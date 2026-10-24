import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { getWebTradeHistory, webTradeErrorResponse } from "@/lib/services/webTradeService";
import { issuesText, webTradeHistoryQuerySchema } from "@/lib/trade/webTradeSchemas";

/**
 * GET /api/terminal/trade/history?accountId=...&since=...&limit=...
 *
 * WSA Trade, History tab: the closed trades of one of the caller's own accounts, newest first, optionally only those
 * closed at or after `since`. Read only, and read from the platform's synchronised trade record (not from the broker).
 */
export async function GET(request: Request) {
  try {
    // (a list the panel asks for every few seconds while the tab is open: the session verified a moment ago is not verified again)
    const user = await requireTrader({ cached: true });
    const params = new URL(request.url).searchParams;
    const parsed = webTradeHistoryQuerySchema.safeParse({
      accountId: params.get("accountId") || undefined,
      since: params.get("since") || undefined,
      limit: params.get("limit") || undefined,
    });
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", issuesText(parsed.error), 400);
    return jsonOk(await getWebTradeHistory(user, parsed.data), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
