if (typeof window !== "undefined") {
  throw new Error("[aurix] jobProcessor is server-only.");
}

import { createAdminClient } from "@/lib/supabase/admin";
import { claimNextJobs, enqueueJob, finalizeJob } from "@/lib/services/backgroundJobService";
import { syncTradingAccount } from "@/lib/services/brokerSyncService";
import {
  closeAllStrategyPositions,
  executeCopyForEvent,
  monitorMasterAccount,
  retryCopyExecution,
  simulateCopyForEvent,
  simulateStrategy,
} from "@/lib/services/copyTradingService";
import { COPY_ERROR, CopyError } from "@/lib/copy/types";
import type { BackgroundJob, JobResult, JobType } from "@/lib/jobs/types";
import { brokerProviderConfigured } from "@/lib/broker/provider";

// ─────────────────────────────────────────────────────────────────────────────
// Job processor (server-only). Dispatches a claimed job to the right existing
// service. Live execution stays fully gated — when blocked it returns SKIPPED
// (no retry), never a fake success. Broker operations own their timeouts:
// racing one against a timer here would not cancel the underlying operation
// and could allow the same live action to be retried while it is still running.
// ─────────────────────────────────────────────────────────────────────────────

// Copy gate codes are intentional blocks, not failures → SKIPPED, no retry.
const GATE_CODES = new Set<string>([
  COPY_ERROR.COPY_EXECUTION_NOT_CONFIGURED,
  COPY_ERROR.COPY_LIVE_DISABLED,
  COPY_ERROR.COPY_EMERGENCY_STOP,
  COPY_ERROR.COPY_CONSENT_REQUIRED,
  COPY_ERROR.FOLLOWER_NOT_ELIGIBLE,
]);

async function loadAllIds(
  table: "trading_accounts" | "copy_strategies",
  buildQuery: (from: number, to: number) => Promise<{ data: Array<{ id: string }> | null; error: { message: string } | null }>,
): Promise<string[]> {
  const pageSize = 1_000;
  const ids: string[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) throw new Error(`${table} page could not be loaded: ${error.message}`);
    ids.push(...((data ?? []).map((row) => row.id)));
    if (!data || data.length < pageSize) break;
  }
  return ids;
}

function requireId(job: BackgroundJob, key: string): string {
  const value = job.payload?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CopyError(COPY_ERROR.VALIDATION_ERROR, `Job payload missing ${key}`, 400);
  }
  return value;
}

async function dispatch(job: BackgroundJob): Promise<JobResult> {
  const actor = job.createdBy;
  const liveRiskProjectionEnabled =
    brokerProviderConfigured()
    && process.env.WSA_RISK_ENGINE_ENABLED === "true";
  const liveCopyStreamEnabled =
    brokerProviderConfigured()
    && process.env.WSA_COPY_ENGINE_ENABLED === "true"
    && process.env.BROKER_EXECUTION_ENABLED === "true";

  switch (job.type) {
    case "SYNC_ACCOUNT": {
      const accountId = requireId(job, "accountId");
      // Explicit fallback jobs run only when the live stream heartbeat is
      // stale. Keep MetaApi sockets in the worker, never in Vercel.
      const summary = await syncTradingAccount(accountId, actor, { force: true });
      if (summary.status === "CONNECTED" && !summary.error) {
        return { status: "SUCCESS", result: { status: summary.status, tradesUpserted: summary.tradesUpserted, snapshotInserted: summary.snapshotInserted } };
      }
      // PENDING (timeout) or DISCONNECTED with error → retry transiently.
      return { status: "FAILED", errorCode: "SYNC_INCOMPLETE", errorMessage: summary.error ?? `Sync ended as ${summary.status}`, retry: true };
    }

    case "SYNC_ALL_CONNECTED_ACCOUNTS": {
      if (liveRiskProjectionEnabled) {
        return {
          status: "SKIPPED",
          errorCode: "OWNED_BY_LIVE_RISK_STREAM",
          errorMessage: "Recurring account synchronization is owned by the live risk stream.",
        };
      }
      const supabase = createAdminClient();
      const accountIds = await loadAllIds("trading_accounts", async (from, to) =>
        await supabase.from("trading_accounts").select("id").eq("status", "CONNECTED").order("id").range(from, to),
      );
      let enqueued = 0;
      for (const accountId of accountIds) {
        await enqueueJob({ type: "SYNC_ACCOUNT", payload: { accountId }, uniqueKey: `SYNC_ACCOUNT:${accountId}`, createdBy: actor });
        enqueued++;
      }
      return { status: "SUCCESS", result: { enqueued } };
    }

    case "MONITOR_COPY_STRATEGY": {
      if (liveCopyStreamEnabled) {
        return {
          status: "SKIPPED",
          errorCode: "OWNED_BY_LIVE_COPY_STREAM",
          errorMessage: "The dedicated live copy worker already monitors strategy streams.",
        };
      }
      const strategyId = requireId(job, "strategyId");
      const r = await monitorMasterAccount(strategyId, actor);
      return { status: "SUCCESS", result: { detected: r.detected } };
    }

    case "MONITOR_ALL_ACTIVE_COPY_STRATEGIES": {
      if (liveCopyStreamEnabled) {
        return {
          status: "SKIPPED",
          errorCode: "OWNED_BY_LIVE_COPY_STREAM",
          errorMessage: "Recurring strategy monitoring is owned by the dedicated live copy worker.",
        };
      }
      const supabase = createAdminClient();
      const strategyIds = await loadAllIds("copy_strategies", async (from, to) =>
        await supabase.from("copy_strategies").select("id").eq("status", "ACTIVE").order("id").range(from, to),
      );
      let enqueued = 0;
      for (const strategyId of strategyIds) {
        await enqueueJob({ type: "MONITOR_COPY_STRATEGY", payload: { strategyId }, uniqueKey: `MONITOR_COPY_STRATEGY:${strategyId}`, createdBy: actor });
        enqueued++;
      }
      return { status: "SUCCESS", result: { enqueued } };
    }

    case "SIMULATE_COPY_EVENT": {
      const masterEventId = requireId(job, "masterEventId");
      const r = await simulateCopyForEvent(masterEventId, actor);
      return { status: "SUCCESS", result: { ...r } };
    }

    case "SIMULATE_COPY_STRATEGY": {
      const strategyId = requireId(job, "strategyId");
      const r = await simulateStrategy(strategyId, actor);
      return { status: "SUCCESS", result: { ...r } };
    }

    case "EXECUTE_COPY_EVENT": {
      const masterEventId = requireId(job, "masterEventId");
      const r = await executeCopyForEvent(masterEventId, actor);
      return { status: "SUCCESS", result: { ...r } };
    }

    case "CLOSE_COPY_STRATEGY": {
      const strategyId = requireId(job, "strategyId");
      const r = await closeAllStrategyPositions(strategyId);
      return { status: r.failed > 0 ? "FAILED" : "SUCCESS", result: { ...r }, errorCode: r.failed > 0 ? "COPY_CLOSE_PARTIAL_FAILURE" : undefined, errorMessage: r.failed > 0 ? `${r.failed} position(s) could not be closed.` : undefined, retry: r.failed > 0 };
    }

    case "RETRY_COPY_LOG": {
      const copyExecutionLogId = requireId(job, "copyExecutionLogId");
      const r = await retryCopyExecution(copyExecutionLogId, actor);
      return { status: "SUCCESS", result: { ...r } };
    }

    case "CLEANUP_STALE_JOBS": {
      const { releaseStaleJobs } = await import("@/lib/services/backgroundJobService");
      const minutes = Number.parseInt(process.env.WORKER_STALE_JOB_MINUTES ?? "15", 10) || 15;
      const released = await releaseStaleJobs(minutes);
      return { status: "SUCCESS", result: { released } };
    }

    case "SYNC_EVALUATION_ACCOUNT": {
      const attemptId = requireId(job, "attemptId");
      const { adminRunEvaluationCheck } = await import("@/lib/services/evaluationService");
      const outcome = await adminRunEvaluationCheck(attemptId, actor);
      return { status: "SUCCESS", result: { checkResult: outcome.result.result, attemptStatus: outcome.attempt.status } };
    }

    case "CHECK_EVALUATION_ATTEMPT": {
      const attemptId = requireId(job, "attemptId");
      const { adminRunEvaluationCheck } = await import("@/lib/services/evaluationService");
      const outcome = await adminRunEvaluationCheck(attemptId, actor);
      return { status: "SUCCESS", result: { checkResult: outcome.result.result } };
    }

    case "CHECK_ALL_ACTIVE_EVALUATIONS": {
      const supabase = createAdminClient();
      const { data } = await supabase
        .from("evaluation_attempts")
        .select("id")
        .in("status", ["ACTIVE", "NEEDS_REVIEW"])
        .limit(500);
      let enqueued = 0;
      for (const a of data ?? []) {
        await enqueueJob({
          type: "CHECK_EVALUATION_ATTEMPT",
          payload: { attemptId: a.id },
          uniqueKey: `CHECK_EVALUATION_ATTEMPT:${a.id}`,
          createdBy: actor,
        });
        enqueued++;
      }
      return { status: "SUCCESS", result: { enqueued } };
    }

    default:
      return { status: "FAILED", errorCode: "UNKNOWN_JOB_TYPE", errorMessage: `Unknown job type: ${job.type}`, retry: false };
  }
}

export async function processJob(job: BackgroundJob): Promise<JobResult> {
  try {
    return await dispatch(job);
  } catch (err) {
    if (err instanceof CopyError) {
      // Gate blocks are SKIPPED (no retry); other copy errors are non-retryable failures.
      if (GATE_CODES.has(err.code)) {
        return { status: "SKIPPED", errorCode: err.code, errorMessage: err.message };
      }
      return { status: "FAILED", errorCode: err.code, errorMessage: err.message, retry: false };
    }
    const message = (err instanceof Error ? err.message : "Job failed").slice(0, 400);
    return { status: "FAILED", errorCode: "JOB_ERROR", errorMessage: message, retry: true };
  }
}

export interface WorkerRunSummary {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  superseded: number;
}

/**
 * Claim up to `limit` runnable jobs, process and finalize each. One pass only —
 * no infinite loop. Used by the protected worker route and admin run-now.
 */
export async function runWorkerOnce(params: {
  workerId: string;
  limit: number;
  types?: JobType[];
}): Promise<WorkerRunSummary> {
  const jobs = await claimNextJobs(params);
  const summary: WorkerRunSummary = { processed: 0, succeeded: 0, failed: 0, skipped: 0, superseded: 0 };
  for (const job of jobs) {
    const result = await processJob(job);
    const finalized = await finalizeJob(job, result);
    summary.processed++;
    if (!finalized) {
      summary.superseded++;
      continue;
    }
    if (result.status === "SUCCESS") summary.succeeded++;
    else if (result.status === "SKIPPED") summary.skipped++;
    else summary.failed++;
  }
  return summary;
}
