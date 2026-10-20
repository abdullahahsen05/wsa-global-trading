import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { closeWebTradePosition, webTradeErrorResponse } from "@/lib/services/webTradeService";
import { answerWebTradeWarmUp } from "@/lib/services/webTradeWarmUp";
import { issuesText, webTradeCloseSchema } from "@/lib/trade/webTradeSchemas";

// The close is carried out by the AWS trading system; this request waits for its answer.
export const maxDuration = 30;

/**
 * GET /api/terminal/trade/close[?accountId=...]
 *
 * Wakes this route up so the first close does not pay for a cold start - and, with an account, keeps the checks a
 * close makes (sign-in, account, subscription) in memory. Returns nothing but `{ warm: true }`.
 */
export function GET(request?: Request) {
  return answerWebTradeWarmUp(request);
}

/**
 * POST /api/terminal/trade/close
 * { accountId, ticket, volume?, clientRequestId? }
 *
 * WSA Trade: closes an open position of one of the caller's own accounts, or only
 * `volume` lots of it. Not blocked by risk rules (reducing risk is never refused).
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const user = await requireTrader({ cached: true });
    const signedInAt = Date.now();
    const parsed = webTradeCloseSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", issuesText(parsed.error), 400);
    return jsonOk(await closeWebTradePosition(user, parsed.data, { startedAt, signedInAt }), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
