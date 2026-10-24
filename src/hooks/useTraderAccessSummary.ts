"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SubscriptionDto, UserBillingSummaryDto } from "@/lib/services/billingService";
import { useSessionUser } from "@/hooks/useSessionUser";
import { useShellHint } from "@/hooks/useShellHint";
import { readRememberedAccess, rememberAccessVerdict, subscribeAccessHint } from "@/lib/shell/accessHint";

export const EMPTY_PLATFORM_SUBSCRIPTION_ACCESS: SubscriptionDto = {
  id: "",
  productCode: "PLATFORM_MONTHLY",
  productName: "Platform Subscription",
  status: "NONE",
  currentPeriodEnd: null,
  approvedAt: null,
  orderId: null,
  message: "",
};

/** What a gated page is drawn from while the server has not yet answered for somebody it remembers as active. */
const ASSUMED_ACTIVE_ACCESS: SubscriptionDto = { ...EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, status: "ACTIVE" };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

export function useTraderAccessSummary() {
  return useQuery<UserBillingSummaryDto>({
    queryKey: ["billing-me"],
    queryFn: () => getJson("/api/billing/me"),
    staleTime: 0,
    retry: 3,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: (query) =>
      query.state.data?.platformSubscription.status === "ACTIVE" ? false : 5_000,
  });
}

export interface PlatformGate {
  /** The server's answer, once it is in (never a guess). */
  summary: UserBillingSummaryDto | undefined;
  /** The subscription the page is drawn from: the real one, or - until it arrives - the remembered "active". */
  access: SubscriptionDto;
  /**
   * True only while nothing at all is known (a first visit, a new browser): the page shows its waiting state. For a
   * person this browser remembers as active it is false from the first paint, so the page starts drawing - and asking
   * for its own data - together with the access check instead of after it.
   */
  checking: boolean;
  /** True while `access` is the remembered guess and not yet the server's answer. */
  assumed: boolean;
}

/**
 * The gate every platform page stands behind. The access check itself is unchanged (same request, same key, asked on
 * every visit); what changed is that its answer is no longer the only thing a returning person waits for. If the answer
 * says the subscription is no longer active, the page switches to the locked view the moment it arrives.
 */
export function usePlatformGate(): PlatformGate {
  const query = useTraderAccessSummary();
  const { data: sessionUser } = useSessionUser();
  const hint = useShellHint();
  const userId = sessionUser?.id ?? hint?.id ?? null;
  const remembered = useSyncExternalStore(
    subscribeAccessHint,
    () => readRememberedAccess(userId),
    () => false,
  );

  const summary = query.data;
  const status = summary?.platformSubscription.status;
  useEffect(() => {
    if (userId && status !== undefined) rememberAccessVerdict(userId, status === "ACTIVE");
  }, [userId, status]);

  if (summary) return { summary, access: summary.platformSubscription, checking: false, assumed: false };
  if (query.isLoading && remembered) {
    return { summary: undefined, access: ASSUMED_ACTIVE_ACCESS, checking: false, assumed: true };
  }
  return { summary: undefined, access: EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, checking: query.isLoading, assumed: false };
}
