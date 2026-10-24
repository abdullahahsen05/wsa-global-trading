import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { signInForOrder } from "@/lib/services/webTradePass";
import { placeWebTradeOrder, webTradeErrorResponse } from "@/lib/services/webTradeService";
import { answerWebTradeWarmUp } from "@/lib/services/webTradeWarmUp";
import { issuesText, webTradeOpenSchema } from "@/lib/trade/webTradeSchemas";

// The order is carried out by the AWS trading system; this request waits for its answer.
export const maxDuration = 30;

/**
 * GET /api/terminal/trade/open[?accountId=...]
 *
 * Wakes this route up so the first order does not pay for a cold start - and, with an account, keeps the checks an
 * order makes (sign-in, account, risk, subscription) in memory. Returns nothing but `{ warm: true }`.
 */
export function GET(request?: Request) {
  return answerWebTradeWarmUp(request);
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
    // (the cheap sign-in: the order pass of the last state poll, else the same session verified a few seconds ago)
    const signedIn = await signInForOrder(request);
    const parsed = webTradeOpenSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", issuesText(parsed.error), 400);
    return jsonOk(
      await placeWebTradeOrder(signedIn.user, parsed.data, { startedAt, signedInAt: signedIn.at, pass: signedIn.pass }),
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
