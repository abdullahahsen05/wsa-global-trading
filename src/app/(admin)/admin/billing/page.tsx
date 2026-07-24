"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2 as CheckCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DataTable,
  EmptyState,
  FilterChipRow,
  GhostButton,
  InlineStatusStrip,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { formatMoney } from "@/lib/utils/format";

type Purchase = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  productCode: string;
  productName: string;
  productType: string;
  amount: number;
  currency: string;
  status: string;
  provider: string;
  intentId: string | null;
  createdAt: string;
  paidAt: string | null;
};

type ApprovalRow = {
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
  purchases: Purchase[];
  pendingApprovals: ApprovalRow[];
  activeAccess: AccessRow[];
  expiredAccess: AccessRow[];
};

const STATUS_TONE: Record<string, "lime" | "accent" | "muted" | "danger"> = {
  ACTIVE: "lime",
  PAID: "lime",
  PENDING: "accent",
  PENDING_APPROVAL: "accent",
  FAILED: "danger",
  CANCELLED: "muted",
  REFUNDED: "muted",
  EXPIRED: "danger",
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data;
}

function AccessTable({
  rows,
  emptyTitle,
  emptyDescription,
}: {
  rows: AccessRow[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <DataTable
      headers={["User", "Access", "Scope", "Status", "Period / Approval"]}
      rows={rows.map((row) => [
        <div key="user" className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{row.userName}</p>
          <p className="truncate text-xs text-muted">{row.userEmail}</p>
        </div>,
        <div key="access">
          <p className="text-sm text-foreground">{row.productName}</p>
          <p className="text-xs text-muted">{row.accessType.replace(/_/g, " ")}</p>
        </div>,
        <span key="scope" className="text-xs text-muted">{row.scopeLabel}</span>,
        <StatusPill key="status" tone={STATUS_TONE[row.status] ?? "muted"}>{row.status}</StatusPill>,
        <div key="period" className="text-xs text-muted">
          {row.currentPeriodEnd ? (
            <p>Period end: {new Date(row.currentPeriodEnd).toLocaleDateString()}</p>
          ) : null}
          {row.approvedAt ? (
            <p>
              {row.accessType === "COPY_ACCOUNT" ? "Auto-activated" : "Approved"}:{" "}
              {new Date(row.approvedAt).toLocaleDateString()}
            </p>
          ) : null}
          {!row.currentPeriodEnd && !row.approvedAt ? <span>-</span> : null}
        </div>,
      ])}
    />
  );
}

export default function AdminBillingPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PAID" | "PENDING" | "FAILED" | "CANCELLED">("ALL");
  const [approveTarget, setApproveTarget] = useState<ApprovalRow | null>(null);
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(""), 6000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  const { data, isLoading, refetch } = useQuery<AdminBillingData>({
    queryKey: ["admin-billing-purchases"],
    queryFn: () => getJson("/api/admin/billing/purchases"),
    staleTime: 30_000,
  });

  const purchases = data?.purchases ?? [];
  const pendingApprovals = data?.pendingApprovals ?? [];
  const activeAccess = data?.activeAccess ?? [];
  const expiredAccess = data?.expiredAccess ?? [];
  const filtered = statusFilter === "ALL" ? purchases : purchases.filter((purchase) => purchase.status === statusFilter);

  const counts = {
    ALL: purchases.length,
    PAID: purchases.filter((purchase) => purchase.status === "PAID").length,
    PENDING: purchases.filter((purchase) => purchase.status === "PENDING").length,
    FAILED: purchases.filter((purchase) => purchase.status === "FAILED").length,
    CANCELLED: purchases.filter((purchase) => purchase.status === "CANCELLED").length,
  };

  const approve = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/billing/purchases/${id}/approve-access`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Approval failed");
      return json.data;
    },
    onSuccess: () => {
      setApproveTarget(null);
      setSuccessMessage("Access approved successfully.");
      qc.invalidateQueries({ queryKey: ["admin-billing-purchases"] });
    },
  });

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Billing & Payments"
      description="Review mock or live payments, approve access, and monitor active and expired billing access."
    >
      {successMessage ? (
        <div className="mb-5 flex items-center gap-2 rounded-[4px] border border-lime/20 bg-lime/10 px-4 py-3 text-sm font-medium text-lime">
          <CheckCircle className="h-4 w-4 shrink-0" />
          {successMessage}
        </div>
      ) : null}

      <InlineStatusStrip
        items={[
          { label: "Orders", value: counts.ALL },
          { label: "Pending approvals", value: pendingApprovals.length, tone: pendingApprovals.length > 0 ? "accent" : undefined },
          { label: "Active access", value: activeAccess.length, tone: activeAccess.length > 0 ? "lime" : undefined },
          { label: "Expired access", value: expiredAccess.length, tone: expiredAccess.length > 0 ? "danger" : undefined },
        ]}
      />

      <Panel className="mt-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Pending approvals</h2>
          <GhostButton type="button" onClick={() => refetch()}>
            Refresh
          </GhostButton>
        </div>
        {isLoading ? (
          <p className="text-sm text-muted">Loading...</p>
        ) : pendingApprovals.length === 0 ? (
          <EmptyState title="No pending approvals" description="Paid orders waiting for manual approval will appear here." />
        ) : (
          <DataTable
            headers={["User", "Product", "Amount", "Paid", "Action"]}
            rows={pendingApprovals.map((row) => [
              <div key="user" className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{row.userName}</p>
                <p className="truncate text-xs text-muted">{row.userEmail}</p>
              </div>,
              <div key="product">
                <p className="text-sm text-foreground">{row.productName}</p>
                <p className="text-xs text-muted">{row.productType}</p>
              </div>,
              <span key="amount">{formatMoney({ amount: row.amount, currency: row.currency })}</span>,
              <span key="paid" className="text-xs text-muted">
                {row.paidAt ? new Date(row.paidAt).toLocaleString() : "-"}
              </span>,
              <GhostButton key="action" type="button" onClick={() => setApproveTarget(row)}>
                Approve access
              </GhostButton>,
            ])}
          />
        )}
      </Panel>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Active access records</h2>
          {isLoading ? (
            <p className="text-sm text-muted">Loading...</p>
          ) : (
            <AccessTable
              rows={activeAccess}
              emptyTitle="No active access"
              emptyDescription="Active subscriptions, auto-activated copy entitlements, bot access, and mentorship approvals show here."
            />
          )}
        </Panel>

        <Panel>
          <h2 className="mb-4 text-lg font-semibold text-foreground">Expired access records</h2>
          {isLoading ? (
            <p className="text-sm text-muted">Loading...</p>
          ) : (
            <AccessTable
              rows={expiredAccess}
              emptyTitle="No expired access"
              emptyDescription="Expired subscriptions and account-level entitlements show here for renewal follow-up."
            />
          )}
        </Panel>
      </div>

      <Panel className="mt-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Payment orders</h2>
          <div className="flex items-center gap-3">
            <FilterChipRow
              chips={(["ALL", "PAID", "PENDING", "FAILED", "CANCELLED"] as const).map((status) => ({
                label: `${status} (${counts[status]})`,
                active: statusFilter === status,
                onClick: () => setStatusFilter(status),
              }))}
            />
            <GhostButton type="button" onClick={() => refetch()}>
              Refresh
            </GhostButton>
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted">Loading...</p>
        ) : filtered.length === 0 ? (
          <EmptyState title="No purchases" description="No payment orders match the selected filter." />
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">Showing {filtered.length} of {purchases.length}</p>
            <DataTable
              headers={["User", "Product", "Amount", "Status", "Provider", "Intent / Order", "Date"]}
              rows={filtered.map((purchase) => [
                <div key="user" className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{purchase.userName}</p>
                  <p className="truncate text-xs text-muted">{purchase.userEmail}</p>
                </div>,
                <div key="product">
                  <p className="text-sm text-foreground">{purchase.productName}</p>
                  <p className="text-xs text-muted">{purchase.productType}</p>
                </div>,
                <span key="amount">{formatMoney({ amount: purchase.amount, currency: purchase.currency })}</span>,
                <StatusPill key="status" tone={STATUS_TONE[purchase.status] ?? "muted"}>{purchase.status}</StatusPill>,
                <span key="provider" className="text-xs text-muted">{purchase.provider}</span>,
                <div key="intent" className="text-xs text-muted">
                  <p className="font-mono">{purchase.intentId ? `${purchase.intentId.slice(0, 20)}...` : purchase.id.slice(0, 12)}</p>
                  <p>{purchase.productCode || "-"}</p>
                </div>,
                <span key="date" className="text-xs text-muted">
                  {new Date(purchase.createdAt).toLocaleString()}
                </span>,
              ])}
            />
          </>
        )}
      </Panel>

      <Dialog.Root open={Boolean(approveTarget)} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
          <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-lime/30 bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
            <Dialog.Title className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <CheckCircle className="h-5 w-5 text-lime" />
              Approve access
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
              This will activate access for <strong className="text-foreground">{approveTarget?.userName}</strong> for{" "}
              <strong className="text-foreground">{approveTarget?.productName}</strong>. This action is logged in the audit trail.
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-3 border-t border-line pt-4">
              <Dialog.Close asChild>
                <GhostButton type="button">Cancel</GhostButton>
              </Dialog.Close>
              <PrimaryButton
                type="button"
                disabled={approve.isPending}
                onClick={() => approveTarget && approve.mutate(approveTarget.orderId)}
              >
                {approve.isPending ? "Approving..." : "Confirm & approve"}
              </PrimaryButton>
            </div>
            {approve.isError ? (
              <p className="mt-3 text-xs text-danger">{(approve.error as Error).message}</p>
            ) : null}
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </WorkspacePage>
  );
}
