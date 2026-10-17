import { handleAuthError, jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth } from "@/lib/auth/session";
import { resolveBrokerWebTerminal } from "@/lib/services/brokerWebTerminalService";
import {
  MetaTraderTerminalError,
  resolveMetaTraderLaunch,
} from "@/lib/services/metaTraderTerminalService";
import { normalizePlatform, sanitizeServer } from "@/lib/terminal/metatrader";
import { isUuid } from "@/lib/terminal/workspace";

/**
 * POST /api/terminal/metatrader/resolve
 *   { accountId, refresh? }          one of the CALLER'S OWN platform accounts, or
 *   { server, platform, refresh? }   an account added by hand in the terminal
 *
 * The MetaTrader 5 web terminal runs on the broker's own domain, so which address
 * to open depends on the account's server. This answers with the broker's web
 * terminal address, found automatically (see brokerWebTerminalService): nobody has
 * to look for a link.
 *
 * Nothing in the request is an address, and nothing is fetched on behalf of an
 * address a user typed: for a platform account the server and the broker name are
 * read from the caller's own account, for a manual one only the server name is
 * used. The login and the password are not involved at all.
 */
export const maxDuration = 20;

export async function POST(req: Request) {
  try {
    const user = await requireAuth();
    if (user.role === "PARTNER") {
      return jsonFail("FORBIDDEN", "Partners do not have a trading terminal.", 403);
    }

    const body = (await req.json().catch(() => null)) as {
      accountId?: unknown;
      server?: unknown;
      platform?: unknown;
      refresh?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      return jsonFail("VALIDATION_ERROR", "A platform account or a server and platform are required.", 400);
    }

    let server: string | null;
    let platform: ReturnType<typeof normalizePlatform>;
    let brokerName: string | null = null;

    if (body.accountId !== undefined) {
      if (!isUuid(body.accountId)) {
        return jsonFail("VALIDATION_ERROR", "A valid account id is required.", 400);
      }
      // the caller's own account only: someone else's looks like a missing one
      const target = await resolveMetaTraderLaunch(user.id, body.accountId.toLowerCase());
      server = target.server;
      platform = target.platform;
      brokerName = target.brokerName && target.brokerName !== "WSA GLOBAL" ? target.brokerName : null;
    } else {
      server = sanitizeServer(body.server);
      platform = normalizePlatform(body.platform);
    }

    if (!server || !platform) {
      return jsonFail("VALIDATION_ERROR", "A trade server name and a platform (MT4 or MT5) are required.", 400);
    }

    const info = await resolveBrokerWebTerminal({
      userId: user.id,
      server,
      platform,
      brokerName,
      ownOrigin: new URL(req.url).origin,
      refresh: body.refresh === true,
    });
    return jsonOk(info, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    if (error instanceof MetaTraderTerminalError) {
      return jsonFail(error.code, error.message, error.statusCode);
    }
    if (!(error instanceof Error && error.name === "AuthError")) {
      console.error("[terminal] metatrader resolve failed:", error instanceof Error ? error.message : "unknown error");
    }
    return handleAuthError(error);
  }
}
