import { jsonFail, jsonOk } from "@/lib/api/envelope";
import type { TradeStatus } from "@/lib/domain/types";
import { requireAuth, AuthError } from "@/lib/auth/session";
import { listTrades } from "@/lib/services/tradeService";
import { tradeQuerySchema } from "@/lib/validation/schemas";

export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    const parsed = tradeQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return jsonFail("INVALID_QUERY", parsed.error.message, 400);

    return jsonOk(
      await listTrades({
        userId: user.id,
        role: user.role,
        accountId: parsed.data.accountId,
        status: parsed.data.status as TradeStatus | undefined,
        limit: parsed.data.limit,
      }),
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
