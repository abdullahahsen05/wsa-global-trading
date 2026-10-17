"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  isUncertainTradeCode,
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

/**
 * Live state of one account. Refreshes every couple of seconds while `active` (the pane is
 * on screen and the browser tab is visible), never when hidden. `symbol` decides
 * which price is read; it is the symbol the user has COMMITTED (not every keystroke),
 * and the previous answer stays on screen while the new one loads, so changing the
 * symbol never blanks the positions.
 */
export function useWebTradeState(accountId: string | null, symbol: string, active: boolean) {
  return useQuery<WebTradeState>({
    queryKey: [WEB_TRADE_STATE_QUERY_KEY, accountId, symbol],
    enabled: active && accountId !== null,
    refetchInterval: active ? WEB_TRADE_POLL_MS : false,
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

/** One order / change. The server answers with the ticket; a network failure is reported as `uncertain`. */
export async function sendWebTrade(action: WebTradeAction, body: Record<string, unknown>): Promise<WebTradeOrderResult> {
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
  return readEnvelope<WebTradeOrderResult>(response, "The broker did not answer.");
}

/** One id per click on "Send order" - the server never places two orders for the same id. */
export function newRequestId(): string {
  const cryptoApi = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : null;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
