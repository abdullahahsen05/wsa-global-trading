/**
 * POST /api/dxfeed/feed-token
 *
 * Exchanges the server-side dxFeed feed credential for a short-lived connection
 * token that the browser can use to open the WebSocket feed directly.
 *
 * Why: browser WebSocket connections cannot send custom HTTP headers. The main
 * DXFEED_FEED_AUTH_HEADER never reaches the client — only the short-lived
 * token returned here does. Configure DXFEED_TOKEN_EXCHANGE_URL to the
 * endpoint your dxFeed provisioner gives you.
 *
 * If DXFEED_TOKEN_EXCHANGE_URL is not set the route returns the feed path
 * without a token, which works when your dxFeed plan uses public WSS access
 * (unusual — contact your dxFeed representative).
 */
import { requireAuth } from "@/lib/auth/session";
import { jsonOk, jsonFail, handleAuthError } from "@/lib/api/envelope";
import { getUpstreamPaths, getServerAuthHeaders, isWidgetConfigured } from "@/lib/terminal/dxfeedWidgetConfig";

export async function POST() {
  try {
    await requireAuth();

    if (!isWidgetConfigured()) {
      return jsonFail("NOT_CONFIGURED", "dxFeed widget is not configured", 503);
    }

    const paths = getUpstreamPaths();
    const auth = getServerAuthHeaders();

    // If no token exchange URL is set, return the feed path without a token.
    // The widget will connect without auth (works for public feed plans only).
    if (!paths.tokenExchange) {
      return jsonOk({ feedUrl: paths.feed, hasToken: false });
    }

    // Call dxFeed's token exchange endpoint to obtain a short-lived connection token.
    // The exact request/response shape depends on your dxFeed provisioner's contract.
    const resp = await fetch(paths.tokenExchange, {
      method: "POST",
      headers: {
        "Authorization": auth.feed,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return jsonFail("TOKEN_EXCHANGE_FAILED", `dxFeed token exchange failed: HTTP ${resp.status} — ${text.slice(0, 200)}`, 502);
    }

    const data = await resp.json() as { token?: string; access_token?: string };
    // Support common token field names; adjust to match your provisioner's response shape.
    const token = data.token ?? data.access_token ?? "";

    if (!token) {
      return jsonFail("TOKEN_MISSING", "dxFeed token exchange returned no token field", 502);
    }

    // Return the full WebSocket URL with the short-lived token as a query parameter.
    // The client connects to this URL — the main secret never leaves the server.
    const feedUrl = `${paths.feed}${paths.feed.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

    return jsonOk({ feedUrl, hasToken: true });
  } catch (err) {
    return handleAuthError(err);
  }
}
