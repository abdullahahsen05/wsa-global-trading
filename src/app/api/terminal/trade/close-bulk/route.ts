import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { closeWebTradeBulk, webTradeErrorResponse } from "@/lib/services/webTradeService";
import { issuesText, webTradeCloseBulkSchema } from "@/lib/trade/webTradeSchemas";

// Many orders are carried out by the AWS trading system; this request waits for the answer.
export const maxDuration = 30;

/**
 * POST /api/terminal/trade/close-bulk
 * { accountId, scope: "ALL"|"PROFIT"|"LOSS"|"BUY"|"SELL"|"SYMBOL"|"PENDING", symbol?, clientRequestId? }
 *
 * WSA Trade: closes several positions of one of the caller's own accounts at once
 * (all, the winners, the losers, one side, one symbol) or deletes the pending orders.
 * The answer says how many were closed and lists the ones that could not be. Not
 * blocked by risk rules.
 */
export async function POST(request: Request) {
  try {
    const user = await requireTrader();
    const parsed = webTradeCloseBulkSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", issuesText(parsed.error), 400);
    return jsonOk(await closeWebTradeBulk(user, parsed.data), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
