"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Clock3, ShieldCheck, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, WorkspacePage } from "@/components/app/WorkspaceUI";
import type { BillingReturnStatusDto } from "@/lib/services/billingService";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const json = await response.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

export default function BillingReturnPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const mockConfirmationStarted = useRef(false);
  const orderId = searchParams.get("orderId");
  const sessionId = searchParams.get("session_id");
  const isMock = searchParams.get("mock") === "1";

  const confirmMockPayment = useMutation({
    mutationFn: () =>
      getJson<{ message: string }>("/api/billing/mock-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["billing-me"] });
      void queryClient.invalidateQueries({ queryKey: ["billing-return", orderId, sessionId] });
    },
  });

  useEffect(() => {
    if (!isMock || !orderId || mockConfirmationStarted.current) return;
    mockConfirmationStarted.current = true;
    confirmMockPayment.mutate();
  }, [confirmMockPayment, isMock, orderId]);

  const statusQuery = useQuery<BillingReturnStatusDto>({
    queryKey: ["billing-return", orderId, sessionId],
    queryFn: () => {
      const params = new URLSearchParams({ orderId: orderId ?? "" });
      if (sessionId) params.set("session_id", sessionId);
      return getJson(`/api/billing/return-status?${params.toString()}`);
    },
    enabled: Boolean(orderId),
    refetchInterval: (query) =>
      query.state.data?.state === "ACTIVE" ||
      query.state.data?.state === "FAILED" ||
      query.state.data?.state === "CANCELLED"
        ? false
        : 5_000,
  });

  const state = statusQuery.data?.state;
  const isErrorState = state === "FAILED" || state === "CANCELLED" || statusQuery.isError;
  const isActive = state === "ACTIVE";
  const isApproval = state === "PENDING_APPROVAL";
  const platformActivated =
    isActive && statusQuery.data?.order.productCode === "PLATFORM_MONTHLY";
  const Icon = isErrorState ? X : isActive ? CheckCircle2 : isApproval ? ShieldCheck : Clock3;
  const iconClass = isErrorState ? "text-danger" : isActive ? "text-lime" : "text-accent";

  useEffect(() => {
    if (!platformActivated) return;
    void queryClient.invalidateQueries({ queryKey: ["billing-me"] });
    const timer = window.setTimeout(() => {
      router.replace("/dashboard");
      router.refresh();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [platformActivated, queryClient, router]);

  return (
    <WorkspacePage
      eyebrow="Billing"
      title="Payment status"
      description={isMock ? "Returned from the local mock checkout flow." : "Returned securely from Stripe Checkout."}
    >
      <Panel className="max-w-2xl overflow-hidden">
        <div className="border-b border-line bg-[radial-gradient(circle_at_top_right,rgba(196,255,77,0.12),transparent_45%)] px-1 pb-6">
          {statusQuery.isLoading || (isMock && confirmMockPayment.isPending) ? (
            <div className="space-y-3 py-4">
              <div className="h-6 w-56 animate-pulse rounded-full bg-panel-strong" />
              <div className="h-4 w-80 max-w-full animate-pulse rounded-full bg-panel-strong" />
            </div>
          ) : (
            <div className="flex items-start gap-4 py-3">
              <div className="rounded-[4px] border border-line bg-background p-3">
                <Icon className={`h-7 w-7 ${iconClass}`} />
              </div>
              <div>
                {statusQuery.data?.order.status === "PAID" ? (
                  <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-lime">
                    Payment confirmed
                  </p>
                ) : null}
                <p className="text-lg font-semibold text-foreground">
                  {statusQuery.isError ? "Payment status unavailable" : statusQuery.data?.title}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {statusQuery.isError
                    ? statusQuery.error instanceof Error
                      ? statusQuery.error.message
                      : "The payment status could not be verified."
                    : statusQuery.data?.message}
                </p>
                {statusQuery.data?.order ? (
                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
                    <span><strong className="text-foreground">Product:</strong> {statusQuery.data.order.productName}</span>
                    <span><strong className="text-foreground">Order:</strong> {statusQuery.data.order.id.slice(0, 8).toUpperCase()}</span>
                    <span><strong className="text-foreground">Payment:</strong> {statusQuery.data.order.status}</span>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {confirmMockPayment.isError ? (
          <p className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            {(confirmMockPayment.error as Error).message}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/marketplace" className="rounded-[4px] border border-line bg-background px-4 py-2 text-xs font-semibold text-foreground hover:border-accent/40">
            Marketplace
          </Link>
          <Link href="/billing" className="rounded-[4px] border border-line bg-background px-4 py-2 text-xs font-semibold text-foreground hover:border-accent/40">
            Billing
          </Link>
          <Link
            href={platformActivated ? "/dashboard" : "/my-bots"}
            className="rounded-[4px] bg-accent px-4 py-2 text-xs font-semibold text-background hover:opacity-90"
          >
            {platformActivated ? "Open trader portal" : "My Bots"}
          </Link>
        </div>
      </Panel>
    </WorkspacePage>
  );
}
