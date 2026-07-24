import type { RiskRuleDto, TradeDto } from "./types";
import {
  calculateAverageWinLossRatio,
  calculateTotalProfit,
  calculateWinRate,
} from "./metrics";

export type Period = "DAILY" | "WEEKLY" | "MONTHLY";

export type PeriodStats = {
  totalProfit: number;
  winRate: number;
  tradeCount: number;
  riskReward: number;
};

export type DashboardView = "CURRENT_EQUITY" | "CHECK_LIMITS" | "PROFIT_SUMMARY" | "CALENDAR_TRACKER";

export type DashboardRiskLimits = {
  dailyLoss: number | null;
  maxDrawdown: number | null;
  openTrades: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function getPeriodCutoff(period: Period, now: Date) {
  if (period === "DAILY") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  if (period === "MONTHLY") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  return new Date(now.getTime() - 7 * DAY_MS);
}

export function filterClosedTradesForPeriod(trades: TradeDto[], period: Period, now = new Date()): TradeDto[] {
  const cutoff = getPeriodCutoff(period, now);
  return trades.filter((trade) => {
    if (trade.status !== "CLOSED" || trade.closedAt === null) return false;
    return new Date(trade.closedAt).getTime() >= cutoff.getTime();
  });
}

export function computePeriodStats(trades: TradeDto[], period: Period, now = new Date()): PeriodStats {
  const periodTrades = filterClosedTradesForPeriod(trades, period, now);

  return {
    totalProfit: calculateTotalProfit(periodTrades).amount,
    winRate: calculateWinRate(periodTrades),
    tradeCount: periodTrades.length,
    riskReward: calculateAverageWinLossRatio(periodTrades),
  };
}

export function getEffectiveRiskLimit(
  rules: RiskRuleDto[],
  metric: RiskRuleDto["metric"],
  accountId: string,
): number | null {
  const thresholds = rules
    .filter(
      (rule) =>
        rule.enabled &&
        rule.metric === metric &&
        (rule.accountId === null || rule.accountId === accountId),
    )
    .map((rule) => rule.threshold)
    .filter((threshold) => Number.isFinite(threshold) && threshold > 0);

  return thresholds.length > 0 ? Math.min(...thresholds) : null;
}

export function getRiskLimitState(params: {
  dailyClosedPnl: number;
  drawdownPercent: number;
  openTradeCount: number;
  limits: DashboardRiskLimits;
}) {
  const dailyLossUsed = Math.max(0, -params.dailyClosedPnl);
  const dailyLossBreached =
    params.limits.dailyLoss !== null && dailyLossUsed >= params.limits.dailyLoss;
  const drawdownBreached =
    params.limits.maxDrawdown !== null &&
    params.drawdownPercent >= params.limits.maxDrawdown;
  const openTradesBreached =
    params.limits.openTrades !== null &&
    params.openTradeCount >= params.limits.openTrades;

  return {
    dailyLossUsed,
    dailyLossHeadroom:
      params.limits.dailyLoss === null
        ? null
        : Math.max(0, params.limits.dailyLoss - dailyLossUsed),
    dailyLossBreached,
    drawdownBreached,
    openTradesBreached,
    breached: dailyLossBreached || drawdownBreached || openTradesBreached,
  };
}
