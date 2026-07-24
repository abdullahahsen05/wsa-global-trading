import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError } from "@/lib/auth/session";
import { authorizeWorker, WorkerAuthError } from "@/lib/jobs/workerAuth";
import { releaseStaleJobs } from "@/lib/services/backgroundJobService";
import { runWorkerOnce } from "@/lib/workers/jobProcessor";
import { jobRunSchema } from "@/lib/validation/schemas";

// POST /api/worker/jobs/run — protected. Claims + processes one bounded batch of
// jobs (no infinite loop). Called by Vercel Cron (with x-worker-secret) or, in
// dev, by an authenticated admin. Default batch small; hard-capped at 20.
export async function POST(request: Request) {
  try {
    await authorizeWorker(request);

    const body = await request.json().catch(() => ({}));
    const parsed = jobRunSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return jsonFail("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join(", "), 400);
    }

    const envMax = Number.parseInt(process.env.WORKER_MAX_JOBS_PER_RUN ?? "5", 10);
    const limit = Math.min(parsed.data.limit ?? (Number.isFinite(envMax) ? envMax : 5), 20);
    const staleMinutes = Math.max(Number.parseInt(process.env.WORKER_STALE_JOB_MINUTES ?? "15", 10) || 15, 5);
    const releasedStale = await releaseStaleJobs(staleMinutes);

    const summary = await runWorkerOnce({
      workerId: `worker-${Date.now()}`,
      limit,
      types: parsed.data.types,
    });
    return jsonOk({ ...summary, releasedStale });
  } catch (err) {
    if (err instanceof WorkerAuthError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
