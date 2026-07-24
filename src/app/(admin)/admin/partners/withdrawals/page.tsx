"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
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
    queryKey: ["admin-withdrawals", filter],
    queryFn: () => api(`/api/admin/partners/withdrawals${filter === "ALL" ? "" : `?status=${filter}`}`),
  });
  const ledgers = useQuery<{ ledgers: PartnerFinancialLedgerDto[] }>({
    queryKey: ["admin-partner-financial-ledgers"],
    queryFn: () => api("/api/admin/partners/financial-ledgers"),
  });
  const rows = withdrawals.data?.withdrawals ?? [];
  const selected = rows.find((row) => row.id === selectedId);
  const selectedLedger = useMemo(
    () => ledgers.data?.ledgers.find((ledger) => ledger.partnerId === (selectedPartnerId || selected?.partnerId))
      ?? ledgers.data?.ledgers[0]
      ?? null,
    [ledgers.data, selectedPartnerId, selected],
  );

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
      <FilterChipRow
        chips={(["ALL", "PENDING_REVIEW", "APPROVED", "PAID", "REJECTED"] as const).map((status) => ({
          label: status.replaceAll("_", " "),
          active: filter === status,
          onClick: () => setFilter(status),
        }))}
      />
      {notice ? <p className="mt-4 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm text-accent">{notice}</p> : null}
      {error ? <p className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p> : null}

      <div className="mt-5 grid items-stretch gap-5 xl:h-[620px] xl:grid-cols-3">
        <Panel className="invisible-scrollbar min-h-0 min-w-0 w-full overflow-auto xl:col-span-2 xl:h-full">
          {withdrawals.isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <EmptyState title="No requests" description="No withdrawal requests match this filter." />
          ) : (
            <DataTable
              headers={["Partner", "Requested", "Available balance", "Method", "Included items", "Status", ""]}
              rows={rows.map((row) => {
                const partnerLedger = ledgers.data?.ledgers.find(
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

        <Panel className="invisible-scrollbar min-h-0 min-w-0 w-full overflow-y-auto xl:h-full">
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
          <div className="min-w-[260px]">
            <SelectField
              label="Partner"
              value={selectedLedger?.partnerId ?? ""}
              onChange={(event) => setSelectedPartnerId(event.target.value)}
            >
              {(ledgers.data?.ledgers ?? []).map((ledger) => (
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
            <div className="mt-5 grid items-stretch gap-5 xl:h-[520px] xl:grid-cols-3">
              <div className="invisible-scrollbar min-h-0 min-w-0 overflow-auto xl:col-span-2 xl:h-full">
                {selectedLedger.items.length === 0 ? (
                  <EmptyState title="No ledger entries" description="Commissions and rebates for this partner will appear here." />
                ) : (
                  <DataTable
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
              <form onSubmit={createRebate} className="invisible-scrollbar flex min-h-0 w-full flex-col gap-4 overflow-y-auto rounded-[4px] border border-line bg-background p-4 xl:h-full">
                <h3 className="font-semibold text-foreground">Add rebate entry</h3>
                <TextField label={`Amount (${selectedLedger.currency})`} type="number" min="0.01" step="0.01" required value={rebateAmount} onChange={(event) => setRebateAmount(event.target.value)} />
                <SelectField label="Initial status" value={rebateStatus} onChange={(event) => setRebateStatus(event.target.value as typeof rebateStatus)}>
                  <option value="PENDING">Pending</option>
                  <option value="APPROVED">Approved and withdrawable</option>
                </SelectField>
                <TextField label="Description" maxLength={500} value={rebateDescription} onChange={(event) => setRebateDescription(event.target.value)} placeholder="Reason or payment context" />
                <PrimaryButton type="submit" disabled={rebate.isPending || !rebateAmount} className="mt-auto w-full">
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
