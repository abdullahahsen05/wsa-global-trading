"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DataTable,
  EmptyState,
  FilterChipRow,
  InlineStatusStrip,
  Panel,
  WorkspacePage,
  StatusPill,
} from "@/components/app/WorkspaceUI";
import { SearchField } from "@/components/app/FormFields";
import type { AdminSummaryDto } from "@/lib/domain/types";

type PendingApproval = {
  orderId: string;
  userId: string;
  userName: string;
  userEmail: string;
  productCode: string;
  productName: string;
  productType: string;
  amount: number;
  currency: string;
  paidAt: string | null;
};

type AccessRow = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  accessType: "SUBSCRIPTION" | "COPY_ACCOUNT" | "BOT" | "MENTORSHIP";
  productName: string;
  status: string;
  scopeLabel: string;
  currentPeriodEnd: string | null;
  approvedAt: string | null;
  createdAt: string;
};

type AdminBillingData = {
  purchases: Array<unknown>;
  pendingApprovals: PendingApproval[];
  activeAccess: AccessRow[];
  expiredAccess: AccessRow[];
};

type SubscriptionRecord = {
  id: string;
  userName: string;
  userEmail: string;
  productName: string;
  status: "ACTIVE" | "PENDING" | "EXPIRED";
  scopeLabel: string;
  currentPeriodEnd: string | null;
  approvedAt: string | null;
  source: "ACCESS" | "PENDING_APPROVAL";
};

const STATUS_TONE: Record<string, "lime" | "accent" | "muted" | "danger"> = {
  ACTIVE: "lime",
  PENDING: "accent",
  EXPIRED: "danger",
};

export default function AdminSubscriptionsPage() {
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "PENDING" | "EXPIRED">("ALL");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");

  const { data: adminSummary } = useQuery<AdminSummaryDto>({
    queryKey: ["admin-summary"],
    queryFn: async () => {
      const res = await fetch("/api/admin/summary");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load admin summary");
      return json.data;
    },
  });

  const { data: billingData, isLoading } = useQuery<AdminBillingData>({
    queryKey: ["admin-billing-purchases"],
    queryFn: async () => {
      const res = await fetch("/api/admin/billing/purchases?limit=500");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load subscriptions");
      return json.data;
    },
    staleTime: 30_000,
  });

  const activeAccess = billingData?.activeAccess.filter((row) => row.accessType === "SUBSCRIPTION") ?? [];
  const expiredAccess = billingData?.expiredAccess.filter((row) => row.accessType === "SUBSCRIPTION") ?? [];
  const pendingApprovals = billingData?.pendingApprovals.filter((row) => row.productType === "SUBSCRIPTION") ?? [];

  const records = useMemo((): SubscriptionRecord[] => {
    const source = [
      ...activeAccess.map((row) => ({
        id: row.id,
        userName: row.userName,
        userEmail: row.userEmail,
        productName: row.productName,
        status: "ACTIVE" as const,
        scopeLabel: row.scopeLabel,
        currentPeriodEnd: row.currentPeriodEnd,
        approvedAt: row.approvedAt,
        source: "ACCESS" as const,
      })),
      ...pendingApprovals.map((row) => ({
        id: row.orderId,
        userName: row.userName,
        userEmail: row.userEmail,
        productName: row.productName,
        status: "PENDING" as const,
        scopeLabel: "Awaiting activation",
        currentPeriodEnd: null,
        approvedAt: row.paidAt,
        source: "PENDING_APPROVAL" as const,
      })),
      ...expiredAccess.map((row) => ({
        id: row.id,
        userName: row.userName,
        userEmail: row.userEmail,
        productName: row.productName,
        status: "EXPIRED" as const,
        scopeLabel: row.scopeLabel,
        currentPeriodEnd: row.currentPeriodEnd,
        approvedAt: row.approvedAt,
        source: "ACCESS" as const,
      })),
    ];

    const normalizedSearch = search.trim().toLowerCase();
    return source.filter((row) => {
      const matchesStatus = statusFilter === "ALL" || row.status === statusFilter;
      const matchesSearch =
        normalizedSearch.length === 0 ||
        row.userName.toLowerCase().includes(normalizedSearch) ||
        row.userEmail.toLowerCase().includes(normalizedSearch) ||
        row.productName.toLowerCase().includes(normalizedSearch) ||
        row.scopeLabel.toLowerCase().includes(normalizedSearch);
      return matchesStatus && matchesSearch;
    });
  }, [activeAccess, expiredAccess, pendingApprovals, search, statusFilter]);

  const selectedRecord = records.find((row) => row.id === selectedId) ?? records[0] ?? null;

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Subscriptions"
      description="Live subscription access and activation state from billing records."
    >
      <InlineStatusStrip
        items={[
          {
            label: "MRR",
            value: `$${(adminSummary?.monthlyRecurringRevenue?.amount ?? 0).toLocaleString()}`,
            tone: "lime",
          },
          { label: "Active subscriptions", value: activeAccess.length },
          { label: "Pending activations", value: pendingApprovals.length, tone: "accent" },
          {
            label: "Expired subscriptions",
            value: expiredAccess.length,
            tone: expiredAccess.length > 0 ? "danger" : undefined,
          },
        ]}
      />

      <div className="mt-5 rounded-[4px] border border-line bg-panel p-4">
        <SearchField
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search trader, email, product, or scope"
        />

        <div className="mt-4">
          <FilterChipRow
            chips={[
              {
                label: `All (${activeAccess.length + pendingApprovals.length + expiredAccess.length})`,
                active: statusFilter === "ALL",
                onClick: () => setStatusFilter("ALL"),
              },
              {
                label: `Active (${activeAccess.length})`,
                active: statusFilter === "ACTIVE",
                onClick: () => setStatusFilter("ACTIVE"),
              },
              {
                label: `Pending (${pendingApprovals.length})`,
                active: statusFilter === "PENDING",
                onClick: () => setStatusFilter("PENDING"),
              },
              {
                label: `Expired (${expiredAccess.length})`,
                active: statusFilter === "EXPIRED",
                onClick: () => setStatusFilter("EXPIRED"),
              },
            ]}
          />
        </div>
      </div>

      <div className="mt-5 grid items-stretch gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
        <Panel className="min-w-0">
          {isLoading ? (
            <p className="text-sm text-muted">Loading subscription records...</p>
          ) : records.length === 0 ? (
            <EmptyState
              title="No subscription records"
              description="No live subscription records match the current filter."
            />
          ) : (
            <DataTable
              headers={["User", "Product", "Status", "Scope", "Period / Approval"]}
              rows={records.map((row) => [
                <button
                  key="user"
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className="min-w-[200px] text-left"
                >
                  <p className="truncate text-sm font-semibold text-foreground">{row.userName}</p>
                  <p className="truncate text-xs text-muted">{row.userEmail}</p>
                </button>,
                <div key="product" className="min-w-[180px]">
                  <p className="text-sm text-foreground">{row.productName}</p>
                  <p className="text-xs text-muted">Platform subscription</p>
                </div>,
                <StatusPill key="status" tone={STATUS_TONE[row.status] ?? "muted"}>
                  {row.status}
                </StatusPill>,
                <span
                  key="scope"
                  className="block min-w-[160px] max-w-[260px] whitespace-normal text-xs leading-5 text-muted"
                >
                  {row.scopeLabel}
                </span>,
                <div key="period" className="min-w-[160px] text-xs leading-5 text-muted">
                  {row.currentPeriodEnd ? (
                    <p>Period end: {new Date(row.currentPeriodEnd).toLocaleDateString()}</p>
                  ) : null}
                  {row.approvedAt ? (
                    <p>
                      {row.status === "PENDING" ? "Paid" : "Approved"}:{" "}
                      {new Date(row.approvedAt).toLocaleDateString()}
                    </p>
                  ) : null}
                  {!row.currentPeriodEnd && !row.approvedAt ? <span>-</span> : null}
                </div>,
              ])}
            />
          )}
        </Panel>

        {selectedRecord ? (
          <Panel className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
                  Selected subscription
                </p>
                <h2 className="mt-2 text-lg font-semibold text-foreground">
                  {selectedRecord.userName}
                </h2>
                <p className="mt-1 text-sm text-muted">{selectedRecord.productName}</p>
              </div>
              <StatusPill tone={STATUS_TONE[selectedRecord.status] ?? "muted"}>
                {selectedRecord.status}
              </StatusPill>
            </div>

            <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  User
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {selectedRecord.userEmail}
                </p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  Scope
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {selectedRecord.scopeLabel}
                </p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  Current period end
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {selectedRecord.currentPeriodEnd
                    ? new Date(selectedRecord.currentPeriodEnd).toLocaleDateString()
                    : "—"}
                </p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  Source
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {selectedRecord.source === "ACCESS" ? "Live access record" : "Paid order awaiting activation"}
                </p>
              </div>
            </div>

          </Panel>
        ) : (
          <Panel className="min-w-0">
            <p className="text-sm text-muted">No live subscription record selected.</p>
          </Panel>
        )}
      </div>
    </WorkspacePage>
  );
}
