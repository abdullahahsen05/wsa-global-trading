import { z } from "zod";
import { jsonFail, jsonOk, handleAuthError } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import {
  adminListEvaluationPrograms,
  adminCreateEvaluationProgram,
} from "@/lib/services/evaluationService";

const CreateSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, hyphens"),
  name: z.string().min(2).max(120),
  description: z.string().optional(),
  requiredCourseId: z.string().uuid().optional(),
  startingBalance: z.number().positive(),
  profitTargetPercent: z.number().positive().max(100),
  maxDailyDrawdownPercent: z.number().positive().max(100),
  maxOverallDrawdownPercent: z.number().positive().max(100),
  minimumTradingDays: z.number().int().min(0),
  durationDays: z.number().int().positive(),
  demoServerName: z.string().trim().min(2).max(160).optional(),
  demoAccountType: z.string().trim().min(1).max(120).optional(),
  demoLeverage: z.number().int().min(1).max(5000).optional(),
  demoBrokerKeywords: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
});

export async function GET() {
  try {
    const admin = await requireAdmin();
    void admin;
    const programs = await adminListEvaluationPrograms();
    return jsonOk(programs);
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError(err);
    return jsonFail("INTERNAL_ERROR", err instanceof Error ? err.message : "Unknown error", 500);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = await req.json();
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonFail("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Validation error", 400);
    }
    const program = await adminCreateEvaluationProgram(parsed.data, admin.id);
    return jsonOk(program, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError(err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return jsonFail("SLUG_TAKEN", "A program with this slug already exists.", 409);
    }
    return jsonFail("INTERNAL_ERROR", msg, 500);
  }
}
