import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth, AuthError } from "@/lib/auth/session";
import { getTradingAccount, updatePendingTradingAccount } from "@/lib/services/tradingAccountService";
import { z } from "zod";

const pendingAccountSchema = z.object({
  accountName: z.string().trim().min(2).max(100),
  brokerName: z.string().trim().min(2).max(100),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  try {
    const user = await requireAuth();
    const { accountId } = await context.params;
    const account = await getTradingAccount(accountId, user.id, user.role);
    if (!account) return jsonFail("ACCOUNT_NOT_FOUND", "Trading account was not found.", 404);
    return jsonOk(account);
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  try {
    const user = await requireAuth();
    if (user.role !== "TRADER") {
      return jsonFail("FORBIDDEN", "Only traders can update pending account setup.", 403);
    }
    const parsed = pendingAccountSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonFail("INVALID_BODY", parsed.error.issues.map((issue) => issue.message).join(", "), 400);
    }
    const { accountId } = await context.params;
    return jsonOk(await updatePendingTradingAccount(accountId, user.id, parsed.data));
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    return jsonFail("ACCOUNT_UPDATE_FAILED", err instanceof Error ? err.message : "Pending account could not be updated.", 409);
  }
}
