"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingDown } from "lucide-react";
import {
  DataTable,
  EmptyState,
  InlineStatusStrip,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { AccountPerformanceChart } from "@/components/charts/AccountPerformanceChart";
import { deriveSeries, rangeForAnalyticsPeriod } from "@/lib/charts/performanceSeries";
import { usePerformanceSeries } from "@/hooks/usePerformanceSeries";
import { formatMoney, formatPercent } from "@/lib/utils/format";
import type {
  AnalyticsSummary,
  TraderAccountSummary,
} from "@/lib/domain/types";
import {
  EMPTY_PLATFORM_SUBSCRIPTION_ACCESS,
  useTraderAccessSummary,
} from "@/hooks/useTraderAccessSummary";
import { isLiveConnectedAccount, resolveLiveSelectedAccountId } from "@/lib/accounts/lifecycle";
import { useTradingAccountSelection } from "@/providers/TradingAccountSelectionProvider";

const periods = ["DAILY", "WEEKLY", "MONTHLY", "ALL_TIME"] as const;

function DrawdownMeter({ value }: { value: number }) {
  const chartMaximum = Math.max(1, Math.ceil(Math.max(0, value) * 1.25 * 10) / 10);
  const capped = Math.min(Math.max(0, value), chartMaximum);
  return (
    <div className="rounded-[4px] border border-line bg-panel p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            Drawdown meter
          </h3>
          <p className="mt-1 text-xs text-muted">
            Current drawdown pressure across live data
          </p>
        </div>
        <StatusPill
          tone={value >= 6 ? "danger" : value >= 4 ? "accent" : "lime"}
        >
          {formatPercent(value)}
        </StatusPill>
      </div>
      <div className="mt-5 h-4 overflow-hidden rounded-full border border-line bg-background">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${(capped / chartMaximum) * 100}%` }}
        />
      </div>
      <div className="mt-4 flex items-center justify-between text-xs text-muted">
        <span>0%</span>
        <span>{formatPercent(chartMaximum / 2)}</span>
        <span>{formatPercent(chartMaximum)}</span>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access =
    summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage
        eyebrow="Performance lab"
        title="Analytics"
        description="Loading your platform access status."
      >
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (access.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Performance lab"
        title="Analytics"
        description="Activate your platform subscription to unlock equity analytics and performance reporting."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock analytics, equity breakdowns, and performance reporting workflows."
        />
      </WorkspacePage>
    );
  }

  return <AnalyticsContent />;
}

function AnalyticsContent() {
  const [period, setPeriod] = useState<(typeof periods)[number]>("ALL_TIME");
  const [allScopeSelection, setAllScopeSelection] = useState<{ selectedAccountId: string | null } | null>(null);
  const { selectedAccountId, setSelectedAccountId } = useTradingAccountSelection();
  const showAllAccounts = allScopeSelection !== null
    && allScopeSelection.selectedAccountId === selectedAccountId;

  const {
    data: accounts = [],
    isLoading: accountsLoading,
    isError: accountsError,
  } = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/trading-accounts");
      const json = await res.json();
      if (!json.ok)
        throw new Error(json.error?.message ?? "Failed to load accounts");
      return json.data;
    },
    refetchInterval: 10_000,
  });

  const connectedAccounts = accounts.filter(isLiveConnectedAccount);
  const accountScope = showAllAccounts
    ? "ALL"
    : resolveLiveSelectedAccountId(accounts, selectedAccountId);
  const selectedAccount = connectedAccounts.find(
    (account) => account.accountId === accountScope,
  );

  const {
    data: analyticsSummary,
    isLoading: analyticsLoading,
    isError: analyticsError,
  } = useQuery<AnalyticsSummary>({
    queryKey: ["analytics-summary", accountScope, period],
    queryFn: async () => {
      const res = await fetch(
        `/api/analytics/summary?accountId=${accountScope}&period=${period}`,
      );
      const json = await res.json();
      if (!json.ok)
        throw new Error(json.error?.message ?? "Failed to load analytics");
      return json.data;
    },
    enabled: !accountsLoading && Boolean(accountScope),
    refetchInterval: 10_000,
  });


  // Same query as the chart below (same key), so no extra request. The summary
  // only sees the newest snapshots, so the deepest fall of the sampled history
  // is taken into account as well when the scope has a longer history.
  const { data: performanceSeries } = usePerformanceSeries(
    accountScope,
    rangeForAnalyticsPeriod(period),
    { enabled: !accountsLoading && Boolean(accountScope) },
  );
  const chartMaxDrawdown = useMemo(
    () => (performanceSeries ? deriveSeries(performanceSeries).maxDrawdownPct : 0),
    [performanceSeries],
  );
  const maxDrawdownPercent = Math.max(analyticsSummary?.maxDrawdownPercent ?? 0, chartMaxDrawdown);
  const selectedCurrency =
    analyticsSummary?.totalProfit.currency ??
    selectedAccount?.equity.currency ??
    selectedAccount?.balance.currency ??
    "USD";

  if (accountsLoading) {
    return (
      <WorkspacePage
        eyebrow="Analytics"
        title="Performance intelligence"
        description="Loading connected accounts."
      >
        <Panel>
          <p className="text-sm text-muted">Loading accounts…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (accountsError) {
    return (
      <WorkspacePage
        eyebrow="Analytics"
        title="Performance intelligence"
        description="Account-scoped performance analytics."
      >
        <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
          Connected accounts could not be loaded. Refresh and try again.
        </div>
      </WorkspacePage>
    );
  }

  if (connectedAccounts.length === 0) {
    return (
      <WorkspacePage
        eyebrow="Analytics"
        title="Performance intelligence"
        description="Account-scoped performance analytics."
      >
        <EmptyState
          title="No connected accounts"
          description="Connect and sync an MT4 or MT5 account before opening analytics."
        />
      </WorkspacePage>
    );
  }

  const performanceRows = [
    [
      "Profit factor",
      (analyticsSummary?.profitFactor ?? 0).toFixed(2),
      "Gross profit / gross loss",
    ],
    [
      "Win rate",
      formatPercent(analyticsSummary?.winRatePercent ?? 0),
      "Closed trades only",
    ],
    [
      "Consistency",
      formatPercent(analyticsSummary?.consistencyScore ?? 0),
      "Profitable trading days",
    ],
    [
      "Average win",
      formatMoney(
        analyticsSummary?.averageWin ?? {
          amount: 0,
          currency: selectedCurrency,
        },
      ),
      "Mean profitable trade",
    ],
    [
      "Average loss",
      formatMoney(
        analyticsSummary?.averageLoss ?? {
          amount: 0,
          currency: selectedCurrency,
        },
      ),
      "Mean losing trade",
    ],
  ];

  return (
    <WorkspacePage
      eyebrow="Analytics"
      title="Performance intelligence"
      description="Profitability, drawdown, consistency, account growth, and risk-adjusted trade quality."
    >
      <div className="grid gap-4 rounded-[4px] border border-line bg-panel p-4 lg:grid-cols-[minmax(220px,0.35fr)_1fr] lg:items-end">
        <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
          Account scope
          <select
            value={accountScope ?? ""}
            onChange={(event) => {
              if (event.target.value === "ALL") {
                setAllScopeSelection({ selectedAccountId });
              } else {
                setAllScopeSelection(null);
                setSelectedAccountId(event.target.value || null);
              }
            }}
            className="min-h-11 rounded-[4px] border border-line bg-background px-3 text-sm font-semibold normal-case tracking-normal text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            <option value="ALL">All Accounts</option>
            {connectedAccounts.map((account) => (
              <option key={account.accountId} value={account.accountId}>
                {account.accountName} · {account.brokerName}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2 rounded-[4px] border border-line bg-background p-2">
          {periods.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setPeriod(item)}
              className={`rounded-[4px] px-4 py-2 text-xs font-semibold transition ${
                period === item
                  ? "bg-accent text-background"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {item.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      {analyticsError ? (
        <div className="mt-5 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
          Analytics for this account scope could not be loaded. The selection
          may be unavailable or outside your access.
        </div>
      ) : null}

      {analyticsLoading ? (
        <div className="mt-5 rounded-[4px] border border-line bg-panel px-4 py-3 text-sm text-muted">
          Recalculating metrics for this scope…
        </div>
      ) : null}

      <div className="mt-5">
        <InlineStatusStrip
          items={[
            {
              label: "Total profit",
              value: analyticsSummary
                ? formatMoney(analyticsSummary.totalProfit)
                : "—",
              tone: "lime",
            },
            {
              label: "Win rate",
              value: analyticsSummary
                ? formatPercent(analyticsSummary.winRatePercent)
                : "—",
            },
            {
              label: "Max drawdown",
              value: analyticsSummary ? formatPercent(maxDrawdownPercent) : "—",
              tone: "accent",
            },
            {
              label: "Risk reward",
              value: analyticsSummary?.riskRewardRatio ?? "—",
            },
            {
              label: "Consistency",
              value: analyticsSummary
                ? formatPercent(analyticsSummary.consistencyScore)
                : "—",
            },
          ]}
        />
      </div>

      <AccountPerformanceChart
        className="mt-5"
        accountId={accountScope}
        accountName={
          accountScope === "ALL"
            ? "all connected accounts"
            : (selectedAccount?.accountName ?? "the selected account")
        }
        currency={selectedCurrency}
        eyebrow="Equity history"
        title="Account growth"
        range={rangeForAnalyticsPeriod(period)}
        showRangeSelector={false}
        liveEquity={selectedAccount ? selectedAccount.equity.amount : null}
        currentDrawdownPercent={selectedAccount ? selectedAccount.drawdownPercent : null}
      />

      <div className="mt-5">
        <Panel className="h-full min-w-0 w-full">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                Performance metrics
              </h2>
              <p className="mt-1 text-sm text-muted">
                A compact view of the account&apos;s trading quality
              </p>
            </div>
            <StatusPill tone="accent">Live data</StatusPill>
          </div>
          <div className="mt-4">
            <DataTable
              headers={["Metric", "Value", "Notes"]}
              rows={performanceRows.map(([metric, value, notes]) => [
                <span key={metric} className="font-semibold text-foreground">
                  {metric}
                </span>,
                value,
                notes,
              ])}
            />
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-[0.58fr_0.42fr]">
        <DrawdownMeter value={maxDrawdownPercent} />
        <Panel className="h-full">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                Risk-to-reward overview
              </h2>
              <p className="mt-1 text-sm text-muted">
                Closed-trade behavior across the ledger
              </p>
            </div>
            <TrendingDown className="h-5 w-5 text-danger" />
          </div>
          <div className="mt-5 overflow-hidden rounded-[4px] border border-line bg-background">
            {[
              [
                "Winning trades",
                String(analyticsSummary?.winningTradeCount ?? 0),
                "Positive profit",
              ],
              [
                "Losing trades",
                String(analyticsSummary?.losingTradeCount ?? 0),
                "Negative profit",
              ],
              [
                "Closed trades",
                String(analyticsSummary?.tradeCount ?? 0),
                "Selected scope and period",
              ],
            ].map(([label, value, note]) => (
              <div
                key={label}
                className="border-b border-line p-4 last:border-b-0"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-muted">
                    {label}
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    {value}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted">{note}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
