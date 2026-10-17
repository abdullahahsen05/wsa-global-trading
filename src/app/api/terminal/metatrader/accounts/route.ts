import { handleAuthError, jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth } from "@/lib/auth/session";
import {
  listMetaTraderTerminalAccounts,
  MetaTraderTerminalError,
} from "@/lib/services/metaTraderTerminalService";

/**
 * GET /api/terminal/metatrader/accounts
 *
 * The caller's own trading accounts as the MetaTrader web terminal's account
 * picker needs them: name, broker, platform, server and a MASKED login. Never a
 * password and never the full login (that comes from POST .../launch, one account
 * at a time).
 */
export async function GET() {
  try {
    const user = await requireAuth();
    if (user.role === "PARTNER") {
      return jsonFail("FORBIDDEN", "Partners do not have a trading terminal.", 403);
    }
    const accounts = await listMetaTraderTerminalAccounts(user.id);
    return jsonOk({ accounts }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    if (error instanceof MetaTraderTerminalError) {
      return jsonFail(error.code, error.message, error.statusCode);
    }
    // message only: errors from this path never carry credentials
    if (!(error instanceof Error && error.name === "AuthError")) {
      console.error("[terminal] metatrader accounts failed:", error instanceof Error ? error.message : "unknown error");
    }
    return handleAuthError(error);
  }
}
