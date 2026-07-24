"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BadgeDollarSign,
  ShieldAlert,
  Users,
  WalletCards,
} from "lucide-react";
import {
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
  CrmNoteDto,
  EquityPoint,
  RiskEventDto,
  RiskRuleDto,
  TradeDto,
  TraderAccountSummary,
  TraderProfileDto,
} from "@/lib/domain/types";
import {
  calculateTotalProfit,
  calculateConsistencyScore,
  calculateMaxDrawdown,
} from "@/lib/domain/metrics";
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
  { key: "RISK_QUEUE", label: "Risk Queue" },
  { key: "CRM", label: "CRM" },
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
      <div className="grid sm:grid-cols-2 xl:grid-cols-5">
        {items.map((item, index) => {
          const Icon = item.icon;
          const tone = toneClasses[item.tone];

          return (
            <article
              key={item.label}
              className={[
                "relative min-h-[150px] px-5 py-5",
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

                  <p className="mt-3 text-[28px] font-semibold leading-none tracking-[-0.03em] text-foreground tabular-nums">
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

function PlatformOversightChart({
  data,
}: {
  data: EquityPoint[];
}) {
  const width = 920;
  const height = 300;
  const padding = {
    top: 20,
    right: 18,
    bottom: 40,
    left: 58,
  };

  const values = data.map((point) => point.equity);
  const fallbackValue = values[0] ?? 0;
  const safeValues =
    values.length > 1 ? values : [fallbackValue, fallbackValue];

  const rawMin = Math.min(...safeValues);
  const rawMax = Math.max(...safeValues);
  const spread = Math.max(rawMax - rawMin, Math.max(Math.abs(rawMax) * 0.12, 1));
  const min = Math.max(0, rawMin - spread * 0.12);
  const max = rawMax + spread * 0.12;
  const range = max - min || 1;

  const drawableWidth = width - padding.left - padding.right;
  const drawableHeight = height - padding.top - padding.bottom;

  const normalizedData =
    data.length > 1
      ? data
      : [
          {
            capturedAt: data[0]?.capturedAt ?? new Date().toISOString(),
            balance: data[0]?.balance ?? 0,
            equity: data[0]?.equity ?? 0,
          },
          {
            capturedAt: data[0]?.capturedAt ?? new Date().toISOString(),
            balance: data[0]?.balance ?? 0,
            equity: data[0]?.equity ?? 0,
          },
        ];

  const points = normalizedData.map((point, index) => {
    const x =
      padding.left +
      (index / Math.max(normalizedData.length - 1, 1)) * drawableWidth;
    const y =
      padding.top +
      drawableHeight -
      ((point.equity - min) / range) * drawableHeight;

    return {
      x,
      y,
      point,
    };
  });

  const linePoints = points.map(({ x, y }) => `${x},${y}`).join(" ");
  const areaPoints = [
    `${points[0]?.x ?? padding.left},${height - padding.bottom}`,
    linePoints,
    `${points.at(-1)?.x ?? width - padding.right},${height - padding.bottom}`,
  ].join(" ");

  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, index) => {
    const ratio = index / tickCount;
    const value = max - ratio * range;
    const y = padding.top + ratio * drawableHeight;

    return {
      value,
      y,
    };
  });

  const dateIndexes = Array.from(
    new Set([
      0,
      Math.floor((normalizedData.length - 1) * 0.25),
      Math.floor((normalizedData.length - 1) * 0.5),
      Math.floor((normalizedData.length - 1) * 0.75),
      normalizedData.length - 1,
    ]),
  );

  const latest = data.at(-1);

  return (
    <section className="overflow-hidden rounded-[4px] border border-line bg-panel/45">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Platform oversight
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Operational health and account movement across the platform.
          </p>
        </div>

        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
            Platform equity
          </p>
          <p className="mt-1 text-base font-semibold text-accent tabular-nums">
            {latest
              ? formatMoney({
                  amount: latest.equity,
                  currency: "USD",
                })
              : "$0"}
          </p>
        </div>
      </header>

      <div className="px-4 pb-3 pt-4">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[280px] w-full overflow-visible"
          role="img"
          aria-label="Platform equity trend"
        >
          <defs>
            <linearGradient
              id="admin-platform-equity-fill"
              x1="0"
              x2="0"
              y1="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#21d19f" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#21d19f" stopOpacity="0" />
            </linearGradient>
          </defs>

          {yTicks.map((tick) => (
            <g key={tick.y}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={tick.y}
                y2={tick.y}
                stroke="rgba(255,255,255,0.07)"
                strokeWidth="1"
              />
              <text
                x={padding.left - 12}
                y={tick.y + 4}
                textAnchor="end"
                fill="rgba(255,255,255,0.42)"
                fontSize="11"
              >
                {new Intl.NumberFormat("en-US", {
                  notation: "compact",
                  maximumFractionDigits: 0,
                  style: "currency",
                  currency: "USD",
                }).format(tick.value)}
              </text>
            </g>
          ))}

          <polygon
            points={areaPoints}
            fill="url(#admin-platform-equity-fill)"
          />

          <polyline
            points={linePoints}
            fill="none"
            stroke="#21d19f"
            strokeWidth="2.25"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {points.length > 0 ? (
            <g>
              <circle
                cx={points.at(-1)?.x}
                cy={points.at(-1)?.y}
                r="5.5"
                fill="#07100f"
                stroke="#21d19f"
                strokeWidth="2.5"
              />
              <circle
                cx={points.at(-1)?.x}
                cy={points.at(-1)?.y}
                r="2"
                fill="#21d19f"
              />
            </g>
          ) : null}

          {dateIndexes.map((index) => {
            const point = normalizedData[index];
            const plottedPoint = points[index];

            if (!point || !plottedPoint) return null;

            return (
              <text
                key={`${point.capturedAt}-${index}`}
                x={plottedPoint.x}
                y={height - 12}
                textAnchor={
                  index === 0
                    ? "start"
                    : index === normalizedData.length - 1
                      ? "end"
                      : "middle"
                }
                fill="rgba(255,255,255,0.42)"
                fontSize="11"
              >
                {new Date(point.capturedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </text>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

export default function AdminOverviewPage() {
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayView, setOverlayView] =
    useState<AdminOverviewView>("OVERVIEW");

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
  });

  const { data: tradingAccounts = [] } = useQuery<
    TraderAccountSummary[]
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
  });

  const { data: traders = [] } = useQuery<TraderProfileDto[]>({
    queryKey: ["crm-traders"],
    queryFn: async () => {
      const res = await fetch("/api/crm/traders");
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load traders",
        );
      }

      return json.data;
    },
  });

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
  });

  const { data: riskEvents = [] } = useQuery<RiskEventDto[]>({
    queryKey: ["risk-events"],
    queryFn: async () => {
      const res = await fetch("/api/risk/events");
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load risk events",
        );
      }

      return json.data;
    },
  });

  const { data: riskRules = [] } = useQuery<RiskRuleDto[]>({
    queryKey: ["risk-rules"],
    queryFn: async () => {
      const res = await fetch("/api/risk/rules");
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load risk rules",
        );
      }

      return json.data;
    },
  });

  const { data: crmNotes = [] } = useQuery<CrmNoteDto[]>({
    queryKey: ["crm-notes"],
    queryFn: async () => {
      const res = await fetch("/api/crm/notes");
      const json = await res.json();

      if (!json.ok) {
        throw new Error(
          json.error?.message ?? "Failed to load CRM notes",
        );
      }

      return json.data;
    },
  });

  const equityCurve: EquityPoint[] = tradingAccounts.map(
    (account) => ({
      capturedAt: account.updatedAt,
      balance: account.balance.amount,
      equity: account.equity.amount,
    }),
  );

  const activeTraders = adminSummary?.activeTraders ?? 0;
  const connectedAccounts = adminSummary?.connectedAccounts ?? 0;
  const openRiskEvents =
    adminSummary?.openRiskEvents ?? riskEvents.length;
  const monthlyRecurringRevenue =
    adminSummary?.monthlyRecurringRevenue ?? {
      amount: 0,
      currency: "USD",
    };

  const platformMetrics: PlatformMetric[] = [
    {
      label: "Active traders",
      value: `${activeTraders}`,
      status: "Excellent",
      tone: "lime",
      progress: Math.min(activeTraders / 150, 1),
      icon: Users,
    },
    {
      label: "Connected accounts",
      value: `${connectedAccounts}`,
      status: "Good",
      tone: "accent",
      progress: Math.min(connectedAccounts / 250, 1),
      icon: WalletCards,
    },
    {
      label: "Open risk events",
      value: `${openRiskEvents}`,
      status: openRiskEvents > 0 ? "Watch" : "Stable",
      tone: openRiskEvents > 0 ? "danger" : "lime",
      progress: Math.max(0.08, 1 - openRiskEvents / 10),
      icon: ShieldAlert,
    },
    {
      label: "MRR",
      value: formatMoney(monthlyRecurringRevenue),
      status: "Good",
      tone: "accent",
      progress: Math.min(
        monthlyRecurringRevenue.amount / 20000,
        1,
      ),
      icon: BadgeDollarSign,
    },
    {
      label: "Accounts under supervision",
      value: `${tradingAccounts.length}`,
      status: "Stable",
      tone: "lime",
      progress: Math.min(tradingAccounts.length / 10, 1),
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
      description="A single calm operations dashboard for traders, accounts, risk, subscriptions, and audits."
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

      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-[minmax(0,2.05fr)_minmax(300px,0.95fr)]">
        <PlatformOversightChart data={equityCurve} />

        <Panel className="h-full !rounded-[4px] !p-0">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-5">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Platform health
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted">
                Summary signals for support, supervision, and admin
                follow-up.
              </p>
            </div>

            <StatusPill
              tone={openRiskEvents > 0 ? "danger" : "lime"}
            >
              {openRiskEvents > 0
                ? "Needs attention"
                : "Stable"}
            </StatusPill>
          </header>

          <dl>
            <div className="flex min-h-11 items-center justify-between gap-4 border-b border-line px-5">
              <dt className="text-sm text-muted">Net profit</dt>
              <dd className="text-sm font-semibold text-accent-2 tabular-nums">
                {formatMoney(calculateTotalProfit(trades))}
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
                {formatPercent(
                  calculateMaxDrawdown(equityCurve),
                )}
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
                the platform snapshot, with{" "}
                {tradingAccounts.length} accounts currently under
                supervision.
              </dd>
            </div>
          </dl>
        </Panel>
      </div>

      <div className="mt-5 grid items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel className="flex h-[340px] min-w-0 flex-col overflow-hidden !rounded-[4px] !p-0">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <h2 className="text-base font-semibold text-foreground">
              Trader watchlist
            </h2>
            <StatusPill tone="muted">Live review</StatusPill>
          </header>

          <div className="min-h-0 flex-1 invisible-scrollbar overflow-auto">
            <table className="w-full min-w-[720px] table-fixed text-left text-sm">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[20%]" />
                <col className="w-[12%]" />
                <col className="w-[18%]" />
                <col className="w-[22%]" />
              </colgroup>

              <thead className="border-b border-line bg-background/55">
                <tr className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
                  <th className="px-5 py-3">Trader</th>
                  <th className="px-4 py-3">Segment</th>
                  <th className="px-4 py-3 text-right">
                    Accounts
                  </th>
                  <th className="px-4 py-3 text-right">
                    Equity
                  </th>
                  <th className="px-5 py-3 text-right">
                    Last active
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-line">
                {traders.length > 0 ? (
                  traders.map((trader) => (
                    <tr
                      key={trader.traderId}
                      className="transition-colors hover:bg-background/35"
                    >
                      <td className="px-5 py-4 font-semibold text-foreground">
                        {trader.name}
                      </td>
                      <td className="px-4 py-4">
                        <StatusPill
                          tone={
                            trader.segment === "AT_RISK"
                              ? "accent"
                              : "lime"
                          }
                        >
                          {trader.segment}
                        </StatusPill>
                      </td>
                      <td className="px-4 py-4 text-right text-foreground tabular-nums">
                        {trader.accountCount}
                      </td>
                      <td className="px-4 py-4 text-right font-semibold text-accent-2 tabular-nums">
                        {formatMoney(trader.totalEquity)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-right text-xs text-muted">
                        {new Date(
                          trader.lastActivityAt,
                        ).toLocaleString()}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-5 py-8 text-sm text-muted"
                    >
                      No traders are currently available for review.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel className="flex h-[340px] min-w-0 flex-col overflow-hidden !rounded-[4px] !p-0">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <h2 className="text-base font-semibold text-foreground">
              Risk queue
            </h2>
            <StatusPill
              tone={riskEvents.length > 0 ? "danger" : "lime"}
            >
              {riskEvents.length > 0
                ? `${riskEvents.length} open`
                : "Clear"}
            </StatusPill>
          </header>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 invisible-scrollbar overflow-y-auto">
            {riskEvents.length > 0 ? (
              riskEvents.map((event) => (
                <article
                  key={event.id}
                  className="group relative border-b border-line px-5 py-4 transition-colors hover:bg-background/30"
                >
                  <span className="absolute inset-y-0 left-0 w-0.5 bg-danger" />

                  <div className="flex items-start gap-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-danger" />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-4">
                        <p className="font-semibold leading-5 text-foreground">
                          {event.ruleName}
                        </p>
                        <StatusPill tone="accent">
                          {event.severity}
                        </StatusPill>
                      </div>

                      <p className="mt-1.5 text-sm leading-6 text-muted">
                        {event.message}
                      </p>
                    </div>
                  </div>
                </article>
              ))
            ) : (
              <div className="px-5 py-8 text-sm text-muted">
                No risk events currently require review.
              </div>
            )}
            </div>

            <footer className="flex min-h-12 items-center justify-between gap-4 bg-background/35 px-5">
              <p className="text-sm font-medium text-muted">
                Accounts under supervision
              </p>
              <p className="text-lg font-semibold text-foreground tabular-nums">
                {tradingAccounts.length}
              </p>
            </footer>
          </div>
        </Panel>
      </div>

      <AdminOverviewOverlay
        open={overlayOpen}
        view={overlayView}
        onOpenChange={setOverlayOpen}
        activeTraders={activeTraders}
        connectedAccounts={connectedAccounts}
        openRiskEvents={openRiskEvents}
        monthlyRecurringRevenue={monthlyRecurringRevenue}
        equityCurve={equityCurve}
        trades={trades}
        tradingAccounts={tradingAccounts}
        traders={traders}
        riskEvents={riskEvents}
        riskRules={riskRules}
        crmNotes={crmNotes}
      />
    </WorkspacePage>
  );
}
