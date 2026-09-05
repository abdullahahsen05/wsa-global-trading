import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError } from "@/lib/auth/session";
import { authorizeWorker, WorkerAuthError } from "@/lib/jobs/workerAuth";
import { enqueueJob } from "@/lib/services/backgroundJobService";

// POST /api/worker/jobs/schedule — protected. Enqueues the recurring fan-out
// jobs (which themselves enqueue per-account / per-strategy children). It does
// Do not run long broker sync calls here — /api/worker/jobs/run does the processing.
// Intended as a Vercel Cron target (not auto-enabled in this phase).
export async function POST(request: Request) {
  try {
    await authorizeWorker(request);

    const sync = await enqueueJob({
      type: "SYNC_ALL_CONNECTED_ACCOUNTS",
      uniqueKey: "SYNC_ALL_CONNECTED_ACCOUNTS",
    });
    const monitor = await enqueueJob({
      type: "MONITOR_ALL_ACTIVE_COPY_STRATEGIES",
      uniqueKey: "MONITOR_ALL_ACTIVE_COPY_STRATEGIES",
    });

    return jsonOk({ enqueued: [sync.type, monitor.type] });
  } catch (err) {
    if (err instanceof WorkerAuthError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
