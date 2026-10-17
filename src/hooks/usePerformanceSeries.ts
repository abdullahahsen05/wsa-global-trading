"use client";

import { useQuery } from "@tanstack/react-query";
import type { PerformanceRange, PerformanceSeriesDto } from "@/lib/charts/performanceSeries";

/**
 * Query-key prefix of the account performance history.
 *
 * Deliberately NOT one of the keys that `useRealtimeUpdates` invalidates on
 * every snapshot: the endpoint samples the whole history (about 120 indexed
 * look-ups), so it must not refetch every few seconds. It refreshes on a slow
 * interval and, debounced, when a trade changes (see `useRealtimeUpdates`).
 */
export const PERFORMANCE_QUERY_KEY = "account-performance";

const REFETCH_INTERVAL_MS = 60_000;
const STALE_TIME_MS = 20_000;

async function fetchPerformance(
  accountId: string,
  range: PerformanceRange,
  signal?: AbortSignal,
): Promise<PerformanceSeriesDto> {
  const params = new URLSearchParams({ accountId, range });
  const response = await fetch(`/api/analytics/performance?${params.toString()}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("The account history service returned an unreadable response.");
  }

  const envelope = json as {
    ok?: boolean;
    data?: PerformanceSeriesDto;
    error?: { message?: string };
  };
  if (!envelope.ok || !envelope.data) {
    throw new Error(envelope.error?.message ?? "Failed to load account performance history.");
  }
  return envelope.data;
}

/**
 * Sampled balance/equity history + closed-trade ledger for one account (or
 * "ALL" for the combined curve of the caller's connected accounts).
 */
export function usePerformanceSeries(
  accountId: string | null | undefined,
  range: PerformanceRange,
  options: { enabled?: boolean } = {},
) {
  const key = accountId ?? null;
  return useQuery<PerformanceSeriesDto>({
    queryKey: [PERFORMANCE_QUERY_KEY, key, range],
    queryFn: ({ signal }) => fetchPerformance(accountId as string, range, signal),
    enabled: Boolean(accountId) && (options.enabled ?? true),
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: 1,
    // Keep the previous range on screen while another range loads, but never
    // show another account's history while this account loads.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === key ? previousData : undefined,
  });
}
