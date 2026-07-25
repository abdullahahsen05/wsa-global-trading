"use client";

import { useQuery } from "@tanstack/react-query";
import type { SubscriptionDto, UserBillingSummaryDto } from "@/lib/services/billingService";

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
