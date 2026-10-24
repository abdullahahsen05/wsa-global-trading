import type { TraderAccountSummary } from "@/lib/domain/types";

/**
 * The trader's own accounts, one query for the whole app. The top bar's account picker and the dashboard / reports used
 * to read the same endpoint under different keys (so the same page asked for it twice, and polled it twice); under this
 * key they share one request. The realtime hook invalidates the `["trading-accounts"]` prefix, which includes it.
 */
export const TRADER_ACCOUNTS_QUERY_KEY = ["trading-accounts", "TRADER"] as const;

export async function fetchTraderAccounts(signal?: AbortSignal): Promise<TraderAccountSummary[]> {
  const res = await fetch("/api/trading-accounts", { cache: "no-store", signal });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Failed to load accounts");
  return json.data;
}
