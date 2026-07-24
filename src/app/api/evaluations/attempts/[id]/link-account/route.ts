import { z } from "zod";
import { jsonFail, jsonOk, handleAuthError } from "@/lib/api/envelope";
import { AuthError, requireTrader } from "@/lib/auth/session";
import { traderLinkEvaluationAccount } from "@/lib/services/evaluationService";

const Schema = z.object({
  tradingAccountId: z.string().uuid(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const trader = await requireTrader();
    const { id } = await context.params;
    const parsed = Schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonFail(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Select a valid trading account.",
        400,
      );
    }
    const attempt = await traderLinkEvaluationAccount(
      id,
      parsed.data.tradingAccountId,
      trader.id,
    );
    return jsonOk(attempt);
  } catch (error) {
    if (error instanceof AuthError) return handleAuthError(error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Attempt not found"
      ? 404
      : message.includes("belong")
        ? 403
        : message.includes("already started")
          ? 409
          : 400;
    return jsonFail("EVALUATION_ACCOUNT_INVALID", message, status);
  }
}
