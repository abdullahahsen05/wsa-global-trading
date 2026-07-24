if (typeof window !== "undefined") {
  throw new Error("[aurix] backgroundJobService is server-only.");
}

import { createAdminClient } from "@/lib/supabase/admin";
import type { BackgroundJob, JobResult, JobStatus, JobType } from "@/lib/jobs/types";

// ─────────────────────────────────────────────────────────────────────────────
// Background Job Service (server-only). Enqueue, atomically claim, and finalize
// jobs. Payloads contain IDs only — never secrets, tokens, or credentials.
// ─────────────────────────────────────────────────────────────────────────────

const SELECT_COLS =
  "id, type, status, priority, run_after, attempts, max_attempts, unique_key, locked_at, locked_by, started_at, completed_at, failed_at, last_error_code, last_error_message, payload, result, created_by, created_at, updated_at";

/** Backoff for the Nth failed attempt: 1→1m, 2→5m, 3+→15m. Pure + tested. */
export function backoffMs(attempt: number): number {
  const schedule = [60_000, 300_000, 900_000];
  const idx = Math.min(Math.max(attempt, 1), schedule.length) - 1;
  return schedule[idx];
}

interface Row {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  run_after: string;
  attempts: number;
  max_attempts: number;
  unique_key: string | null;
  locked_at: string | null;
  locked_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function mapJob(r: Row): BackgroundJob {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    priority: r.priority,
    runAfter: r.run_after,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    uniqueKey: r.unique_key,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    failedAt: r.failed_at,
    lastErrorCode: r.last_error_code,
    lastErrorMessage: r.last_error_message,
    payload: r.payload ?? {},
    result: r.result,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface EnqueueParams {
  type: JobType;
  payload?: Record<string, unknown>;
  priority?: number;
  runAfter?: string;
  maxAttempts?: number;
  createdBy?: string | null;
  /** When set, an existing PENDING/RUNNING job with the same key is reused instead of duplicated. */
  uniqueKey?: string;
}

export async function enqueueJob(params: EnqueueParams): Promise<BackgroundJob> {
  const supabase = createAdminClient();
  const insert = {
    type: params.type,
    payload: params.payload ?? {},
    priority: params.priority ?? 100,
    run_after: params.runAfter ?? new Date().toISOString(),
    max_attempts: params.maxAttempts ?? 3,
    created_by: params.createdBy ?? null,
    unique_key: params.uniqueKey ?? null,
  };

  const { data, error } = await supabase.from("background_jobs").insert(insert).select(SELECT_COLS).single();

  if (error) {
    // 23505 on the partial unique index = an active job with this key already
    // exists — reuse it rather than duplicating work.
    if ((error as { code?: string }).code === "23505" && params.uniqueKey) {
      const { data: existing } = await supabase
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("unique_key", params.uniqueKey)
        .in("status", ["PENDING", "RUNNING"])
        .limit(1)
        .maybeSingle();
      if (existing) return mapJob(existing as Row);
    }
    throw new Error(`Failed to enqueue job: ${error.message}`);
  }
  return mapJob(data as Row);
}

/** Atomically claim up to `limit` runnable jobs (FOR UPDATE SKIP LOCKED via RPC). */
export async function claimNextJobs(params: {
  workerId: string;
  limit: number;
  types?: JobType[];
}): Promise<BackgroundJob[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("claim_background_jobs", {
    p_worker: params.workerId,
    p_limit: Math.min(Math.max(params.limit, 0), 20),
    p_types: params.types ?? null,
  });
  if (error) throw new Error(`Failed to claim jobs: ${error.message}`);
  return ((data ?? []) as Row[])
    .map(mapJob)
    .sort((a, b) =>
      a.priority - b.priority
      || a.runAfter.localeCompare(b.runAfter)
      || a.createdAt.localeCompare(b.createdAt),
    );
}

async function updateClaimed(job: BackgroundJob, patch: Record<string, unknown>): Promise<boolean> {
  const supabase = createAdminClient();
  let query = supabase
    .from("background_jobs")
    .update(patch)
    .eq("id", job.id)
    .eq("status", "RUNNING");
  if (job.lockedBy) query = query.eq("locked_by", job.lockedBy);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw new Error(`Failed to finalize job: ${error.message}`);
  return Boolean(data);
}

/**
 * Finalize a claimed job from its processor result. FAILED jobs reschedule with
 * backoff while attempts remain (unless retry === false); otherwise terminal.
 */
export async function finalizeJob(job: BackgroundJob, result: JobResult): Promise<boolean> {
  const now = new Date().toISOString();

  if (result.status === "SUCCESS") {
    return updateClaimed(job, {
      status: "SUCCESS",
      completed_at: now,
      result: result.result ?? null,
      locked_at: null,
      locked_by: null,
      last_error_code: null,
      last_error_message: null,
    });
  }

  if (result.status === "SKIPPED") {
    return updateClaimed(job, {
      status: "SKIPPED",
      completed_at: now,
      result: result.result ?? null,
      locked_at: null,
      locked_by: null,
      last_error_code: result.errorCode ?? null,
      last_error_message: result.errorMessage ?? null,
    });
  }

  // FAILED
  const canRetry = result.retry !== false && job.attempts < job.maxAttempts;
  if (canRetry) {
    return updateClaimed(job, {
      status: "PENDING",
      run_after: new Date(Date.now() + backoffMs(job.attempts)).toISOString(),
      locked_at: null,
      locked_by: null,
      last_error_code: result.errorCode ?? null,
      last_error_message: result.errorMessage ?? null,
    });
  }
  return updateClaimed(job, {
    status: "FAILED",
    failed_at: now,
    locked_at: null,
    locked_by: null,
    last_error_code: result.errorCode ?? null,
    last_error_message: result.errorMessage ?? null,
  });
}

/** Release jobs stuck in RUNNING past the stale threshold back to PENDING (or FAILED if exhausted). */
export async function releaseStaleJobs(staleMinutes: number): Promise<number> {
  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const { data: stale } = await supabase
    .from("background_jobs")
    .select("id, type, attempts, max_attempts, locked_at")
    .eq("status", "RUNNING")
    .lt("locked_at", cutoff)
    .limit(100);

  let released = 0;
  for (const j of (stale ?? []) as { id: string; type: JobType; attempts: number; max_attempts: number; locked_at: string }[]) {
    // An external broker action can finish after our process loses contact.
    // Never automatically retry an uncertain live execution; require an
    // operator to inspect it and explicitly choose Retry.
    const uncertainExternalOutcome = ["EXECUTE_COPY_EVENT", "CLOSE_COPY_STRATEGY", "RETRY_COPY_LOG"].includes(j.type);
    const terminal = uncertainExternalOutcome || j.attempts >= j.max_attempts;
    const patch = terminal
      ? {
          status: "FAILED",
          failed_at: new Date().toISOString(),
          locked_at: null,
          locked_by: null,
          last_error_code: uncertainExternalOutcome ? "STALE_EXTERNAL_OUTCOME_UNKNOWN" : "STALE_TIMEOUT",
          last_error_message: uncertainExternalOutcome
            ? "Live broker operation became stale. Inspect the broker outcome before manually retrying."
            : "Job exceeded the stale-running timeout.",
        }
      : { status: "PENDING", run_after: new Date().toISOString(), locked_at: null, locked_by: null, last_error_code: "STALE_TIMEOUT", last_error_message: "Released after stale-running timeout." };
    const { data, error } = await supabase
      .from("background_jobs")
      .update(patch)
      .eq("id", j.id)
      .eq("status", "RUNNING")
      .eq("locked_at", j.locked_at)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`Failed to release stale job: ${error.message}`);
    if (data) released++;
  }
  return released;
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("background_jobs")
    .update({ status: "CANCELLED", completed_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "PENDING") // only pending jobs can be cancelled
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Failed to cancel job: ${error.message}`);
  return Boolean(data);
}

/** Re-queue a terminal job for a fresh run (resets attempts). */
export async function requeueJob(jobId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("background_jobs")
    .update({
      status: "PENDING",
      attempts: 0,
      run_after: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      failed_at: null,
      completed_at: null,
      started_at: null,
      result: null,
      last_error_code: null,
      last_error_message: null,
    })
    .eq("id", jobId)
    .in("status", ["FAILED", "CANCELLED", "SKIPPED"])
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Failed to requeue job: ${error.message}`);
  return Boolean(data);
}

export async function listJobs(filters?: {
  status?: JobStatus;
  type?: JobType;
  limit?: number;
}): Promise<BackgroundJob[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from("background_jobs")
    .select(SELECT_COLS)
    .order("created_at", { ascending: false })
    .limit(Math.min(filters?.limit ?? 100, 200));
  if (filters?.status) query = query.eq("status", filters.status);
  if (filters?.type) query = query.eq("type", filters.type);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list jobs: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapJob);
}

export async function getJob(jobId: string): Promise<BackgroundJob | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.from("background_jobs").select(SELECT_COLS).eq("id", jobId).maybeSingle();
  if (error) throw new Error(`Failed to load job: ${error.message}`);
  return data ? mapJob(data as Row) : null;
}

export interface JobStats {
  pending: number;
  running: number;
  successToday: number;
  failedToday: number;
  skippedToday: number;
}

export async function getJobStats(): Promise<JobStats> {
  const supabase = createAdminClient();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const since = dayStart.toISOString();
  const head = () => supabase.from("background_jobs").select("id", { count: "exact", head: true });

  const [pending, running, successToday, failedToday, skippedToday] = await Promise.all([
    head().eq("status", "PENDING"),
    head().eq("status", "RUNNING"),
    head().eq("status", "SUCCESS").gte("completed_at", since),
    head().eq("status", "FAILED").gte("failed_at", since),
    head().eq("status", "SKIPPED").gte("completed_at", since),
  ]);

  return {
    pending: pending.count ?? 0,
    running: running.count ?? 0,
    successToday: successToday.count ?? 0,
    failedToday: failedToday.count ?? 0,
    skippedToday: skippedToday.count ?? 0,
  };
}
