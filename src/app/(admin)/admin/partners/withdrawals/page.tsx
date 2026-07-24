"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
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
import { SelectField, TextField } from "@/components/app/FormFields";
import { formatMoney } from "@/lib/utils/format";
import type {
  PartnerFinancialLedgerDto,
  PartnerWithdrawalDto,
  PartnerWithdrawalStatus,
} from "@/lib/partner/withdrawals";

const TONES: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  PENDING_REVIEW: "accent",
  APPROVED: "lime",
  PAID: "lime",
  PENDING: "accent",
  REJECTED: "danger",
  CANCELLED: "danger",
  REVERSED: "danger",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Request failed.");
  return payload.data as T;
}

export default function AdminPartnerWithdrawalsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"ALL" | PartnerWithdrawalStatus>("ALL");
  const [requestSearch, setRequestSearch] = useState("");
  const [partnerSearch, setPartnerSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedPartnerId, setSelectedPartnerId] = useState("");
  const [adminNote, setAdminNote] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [rebateAmount, setRebateAmount] = useState("");
  const [rebateStatus, setRebateStatus] = useState<"PENDING" | "APPROVED">("PENDING");
  const [rebateDescription, setRebateDescription] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const withdrawals = useQuery<{ withdrawals: PartnerWithdrawalDto[] }>({
    queryKey: ["admin-withdrawals"],
    queryFn: () => api("/api/admin/partners/withdrawals"),
  });
  const ledgers = useQuery<{ ledgers: PartnerFinancialLedgerDto[] }>({
    queryKey: ["admin-partner-financial-ledgers"],
    queryFn: () => api("/api/admin/partners/financial-ledgers"),
  });
  const allRows = useMemo(
    () => withdrawals.data?.withdrawals ?? [],
    [withdrawals.data?.withdrawals],
  );
  const normalizedRequestSearch = requestSearch.trim().toLowerCase();
  const rows = useMemo(
    () => allRows.filter((row) => {
      if (filter !== "ALL" && row.status !== filter) return false;
      if (!normalizedRequestSearch) return true;
      return [
        row.partnerName,
        row.partnerEmail,
        row.payoutMethod,
        row.payoutReference,
        row.id,
      ].some((value) => value?.toLowerCase().includes(normalizedRequestSearch));
    }),
    [allRows, filter, normalizedRequestSearch],
  );
  const selected = allRows.find((row) => row.id === selectedId);
  const statusCounts = useMemo(
    () => ({
      ALL: allRows.length,
      PENDING_REVIEW: allRows.filter((row) => row.status === "PENDING_REVIEW").length,
      APPROVED: allRows.filter((row) => row.status === "APPROVED").length,
      PAID: allRows.filter((row) => row.status === "PAID").length,
      REJECTED: allRows.filter((row) => row.status === "REJECTED").length,
    }),
    [allRows],
  );
  const ledgerRows = useMemo(
    () => ledgers.data?.ledgers ?? [],
    [ledgers.data?.ledgers],
  );
  const normalizedPartnerSearch = partnerSearch.trim().toLowerCase();
  const visiblePartnerLedgers = useMemo(
    () => ledgerRows.filter((ledger) =>
      !normalizedPartnerSearch
      || [ledger.partnerName, ledger.partnerEmail, ledger.referralCode]
        .some((value) => value?.toLowerCase().includes(normalizedPartnerSearch)),
    ),
    [ledgerRows, normalizedPartnerSearch],
  );
  const selectedLedgerSummary = useMemo(
    () => ledgers.data?.ledgers.find((ledger) => ledger.partnerId === (selectedPartnerId || selected?.partnerId))
      ?? ledgers.data?.ledgers[0]
      ?? null,
    [ledgers.data, selectedPartnerId, selected],
  );
  const ledgerDetail = useQuery<{ ledgers: PartnerFinancialLedgerDto[] }>({
    queryKey: ["admin-partner-financial-ledgers", selectedLedgerSummary?.partnerId, "detail"],
    queryFn: () => api(`/api/admin/partners/financial-ledgers?partnerId=${selectedLedgerSummary?.partnerId}`),
    enabled: Boolean(selectedLedgerSummary?.partnerId),
  });
  const selectedLedger = ledgerDetail.data?.ledgers[0] ?? selectedLedgerSummary;

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-withdrawals"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-partner-financial-ledgers"] }),
    ]);
  }

  const action = useMutation({
    mutationFn: (name: "approve" | "reject" | "mark-paid") =>
      api(`/api/admin/partners/withdrawals/${selectedId}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminNote, rejectionReason }),
      }),
    onSuccess: async () => {
      setError("");
      setNotice("Withdrawal workflow updated and ledger recalculated.");
      setSelectedId("");
      setAdminNote("");
      setRejectionReason("");
      await refresh();
    },
    onError: (actionError: Error) => setError(actionError.message),
  });

  const rebate = useMutation({
    mutationFn: () => {
      if (!selectedLedger) throw new Error("Select a partner first.");
      return api(`/api/admin/partners/${selectedLedger.partnerId}/rebates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(rebateAmount),
          currency: selectedLedger.currency,
          sourceType: "ADMIN_ADJUSTMENT",
          status: rebateStatus,
          description: rebateDescription || null,
        }),
      });
    },
    onSuccess: async () => {
      setError("");
      setNotice("Rebate ledger entry created.");
      setRebateAmount("");
      setRebateDescription("");
      await refresh();
    },
    onError: (rebateError: Error) => setError(rebateError.message),
  });

  function createRebate(event: FormEvent) {
    event.preventDefault();
    rebate.mutate();
  }

  return (
    <WorkspacePage
      eyebrow="Admin · Partners"
      title="Partner financial control"
      description="Review commission and rebate ledgers, locked items, and withdrawal settlement from one server-calculated view."
    >
      <InlineStatusStrip
        items={[
          { label: "Requests", value: statusCounts.ALL },
          { label: "Pending review", value: statusCounts.PENDING_REVIEW, tone: "accent" },
          { label: "Approved", value: statusCounts.APPROVED, tone: "lime" },
          { label: "Paid", value: statusCounts.PAID, tone: "lime" },
          { label: "Partner wallets", value: ledgerRows.length },
        ]}
      />

      <div className="mt-5 flex flex-col gap-3 border-y border-line py-4 xl:flex-row xl:items-center xl:justify-between">
        <FilterChipRow
          chips={(["ALL", "PENDING_REVIEW", "APPROVED", "PAID", "REJECTED"] as const).map((status) => ({
            label: `${status.replaceAll("_", " ")} (${statusCounts[status]})`,
            active: filter === status,
            onClick: () => setFilter(status),
          }))}
        />
        <label className="relative block w-full xl:max-w-sm">
          <span className="sr-only">Search withdrawal requests</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={requestSearch}
            onChange={(event) => setRequestSearch(event.target.value)}
            placeholder="Search partner, method, reference..."
            className="h-11 w-full rounded-[4px] border border-line bg-panel pl-10 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent"
          />
        </label>
      </div>
      {notice ? <p className="mt-4 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm text-accent">{notice}</p> : null}
      {error ? <p className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p> : null}

      <div className={`mt-5 grid items-start gap-5 ${selected ? "xl:grid-cols-3" : ""}`}>
        <Panel className={`min-w-0 w-full overflow-hidden ${selected ? "xl:col-span-2" : ""}`}>
          {withdrawals.isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <EmptyState title="No requests" description="No withdrawal requests match this filter." />
          ) : (
            <DataTable
              initialPageSize={10}
              pageSizeOptions={[10, 20, 50]}
              maxBodyHeight="520px"
              headers={["Partner", "Requested", "Available balance", "Method", "Included items", "Status", ""]}
              rows={rows.map((row) => {
                const partnerLedger = ledgerRows.find(
                  (ledger) => ledger.partnerId === row.partnerId,
                );
                return [
                  <div key="partner">
                    <p className="text-sm font-semibold text-foreground">{row.partnerName ?? "Partner"}</p>
                    <p className="text-xs text-muted">{row.partnerEmail}</p>
                  </div>,
                  <span key="amount" className="font-semibold text-foreground">
                    {formatMoney({ amount: row.amount, currency: row.currency })}
                  </span>,
                  <div key="balance" className="min-w-28">
                    <p className="text-sm font-semibold text-accent-2">
                      {partnerLedger
                        ? formatMoney({ amount: partnerLedger.withdrawableBalance, currency: partnerLedger.currency })
                        : "Loading…"}
                    </p>
                    <p className="mt-1 text-[11px] text-muted">
                      {partnerLedger
                        ? `${formatMoney({ amount: partnerLedger.lockedWithdrawalAmount, currency: partnerLedger.currency })} locked`
                        : "Available now"}
                    </p>
                  </div>,
                  <span key="method" className="text-xs text-muted">{row.payoutMethod}</span>,
                  <span key="items">{row.includedItems?.length ?? 0}</span>,
                  <StatusPill key="status" tone={TONES[row.status] ?? "muted"}>{row.status.replaceAll("_", " ")}</StatusPill>,
                  <GhostButton
                    key="review"
                    type="button"
                    onClick={() => {
                      setSelectedId(row.id);
                      setSelectedPartnerId(row.partnerId);
                      setError("");
                    }}
                  >
                    Review
                  </GhostButton>,
                ];
              })}
            />
          )}
        </Panel>

        <Panel className={selected ? "min-w-0 w-full xl:sticky xl:top-24" : "hidden"}>
          <h2 className="text-lg font-semibold text-foreground">Review request</h2>
          {!selected ? (
            <p className="mt-3 text-sm text-muted">Select a request to inspect its locked ledger items and payout reference.</p>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3 rounded-[4px] border border-accent/20 bg-accent/5 p-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Available now</p>
                  <p className="mt-1 text-lg font-semibold text-accent-2">
                    {selectedLedger
                      ? formatMoney({ amount: selectedLedger.withdrawableBalance, currency: selectedLedger.currency })
                      : "Loading…"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Locked in requests</p>
                  <p className="mt-1 text-lg font-semibold text-foreground">
                    {selectedLedger
                      ? formatMoney({ amount: selectedLedger.lockedWithdrawalAmount, currency: selectedLedger.currency })
                      : "Loading…"}
                  </p>
                </div>
                <p className="col-span-2 text-xs leading-5 text-muted">
                  Requested funds are locked immediately, so they no longer appear in the available balance.
                </p>
              </div>
              <div className="rounded-[4px] border border-line bg-background p-4 text-sm">
                <p className="font-semibold text-foreground">{selected.payoutMethod}</p>
                <p className="mt-1 break-all text-muted">{selected.payoutReference}</p>
                <p className="mt-2 text-xs text-muted">Requested {new Date(selected.createdAt).toLocaleString()}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Locked ledger items</p>
                <div className="mt-3 space-y-2">
                  {(selected.includedItems ?? []).map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-foreground">{item.type} · {item.sourceType}</span>
                      <span className="font-mono text-muted">
                        …{item.ledgerItemId.slice(-8)} · {formatMoney({ amount: item.allocatedAmount, currency: selected.currency })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <textarea value={adminNote} onChange={(event) => setAdminNote(event.target.value)} maxLength={1000} rows={3} placeholder="Admin note (optional)" className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground" />
              {(selected.status === "PENDING_REVIEW" || selected.status === "APPROVED") ? (
                <textarea value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} maxLength={1000} rows={2} placeholder="Rejection reason (required only to reject)" className="w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground" />
              ) : null}
              <div className="flex flex-wrap gap-3 border-t border-line pt-4">
                {selected.status === "PENDING_REVIEW" ? <PrimaryButton type="button" disabled={action.isPending} onClick={() => action.mutate("approve")}>Approve</PrimaryButton> : null}
                {selected.status === "APPROVED" ? <PrimaryButton type="button" disabled={action.isPending} onClick={() => action.mutate("mark-paid")}>Mark paid</PrimaryButton> : null}
                {(selected.status === "PENDING_REVIEW" || selected.status === "APPROVED") ? (
                  <GhostButton type="button" disabled={action.isPending || rejectionReason.trim().length < 3} onClick={() => action.mutate("reject")}>Reject</GhostButton>
                ) : null}
              </div>
            </div>
          )}
        </Panel>
      </div>

      <Panel className="mt-5 overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Partner commission and rebate ledger</h2>
            <p className="mt-1 text-sm text-muted">All balances below are calculated from server-side ledger rows and withdrawal allocations.</p>
          </div>
          <div className="grid w-full gap-3 sm:grid-cols-2 xl:w-auto xl:min-w-[600px]">
            <TextField
              label="Find partner"
              value={partnerSearch}
              onChange={(event) => setPartnerSearch(event.target.value)}
              placeholder="Name, email, or referral code"
            />
            <SelectField
              label={`Partner (${visiblePartnerLedgers.length})`}
              value={selectedLedger?.partnerId ?? ""}
              onChange={(event) => setSelectedPartnerId(event.target.value)}
            >
              {visiblePartnerLedgers.map((ledger) => (
                <option key={ledger.partnerId} value={ledger.partnerId}>{ledger.partnerName} · {ledger.partnerEmail}</option>
              ))}
            </SelectField>
          </div>
        </div>

        {selectedLedger ? (
          <>
            <div className="mt-4 rounded-[4px] border border-line bg-background p-4 text-sm">
              <p className="font-semibold text-foreground">{selectedLedger.partnerName}</p>
              <p className="mt-1 text-muted">
                {selectedLedger.partnerEmail} · referral {selectedLedger.referralCode ?? "not set"} · {selectedLedger.referredTraderCount} referred traders
              </p>
            </div>
            <div className="mt-4">
              <InlineStatusStrip items={[
                { label: "Withdrawable", value: formatMoney({ amount: selectedLedger.withdrawableBalance, currency: selectedLedger.currency }), tone: "lime" },
                { label: "Approved commissions", value: formatMoney({ amount: selectedLedger.approvedUnpaidCommissions, currency: selectedLedger.currency }), tone: "lime" },
                { label: "Approved rebates", value: formatMoney({ amount: selectedLedger.approvedUnpaidRebates, currency: selectedLedger.currency }), tone: "lime" },
                { label: "Locked", value: formatMoney({ amount: selectedLedger.lockedWithdrawalAmount, currency: selectedLedger.currency }), tone: "accent" },
              ]} />
            </div>
            <div className="mt-5 grid items-start gap-5 xl:grid-cols-3">
              <div className="min-w-0 xl:col-span-2">
                {ledgerDetail.isFetching ? (
                  <p className="rounded-[4px] border border-line bg-background px-4 py-5 text-sm text-muted">
                    Loading the selected partner&apos;s full ledger...
                  </p>
                ) : ledgerDetail.isError ? (
                  <p className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-5 text-sm text-danger">
                    The selected partner&apos;s ledger could not be loaded.
                  </p>
                ) : selectedLedger.items.length === 0 ? (
                  <EmptyState title="No ledger entries" description="Commissions and rebates for this partner will appear here." />
                ) : (
                  <DataTable
                    initialPageSize={10}
                    pageSizeOptions={[10, 20, 50]}
                    maxBodyHeight="460px"
                    headers={["Date", "Type", "Source", "Amount", "Status", "Order reference"]}
                    rows={selectedLedger.items.map((item) => [
                      <span key="date" className="text-xs text-muted">{new Date(item.createdAt).toLocaleDateString()}</span>,
                      <span key="type">{item.type}</span>,
                      <span key="source" className="text-xs text-muted">{item.sourceType}</span>,
                      <span key="amount">{formatMoney({ amount: item.amount, currency: item.currency })}</span>,
                      <StatusPill key="status" tone={TONES[item.status] ?? "muted"}>{item.status}</StatusPill>,
                      <span key="reference" className="font-mono text-xs text-muted">{item.paymentOrderId ? `…${item.paymentOrderId.slice(-8)}` : "—"}</span>,
                    ])}
                  />
                )}
              </div>
              <form onSubmit={createRebate} className="flex w-full flex-col gap-4 rounded-[4px] border border-line bg-background p-4 xl:sticky xl:top-24">
                <h3 className="font-semibold text-foreground">Add rebate entry</h3>
                <TextField label={`Amount (${selectedLedger.currency})`} type="number" min="0.01" step="0.01" required value={rebateAmount} onChange={(event) => setRebateAmount(event.target.value)} />
                <SelectField label="Initial status" value={rebateStatus} onChange={(event) => setRebateStatus(event.target.value as typeof rebateStatus)}>
                  <option value="PENDING">Pending</option>
                  <option value="APPROVED">Approved and withdrawable</option>
                </SelectField>
                <TextField label="Description" maxLength={500} value={rebateDescription} onChange={(event) => setRebateDescription(event.target.value)} placeholder="Reason or payment context" />
                <PrimaryButton type="submit" disabled={rebate.isPending || !rebateAmount} className="w-full">
                  {rebate.isPending ? "Creating…" : "Create rebate"}
                </PrimaryButton>
              </form>
            </div>
          </>
        ) : (
          <EmptyState title="No partners" description="Partner financial ledgers will appear after partner profiles exist." />
        )}
      </Panel>
    </WorkspacePage>
  );
}
