import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { cancelWebTradeOrder, webTradeErrorResponse } from "@/lib/services/webTradeService";
import { issuesText, webTradeCancelSchema } from "@/lib/trade/webTradeSchemas";

// The deletion is carried out by the AWS trading system; this request waits for its answer.
export const maxDuration = 30;

/**
 * GET /api/terminal/trade/cancel
 *
 * Wakes this route up - nothing else (no data, no sign-in, no database). The order panel
 * calls it when it opens so the first deletion does not pay for a cold start.
 */
export function GET() {
  return jsonOk({ warm: true }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

/**
 * POST /api/terminal/trade/cancel
 * { accountId, ticket, clientRequestId? }
 *
 * WSA Trade: deletes a PENDING (limit / stop) order of one of the caller's own
 * accounts. An open position is never closed through this route. Not blocked by risk
 * rules.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const user = await requireTrader();
    const parsed = webTradeCancelSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", issuesText(parsed.error), 400);
    return jsonOk(await cancelWebTradeOrder(user, parsed.data, { startedAt }), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
