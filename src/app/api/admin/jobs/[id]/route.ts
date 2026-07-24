import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { getJob } from "@/lib/services/backgroundJobService";

// GET /api/admin/jobs/[id] — fetch the current state for the operator detail view.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await params;
    const job = await getJob(id);
    if (!job) return jsonFail("JOB_NOT_FOUND", "Job not found.", 404);
    return jsonOk(job);
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
