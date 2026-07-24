"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { BillingCheckoutModal } from "@/components/app/BillingCheckoutModal";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import type { UserBillingSummaryDto } from "@/lib/services/billingService";
import { DashboardModeOverlay } from "@/components/dashboard/DashboardModeOverlay";
import { DashboardKpiStrip, MarketSentimentStrip } from "@/components/dashboard/DashboardKpiStrip";
import { PerformanceRings, type PerformanceRingItem } from "@/components/dashboard/PerformanceRings";
import { Panel, PageActionGroup, WorkspacePage } from "@/components/app/WorkspaceUI";
import { formatMoney, formatPercent } from "@/lib/utils/format";
import {
  calculateAverageWinLossRatio,
  calculateConsistencyScore,
  calculateProfitFactor,
} from "@/lib/domain/metrics";
import {
  computePeriodStats,
  filterClosedTradesForPeriod,
  type DashboardView,
  type Period,
  type PeriodStats,
} from "@/lib/domain/dashboard";
import type { TraderAccountSummary, TradeDto, RiskRuleDto } from "@/lib/domain/types";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";
import { getAccountDisplayIdentity } from "@/lib/domain/accountIdentity";

type SessionUser = { id: string; name: string; email: string };

const TradingChart = dynamic(
  () => import("@/components/charts/TradingChart").then((mod) => mod.TradingChart),
  {
    ssr: false,
    loading: () => (
      <section className="section-surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <div className="h-6 w-44 animate-pulse rounded-full bg-panel-strong" />
            <div className="mt-3 h-4 w-32 animate-pulse rounded-full bg-panel-strong" />
          </div>
          <div className="h-6 w-20 animate-pulse rounded-full bg-panel-strong" />
        </div>
        <div className="px-5 py-5">
          <div className="inner-surface h-[560px] animate-pulse" />
        </div>
      </section>
    ),
  },
);

const dashboardTabs: Array<{ id: DashboardView; label: string }> = [
  { id: "CURRENT_EQUITY", label: "Current Equity" },
  { id: "CHECK_LIMITS", label: "Check Limits" },
  { id: "PROFIT_SUMMARY", label: "Profit Summary" },
  { id: "CALENDAR_TRACKER", label: "Calendar Tracker" },
];

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
  const [accountIndex, setAccountIndex] = useState(0);

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
    staleTime: 0,
  });

  const subStatus = billingSummary?.platformSubscription?.status;
  const subEnd = billingSummary?.platformSubscription?.currentPeriodEnd;
  const showSubBanner =
    billingSummary !== undefined &&
    subStatus !== "ACTIVE" &&
    subStatus !== "PENDING_APPROVAL";

  // Fetch trading accounts
  const { data: accounts = [], isLoading } = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/trading-accounts");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load accounts");
      return json.data;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const baseAccount = accounts[Math.min(accountIndex, Math.max(accounts.length - 1, 0))] ?? accounts[0];

  // Keep the selected account's ledger current. Supabase Realtime invalidates
  // this query immediately; polling is the fallback if a realtime socket drops.
  const { data: trades = [] } = useQuery<TradeDto[]>({
    queryKey: ["trades", baseAccount?.accountId],
    queryFn: async () => {
      const params = new URLSearchParams({ accountId: baseAccount!.accountId });
      const res = await fetch(`/api/trades?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load trades");
      return json.data;
    },
    enabled: Boolean(baseAccount?.accountId),
    staleTime: 0,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });

  // Fetch risk rules
  const { data: riskRules = [] } = useQuery<RiskRuleDto[]>({
    queryKey: ["risk-rules"],
    queryFn: async () => {
      const res = await fetch("/api/risk/rules");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load risk rules");
      return json.data;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // Subscribe to realtime updates
  useRealtimeUpdates();

  useEffect(() => {
    const timer = window.setInterval(() => setStatsNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const live = useMemo(
    () => ({
      balance: baseAccount?.balance.amount ?? 0,
      equity: baseAccount?.equity.amount ?? 0,
      pnl: baseAccount?.floatingPnl.amount ?? 0,
      refresh: statsNow,
    }),
    [baseAccount, statsNow],
  );

  const openTrades = useMemo(() => trades.filter((trade) => trade.status === "OPEN"), [trades]);
  const periodTrades = useMemo(
    () => filterClosedTradesForPeriod(trades, selectedPeriod, statsNow),
    [trades, selectedPeriod, statsNow],
  );
  const periodStats = useMemo<PeriodStats>(
    () => computePeriodStats(trades, selectedPeriod, statsNow),
    [trades, selectedPeriod, statsNow],
  );
  const dailyLossLimit = riskRules.find((rule) => rule.metric === "DAILY_LOSS")?.threshold ?? 2500;
  const maxDrawdownLimit = riskRules.find((rule) => rule.metric === "MAX_DRAWDOWN")?.threshold ?? 5;
  const openTradeLimit = riskRules.find((rule) => rule.metric === "OPEN_TRADES")?.threshold ?? 5;

  const periodProfitFactor = useMemo(() => calculateProfitFactor(periodTrades), [periodTrades]);
  const periodAvgWinLoss = useMemo(() => calculateAverageWinLossRatio(periodTrades), [periodTrades]);
  const periodConsistency = useMemo(() => calculateConsistencyScore(periodTrades), [periodTrades]);
  const hasClosedTrades = periodTrades.length > 0;
  const pnlPositive = live.pnl >= 0;
  const pnlPrefix = pnlPositive ? "↑" : "↓";
  const accountDrawdown = baseAccount?.drawdownPercent ?? 0;
  const accountIdentity = getAccountDisplayIdentity(baseAccount);
  const currentHour = new Date().getHours();
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
      value: formatMoney({ amount: live.balance, currency: "USD" }),
      helper: "Current account balance",
      tone: "accent" as const,
      status: "Good",
      statusTone: "lime" as const,
      sparkline: [],
    },
    {
      label: "Equity",
      value: formatMoney({ amount: live.equity, currency: "USD" }),
      helper: "Net equity including open trades",
      tone: "lime" as const,
      status: "Excellent",
      statusTone: "lime" as const,
      sparkline: [],
    },
    {
      label: "Floating PnL",
      value: `${pnlPrefix} ${formatMoney({ amount: Math.abs(live.pnl), currency: "USD" })}`,
      helper: pnlPositive ? "Unrealised gain on open positions" : "Unrealised loss on open positions",
      tone: pnlPositive ? ("lime" as const) : ("danger" as const),
      status: pnlPositive ? "Good" : "Average",
      statusTone: pnlPositive ? ("lime" as const) : ("muted" as const),
      sparkline: [],
    },
  ];

  const marketSentimentItems = [
    {
      label: "Session",
      value: currentHour < 7 ? "Asia late" : currentHour < 13 ? "London" : currentHour < 19 ? "New York" : "Overnight",
      helper: "Current market window",
      tone: "accent" as const,
    },
    {
      label: "Trend Bias",
      value: periodStats.winRate >= 58 && periodProfitFactor >= 1.4 ? "Bullish" : "Balanced",
      helper: "Derived from your win rate and profit factor",
      tone: "lime" as const,
    },
    {
      label: "Volatility",
      value: accountDrawdown >= 4.5 ? "Elevated" : accountDrawdown >= 3 ? "Moderate" : "Low",
      helper: "Based on your account drawdown",
      tone: accountDrawdown >= 4.5 ? ("danger" as const) : ("lime" as const),
    },
    {
      label: "Performance Score",
      value: `${Math.min(99, Math.round((periodStats.winRate * 0.8 + periodProfitFactor * 10) / 1.1))}`,
      helper: "Composite score from your period results",
      tone: "accent" as const,
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
          {accounts.length > 1 ? (
            <select
              value={accountIndex}
              onChange={(e) => setAccountIndex(Number(e.target.value))}
              className="h-9 rounded-[4px] border border-line bg-background px-3 text-xs font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              {accounts.map((a, i) => (
                <option key={a.accountId} value={i}>
                  {a.accountName}
                </option>
              ))}
            </select>
          ) : null}
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
      {!isLoading && accounts.length === 0 ? (
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
            href="/accounts"
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
                    {period === "DAILY" ? "Today" : period === "WEEKLY" ? "7 days" : "30 days"}
                  </button>
                ))}
              </div>
            </div>
            <PerformanceRings items={performanceRings} />
          </Panel>
          <div className="mt-4">
            <TradingChart accountId={baseAccount?.accountId} />
          </div>
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
            trades={trades}
            summary={overlayPeriodStats}
            dailyLossLimit={dailyLossLimit}
            maxDrawdownLimit={maxDrawdownLimit}
            openTradeLimit={openTradeLimit}
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
