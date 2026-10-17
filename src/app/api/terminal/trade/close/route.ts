import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { closeWebTradePosition, webTradeErrorResponse } from "@/lib/services/webTradeService";
import { issuesText, webTradeCloseSchema } from "@/lib/trade/webTradeSchemas";

// The close is carried out by the AWS trading system; this request waits for its answer.
export const maxDuration = 30;

/**
 * POST /api/terminal/trade/close
 * { accountId, ticket, volume?, clientRequestId? }
 *
 * WSA Trade: closes an open position of one of the caller's own accounts, or only
 * `volume` lots of it. Not blocked by risk rules (reducing risk is never refused).
 */
export async function POST(request: Request) {
  try {
    const user = await requireTrader();
    const parsed = webTradeCloseSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", issuesText(parsed.error), 400);
    return jsonOk(await closeWebTradePosition(user, parsed.data), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
