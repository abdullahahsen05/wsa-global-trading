import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { getJobStats, releaseStaleJobs } from "@/lib/services/backgroundJobService";
import { runWorkerOnce } from "@/lib/workers/jobProcessor";
import { writeAuditLog } from "@/lib/services/auditService";
import { jobRunSchema } from "@/lib/validation/schemas";

// POST /api/admin/jobs/run-now — admin manually processes one bounded batch.
// Runs the internal processor directly (admin-gated), capped small.
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await request.json().catch(() => ({}));
    const parsed = jobRunSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return jsonFail("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join(", "), 400);
    }
    const limit = Math.min(parsed.data.limit ?? 5, 20);
    const staleMinutes = Math.max(Number.parseInt(process.env.WORKER_STALE_JOB_MINUTES ?? "15", 10) || 15, 5);
    const releasedStale = await releaseStaleJobs(staleMinutes);
    const summary = await runWorkerOnce({ workerId: `admin-${admin.id.slice(0, 8)}`, limit, types: parsed.data.types });
    const stats = await getJobStats();

    await writeAuditLog({
      actorUserId: admin.id,
      action: "WORKER_RUN",
      entityType: "background_job",
      entityId: null,
      metadata: { ...summary, releasedStale, remainingPending: stats.pending },
    });
    return jsonOk({ ...summary, releasedStale, remainingPending: stats.pending });
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
