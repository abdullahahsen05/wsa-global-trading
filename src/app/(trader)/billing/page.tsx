"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import {
  DataTable,
  EmptyState,
  FilterChipRow,
  InlineStatusStrip,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { formatMoney } from "@/lib/utils/format";
import type { UserBillingSummaryDto } from "@/lib/services/billingService";

const STATUS_TONE: Record<string, "lime" | "accent" | "muted" | "danger"> = {
  ACTIVE: "lime",
  PENDING_APPROVAL: "accent",
  PENDING_PAYMENT: "muted",
  EXPIRED: "danger",
  CANCELLED: "muted",
  PAID: "lime",
  PENDING: "accent",
  FAILED: "danger",
  REFUNDED: "muted",
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data;
}

export default function BillingPage() {
  const [historyFilter, setHistoryFilter] = useState<
    "ALL" | "PAID" | "PENDING" | "FAILED" | "CANCELLED" | "REFUNDED"
  >("ALL");

  const { data: summary, isLoading } = useQuery<UserBillingSummaryDto>({
    queryKey: ["billing-me"],
    queryFn: () => getJson("/api/billing/me"),
    staleTime: 30_000,
  });

  const platformSub = summary?.platformSubscription ?? {
    id: "",
    productCode: "PLATFORM_MONTHLY",
    productName: "Platform Subscription",
    status: "NONE" as const,
    currentPeriodEnd: null,
    approvedAt: null,
    orderId: null,
    message: "",
  };
  const copyEntitlements = summary?.copyEntitlements ?? [];
  const paymentHistory = summary?.paymentHistory ?? [];
  const pendingApprovals = summary?.pendingApprovals ?? [];
  const botAccess = summary?.botAccess ?? [];
  const mentorshipAccess = summary?.mentorshipAccess;

  const filteredHistory =
    historyFilter === "ALL"
      ? paymentHistory
      : paymentHistory.filter((h) => h.status === historyFilter);

  return (
    <WorkspacePage
      eyebrow="Account"
      title="Billing & Access"
      description="Your payment history, active entitlements, and access status."
    >
      <InlineStatusStrip
        items={[
          {
            label: "Platform subscription",
            value: isLoading ? "..." : (platformSub?.status ?? "None"),
            tone: platformSub?.status === "ACTIVE"
              ? "lime"
              : platformSub?.status === "PENDING_APPROVAL"
                ? "accent"
                : "danger",
          },
          {
            label: "Copy entitlements",
            value: copyEntitlements.filter((e) => e.status === "ACTIVE").length,
            tone: "accent",
          },
          {
            label: "Pending approvals",
            value: pendingApprovals.length,
            tone: pendingApprovals.length > 0 ? "accent" : undefined,
          },
        ]}
      />

      {pendingApprovals.length > 0 && (
        <div className="mt-4 flex items-start gap-3 rounded-[4px] border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>{pendingApprovals.length} payment(s)</strong> are awaiting admin approval.
            Access will be activated shortly after review.
          </p>
        </div>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Platform Subscription</h2>
          {platformSub.status !== "NONE" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted">{platformSub.productName}</span>
                <StatusPill tone={STATUS_TONE[platformSub.status] ?? "muted"}>
                  {platformSub.status === "ACTIVE"
                    ? "Active"
                    : platformSub.status === "PENDING_APPROVAL"
                      ? "Payment verified - activating access"
                      : platformSub.status.replace(/_/g, " ")}
                </StatusPill>
              </div>
              {platformSub.currentPeriodEnd && (
                <p className="text-xs text-muted">
                  {platformSub.status === "ACTIVE" ? "Renews on" : "Period ends"}:{" "}
                  {new Date(platformSub.currentPeriodEnd).toLocaleDateString()}
                </p>
              )}
              {platformSub.status === "EXPIRED" && (
                <p className="mt-1 text-xs text-muted">
                  Your subscription has expired. Go to the Dashboard to renew.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">
              No active platform subscription. You can subscribe from the Dashboard banner.
            </p>
          )}
        </Panel>

        <Panel>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Copy Trading Entitlements</h2>
          {copyEntitlements.length === 0 ? (
            <p className="text-sm text-muted">
              No copy entitlements. Purchase one from the Copy Trading page.
            </p>
          ) : (
            <div className="space-y-2">
              {copyEntitlements.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center justify-between gap-3 rounded-[4px] border border-line bg-background px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {e.tier === "PREMIUM" ? "Ultra Fast" : "Normal"} tier
                    </p>
                    {e.currentPeriodEnd && (
                      <p className="text-xs text-muted">
                        {e.status === "ACTIVE" ? "Renews" : "Expires"}:{" "}
                        {new Date(e.currentPeriodEnd).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <StatusPill tone={STATUS_TONE[e.status] ?? "muted"}>
                    {e.status === "ACTIVE"
                      ? "Copy access active"
                      : e.status === "PENDING_APPROVAL"
                        ? "Pending approval"
                        : e.status.replace(/_/g, " ")}
                  </StatusPill>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {botAccess.length > 0 && (
        <Panel className="mt-5">
          <h2 className="mb-4 text-lg font-semibold text-foreground">Bot / EA Access</h2>
          <div className="space-y-2">
            {botAccess.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between gap-3 rounded-[4px] border border-line bg-background px-3 py-2"
              >
                <p className="text-sm font-semibold text-foreground">{b.botName}</p>
                <StatusPill tone={STATUS_TONE[b.status] ?? "muted"}>
                  {b.status === "ACTIVE"
                    ? "Access granted"
                    : b.status === "PENDING_APPROVAL"
                      ? "Activating access"
                      : b.status.replace(/_/g, " ")}
                </StatusPill>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {mentorshipAccess && mentorshipAccess.status !== "NONE" && (
        <Panel className="mt-5">
          <h2 className="mb-4 text-lg font-semibold text-foreground">Mentorship Access</h2>
          <div className="flex items-center justify-between gap-3 rounded-[4px] border border-line bg-background px-3 py-2">
            <p className="text-sm font-semibold text-foreground">{mentorshipAccess.productName}</p>
            <StatusPill tone={STATUS_TONE[mentorshipAccess.status] ?? "muted"}>
              {mentorshipAccess.status === "ACTIVE"
                ? "Access granted"
                : mentorshipAccess.status === "PENDING_APPROVAL"
                  ? "Pending admin approval"
                  : mentorshipAccess.status.replace(/_/g, " ")}
            </StatusPill>
          </div>
        </Panel>
      )}

      <Panel className="mt-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Payment history</h2>
          {paymentHistory.length > 0 && (
            <FilterChipRow
              chips={(["ALL", "PAID", "PENDING", "FAILED", "CANCELLED", "REFUNDED"] as const).map((s) => ({
                label: s === "ALL" ? `All (${paymentHistory.length})` : s,
                active: historyFilter === s,
                onClick: () => setHistoryFilter(s),
              }))}
            />
          )}
        </div>
        {paymentHistory.length === 0 ? (
          <EmptyState
            title="No payments yet"
            description="Your payment history will appear here once you make a purchase."
          />
        ) : (
          <DataTable
            headers={["Product", "Amount", "Status", "Date"]}
            paginated
            initialPageSize={10}
            rows={filteredHistory.map((h) => [
              <span key="n" className="text-sm font-medium text-foreground">
                {h.productName}
              </span>,
              <span key="a">
                {formatMoney({ amount: h.amount, currency: h.currency })}
              </span>,
              <StatusPill key="s" tone={STATUS_TONE[h.status] ?? "muted"}>
                {h.status === "PAID"
                  ? "Paid"
                  : h.status === "PENDING"
                    ? "Pending payment"
                    : h.status === "FAILED"
                      ? "Failed - try again"
                      : h.status}
              </StatusPill>,
              <span key="d" className="text-xs text-muted">
                {new Date(h.createdAt).toLocaleDateString()}
              </span>,
            ])}
          />
        )}
      </Panel>
    </WorkspacePage>
  );
}
