"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  DataTable,
  EmptyState,
  FilterChipRow,
  GhostButton,
  InlineStatusStrip,
  PageActionGroup,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { formatMoney } from "@/lib/utils/format";
import type { PartnerCommissionDto, PartnerCommissionSummaryDto } from "@/lib/partner/types";
import type {
  PartnerFinancialLedgerDto,
  PartnerWithdrawalBalanceDto,
  PartnerWithdrawalDto,
} from "@/lib/partner/withdrawals";

type FinanceMode = "REBATE" | "CPA" | "HYBRID" | "COMMISSION" | "PAYOUT";

type WithdrawalResponse = {
  balance: PartnerWithdrawalBalanceDto;
  withdrawals: PartnerWithdrawalDto[];
  ledger: PartnerFinancialLedgerDto;
};

type CommissionsResponse = {
  summary: PartnerCommissionSummaryDto;
  records: PartnerCommissionDto[];
};

type PartnerTradeRebateLogDto = {
  id: string;
  traderName: string | null;
  externalTradeId: string | null;
  symbol: string | null;
  lots: number;
  brokerName: string | null;
  modelType: "IB" | "CPA" | "HYBRID" | null;
  calculationType: "IB_VOLUME" | "CPA_TIER" | "ADMIN_ADJUSTMENT" | null;
  rebateAmount: number;
  currency: string;
  status: string;
  createdAt: string;
};

const STATUS_TONE: Record<PartnerCommissionDto["status"], "lime" | "accent" | "danger" | "muted"> = {
  PENDING: "accent",
  APPROVED: "lime",
  PAID: "lime",
  CANCELLED: "muted",
};

const WITHDRAWAL_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  PENDING_REVIEW: "accent",
  APPROVED: "lime",
  PAID: "lime",
  REJECTED: "danger",
};

function titleFor(mode: FinanceMode) {
  if (mode === "REBATE") return "Rebate";
  if (mode === "CPA") return "CPA";
  if (mode === "HYBRID") return "Hybrid";
  if (mode === "COMMISSION") return "WSA Commission %";
  return "WSA Payout";
}

function descriptionFor(mode: FinanceMode) {
  switch (mode) {
    case "REBATE":
      return "Track broker-side, lot-based rebate earnings from referred trader trading activity.";
    case "CPA":
      return "Review broker-side CPA performance as read-only partner reporting.";
    case "HYBRID":
      return "Monitor broker setups where rebate and CPA logic both contribute to partner earnings.";
    case "COMMISSION":
      return "See WSA platform-subscription affiliate commission, separate from broker rebate/CPA/hybrid calculations.";
    case "PAYOUT":
      return "Review WSA commission balance, withdrawable funds, and every payout request step.";
  }
}

function isRebateTrade(row: PartnerTradeRebateLogDto) {
  return row.calculationType === "IB_VOLUME" || row.modelType === "IB";
}

function isCpaTrade(row: PartnerTradeRebateLogDto) {
  return row.calculationType === "CPA_TIER" || row.modelType === "CPA";
}

function isHybridTrade(row: PartnerTradeRebateLogDto) {
  return row.modelType === "HYBRID";
}

function isRebateLedgerItem(item: PartnerFinancialLedgerDto["items"][number]) {
  return item.type === "REBATE" && item.sourceType !== "CPA_TIER";
}

function isCpaLedgerItem(item: PartnerFinancialLedgerDto["items"][number]) {
  return item.type === "COMMISSION" || item.sourceType === "CPA_TIER";
}

function isHybridLedgerItem(item: PartnerFinancialLedgerDto["items"][number]) {
  return item.type === "REBATE" && item.sourceType === "CPA_TIER";
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const json = await response.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

function CommissionRulePanel({ summary }: { summary: PartnerCommissionSummaryDto }) {
  return (
    <div className="mt-4 rounded-[4px] border border-line bg-panel p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
        WSA platform subscription commission
      </p>
      <div className="definition-grid mt-3 grid gap-0 sm:grid-cols-3">
        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">WSA commission %</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{summary.commissionPercent}%</p>
        </div>
        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Pending payout</p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {formatMoney(summary.pending)}
          </p>
        </div>
        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Currency</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{summary.currency}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">
        This is the WSA-payable commission. Broker rebate, CPA, and hybrid figures stay in their own performance pages.
      </p>
    </div>
  );
}

function FinanceLedgerTable({ items }: { items: PartnerFinancialLedgerDto["items"] }) {
  return (
    <DataTable
      headers={["Date", "Type", "Source", "Amount", "Status", "Reference"]}
      rows={items.map((item) => [
        <span key="date" className="text-xs text-muted">{new Date(item.createdAt).toLocaleDateString()}</span>,
        <span key="type">{item.type}</span>,
        <span key="source" className="text-xs text-muted">{item.sourceType}</span>,
        <span key="amount">{formatMoney({ amount: item.amount, currency: item.currency })}</span>,
        <StatusPill key="status" tone={item.status === "APPROVED" || item.status === "PAID" ? "lime" : item.status === "PENDING" ? "accent" : "danger"}>
          {item.status}
        </StatusPill>,
        <span key="reference" className="font-mono text-xs text-muted">
          {item.paymentOrderId ? `…${item.paymentOrderId.slice(-8)}` : "—"}
        </span>,
      ])}
    />
  );
}

function FinanceModePage({ mode }: { mode: Exclude<FinanceMode, "PAYOUT"> }) {
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PENDING" | "APPROVED" | "PAID" | "CANCELLED">("ALL");
  const commissionQuery = useQuery<CommissionsResponse>({
    queryKey: ["partner", "commissions"],
    queryFn: () => getJson("/api/partner/commissions"),
  });
  const rebateQuery = useQuery<{ records: PartnerTradeRebateLogDto[] }>({
    queryKey: ["partner", "rebate-trade-log"],
    queryFn: () => getJson("/api/partner/rebates"),
  });
  const withdrawalQuery = useQuery<WithdrawalResponse>({
    queryKey: ["partner-withdrawals"],
    queryFn: () => getJson("/api/partner/withdrawals"),
  });

  const data: CommissionsResponse | undefined = commissionQuery.data;
  const rebateData: { records: PartnerTradeRebateLogDto[] } | undefined = rebateQuery.data;
  const withdrawalData: WithdrawalResponse | undefined = withdrawalQuery.data;
  const isLoading = commissionQuery.isLoading;
  const isError = commissionQuery.isError;
  const summary: PartnerCommissionSummaryDto | undefined = data?.summary;
  const allCommissionRecords: PartnerCommissionDto[] = data?.records ?? [];
  const tradeRows: PartnerTradeRebateLogDto[] = rebateData?.records ?? [];
  const ledgerItems: PartnerFinancialLedgerDto["items"] = withdrawalData?.ledger.items ?? [];

  const filteredTradeRows = tradeRows.filter((row: PartnerTradeRebateLogDto) => {
    if (mode === "REBATE") return isRebateTrade(row) || isHybridTrade(row);
    if (mode === "CPA") return isCpaTrade(row) || isHybridTrade(row);
    if (mode === "HYBRID") return isHybridTrade(row);
    return true;
  });

  const filteredLedgerItems = ledgerItems.filter((item: PartnerFinancialLedgerDto["items"][number]) => {
    if (mode === "REBATE") return isRebateLedgerItem(item);
    if (mode === "CPA") return isCpaLedgerItem(item);
    if (mode === "HYBRID") return isHybridLedgerItem(item);
    return item.type === "COMMISSION" || item.type === "REBATE";
  });

  const filteredCommissionRecords = (mode === "COMMISSION"
    ? allCommissionRecords
    : allCommissionRecords.filter((record: PartnerCommissionDto) => {
        if (mode === "CPA") return summary?.commissionType === "CPA" || record.sourceType.includes("CPA");
        if (mode === "REBATE") return summary?.commissionType === "REBATE" || !record.sourceType.includes("CPA");
        return true;
      }))
    .filter((record: PartnerCommissionDto) => statusFilter === "ALL" ? true : record.status === statusFilter);

  const ledgerTotal = filteredLedgerItems.reduce((sum: number, item: PartnerFinancialLedgerDto["items"][number]) => sum + item.amount, 0);
  const tradeLots = filteredTradeRows.reduce((sum, row) => sum + row.lots, 0);
  const tradeEarnings = filteredTradeRows.reduce((sum, row) => sum + row.rebateAmount, 0);
  const activeBrokerCount = new Set(filteredTradeRows.map((row) => row.brokerName).filter(Boolean)).size;
  const activeTraderCount = new Set(filteredTradeRows.map((row) => row.traderName).filter(Boolean)).size;
  const qualifiedTradeCount = filteredTradeRows.filter((row) => row.status === "APPROVED" || row.status === "PAID").length;
  const ibRows = filteredTradeRows.filter((row) => row.calculationType === "IB_VOLUME" || row.modelType === "IB");
  const cpaRows = filteredTradeRows.filter((row) => row.calculationType === "CPA_TIER" || row.modelType === "CPA");
  const ibTotal = ibRows.reduce((sum, row) => sum + row.rebateAmount, 0);
  const cpaTotal = cpaRows.reduce((sum, row) => sum + row.rebateAmount, 0);

  const title = titleFor(mode);

  return (
    <WorkspacePage
      eyebrow="Partner"
      title={title}
      description={descriptionFor(mode)}
      action={
        mode === "COMMISSION" ? (
          <PageActionGroup>
            <a href="/api/partner/commissions/export" download>
              <GhostButton type="button" disabled={filteredCommissionRecords.length === 0}>
                <Download className="mr-2 inline-block h-4 w-4" />
                Export CSV
              </GhostButton>
            </a>
          </PageActionGroup>
        ) : undefined
      }
    >
      <InlineStatusStrip
        items={mode === "COMMISSION" ? [
          {
            label: "WSA commission %",
            value: `${summary?.commissionPercent ?? 0}%`,
            tone: "accent",
          },
          {
            label: "Pending",
            value: summary ? formatMoney(summary.pending) : "-",
            tone: "accent",
          },
          {
            label: "Approved",
            value: summary ? formatMoney(summary.approved) : "-",
            tone: "lime",
          },
          {
            label: "Paid",
            value: summary ? formatMoney(summary.paid) : "-",
            tone: "lime",
          },
          {
            label: "Ledger total",
            value: filteredLedgerItems.length > 0
              ? formatMoney({ amount: ledgerTotal, currency: filteredLedgerItems[0]?.currency ?? summary?.currency ?? "USD" })
              : "-",
            tone: ledgerTotal < 0 ? "danger" : "lime",
          },
        ] : mode === "CPA" ? [
          { label: "CPA records", value: filteredTradeRows.length, tone: "accent" },
          { label: "Brokers", value: activeBrokerCount },
          { label: "Clients", value: activeTraderCount },
          { label: "Lots", value: tradeLots.toFixed(2), tone: "accent" },
          { label: "Qualified", value: qualifiedTradeCount, tone: "lime" },
          {
            label: "Total CPA",
            value: formatMoney({ amount: tradeEarnings, currency: filteredTradeRows[0]?.currency ?? summary?.currency ?? "USD" }),
            tone: "lime",
          },
        ] : mode === "HYBRID" ? [
          { label: "Hybrid records", value: filteredTradeRows.length, tone: "accent" },
          { label: "Brokers", value: activeBrokerCount },
          { label: "Clients", value: activeTraderCount },
          { label: "Lots", value: tradeLots.toFixed(2), tone: "accent" },
          {
            label: "IB",
            value: formatMoney({ amount: ibTotal, currency: filteredTradeRows[0]?.currency ?? summary?.currency ?? "USD" }),
            tone: "lime",
          },
          {
            label: "CPA",
            value: formatMoney({ amount: cpaTotal, currency: filteredTradeRows[0]?.currency ?? summary?.currency ?? "USD" }),
            tone: "lime",
          },
        ] : [
          { label: "Broker records", value: filteredTradeRows.length, tone: "accent" },
          { label: "Brokers", value: activeBrokerCount },
          { label: "Traders", value: activeTraderCount },
          { label: "Lots", value: tradeLots.toFixed(2), tone: "accent" },
          {
            label: mode === "REBATE" ? "Rebate earned" : mode === "CPA" ? "CPA earned" : "Hybrid earned",
            value: formatMoney({ amount: tradeEarnings, currency: filteredTradeRows[0]?.currency ?? summary?.currency ?? "USD" }),
            tone: "lime",
          },
        ]}
      />

      {mode === "COMMISSION" && summary ? <CommissionRulePanel summary={summary} /> : null}

      <div className={mode === "REBATE" || mode === "CPA" || mode === "HYBRID" ? "mt-5 grid gap-5" : "mt-5 grid gap-5 xl:grid-cols-[1.1fr_0.9fr]"}>
        <Panel className="min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                {mode === "REBATE" ? "Rebate performance" : mode === "CPA" ? "CPA performance" : mode === "HYBRID" ? "Hybrid performance" : mode === "COMMISSION" ? "Commission ledger" : `${title} activity`}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {mode === "REBATE"
                  ? "Broker → trader → symbol → lots → rebate. Only rebate performance is shown here."
                  : mode === "CPA"
                    ? "Broker → client → symbol → lots → qualified → total. Only CPA performance is shown here."
                    : mode === "HYBRID"
                      ? "Broker → client → symbol → lots → IB → CPA. WSA commission is not shown here."
                      : "Platform subscription commission records generated for the partner account."}
              </p>
            </div>
            <StatusPill tone="accent">
              {mode === "COMMISSION" ? filteredCommissionRecords.length : filteredTradeRows.length} shown
            </StatusPill>
          </div>
          <div className="mt-4">
            {mode === "COMMISSION" ? (
              filteredCommissionRecords.length === 0 ? (
                <EmptyState title="No commission records yet" description="Commission records will appear here once earnings are generated." />
              ) : (
                <DataTable
                  headers={["Date", "Trader", "Source", "Gross", "Rate", "Commission", "Status"]}
                  rows={filteredCommissionRecords.map((record: PartnerCommissionDto) => [
                    <span key="date">{new Date(record.createdAt).toLocaleDateString()}</span>,
                    <span key="trader">{record.traderName ?? "-"}</span>,
                    <span key="source">{record.sourceType}</span>,
                    <span key="gross">{formatMoney({ amount: record.grossAmount, currency: record.currency })}</span>,
                    <span key="rate">{record.commissionPercent}%</span>,
                    <span key="commission" className="font-semibold text-foreground">
                      {formatMoney({ amount: record.commissionAmount, currency: record.currency })}
                    </span>,
                    <StatusPill key="status" tone={STATUS_TONE[record.status]}>
                      {record.status}
                    </StatusPill>,
                  ])}
                />
              )
            ) : filteredTradeRows.length === 0 ? (
              <EmptyState
                title={`No ${title.toLowerCase()} records yet`}
                description={mode === "REBATE"
                  ? "When referred traders close eligible lots, broker, trader, symbol, lots, and rebate values will appear here."
                  : mode === "CPA"
                    ? "When referred clients qualify for CPA, broker, client, lot, qualified, and total values will appear here."
                    : mode === "HYBRID"
                      ? "When referred clients generate hybrid activity, broker, client, lot, IB, and CPA values will appear here."
                  : `When ${title.toLowerCase()} activity is created for your traders, it will appear here.`}
              />
            ) : (
              <DataTable
                initialPageSize={10}
                pageSizeOptions={[10, 20, 50]}
                maxBodyHeight="420px"
                headers={mode === "REBATE"
                  ? ["Broker", "Trader", "Symbol", "Lots", "Rebate", "Status"]
                  : mode === "CPA"
                    ? ["Broker", "Client", "Symbol", "Lots", "Qualified", "Total", "Status"]
                    : ["Broker", "Client", "Symbol", "Lots", "IB", "CPA", "Status"]}
                rows={filteredTradeRows.map((row: PartnerTradeRebateLogDto) => [
                  <span key="broker" className="text-xs text-muted">{row.brokerName ?? "All brokers"}</span>,
                  <span key="trader">{row.traderName ?? (mode === "CPA" || mode === "HYBRID" ? "Client" : "Trader")}</span>,
                  <span key="symbol" className="font-semibold text-foreground">{row.symbol ?? "—"}</span>,
                  <span key="lots">{row.lots.toFixed(2)}</span>,
                  ...(mode === "CPA" ? [
                    <StatusPill key="qualified" tone={row.status === "APPROVED" || row.status === "PAID" ? "lime" : row.status === "PENDING" ? "accent" : "muted"}>
                      {row.status === "APPROVED" || row.status === "PAID" ? "Qualified" : "Pending"}
                    </StatusPill>,
                  ] : []),
                  ...(mode === "HYBRID" ? [
                    <span key="ib" className="font-semibold text-accent-2">
                      {row.calculationType === "IB_VOLUME" ? formatMoney({ amount: row.rebateAmount, currency: row.currency }) : "—"}
                    </span>,
                    <span key="cpa" className="font-semibold text-accent-2">
                      {row.calculationType === "CPA_TIER" ? formatMoney({ amount: row.rebateAmount, currency: row.currency }) : "—"}
                    </span>,
                  ] : [
                  <span key="amount" className="font-semibold text-accent-2">
                    {formatMoney({ amount: row.rebateAmount, currency: row.currency })}
                  </span>,
                  ]),
                  <StatusPill key="status" tone={STATUS_TONE[row.status as PartnerCommissionDto["status"]] ?? "muted"}>
                    {row.status}
                  </StatusPill>,
                ])}
              />
            )}
          </div>
        </Panel>

        {mode !== "REBATE" && mode !== "CPA" && mode !== "HYBRID" ? <Panel className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">
            {mode === "COMMISSION" ? "Commission mix" : `${title} ledger`}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {mode === "COMMISSION"
              ? "Current platform subscription commission rules, pending balances, and what has already cleared."
              : "Server-calculated ledger items used to make wallet and payout balances accurate."}
          </p>
          {mode === "COMMISSION" ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">WSA commission %</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{summary ? `${summary.commissionPercent}%` : "Loading…"}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Approved for WSA payout</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {summary ? formatMoney(summary.approved) : "Loading…"}
                </p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Paid WSA commission</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {summary ? formatMoney(summary.paid) : "Loading…"}
                </p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Payout rule</p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  Only WSA commission is eligible for WSA payout. Broker Rebate, CPA, and Hybrid are shown separately as broker performance.
                </p>
              </div>
            </div>
          ) : filteredLedgerItems.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No ledger items yet" description="Once earnings are generated, the matching ledger entries will appear here." />
            </div>
          ) : (
            <div className="mt-4">
              <FinanceLedgerTable items={filteredLedgerItems.slice(0, 100)} />
            </div>
          )}
        </Panel> : null}
      </div>

      {mode === "COMMISSION" ? <div className="mt-5 rounded-[4px] border border-line bg-panel p-4">
        <FilterChipRow
          chips={(["ALL", "PENDING", "APPROVED", "PAID", "CANCELLED"] as const).map((status) => ({
            label: status === "ALL"
              ? `All (${allCommissionRecords.length})`
              : `${status} (${allCommissionRecords.filter((record: PartnerCommissionDto) => record.status === status).length})`,
            active: statusFilter === status,
            onClick: () => setStatusFilter(status),
          }))}
        />
      </div> : null}

      <div className="mt-5">
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-[4px] border border-line bg-panel" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Failed to load partner finance data.
          </div>
        ) : null}
      </div>
    </WorkspacePage>
  );
}

function PayoutModePage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const withdrawalQuery = useQuery<WithdrawalResponse>({
    queryKey: ["partner-withdrawals"],
    queryFn: () => getJson("/api/partner/withdrawals"),
  });
  const createRequest = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      getJson("/api/partner/withdrawals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      setError("");
      setMessage("Withdrawal request submitted for admin review.");
      void queryClient.invalidateQueries({ queryKey: ["partner-withdrawals"] });
    },
    onError: (mutationError: Error) => {
      setMessage("");
      setError(mutationError.message);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createRequest.mutate({
      amount: Number(form.get("amount")),
      currency: "USD",
      payoutMethod: form.get("payoutMethod"),
      payoutReference: form.get("payoutReference"),
      requestedNote: form.get("requestedNote"),
    });
  }

  const data: WithdrawalResponse | undefined = withdrawalQuery.data;
  const isLoading = withdrawalQuery.isLoading;
  const balance = data?.balance;
  const withdrawals: PartnerWithdrawalDto[] = data?.withdrawals ?? [];
  const commissionLedgerItems = (data?.ledger.items ?? []).filter((item) => item.type === "COMMISSION");
  const hasActive = withdrawals.some((row) => row.status === "PENDING_REVIEW" || row.status === "APPROVED");

  return (
    <WorkspacePage eyebrow="Partner" title="WSA Payout" description={descriptionFor("PAYOUT")}>
      <InlineStatusStrip
        items={[
          { label: "Withdrawable", value: balance ? formatMoney({ amount: balance.available, currency: balance.currency }) : "…", tone: "lime" },
          { label: "Approved WSA commission", value: data?.ledger ? formatMoney({ amount: data.ledger.approvedUnpaidCommissions, currency: data.ledger.currency }) : "…", tone: "lime" },
          { label: "Paid WSA commission", value: data?.ledger ? formatMoney({ amount: data.ledger.paidCommissions, currency: data.ledger.currency }) : "…", tone: "lime" },
          { label: "Reserved / reconciled", value: balance ? formatMoney({ amount: balance.reserved, currency: balance.currency }) : "…", tone: "accent" },
        ]}
      />

      <div className="mt-5 grid gap-4 md:grid-cols-4">
        <Panel>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Partner wallet</p>
          <p className="mt-3 text-2xl font-semibold text-foreground">
            {balance ? formatMoney({ amount: balance.available, currency: balance.currency }) : "…"}
          </p>
          <p className="mt-1 text-xs text-muted">Immediately withdrawable after approvals and existing locks.</p>
        </Panel>
        <Panel>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Approved WSA commission</p>
          <p className="mt-3 text-2xl font-semibold text-foreground">
            {data?.ledger ? formatMoney({ amount: data.ledger.approvedUnpaidCommissions, currency: data.ledger.currency }) : "…"}
          </p>
          <p className="mt-1 text-xs text-muted">WSA commission cleared for payout.</p>
        </Panel>
        <Panel>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Paid WSA commission</p>
          <p className="mt-3 text-2xl font-semibold text-foreground">
            {data?.ledger ? formatMoney({ amount: data.ledger.paidCommissions, currency: data.ledger.currency }) : "…"}
          </p>
          <p className="mt-1 text-xs text-muted">WSA commission already reconciled.</p>
        </Panel>
        <Panel>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Locked requests</p>
          <p className="mt-3 text-2xl font-semibold text-foreground">
            {balance ? formatMoney({ amount: balance.reserved, currency: balance.currency }) : "…"}
          </p>
          <p className="mt-1 text-xs text-muted">Amounts already reserved in active payout requests.</p>
        </Panel>
      </div>

      <div className="mt-5 grid items-stretch gap-5 xl:h-[620px] xl:grid-cols-[0.8fr_1.2fr]">
        <Panel className="invisible-scrollbar min-h-0 overflow-y-auto xl:h-full">
          <h2 className="text-lg font-semibold text-foreground">Request WSA payout</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Only approved WSA platform subscription commission that is not already locked can be paid out. One active request is allowed at a time.
          </p>
          {message ? <p className="mt-4 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm text-accent">{message}</p> : null}
          {error ? <p className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p> : null}
          <form onSubmit={submit} className="mt-5 grid gap-4">
            <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
              Amount (USD)
              <input name="amount" type="number" min={balance?.minimum ?? 100} max={balance?.available ?? 0} step="0.01" required defaultValue={balance?.available || ""} disabled={hasActive} className="mt-2 w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground" />
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
              Payout method
              <input name="payoutMethod" required maxLength={80} placeholder="Bank transfer, USDT, etc." disabled={hasActive} className="mt-2 w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground" />
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
              Payout reference
              <input name="payoutReference" required maxLength={240} placeholder="Account, wallet, or payment reference" disabled={hasActive} className="mt-2 w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground" />
            </label>
            <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
              Note (optional)
              <textarea name="requestedNote" maxLength={1000} rows={3} disabled={hasActive} className="mt-2 w-full rounded-[4px] border border-line bg-background px-3 py-2 text-sm text-foreground" />
            </label>
            <PrimaryButton type="submit" disabled={createRequest.isPending || hasActive || !balance || balance.available < balance.minimum}>
              {createRequest.isPending ? "Submitting…" : hasActive ? "Active request in review" : "Submit payout request"}
            </PrimaryButton>
          </form>
        </Panel>

        <Panel className="flex min-h-0 flex-col overflow-hidden xl:h-full">
          <h2 className="mb-4 shrink-0 text-lg font-semibold text-foreground">Payout history</h2>
          {isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : withdrawals.length === 0 ? (
            <EmptyState title="No payout requests" description="Your submitted payout requests will appear here." />
          ) : (
            <div className="invisible-scrollbar min-h-0 flex-1 overflow-auto">
              <DataTable
                headers={["Requested", "Amount", "Method", "Status", "Review"]}
                rows={withdrawals.map((row: PartnerWithdrawalDto) => [
                  <span key="date" className="text-xs text-muted">{new Date(row.createdAt).toLocaleDateString()}</span>,
                  <span key="amount">{formatMoney({ amount: row.amount, currency: row.currency })}</span>,
                  <span key="method" className="text-sm text-foreground">{row.payoutMethod}</span>,
                  <StatusPill key="status" tone={WITHDRAWAL_TONE[row.status] ?? "muted"}>
                    {row.status.replaceAll("_", " ")}
                  </StatusPill>,
                  <span key="review" className="max-w-[220px] text-xs text-muted">
                    {row.rejectionReason ?? row.adminNote ?? (row.paidAt ? `Paid ${new Date(row.paidAt).toLocaleDateString()}` : "-")}
                  </span>,
                ])}
              />
            </div>
          )}
        </Panel>
      </div>

      <Panel className="mt-5">
        <h2 className="text-lg font-semibold text-foreground">Wallet ledger</h2>
        <p className="mt-1 text-sm text-muted">
          WSA commission entries that feed the partner wallet, withdrawable balance, and payout lock logic.
        </p>
        <div className="mt-4">
          {commissionLedgerItems.length === 0 ? (
            <EmptyState title="No ledger entries" description="WSA commission entries will appear here." />
          ) : (
            <FinanceLedgerTable items={commissionLedgerItems.slice(0, 100)} />
          )}
        </div>
      </Panel>
    </WorkspacePage>
  );
}

export function PartnerFinanceWorkspace({ mode }: { mode: FinanceMode }) {
  if (mode === "PAYOUT") return <PayoutModePage />;
  return <FinanceModePage mode={mode} />;
}
