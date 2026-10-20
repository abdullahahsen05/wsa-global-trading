if (typeof window !== "undefined") {
  throw new Error("[wsa] webTradeWarmUp is server-only.");
}

import { jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { warmWebTradeGates } from "@/lib/services/webTradeService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function accountIdOf(request: Request | undefined): string | null {
  if (!request) return null;
  try {
    const value = new URL(request.url).searchParams.get("accountId");
    return value && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The answer of the five order routes to a plain GET: a warm-up.
 *
 * The first request to a route that has been idle pays for its start-up, and the first order pays for every check
 * from scratch (the sign-in, the account, the risk verdict, the subscription, the AWS heartbeat). The panel sends this
 * when it opens and whenever somebody reaches for the buttons, so neither is ever an order.
 *
 *  - without `?accountId=` it only wakes the route up: no data, no sign-in, no database;
 *  - with the id of an account it also reads, as the caller, what an order on that account will check - they stay in
 *    memory for seconds (`warmWebTradeGates`). It signs in the cheap way, changes nothing, returns nothing but
 *    `{ warm: true }` whoever asks, and swallows every failure: the real request says what is wrong, properly.
 */
export async function answerWebTradeWarmUp(request?: Request): Promise<Response> {
  const accountId = accountIdOf(request);
  if (accountId) {
    try {
      const user = await requireTrader({ cached: true });
      await warmWebTradeGates(user, accountId, true);
    } catch {
      // a warm-up is a courtesy
    }
  }
  return jsonOk({ warm: true }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
