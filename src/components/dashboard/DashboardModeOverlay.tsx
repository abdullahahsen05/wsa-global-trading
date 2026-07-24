"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X, TrendingDown } from "lucide-react";
import { motion } from "framer-motion";
import type { Period, DashboardView } from "@/lib/domain/dashboard";
import type { TradeDto } from "@/lib/domain/types";
import { CalendarTracker } from "@/components/dashboard/CalendarTracker";
import { OpenTradesTable } from "@/components/dashboard/OpenTradesTable";
import { Panel, StatTile, StatusPill } from "@/components/app/WorkspaceUI";
import { formatMoney, formatPercent } from "@/lib/utils/format";

type LiveSnapshot = {
  balance: number;
  equity: number;
  pnl: number;
  refresh: Date;
};

type PeriodSummary = {
  totalProfit: number;
  winRate: number;
  drawdown: number;
  consistency: number;
  tradeCount: number;
  riskReward: number;
};

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { duration: 0.2 },
  },
};

type DashboardModeOverlayProps = {
  open: boolean;
  view: DashboardView | null;
  onOpenChange: (open: boolean) => void;
  selectedPeriod: Period;
  onPeriodChange: (period: Period) => void;
  live: LiveSnapshot;
  openTrades: TradeDto[];
  trades: TradeDto[];
  summary: PeriodSummary;
  dailyLossLimit: number;
  maxDrawdownLimit: number;
  openTradeLimit: number;
  profitFactor: number;
  avgWinLoss: number;
};

function DrawdownPanel({ drawdown, riskReward }: { drawdown: number; riskReward: number }) {
  return (
    <Panel className="h-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Risk view</p>
          <h3 className="mt-2 text-lg font-semibold text-foreground">Drawdown analytics</h3>
          <p className="mt-1 text-sm text-muted">A compact risk readout for the current period.</p>
        </div>
        <TrendingDown className="h-5 w-5 text-accent" />
      </div>
      <div className="mt-5 rounded-[4px] border border-line bg-background p-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Max drawdown</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{formatPercent(drawdown)}</p>
          </div>
          <StatusPill tone={drawdown >= 5 ? "accent" : "lime"}>Controlled</StatusPill>
        </div>
        <div className="mt-4 h-3 overflow-hidden rounded-full border border-line bg-panel">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${Math.min((drawdown / 8) * 100, 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted">Threshold mapped to an 8% reference band.</p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-[4px] border border-line bg-background p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Risk / reward</p>
          <p className="mt-2 text-xl font-semibold text-accent-2">{riskReward.toFixed(2)}</p>
        </div>
        <div className="rounded-[4px] border border-line bg-background p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Account state</p>
          <p className="mt-2 text-xl font-semibold text-foreground">Stable</p>
        </div>
      </div>
    </Panel>
  );
}

export function DashboardModeOverlay({
  open,
  view,
  onOpenChange,
  selectedPeriod,
  onPeriodChange,
  live,
  openTrades,
  trades,
  summary,
  dailyLossLimit,
  maxDrawdownLimit,
  openTradeLimit,
  profitFactor,
  avgWinLoss,
}: DashboardModeOverlayProps) {
  const title =
    view === "CURRENT_EQUITY"
      ? "Current equity"
      : view === "CHECK_LIMITS"
        ? "Check limits"
        : view === "PROFIT_SUMMARY"
          ? "Profit summary"
          : "Calendar tracker";

  const description =
    view === "CURRENT_EQUITY"
      ? "Balance, equity, and floating PnL in a focused overlay."
      : view === "CHECK_LIMITS"
        ? "Platform guardrails without pushing the main dashboard down."
        : view === "PROFIT_SUMMARY"
          ? "Daily, weekly, and monthly performance in one compact view."
          : "Trade calendar for month and year review.";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/82" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[96vw] max-w-7xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[6px] border border-line bg-panel focus:outline-none">
          <motion.div
            variants={container}
            initial="hidden"
            animate="show"
            transition={{ duration: 0.28 }}
            className="flex min-h-0 w-full flex-col"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Dashboard detail</p>
                <Dialog.Title className="mt-1 text-lg font-semibold text-foreground">{title}</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close dashboard overlay"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-[4px] border border-line bg-background text-muted transition hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="invisible-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
              {view === "CURRENT_EQUITY" ? (
                <div className="grid items-stretch gap-4 xl:grid-cols-[0.66fr_0.34fr]">
                  <Panel className="h-full">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
                          Current equity
                        </p>
                        <h3 className="mt-2 text-lg font-semibold text-foreground">
                          Balance, equity, and floating PnL
                        </h3>
                        <p className="mt-1 text-sm text-muted">
                          Updated {live.refresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                      <StatusPill tone={live.pnl >= 0 ? "lime" : "accent"}>
                        {live.pnl >= 0 ? "Open profit" : "Open loss"}
                      </StatusPill>
                    </div>
                    <div className="definition-grid mt-4 grid gap-0 md:grid-cols-3">
                      <StatTile
                        label="Account balance"
                        value={formatMoney({ amount: live.balance, currency: "USD" })}
                      />
                      <StatTile
                        label="Equity"
                        value={formatMoney({ amount: live.equity, currency: "USD" })}
                        tone="lime"
                      />
                      <StatTile
                        label="Floating PnL"
                        value={formatMoney({ amount: live.pnl, currency: "USD" })}
                        tone={live.pnl >= 0 ? "accent" : "danger"}
                      />
                    </div>
                    <div className="mt-5">
                      <OpenTradesTable
                        trades={openTrades}
                        updatedAt={live.refresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      />
                    </div>
                  </Panel>
                  <DrawdownPanel drawdown={summary.drawdown} riskReward={summary.riskReward} />
                </div>
              ) : null}

              {view === "CHECK_LIMITS" ? (
                <div className="grid items-stretch gap-4 xl:grid-cols-[0.58fr_0.42fr]">
                  <Panel className="h-full">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
                          Check limits
                        </p>
                        <h3 className="mt-2 text-lg font-semibold text-foreground">Platform guardrails</h3>
                        <p className="mt-1 text-sm text-muted">
                          The limits panel stays inside the overlay so the main page remains short.
                        </p>
                      </div>
                      <StatusPill tone="accent">Mock limits</StatusPill>
                    </div>
                    <div className="definition-grid mt-4 grid gap-0 md:grid-cols-3">
                      <StatTile
                        label="Daily loss limit"
                        value={formatMoney({ amount: dailyLossLimit, currency: "USD" })}
                        helper="Current headroom is mocked."
                      />
                      <StatTile
                        label="Max drawdown"
                        value={formatPercent(maxDrawdownLimit)}
                        helper="Threshold tracked against the live snapshot."
                      />
                      <StatTile
                        label="Open trade limit"
                        value={openTradeLimit}
                        helper={`${openTrades.length} open trades currently active.`}
                      />
                    </div>
                    <div className="definition-grid mt-5 grid gap-0 md:grid-cols-2">
                      <div className="p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Limit headroom</p>
                        <p className="mt-2 text-xl font-semibold text-accent-2">
                          {formatMoney({ amount: dailyLossLimit - 1240, currency: "USD" })}
                        </p>
                      </div>
                      <div className="p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Risk posture</p>
                        <p className="mt-2 text-xl font-semibold text-foreground">Within bounds</p>
                      </div>
                    </div>
                  </Panel>
                  <DrawdownPanel drawdown={summary.drawdown} riskReward={summary.riskReward} />
                </div>
              ) : null}

              {view === "PROFIT_SUMMARY" ? (
                <Panel>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
                        Profit summary
                      </p>
                      <h3 className="mt-2 text-lg font-semibold text-foreground">
                        Daily, weekly, and monthly analytics
                      </h3>
                      <p className="mt-1 text-sm text-muted">
                        Switch periods to review account performance summaries for the selected range.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(["DAILY", "WEEKLY", "MONTHLY"] as Period[]).map((period) => (
                        <button
                          key={period}
                          type="button"
                          onClick={() => onPeriodChange(period)}
                          className={`btn-dark h-9 px-4 text-xs ${selectedPeriod === period ? "btn-active" : ""}`}
                        >
                          {period}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="definition-grid mt-5 grid gap-0 md:grid-cols-3">
                    <StatTile
                      label="Total profit"
                      value={formatMoney({ amount: summary.totalProfit, currency: "USD" })}
                      tone="lime"
                    />
                    <StatTile label="Closed trades" value={summary.tradeCount} tone="accent" />
                    <StatTile label="Consistency" value={formatPercent(summary.consistency)} tone="lime" />
                  </div>
                  <div className="definition-grid mt-5 grid gap-0 md:grid-cols-3">
                    <StatTile label="Win rate" value={formatPercent(summary.winRate)} />
                    <StatTile label="Profit factor" value={profitFactor.toFixed(2)} tone="accent" />
                    <StatTile label="Avg win/loss" value={avgWinLoss.toFixed(2)} tone="lime" />
                  </div>
                </Panel>
              ) : null}

              {view === "CALENDAR_TRACKER" ? <CalendarTracker trades={trades} /> : null}
            </div>
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
