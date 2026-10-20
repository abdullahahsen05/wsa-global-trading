import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { getWebTradeState, webTradeErrorResponse } from "@/lib/services/webTradeService";
import { issuesText, webTradeStateQuerySchema } from "@/lib/trade/webTradeSchemas";

// A first poll may wait a moment for the AWS trading system to publish the first picture.
export const maxDuration = 30;

/**
 * GET /api/terminal/trade/state?accountId=...&symbol=...
 *
 * WSA Trade: the broker's figures (balance, equity, margin), the open positions, the
 * pending orders and - when a symbol is given and the bridge has a price endpoint -
 * bid / ask of that symbol, for one of the caller's own accounts. Read only; the panel
 * polls it every two seconds while it is open. Each poll also tells the AWS trading
 * system "somebody is looking at this account", so it keeps the picture fresh.
 */
export async function GET(request: Request) {
  try {
    // (polled every second or two: the same session verified a few seconds ago is not verified again)
    const user = await requireTrader({ cached: true });
    const params = new URL(request.url).searchParams;
    const parsed = webTradeStateQuerySchema.safeParse({
      accountId: params.get("accountId") || undefined,
      symbol: params.get("symbol") || undefined,
    });
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", issuesText(parsed.error), 400);
    return jsonOk(await getWebTradeState(user, parsed.data), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
