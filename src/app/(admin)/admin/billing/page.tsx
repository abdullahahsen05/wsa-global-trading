"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2 as CheckCircle, Clock3, X } from "lucide-react";
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
import { SearchField } from "@/components/app/FormFields";
import { formatMoney } from "@/lib/utils/format";

const ACCESS_PAGE_SIZE = 10;
const ORDER_PAGE_SIZE = 15;
const APPROVAL_PAGE_SIZE = 10;

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
    <div className="invisible-scrollbar min-w-0 overflow-x-auto">
      <DataTable
        headers={["User", "Access", "Scope", "Status", "Period / Approval"]}
        rows={rows.map((row) => [
          <div key="user" className="min-w-[190px] max-w-[260px]">
            <p className="truncate text-sm font-semibold text-foreground">{row.userName}</p>
            <p className="truncate text-xs text-muted">{row.userEmail}</p>
          </div>,
          <div key="access" className="min-w-[180px]">
            <p className="text-sm text-foreground">{row.productName}</p>
            <p className="text-xs text-muted">{row.accessType.replace(/_/g, " ")}</p>
          </div>,
          <span key="scope" className="block min-w-[180px] max-w-[280px] whitespace-normal text-xs leading-5 text-muted">
            {row.scopeLabel}
          </span>,
          <StatusPill key="status" tone={STATUS_TONE[row.status] ?? "muted"}>{row.status}</StatusPill>,
          <div key="period" className="min-w-[160px] text-xs leading-5 text-muted">
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
    </div>
  );
}

function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, totalItems);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
        {totalItems === 0 ? "No records" : `${start}-${end} of ${totalItems}`}
      </p>
      <div className="flex gap-2">
        <GhostButton
          type="button"
          disabled={safePage <= 1}
          onClick={() => onPageChange(Math.max(1, safePage - 1))}
        >
          Previous
        </GhostButton>
        <GhostButton
          type="button"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
        >
          Next
        </GhostButton>
      </div>
    </div>
  );
}

export default function AdminBillingPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PAID" | "PENDING" | "FAILED" | "CANCELLED">("ALL");
  const [orderSearch, setOrderSearch] = useState("");
  const [expiredSearch, setExpiredSearch] = useState("");
  const [orderPage, setOrderPage] = useState(1);
  const [approvalPage, setApprovalPage] = useState(1);
  const [activePage, setActivePage] = useState(1);
  const [expiredPage, setExpiredPage] = useState(1);
  const [expiredOpen, setExpiredOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<ApprovalRow | null>(null);
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(""), 6000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  const { data, isLoading, refetch } = useQuery<AdminBillingData>({
    queryKey: ["admin-billing-purchases"],
    queryFn: () => getJson("/api/admin/billing/purchases?limit=500"),
    staleTime: 30_000,
  });

  const purchases = data?.purchases ?? [];
  const pendingApprovals = data?.pendingApprovals ?? [];
  const activeAccess = data?.activeAccess ?? [];
  const expiredAccess = data?.expiredAccess ?? [];
  const normalizedOrderSearch = orderSearch.trim().toLowerCase();
  const filtered = purchases.filter((purchase) => {
    const matchesStatus = statusFilter === "ALL" || purchase.status === statusFilter;
    const matchesSearch = normalizedOrderSearch.length === 0
      || purchase.userName.toLowerCase().includes(normalizedOrderSearch)
      || purchase.userEmail.toLowerCase().includes(normalizedOrderSearch)
      || purchase.productName.toLowerCase().includes(normalizedOrderSearch)
      || purchase.productCode.toLowerCase().includes(normalizedOrderSearch)
      || purchase.provider.toLowerCase().includes(normalizedOrderSearch)
      || purchase.intentId?.toLowerCase().includes(normalizedOrderSearch) === true
      || purchase.id.toLowerCase().includes(normalizedOrderSearch);
    return matchesStatus && matchesSearch;
  });
  const normalizedExpiredSearch = expiredSearch.trim().toLowerCase();
  const filteredExpiredAccess = expiredAccess.filter((row) => (
    normalizedExpiredSearch.length === 0
    || row.userName.toLowerCase().includes(normalizedExpiredSearch)
    || row.userEmail.toLowerCase().includes(normalizedExpiredSearch)
    || row.productName.toLowerCase().includes(normalizedExpiredSearch)
    || row.scopeLabel.toLowerCase().includes(normalizedExpiredSearch)
  ));
  const approvalPageSafe = Math.min(
    approvalPage,
    Math.max(1, Math.ceil(pendingApprovals.length / APPROVAL_PAGE_SIZE)),
  );
  const activePageSafe = Math.min(
    activePage,
    Math.max(1, Math.ceil(activeAccess.length / ACCESS_PAGE_SIZE)),
  );
  const expiredPageSafe = Math.min(
    expiredPage,
    Math.max(1, Math.ceil(filteredExpiredAccess.length / ACCESS_PAGE_SIZE)),
  );
  const orderPageSafe = Math.min(
    orderPage,
    Math.max(1, Math.ceil(filtered.length / ORDER_PAGE_SIZE)),
  );
  const visibleApprovals = pendingApprovals.slice(
    (approvalPageSafe - 1) * APPROVAL_PAGE_SIZE,
    approvalPageSafe * APPROVAL_PAGE_SIZE,
  );
  const visibleActiveAccess = activeAccess.slice(
    (activePageSafe - 1) * ACCESS_PAGE_SIZE,
    activePageSafe * ACCESS_PAGE_SIZE,
  );
  const visibleExpiredAccess = filteredExpiredAccess.slice(
    (expiredPageSafe - 1) * ACCESS_PAGE_SIZE,
    expiredPageSafe * ACCESS_PAGE_SIZE,
  );
  const visibleOrders = filtered.slice(
    (orderPageSafe - 1) * ORDER_PAGE_SIZE,
    orderPageSafe * ORDER_PAGE_SIZE,
  );

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
          <div className="invisible-scrollbar min-w-0 overflow-x-auto">
            <DataTable
              headers={["User", "Product", "Amount", "Paid", "Action"]}
              rows={visibleApprovals.map((row) => [
                <div key="user" className="min-w-[190px] max-w-[260px]">
                  <p className="truncate text-sm font-semibold text-foreground">{row.userName}</p>
                  <p className="truncate text-xs text-muted">{row.userEmail}</p>
                </div>,
                <div key="product" className="min-w-[180px]">
                  <p className="text-sm text-foreground">{row.productName}</p>
                  <p className="text-xs text-muted">{row.productType}</p>
                </div>,
                <span key="amount" className="whitespace-nowrap">
                  {formatMoney({ amount: row.amount, currency: row.currency })}
                </span>,
                <span key="paid" className="min-w-[150px] text-xs text-muted">
                  {row.paidAt ? new Date(row.paidAt).toLocaleString() : "-"}
                </span>,
                <GhostButton key="action" type="button" onClick={() => setApproveTarget(row)}>
                  Approve access
                </GhostButton>,
              ])}
            />
          </div>
        )}
        {!isLoading && pendingApprovals.length > APPROVAL_PAGE_SIZE ? (
          <div className="mt-4">
            <Pagination
              page={approvalPageSafe}
              pageSize={APPROVAL_PAGE_SIZE}
              totalItems={pendingApprovals.length}
              onPageChange={setApprovalPage}
            />
          </div>
        ) : null}
      </Panel>

      <div className="mt-5">
        <Panel className="min-w-0">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Active access records</h2>
              <p className="mt-1 text-sm text-muted">
                Current subscriptions and account-level entitlements, newest first.
              </p>
            </div>
            <GhostButton type="button" onClick={() => setExpiredOpen(true)}>
              <Clock3 className="mr-2 inline-block h-4 w-4" />
              View expired ({expiredAccess.length})
            </GhostButton>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted">Loading...</p>
          ) : (
            <AccessTable
              rows={visibleActiveAccess}
              emptyTitle="No active access"
              emptyDescription="Active subscriptions, auto-activated copy entitlements, bot access, and mentorship approvals show here."
            />
          )}
          {!isLoading && activeAccess.length > ACCESS_PAGE_SIZE ? (
            <div className="mt-4">
              <Pagination
                page={activePageSafe}
                pageSize={ACCESS_PAGE_SIZE}
                totalItems={activeAccess.length}
                onPageChange={setActivePage}
              />
            </div>
          ) : null}
        </Panel>
      </div>

      <Panel className="mt-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Payment orders</h2>
            <p className="mt-1 text-sm text-muted">
              Search and review up to 500 recent orders without loading one oversized table.
            </p>
          </div>
          <div className="flex w-full flex-wrap items-end gap-3 lg:w-auto">
            <div className="min-w-[240px] flex-1 lg:w-[320px]">
              <SearchField
                aria-label="Search payment orders"
                placeholder="User, product, provider, or order ID"
                value={orderSearch}
                onChange={(event) => {
                  setOrderSearch(event.target.value);
                  setOrderPage(1);
                }}
              />
            </div>
            <GhostButton type="button" onClick={() => refetch()}>
              Refresh
            </GhostButton>
          </div>
        </div>
        <div className="invisible-scrollbar mb-4 overflow-x-auto border-b border-line pb-3">
          <div className="min-w-max">
            <FilterChipRow
              chips={(["ALL", "PAID", "PENDING", "FAILED", "CANCELLED"] as const).map((status) => ({
                label: `${status} (${counts[status]})`,
                active: statusFilter === status,
                onClick: () => {
                  setStatusFilter(status);
                  setOrderPage(1);
                },
              }))}
            />
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted">Loading...</p>
        ) : filtered.length === 0 ? (
          <EmptyState title="No purchases" description="No payment orders match the selected filter." />
        ) : (
          <>
            <div className="invisible-scrollbar min-w-0 overflow-x-auto">
              <DataTable
                headers={["User", "Product", "Amount", "Status", "Provider", "Intent / Order", "Date"]}
                rows={visibleOrders.map((purchase) => [
                  <div key="user" className="min-w-[190px] max-w-[250px]">
                    <p className="truncate text-sm font-semibold text-foreground">{purchase.userName}</p>
                    <p className="truncate text-xs text-muted">{purchase.userEmail}</p>
                  </div>,
                  <div key="product" className="min-w-[180px] max-w-[260px]">
                    <p className="text-sm text-foreground">{purchase.productName}</p>
                    <p className="text-xs text-muted">{purchase.productType}</p>
                  </div>,
                  <span key="amount" className="whitespace-nowrap">
                    {formatMoney({ amount: purchase.amount, currency: purchase.currency })}
                  </span>,
                  <StatusPill key="status" tone={STATUS_TONE[purchase.status] ?? "muted"}>{purchase.status}</StatusPill>,
                  <span key="provider" className="text-xs text-muted">{purchase.provider}</span>,
                  <div key="intent" className="min-w-[190px] text-xs text-muted">
                    <p className="font-mono">{purchase.intentId ? `${purchase.intentId.slice(0, 20)}...` : purchase.id.slice(0, 12)}</p>
                    <p>{purchase.productCode || "-"}</p>
                  </div>,
                  <span key="date" className="min-w-[150px] text-xs text-muted">
                    {new Date(purchase.createdAt).toLocaleString()}
                  </span>,
                ])}
              />
            </div>
            <div className="mt-4">
              <Pagination
                page={orderPageSafe}
                pageSize={ORDER_PAGE_SIZE}
                totalItems={filtered.length}
                onPageChange={setOrderPage}
              />
            </div>
          </>
        )}
      </Panel>

      <Dialog.Root
        open={expiredOpen}
        onOpenChange={(open) => {
          setExpiredOpen(open);
          if (!open) {
            setExpiredSearch("");
            setExpiredPage(1);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[96vw] max-w-6xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[6px] border border-line bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.65)] focus:outline-none">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-5 sm:px-6">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent">
                  Billing archive
                </p>
                <Dialog.Title className="mt-2 text-xl font-semibold text-foreground">
                  Expired access records
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">
                  Review expired subscriptions and entitlements for renewal follow-up.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close expired access records"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-[4px] border border-line bg-background text-muted transition-colors hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div className="w-full sm:max-w-md">
                  <SearchField
                    label="Search expired access"
                    placeholder="User, email, product, or scope"
                    value={expiredSearch}
                    onChange={(event) => {
                      setExpiredSearch(event.target.value);
                      setExpiredPage(1);
                    }}
                  />
                </div>
                <StatusPill tone="danger">{filteredExpiredAccess.length} records</StatusPill>
              </div>
              <div className="invisible-scrollbar max-h-[52vh] overflow-y-auto">
                <AccessTable
                  rows={visibleExpiredAccess}
                  emptyTitle="No expired access"
                  emptyDescription={
                    expiredSearch
                      ? "No expired access records match this search."
                      : "Expired subscriptions and account-level entitlements will appear here."
                  }
                />
              </div>
              <div className="mt-4">
                <Pagination
                  page={expiredPageSafe}
                  pageSize={ACCESS_PAGE_SIZE}
                  totalItems={filteredExpiredAccess.length}
                  onPageChange={setExpiredPage}
                />
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

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
