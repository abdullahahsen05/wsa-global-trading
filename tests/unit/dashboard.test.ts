import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  computePeriodStats,
  getEffectiveRiskLimit,
  getRiskLimitState,
} from "@/lib/domain/dashboard";
import type { RiskRuleDto, TradeDto } from "@/lib/domain/types";

const usd = (amount: number) => ({ amount, currency: "USD" });

function trade(
  id: string,
  profit: number,
  closedAt: string | null,
  status: TradeDto["status"] = "CLOSED",
): TradeDto {
  return {
    id,
    shortTradeId: `TRD-${id}`,
    accountId: "account-1",
    symbol: "EURUSD",
    side: "BUY",
    status,
    volume: 1,
    openPrice: 1,
    closePrice: status === "CLOSED" ? 1.1 : null,
    profit: usd(profit),
    openedAt: "2026-04-01T00:00:00.000Z",
    closedAt,
  };
}

const trades: TradeDto[] = [
  trade("today-win", 200, "2026-05-30T02:00:00.000Z"),
  trade("today-loss", -50, "2026-05-30T10:00:00.000Z"),
  trade("six-days-ago", 40, "2026-05-24T12:00:00.000Z"),
  trade("seven-day-boundary", -20, "2026-05-23T15:00:00.000Z"),
  trade("thirty-one-days-old", 500, "2026-04-29T15:00:00.000Z"),
  trade("open-trade", 999, null, "OPEN"),
];

describe("computePeriodStats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("DAILY includes only trades closed today", () => {
    expect(computePeriodStats(trades, "DAILY")).toMatchObject({
      totalProfit: 150,
      tradeCount: 2,
    });
  });

  test("WEEKLY includes trades closed in the last seven days", () => {
    expect(computePeriodStats(trades, "WEEKLY")).toMatchObject({
      totalProfit: 170,
      tradeCount: 4,
    });
  });

  test("MONTHLY includes trades from the current calendar month", () => {
    expect(computePeriodStats(trades, "MONTHLY")).toMatchObject({
      totalProfit: 170,
      tradeCount: 4,
    });
  });

  test("empty daily stats returns zeros", () => {
    expect(computePeriodStats([trade("old", 100, "2026-05-29T23:59:59.000Z")], "DAILY")).toEqual({
      totalProfit: 0,
      winRate: 0,
      tradeCount: 0,
      riskReward: 0,
    });
  });

  test("DAILY winRate is 50 for one win and one loss", () => {
    expect(computePeriodStats(trades, "DAILY").winRate).toBe(50);
  });

  test("open trades are excluded", () => {
    expect(computePeriodStats([trade("closed", 20, "2026-05-30T12:00:00.000Z"), trade("open", 999, null, "OPEN")], "DAILY")).toMatchObject({
      totalProfit: 20,
      tradeCount: 1,
    });
  });
});

describe("dashboard risk limits", () => {
  const rule = (
    id: string,
    metric: RiskRuleDto["metric"],
    threshold: number,
    accountId: string | null,
    enabled = true,
  ): RiskRuleDto => ({
    id,
    accountId,
    scope: accountId ? "ACCOUNT" : "PLATFORM",
    name: id,
    severity: "WARNING",
    action: "LIMIT",
    metric,
    threshold,
    enabled,
  });

  test("uses the strictest enabled rule that applies to the selected account", () => {
    const rules = [
      rule("platform", "MAX_DRAWDOWN", 8, null),
      rule("selected", "MAX_DRAWDOWN", 5, "account-1"),
      rule("other", "MAX_DRAWDOWN", 3, "account-2"),
      rule("disabled", "MAX_DRAWDOWN", 2, "account-1", false),
    ];

    expect(getEffectiveRiskLimit(rules, "MAX_DRAWDOWN", "account-1")).toBe(5);
  });

  test("returns no configured value instead of inventing a default", () => {
    expect(getEffectiveRiskLimit([], "DAILY_LOSS", "account-1")).toBeNull();
  });

  test("calculates live headroom and breach state from actual usage", () => {
    expect(
      getRiskLimitState({
        dailyClosedPnl: -750,
        drawdownPercent: 4,
        openTradeCount: 5,
        limits: { dailyLoss: 1000, maxDrawdown: 5, openTrades: 5 },
      }),
    ).toEqual({
      dailyLossUsed: 750,
      dailyLossHeadroom: 250,
      dailyLossBreached: false,
      drawdownBreached: false,
      openTradesBreached: true,
      breached: true,
    });
  });
});
