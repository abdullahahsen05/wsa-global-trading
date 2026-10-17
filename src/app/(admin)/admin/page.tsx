"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BadgeDollarSign,
  Search,
  TrendingDown,
  TrendingUp,
  Users,
  WalletCards,
} from "lucide-react";
import {
  DataTable,
  PaginationControls,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import {
  AdminOverviewOverlay,
  type AdminOverviewView,
} from "@/components/admin/AdminOverviewOverlay";
import type {
  AdminSummaryDto,
  AdminTradingAccountSummary,
  AdminEquityTimelineDto,
  TradeDto,
  TraderCrmDirectoryDto,
  TraderProfileDto,
} from "@/lib/domain/types";
import {
  calculateTotalProfit,
  calculateConsistencyScore,
  calculateMaxDrawdown,
} from "@/lib/domain/metrics";
import { AccountPerformanceChart } from "@/components/charts/AccountPerformanceChart";
import { formatMoney, formatPercent } from "@/lib/utils/format";

type SessionUser = {
  id: string;
  name: string;
  email: string;
};

type MetricTone = "accent" | "lime" | "danger" | "muted";

type PlatformMetric = {
  label: string;
  value: string;
  status: string;
  tone: MetricTone;
  progress: number;
  icon: typeof Users;
};

const adminTabs: Array<{
  key: AdminOverviewView;
  label: string;
}> = [
  { key: "OVERVIEW", label: "Overview" },
  { key: "ACCOUNTS", label: "Accounts" },
];

const toneClasses: Record<
  MetricTone,
  {
    dot: string;
    text: string;
    line: string;
  }
> = {
  accent: {
    dot: "bg-accent",
    text: "text-accent",
    line: "bg-accent",
  },
  lime: {
    dot: "bg-accent-2",
    text: "text-accent-2",
    line: "bg-accent-2",
  },
  danger: {
    dot: "bg-danger",
    text: "text-danger",
    line: "bg-danger",
  },
  muted: {
    dot: "bg-muted",
    text: "text-muted",
    line: "bg-muted",
  },
};

function PlatformMetricRail({ items }: { items: PlatformMetric[] }) {
  return (
    <section className="overflow-hidden rounded-[4px] border border-line bg-panel/45">
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {items.map((item, index) => {
          const Icon = item.icon;
          const tone = toneClasses[item.tone];

          return (
            <article
              key={item.label}
              className={[
                "relative min-w-0 min-h-[150px] px-5 py-5",
                index > 0 ? "border-t border-line sm:border-t-0" : "",
                index % 2 !== 0 ? "sm:border-l sm:border-line" : "",
                index >= 2 ? "sm:border-t sm:border-line xl:border-t-0" : "",
                index > 0 ? "xl:border-l xl:border-line" : "",
              ].join(" ")}
            >
              <div className="flex items-start gap-4">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[4px] border border-line bg-background/70 text-muted">
                  <Icon className="h-4 w-4" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="min-h-[28px] text-[10px] font-semibold uppercase leading-[1.4] tracking-[0.18em] text-muted">
                    {item.label}
                  </p>

                  <p className="mt-3 break-words text-[clamp(1.25rem,1.7vw,1.75rem)] font-semibold leading-tight tracking-[-0.03em] text-foreground tabular-nums" title={item.value}>
                    {item.value}
                  </p>

                  <div className="mt-3 flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                    <span className={`text-xs font-semibold ${tone.text}`}>
                      {item.status}
                    </span>
                  </div>
                </div>
              </div>

              <div className="absolute inset-x-5 bottom-4 h-px bg-line">
                <span
                  className={`block h-px ${tone.line}`}
                  style={{
                    width: `${Math.max(4, Math.min(item.progress, 1) * 100)}%`,
                  }}
                />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function formatClosedTradeProfit(trades: TradeDto[]): string {
  const closedTrades = trades.filter((trade) => trade.status === "CLOSED");
  const currencies = [
    ...new Set(closedTrades.map((trade) => trade.profit.currency).filter(Boolean)),
  ];

  if (currencies.length > 1) return "Mixed";

  return formatMoney(
    calculateTotalProfit(closedTrades, currencies[0] ?? "USD"),
  );
}

/**
 * Platform oversight = the combined history of every connected account, drawn
 * with the same Myfxbook-style chart as a single account (admins are scoped to
 * all accounts by the API). Stored snapshots and closed trades only - nothing
 * on this chart is generated.
 */
function PlatformOversightChart({ currency }: { currency: string }) {
  return (
    <AccountPerformanceChart
      accountId="ALL"
      accountName="every connected account"
      currency={currency}
      eyebrow="Platform"
      title="Platform oversight"
      description="Combined equity, closed P&L and traded volume of all connected accounts, drawn from stored snapshots and closed trades."
    />
  );
}

export default function AdminOverviewPage() {
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayView, setOverlayView] =
    useState<AdminOverviewView>("OVERVIEW");
  const [watchPage, setWatchPage] = useState(1);
  const [watchPageSize, setWatchPageSize] = useState(25);
  const [watchSearch, setWatchSearch] = useState("");

  const { data: sessionUser } = useQuery<SessionUser>({
    queryKey: ["session"],
    queryFn: async () => {
      const res = await fetch("/api/auth/session");
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load profile",
        );
      }

      return json.data;
    },
  });

  const { data: adminSummary } = useQuery<AdminSummaryDto>({
    queryKey: ["admin-summary"],
    queryFn: async () => {
      const res = await fetch("/api/admin/summary");
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load admin summary",
        );
      }

      return json.data;
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const {
    data: tradingAccounts = [],
    dataUpdatedAt: accountsFetchedAt,
  } = useQuery<
    AdminTradingAccountSummary[]
  >({
    queryKey: ["admin-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/admin/accounts");
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load accounts",
        );
      }

      return json.data;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const { data: traderDirectory } = useQuery<TraderCrmDirectoryDto>({
    queryKey: ["admin-overview-traders", watchPage, watchPageSize, watchSearch],
    queryFn: async () => {
      const params = new URLSearchParams({
        view: "directory",
        page: String(watchPage),
        pageSize: String(watchPageSize),
        sort: "NEWEST",
      });
      if (watchSearch.trim()) params.set("search", watchSearch.trim());
      const res = await fetch(`/api/crm/traders?${params.toString()}`);
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load traders",
        );
      }

      return json.data;
    },
    placeholderData: (previous) => previous,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const traders = useMemo(
    () => traderDirectory?.items ?? [],
    [traderDirectory?.items],
  );

  const { data: trades = [] } = useQuery<TradeDto[]>({
    queryKey: ["trades"],
    queryFn: async () => {
      const res = await fetch("/api/trades");
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load trades",
        );
      }

      return json.data;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const { data: equityTimeline } = useQuery<AdminEquityTimelineDto>({
    queryKey: ["admin-equity-timeline"],
    queryFn: async () => {
      const res = await fetch("/api/admin/analytics/equity");
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load platform equity",
        );
      }

      return json.data;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const equityCurve = equityTimeline?.points ?? [];

  const activeTraders = adminSummary?.activeTraders ?? 0;
  const connectedAccounts = adminSummary?.connectedAccounts ?? 0;
  const monthlyRecurringRevenue =
    adminSummary?.monthlyRecurringRevenue ?? {
      amount: 0,
      currency: "USD",
    };
  const connectedAccountRows = tradingAccounts.filter((account) => account.status === "CONNECTED");
  const accountCurrencies = [...new Set(connectedAccountRows.map((account) => account.equity.currency))];
  const portfolioCurrency = accountCurrencies.length === 1 ? accountCurrencies[0] : null;
  const mixedAccountCurrencies = accountCurrencies.length > 1;
  const mixedCurrencies = equityTimeline?.mixedCurrencies ?? mixedAccountCurrencies;
  const liveCurrency = portfolioCurrency ?? equityTimeline?.currency ?? "USD";
  const totalEquity = connectedAccountRows.reduce((sum, account) => sum + account.equity.amount, 0);
  const totalFloatingPnl = connectedAccountRows.reduce((sum, account) => sum + account.floatingPnl.amount, 0);
  const newestAccountUpdate = connectedAccountRows
    .map((account) => account.updatedAt)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
  const liveEquityCurve =
    equityCurve.length > 0
      ? equityCurve
      : portfolioCurrency && connectedAccountRows.length > 0
        ? [
            {
              capturedAt:
                newestAccountUpdate ?? new Date(accountsFetchedAt).toISOString(),
              balance: connectedAccountRows.reduce(
                (sum, account) => sum + account.balance.amount,
                0,
              ),
              equity: totalEquity,
            },
          ]
        : [];
  const latestTimelineEquity = !mixedCurrencies ? liveEquityCurve.at(-1)?.equity : null;
  const displayTotalEquity = latestTimelineEquity ?? totalEquity;
  const liveMaxDrawdown = Math.max(
    calculateMaxDrawdown(liveEquityCurve),
    ...connectedAccountRows.map((account) => account.drawdownPercent),
  );
  const overlayTraders: TraderProfileDto[] = traders.map((trader) => ({
    traderId: trader.traderId,
    name: trader.name,
    email: trader.email,
    segment: trader.segment,
    accountCount: trader.accounts.length,
    totalEquity: trader.totalEquity ?? { amount: 0, currency: "USD" },
    lastActivityAt: trader.lastActivityAt ?? trader.joinedAt,
  }));

  const platformMetrics: PlatformMetric[] = [
    {
      label: "Active traders",
      value: `${activeTraders}`,
      status: "Active profiles",
      tone: "lime",
      progress: activeTraders > 0 ? 1 : 0.04,
      icon: Users,
    },
    {
      label: "Connected accounts",
      value: `${connectedAccounts}`,
      status: "Broker linked",
      tone: "accent",
      progress: connectedAccounts > 0 ? 1 : 0.04,
      icon: WalletCards,
    },
    {
      label: "Live account equity",
      value: !mixedCurrencies
        ? formatMoney({ amount: displayTotalEquity, currency: liveCurrency })
        : "Mixed",
      status: connectedAccounts > 0 ? "Live" : "No accounts",
      tone: connectedAccounts > 0 ? "lime" : "muted",
      progress: connectedAccounts > 0 ? 1 : 0.04,
      icon: TrendingUp,
    },
    {
      label: "MRR",
      value: formatMoney(monthlyRecurringRevenue),
      status: "Active monthly products",
      tone: "accent",
      progress: monthlyRecurringRevenue.amount > 0 ? 1 : 0.04,
      icon: BadgeDollarSign,
    },
    {
      label: "Floating P&L",
      value: !mixedCurrencies
        ? formatMoney({ amount: totalFloatingPnl, currency: liveCurrency })
        : "Mixed",
      status: totalFloatingPnl > 0 ? "Positive" : totalFloatingPnl < 0 ? "Negative" : "Flat",
      tone: totalFloatingPnl > 0 ? "lime" : totalFloatingPnl < 0 ? "danger" : "muted",
      progress: connectedAccounts > 0 ? Math.min(Math.max(Math.abs(totalFloatingPnl) / Math.max(displayTotalEquity, 1), 0.04), 1) : 0.04,
      icon: Activity,
    },
  ];

  const closedTradeCount = trades.filter(
    (trade) => trade.status === "CLOSED",
  ).length;

  const openView = (view: AdminOverviewView) => {
    setOverlayView(view);
    setOverlayOpen(true);
  };

  return (
    <WorkspacePage
      eyebrow="Admin"
      title={`Welcome, ${sessionUser?.name?.trim() || "Admin"}`}
      description="Live trader, account, subscription, and platform-performance supervision."
    >
      <nav className="-mt-1 mb-5 invisible-scrollbar overflow-x-auto border-b border-line">
        <div className="flex min-w-max gap-7">
          {adminTabs.map((tab) => {
            const active = overlayView === tab.key;

            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => openView(tab.key)}
                className={[
                  "relative h-11 border-b-2 px-1 text-sm font-medium transition-colors",
                  active
                    ? "border-accent text-foreground"
                    : "border-transparent text-muted hover:text-foreground",
                ].join(" ")}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </nav>

      <PlatformMetricRail items={platformMetrics} />

      <div className="mt-5 grid items-start gap-4 xl:grid-cols-[minmax(0,2.05fr)_minmax(300px,0.95fr)]">
        <PlatformOversightChart currency={liveCurrency} />

        <Panel className="!rounded-[4px] !p-0">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-5">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Platform health
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted">
                Live account and trading-performance signals.
              </p>
            </div>

            {connectedAccounts > 0 ? (
              <StatusPill tone="lime">Live</StatusPill>
            ) : null}
          </header>

          <dl>
            <div className="flex min-h-11 items-center justify-between gap-4 border-b border-line px-5">
              <dt className="text-sm text-muted">Net profit</dt>
              <dd className="text-sm font-semibold text-accent-2 tabular-nums">
                {formatClosedTradeProfit(trades)}
              </dd>
            </div>

            <div className="flex min-h-11 items-center justify-between gap-4 border-b border-line px-5">
              <dt className="text-sm text-muted">Closed trades</dt>
              <dd className="text-sm font-semibold text-foreground tabular-nums">
                {closedTradeCount}
              </dd>
            </div>

            <div className="flex min-h-11 items-center justify-between gap-4 border-b border-line px-5">
              <dt className="text-sm text-muted">Max drawdown</dt>
              <dd className="text-sm font-semibold text-danger tabular-nums">
                {formatPercent(liveMaxDrawdown)}
              </dd>
            </div>

            <div className="flex min-h-11 items-center justify-between gap-4 border-b border-line px-5">
              <dt className="text-sm text-muted">Consistency</dt>
              <dd className="text-sm font-semibold text-accent-2 tabular-nums">
                {formatPercent(
                  calculateConsistencyScore(trades),
                )}
              </dd>
            </div>

            <div className="px-5 py-5">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                Summary
              </dt>
              <dd className="mt-2 text-sm leading-6 text-muted">
                {closedTradeCount} closed trades are represented in
                the live platform view. Current account values were
                last updated{" "}
                {newestAccountUpdate
                  ? new Date(newestAccountUpdate).toLocaleString()
                  : "as accounts update"}.
              </dd>
            </div>
          </dl>
        </Panel>
      </div>

      <Panel className="mt-5 min-w-0 overflow-hidden !rounded-[4px] !p-0">
        <header className="flex flex-col gap-4 border-b border-line px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-foreground">Trader watchlist</h2>
              <StatusPill tone="lime">Live data</StatusPill>
            </div>
            <p className="mt-1 text-sm text-muted">
              Latest connected-account equity and activity for {traderDirectory?.pagination.total ?? 0} traders.
            </p>
          </div>
          <label className="relative block w-full xl:max-w-sm">
            <span className="sr-only">Search trader watchlist</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={watchSearch}
              onChange={(event) => {
                setWatchPage(1);
                setWatchSearch(event.target.value);
              }}
              placeholder="Search trader, email, or account..."
              className="h-10 w-full rounded-[4px] border border-line bg-background pl-10 pr-3 text-sm text-foreground outline-none placeholder:text-muted focus:border-accent"
            />
          </label>
        </header>

        <DataTable
          paginated={false}
          maxBodyHeight="560px"
          headers={["Trader", "Status", "Registration affiliate", "Accounts", "Equity", "Floating P&L", "Last activity"]}
          rows={traders.map((trader) => {
            const movement = trader.floatingPnl?.amount ?? null;
            return [
              <div key="trader" className="min-w-48">
                <p className="font-semibold text-foreground">{trader.name}</p>
                <p className="mt-0.5 text-xs text-muted">{trader.email}</p>
              </div>,
              <StatusPill key="status" tone={trader.profileStatus === "ACTIVE" ? "lime" : trader.profileStatus === "SUSPENDED" ? "danger" : "accent"}>
                {trader.profileStatus}
              </StatusPill>,
              <span key="affiliate" className="whitespace-nowrap text-sm text-foreground">
                {trader.partner?.name ?? "WSA PLATFORM"}
              </span>,
              <span key="accounts" className="whitespace-nowrap tabular-nums">
                {trader.connectedAccountCount} / {trader.accounts.length} connected
              </span>,
              <span key="equity" className="whitespace-nowrap font-semibold text-accent-2 tabular-nums">
                {trader.totalEquity ? formatMoney(trader.totalEquity) : "Mixed / awaiting sync"}
              </span>,
              <span
                key="movement"
                className={`inline-flex items-center justify-end gap-1 whitespace-nowrap font-semibold tabular-nums ${
                  movement === null || movement === 0 ? "text-muted" : movement > 0 ? "text-accent-2" : "text-danger"
                }`}
              >
                {movement === null || movement === 0 ? (
                  <span aria-hidden="true">—</span>
                ) : movement > 0 ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
                {movement === null
                  ? "Waiting"
                  : formatMoney({
                      amount: Math.abs(movement),
                      currency: trader.floatingPnl?.currency ?? "USD",
                    })}
              </span>,
              <span key="activity" className="whitespace-nowrap text-xs text-muted">
                {trader.lastActivityAt ? new Date(trader.lastActivityAt).toLocaleString() : "No sync yet"}
              </span>,
            ];
          })}
        />
        {traders.length === 0 ? (
          <p className="border-t border-line px-5 py-8 text-sm text-muted">
            No traders match the current search.
          </p>
        ) : null}
        <div className="px-5 pb-4">
          <PaginationControls
            currentPage={traderDirectory?.pagination.page ?? watchPage}
            totalItems={traderDirectory?.pagination.total ?? 0}
            pageSize={watchPageSize}
            pageSizeOptions={[10, 25, 50, 100]}
            onPageChange={setWatchPage}
            onPageSizeChange={(size) => {
              setWatchPage(1);
              setWatchPageSize(size);
            }}
          />
        </div>
      </Panel>

      <AdminOverviewOverlay
        open={overlayOpen}
        view={overlayView}
        onOpenChange={setOverlayOpen}
        activeTraders={activeTraders}
        connectedAccounts={connectedAccounts}
        openRiskEvents={adminSummary?.openRiskEvents ?? 0}
        monthlyRecurringRevenue={monthlyRecurringRevenue}
        equityCurve={equityCurve}
        equityCurrency={liveCurrency}
        trades={trades}
        tradingAccounts={tradingAccounts}
        traders={overlayTraders}
        riskEvents={[]}
        riskRules={[]}
        crmNotes={[]}
      />
    </WorkspacePage>
  );
}
