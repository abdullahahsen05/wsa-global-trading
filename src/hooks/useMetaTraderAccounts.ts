"use client";

import { useQuery } from "@tanstack/react-query";
import type { BrokerTerminalInfo } from "@/lib/terminal/brokerTerminal";
import type { MetaTraderLaunchTarget, MetaTraderPlatform, MetaTraderTerminalAccount } from "@/lib/terminal/metatrader";

/**
 * The trader's own accounts as the MetaTrader web terminal's picker needs them
 * (masked login only). Not one of the keys `useRealtimeUpdates` invalidates; it
 * refreshes when the window regains focus and when the terminal tab is opened.
 */
export const METATRADER_ACCOUNTS_QUERY_KEY = "terminal-metatrader-accounts";

type Envelope<T> = { ok?: boolean; data?: T; error?: { code?: string; message?: string } };

async function readEnvelope<T>(response: Response, fallbackMessage: string): Promise<T> {
  let json: Envelope<T>;
  try {
    json = (await response.json()) as Envelope<T>;
  } catch {
    throw new Error(fallbackMessage);
  }
  if (!json.ok || json.data === undefined) throw new Error(json.error?.message ?? fallbackMessage);
  return json.data;
}

export function useMetaTraderAccounts(enabled: boolean) {
  return useQuery<MetaTraderTerminalAccount[]>({
    queryKey: [METATRADER_ACCOUNTS_QUERY_KEY],
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/terminal/metatrader/accounts", {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const data = await readEnvelope<{ accounts: MetaTraderTerminalAccount[] }>(
        response,
        "Could not load your trading accounts.",
      );
      return data.accounts;
    },
  });
}

/** Asks the server for the login / server / platform of one of the caller's accounts (never a password). */
export async function fetchMetaTraderLaunch(accountId: string): Promise<MetaTraderLaunchTarget> {
  const response = await fetch("/api/terminal/metatrader/launch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({ accountId }),
  });
  return readEnvelope<MetaTraderLaunchTarget>(response, "Could not open this account in the terminal.");
}

/**
 * What to look the broker's web terminal up for: one of the caller's platform
 * accounts (the server answers from the account itself) or an account added by
 * hand (its server name and platform).
 */
export type BrokerTerminalQuery =
  | { kind: "platform"; accountId: string }
  | { kind: "manual"; server: string; platform: MetaTraderPlatform };

export const BROKER_TERMINAL_QUERY_KEY = "terminal-metatrader-resolve";

/** Asks the server for the address of the web terminal the account's broker hosts (found automatically). */
export async function fetchBrokerTerminal(
  query: BrokerTerminalQuery,
  refresh: boolean,
  signal?: AbortSignal,
): Promise<BrokerTerminalInfo> {
  const response = await fetch("/api/terminal/metatrader/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal,
    body: JSON.stringify(
      query.kind === "platform"
        ? { accountId: query.accountId, refresh }
        : { server: query.server, platform: query.platform, refresh },
    ),
  });
  return readEnvelope<BrokerTerminalInfo>(response, "Could not look up your broker's web terminal.");
}

/**
 * The broker's own web terminal for an account. `attempt` 0 uses what the server
 * already knows; a higher number asks it to look again (limited per user there).
 * A finding is good for a long time, so it is not refetched on focus.
 */
export function useBrokerWebTerminal(query: BrokerTerminalQuery | null, attempt: number, enabled: boolean) {
  const identity = query === null ? null : query.kind === "platform" ? query.accountId : `${query.server}|${query.platform}`;
  return useQuery<BrokerTerminalInfo>({
    queryKey: [BROKER_TERMINAL_QUERY_KEY, identity, attempt],
    enabled: enabled && query !== null,
    retry: false,
    staleTime: 10 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => fetchBrokerTerminal(query as BrokerTerminalQuery, attempt > 0, signal),
  });
}
