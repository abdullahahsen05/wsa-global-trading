"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import {
  isUncertainTradeCode,
  WEB_TRADE_BURST_MS,
  WEB_TRADE_BURST_POLL_MS,
  WEB_TRADE_POLL_MS,
  type WebTradeAccountsResponse,
  type WebTradeOrderResult,
  type WebTradeState,
  type WebTradeSymbols,
} from "@/lib/trade/webTrade";

/**
 * WSA Trade data: the caller's accounts (with the platform-wide gate), the live state
 * of one account (figures, positions, pending orders, price) and the symbols the
 * account's broker offers. None of these keys is one of the keys `useRealtimeUpdates`
 * invalidates - the open panel polls by itself, and only while it is on screen.
 */
export const WEB_TRADE_ACCOUNTS_QUERY_KEY = "terminal-web-trade-accounts";
export const WEB_TRADE_STATE_QUERY_KEY = "terminal-web-trade-state";
export const WEB_TRADE_SYMBOLS_QUERY_KEY = "terminal-web-trade-symbols";

type Envelope<T> = { ok?: boolean; data?: T; error?: { code?: string; message?: string } };

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
      return readEnvelope<WebTradeState>(response, "Could not read this account from the broker.");
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

export type WebTradeAction = "open" | "modify" | "close" | "cancel" | "close-bulk";

const WEB_TRADE_ACTIONS: readonly WebTradeAction[] = ["open", "modify", "close", "cancel", "close-bulk"];

/** The browser's high-resolution clock (falls back to the wall clock where there is none). */
function clockMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * One order / change. The server answers with the ticket; a network failure is reported as `uncertain`.
 * The browser adds the total time it waited (`timing.totalMs`), so the report can show how much of it
 * was the network and how much the trading system.
 */
export async function sendWebTrade(action: WebTradeAction, body: Record<string, unknown>): Promise<WebTradeOrderResult> {
  const startedAt = clockMs();
  let response: Response;
  try {
    response = await fetch(`/api/terminal/trade/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch {
    throw new WebTradeRequestError(
      "NETWORK_ERROR",
      "The connection dropped before an answer came back.",
      action !== "modify",
    );
  }
  const result = await readEnvelope<WebTradeOrderResult>(response, "The broker did not answer.");
  if (!result.timing) return result;
  return { ...result, timing: { ...result.timing, totalMs: Math.max(0, Math.round(clockMs() - startedAt)) } };
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
