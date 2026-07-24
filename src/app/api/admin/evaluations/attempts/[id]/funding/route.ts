import { jsonFail, jsonOk, handleAuthError } from "@/lib/api/envelope";
import { requireAdmin } from "@/lib/auth/session";
import { adminUpdateEvaluationFunding } from "@/lib/services/evaluationService";
import { z } from "zod";

const schema = z.object({
  status: z.enum(["PENDING_REVIEW", "FUNDED", "DECLINED"]),
  note: z.string().trim().max(1000).optional().nullable(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid funding decision.", 400);
    await adminUpdateEvaluationFunding(id, parsed.data, admin.id);
    return jsonOk({ updated: true });
  } catch (error) {
    const auth = handleAuthError(error);
    if (auth) return auth;
    return jsonFail("EVALUATION_FUNDING_FAILED", error instanceof Error ? error.message : "Funding decision failed.", 400);
  }
}
