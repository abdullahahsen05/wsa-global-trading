"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BillingCheckoutModal } from "@/components/app/BillingCheckoutModal";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { DashboardSkeleton } from "@/components/dashboard/DashboardSkeleton";
import { DashboardKpiStrip, MarketSentimentStrip } from "@/components/dashboard/DashboardKpiStrip";
import { PerformanceRings, type PerformanceRingItem } from "@/components/dashboard/PerformanceRings";
import { Panel, PageActionGroup, WorkspacePage } from "@/components/app/WorkspaceUI";
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
  TraderAccountSummary,
  TradeDto,
  RiskRuleDto,
} from "@/lib/domain/types";
import { usePlatformGate } from "@/hooks/useTraderAccessSummary";
import { usePerformanceSeries } from "@/hooks/usePerformanceSeries";
import { useSessionUser } from "@/hooks/useSessionUser";
import { useShellHint } from "@/hooks/useShellHint";
import { AccountPerformanceChart } from "@/components/charts/AccountPerformanceChart";
import { normalizeSamples, type PerformanceRange } from "@/lib/charts/performanceSeries";
import { fetchTraderAccounts, TRADER_ACCOUNTS_QUERY_KEY } from "@/lib/data/traderAccountsQuery";
import { getAccountDisplayIdentity } from "@/lib/domain/accountIdentity";
import { readLastAccount, rememberLastAccount } from "@/lib/shell/lastAccount";
import { useTradingAccountSelection } from "@/providers/TradingAccountSelectionProvider";

// The detail overlay (limits, profit summary, the trade calendar with its 42 day cells) is only needed once a tab is
// pressed, so its code is not part of the dashboard's first download. It is fetched in the background a moment after
// the page is up and when a hand reaches for a tab - by the time anyone clicks it is normally already here.
const loadOverlay = () => import("@/components/dashboard/DashboardModeOverlay");
const DashboardModeOverlay = dynamic(
  () => import("@/components/dashboard/DashboardModeOverlay").then((mod) => mod.DashboardModeOverlay),
  { ssr: false },
);

const dashboardTabs: Array<{ id: DashboardView; label: string }> = [
  { id: "CURRENT_EQUITY", label: "Current Equity" },
  { id: "CHECK_LIMITS", label: "Check Limits" },
  { id: "PROFIT_SUMMARY", label: "Profit Summary" },
  { id: "CALENDAR_TRACKER", label: "Calendar Tracker" },
];

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
  const [selectedPeriod, setSelectedPeriod] = useState<Period>("MONTHLY");
  const [selectedView, setSelectedView] = useState<DashboardView>("CURRENT_EQUITY");
  const [activeOverlay, setActiveOverlay] = useState<DashboardView | null>(null);
  const [statsNow, setStatsNow] = useState(() => new Date());
  const [subModalOpen, setSubModalOpen] = useState(false);
  const [chartRange, setChartRange] = useState<PerformanceRange>("ALL");
  const { selectedAccountId, setSelectedAccountId } = useTradingAccountSelection();

  // The platform-access check and every data request below start TOGETHER. They used to wait for each other (access ->
  // accounts -> trades / risk / statistics / chart): four round trips in a row before the first figure. Now the access
  // check only decides what is SHOWN (locked page or dashboard); it is also the one `/api/billing/me` request of the page.
  // For somebody this browser remembers as active the dashboard is drawn from the first paint (`access` is then the
  // remembered guess) and the answer, when it comes, only confirms it - or switches the page to the locked view.
  const { summary: billingSummary, access, checking: accessChecking } = usePlatformGate();
  // (until the answer is in the data is asked for; once it says "not active" the polling stops)
  const dataEnabled = !billingSummary || access.status === "ACTIVE";

  const { data: sessionUser } = useSessionUser();
  const hint = useShellHint();
  const knownUserId = sessionUser?.id ?? hint?.id ?? null;
  // The account this person looked at last in this browser: its requests are sent at once with the account list.
  const rememberedAccountId = useMemo(
    () => (knownUserId ? readLastAccount(knownUserId) : null),
    [knownUserId],
  );

  const subStatus = billingSummary?.platformSubscription?.status;
  const subEnd = billingSummary?.platformSubscription?.currentPeriodEnd;
  const showSubBanner =
    billingSummary !== undefined &&
    subStatus !== "ACTIVE" &&
    subStatus !== "PENDING_APPROVAL";

  // Fetch trading accounts (the same key as the top bar's account picker: one request and one poll for both). Supabase
  // Realtime refreshes it within seconds of a change; the poll is the fallback if the socket drops, and it only runs
  // while the browser tab is on screen.
  const { data: accounts = [], isLoading } = useQuery<TraderAccountSummary[]>({
    queryKey: TRADER_ACCOUNTS_QUERY_KEY,
    queryFn: ({ signal }) => fetchTraderAccounts(signal),
    enabled: dataEnabled,
    staleTime: 2_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
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
  // The account the data below is asked for: the real one once the list is in, the one this person looked at last until
  // then - so trades, rules, statistics and the chart travel at the same time as the list instead of after it. A wrong
  // guess (the account is gone) costs only those requests; the list always wins.
  const dataAccountId = baseAccount?.accountId ?? (isLoading ? rememberedAccountId : null);

  useEffect(() => {
    const effectiveAccountId = baseAccount?.accountId ?? null;
    if (effectiveAccountId !== selectedAccountId) {
      setSelectedAccountId(effectiveAccountId);
    }
  }, [baseAccount?.accountId, selectedAccountId, setSelectedAccountId]);

  useEffect(() => {
    if (sessionUser?.id && baseAccount?.accountId) rememberLastAccount(sessionUser.id, baseAccount.accountId);
  }, [sessionUser?.id, baseAccount?.accountId]);

  // Keep the selected account's ledger current. Supabase Realtime invalidates
  // this query within seconds; polling is the (slow) fallback if a realtime socket drops.
  const { data: trades = [] } = useQuery<TradeDto[]>({
    queryKey: ["trades", dataAccountId],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: dataAccountId!,
        limit: "500",
      });
      const res = await fetch(`/api/trades?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load trades");
      return json.data;
    },
    enabled: dataEnabled && Boolean(dataAccountId),
    staleTime: 3_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  const { data: calendarTrades = trades } = useQuery<TradeDto[]>({
    queryKey: ["trades", "calendar", dataAccountId],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: dataAccountId!,
        status: "CLOSED",
        limit: "10000",
      });
      const res = await fetch(`/api/trades?${params.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load trade calendar");
      return json.data;
    },
    enabled:
      dataEnabled && Boolean(dataAccountId) && activeOverlay === "CALENDAR_TRACKER",
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  // Fetch risk rules
  const { data: riskRules = [] } = useQuery<RiskRuleDto[]>({
    queryKey: ["risk-rules", dataAccountId],
    queryFn: async () => {
      const params = new URLSearchParams({ accountId: dataAccountId! });
      const res = await fetch(`/api/risk/rules?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load risk rules");
      return json.data;
    },
    enabled: dataEnabled && Boolean(dataAccountId),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });

  // The statistics read every snapshot and closed trade of the period: refreshed by Realtime (at most every 8 s) and by
  // a slow poll, not every few seconds.
  const { data: analyticsSummary } = useQuery<AnalyticsSummary>({
    queryKey: ["analytics-summary", dataAccountId, selectedPeriod],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: dataAccountId!,
        period: selectedPeriod,
      });
      const res = await fetch(`/api/analytics/summary?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load performance summary");
      return json.data;
    },
    enabled: dataEnabled && Boolean(dataAccountId),
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  const { data: dailyAnalyticsSummary } = useQuery<AnalyticsSummary>({
    queryKey: ["analytics-summary", dataAccountId, "DAILY"],
    queryFn: async () => {
      const params = new URLSearchParams({
        accountId: dataAccountId!,
        period: "DAILY",
      });
      const res = await fetch(`/api/analytics/summary?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load daily performance");
      return json.data;
    },
    enabled: dataEnabled && Boolean(dataAccountId) && selectedPeriod !== "DAILY",
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

  // Sampled balance/equity history of the selected account. The chart below
  // reads the very same query (same key), so this costs no extra request; the
  // KPI sparklines are drawn from the recorded samples of the same range.
  const { data: performanceSeries } = usePerformanceSeries(dataAccountId, chartRange, { enabled: dataEnabled });
  const kpiSparklines = useMemo(() => {
    const samples = performanceSeries ? normalizeSamples(performanceSeries.samples) : [];
    return {
      balance: samples.map((sample) => sample.balance),
      equity: samples.map((sample) => sample.equity),
      floating: samples.map((sample) => sample.equity - sample.balance),
    };
  }, [performanceSeries]);

  // Subscribe to realtime updates

  useEffect(() => {
    const timer = window.setInterval(() => setStatsNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadOverlay().catch(() => undefined);
    }, 2_500);
    return () => window.clearTimeout(timer);
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
      sparkline: kpiSparklines.balance,
    },
    {
      label: "Equity",
      value: formatMoney({ amount: live.equity, currency: accountCurrency }),
      helper: "Net equity including open trades",
      tone: "lime" as const,
      status: `Drawdown ${formatPercent(accountDrawdown)}`,
      statusTone: riskState.drawdownBreached ? ("danger" as const) : ("lime" as const),
      sparkline: kpiSparklines.equity,
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
      sparkline: kpiSparklines.floating,
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

  // (every hook is above: the access answer only chooses what is shown, it never delays what is fetched)
  if (accessChecking) {
    // The page's own header and the shape of the finished dashboard from the first paint - not a bare "Loading…".
    return (
      <WorkspacePage
        eyebrow="Trader workspace"
        title={`Welcome, ${sessionUser?.name?.trim() || "Trader"}`}
        description="Equity, risk, and performance across your connected accounts."
      >
        <DashboardSkeleton />
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
                disabled={!baseAccount}
                onPointerEnter={() => void loadOverlay().catch(() => undefined)}
                onFocus={() => void loadOverlay().catch(() => undefined)}
                onClick={() => {
                  setSelectedView(tab.id);
                  setActiveOverlay(tab.id);
                }}
                className={`btn-dark h-9 px-4 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${active ? "btn-active" : ""}`}
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

      {/* Empty state for traders with no connected accounts; the finished page's shape while the account list is on its way */}
      {isLoading && !baseAccount ? (
        <DashboardSkeleton />
      ) : !isLoading && connectedAccounts.length === 0 ? (
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
          <AccountPerformanceChart
            className="mt-4"
            accountId={dataAccountId}
            accountName={baseAccount?.accountName ?? "your selected account"}
            currency={accountCurrency}
            range={chartRange}
            onRangeChange={setChartRange}
            liveEquity={baseAccount ? live.equity : null}
            currentDrawdownPercent={baseAccount ? accountDrawdown : null}
          />
        </>
      )}
    </WorkspacePage>

    {/* mounted only while a tab is open: its code (and the calendar's) is fetched on demand, see `loadOverlay` */}
    {activeOverlay !== null && baseAccount ? (
      <DashboardModeOverlay
        open
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
    ) : null}

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
