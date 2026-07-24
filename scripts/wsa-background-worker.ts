import { enqueueJob, releaseStaleJobs } from "../src/lib/services/backgroundJobService";
import { runWorkerOnce } from "../src/lib/workers/jobProcessor";
import type { JobType } from "../src/lib/jobs/types";

const GENERAL_JOB_TYPES: JobType[] = [
  "SYNC_ACCOUNT",
  "SYNC_ALL_CONNECTED_ACCOUNTS",
  "MONITOR_COPY_STRATEGY",
  "MONITOR_ALL_ACTIVE_COPY_STRATEGIES",
  "CLEANUP_STALE_JOBS",
  "SYNC_EVALUATION_ACCOUNT",
  "CHECK_EVALUATION_ATTEMPT",
  "CHECK_ALL_ACTIVE_EVALUATIONS",
];

const pollMs = Math.max(500, Number.parseInt(process.env.WSA_JOB_POLL_MS ?? "2000", 10) || 2_000);
const syncIntervalMs = Math.max(60_000, Number.parseInt(process.env.WSA_ACCOUNT_SYNC_INTERVAL_MS ?? "300000", 10) || 300_000);
const evaluationIntervalMs = Math.max(60_000, Number.parseInt(process.env.WSA_EVALUATION_INTERVAL_MS ?? "300000", 10) || 300_000);
const staleMinutes = Math.max(5, Number.parseInt(process.env.WORKER_STALE_JOB_MINUTES ?? "15", 10) || 15);
const maxJobs = Math.min(Math.max(Number.parseInt(process.env.WORKER_MAX_JOBS_PER_RUN ?? "5", 10) || 5, 1), 20);
const riskStreamOwnsAccountProjection =
  Boolean(process.env.METAAPI_TOKEN)
  && process.env.WSA_RISK_ENGINE_ENABLED === "true";
const recurringAccountSyncEnabled =
  process.env.WSA_BACKGROUND_ACCOUNT_SYNC_ENABLED === "true"
  || !riskStreamOwnsAccountProjection;
const workerId = `wsa-background-${process.pid}`;
let stopping = false;
let nextSyncAt = 0;
let nextEvaluationAt = 0;
let nextStaleRecoveryAt = 0;

async function scheduleRecurringWork(now: number) {
  if (recurringAccountSyncEnabled && now >= nextSyncAt) {
    await enqueueJob({
      type: "SYNC_ALL_CONNECTED_ACCOUNTS",
      uniqueKey: "SYNC_ALL_CONNECTED_ACCOUNTS",
    });
    nextSyncAt = now + syncIntervalMs;
  }
  if (now >= nextEvaluationAt) {
    await enqueueJob({
      type: "CHECK_ALL_ACTIVE_EVALUATIONS",
      uniqueKey: "CHECK_ALL_ACTIVE_EVALUATIONS",
    });
    nextEvaluationAt = now + evaluationIntervalMs;
  }
  if (now >= nextStaleRecoveryAt) {
    const released = await releaseStaleJobs(staleMinutes);
    if (released) console.warn(`[jobs-worker] recovered ${released} stale job(s).`);
    nextStaleRecoveryAt = now + 60_000;
  }
}

async function main() {
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  console.log(`[jobs-worker] started; polling every ${pollMs}ms.`);
  if (!recurringAccountSyncEnabled) {
    console.log("[jobs-worker] recurring account sync disabled; the live risk stream owns account snapshots and trade projection.");
  }

  while (!stopping) {
    try {
      await scheduleRecurringWork(Date.now());
      const summary = await runWorkerOnce({
        workerId,
        limit: maxJobs,
        types: GENERAL_JOB_TYPES,
      });
      if (summary.processed) {
        console.log(
          `[jobs-worker] processed ${summary.processed}: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.superseded} superseded.`,
        );
      }
    } catch (error) {
      console.error(`[jobs-worker] ${error instanceof Error ? error.message : "worker cycle failed"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "WSA background worker failed.");
  process.exitCode = 1;
});
