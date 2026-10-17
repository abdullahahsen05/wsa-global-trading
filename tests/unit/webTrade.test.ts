import { describe, expect, test } from "vitest";
import {
  WEB_TRADE_MAX_LOTS,
  WEB_TRADE_MIN_LOTS,
  isValidLots,
  levelsProblem,
  normalizeTradeSymbol,
  remainingLots,
  resolveModifyLevels,
  roundLots,
  sideLabel,
} from "@/lib/trade/webTrade";
import {
  issuesText,
  webTradeCloseSchema,
  webTradeModifySchema,
  webTradeOpenSchema,
  webTradeStateQuerySchema,
} from "@/lib/trade/webTradeSchemas";
import {
  formatLots,
  formatMoney,
  formatPercent,
  formatPrice,
  formatSigned,
  parseDecimal,
  parseLevelInput,
  resultTone,
} from "@/lib/trade/webTradeFormat";
import { WebTradeGuard } from "@/lib/trade/webTradeGuard";
import {
  classifyOrderType,
  mapOpenPositions,
  orderVolumeLots,
  pendingKindOf,
  positionTicket,
  scaleRawVolume,
} from "@/lib/broker/openPositions";
import { parseQuote, QUOTE_ENDPOINTS } from "@/lib/broker/quote";

const ACCOUNT = "3f2b8c1e-5d4a-4e7b-9c2d-1a2b3c4d5e6f";
const REQUEST = "req-0123456789";

function open(overrides: Record<string, unknown> = {}) {
  return { accountId: ACCOUNT, symbol: "XAUUSD", side: "BUY", volume: 0.1, clientRequestId: REQUEST, ...overrides };
}

describe("symbols and lots", () => {
  test("a broker symbol keeps its own spelling; anything that is not a symbol is refused", () => {
    expect(normalizeTradeSymbol(" EURUSD.m ")).toBe("EURUSD.m");
    expect(normalizeTradeSymbol("XAUUSD#")).toBe("XAUUSD#");
    expect(normalizeTradeSymbol("US30.cash")).toBe("US30.cash");
    expect(normalizeTradeSymbol("btcusd")).toBe("btcusd");
    for (const bad of ["", " ", "EUR USD", "EURUSD;", "<script>", "A".repeat(33), ".EURUSD", 5, null, undefined]) {
      expect(normalizeTradeSymbol(bad)).toBeNull();
    }
  });

  test("lots: thousandths between the minimum and the maximum", () => {
    expect(WEB_TRADE_MIN_LOTS).toBe(0.001);
    expect(WEB_TRADE_MAX_LOTS).toBe(100);
    for (const good of [0.001, 0.01, 0.1, 0.35, 1, 12.5, 100]) expect(isValidLots(good)).toBe(true);
    for (const bad of [0, -1, 0.0001, 0.0015, 100.001, Number.NaN, Number.POSITIVE_INFINITY, "0.1", null]) {
      expect(isValidLots(bad)).toBe(false);
    }
    expect(roundLots(0.1 + 0.2)).toBe(0.3);
    expect(roundLots(1.23456)).toBe(1.235);
  });

  test("what is left after a partial close", () => {
    expect(remainingLots(1, 0.3)).toBe(0.7);
    expect(remainingLots(0.1, 0.1)).toBe(0);
    expect(remainingLots(0.1, undefined)).toBe(0);
    expect(remainingLots(0.1, 5)).toBe(0);
  });

  test("direction labels", () => {
    expect(sideLabel("BUY")).toBe("Buy");
    expect(sideLabel("SELL")).toBe("Sell");
  });
});

describe("stop loss / take profit", () => {
  test("a long needs the stop below the target, a short above it; one level alone is never a contradiction", () => {
    expect(levelsProblem("BUY", 2290, 2320)).toBeNull();
    expect(levelsProblem("BUY", 2320, 2290)).toMatch(/below the take profit/);
    expect(levelsProblem("BUY", 2300, 2300)).not.toBeNull();
    expect(levelsProblem("SELL", 2320, 2290)).toBeNull();
    expect(levelsProblem("SELL", 2290, 2320)).toMatch(/above the take profit/);
    expect(levelsProblem("BUY", 2290, null)).toBeNull();
    expect(levelsProblem("SELL", null, 2290)).toBeNull();
    expect(levelsProblem("SELL", undefined, undefined)).toBeNull();
  });

  test("a modification sends both levels: untouched ones keep their value, removed ones become 0", () => {
    const current = { stopLoss: 2290, takeProfit: null };
    expect(resolveModifyLevels(current, { takeProfit: 2320 })).toEqual({ stopLoss: 2290, takeProfit: 2320 });
    expect(resolveModifyLevels(current, { stopLoss: null })).toEqual({ stopLoss: 0, takeProfit: 0 });
    expect(resolveModifyLevels(current, { stopLoss: 2295, takeProfit: null })).toEqual({ stopLoss: 2295, takeProfit: 0 });
    expect(resolveModifyLevels(current, {})).toEqual({ stopLoss: 2290, takeProfit: 0 });
  });
});

describe("request schemas", () => {
  test("a valid order is accepted, levels are optional", () => {
    const parsed = webTradeOpenSchema.parse(open({ stopLoss: 2290, takeProfit: 2320 }));
    expect(parsed).toMatchObject({ symbol: "XAUUSD", side: "BUY", volume: 0.1, stopLoss: 2290, takeProfit: 2320 });
    expect(webTradeOpenSchema.safeParse(open()).success).toBe(true);
    expect(webTradeOpenSchema.safeParse(open({ stopLoss: null, takeProfit: null })).success).toBe(true);
  });

  test("an order is refused for a bad account, side, symbol, volume, level or request id", () => {
    const bad: Array<Record<string, unknown>> = [
      { accountId: "x" },
      { side: "HOLD" },
      { side: "buy" },
      { symbol: "EUR USD" },
      { volume: 0 },
      { volume: -1 },
      { volume: 0.0001 },
      { volume: 101 },
      { volume: "0.1" },
      { volume: null },
      { stopLoss: 0 },
      { stopLoss: -5 },
      { takeProfit: "2300" },
      { clientRequestId: "short" },
      { clientRequestId: "has spaces in it!" },
      { clientRequestId: undefined },
    ];
    for (const override of bad) expect(webTradeOpenSchema.safeParse(open(override)).success).toBe(false);
    expect(webTradeOpenSchema.safeParse(null).success).toBe(false);
    expect(webTradeOpenSchema.safeParse("order").success).toBe(false);
  });

  test("contradicting levels are refused with a message that says what is wrong", () => {
    const result = webTradeOpenSchema.safeParse(open({ side: "BUY", stopLoss: 2320, takeProfit: 2290 }));
    expect(result.success).toBe(false);
    if (!result.success) expect(issuesText(result.error)).toMatch(/stop loss must be below/);
    expect(webTradeOpenSchema.safeParse(open({ side: "SELL", stopLoss: 2290, takeProfit: 2320 })).success).toBe(false);
    expect(webTradeOpenSchema.safeParse(open({ side: "SELL", stopLoss: 2320, takeProfit: 2290 })).success).toBe(true);
  });

  test("modify: null removes a level, a missing key leaves it, nothing at all is refused; the ticket is digits", () => {
    expect(webTradeModifySchema.parse({ accountId: ACCOUNT, ticket: 9001, stopLoss: 2290 })).toEqual({
      accountId: ACCOUNT,
      ticket: "9001",
      stopLoss: 2290,
    });
    expect(webTradeModifySchema.parse({ accountId: ACCOUNT, ticket: "9001", takeProfit: null })).toMatchObject({
      takeProfit: null,
    });
    expect(webTradeModifySchema.safeParse({ accountId: ACCOUNT, ticket: "9001" }).success).toBe(false);
    expect(webTradeModifySchema.safeParse({ accountId: ACCOUNT, ticket: "90 01", stopLoss: 1 }).success).toBe(false);
    expect(webTradeModifySchema.safeParse({ accountId: ACCOUNT, ticket: "abc", stopLoss: 1 }).success).toBe(false);
    expect(webTradeModifySchema.safeParse({ accountId: ACCOUNT, ticket: "9001", stopLoss: 0 }).success).toBe(false);
  });

  test("close: the whole position, or a number of lots", () => {
    expect(webTradeCloseSchema.parse({ accountId: ACCOUNT, ticket: "9001" })).toEqual({ accountId: ACCOUNT, ticket: "9001" });
    expect(webTradeCloseSchema.parse({ accountId: ACCOUNT, ticket: "9001", volume: 0.05 }).volume).toBe(0.05);
    expect(webTradeCloseSchema.safeParse({ accountId: ACCOUNT, ticket: "9001", volume: 0 }).success).toBe(false);
    expect(webTradeCloseSchema.safeParse({ accountId: ACCOUNT, ticket: "9001", volume: 0.0001 }).success).toBe(false);
    expect(webTradeCloseSchema.safeParse({ ticket: "9001" }).success).toBe(false);
  });

  test("state query: an account, optionally a symbol", () => {
    expect(webTradeStateQuerySchema.safeParse({ accountId: ACCOUNT }).success).toBe(true);
    expect(webTradeStateQuerySchema.safeParse({ accountId: ACCOUNT, symbol: "EURUSD.m" }).success).toBe(true);
    expect(webTradeStateQuerySchema.safeParse({ accountId: ACCOUNT, symbol: "EUR USD" }).success).toBe(false);
    expect(webTradeStateQuerySchema.safeParse({}).success).toBe(false);
  });

  test("the text of several problems has no duplicates", () => {
    const result = webTradeOpenSchema.safeParse(open({ volume: 0, symbol: "EUR USD" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const text = issuesText(result.error);
      expect(text).toMatch(/Volume must be at least/);
      expect(text).toMatch(/Symbol is not valid/);
    }
  });
});

describe("what you type in the ticket", () => {
  test("decimals with a point or a comma", () => {
    expect(parseDecimal("1.25")).toBe(1.25);
    expect(parseDecimal(" 1,25 ")).toBe(1.25);
    expect(parseDecimal(".5")).toBe(0.5);
    expect(parseDecimal("2")).toBe(2);
    // spaces are thousands separators, not part of the number
    expect(parseDecimal("1 234,5")).toBe(1234.5);
    for (const bad of ["", "abc", "1.2.3", "1e5", "--1", "0x10", "1,2,3"]) expect(parseDecimal(bad)).toBeNull();
  });

  test("a level field: empty is none, a positive price is a level, anything else is invalid", () => {
    expect(parseLevelInput("")).toBeNull();
    expect(parseLevelInput("  ")).toBeNull();
    expect(parseLevelInput("2290.5")).toBe(2290.5);
    expect(parseLevelInput("0")).toBe("invalid");
    expect(parseLevelInput("-3")).toBe("invalid");
    expect(parseLevelInput("abc")).toBe("invalid");
  });

  test("numbers are shown the way a terminal shows them", () => {
    expect(formatPrice(2301.5)).toBe("2301.5");
    expect(formatPrice(1.08123)).toBe("1.08123");
    expect(formatPrice(null)).toBe("-");
    expect(formatPrice(Number.NaN)).toBe("-");
    expect(formatLots(0.1)).toBe("0.1");
    expect(formatLots(1)).toBe("1");
    expect(formatLots(0.123456)).toBe("0.123");
    expect(formatSigned(12.345)).toBe("+12.35");
    expect(formatSigned(-5)).toBe("-5.00");
    expect(formatSigned(0)).toBe("0.00");
    expect(formatMoney(10050, "USD")).toBe("10,050.00 USD");
    expect(formatMoney(undefined, "USD")).toBe("-");
    expect(formatPercent(5025.5)).toBe("5,025.5%");
    expect(formatPercent(null)).toBe("-");
    expect(resultTone(3)).toBe("gain");
    expect(resultTone(-3)).toBe("loss");
    expect(resultTone(0)).toBe("flat");
  });
});

describe("open positions out of the broker's answer", () => {
  const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

  test("order types: numbers and words, market and pending", () => {
    expect(classifyOrderType(0)).toEqual({ side: "BUY", pending: false });
    expect(classifyOrderType("1")).toEqual({ side: "SELL", pending: false });
    expect(classifyOrderType("Buy")).toEqual({ side: "BUY", pending: false });
    expect(classifyOrderType("SELL")).toEqual({ side: "SELL", pending: false });
    expect(classifyOrderType("ORDER_TYPE_BUY")).toEqual({ side: "BUY", pending: false });
    expect(classifyOrderType(2)).toEqual({ side: "BUY", pending: true });
    expect(classifyOrderType(3)).toEqual({ side: "SELL", pending: true });
    expect(classifyOrderType(4)).toEqual({ side: "BUY", pending: true });
    expect(classifyOrderType(5)).toEqual({ side: "SELL", pending: true });
    expect(classifyOrderType(7)).toEqual({ side: "SELL", pending: true });
    expect(classifyOrderType("BuyLimit")).toEqual({ side: "BUY", pending: true });
    expect(classifyOrderType("Sell Stop")).toEqual({ side: "SELL", pending: true });
    expect(classifyOrderType("sell_limit")).toEqual({ side: "SELL", pending: true });
    // balance / credit rows and unknown values are not trades
    expect(classifyOrderType(8)).toEqual({ side: null, pending: false });
    expect(classifyOrderType("Balance")).toEqual({ side: null, pending: false });
    expect(classifyOrderType(undefined)).toEqual({ side: null, pending: false });
  });

  test("the id close / modify use: position id first, then ticket", () => {
    expect(positionTicket({ positionId: 77, ticket: 5 })).toBe("77");
    expect(positionTicket({ ticket: 5 })).toBe("5");
    expect(positionTicket({ positionId: 0, ticket: "0", orderId: 9 })).toBe("9");
    expect(positionTicket({ id: " 12 " })).toBe("12");
    expect(positionTicket({})).toBeNull();
  });

  test("lots: `lots` wins, integer volumes are scaled down", () => {
    expect(orderVolumeLots({ lots: 0.1 })).toBe(0.1);
    expect(orderVolumeLots({ volume: 0.25 })).toBe(0.25);
    expect(orderVolumeLots({ volume: 10_000_000 })).toBe(0.1);
    expect(orderVolumeLots({ lots: 150 })).toBe(150);
    expect(orderVolumeLots({})).toBe(0);
  });

  test("lots: a size without `lots` is read by its magnitude, the same everywhere on the platform", () => {
    // already lots
    expect(scaleRawVolume(0.01)).toBe(0.01);
    expect(scaleRawVolume(2.5)).toBe(2.5);
    expect(scaleRawVolume(99)).toBe(99);
    // 1 lot = 10 000
    expect(scaleRawVolume(100)).toBe(0.01);
    expect(scaleRawVolume(10_000)).toBe(1);
    expect(scaleRawVolume(25_000)).toBe(2.5);
    // 1 lot = 100 000 000 (MT5 extended volume)
    expect(scaleRawVolume(1_000_000)).toBe(0.01);
    expect(scaleRawVolume(100_000_000)).toBe(1);
    expect(scaleRawVolume(0)).toBe(0);
    expect(scaleRawVolume(-5)).toBe(0);
    expect(scaleRawVolume(Number.NaN)).toBe(0);

    expect(orderVolumeLots({ volume: 10_000 })).toBe(1);
    expect(orderVolumeLots({ volume: "100000000" })).toBe(1);
    // a `lots` of 0 does not hide a real volume
    expect(orderVolumeLots({ lots: 0, volume: 0.5 })).toBe(0.5);
    expect(orderVolumeLots({ closeLots: 0.3 })).toBe(0.3);
  });

  test("pending orders: what they wait for", () => {
    expect(pendingKindOf(2)).toBe("LIMIT");
    expect(pendingKindOf(3)).toBe("LIMIT");
    expect(pendingKindOf("4")).toBe("STOP");
    expect(pendingKindOf(5)).toBe("STOP");
    expect(pendingKindOf(6)).toBe("STOP_LIMIT");
    expect(pendingKindOf(7)).toBe("STOP_LIMIT");
    expect(pendingKindOf("BuyLimit")).toBe("LIMIT");
    expect(pendingKindOf("Sell Stop")).toBe("STOP");
    expect(pendingKindOf("ORDER_TYPE_BUY_STOP_LIMIT")).toBe("STOP_LIMIT");
    // market orders and rows that are no orders wait for nothing
    expect(pendingKindOf(0)).toBeNull();
    expect(pendingKindOf("Sell")).toBeNull();
    expect(pendingKindOf("Balance")).toBeNull();
    expect(pendingKindOf(undefined)).toBeNull();
  });

  test("positions are mapped, pending orders are counted, junk rows are dropped, newest first", () => {
    const orders = [
      {
        ticket: 1001,
        symbol: "EURUSD",
        type: "Buy",
        lots: 0.5,
        openPrice: 1.0812,
        stopLoss: 1.075,
        takeProfit: 0,
        profit: 12.5,
        commission: -2,
        swap: -0.5,
        openTimestampUTC: Date.UTC(2026, 9, 12, 8, 0, 0) / 1000,
        comment: "WSA Trade",
      },
      {
        ticket: 1002,
        positionId: 2002,
        symbol: " XAUUSD ",
        type: 1,
        volume: 0.1,
        openPrice: "2300.5",
        stopLoss: "2320",
        takeProfit: "2250",
        profit: -4,
        openTimestampUTC: Date.UTC(2026, 9, 12, 10, 0, 0),
      },
      { ticket: 1003, symbol: "GBPUSD", type: "BuyLimit", lots: 1, openPrice: 1.2 },
      { ticket: 1004, symbol: "", type: 0, lots: 1 },
      { ticket: 1005, symbol: "USDJPY", type: 0, lots: 0 },
      { symbol: "USDJPY", type: 0, lots: 1 },
      { ticket: 1006, symbol: "BALANCE", type: "Balance", profit: 1000 },
    ];
    const { positions, pending, pendingOrders } = mapOpenPositions(orders, { now: NOW });

    expect(pendingOrders).toBe(1);
    expect(pending.map((order) => `${order.ticket}:${order.side}:${order.kind}:${order.price}`)).toEqual(["1003:BUY:LIMIT:1.2"]);
    expect(positions.map((position) => position.ticket)).toEqual(["2002", "1001"]);

    const gold = positions[0];
    expect(gold).toMatchObject({
      symbol: "XAUUSD",
      side: "SELL",
      volume: 0.1,
      openPrice: 2300.5,
      stopLoss: 2320,
      takeProfit: 2250,
      profit: -4,
      openedAt: "2026-10-12T10:00:00.000Z",
      comment: null,
    });

    const euro = positions[1];
    // profit + commission + swap, a level of 0 is "not set"
    expect(euro).toMatchObject({ side: "BUY", volume: 0.5, stopLoss: 1.075, takeProfit: null, profit: 10, swap: -0.5, commission: -2 });
    expect(euro.openedAt).toBe("2026-10-12T08:00:00.000Z");
    expect(euro.comment).toBe("WSA Trade");
  });

  test("pending orders are listed with what they wait for, newest first; incomplete ones are only counted", () => {
    const { positions, pending, pendingOrders } = mapOpenPositions(
      [
        { ticket: 31, symbol: "EURUSD.r", type: 3, lots: 0.2, openPrice: 1.12, stopLoss: 1.13, takeProfit: 1.1, openTimestampUTC: Date.UTC(2026, 9, 12, 9, 0, 0) / 1000, comment: "ladder" },
        { ticket: 32, symbol: "XAUUSDm", type: "BuyStop", volume: 0.05, openPrice: 2350, openTimestampUTC: Date.UTC(2026, 9, 12, 11, 0, 0) / 1000 },
        { ticket: 33, symbol: "GBPUSD", type: 5, lots: 1, openPrice: 0 },
        { ticket: 34, symbol: "", type: 2, lots: 1, openPrice: 1.1 },
        { symbol: "USDJPY", type: 4, lots: 1, openPrice: 150 },
      ],
      { now: NOW },
    );

    expect(positions).toEqual([]);
    expect(pendingOrders).toBe(5);
    expect(pending.map((order) => order.ticket)).toEqual(["32", "31"]);
    expect(pending[0]).toMatchObject({ symbol: "XAUUSDm", side: "BUY", kind: "STOP", volume: 0.05, price: 2350, stopLoss: null, takeProfit: null });
    expect(pending[1]).toMatchObject({ side: "SELL", kind: "LIMIT", price: 1.12, stopLoss: 1.13, takeProfit: 1.1, comment: "ladder", placedAt: "2026-10-12T09:00:00.000Z" });
  });

  test("server-time text is converted with the offset the same answer reveals", () => {
    const { positions } = mapOpenPositions(
      [
        {
          ticket: 1,
          symbol: "EURUSD",
          type: 0,
          lots: 1,
          openTime: "2026-10-12T11:00:00",
          openTimestampUTC: Date.UTC(2026, 9, 12, 8, 0, 0) / 1000,
        },
        { ticket: 2, symbol: "EURUSD", type: 0, lots: 1, openTime: "2026-10-12T12:30:00" },
      ],
      { now: Date.UTC(2026, 9, 12, 12, 0, 0) },
    );
    // UTC+3 server: 11:00 server time is 08:00 UTC, so 12:30 is 09:30 UTC
    expect(positions.find((position) => position.ticket === "2")?.openedAt).toBe("2026-10-12T09:30:00.000Z");
  });

  test("an empty or malformed answer gives nothing", () => {
    expect(mapOpenPositions([])).toEqual({ positions: [], pending: [], pendingOrders: 0 });
    expect(mapOpenPositions([{}, { type: "Buy" }])).toEqual({ positions: [], pending: [], pendingOrders: 0 });
  });
});

describe("price quotes out of the bridge's answer", () => {
  test("the usual shapes", () => {
    expect(parseQuote({ bid: 2301.1, ask: 2301.4 }, "XAUUSD")).toEqual({ bid: 2301.1, ask: 2301.4 });
    expect(parseQuote({ Bid: 1.0801, Ask: 1.0803, Symbol: "EURUSD" }, "EURUSD")).toEqual({ bid: 1.0801, ask: 1.0803 });
    expect(parseQuote({ bid: "1.0801", ask: "1.0803" }, "EURUSD")).toEqual({ bid: 1.0801, ask: 1.0803 });
    expect(parseQuote([{ symbol: "GBPUSD", bid: 1.2, ask: 1.2001 }, { symbol: "eurusd", bid: 1.08, ask: 1.0801 }], "EURUSD")).toEqual({
      bid: 1.08,
      ask: 1.0801,
    });
    // one entry in the array: it is the answer for the symbol that was asked
    expect(parseQuote([{ bid: 5, ask: 6 }], "XAUUSD")).toEqual({ bid: 5, ask: 6 });
  });

  test("nothing usable gives null, never a guessed price", () => {
    expect(parseQuote(null, "EURUSD")).toBeNull();
    expect(parseQuote("OK", "EURUSD")).toBeNull();
    expect(parseQuote({}, "EURUSD")).toBeNull();
    expect(parseQuote({ bid: 0, ask: 0 }, "EURUSD")).toBeNull();
    expect(parseQuote({ bid: 1.1 }, "EURUSD")).toBeNull();
    expect(parseQuote({ bid: 1.2, ask: 1.1 }, "EURUSD")).toBeNull();
    expect(parseQuote([{ symbol: "GBPUSD", bid: 1.2, ask: 1.21 }, { symbol: "USDJPY", bid: 150, ask: 150.1 }], "EURUSD")).toBeNull();
    expect(parseQuote([], "EURUSD")).toBeNull();
  });

  test("a short list of endpoints is tried", () => {
    expect(QUOTE_ENDPOINTS.length).toBeGreaterThan(2);
    expect(new Set(QUOTE_ENDPOINTS).size).toBe(QUOTE_ENDPOINTS.length);
  });
});

describe("repeat protection and the ceiling per minute", () => {
  function guard(overrides: Partial<ConstructorParameters<typeof WebTradeGuard>[0]> = {}) {
    const clock = { now: 1_000_000 };
    const instance = new WebTradeGuard<{ ok: true }>(
      { windowMs: 60_000, maxPerWindow: 3, rememberMs: 5 * 60_000, maxRemembered: 3, ...overrides },
      () => clock.now,
    );
    return { instance, clock };
  }

  test("a handled request id is answered from memory, for that user only, for a while", () => {
    const { instance, clock } = guard();
    expect(instance.recall("u1", "r1")).toBeUndefined();
    instance.remember("u1", "r1", { ok: true });
    expect(instance.recall("u1", "r1")).toEqual({ ok: true });
    expect(instance.recall("u2", "r1")).toBeUndefined();
    clock.now += 5 * 60_000 + 1;
    expect(instance.recall("u1", "r1")).toBeUndefined();
  });

  test("the memory is capped, oldest first", () => {
    const { instance } = guard();
    for (const id of ["a", "b", "c", "d"]) instance.remember("u", id, { ok: true });
    expect(instance.recall("u", "a")).toBeUndefined();
    expect(instance.recall("u", "d")).toEqual({ ok: true });
  });

  test("one request id is in flight once", () => {
    const { instance } = guard();
    expect(instance.begin("u", "r")).toBe(true);
    expect(instance.begin("u", "r")).toBe(false);
    expect(instance.begin("other", "r")).toBe(true);
    instance.end("u", "r");
    expect(instance.begin("u", "r")).toBe(true);
  });

  test("a user gets a fixed number of orders per window; the window moves on", () => {
    const { instance, clock } = guard();
    expect([instance.allow("u"), instance.allow("u"), instance.allow("u")]).toEqual([true, true, true]);
    expect(instance.allow("u")).toBe(false);
    expect(instance.allow("someone-else")).toBe(true);
    clock.now += 60_001;
    expect(instance.allow("u")).toBe(true);
  });
});
