import type { AnalyticsSummary, EquityPoint, MoneyValue, TradeDto } from "./types";

const money = (amount: number, currency = "USD"): MoneyValue => ({
  amount: Number(amount.toFixed(2)),
  currency,
});

function inferTradeCurrency(trades: TradeDto[], fallback = "USD"): string {
  const currencies = [
    ...new Set(
      trades
        .filter((trade) => trade.status === "CLOSED")
        .map((trade) => trade.profit.currency)
        .filter(Boolean),
    ),
  ];

  return currencies[0] ?? fallback;
}

export function calculateTotalProfit(trades: TradeDto[], currency = "USD"): MoneyValue {
  return money(
    trades
      .filter((trade) => trade.status === "CLOSED")
      .reduce((total, trade) => total + trade.profit.amount, 0),
    currency,
  );
}

export function calculateWinRate(trades: TradeDto[]): number {
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  if (closed.length === 0) return 0;
  const wins = closed.filter((trade) => trade.profit.amount > 0).length;
  return Number(((wins / closed.length) * 100).toFixed(2));
}

export function calculateMaxDrawdown(equityCurve: EquityPoint[]): number {
  let peak = 0;
  let maxDrawdown = 0;

  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak === 0) continue;
    const drawdown = ((peak - point.equity) / peak) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return Number(maxDrawdown.toFixed(2));
}

export function calculateRiskRewardRatio(trades: TradeDto[]): number {
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const winners = closed.filter((trade) => trade.profit.amount > 0);
  const losers = closed.filter((trade) => trade.profit.amount < 0);
  if (winners.length === 0 || losers.length === 0) return 0;

  const averageWin =
    winners.reduce((total, trade) => total + trade.profit.amount, 0) / winners.length;
  const averageLoss =
    Math.abs(losers.reduce((total, trade) => total + trade.profit.amount, 0)) / losers.length;

  return Number((averageWin / averageLoss).toFixed(2));
}

export function calculateProfitFactor(trades: TradeDto[]): number {
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const grossProfit = closed
    .filter((trade) => trade.profit.amount > 0)
    .reduce((total, trade) => total + trade.profit.amount, 0);
  const grossLoss = Math.abs(
    closed.filter((trade) => trade.profit.amount < 0).reduce((total, trade) => total + trade.profit.amount, 0),
  );

  if (grossProfit === 0 || grossLoss === 0) return 0;
  return Number((grossProfit / grossLoss).toFixed(2));
}

export function calculateAverageWinLossRatio(trades: TradeDto[]): number {
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const winners = closed.filter((trade) => trade.profit.amount > 0);
  const losers = closed.filter((trade) => trade.profit.amount < 0);
  if (winners.length === 0 || losers.length === 0) return 0;

  const averageWin = winners.reduce((total, trade) => total + trade.profit.amount, 0) / winners.length;
  const averageLoss = Math.abs(losers.reduce((total, trade) => total + trade.profit.amount, 0)) / losers.length;

  return Number((averageWin / averageLoss).toFixed(2));
}

export function calculateConsistencyScore(trades: TradeDto[]): number {
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  if (closed.length === 0) return 0;

  const profitableDays = new Set(
    closed
      .filter((trade) => trade.profit.amount > 0)
      .map((trade) => trade.closedAt?.slice(0, 10) ?? trade.openedAt.slice(0, 10)),
  );
  const tradedDays = new Set(
    closed.map((trade) => trade.closedAt?.slice(0, 10) ?? trade.openedAt.slice(0, 10)),
  );

  return Number(((profitableDays.size / tradedDays.size) * 100).toFixed(2));
}

export function buildAnalyticsSummary(
  accountId: string,
  trades: TradeDto[],
  equityCurve: EquityPoint[],
): AnalyticsSummary {
  const currency = inferTradeCurrency(trades);
  const closedTradeCount = trades.filter((trade) => trade.status === "CLOSED").length;
  const winningTrades = trades.filter(
    (trade) => trade.status === "CLOSED" && trade.profit.amount > 0,
  );
  const losingTrades = trades.filter(
    (trade) => trade.status === "CLOSED" && trade.profit.amount < 0,
  );
  const averageWin =
    winningTrades.reduce((total, trade) => total + trade.profit.amount, 0) /
    Math.max(winningTrades.length, 1);
  const averageLoss =
    Math.abs(losingTrades.reduce((total, trade) => total + trade.profit.amount, 0)) /
    Math.max(losingTrades.length, 1);

  return {
    accountId,
    totalProfit: calculateTotalProfit(trades, currency),
    winRatePercent: calculateWinRate(trades),
    maxDrawdownPercent: calculateMaxDrawdown(equityCurve),
    riskRewardRatio: calculateRiskRewardRatio(trades),
    consistencyScore: calculateConsistencyScore(trades),
    profitFactor: calculateProfitFactor(trades),
    averageWin: money(averageWin, currency),
    averageLoss: money(averageLoss, currency),
    winningTradeCount: winningTrades.length,
    losingTradeCount: losingTrades.length,
    tradeCount: closedTradeCount,
    period: "ALL_TIME",
  };
}
