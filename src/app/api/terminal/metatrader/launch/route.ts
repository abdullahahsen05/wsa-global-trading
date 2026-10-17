import { handleAuthError, jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/services/auditService";
import {
  MetaTraderTerminalError,
  resolveMetaTraderLaunch,
} from "@/lib/services/metaTraderTerminalService";
import { isUuid } from "@/lib/terminal/workspace";

/**
 * POST /api/terminal/metatrader/launch  { accountId }
 *
 * What the MetaTrader web terminal needs to pre-fill its sign-in form for one of
 * the CALLER'S OWN accounts: login number, trade server and platform. The
 * password is never returned (the web terminal has no way to receive it - the
 * trader types it once inside the terminal). Opening an account is audited.
 */
export async function POST(req: Request) {
  try {
    const user = await requireAuth();
    if (user.role === "PARTNER") {
      return jsonFail("FORBIDDEN", "Partners do not have a trading terminal.", 403);
    }

    const body = (await req.json().catch(() => null)) as { accountId?: unknown } | null;
    if (!body || !isUuid(body.accountId)) {
      return jsonFail("VALIDATION_ERROR", "A valid account id is required.", 400);
    }

    const target = await resolveMetaTraderLaunch(user.id, body.accountId.toLowerCase());

    void writeAuditLog({
      actorUserId: user.id,
      action: "METATRADER_TERMINAL_LAUNCHED",
      entityType: "trading_account",
      entityId: target.accountId,
      // never the login, server or any credential
      metadata: { platform: target.platform },
    });

    return jsonOk(target, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    if (error instanceof MetaTraderTerminalError) {
      return jsonFail(error.code, error.message, error.statusCode);
    }
    if (!(error instanceof Error && error.name === "AuthError")) {
      console.error("[terminal] metatrader launch failed:", error instanceof Error ? error.message : "unknown error");
    }
    return handleAuthError(error);
  }
}
