"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BillingCheckoutModal } from "@/components/app/BillingCheckoutModal";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import type { UserBillingSummaryDto } from "@/lib/services/billingService";
import { DashboardModeOverlay } from "@/components/dashboard/DashboardModeOverlay";
import { DashboardKpiStrip, MarketSentimentStrip } from "@/components/dashboard/DashboardKpiStrip";
import { PerformanceRings, type PerformanceRingItem } from "@/components/dashboard/PerformanceRings";
import { Panel, PageActionGroup, WorkspacePage } from "@/components/app/WorkspaceUI";
import { toSmoothAreaPath, toSmoothPath } from "@/lib/charts/svgCurve";
import { formatMoney, formatPercent, normalizeMoneyAmount } from "@/lib/utils/format";
import {
  calculateAverageWinLossRatio,
  calculateConsistencyScore,
  calculateProfitFactor,
} from "@/lib/domain/metrics";
import {
  computePeriodStats,
  filterClosedTradesForPeriod,
  getEffectiveRiskLimit,
  getRiskLimitState,
  type DashboardView,
  type Period,
  type PeriodStats,
} from "@/lib/domain/dashboard";
import type {
  AnalyticsSummary,
  EquityPoint,
  TraderAccountSummary,
  TradeDto,
  RiskRuleDto,
} from "@/lib/domain/types";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";
import { getAccountDisplayIdentity } from "@/lib/domain/accountIdentity";
import { useTradingAccountSelection } from "@/providers/TradingAccountSelectionProvider";

type SessionUser = { id: string; name: string; email: string };

const dashboardTabs: Array<{ id: DashboardView; label: string }> = [
  { id: "CURRENT_EQUITY", label: "Current Equity" },
  { id: "CHECK_LIMITS", label: "Check Limits" },
  { id: "PROFIT_SUMMARY", label: "Profit Summary" },
  { id: "CALENDAR_TRACKER", label: "Calendar Tracker" },
];

type ChartMetricPoint = {
  x: number;
  y: number;
};

function normalizeSeriesPoints(values: number[], width: number, height: number, padding: number): ChartMetricPoint[] {
  if (values.length === 0) return [];
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || Math.max(Math.abs(maxValue), 1);
  return values.map((value, index) => {
    const x = padding + (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((value - minValue) / range) * (height - padding * 2);
    return { x, y };
  });
}

function normalizePercentSeriesPoints(
  values: number[],
  width: number,
  height: number,
  paddingX: number,
  paddingY: number,
  domain: { min: number; max: number },
): ChartMetricPoint[] {
  if (values.length === 0) return [];
  const range = domain.max - domain.min || 1;
  return values.map((value, index) => {
    const x = paddingX + (index / Math.max(values.length - 1, 1)) * (width - paddingX * 2);
    const y = height - paddingY - ((value - domain.min) / range) * (height - paddingY * 2);
    return { x, y };
  });
}

function buildPercentDomain(...series: number[][]): { min: number; max: number } {
  const values = series.flat().filter(Number.isFinite);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const rawRange = rawMax - rawMin;
  if (rawRange < 1) return { min: -0.5, max: 0.5 };
  const padding = Math.max(rawRange * 0.12, 0.15);
  return { min: rawMin - padding, max: rawMax + padding };
}

function formatGrowthPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0.00%";
  if (Math.abs(value) < 0.01) return value > 0 ? "<0.01%" : ">-0.01%";
  if (Math.abs(value) < 1) return `${value.toFixed(2)}%`;
  return formatPercent(value);
}

function formatAxisPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.01) return "0%";
  if (Math.abs(value) < 1) return `${value.toFixed(2)}%`;
  return `${value.toFixed(1)}%`;
}

function formatCompactMoneyAmount(amount: number, currency: string): string {
  const normalized = normalizeMoneyAmount(amount);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: Math.abs(normalized) >= 1000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(normalized) >= 1000 ? 1 : 2,
  }).format(normalized).replace(".0", "");
}

function formatShortDate(value: string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

function buildDashboardPnlSeries(trades: TradeDto[], fallbackValue: number): number[] {
  const closed = [...trades]
    .filter((trade) => trade.status === "CLOSED")
    .sort((a, b) => {
      const aTime = new Date(a.closedAt ?? a.openedAt).getTime();
      const bTime = new Date(b.closedAt ?? b.openedAt).getTime();
      return aTime - bTime;
    })
    .slice(-24);

  if (closed.length === 0) return [0, fallbackValue];

  let running = 0;
  return [0, ...closed.map((trade) => {
    running += normalizeMoneyAmount(trade.profit.amount);
    return running;
  })];
}

function chartDateLabels(equityCurve: EquityPoint[], trades: TradeDto[]): { start: string; end: string } {
  const dates = [
    ...equityCurve.map((point) => point.capturedAt),
    ...trades.map((trade) => trade.closedAt ?? trade.openedAt),
  ]
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (dates.length === 0) return { start: "", end: "" };
  return {
    start: formatShortDate(new Date(dates[0]).toISOString()),
    end: formatShortDate(new Date(dates[dates.length - 1]).toISOString()),
  };
}

function buildDashboardVolumeSeries(trades: TradeDto[]): number[] {
  const recent = [...trades]
    .sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime())
    .slice(-18);
  return recent.map((trade) => Math.max(0, Number(trade.volume) || 0));
}

function TraderPerformanceChart({
  equityCurve,
  trades,
  currency,
  periodProfit,
  currentEquity,
  winRate,
  drawdown,
  accountName,
}: {
  equityCurve: EquityPoint[];
  trades: TradeDto[];
  currency: string;
  periodProfit: number;
  currentEquity: number;
  winRate: number;
  drawdown: number;
  accountName: string;
}) {
  const [visibleSeries, setVisibleSeries] = useState({
    equity: true,
    pnl: true,
    volume: true,
  });
  const width = 1120;
  const height = 390;
  const paddingX = 76;
  const paddingY = 42;
  const equityValues = equityCurve.length > 0
    ? equityCurve.map((point) => point.equity)
    : [currentEquity * 0.997, currentEquity];
  const pnlValues = buildDashboardPnlSeries(trades, periodProfit);
  const volumeValues = buildDashboardVolumeSeries(trades);
  const latestEquity = equityCurve.at(-1)?.equity ?? currentEquity;
  const latestPnl = pnlValues.at(-1) ?? periodProfit;
  const startingEquity = equityValues[0] || currentEquity || latestEquity;
  const equityGrowthPercent = startingEquity > 0 ? ((latestEquity - startingEquity) / startingEquity) * 100 : 0;
  const profitBaseEquity = Math.max(latestEquity - latestPnl, startingEquity, 1);
  const profitGrowthPercent = profitBaseEquity > 0 ? (latestPnl / profitBaseEquity) * 100 : 0;
  const growthPercent = Math.abs(equityGrowthPercent) > 0.005 ? equityGrowthPercent : profitGrowthPercent;
  const equityGrowthValues = equityValues.map((value) => (startingEquity > 0 ? ((value - startingEquity) / startingEquity) * 100 : 0));
  const pnlGrowthValues = pnlValues.map((value) => (profitBaseEquity > 0 ? (value / profitBaseEquity) * 100 : 0));
  const percentDomain = buildPercentDomain(equityGrowthValues, pnlGrowthValues);
  const equityPoints = normalizePercentSeriesPoints(equityGrowthValues, width, height, paddingX, paddingY, percentDomain);
  const pnlPoints = normalizePercentSeriesPoints(pnlGrowthValues, width, height, paddingX, paddingY, percentDomain);
  const equityPath = toSmoothPath(equityPoints);
  const equityArea = toSmoothAreaPath(equityPoints, height - paddingY);
  const pnlPath = toSmoothPath(pnlPoints);
  const maxVolume = Math.max(...volumeValues, 1);
  const dateLabels = chartDateLabels(equityCurve, trades);
  const axisTicks = [1, 0.75, 0.5, 0.25, 0];
  const domainValueAt = (ratio: number) => percentDomain.min + (percentDomain.max - percentDomain.min) * ratio;
  const moneyValueAt = (ratio: number) => (domainValueAt(ratio) / 100) * profitBaseEquity;
  const latestEquityGrowth = equityGrowthValues.at(-1) ?? growthPercent;
  const latestPnlGrowth = pnlGrowthValues.at(-1) ?? growthPercent;
  const toggleSeries = (series: keyof typeof visibleSeries) => {
    setVisibleSeries((current) => {
      const next = { ...current, [series]: !current[series] };
      return next.equity || next.pnl || next.volume ? next : current;
    });
  };
  const legendItems = [
    {
      key: "equity" as const,
      label: "Equity curve",
      helper: "Live account balance/equity points",
      tone: "bg-accent-2",
      active: visibleSeries.equity,
    },
    {
      key: "pnl" as const,
      label: "Closed P&L curve",
      helper: "Cumulative closed-trade profit",
      tone: "bg-accent",
      active: visibleSeries.pnl,
    },
    {
      key: "volume" as const,
      label: "Volume bars",
      helper: "Recent traded lot volume",
      tone: "bg-accent/50",
      active: visibleSeries.volume,
    },
  ];

  return (
    <Panel className="mt-4 overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Performance analytics</p>
          <h2 className="mt-2 text-lg font-semibold text-foreground">Account performance curve</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            MT5-synced equity growth, closed P&L, and traded volume from {accountName}, shown with percentage and money scales.
          </p>
        </div>
        <div className="grid grid-cols-2 overflow-hidden rounded-[4px] border border-line bg-background text-right sm:grid-cols-4">
          {[
            ["Equity", formatMoney({ amount: latestEquity, currency }), "text-accent"],
            ["Closed P&L", formatMoney({ amount: latestPnl, currency }), latestPnl >= 0 ? "text-accent-2" : "text-danger"],
            ["% Growth", formatGrowthPercent(growthPercent), growthPercent >= 0 ? "text-accent-2" : "text-danger"],
            ["Win rate", formatPercent(winRate), "text-foreground"],
          ].map(([label, value, tone]) => (
            <div key={label} className="min-w-28 border-r border-line px-4 py-3 last:border-r-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{label}</p>
              <p className={`mt-1 text-sm font-semibold tabular-nums ${tone}`}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="px-4 pb-5 pt-4 sm:px-5">
        <div className="relative overflow-hidden rounded-[4px] border border-line bg-background">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_20%,rgba(255,207,0,0.12),transparent_34%),radial-gradient(circle_at_75%_70%,rgba(33,209,159,0.12),transparent_30%)]" />
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="relative h-[390px] w-full"
            role="img"
            aria-label="Trader dashboard performance chart"
          >
            <defs>
              <linearGradient id="dashboardEquityFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#21d19f" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#21d19f" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="dashboardPnlStroke" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="#ffcf00" />
                <stop offset="100%" stopColor="#ffef8a" />
              </linearGradient>
            </defs>
            <line x1={paddingX} x2={paddingX} y1={paddingY} y2={height - paddingY} stroke="rgba(255,255,255,0.12)" />
            <line x1={width - paddingX} x2={width - paddingX} y1={paddingY} y2={height - paddingY} stroke="rgba(255,255,255,0.12)" />
            <line x1={paddingX} x2={width - paddingX} y1={height - paddingY} y2={height - paddingY} stroke="rgba(255,255,255,0.12)" />
            {axisTicks.map((ratio) => {
              const y = height - paddingY - ratio * (height - paddingY * 2);
              return (
                <g key={ratio}>
                  <line
                    x1={paddingX}
                    x2={width - paddingX}
                    y1={y}
                    y2={y}
                    stroke="rgba(255,255,255,0.08)"
                    strokeDasharray="7 10"
                  />
                  <text x={paddingX - 12} y={y + 4} textAnchor="end" className="fill-muted text-[10px] font-semibold tabular-nums">
                    {formatAxisPercent(domainValueAt(ratio))}
                  </text>
                  <text x={width - paddingX + 12} y={y + 4} textAnchor="start" className="fill-muted text-[10px] font-semibold tabular-nums">
                    {formatCompactMoneyAmount(moneyValueAt(ratio), currency)}
                  </text>
                </g>
              );
            })}
            <text x={paddingX} y={24} textAnchor="start" className="fill-accent-2 text-[10px] font-bold uppercase tracking-[0.16em]">
              Growth %
            </text>
            <text x={width - paddingX} y={24} textAnchor="end" className="fill-accent text-[10px] font-bold uppercase tracking-[0.16em]">
              Closed P&L
            </text>
            {visibleSeries.volume ? volumeValues.map((volume, index) => {
              const barWidth = Math.max(8, (width - paddingX * 2) / Math.max(volumeValues.length, 1) - 10);
              const x = paddingX + (index / Math.max(volumeValues.length - 1, 1)) * (width - paddingX * 2) - barWidth / 2;
              const barHeight = Math.max(8, (volume / maxVolume) * 84);
              return (
                <rect
                  key={`${volume}-${index}`}
                  x={x}
                  y={height - paddingY - barHeight}
                  width={barWidth}
                  height={barHeight}
                  rx="4"
                  fill="rgba(255,207,0,0.18)"
                />
              );
            }) : null}
            {visibleSeries.equity ? <path d={equityArea} fill="url(#dashboardEquityFill)" /> : null}
            {visibleSeries.equity ? (
              <path
                d={equityPath}
                fill="none"
                stroke="#21d19f"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {visibleSeries.pnl ? (
              <path
                d={pnlPath}
                fill="none"
                stroke="url(#dashboardPnlStroke)"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="9 9"
              />
            ) : null}
            {visibleSeries.equity && equityPoints.at(-1) ? (
              <circle
                cx={equityPoints.at(-1)!.x}
                cy={equityPoints.at(-1)!.y}
                r="6"
                fill="#050505"
                stroke="#21d19f"
                strokeWidth="3"
              />
            ) : null}
            {visibleSeries.pnl && pnlPoints.at(-1) ? (
              <g>
                <circle cx={pnlPoints.at(-1)!.x} cy={pnlPoints.at(-1)!.y} r="4" fill="#ffcf00" />
                <text x={Math.min(pnlPoints.at(-1)!.x + 12, width - paddingX - 90)} y={pnlPoints.at(-1)!.y - 10} className="fill-accent text-[11px] font-bold tabular-nums">
                  {formatMoney({ amount: latestPnl, currency })} / {formatGrowthPercent(latestPnlGrowth)}
                </text>
              </g>
            ) : null}
            {visibleSeries.equity && equityPoints.at(-1) ? (
              <text x={Math.min(equityPoints.at(-1)!.x + 12, width - paddingX - 86)} y={equityPoints.at(-1)!.y + 20} className="fill-accent-2 text-[11px] font-bold tabular-nums">
                {formatGrowthPercent(latestEquityGrowth)}
              </text>
            ) : null}
            {dateLabels.start ? (
              <text x={paddingX} y={height - 14} textAnchor="start" className="fill-muted text-[10px] font-semibold tabular-nums">
                {dateLabels.start}
              </text>
            ) : null}
            {dateLabels.end ? (
              <text x={width - paddingX} y={height - 14} textAnchor="end" className="fill-muted text-[10px] font-semibold tabular-nums">
                {dateLabels.end}
              </text>
            ) : null}
          </svg>
        </div>
        <div className="mt-4 grid gap-3 text-xs text-muted sm:grid-cols-4">
          {legendItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => toggleSeries(item.key)}
              className={`rounded-[4px] border px-3 py-3 text-left transition ${
                item.active
                  ? "border-line bg-panel text-muted"
                  : "border-line/60 bg-background text-muted/60 opacity-70"
              }`}
              aria-pressed={item.active}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${item.active ? item.tone : "bg-muted/40"}`} />
                  <span className="font-semibold text-foreground">{item.label}</span>
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                  {item.active ? "Shown" : "Hidden"}
                </span>
              </div>
              <p className="mt-1">{item.helper}</p>
            </button>
          ))}
          <div className="rounded-[4px] border border-line bg-panel px-3 py-3">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${drawdown > 0 ? "bg-danger" : "bg-muted"}`} />
              <span className="font-semibold text-foreground">Drawdown</span>
            </div>
            <p className="mt-1">{formatPercent(drawdown)}</p>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function formatSyncTime(value: string | null | undefined): string {
  if (!value) return "Not synced";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not synced";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function TraderDashboardPage() {
  const { data: summary, isLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (isLoading && !summary) {
    return (
      <WorkspacePage
        eyebrow="Workspace"
        title="Trading Dashboard"
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
        eyebrow="Workspace"
        title="Trading Dashboard"
        description="Activate your platform subscription to unlock the live trader dashboard."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock live dashboard metrics, MT5 account tracking, and the full trading workspace."
        />
      </WorkspacePage>
    );
  }

  return <TraderDashboardContent />;
}

function TraderDashboardContent() {
  const [selectedPeriod, setSelectedPeriod] = useState<Period>("MONTHLY");
  const [selectedView, setSelectedView] = useState<DashboardView>("CURRENT_EQUITY");
  const [activeOverlay, setActiveOverlay] = useState<DashboardView | null>(null);
  const [statsNow, setStatsNow] = useState(() => new Date());
  const [subModalOpen, setSubModalOpen] = useState(false);
  const { selectedAccountId, setSelectedAccountId } = useTradingAccountSelection();

  const { data: sessionUser } = useQuery<SessionUser>({
    queryKey: ["session"],
    queryFn: async () => {
      const res = await fetch("/api/auth/session");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load profile");
      return json.data;
    },
  });

  const { data: billingSummary } = useQuery<UserBillingSummaryDto>({
    queryKey: ["billing-me"],
    queryFn: async () => {
      const res = await fetch("/api/billing/me");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load billing");
      return json.data;
    },
    staleTime: 30_000,
  });

  const subStatus = billingSummary?.platformSubscription?.status;
  const subEnd = billingSummary?.platformSubscription?.currentPeriodEnd;
  const showSubBanner =
    billingSummary !== undefined &&
    subStatus !== "ACTIVE" &&
    subStatus !== "PENDING_APPROVAL";

  // Fetch trading accounts
  const { data: accounts = [], isLoading } = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts", "TRADER"],
    queryFn: async () => {
      const res = await fetch("/api/trading-accounts", { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load accounts");
      return json.data;
    },
    staleTime: 1_000,
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  const connectedAccounts = useMemo(
    () => accounts.filter((account) => account.status === "CONNECTED"),
    [accounts],
  );
  const baseAccount =
    connectedAccounts.find((account) => account.accountId === selectedAccountId) ??
    connectedAccounts[0];

  useEffect(() => {
    const effectiveAccountId = baseAccount?.accountId ?? null;
    if (effectiveAccountId !== selectedAccountId) {
      setSelectedAccountId(effectiveAccountId);
    }
  }, [baseAccount?.accountId, selectedAccountId, setSelectedAccountId]);

  // Keep the selected account's ledger current. Supabase Realtime invalidates
  // this query immediately; polling is the fallback if a realtime socket drops.
  const { data: trades = [] } = useQuery<TradeDto[]>({
    queryKey: ["trades", baseAccount?.accountId],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: baseAccount!.accountId,
        limit: "500",
      });
      const res = await fetch(`/api/trades?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load trades");
      return json.data;
    },
    enabled: Boolean(baseAccount?.accountId),
    staleTime: 1_000,
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  const { data: calendarTrades = trades } = useQuery<TradeDto[]>({
    queryKey: ["trades", "calendar", baseAccount?.accountId],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: baseAccount!.accountId,
        status: "CLOSED",
        limit: "10000",
      });
      const res = await fetch(`/api/trades?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load trade calendar");
      return json.data;
    },
    enabled:
      Boolean(baseAccount?.accountId) && activeOverlay === "CALENDAR_TRACKER",
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  // Fetch risk rules
  const { data: riskRules = [] } = useQuery<RiskRuleDto[]>({
    queryKey: ["risk-rules", baseAccount?.accountId],
    queryFn: async () => {
      const params = new URLSearchParams({ accountId: baseAccount!.accountId });
      const res = await fetch(`/api/risk/rules?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load risk rules");
      return json.data;
    },
    enabled: Boolean(baseAccount?.accountId),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });

  const { data: analyticsSummary } = useQuery<AnalyticsSummary>({
    queryKey: ["analytics-summary", baseAccount?.accountId, selectedPeriod],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: baseAccount!.accountId,
        period: selectedPeriod,
      });
      const res = await fetch(`/api/analytics/summary?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load performance summary");
      return json.data;
    },
    enabled: Boolean(baseAccount?.accountId),
    staleTime: 3_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  const { data: dailyAnalyticsSummary } = useQuery<AnalyticsSummary>({
    queryKey: ["analytics-summary", baseAccount?.accountId, "DAILY"],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: baseAccount!.accountId,
        period: "DAILY",
      });
      const res = await fetch(`/api/analytics/summary?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load daily performance");
      return json.data;
    },
    enabled: Boolean(baseAccount?.accountId) && selectedPeriod !== "DAILY",
    staleTime: 3_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  const { data: equityCurve = [] } = useQuery<EquityPoint[]>({
    queryKey: ["dashboard-equity-curve", baseAccount?.accountId, selectedPeriod],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: baseAccount!.accountId,
        period: selectedPeriod,
      });
      const res = await fetch(`/api/analytics/equity-curve?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load equity curve");
      return json.data;
    },
    enabled: Boolean(baseAccount?.accountId),
    staleTime: 3_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  // Subscribe to realtime updates

  useEffect(() => {
    const timer = window.setInterval(() => setStatsNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const live = useMemo(
    () => ({
      balance: baseAccount?.balance.amount ?? 0,
      equity: baseAccount?.equity.amount ?? 0,
      pnl: normalizeMoneyAmount(baseAccount?.floatingPnl.amount ?? 0),
      refresh: baseAccount?.updatedAt
        ? new Date(baseAccount.updatedAt)
        : statsNow,
    }),
    [baseAccount, statsNow],
  );

  const openTrades = useMemo(() => trades.filter((trade) => trade.status === "OPEN"), [trades]);
  const periodTrades = useMemo(
    () => filterClosedTradesForPeriod(trades, selectedPeriod, statsNow),
    [trades, selectedPeriod, statsNow],
  );
  const localPeriodStats = useMemo<PeriodStats>(
    () => computePeriodStats(trades, selectedPeriod, statsNow),
    [trades, selectedPeriod, statsNow],
  );
  const localDailyStats = useMemo(
    () => computePeriodStats(trades, "DAILY", statsNow),
    [trades, statsNow],
  );
  const periodStats = useMemo<PeriodStats>(
    () =>
      analyticsSummary
        ? {
            totalProfit: analyticsSummary.totalProfit.amount,
            winRate: analyticsSummary.winRatePercent,
            tradeCount: analyticsSummary.tradeCount,
            riskReward: analyticsSummary.riskRewardRatio,
          }
        : localPeriodStats,
    [analyticsSummary, localPeriodStats],
  );
  const dailyClosedPnl =
    (selectedPeriod === "DAILY"
      ? analyticsSummary?.totalProfit.amount
      : dailyAnalyticsSummary?.totalProfit.amount) ?? localDailyStats.totalProfit;
  const riskLimits = useMemo(
    () => ({
      dailyLoss: getEffectiveRiskLimit(
        riskRules,
        "DAILY_LOSS",
        baseAccount?.accountId ?? "",
      ),
      maxDrawdown: getEffectiveRiskLimit(
        riskRules,
        "MAX_DRAWDOWN",
        baseAccount?.accountId ?? "",
      ),
      openTrades: getEffectiveRiskLimit(
        riskRules,
        "OPEN_TRADES",
        baseAccount?.accountId ?? "",
      ),
    }),
    [baseAccount?.accountId, riskRules],
  );

  const localProfitFactor = useMemo(() => calculateProfitFactor(periodTrades), [periodTrades]);
  const localAvgWinLoss = useMemo(() => calculateAverageWinLossRatio(periodTrades), [periodTrades]);
  const localConsistency = useMemo(() => calculateConsistencyScore(periodTrades), [periodTrades]);
  const periodProfitFactor = analyticsSummary?.profitFactor ?? localProfitFactor;
  const periodAvgWinLoss = analyticsSummary?.riskRewardRatio ?? localAvgWinLoss;
  const periodConsistency = analyticsSummary?.consistencyScore ?? localConsistency;
  const hasClosedTrades = periodStats.tradeCount > 0;
  const accountCurrency = baseAccount?.balance.currency ?? "USD";
  const pnlPositive = live.pnl >= 0;
  const pnlPrefix = live.pnl > 0 ? "↑" : live.pnl < 0 ? "↓" : "—";
  const floatingPnlValue = live.pnl === 0
    ? formatMoney({ amount: 0, currency: accountCurrency })
    : `${pnlPrefix} ${formatMoney({ amount: Math.abs(live.pnl), currency: accountCurrency })}`;
  const accountDrawdown = baseAccount?.drawdownPercent ?? 0;
  const accountOpenTradeCount = baseAccount?.openTradeCount ?? openTrades.length;
  const riskState = useMemo(
    () =>
      getRiskLimitState({
        dailyClosedPnl,
        drawdownPercent: accountDrawdown,
        openTradeCount: accountOpenTradeCount,
        limits: riskLimits,
      }),
    [
      accountDrawdown,
      accountOpenTradeCount,
      dailyClosedPnl,
      riskLimits,
    ],
  );
  const accountIdentity = getAccountDisplayIdentity(baseAccount);
  const overlayPeriodStats = useMemo(
    () => ({
      ...periodStats,
      drawdown: accountDrawdown,
      consistency: periodConsistency,
    }),
    [accountDrawdown, periodConsistency, periodStats],
  );

  const performanceRings = useMemo<PerformanceRingItem[]>(
    () => [
      {
        label: "Win %",
        value: hasClosedTrades ? formatPercent(periodStats.winRate) : "—",
        status: !hasClosedTrades ? "No closed trades" : periodStats.winRate >= 60 ? "Excellent" : periodStats.winRate >= 50 ? "Good" : "Average",
        statusTone: !hasClosedTrades ? ("muted" as const) : periodStats.winRate >= 60 ? ("lime" as const) : periodStats.winRate >= 50 ? ("accent" as const) : ("muted" as const),
        progress: periodStats.winRate / 100,
        tone: "yellow" as const,
      },
      {
        label: "Profit Factor",
        value: hasClosedTrades ? periodProfitFactor.toFixed(2) : "—",
        status: !hasClosedTrades ? "No closed trades" : periodProfitFactor >= 2 ? "Excellent" : periodProfitFactor >= 1.4 ? "Good" : "Average",
        statusTone: !hasClosedTrades ? ("muted" as const) : periodProfitFactor >= 2 ? ("lime" as const) : periodProfitFactor >= 1.4 ? ("accent" as const) : ("muted" as const),
        progress: Math.min(periodProfitFactor / 4, 1),
        tone: "lime" as const,
      },
      {
        label: "Win/Loss",
        value: hasClosedTrades ? periodAvgWinLoss.toFixed(2) : "—",
        status: !hasClosedTrades ? "No closed trades" : periodAvgWinLoss >= 1.8 ? "Good" : "Average",
        statusTone: !hasClosedTrades ? ("muted" as const) : periodAvgWinLoss >= 1.8 ? ("accent" as const) : ("muted" as const),
        progress: Math.min(periodAvgWinLoss / 4, 1),
        tone: "yellow" as const,
      },
    ],
    [hasClosedTrades, periodAvgWinLoss, periodProfitFactor, periodStats.winRate],
  );

  const kpiItems = [
    {
      label: "Balance",
      value: formatMoney({ amount: live.balance, currency: accountCurrency }),
      helper: "Current account balance",
      tone: "accent" as const,
      status: baseAccount?.status ?? "Unavailable",
      statusTone: "lime" as const,
      sparkline: [],
    },
    {
      label: "Equity",
      value: formatMoney({ amount: live.equity, currency: accountCurrency }),
      helper: "Net equity including open trades",
      tone: "lime" as const,
      status: `Drawdown ${formatPercent(accountDrawdown)}`,
      statusTone: riskState.drawdownBreached ? ("danger" as const) : ("lime" as const),
      sparkline: [],
    },
    {
      label: "Floating PnL",
      value: floatingPnlValue,
      helper:
        live.pnl > 0
          ? "Unrealised gain on open positions"
          : live.pnl < 0
            ? "Unrealised loss on open positions"
            : "No unrealised profit or loss",
      tone: pnlPositive ? ("lime" as const) : ("danger" as const),
      status: live.pnl > 0 ? "Open profit" : live.pnl < 0 ? "Open loss" : "Flat",
      statusTone:
        live.pnl > 0
          ? ("lime" as const)
          : live.pnl < 0
            ? ("danger" as const)
            : ("muted" as const),
      sparkline: [],
    },
  ];

  const marketSentimentItems = [
    {
      label: "Open Trades",
      value: String(accountOpenTradeCount),
      helper: "Live open positions from the selected account",
      tone: accountOpenTradeCount > 0 ? ("accent" as const) : ("muted" as const),
    },
    {
      label: "Closed Trades",
      value: String(periodStats.tradeCount),
      helper: `${selectedPeriod === "DAILY" ? "Today" : selectedPeriod === "WEEKLY" ? "Last 7 days" : "This month"} from the live trade ledger`,
      tone: periodStats.tradeCount > 0 ? ("lime" as const) : ("muted" as const),
    },
    {
      label: "Period P&L",
      value: formatMoney({ amount: periodStats.totalProfit, currency: accountCurrency }),
      helper: "Closed-trade profit for the selected period",
      tone: periodStats.totalProfit > 0
        ? ("lime" as const)
        : periodStats.totalProfit < 0
          ? ("danger" as const)
          : ("muted" as const),
    },
    {
      label: "Last Sync",
      value: formatSyncTime(baseAccount?.lastSyncedAt ?? baseAccount?.updatedAt),
      helper: "Latest live broker update received by the platform",
      tone: baseAccount?.live ? ("lime" as const) : ("muted" as const),
    },
  ];

  return (
    <>
    <WorkspacePage
      eyebrow="Trader workspace"
      title={`Welcome, ${sessionUser?.name?.trim() || "Trader"}`}
      description="Equity, risk, and performance across your connected accounts."
      action={
        <PageActionGroup>
          {dashboardTabs.map((tab) => {
            const active = selectedView === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setSelectedView(tab.id);
                  setActiveOverlay(tab.id);
                }}
                className={`btn-dark h-9 px-4 text-xs ${active ? "btn-active" : ""}`}
              >
                {tab.label}
              </button>
            );
          })}
        </PageActionGroup>
      }
    >
      {/* Platform subscription banner */}
      {showSubBanner && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-accent/30 bg-accent/5 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-foreground">
              {subStatus === "EXPIRED" ? "Subscription expired" : "Activate Platform Subscription"}
            </p>
            <p className="text-xs text-muted">
              {subStatus === "EXPIRED"
                ? `Expired on ${subEnd ? new Date(subEnd).toLocaleDateString() : "—"}. Renew to restore full access.`
                : "$50/month — renews monthly from your subscription start date"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSubModalOpen(true)}
            className="shrink-0 rounded-[4px] bg-accent px-4 py-2 text-xs font-semibold text-background hover:opacity-90"
          >
            {subStatus === "EXPIRED" ? "Renew — $50/month" : "Pay $50 / month"}
          </button>
        </div>
      )}
      {subStatus === "PENDING_APPROVAL" && (
        <div className="mb-5 rounded-[4px] border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-accent">
          Platform subscription payment verified — access activation is finishing automatically.
        </div>
      )}

      {/* Empty state for traders with no connected accounts */}
      {!isLoading && connectedAccounts.length === 0 ? (
        <div className="mt-10 flex flex-col items-center justify-center gap-5 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-panel">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">No trading account connected</h2>
            <p className="mt-2 max-w-sm text-sm text-muted">
              Connect a broker account to start tracking your equity, trades, and performance metrics.
            </p>
          </div>
          <Link
            href="/accounts?connect=1"
            className="rounded-[4px] bg-accent px-6 py-2.5 text-sm font-semibold text-background transition hover:opacity-90"
          >
            Connect account
          </Link>
        </div>
      ) : (
        <>
          <section className="mb-4 overflow-hidden border border-line bg-panel">
            <div className="grid lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,2fr)]">
              <div className="border-b border-line px-4 py-3 lg:border-b-0 lg:border-r">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Connected account</p>
                <h2 className="mt-2 text-lg font-semibold text-foreground">{baseAccount?.accountName ?? "Trading account"}</h2>
              </div>
              <div className="grid sm:grid-cols-3">
                {[
                  ["Broker", accountIdentity.brokerName],
                  ["Server", accountIdentity.serverName],
                  ["Platform", accountIdentity.platform],
                ].map(([label, value]) => (
                  <div key={label} className="border-b border-line px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{label}</p>
                    <p className="mt-1 truncate font-semibold text-foreground">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
          <DashboardKpiStrip items={kpiItems} />
          <div className="mt-4">
            <MarketSentimentStrip items={marketSentimentItems} />
          </div>
          <Panel className="mt-4 overflow-hidden">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">Live performance</p>
                <p className="mt-1 text-xs text-muted">
                  Updates automatically from {baseAccount?.accountName ?? "your selected account"}.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["DAILY", "WEEKLY", "MONTHLY"] as Period[]).map((period) => (
                  <button
                    key={period}
                    type="button"
                    onClick={() => setSelectedPeriod(period)}
                    className={`h-9 rounded-[4px] border px-4 text-xs font-semibold transition ${
                      selectedPeriod === period
                        ? "border-accent bg-accent text-background"
                        : "border-line bg-background text-muted hover:text-foreground"
                    }`}
                  >
                    {period === "DAILY" ? "Today" : period === "WEEKLY" ? "7 days" : "This month"}
                  </button>
                ))}
              </div>
            </div>
            <PerformanceRings items={performanceRings} />
          </Panel>
          <TraderPerformanceChart
            equityCurve={equityCurve}
            trades={periodTrades}
            currency={accountCurrency}
            periodProfit={periodStats.totalProfit}
            currentEquity={live.equity}
            winRate={periodStats.winRate}
            drawdown={accountDrawdown}
            accountName={baseAccount?.accountName ?? "your selected account"}
          />
          <DashboardModeOverlay
            open={activeOverlay !== null}
            view={activeOverlay}
            onOpenChange={(open) => {
              if (!open) setActiveOverlay(null);
            }}
            selectedPeriod={selectedPeriod}
            onPeriodChange={setSelectedPeriod}
            live={live}
            openTrades={openTrades}
            calendarTrades={calendarTrades}
            summary={overlayPeriodStats}
            currency={accountCurrency}
            dailyClosedPnl={dailyClosedPnl}
            dailyLossLimit={riskLimits.dailyLoss}
            maxDrawdownLimit={riskLimits.maxDrawdown}
            openTradeLimit={riskLimits.openTrades}
            openTradeCount={accountOpenTradeCount}
            riskState={riskState}
            profitFactor={periodProfitFactor}
            avgWinLoss={periodAvgWinLoss}
          />
        </>
      )}
    </WorkspacePage>

    <BillingCheckoutModal
      open={subModalOpen}
      onClose={() => setSubModalOpen(false)}
      product={{
        code: "PLATFORM_MONTHLY",
        name: "Platform Subscription",
        amount: 50,
        currency: "USD",
        billingInterval: "MONTHLY",
        description:
          "Full access to all WSA Global platform features. Renews monthly from your subscription start date.",
      }}
    />
    </>
  );
}
