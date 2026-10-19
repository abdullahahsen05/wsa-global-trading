import { describe, expect, test } from "vitest";
import { bulkTargets } from "@/lib/gateway/tradeExecutor";
import {
  breakEvenLevel,
  buildOrderPlan,
  bulkPreview,
  bulkQuestion,
  describePlan,
  formatRatio,
  levelFromPoints,
  lotStep,
  marketEntry,
  partialLots,
  planToRequest,
  pointSize,
  pointsBetween,
  resolveDigits,
  riskReward,
  stepLots,
  type OrderPlan,
  type TicketInput,
} from "@/lib/trade/ticketMath";
import { WEB_TRADE_BULK_SCOPES, type WebTradePendingOrder, type WebTradePosition } from "@/lib/trade/webTrade";
import { formatDuration, timingText } from "@/lib/trade/webTradeFormat";

const QUOTE = { bid: 2301.1, ask: 2301.4 };

function ticket(overrides: Partial<TicketInput> = {}): TicketInput {
  return {
    side: "BUY",
    kind: "MARKET",
    symbol: "XAUUSD",
    volumeText: "0.10",
    priceText: "",
    stopLossText: "",
    takeProfitText: "",
    levelMode: "price",
    defaultStopLossPoints: null,
    defaultTakeProfitPoints: null,
    quote: QUOTE,
    digits: 2,
    rules: { requireStopLoss: false, maxVolume: null },
    ...overrides,
  };
}

function plan(overrides: Partial<TicketInput> = {}): OrderPlan {
  const result = buildOrderPlan(ticket(overrides));
  if (!result.ok) throw new Error(`expected a plan, got: ${result.message}`);
  return result.plan;
}

function refusal(overrides: Partial<TicketInput> = {}): string {
  const result = buildOrderPlan(ticket(overrides));
  if (result.ok) throw new Error("expected a refusal");
  return result.message;
}

describe("digits, points and levels", () => {
  test("a point is the smallest price step of the symbol", () => {
    expect(pointSize(5)).toBeCloseTo(0.00001, 10);
    expect(pointSize(2)).toBe(0.01);
    expect(pointSize(0)).toBe(1);
    expect(pointSize(null)).toBeNull();
    expect(pointSize(undefined)).toBeNull();
    expect(pointSize(-1)).toBeNull();
    expect(pointSize(1.5)).toBeNull();
    expect(pointSize(11)).toBeNull();
  });

  test("digits: the broker's value wins, else the decimals of the live quote", () => {
    expect(resolveDigits(3, QUOTE)).toBe(3);
    expect(resolveDigits(null, { bid: 1.08123, ask: 1.08125 })).toBe(5);
    expect(resolveDigits(undefined, QUOTE)).toBe(1);
    expect(resolveDigits(null, { bid: 150, ask: 150.02 })).toBe(2);
    expect(resolveDigits(null, null)).toBeNull();
    expect(resolveDigits(null, { bid: 0, ask: 0 })).toBeNull();
  });

  test("a stop loss and a take profit lie on opposite sides, and swap for a sell", () => {
    expect(levelFromPoints("BUY", 2301.4, 200, 2, "STOP_LOSS")).toBe(2299.4);
    expect(levelFromPoints("BUY", 2301.4, 200, 2, "TAKE_PROFIT")).toBe(2303.4);
    expect(levelFromPoints("SELL", 2301.1, 200, 2, "STOP_LOSS")).toBe(2303.1);
    expect(levelFromPoints("SELL", 2301.1, 200, 2, "TAKE_PROFIT")).toBe(2299.1);
  });

  test("the level is rounded to the digits of the symbol", () => {
    expect(levelFromPoints("BUY", 1.08125, 150, 5, "STOP_LOSS")).toBe(1.07975);
    expect(levelFromPoints("SELL", 1.08123, 333, 5, "TAKE_PROFIT")).toBe(1.0779);
  });

  test("no digits, no distance or an impossible price -> null", () => {
    expect(levelFromPoints("BUY", 2301.4, 200, null, "STOP_LOSS")).toBeNull();
    expect(levelFromPoints("BUY", 2301.4, 0, 2, "STOP_LOSS")).toBeNull();
    expect(levelFromPoints("BUY", 2301.4, Number.NaN, 2, "STOP_LOSS")).toBeNull();
    expect(levelFromPoints("BUY", 1, 1_000_000, 2, "STOP_LOSS")).toBeNull();
    expect(levelFromPoints("BUY", 0, 10, 2, "STOP_LOSS")).toBeNull();
  });

  test("the distance between two prices in points", () => {
    expect(pointsBetween(2301.4, 2301.1, 2)).toBe(30);
    expect(pointsBetween(1.08125, 1.08123, 5)).toBe(2);
    expect(pointsBetween(1, 2, null)).toBeNull();
  });

  test("risk and reward: only with both levels on the right side", () => {
    const value = riskReward("BUY", 100, 99, 102);
    expect(value).toEqual({ risk: 1, reward: 2, ratio: 2 });
    expect(formatRatio(value)).toBe("1 : 2.0");
    expect(riskReward("SELL", 100, 101, 98)?.ratio).toBe(2);
    expect(riskReward("BUY", 100, 101, 102)).toBeNull();
    expect(riskReward("BUY", 100, 99, 98)).toBeNull();
    expect(riskReward("BUY", 100, null, 102)).toBeNull();
    expect(riskReward("BUY", null, 99, 102)).toBeNull();
    expect(formatRatio(null)).toBe("-");
    expect(formatRatio(riskReward("BUY", 100, 99, 112))).toBe("1 : 12");
  });
});

describe("volume", () => {
  test("the step grows with the size: 0.01, then 0.1 from one lot, then 1 from ten", () => {
    expect(lotStep(0.05)).toBe(0.01);
    expect(lotStep(1)).toBe(0.1);
    expect(lotStep(10)).toBe(1);
  });

  test("stepping up and down", () => {
    expect(stepLots(0.01, 1)).toBe(0.02);
    expect(stepLots(0.99, 1)).toBe(1);
    expect(stepLots(1, -1)).toBe(0.9);
    expect(stepLots(1, 1)).toBe(1.1);
    expect(stepLots(10, 1)).toBe(11);
    expect(stepLots(0.1, 1)).toBe(0.11);
  });

  test("never below 0.01 or above 100 lots", () => {
    expect(stepLots(0.01, -1)).toBe(0.01);
    expect(stepLots(100, 1)).toBe(100);
  });

  test("a share of a position is rounded down to a hundredth of a lot", () => {
    expect(partialLots(0.1, 0.5)).toBe(0.05);
    expect(partialLots(0.03, 0.5)).toBe(0.01);
    expect(partialLots(0.07, 0.5)).toBe(0.03);
    expect(partialLots(0.29, 0.25)).toBe(0.07);
    expect(partialLots(1, 0.25)).toBe(0.25);
    expect(partialLots(0.1, 1)).toBe(0.1);
  });

  test("a share that is less than 0.01 lot cannot be closed", () => {
    expect(partialLots(0.01, 0.5)).toBeNull();
    expect(partialLots(0, 0.5)).toBeNull();
    expect(partialLots(0.1, 0)).toBeNull();
  });
});

describe("buildOrderPlan - the order a ticket would send", () => {
  test("a market buy is measured from the ask, a sell from the bid", () => {
    expect(plan()).toEqual({
      side: "BUY",
      kind: "MARKET",
      symbol: "XAUUSD",
      volume: 0.1,
      price: null,
      stopLoss: null,
      takeProfit: null,
      entry: 2301.4,
    });
    expect(plan({ side: "SELL" }).entry).toBe(2301.1);
    expect(marketEntry("BUY", QUOTE)).toBe(2301.4);
    expect(marketEntry("SELL", QUOTE)).toBe(2301.1);
    expect(marketEntry("BUY", null)).toBeNull();
  });

  test("the symbol is the broker's spelling, the volume may use a comma", () => {
    expect(plan({ symbol: " EURUSD.m ", volumeText: "0,25" })).toMatchObject({ symbol: "EURUSD.m", volume: 0.25 });
  });

  test("a bad symbol is refused with a way out", () => {
    expect(refusal({ symbol: "" })).toMatch(/Choose a symbol/);
    expect(refusal({ symbol: "EUR USD" })).toMatch(/Choose a symbol/);
    expect(refusal({ symbol: "<script>" })).toMatch(/Choose a symbol/);
  });

  test("a bad volume is refused", () => {
    for (const volumeText of ["", "abc", "0", "-1", "101", "0.0005", "1.2345"]) {
      expect(refusal({ volumeText }), volumeText).toMatch(/between 0.001 and 100 lots/);
    }
  });

  test("stop loss and take profit typed as prices", () => {
    expect(plan({ stopLossText: "2290", takeProfitText: "2320" })).toMatchObject({ stopLoss: 2290, takeProfit: 2320 });
    expect(plan({ side: "SELL", stopLossText: "2310", takeProfitText: "2280.5" })).toMatchObject({
      stopLoss: 2310,
      takeProfit: 2280.5,
    });
    expect(plan({ stopLossText: "2290,5" }).stopLoss).toBe(2290.5);
  });

  test("a level on the wrong side of the entry is refused", () => {
    expect(refusal({ stopLossText: "2310" })).toMatch(/buy the stop loss must be below the entry price/);
    expect(refusal({ takeProfitText: "2300" })).toMatch(/buy the take profit must be above the entry price/);
    expect(refusal({ side: "SELL", stopLossText: "2290" })).toMatch(/sell the stop loss must be above the entry price/);
    expect(refusal({ side: "SELL", takeProfitText: "2310" })).toMatch(/sell the take profit must be below the entry price/);
  });

  test("without a price only the pair of levels can be checked", () => {
    expect(refusal({ quote: null, stopLossText: "2320", takeProfitText: "2290" })).toMatch(
      /stop loss must be below the take profit/,
    );
    const open = plan({ quote: null, stopLossText: "2290", takeProfitText: "2320" });
    expect(open).toMatchObject({ stopLoss: 2290, takeProfit: 2320, entry: null });
  });

  test("a level that is not a price is refused", () => {
    expect(refusal({ stopLossText: "abc" })).toMatch(/stop loss must be a price above zero/);
    expect(refusal({ takeProfitText: "0" })).toMatch(/take profit must be a price above zero/);
    expect(refusal({ takeProfitText: "-5" })).toMatch(/take profit must be a price above zero/);
  });

  test("levels typed as points are measured from the entry, in the direction of the side", () => {
    const buy = plan({ levelMode: "points", stopLossText: "200", takeProfitText: "400" });
    expect(buy).toMatchObject({ stopLoss: 2299.4, takeProfit: 2305.4 });
    const sell = plan({ side: "SELL", levelMode: "points", stopLossText: "200", takeProfitText: "400" });
    expect(sell).toMatchObject({ stopLoss: 2303.1, takeProfit: 2297.1 });
  });

  test("points need a price and the digits; a distance must be above zero", () => {
    expect(refusal({ levelMode: "points", stopLossText: "200", quote: null })).toMatch(/no live price/);
    expect(refusal({ levelMode: "points", stopLossText: "0" })).toMatch(/distance in points above zero/);
    expect(refusal({ levelMode: "points", takeProfitText: "x" })).toMatch(/distance in points above zero/);
  });

  test("without digits from the broker the quote's decimals are used", () => {
    // 2301.1 / 2301.4 have one decimal, so one point is 0.1
    expect(plan({ digits: null, levelMode: "points", stopLossText: "20" }).stopLoss).toBe(2299.4);
  });

  test("an empty box takes the default distance; a typed value wins", () => {
    expect(plan({ defaultStopLossPoints: 150, defaultTakeProfitPoints: 300 })).toMatchObject({
      stopLoss: 2299.9,
      takeProfit: 2304.4,
    });
    expect(plan({ defaultStopLossPoints: 150, stopLossText: "2295" }).stopLoss).toBe(2295);
    expect(plan({ side: "SELL", defaultStopLossPoints: 150 }).stopLoss).toBe(2302.6);
  });

  test("a default distance that cannot be turned into a price is said, not skipped", () => {
    expect(refusal({ defaultStopLossPoints: 150, quote: null })).toMatch(/default|no live price/);
  });

  test("rule: a stop loss is required (a default distance counts)", () => {
    const rules = { requireStopLoss: true, maxVolume: null };
    expect(refusal({ rules })).toMatch(/needs a stop loss/);
    expect(plan({ rules, stopLossText: "2290" }).stopLoss).toBe(2290);
    expect(plan({ rules, defaultStopLossPoints: 100 }).stopLoss).toBe(2300.4);
  });

  test("rule: the largest volume per order", () => {
    const rules = { requireStopLoss: false, maxVolume: 0.3 };
    expect(refusal({ rules, volumeText: "0.5" })).toMatch(/limit is 0.3 lots/);
    expect(plan({ rules, volumeText: "0.3" }).volume).toBe(0.3);
  });

  test("a pending order needs its price", () => {
    expect(refusal({ kind: "LIMIT", priceText: "" })).toMatch(/Enter the price/);
    expect(refusal({ kind: "STOP", priceText: "abc" })).toMatch(/Enter the price/);
    expect(refusal({ kind: "LIMIT", priceText: "0" })).toMatch(/Enter the price/);
  });

  test("a buy limit waits BELOW the ask, a buy stop ABOVE it", () => {
    expect(plan({ kind: "LIMIT", priceText: "2300" })).toMatchObject({ kind: "LIMIT", price: 2300, entry: 2300 });
    expect(plan({ kind: "STOP", priceText: "2305" })).toMatchObject({ kind: "STOP", price: 2305, entry: 2305 });
    expect(refusal({ kind: "LIMIT", priceText: "2305" })).toMatch(/Buy limit must be placed below the current ask \(2301.4\).*buy stop/);
    expect(refusal({ kind: "STOP", priceText: "2300" })).toMatch(/Buy stop must be placed above the current ask \(2301.4\).*buy limit/);
  });

  test("a sell limit waits ABOVE the bid, a sell stop BELOW it", () => {
    expect(plan({ side: "SELL", kind: "LIMIT", priceText: "2305" }).price).toBe(2305);
    expect(plan({ side: "SELL", kind: "STOP", priceText: "2295" }).price).toBe(2295);
    expect(refusal({ side: "SELL", kind: "STOP", priceText: "2305" })).toMatch(
      /Sell stop must be placed below the current bid \(2301.1\).*sell limit/,
    );
    expect(refusal({ side: "SELL", kind: "LIMIT", priceText: "2295" })).toMatch(/Sell limit must be placed above the current bid/);
  });

  test("without a price the broker decides which side of the market a pending order may sit on", () => {
    expect(plan({ quote: null, kind: "LIMIT", priceText: "2305" })).toMatchObject({ price: 2305, entry: 2305 });
  });

  test("levels of a pending order are measured from ITS price", () => {
    const limit = plan({ kind: "LIMIT", priceText: "2300", levelMode: "points", stopLossText: "100", takeProfitText: "300" });
    expect(limit).toMatchObject({ price: 2300, stopLoss: 2299, takeProfit: 2303 });
    expect(refusal({ kind: "LIMIT", priceText: "2300", stopLossText: "2301" })).toMatch(/stop loss must be below the entry price/);
  });

  test("describePlan and planToRequest", () => {
    const market = plan({ stopLossText: "2290", takeProfitText: "2320" });
    expect(describePlan(market)).toBe("Buy 0.1 XAUUSD · at market · SL 2290 · TP 2320");
    expect(planToRequest(market)).toEqual({
      symbol: "XAUUSD",
      side: "BUY",
      volume: 0.1,
      orderKind: "MARKET",
      price: null,
      stopLoss: 2290,
      takeProfit: 2320,
    });
    const limit = plan({ side: "SELL", kind: "LIMIT", priceText: "2305" });
    expect(describePlan(limit)).toBe("Sell 0.1 XAUUSD · limit at 2305");
    expect(planToRequest(limit)).toMatchObject({ orderKind: "LIMIT", price: 2305, side: "SELL" });
  });
});

describe("break-even", () => {
  test("a buy with the stop below the entry (or none) can be moved to the entry", () => {
    expect(breakEvenLevel({ side: "BUY", openPrice: 100, stopLoss: 99 })).toBe(100);
    expect(breakEvenLevel({ side: "BUY", openPrice: 100, stopLoss: null })).toBe(100);
  });

  test("a stop that already protects the entry is never pulled back", () => {
    expect(breakEvenLevel({ side: "BUY", openPrice: 100, stopLoss: 100 })).toBeNull();
    expect(breakEvenLevel({ side: "BUY", openPrice: 100, stopLoss: 101 })).toBeNull();
  });

  test("the same for a sell, the other way round", () => {
    expect(breakEvenLevel({ side: "SELL", openPrice: 100, stopLoss: 101 })).toBe(100);
    expect(breakEvenLevel({ side: "SELL", openPrice: 100, stopLoss: null })).toBe(100);
    expect(breakEvenLevel({ side: "SELL", openPrice: 100, stopLoss: 100 })).toBeNull();
    expect(breakEvenLevel({ side: "SELL", openPrice: 100, stopLoss: 99 })).toBeNull();
  });

  test("no entry price, no break-even", () => {
    expect(breakEvenLevel({ side: "BUY", openPrice: 0, stopLoss: null })).toBeNull();
  });
});

function position(overrides: Partial<WebTradePosition> = {}): WebTradePosition {
  return {
    ticket: "1",
    symbol: "XAUUSD",
    side: "BUY",
    volume: 0.1,
    openPrice: 2300,
    stopLoss: null,
    takeProfit: null,
    profit: 0,
    swap: 0,
    commission: 0,
    openedAt: null,
    comment: null,
    ...overrides,
  };
}

function pendingOrder(overrides: Partial<WebTradePendingOrder> = {}): WebTradePendingOrder {
  return {
    ticket: "11",
    symbol: "XAUUSD",
    side: "BUY",
    kind: "LIMIT",
    volume: 0.1,
    price: 2290,
    stopLoss: null,
    takeProfit: null,
    placedAt: null,
    comment: null,
    ...overrides,
  };
}

describe("close several at once", () => {
  const positions = [
    position({ ticket: "1", symbol: "XAUUSD", side: "BUY", profit: 50 }),
    position({ ticket: "2", symbol: "EURUSD", side: "SELL", profit: -20 }),
    position({ ticket: "3", symbol: "xauusd", side: "SELL", profit: 0 }),
    position({ ticket: "4", symbol: "GBPUSD", side: "BUY", profit: -1 }),
  ];
  const pending = [
    pendingOrder({ ticket: "11", symbol: "XAUUSD" }),
    pendingOrder({ ticket: "12", symbol: "EURUSD", side: "SELL", kind: "STOP" }),
  ];

  test("the number the person confirms is the number the trading system closes", () => {
    for (const scope of WEB_TRADE_BULK_SCOPES) {
      for (const symbol of [null, "XAUUSD", "eurusd"]) {
        const preview = bulkPreview(scope, symbol, positions, pending);
        const real = bulkTargets({ positions, pending }, scope, symbol);
        expect(preview.positions.map((entry) => entry.ticket), `${scope} ${symbol}`).toEqual(
          real.positions.map((entry) => entry.ticket),
        );
        expect(preview.pending.map((entry) => entry.ticket), `${scope} ${symbol}`).toEqual(
          real.pending.map((entry) => entry.ticket),
        );
      }
    }
  });

  test("what each scope picks", () => {
    const tickets = (scope: Parameters<typeof bulkPreview>[0], symbol: string | null = null) =>
      bulkPreview(scope, symbol, positions, pending).positions.map((entry) => entry.ticket);
    expect(tickets("ALL")).toEqual(["1", "2", "3", "4"]);
    expect(tickets("PROFIT")).toEqual(["1"]);
    expect(tickets("LOSS")).toEqual(["2", "4"]);
    expect(tickets("BUY")).toEqual(["1", "4"]);
    expect(tickets("SELL")).toEqual(["2", "3"]);
    expect(tickets("SYMBOL", "XAUUSD")).toEqual(["1", "3"]);
    expect(bulkPreview("PENDING", null, positions, pending).pending.map((entry) => entry.ticket)).toEqual(["11", "12"]);
    expect(bulkPreview("PENDING", "EURUSD", positions, pending).pending.map((entry) => entry.ticket)).toEqual(["12"]);
  });

  test("the count of a bulk command in words", () => {
    expect(bulkQuestion("ALL", null, 3)).toBe("Close 3 positions?");
    expect(bulkQuestion("PROFIT", null, 1)).toBe("Close 1 winning position?");
    expect(bulkQuestion("LOSS", null, 2)).toBe("Close 2 losing positions?");
    expect(bulkQuestion("BUY", null, 2)).toBe("Close 2 buy positions?");
    expect(bulkQuestion("SYMBOL", "XAUUSD", 2)).toBe("Close 2 XAUUSD positions?");
    expect(bulkQuestion("PENDING", null, 2)).toBe("Delete 2 pending orders?");
    expect(bulkQuestion("PENDING", "EURUSD", 1)).toBe("Delete 1 pending order of EURUSD?");
  });
});

describe("how long it took", () => {
  test("durations", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(183.4)).toBe("183 ms");
    expect(formatDuration(1250)).toBe("1.25 s");
    expect(formatDuration(12_340)).toBe("12.3 s");
    expect(formatDuration(-1)).toBe("-");
    expect(formatDuration(Number.NaN)).toBe("-");
  });

  test("the timing line of a result", () => {
    expect(timingText({ queueMs: 120, runMs: 63 })).toBe("183 ms (queue 120 ms · broker 63 ms)");
    expect(timingText(null)).toBe("");
    expect(timingText(undefined)).toBe("");
  });
});
