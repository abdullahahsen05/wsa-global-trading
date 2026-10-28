/**
 * Demo-only AWS order pilot. Only one allowlisted MT5 demo account can submit a
 * 0.01-lot market OPEN. The browser presents the short-lived WSA order pass plus
 * the very Supabase access token it was bound to; neither grants access alone.
 * No provider credential or direct-lane signing secret is sent to the browser.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DIRECT_LANE_VERSION, DIRECT_ORDER_TTL_MS, type DirectRequest } from "../../../src/lib/gateway/directLane";
import { sendDirect, warmDirectLane } from "../../../src/lib/gateway/directLaneClient";
import { parseTradeCommand, TradeCommandError } from "../../../src/lib/gateway/tradeCommands";
import { webTradeOpenSchema } from "../../../src/lib/trade/webTradeSchemas";

type GatewayEvent = {
  rawPath?: string;
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
};

type Claims = { user: string; role: string; account: string; token: string; until: number; riskUntil?: number; aws?: { dbMs?: number; loopMs?: number } };
const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(statusCode: number, data: unknown) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store, max-age=0",
      // Match the HTTP API's CORS allowlist so the live panel can read Resource Timing
      // for this cross-origin pilot without exposing timing to unrelated sites.
      "timing-allow-origin": "https://wsa-global-trading-platform.vercel.app",
    },
    body: JSON.stringify(data),
  };
}

function fail(code: string, message: string, statusCode: number, notSent = false) {
  return reply(statusCode, { ok: false, error: { code, message, ...(notSent ? { notSent: true } : {}) } });
}

function passFor(value: string | undefined, token: string, account: string, now: number): Claims | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secret || !value || value.length > 2048 || token.length > 8192) return null;
  const dot = value.indexOf(".");
  if (dot < 1 || dot !== value.lastIndexOf(".")) return null;
  const body = value.slice(0, dot);
  const key = createHmac("sha256", secret).update("wsa-order-pass-v1").digest();
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  if (!same(expected, given)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const claims = raw as Claims & { v?: unknown };
  const tokenHash = createHash("sha256").update(token).digest("base64url");
  if (
    claims.v !== 1 ||
    !UUID.test(claims.user) ||
    claims.user !== process.env.WSA_DEMO_USER_ID ||
    claims.account !== account ||
    claims.token !== tokenHash ||
    !["TRADER", "ADMIN", "SUPER_ADMIN"].includes(claims.role) ||
    typeof claims.until !== "number" || !Number.isFinite(claims.until) ||
    claims.until <= now || claims.until > now + 8_000 ||
    typeof claims.riskUntil !== "number" || !Number.isFinite(claims.riskUntil) ||
    claims.riskUntil <= now || claims.riskUntil > claims.until
  ) return null;
  // The pass was minted for a verified session. Its token must still name that
  // user and be unexpired, in addition to matching the pass's signed hash.
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const jwt = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown };
    if (jwt.sub !== claims.user || typeof jwt.exp !== "number" || jwt.exp * 1000 <= now) return null;
  } catch {
    return null;
  }
  return claims;
}

export async function handler(event: GatewayEvent) {
  const startedAt = Date.now();
  if (event.rawPath !== "/demo/open" || event.requestContext?.http?.method !== "POST") {
    return fail("NOT_FOUND", "Not found.", 404, true);
  }
  if (process.env.WSA_DEMO_ORDER_ENABLED !== "true") {
    return fail("DEMO_ROUTE_OFFLINE", "The demo route is unavailable.", 503, true);
  }
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return fail("VALIDATION_ERROR", "Request is too large.", 413, true);
  const directSecret = process.env.WSA_TRADE_DIRECT_SECRET?.trim();
  const directUrl = process.env.WSA_TRADE_DIRECT_URL?.trim();
  if (
    rawBody === "{}" && event.headers?.authorization === "Bearer warm" &&
    event.headers?.["x-wsa-pass"] === "warm"
  ) {
    // This exact invalid order is sent only to prime the browser's CORS preflight
    // and the Lambda's signed, keep-alive connection to the worker. It never
    // reserves a command or calls the broker.
    if (directSecret && directUrl?.startsWith("https://")) {
      const warmingAt = Date.now();
      await warmDirectLane({ base: directUrl.replace(/\/+$/, ""), secret: directSecret });
      console.info(`[demo-order] signed worker warm-up ${Date.now() - warmingAt}ms`);
    }
    return reply(200, { ok: true, data: { warm: true } });
  }
  let raw: unknown;
  try { raw = JSON.parse(rawBody); } catch { return fail("VALIDATION_ERROR", "Invalid order.", 400, true); }
  const parsed = webTradeOpenSchema.safeParse(raw);
  if (!parsed.success) return fail("VALIDATION_ERROR", "Invalid order.", 400, true);
  const order = parsed.data;
  if (
    order.accountId !== process.env.WSA_DEMO_ACCOUNT_ID ||
    (order.orderKind ?? "MARKET") !== "MARKET" ||
    order.volume !== 0.01
  ) return fail("DEMO_ONLY", "This pilot is limited to 0.01-lot market orders on the test demo account.", 403, true);

  const authorization = event.headers?.authorization ?? "";
  const token = /^Bearer (\S+)$/i.exec(authorization)?.[1] ?? "";
  const claims = passFor(event.headers?.["x-wsa-pass"], token, order.accountId, Date.now());
  if (!claims) return fail("DEMO_PASS_EXPIRED", "Trading checks need a refresh. Try again in a moment.", 401, true);
  if (!directSecret || !directUrl || !directUrl.startsWith("https://")) {
    return fail("DEMO_ROUTE_OFFLINE", "The demo route is unavailable.", 503, true);
  }
  let command;
  try {
    command = parseTradeCommand("OPEN", {
      symbol: order.symbol, side: order.side, volume: order.volume,
      orderKind: "MARKET", price: null,
      stopLoss: order.stopLoss ?? null, takeProfit: order.takeProfit ?? null,
    });
  } catch (error) {
    return fail("VALIDATION_ERROR", error instanceof TradeCommandError ? error.message : "Invalid order.", 400, true);
  }
  const request: DirectRequest = {
    v: DIRECT_LANE_VERSION,
    userId: claims.user,
    accountId: order.accountId,
    kind: "OPEN",
    payload: command.payload,
    clientRequestId: order.clientRequestId,
    ttlMs: DIRECT_ORDER_TTL_MS,
    attempt: 1,
    audit: "AWS_DEMO_OPEN",
  };
  const sentAt = Date.now();
  const lane = { base: directUrl.replace(/\/+$/, ""), secret: directSecret };
  let sent = await sendDirect(lane, request, { deadlineMs: 20_000 });
  if (sent.kind === "not_sent") return fail("DEMO_ROUTE_NOT_SENT", "The demo route was unavailable before the order was sent.", 503, true);
  if (sent.kind === "uncertain") {
    sent = await sendDirect(lane, { ...request, attempt: 2 }, { deadlineMs: 3_000 });
  }
  if (sent.kind !== "answered") {
    return fail("ORDER_UNCERTAIN", "The order may have reached the broker. Check open positions before retrying.", 504);
  }
  if (!sent.reply.ok) {
    return fail(sent.reply.error.code, sent.reply.error.message, sent.reply.error.statusCode);
  }
  const brokerAnsweredAt = Date.now();
  const outcome = sent.reply.outcome;
  const repeated = sent.reply.repeated === true;
  console.info(
    `[demo-order] confirmed ${request.clientRequestId.slice(0, 8)} worker ${brokerAnsweredAt - sentAt}ms` +
    ` queue ${outcome.timing?.queueMs ?? "?"}ms broker ${outcome.timing?.runMs ?? "?"}ms`,
  );
  const result = {
    ok: true,
    ticket: outcome.ticket ?? null,
    ...(outcome.note ? { note: outcome.note } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    ...(repeated ? { repeated: true } : {}),
    ...(outcome.timing ? {
      timing: {
        ...outcome.timing,
        serverMs: Math.max(0, Date.now() - startedAt),
        waitMs: Math.max(0, brokerAnsweredAt - sentAt),
        signInMs: 0,
        checksMs: Math.max(0, sentAt - startedAt),
        wake: "direct",
        awsBrowserPilot: true,
        ...(claims.aws?.dbMs !== undefined ? { awsDbMs: claims.aws.dbMs } : {}),
        ...(claims.aws?.loopMs !== undefined ? { awsLoopMs: claims.aws.loopMs } : {}),
      },
    } : {}),
  };
  return reply(200, { ok: true, data: result });
}
