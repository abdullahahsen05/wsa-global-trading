import { jsonOk } from "@/lib/api/envelope";
import { requireTrader } from "@/lib/auth/session";
import { listWebTradeAccounts, webTradeErrorResponse } from "@/lib/services/webTradeService";

/**
 * GET /api/terminal/trade/accounts
 *
 * WSA Trade: the caller's OWN trading accounts (admins included - the admin
 * terminal trades the admin's own accounts), the platform-wide part of the gate
 * (is the AWS trading system there, is its execution switch on, platform
 * subscription) and the `route` orders take: "gateway" (through the AWS worker),
 * "direct" (this server's own bridge) or "none" (read-only). Never credentials.
 */
export async function GET() {
  try {
    const user = await requireTrader();
    return jsonOk(await listWebTradeAccounts(user), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    return webTradeErrorResponse(error);
  }
}
