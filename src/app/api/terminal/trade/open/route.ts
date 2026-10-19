import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { placeWebTradeOrder, webTradeErrorResponse } from "@/lib/services/webTradeService";
import { issuesText, webTradeOpenSchema } from "@/lib/trade/webTradeSchemas";

// The order is carried out by the AWS trading system; this request waits for its answer.
export const maxDuration = 30;

/**
 * GET /api/terminal/trade/open
 *
 * Wakes this route up - nothing else (no data, no sign-in, no database). The order panel
 * calls it when it opens so the first order does not pay for a cold start.
 */
export function GET() {
  return jsonOk({ warm: true }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

/**
 * POST /api/terminal/trade/open
 * { accountId, symbol, side: "BUY"|"SELL", volume, orderKind?: "MARKET"|"LIMIT"|"STOP",
 *   price? (pending orders), stopLoss?, takeProfit?, clientRequestId }
 *
 * WSA Trade: a market order - or a limit / stop order waiting for its price - on one of
 * the caller's own accounts. It goes through the same gates as the rest of the platform:
 * the platform subscription (admins exempt) and the account's risk rules, and it is
 * carried out by the AWS trading system (or by this server where it has the bridge).
 * A repeated `clientRequestId` never places a second order.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const user = await requireTrader();
    const parsed = webTradeOpenSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", issuesText(parsed.error), 400);
    return jsonOk(await placeWebTradeOrder(user, parsed.data, { startedAt }), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
