import { describe, expect, test, vi } from "vitest";
import {
  BrokerExecutionError,
  type BrokerAdapter,
  type BrokerTradingState,
  type ExecutionStages,
} from "@/lib/broker/BrokerAdapter";
import { parseTradeCommand, TradeCommandError, type CommandTiming } from "@/lib/gateway/tradeCommands";
import {
  BULK_CONCURRENCY,
  bulkTargets,
  describeCommandError,
  executeTradeCommand,
  MAX_BULK_ITEMS,
  readGatewayState,
  type ExecuteContext,
} from "@/lib/gateway/tradeExecutor";
import { WEB_TRADE_COMMENT } from "@/lib/trade/webTrade";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

function position(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "5001",
    symbol: "XAUUSD",
    side: "BUY" as "BUY" | "SELL",
    volume: 0.5,
    openPrice: 2390,
    stopLoss: 2380 as number | null,
    takeProfit: 2410 as number | null,
    profit: 12.5,
    swap: 0,
    commission: -1,
    openedAt: "2026-10-12T10:00:00.000Z",
    comment: null,
    ...overrides,
  };
}

function pendingOrder(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "6001",
    symbol: "EURUSD.r",
    side: "BUY" as "BUY" | "SELL",
    kind: "LIMIT" as const,
    volume: 0.2,
    price: 1.08,
    stopLoss: 1.07 as number | null,
    takeProfit: 1.1 as number | null,
    placedAt: "2026-10-12T10:00:00.000Z",
    comment: null,
    ...overrides,
  };
}

function tradingState(overrides: Partial<BrokerTradingState> = {}): BrokerTradingState {
  return {
    currency: "USD",
    balance: 10_000,
    equity: 10_012.5,
    floatingProfit: 12.5,
    margin: 200,
    freeMargin: 9812.5,
    marginLevel: 5006,
    positions: [position()],
    pending: [pendingOrder()],
    pendingOrders: 1,
    fetchedAt: "2026-10-12T10:05:00.000Z",
    ...overrides,
  };
}

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    executionAvailable: vi.fn(() => true),
    fetchTradingState: vi.fn(async () => tradingState()),
    fetchQuote: vi.fn(async (_account: string, symbol: string) => ({ symbol, bid: 2400.1, ask: 2400.4 })),
    fetchSymbolList: vi.fn(async () => [{ name: "XAUUSD", description: "Gold", path: null, digits: 2 }]),
    openTrade: vi.fn(async () => ({ ok: true, brokerPositionId: "9001", brokerOrderId: "9000" })),
    closeTrade: vi.fn(async () => ({ ok: true })),
    modifyTrade: vi.fn(async () => ({ ok: true })),
    cancelOrder: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function run(adapter: ReturnType<typeof makeAdapter>, kind: string, payload: unknown) {
  return executeTradeCommand(adapter as unknown as BrokerAdapter, ACCOUNT, parseTradeCommand(kind, payload));
}

function runWith(adapter: ReturnType<typeof makeAdapter>, kind: string, payload: unknown, context: ExecuteContext) {
  return executeTradeCommand(adapter as unknown as BrokerAdapter, ACCOUNT, parseTradeCommand(kind, payload), context);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function failure(task: Promise<unknown>): Promise<TradeCommandError | BrokerExecutionError> {
  try {
    await task;
  } catch (error) {
    return error as TradeCommandError;
  }
  throw new Error("it did not fail");
}

describe("OPEN", () => {
  test("sends the order as WSA Trade and answers with the position id", async () => {
    const adapter = makeAdapter();
    const outcome = await run(adapter, "OPEN", { symbol: "EURUSD.r", side: "SELL", volume: 0.25, stopLoss: 1.12, takeProfit: 1.08 });

    expect(adapter.openTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      symbol: "EURUSD.r",
      side: "SELL",
      volume: 0.25,
      orderKind: "MARKET",
      price: null,
      stopLoss: 1.12,
      takeProfit: 1.08,
      comment: WEB_TRADE_COMMENT,
      stages: expect.any(Object),
    });
    expect(outcome.ticket).toBe("9001");
    expect(outcome.detail).toMatchObject({ symbol: "EURUSD.r" });
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
  });

  test("a pending order carries its price", async () => {
    const adapter = makeAdapter();
    await run(adapter, "OPEN", { symbol: "EURUSD", side: "BUY", volume: 0.1, orderKind: "LIMIT", price: 1.08 });

    expect(adapter.openTrade).toHaveBeenCalledWith(expect.objectContaining({ orderKind: "LIMIT", price: 1.08 }));
  });

  test("the broker's note travels with the answer", async () => {
    const adapter = makeAdapter({ openTrade: vi.fn(async () => ({ ok: true, brokerOrderId: "9", note: "Only part of the volume was executed." })) });
    const outcome = await run(adapter, "OPEN", { symbol: "EURUSD", side: "BUY", volume: 1 });

    expect(outcome.ticket).toBe("9");
    expect(outcome.note).toBe("Only part of the volume was executed.");
  });

  test("with the execution switch off nothing is sent", async () => {
    const adapter = makeAdapter({ executionAvailable: vi.fn(() => false) });
    const error = await failure(run(adapter, "OPEN", { symbol: "EURUSD", side: "BUY", volume: 0.1 }));

    expect(error).toMatchObject({ code: "EXECUTION_DISABLED", statusCode: 503 });
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });
});

describe("CLOSE", () => {
  test("closes without reading the account first (the broker answers 'no such order' itself)", async () => {
    const adapter = makeAdapter();
    const outcome = await run(adapter, "CLOSE", { ticket: "5001" });

    expect(adapter.closeTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "5001",
      volume: null,
      comment: WEB_TRADE_COMMENT,
      stages: expect.any(Object),
    });
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
    expect(outcome.ticket).toBe("5001");
  });

  test("a partial close passes the volume", async () => {
    const adapter = makeAdapter();
    await run(adapter, "CLOSE", { ticket: "5001", volume: 0.2 });

    expect(adapter.closeTrade).toHaveBeenCalledWith(expect.objectContaining({ volume: 0.2 }));
  });

  test("a refusal of the broker comes back as it is", async () => {
    const adapter = makeAdapter({
      closeTrade: vi.fn(async () => {
        throw new BrokerExecutionError("BROKER_PROVIDER_ERROR", "That order does not exist any more.", 502);
      }),
    });
    const error = await failure(run(adapter, "CLOSE", { ticket: "4242" }));

    expect(describeCommandError(error)).toEqual({
      code: "BROKER_PROVIDER_ERROR",
      message: "That order does not exist any more.",
      statusCode: 502,
    });
  });
});

describe("MODIFY a position", () => {
  test("changing only the take profit keeps the stop loss and reports the resulting levels", async () => {
    const adapter = makeAdapter();
    const outcome = await run(adapter, "MODIFY", { ticket: "5001", takeProfit: 2420 });

    expect(adapter.modifyTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "5001",
      stopLoss: 2380,
      takeProfit: 2420,
      stages: expect.any(Object),
    });
    expect(outcome.detail).toMatchObject({ symbol: "XAUUSD", stopLoss: 2380, takeProfit: 2420 });
  });

  test("null removes a level (the broker reads 0 as none)", async () => {
    const adapter = makeAdapter();
    const outcome = await run(adapter, "MODIFY", { ticket: "5001", stopLoss: null });

    expect(adapter.modifyTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "5001",
      stopLoss: 0,
      takeProfit: 2410,
      stages: expect.any(Object),
    });
    expect(outcome.detail).toMatchObject({ stopLoss: null, takeProfit: 2410 });
  });

  test("the same values again are 'no change'", async () => {
    const adapter = makeAdapter();
    const error = await failure(run(adapter, "MODIFY", { ticket: "5001", stopLoss: 2380, takeProfit: 2410 }));

    expect(error).toMatchObject({ code: "NO_CHANGE", statusCode: 400 });
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("a stop loss above the take profit of a buy is refused; a sell has the opposite rule", async () => {
    const buy = makeAdapter();
    const refused = await failure(run(buy, "MODIFY", { ticket: "5001", stopLoss: 2430 }));
    expect(refused).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(refused.message).toContain("stop loss must be below the take profit");

    const sell = makeAdapter({
      fetchTradingState: vi.fn(async () => tradingState({ positions: [position({ side: "SELL", stopLoss: 2420, takeProfit: 2380 })] })),
    });
    expect(await failure(run(sell, "MODIFY", { ticket: "5001", takeProfit: 2430 }))).toMatchObject({ code: "VALIDATION_ERROR" });
    await run(sell, "MODIFY", { ticket: "5001", takeProfit: 2370 });
    expect(sell.modifyTrade).toHaveBeenCalledTimes(1);
  });

  test("an entry price belongs to a pending order only", async () => {
    const adapter = makeAdapter();
    const error = await failure(run(adapter, "MODIFY", { ticket: "5001", price: 2395 }));

    expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("a ticket that is not there is a 404", async () => {
    const adapter = makeAdapter();
    const error = await failure(run(adapter, "MODIFY", { ticket: "7777", takeProfit: 2420 }));

    expect(error).toMatchObject({ code: "POSITION_NOT_FOUND", statusCode: 404 });
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });
});

describe("MODIFY a pending order", () => {
  test("moves the entry price and keeps the levels it was not asked to change", async () => {
    const adapter = makeAdapter();
    const outcome = await run(adapter, "MODIFY", { ticket: "6001", price: 1.075 });

    expect(adapter.modifyTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "6001",
      price: 1.075,
      stopLoss: 1.07,
      takeProfit: 1.1,
      stages: expect.any(Object),
    });
    expect(outcome.detail).toMatchObject({ symbol: "EURUSD.r", price: 1.075 });
  });

  test("the levels must still sit on the right side of the (new) entry", async () => {
    const adapter = makeAdapter();
    const error = await failure(run(adapter, "MODIFY", { ticket: "6001", price: 1.065 }));

    expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(error.message).toContain("stop loss must be below the entry price");
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("the same values again are 'no change'", async () => {
    const adapter = makeAdapter();
    const error = await failure(run(adapter, "MODIFY", { ticket: "6001", price: 1.08 }));

    expect(error).toMatchObject({ code: "NO_CHANGE" });
  });
});

describe("CANCEL", () => {
  test("deletes a pending order", async () => {
    const adapter = makeAdapter();
    const outcome = await run(adapter, "CANCEL", { ticket: "6001" });

    expect(adapter.cancelOrder).toHaveBeenCalledWith({ accountId: ACCOUNT, brokerOrderId: "6001", stages: expect.any(Object) });
    expect(outcome).toMatchObject({ ticket: "6001", detail: { symbol: "EURUSD.r" } });
  });

  test("never closes a real position: an open ticket is refused", async () => {
    const adapter = makeAdapter();
    const error = await failure(run(adapter, "CANCEL", { ticket: "5001" }));

    expect(error).toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    expect(error.message).toContain("close it instead");
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
    expect(adapter.closeTrade).not.toHaveBeenCalled();
  });

  test("an order that is gone is a 404; a bridge that cannot delete orders says so", async () => {
    const adapter = makeAdapter();
    expect(await failure(run(adapter, "CANCEL", { ticket: "123" }))).toMatchObject({ code: "POSITION_NOT_FOUND", statusCode: 404 });

    const limited = makeAdapter({ cancelOrder: undefined });
    expect(await failure(run(limited, "CANCEL", { ticket: "6001" }))).toMatchObject({ code: "NOT_SUPPORTED", statusCode: 501 });
  });
});

describe("bulk targets", () => {
  const state = {
    positions: [
      position({ ticket: "1", symbol: "XAUUSD", side: "BUY", profit: 50 }),
      position({ ticket: "2", symbol: "EURUSD", side: "SELL", profit: -20 }),
      position({ ticket: "3", symbol: "eurusd", side: "BUY", profit: -5 }),
      position({ ticket: "4", symbol: "XAUUSD", side: "SELL", profit: 0 }),
    ],
    pending: [pendingOrder({ ticket: "10", symbol: "EURUSD" }), pendingOrder({ ticket: "11", symbol: "XAUUSD" })],
  };
  const tickets = (scope: Parameters<typeof bulkTargets>[1], symbol: string | null = null) => {
    const targets = bulkTargets(state, scope, symbol);
    return { positions: targets.positions.map((entry) => entry.ticket), pending: targets.pending.map((entry) => entry.ticket) };
  };

  test("each scope picks what its name says", () => {
    expect(tickets("ALL")).toEqual({ positions: ["1", "2", "3", "4"], pending: [] });
    expect(tickets("PROFIT")).toEqual({ positions: ["1"], pending: [] });
    expect(tickets("LOSS")).toEqual({ positions: ["2", "3"], pending: [] });
    expect(tickets("BUY")).toEqual({ positions: ["1", "3"], pending: [] });
    expect(tickets("SELL")).toEqual({ positions: ["2", "4"], pending: [] });
    expect(tickets("SYMBOL", "EURUSD")).toEqual({ positions: ["2", "3"], pending: [] });
    expect(tickets("PENDING")).toEqual({ positions: [], pending: ["10", "11"] });
    expect(tickets("PENDING", "XAUUSD")).toEqual({ positions: [], pending: ["11"] });
  });
});

describe("CLOSE_BULK", () => {
  test("closes what the scope selects and counts the failures with their reasons", async () => {
    const adapter = makeAdapter({
      fetchTradingState: vi.fn(async () =>
        tradingState({
          positions: [position({ ticket: "1" }), position({ ticket: "2", symbol: "EURUSD" }), position({ ticket: "3" })],
          pending: [],
        }),
      ),
      closeTrade: vi.fn(async (request: { brokerPositionId: string }) => {
        if (request.brokerPositionId === "2") throw new BrokerExecutionError("BROKER_PROVIDER_ERROR", "Market is closed.", 502);
        return { ok: true };
      }),
    });
    const outcome = await run(adapter, "CLOSE_BULK", { scope: "ALL" });

    expect(adapter.closeTrade).toHaveBeenCalledTimes(3);
    expect(outcome.closed).toBe(2);
    expect(outcome.failed).toBe(1);
    expect(outcome.failures).toEqual([{ ticket: "2", symbol: "EURUSD", message: "Market is closed." }]);
  });

  test("the pending scope deletes orders and never touches positions", async () => {
    const adapter = makeAdapter();
    const outcome = await run(adapter, "CLOSE_BULK", { scope: "PENDING" });

    expect(adapter.cancelOrder).toHaveBeenCalledWith({ accountId: ACCOUNT, brokerOrderId: "6001" });
    expect(adapter.closeTrade).not.toHaveBeenCalled();
    expect(outcome.closed).toBe(1);
  });

  test("nothing to close is an answer, not an error", async () => {
    const adapter = makeAdapter({ fetchTradingState: vi.fn(async () => tradingState({ positions: [], pending: [] })) });
    const outcome = await run(adapter, "CLOSE_BULK", { scope: "LOSS" });

    expect(outcome).toMatchObject({ closed: 0, failed: 0, note: "There was nothing to close." });
    expect(adapter.closeTrade).not.toHaveBeenCalled();
  });

  test("never more than a few orders at a time, and never more than the cap", async () => {
    const many = Array.from({ length: MAX_BULK_ITEMS + 5 }, (_, index) => position({ ticket: String(index + 1) }));
    let running = 0;
    let peak = 0;
    const adapter = makeAdapter({
      fetchTradingState: vi.fn(async () => tradingState({ positions: many, pending: [] })),
      closeTrade: vi.fn(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return { ok: true };
      }),
    });
    const outcome = await run(adapter, "CLOSE_BULK", { scope: "ALL" });

    expect(peak).toBeLessThanOrEqual(BULK_CONCURRENCY);
    expect(adapter.closeTrade).toHaveBeenCalledTimes(MAX_BULK_ITEMS);
    expect(outcome.closed).toBe(MAX_BULK_ITEMS);
    expect(outcome.note).toContain("run it again for the other 5");
  });

  test("with the execution switch off nothing is read or sent", async () => {
    const adapter = makeAdapter({ executionAvailable: vi.fn(() => false) });
    const error = await failure(run(adapter, "CLOSE_BULK", { scope: "ALL" }));

    expect(error).toMatchObject({ code: "EXECUTION_DISABLED" });
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
  });
});

describe("reads", () => {
  test("STATE: the figures plus the price of each watched symbol", async () => {
    const adapter = makeAdapter();
    const outcome = await run(adapter, "STATE", { symbols: ["XAUUSD", "EURUSD"] });

    expect(outcome.state).toMatchObject({ balance: 10_000, positions: [{ ticket: "5001" }], pending: [{ ticket: "6001" }] });
    expect(outcome.state?.quotes).toMatchObject({ XAUUSD: { bid: 2400.1, ask: 2400.4 }, EURUSD: { bid: 2400.1, ask: 2400.4 } });
    expect(adapter.executionAvailable).not.toHaveBeenCalled();
  });

  test("a price that cannot be read is just missing; so is a nonsense price", async () => {
    const adapter = makeAdapter({
      fetchQuote: vi.fn(async (_account: string, symbol: string) => {
        if (symbol === "BAD") throw new Error("no quote endpoint");
        if (symbol === "ZERO") return { symbol, bid: 0, ask: 0 };
        return { symbol, bid: 1, ask: 1.0001 };
      }),
    });
    const state = await readGatewayState(adapter as unknown as BrokerAdapter, ACCOUNT, ["BAD", "ZERO", "OK"]);

    expect(Object.keys(state.quotes)).toEqual(["OK"]);
  });

  test("SYMBOLS: the broker's list; an adapter without one gives an empty list", async () => {
    expect((await run(makeAdapter(), "SYMBOLS", {})).symbols).toEqual([{ name: "XAUUSD", description: "Gold", path: null, digits: 2 }]);
    expect((await run(makeAdapter({ fetchSymbolList: undefined }), "SYMBOLS", {})).symbols).toEqual([]);
  });

  test("an adapter that cannot read positions is NOT_SUPPORTED", async () => {
    const adapter = makeAdapter({ fetchTradingState: undefined });
    expect(await failure(run(adapter, "STATE", { symbols: [] }))).toMatchObject({ code: "NOT_SUPPORTED", statusCode: 501 });
  });
});

describe("speed: the recent picture", () => {
  test("a modify takes the current levels from it and reads nothing", async () => {
    const adapter = makeAdapter();
    const outcome = await runWith(adapter, "MODIFY", { ticket: "5001", takeProfit: 2420 }, { recentState: tradingState() });

    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
    expect(adapter.modifyTrade).toHaveBeenCalledWith(
      expect.objectContaining({ brokerPositionId: "5001", stopLoss: 2380, takeProfit: 2420 }),
    );
    expect(outcome.detail).toMatchObject({ symbol: "XAUUSD", stopLoss: 2380, takeProfit: 2420 });
  });

  test("a pending order is modified from it as well", async () => {
    const adapter = makeAdapter();
    await runWith(adapter, "MODIFY", { ticket: "6001", price: 1.075 }, { recentState: tradingState() });

    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
    expect(adapter.modifyTrade).toHaveBeenCalledWith(
      expect.objectContaining({ brokerPositionId: "6001", price: 1.075, stopLoss: 1.07, takeProfit: 1.1 }),
    );
  });

  test("a ticket it does not list is looked up with a fresh read before the command gives up", async () => {
    const adapter = makeAdapter();
    const outcome = await runWith(
      adapter,
      "MODIFY",
      { ticket: "5001", takeProfit: 2420 },
      { recentState: tradingState({ positions: [], pending: [] }) },
    );

    expect(adapter.fetchTradingState).toHaveBeenCalledTimes(1);
    expect(outcome.ticket).toBe("5001");
  });

  test("a ticket that is nowhere is still a 404 - after the fresh read", async () => {
    const adapter = makeAdapter();
    const error = await failure(runWith(adapter, "MODIFY", { ticket: "7777", takeProfit: 2420 }, { recentState: tradingState() }));

    expect(error).toMatchObject({ code: "POSITION_NOT_FOUND", statusCode: 404 });
    expect(adapter.fetchTradingState).toHaveBeenCalledTimes(1);
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("a delete and a close-several always read the account fresh", async () => {
    const adapter = makeAdapter();
    await runWith(adapter, "CANCEL", { ticket: "6001" }, { recentState: tradingState() });
    expect(adapter.fetchTradingState).toHaveBeenCalledTimes(1);

    const bulk = makeAdapter();
    await runWith(bulk, "CLOSE_BULK", { scope: "PENDING" }, { recentState: tradingState({ pending: [] }) });
    expect(bulk.fetchTradingState).toHaveBeenCalledTimes(1);
    expect(bulk.cancelOrder).toHaveBeenCalledWith({ accountId: ACCOUNT, brokerOrderId: "6001" });
  });

  test("a close and an order never read anything, with or without a picture", async () => {
    const adapter = makeAdapter();
    await runWith(adapter, "CLOSE", { ticket: "5001" }, { recentState: tradingState() });
    await runWith(adapter, "OPEN", { symbol: "EURUSD", side: "BUY", volume: 0.1 }, { recentState: tradingState() });

    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
  });
});

describe("speed: where the time went", () => {
  test("a modify that has to read notes the read, and what the broker call measured", async () => {
    const adapter = makeAdapter({
      fetchTradingState: vi.fn(async () => {
        await wait(30);
        return tradingState();
      }),
      modifyTrade: vi.fn(async (request: { stages?: ExecutionStages }) => {
        if (request.stages) Object.assign(request.stages, { sessionMs: 12, sendMs: 210, attempts: 2 });
        return { ok: true };
      }),
    });
    const timing: Partial<CommandTiming> = {};
    await runWith(adapter, "MODIFY", { ticket: "5001", takeProfit: 2420 }, { timing });

    expect(timing.readMs).toBeGreaterThanOrEqual(15);
    expect(timing).toMatchObject({ sessionMs: 12, sendMs: 210, attempts: 2 });
  });

  test("with a recent picture there is no read to report", async () => {
    const adapter = makeAdapter();
    const timing: Partial<CommandTiming> = {};
    await runWith(adapter, "MODIFY", { ticket: "5001", takeProfit: 2420 }, { recentState: tradingState(), timing });

    expect(timing.readMs).toBeUndefined();
  });

  test("an order that fails still reports what was measured before it failed", async () => {
    const adapter = makeAdapter({
      openTrade: vi.fn(async (request: { stages?: ExecutionStages }) => {
        if (request.stages) Object.assign(request.stages, { sessionMs: 0, sendMs: 95, attempts: 1 });
        throw new BrokerExecutionError("BROKER_PROVIDER_ERROR", "Not enough money.", 502);
      }),
    });
    const timing: Partial<CommandTiming> = {};
    const error = await failure(runWith(adapter, "OPEN", { symbol: "EURUSD", side: "BUY", volume: 5 }, { timing }));

    expect(error).toMatchObject({ code: "BROKER_PROVIDER_ERROR" });
    expect(timing).toMatchObject({ sessionMs: 0, sendMs: 95, attempts: 1 });
  });

  test("the price the broker filled at travels with the answer", async () => {
    const adapter = makeAdapter({
      openTrade: vi.fn(async () => ({ ok: true, brokerPositionId: "9001", executedPrice: 1.08123, executedVolume: 0.2 })),
    });
    const outcome = await run(adapter, "OPEN", { symbol: "EURUSD", side: "BUY", volume: 0.25 });

    expect(outcome.detail).toMatchObject({ symbol: "EURUSD", fillPrice: 1.08123, volume: 0.2 });
  });

  test("a nonsense fill price is left out", async () => {
    const adapter = makeAdapter({
      openTrade: vi.fn(async () => ({ ok: true, brokerPositionId: "9001", executedPrice: 0 })),
    });
    const outcome = await run(adapter, "OPEN", { symbol: "EURUSD", side: "BUY", volume: 0.25 });

    expect(outcome.detail).not.toHaveProperty("fillPrice");
  });

  test("without a context everything still works and nothing is timed", async () => {
    const adapter = makeAdapter();
    const outcome = await run(adapter, "MODIFY", { ticket: "5001", takeProfit: 2420 });

    expect(adapter.fetchTradingState).toHaveBeenCalledTimes(1);
    expect(outcome.ticket).toBe("5001");
  });
});

describe("describeCommandError", () => {
  test("our own errors keep their code, sentence and status", () => {
    expect(describeCommandError(new TradeCommandError("NO_CHANGE", "Nothing to do.", 400))).toEqual({
      code: "NO_CHANGE",
      message: "Nothing to do.",
      statusCode: 400,
    });
  });

  test("an unknown failure is cleaned of credentials and provider names", () => {
    const stored = describeCommandError(new Error("Api2Trade responded with login=12345678 password=hunter2"));

    expect(stored.code).toBe("BROKER_ERROR");
    expect(stored.statusCode).toBe(502);
    expect(stored.message).not.toMatch(/hunter2|12345678|api2trade/i);
  });
});
