import { z } from "zod";
import { jsonFail, jsonOk, handleAuthError } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { adminUpdateEvaluationProgram } from "@/lib/services/evaluationService";

const UpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().optional(),
  requiredCourseId: z.string().uuid().nullable().optional(),
  startingBalance: z.number().positive().optional(),
  profitTargetPercent: z.number().positive().max(100).optional(),
  maxDailyDrawdownPercent: z.number().positive().max(100).optional(),
  maxOverallDrawdownPercent: z.number().positive().max(100).optional(),
  minimumTradingDays: z.number().int().min(0).optional(),
  durationDays: z.number().int().positive().optional(),
  demoServerName: z.string().trim().min(2).max(160).nullable().optional(),
  demoAccountType: z.string().trim().min(1).max(120).nullable().optional(),
  demoLeverage: z.number().int().min(1).max(5000).optional(),
  demoBrokerKeywords: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await req.json();
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonFail("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Validation error", 400);
    }
    const program = await adminUpdateEvaluationProgram(id, parsed.data, admin.id);
    return jsonOk(program);
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError(err);
    return jsonFail("INTERNAL_ERROR", err instanceof Error ? err.message : "Unknown error", 500);
  }
}
