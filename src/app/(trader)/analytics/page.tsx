"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingDown, TrendingUp } from "lucide-react";
import {
  DataTable,
  EmptyState,
  InlineStatusStrip,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { EquityCurve } from "@/components/dashboard/EquityCurve";
import { formatMoney, formatPercent } from "@/lib/utils/format";
import type { AnalyticsSummary, EquityPoint, TraderAccountSummary } from "@/lib/domain/types";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";

const periods = ["DAILY", "WEEKLY", "MONTHLY", "ALL_TIME"] as const;

function DrawdownMeter({ value }: { value: number }) {
  const capped = Math.min(value, 12);
  return (
    <div className="rounded-[4px] border border-line bg-panel p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Drawdown meter</h3>
          <p className="mt-1 text-xs text-muted">Current drawdown pressure across the live snapshot</p>
        </div>
        <StatusPill tone={value >= 6 ? "danger" : value >= 4 ? "accent" : "lime"}>
          {formatPercent(value)}
        </StatusPill>
      </div>
      <div className="mt-5 h-4 overflow-hidden rounded-full border border-line bg-background">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${(capped / 12) * 100}%` }}
        />
      </div>
      <div className="mt-4 flex items-center justify-between text-xs text-muted">
        <span>0%</span>
        <span>6%</span>
        <span>12%</span>
      </div>
    </div>
  );
}

function GrowthGraph({ points }: { points: EquityPoint[] }) {
  const width = 800;
  const height = 220;
  const padding = 18;
  const values = points.map((point) => point.equity);
  const min = Math.min(...values) - 250;
  const max = Math.max(...values) + 250;
  const range = max - min || 1;
  const coordinates = points.map((point, index) => {
    const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((point.equity - min) / range) * (height - padding * 2);
    return { x, y };
  });
  const line = coordinates.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <div className="rounded-[4px] border border-line bg-panel p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Historical growth</h3>
          <p className="mt-1 text-xs text-muted">Equity growth across the current history</p>
        </div>
        <StatusPill tone="accent">Updated live</StatusPill>
      </div>
      {points.length > 0 ? (
        <svg viewBox={`0 0 ${width} ${height}`} className="mt-4 h-[220px] w-full" role="img" aria-label="Historical growth graph">
          <defs>
            <linearGradient id="analyticsGrowthGradient" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#ffcf00" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#ffcf00" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((ratio) => (
            <line
              key={ratio}
              x1={padding}
              x2={width - padding}
              y1={height * ratio}
              y2={height * ratio}
              stroke="#1d1c17"
              strokeDasharray="5 8"
            />
          ))}
          <polygon points={`${padding},${height - padding} ${line} ${width - padding},${height - padding}`} fill="url(#analyticsGrowthGradient)" />
          <polyline points={line} fill="none" stroke="#ffcf00" strokeWidth="4" />
        </svg>
      ) : (
        <div className="mt-4 h-[220px] flex items-center justify-center text-sm text-muted">No data available</div>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage eyebrow="Performance lab" title="Analytics" description="Loading your platform access status.">
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
  const [accountScope, setAccountScope] = useState("ALL");

  const {
    data: accounts = [],
    isLoading: accountsLoading,
    isError: accountsError,
  } = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/trading-accounts");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load accounts");
      return json.data;
    },
  });

  const connectedAccounts = accounts.filter((account) => account.status === "CONNECTED");

  const {
    data: analyticsSummary,
    isLoading: analyticsLoading,
    isError: analyticsError,
  } = useQuery<AnalyticsSummary>({
    queryKey: ["analytics-summary", accountScope, period],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/summary?accountId=${accountScope}&period=${period}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load analytics");
      return json.data;
    },
    enabled: !accountsLoading && connectedAccounts.length > 0,
  });

  const {
    data: equityCurve = [],
    isLoading: curveLoading,
    isError: curveError,
  } = useQuery<EquityPoint[]>({
    queryKey: ["equity-curve", accountScope, period],
    queryFn: async () => {
      const res = await fetch(
        `/api/analytics/equity-curve?accountId=${accountScope}&period=${period}`,
      );
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load equity curve");
      return json.data;
    },
    enabled: !accountsLoading && connectedAccounts.length > 0,
  });

  if (accountsLoading) {
    return (
      <WorkspacePage eyebrow="Analytics" title="Performance intelligence" description="Loading connected accounts.">
        <Panel><p className="text-sm text-muted">Loading accounts…</p></Panel>
      </WorkspacePage>
    );
  }

  if (accountsError) {
    return (
      <WorkspacePage eyebrow="Analytics" title="Performance intelligence" description="Account-scoped performance analytics.">
        <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
          Connected accounts could not be loaded. Refresh and try again.
        </div>
      </WorkspacePage>
    );
  }

  if (connectedAccounts.length === 0) {
    return (
      <WorkspacePage eyebrow="Analytics" title="Performance intelligence" description="Account-scoped performance analytics.">
        <EmptyState
          title="No connected accounts"
          description="Connect and sync an MT4 or MT5 account before opening analytics."
        />
      </WorkspacePage>
    );
  }

  const kpi = {
    netProfit: analyticsSummary?.totalProfit.amount ?? 0,
    winRate: analyticsSummary?.winRatePercent ?? 0,
    riskUtilization: Math.min(((analyticsSummary?.maxDrawdownPercent ?? 0) / 8) * 100, 100),
    avgR: analyticsSummary?.riskRewardRatio ?? 0,
    status: analyticsSummary?.totalProfit.amount && analyticsSummary.totalProfit.amount > 0
      ? "Positive"
      : "Review",
    note: "Metrics are calculated from the selected account scope and period.",
  };

  const performanceRows = [
    ["Profit factor", (analyticsSummary?.profitFactor ?? 0).toFixed(2), "Gross profit / gross loss"],
    ["Win rate", formatPercent(analyticsSummary?.winRatePercent ?? 0), "Closed trades only"],
    ["Consistency", formatPercent(analyticsSummary?.consistencyScore ?? 0), "Profitable trading days"],
    ["Average win", formatMoney(analyticsSummary?.averageWin ?? { amount: 0, currency: "USD" }), "Mean profitable trade"],
    ["Average loss", formatMoney(analyticsSummary?.averageLoss ?? { amount: 0, currency: "USD" }), "Mean losing trade"],
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
            value={accountScope}
            onChange={(event) => setAccountScope(event.target.value)}
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
                period === item ? "bg-accent text-background" : "text-muted hover:text-foreground"
              }`}
            >
              {item.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      {analyticsError || curveError ? (
        <div className="mt-5 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
          Analytics for this account scope could not be loaded. The selection may be unavailable or outside your access.
        </div>
      ) : null}

      {analyticsLoading || curveLoading ? (
        <div className="mt-5 rounded-[4px] border border-line bg-panel px-4 py-3 text-sm text-muted">
          Recalculating metrics for this scope…
        </div>
      ) : null}

      <div className="mt-5">
        <InlineStatusStrip
          items={[
            {
              label: "Total profit",
              value: analyticsSummary ? formatMoney(analyticsSummary.totalProfit) : "—",
              tone: "lime",
            },
            {
              label: "Win rate",
              value: analyticsSummary ? formatPercent(analyticsSummary.winRatePercent) : "—",
            },
            {
              label: "Max drawdown",
              value: analyticsSummary ? formatPercent(analyticsSummary.maxDrawdownPercent) : "—",
              tone: "accent",
            },
            {
              label: "Risk reward",
              value: analyticsSummary?.riskRewardRatio ?? "—",
            },
            {
              label: "Consistency",
              value: analyticsSummary ? formatPercent(analyticsSummary.consistencyScore) : "—",
            },
          ]}
        />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[0.64fr_0.36fr]">
        <EquityCurve data={equityCurve} />
        <DrawdownMeter value={analyticsSummary?.maxDrawdownPercent ?? 0} />
      </div>

      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-2">
        <Panel className="h-full min-w-0 w-full">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Performance metrics</h2>
              <p className="mt-1 text-sm text-muted">A compact view of the account&apos;s trading quality</p>
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

        <Panel className="flex h-full min-w-0 w-full flex-col">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">KPI dashboard</h2>
              <p className="mt-1 text-sm text-muted">Selected period: {period.replace("_", " ")}</p>
            </div>
          </div>
          <div className="mt-5 rounded-[4px] border border-line bg-background p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted">Primary KPI</p>
                <p className="mt-3 text-5xl font-semibold text-accent-2">{formatMoney({ amount: kpi.netProfit, currency: "USD" })}</p>
                <p className="mt-2 max-w-md text-sm text-muted">Net profit for the selected period</p>
              </div>
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-foreground">
                Performance focused
              </span>
            </div>
          </div>

          <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-2">
            <div className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Win rate</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{formatPercent(kpi.winRate)}</p>
            </div>
            <div className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Risk utilization</p>
              <p className="mt-2 text-lg font-semibold text-accent">{formatPercent(kpi.riskUtilization)}</p>
            </div>
            <div className="p-4 sm:col-span-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Average R</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{kpi.avgR.toFixed(2)}R</p>
            </div>
          </div>
          <div className="mt-4">
            <div className="flex items-center gap-3 rounded-[4px] border border-line bg-[#050602] p-4">
              <TrendingUp className="h-5 w-5 text-accent-2" />
              <div>
                <p className="text-sm font-semibold text-foreground">{kpi.status} trend</p>
                <p className="mt-1 text-xs text-muted">{kpi.note}</p>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-[0.58fr_0.42fr]">
        <GrowthGraph points={equityCurve} />
        <Panel className="h-full">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Risk-to-reward overview</h2>
              <p className="mt-1 text-sm text-muted">Closed-trade behavior across the ledger</p>
            </div>
            <TrendingDown className="h-5 w-5 text-danger" />
          </div>
          <div className="mt-5 overflow-hidden rounded-[4px] border border-line bg-background">
            {[
              ["Winning trades", String(analyticsSummary?.winningTradeCount ?? 0), "Positive profit"],
              ["Losing trades", String(analyticsSummary?.losingTradeCount ?? 0), "Negative profit"],
              ["Closed trades", String(analyticsSummary?.tradeCount ?? 0), "Selected scope and period"],
            ].map(([label, value, note]) => (
              <div key={label} className="border-b border-line p-4 last:border-b-0">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-muted">{label}</span>
                  <span className="text-sm font-semibold text-foreground">{value}</span>
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
