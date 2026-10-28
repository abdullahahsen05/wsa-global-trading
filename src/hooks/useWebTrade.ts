"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  isUncertainTradeCode,
  WEB_TRADE_BURST_MS,
  WEB_TRADE_BURST_POLL_MS,
  WEB_TRADE_PASS_HEADER,
  WEB_TRADE_POLL_MS,
  type WebTradeAccountsResponse,
  type WebTradeOrderResult,
  type WebTradeState,
  type WebTradeSymbols,
  type WebTradeTiming,
} from "@/lib/trade/webTrade";
import { historySince, type HistoryPeriodId, type WebTradeHistory } from "@/lib/trade/webTradeHistory";

/**
 * WSA Trade data: the caller's accounts (with the platform-wide gate), the live state
 * of one account (figures, positions, pending orders, price), the symbols the
 * account's broker offers and the closed trades (History). None of the first three keys is one of
 * the keys `useRealtimeUpdates` invalidates - the open panel polls by itself, and only while it is on screen.
 * The History key is the exception on purpose: it starts with "trades", which `useRealtimeUpdates` invalidates
 * whenever the broker sync records a trade, so an open History list follows by itself.
 */
export const WEB_TRADE_ACCOUNTS_QUERY_KEY = "terminal-web-trade-accounts";
export const WEB_TRADE_STATE_QUERY_KEY = "terminal-web-trade-state";
export const WEB_TRADE_SYMBOLS_QUERY_KEY = "terminal-web-trade-symbols";
export const WEB_TRADE_HISTORY_QUERY_KEY = "terminal-web-trade-history";

type Envelope<T> = { ok?: boolean; data?: T; error?: { code?: string; message?: string; notSent?: boolean } };

/** API Gateway's own throttle response is emitted before Lambda invokes the worker. */
export function isGatewayThrottleRefusal(status: number, body: unknown): boolean {
  if (status !== 429 || !body || typeof body !== "object" || Array.isArray(body)) return false;
  const fields = body as Record<string, unknown>;
  return Object.keys(fields).length === 1 && fields.message === "Too Many Requests";
}

/** A failed WSA Trade request. `uncertain`: the request may have reached the broker even though no answer came back. */
export class WebTradeRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly uncertain: boolean,
  ) {
    super(message);
    this.name = "WebTradeRequestError";
  }
}

async function readEnvelope<T>(response: Response, fallbackMessage: string): Promise<T> {
  let json: Envelope<T>;
  try {
    json = (await response.json()) as Envelope<T>;
  } catch {
    throw new WebTradeRequestError("BAD_RESPONSE", fallbackMessage, response.ok);
  }
  if (!json.ok || json.data === undefined) {
    const code = json.error?.code ?? "REQUEST_FAILED";
    throw new WebTradeRequestError(code, json.error?.message ?? fallbackMessage, isUncertainTradeCode(code));
  }
  return json.data;
}

export function useWebTradeAccounts(enabled: boolean) {
  return useQuery<WebTradeAccountsResponse>({
    queryKey: [WEB_TRADE_ACCOUNTS_QUERY_KEY],
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/terminal/trade/accounts", {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      return readEnvelope<WebTradeAccountsResponse>(response, "Could not load your trading accounts.");
    },
  });
}

/**
 * The newest order pass each state poll brought, per account. It is only kept in memory and sent back with an order
 * (`WEB_TRADE_PASS_HEADER`): it tells the server "this session and this account were checked a moment ago", so the order
 * does not wait for those checks again. A pass the server does not accept is simply ignored by it.
 */
const passes = new Map<string, { pass: string; at: number }>();
/** The server stops trusting a pass after about eight seconds; an older one is not even sent. */
const PASS_SEND_MAX_AGE_MS = 9_000;

function rememberPass(state: WebTradeState): void {
  if (state.pass) passes.set(state.accountId, { pass: state.pass, at: Date.now() });
  else passes.delete(state.accountId);
}

function passOf(accountId: unknown): string | null {
  if (typeof accountId !== "string") return null;
  const held = passes.get(accountId);
  return held && Date.now() - held.at <= PASS_SEND_MAX_AGE_MS ? held.pass : null;
}

/** Test helper. */
export function resetWebTradePasses(): void {
  passes.clear();
}

/** Until when the state is asked for faster than usual (set right after an order). */
let fastRefreshUntil = 0;

/**
 * Right after an order or a change the picture is read every `WEB_TRADE_BURST_POLL_MS` for a
 * few seconds, so the new position / level shows up as soon as the AWS trading system has read
 * it from the broker, instead of up to a full normal interval later. Safe to call any time.
 */
export function requestFastRefresh(): void {
  fastRefreshUntil = Date.now() + WEB_TRADE_BURST_MS;
}

/** The pause before the next read of the state: short while a burst is running, normal otherwise. */
export function nextStatePollMs(now: number = Date.now()): number {
  return now < fastRefreshUntil ? WEB_TRADE_BURST_POLL_MS : WEB_TRADE_POLL_MS;
}

/**
 * Live state of one account. Refreshes every second while `active` (the pane is
 * on screen and the browser tab is visible) - every 400 ms for a few seconds after an
 * order (`requestFastRefresh`) - never when hidden. `symbol` decides
 * which price is read; it is the symbol the user has COMMITTED (not every keystroke),
 * and the previous answer stays on screen while the new one loads, so changing the
 * symbol never blanks the positions.
 */
export function useWebTradeState(accountId: string | null, symbol: string, active: boolean) {
  return useQuery<WebTradeState>({
    queryKey: [WEB_TRADE_STATE_QUERY_KEY, accountId, symbol],
    enabled: active && accountId !== null,
    refetchInterval: active ? () => nextStatePollMs() : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ accountId: accountId as string });
      if (symbol) params.set("symbol", symbol);
      const response = await fetch(`/api/terminal/trade/state?${params.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const state = await readEnvelope<WebTradeState>(response, "Could not read this account from the broker.");
      rememberPass(state);
      return state;
    },
  });
}

/**
 * The symbols of the account's broker, spelled the way that broker spells them. Read once
 * and kept for a while (the server keeps the list for hours); a failure just leaves the
 * panel with a plain text field.
 */
export function useWebTradeSymbols(accountId: string | null, enabled: boolean) {
  return useQuery<WebTradeSymbols>({
    queryKey: [WEB_TRADE_SYMBOLS_QUERY_KEY, accountId],
    enabled: enabled && accountId !== null,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/terminal/trade/symbols?accountId=${encodeURIComponent(accountId as string)}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      return readEnvelope<WebTradeSymbols>(response, "Could not load the broker's symbols.");
    },
  });
}

/** How often an open History list asks again (the realtime channel usually gets there first). */
const HISTORY_POLL_MS = 15_000;

/**
 * The closed trades of one account for a period (History tab). Only read while the tab is open: it is a short indexed
 * read of the platform's synchronised trade record, so it costs the broker nothing. A period or account change shows
 * "loading" instead of the previous list (those rows would be another period's).
 */
export function useWebTradeHistory(accountId: string | null, period: HistoryPeriodId, enabled: boolean) {
  return useQuery<WebTradeHistory>({
    queryKey: ["trades", WEB_TRADE_HISTORY_QUERY_KEY, accountId, period],
    enabled: enabled && accountId !== null,
    staleTime: 4_000,
    refetchInterval: enabled ? HISTORY_POLL_MS : false,
    refetchIntervalInBackground: false,
    retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ accountId: accountId as string });
      const since = historySince(period);
      if (since) params.set("since", since);
      const response = await fetch(`/api/terminal/trade/history?${params.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      return readEnvelope<WebTradeHistory>(response, "Could not load the trade history.");
    },
  });
}

export type WebTradeAction = "open" | "modify" | "close" | "cancel" | "close-bulk";

const WEB_TRADE_ACTIONS: readonly WebTradeAction[] = ["open", "modify", "close", "cancel", "close-bulk"];
const DEMO_ORDER_URL = process.env.NEXT_PUBLIC_WSA_DEMO_ORDER_URL?.trim() ?? "";
const DEMO_ACCOUNT_ID = process.env.NEXT_PUBLIC_WSA_DEMO_ACCOUNT_ID?.trim() ?? "";
const PILOT_PASS_MIN_REMAINING_MS = 1_000;

/** Only a routing hint: the AWS gateway still verifies the signature, session, account, and current risk window. */
export function demoPilotPassFresh(pass: string, now: number = Date.now(), requireRisk = true): boolean {
  try {
    if (pass.length > 2_048) return false;
    const body = pass.slice(0, pass.indexOf("."));
    if (!body) return false;
    const claims = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as { until?: unknown; riskUntil?: unknown };
    return typeof claims.until === "number" && claims.until > now + PILOT_PASS_MIN_REMAINING_MS &&
      (!requireRisk || (typeof claims.riskUntil === "number" && claims.riskUntil > now + PILOT_PASS_MIN_REMAINING_MS));
  } catch {
    return false;
  }
}

export function demoOrderCandidate(
  action: WebTradeAction,
  body: Record<string, unknown>,
  pilotUrl: string = DEMO_ORDER_URL,
  pilotAccountId: string = DEMO_ACCOUNT_ID,
): boolean {
  return Boolean(
    pilotUrl && pilotAccountId && body.accountId === pilotAccountId &&
    typeof body.clientRequestId === "string" &&
    (action !== "open" || (body.volume === 0.01 && (body.orderKind === undefined || body.orderKind === "MARKET"))),
  );
}

/** Only this one demo account may use the AWS browser pilot; new orders stay at 0.01 market lots. */
function eligibleForDemoOrderRoute(action: WebTradeAction, body: Record<string, unknown>, pass: string | null): boolean {
  return demoOrderCandidate(action, body) && pass !== null && demoPilotPassFresh(pass, Date.now(), action === "open");
}

/** Same signed credentials as before, carried only in an HTTPS body so the browser need not preflight. */
export function demoPilotRequest(body: Record<string, unknown>, token: string, pass: string, action: WebTradeAction = "open"): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "text/plain" },
    credentials: "omit",
    body: JSON.stringify({ action, order: body, token, pass }),
  };
}

/** The browser's high-resolution clock (falls back to the wall clock where there is none). */
function clockMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** Same-origin Resource Timing partitions browser/hosting delay without timing or changing the order request itself. */
function browserOrderTiming(path: string, startedAt: number, response: Response): Partial<WebTradeTiming> {
  const timing: Partial<WebTradeTiming> = {};
  try {
    const requestId = response.headers.get("apigw-requestid");
    if (requestId && /^[a-z0-9+/=_-]{8,64}$/i.test(requestId)) timing.gatewayRequestId = requestId;
    const route = response.headers.get("x-vercel-id")?.split("::") ?? [];
    const region = (part: string | undefined) => part && /^[a-z][a-z0-9]{2,6}$/i.test(part) ? part.toUpperCase() : undefined;
    timing.edgeRegion = region(route[0]);
    if (route.length > 2) timing.functionRegion = region(route[1]);

    if (typeof window === "undefined" || typeof performance?.getEntriesByName !== "function") return timing;
    const url = new URL(path, window.location.href).href;
    const entries = performance.getEntriesByName(url, "resource");
    const entry = entries.find((candidate) => candidate.startTime >= startedAt - 1) as PerformanceResourceTiming | undefined;
    if (!entry || entry.requestStart <= 0 || entry.responseStart < entry.requestStart || entry.responseEnd < entry.responseStart) return timing;
    const duration = (value: number) => Math.max(0, Math.round(value));
    const phase = (start: number, end: number) =>
      Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start ? duration(end - start) : undefined;
    timing.browserSetupMs = duration(entry.requestStart - entry.startTime);
    const dns = phase(entry.domainLookupStart, entry.domainLookupEnd);
    const connection = phase(entry.connectStart, entry.connectEnd);
    if (dns !== undefined && connection !== undefined) {
      timing.browserDnsMs = dns;
      timing.browserConnectMs = connection;
      timing.browserOtherSetupMs = Math.max(0, timing.browserSetupMs - dns - connection);
    }
    if (entry.secureConnectionStart > 0) {
      timing.browserTlsMs = phase(entry.secureConnectionStart, entry.connectEnd);
    }
    if (typeof entry.nextHopProtocol === "string" && /^[a-z0-9./_-]{1,16}$/i.test(entry.nextHopProtocol)) {
      timing.browserProtocol = entry.nextHopProtocol;
    }
    timing.browserFirstByteMs = duration(entry.responseStart - entry.requestStart);
    timing.browserDownloadMs = duration(entry.responseEnd - entry.responseStart);
  } catch {
    // Optional diagnostics must never turn a broker-confirmed answer into a failed or uncertain order.
  }
  return timing;
}

/**
 * One order / change. The server answers with the ticket; a network failure is reported as `uncertain`.
 * The browser adds the total time it waited (`timing.totalMs`), so the report can show how much of it
 * was the network and how much the trading system.
 */
export async function sendWebTrade(action: WebTradeAction, body: Record<string, unknown>): Promise<WebTradeOrderResult> {
  const startedAt = clockMs();
  let requestStartedAt = startedAt;
  let path = `/api/terminal/trade/${action}`;
  const pass = passOf(body.accountId);
  let pilotFallback: string | undefined = demoOrderCandidate(action, body) && pass && !demoPilotPassFresh(pass, Date.now(), action === "open")
    ? "STALE_PASS" : undefined;
  let pilotAttemptMs: number | undefined;
  let response: Response | undefined;
  try {
    if (eligibleForDemoOrderRoute(action, body, pass)) {
      const session = await createClient().auth.getSession().then((answer) => answer.data.session).catch(() => null);
      if (session?.access_token) {
        path = DEMO_ORDER_URL;
        requestStartedAt = clockMs();
        response = await fetch(path, demoPilotRequest(body, session.access_token, pass as string, action));
        if (!response.ok) {
          const failure = await response.clone().json().catch(() => null) as Envelope<unknown> | null;
          // Only an explicit pre-execution refusal may retry the same request id on the established Vercel route.
          if (failure?.error?.notSent === true || isGatewayThrottleRefusal(response.status, failure)) {
            const code = failure?.error?.code;
            pilotFallback = isGatewayThrottleRefusal(response.status, failure)
              ? "AWS_THROTTLED"
              : typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "NOT_SENT";
            pilotAttemptMs = Math.max(0, Math.round(clockMs() - requestStartedAt));
            path = `/api/terminal/trade/${action}`;
            response = undefined;
          } else if (!failure?.error?.code) {
            throw new WebTradeRequestError(
              "ORDER_UNCERTAIN",
              "The demo route did not return a clear answer. Check open positions before retrying.",
              true,
            );
          }
        }
      } else {
        pilotFallback = "NO_SESSION";
      }
    }
    if (!response) {
      requestStartedAt = clockMs();
      response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(pass ? { [WEB_TRADE_PASS_HEADER]: pass } : {}) },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(body),
      });
    }
  } catch (error) {
    if (error instanceof WebTradeRequestError) throw error;
    throw new WebTradeRequestError(
      "NETWORK_ERROR",
      "The connection dropped before an answer came back.",
      path === DEMO_ORDER_URL || action !== "modify",
    );
  }
  const headersAt = clockMs();
  const result = await readEnvelope<WebTradeOrderResult>(response, "The broker did not answer.");
  if (!result.timing) return result;
  const answeredAt = clockMs();
  return {
    ...result,
    timing: {
      ...result.timing,
      ...(pilotFallback ? { pilotFallback } : {}),
      ...(pilotAttemptMs !== undefined ? { pilotAttemptMs } : {}),
      ...browserOrderTiming(path, requestStartedAt, response),
      browserToHeadersMs: Math.max(0, Math.round(headersAt - startedAt)),
      browserReadMs: Math.max(0, Math.round(answeredAt - headersAt)),
      totalMs: Math.max(0, Math.round(answeredAt - startedAt)),
    },
  };
}

const WARM_EVERY_MS = 4 * 60_000;
/** A hand on the panel renews what the routes keep for an order (sign-in, account, risk, subscription) at most this often. */
const WARM_AGAIN_AFTER_MS = 8_000;
/** The routes that run orders all day; the other two (delete a pending order, close several) are warmed once, plainly. */
const HOT_ACTIONS: readonly WebTradeAction[] = ["open", "close", "modify"];

/**
 * Wakes order routes up, ignoring any failure. A plain GET only starts the route; with an account it also makes the
 * route read - as the signed-in person - what an order on that account checks, and keep it in memory for a few
 * seconds, so the order itself finds it all ready. Nothing comes back but `{ warm: true }`.
 */
export function warmWebTradeRoutes(accountId: string | null = null, actions: readonly WebTradeAction[] = WEB_TRADE_ACTIONS): void {
  if (typeof fetch !== "function") return;
  if (accountId === DEMO_ACCOUNT_ID && DEMO_ORDER_URL && actions.some((action) => HOT_ACTIONS.includes(action))) {
    // Prime the browser connection and signed worker connection without a preflight or order.
    void fetch(DEMO_ORDER_URL, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      credentials: "omit",
      body: "{}",
    }).catch(() => undefined);
  }
  const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
  for (const action of actions) {
    try {
      void Promise.resolve(
        fetch(`/api/terminal/trade/${action}${query}`, { method: "GET", cache: "no-store", credentials: "same-origin" }),
      ).catch(() => undefined);
    } catch {
      // A warm-up is a courtesy; it must never get in the way of the panel.
    }
  }
}

/**
 * Keeps the order routes warm while the panel is on screen: once when it opens (and when the account changes), then
 * every few minutes while the browser tab is visible. Each route is its own serverless function, and the first
 * request to a cold one pays for its start-up and for every check from scratch - this makes sure that is never an order.
 *
 * Returns `warmNow`: call it when a hand reaches for the panel (the pointer moves over it, a key is pressed) and the
 * three routes that run orders renew what they keep for an order - at most once every few seconds, however often it is called.
 */
export function useWarmWebTradeRoutes(enabled: boolean, accountId: string | null = null): () => void {
  const lastWarmAt = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    lastWarmAt.current = Date.now();
    warmWebTradeRoutes(accountId);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      lastWarmAt.current = Date.now();
      warmWebTradeRoutes(accountId);
    }, WARM_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [enabled, accountId]);

  return useCallback(() => {
    if (!enabled || accountId === null) return;
    const now = Date.now();
    if (now - lastWarmAt.current < WARM_AGAIN_AFTER_MS) return;
    lastWarmAt.current = now;
    warmWebTradeRoutes(accountId, HOT_ACTIONS);
  }, [enabled, accountId]);
}

/** One id per click on "Send order" - the server never places two orders for the same id. */
export function newRequestId(): string {
  const cryptoApi = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : null;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
