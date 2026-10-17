import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { getWebTradeSymbols, webTradeErrorResponse } from "@/lib/services/webTradeService";
import { issuesText, webTradeSymbolsQuerySchema } from "@/lib/trade/webTradeSchemas";

// The first call for an account may wait for the AWS trading system to read the broker's list.
export const maxDuration = 30;

/**
 * GET /api/terminal/trade/symbols?accountId=...
 *
 * WSA Trade: every symbol the account can trade, spelled the way ITS BROKER spells it
 * ("EURUSD.r", "XAUUSDm", "GOLD", "US30.cash"), with description and folder when the
 * bridge sends them. Read only, for one of the caller's own accounts. The list is
 * kept for hours; an empty list means the bridge could not list the symbols (the
 * panel then lets the person type one).
 */
export async function GET(request: Request) {
  try {
    const user = await requireTrader();
    const params = new URL(request.url).searchParams;
    const parsed = webTradeSymbolsQuerySchema.safeParse({ accountId: params.get("accountId") || undefined });
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", issuesText(parsed.error), 400);
    return jsonOk(await getWebTradeSymbols(user, parsed.data), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
