import { describe, expect, test } from "vitest";
import {
  isTradeCommandKind,
  MAX_WATCHED_SYMBOLS,
  ORDER_COMMAND_KINDS,
  parseTradeCommand,
  TradeCommandError,
} from "@/lib/gateway/tradeCommands";

function problem(kind: unknown, payload: unknown): string {
  try {
    parseTradeCommand(kind, payload);
  } catch (error) {
    expect(error).toBeInstanceOf(TradeCommandError);
    expect((error as TradeCommandError).code).toBe("INVALID_COMMAND");
    return (error as TradeCommandError).message;
  }
  throw new Error("the command was accepted");
}

describe("which commands exist", () => {
  test("seven kinds; five of them change something at the broker", () => {
    for (const kind of ["OPEN", "CLOSE", "MODIFY", "CANCEL", "CLOSE_BULK", "STATE", "SYMBOLS"]) {
      expect(isTradeCommandKind(kind)).toBe(true);
    }
    expect(isTradeCommandKind("DROP")).toBe(false);
    expect(isTradeCommandKind(5)).toBe(false);
    expect([...ORDER_COMMAND_KINDS].sort()).toEqual(["CANCEL", "CLOSE", "CLOSE_BULK", "MODIFY", "OPEN"]);
  });

  test("an unknown kind is refused", () => {
    expect(problem("DROP", {})).toBe("Unknown command.");
    expect(problem(undefined, {})).toBe("Unknown command.");
  });
});

describe("OPEN", () => {
  const market = { symbol: "EURUSD.r", side: "BUY", volume: 0.1 };

  test("a market order keeps the broker's own spelling and needs no price", () => {
    expect(parseTradeCommand("OPEN", { ...market, stopLoss: 1.07, takeProfit: 1.09 })).toEqual({
      kind: "OPEN",
      payload: {
        symbol: "EURUSD.r",
        side: "BUY",
        volume: 0.1,
        orderKind: "MARKET",
        price: null,
        stopLoss: 1.07,
        takeProfit: 1.09,
      },
    });
  });

  test("a pending order needs its price, and its stops must sit on the right side of it", () => {
    expect(problem("OPEN", { ...market, orderKind: "LIMIT" })).toBe("Price must be a price above zero.");
    expect(problem("OPEN", { ...market, orderKind: "STOP", price: 1.1, stopLoss: 1.12 })).toBe(
      "For a buy the stop loss must be below the entry price.",
    );
    expect(problem("OPEN", { ...market, side: "SELL", orderKind: "LIMIT", price: 1.1, takeProfit: 1.12 })).toBe(
      "For a sell the take profit must be below the entry price.",
    );
    const ok = parseTradeCommand("OPEN", { ...market, orderKind: "LIMIT", price: 1.08, stopLoss: 1.07, takeProfit: 1.1 });
    expect(ok.kind === "OPEN" && ok.payload).toMatchObject({ orderKind: "LIMIT", price: 1.08 });
  });

  test("a price on a market order is ignored", () => {
    const parsed = parseTradeCommand("OPEN", { ...market, price: 1.5 });
    expect(parsed.kind === "OPEN" && parsed.payload.price).toBeNull();
  });

  test.each([
    ["a side that does not exist", { ...market, side: "HOLD" }, "Direction must be buy or sell."],
    ["no volume", { ...market, volume: 0 }, "Volume is not valid."],
    ["too many decimals", { ...market, volume: 0.1234 }, "Volume is not valid."],
    ["an order type that does not exist", { ...market, orderKind: "OCO" }, "Order type is not valid."],
    ["a symbol with spaces", { ...market, symbol: "EUR USD" }, "Symbol is not valid."],
    ["a negative stop loss", { ...market, stopLoss: -1 }, "Stop loss must be a price above zero."],
  ])("refuses %s", (_name, payload, message) => {
    expect(problem("OPEN", payload)).toBe(message);
  });
});

describe("CLOSE / MODIFY / CANCEL", () => {
  test("close: a ticket, and a volume only when it is partial", () => {
    expect(parseTradeCommand("CLOSE", { ticket: "5001" })).toEqual({ kind: "CLOSE", payload: { ticket: "5001", volume: null } });
    expect(parseTradeCommand("CLOSE", { ticket: 5001, volume: 0.25 })).toEqual({
      kind: "CLOSE",
      payload: { ticket: "5001", volume: 0.25 },
    });
    expect(problem("CLOSE", { ticket: "50a1" })).toBe("Position is not valid.");
    expect(problem("CLOSE", { ticket: "5001", volume: 0 })).toBe("Volume is not valid.");
  });

  test("modify: a missing key leaves a level alone, null removes it", () => {
    expect(parseTradeCommand("MODIFY", { ticket: "7", takeProfit: 2420 })).toEqual({
      kind: "MODIFY",
      payload: { ticket: "7", takeProfit: 2420 },
    });
    expect(parseTradeCommand("MODIFY", { ticket: "7", stopLoss: null })).toEqual({
      kind: "MODIFY",
      payload: { ticket: "7", stopLoss: null },
    });
    expect(parseTradeCommand("MODIFY", { ticket: "7", price: 1.2 })).toEqual({
      kind: "MODIFY",
      payload: { ticket: "7", price: 1.2 },
    });
    expect(problem("MODIFY", { ticket: "7" })).toBe("Nothing to change.");
    expect(problem("MODIFY", { ticket: "7", stopLoss: 0 })).toBe("Stop loss must be a price above zero.");
  });

  test("cancel: just a ticket", () => {
    expect(parseTradeCommand("CANCEL", { ticket: "88" })).toEqual({ kind: "CANCEL", payload: { ticket: "88" } });
    expect(problem("CANCEL", {})).toBe("Position is not valid.");
  });
});

describe("CLOSE_BULK / STATE / SYMBOLS", () => {
  test("bulk: a scope, and a symbol when the scope is one symbol", () => {
    expect(parseTradeCommand("CLOSE_BULK", { scope: "LOSS" })).toEqual({ kind: "CLOSE_BULK", payload: { scope: "LOSS", symbol: null } });
    expect(parseTradeCommand("CLOSE_BULK", { scope: "SYMBOL", symbol: "XAUUSD" })).toEqual({
      kind: "CLOSE_BULK",
      payload: { scope: "SYMBOL", symbol: "XAUUSD" },
    });
    expect(problem("CLOSE_BULK", { scope: "SYMBOL" })).toBe("Choose the symbol to close.");
    expect(problem("CLOSE_BULK", { scope: "EVERYTHING" })).toBe("Choose what to close.");
  });

  test("state: a short list of valid, different symbols", () => {
    const parsed = parseTradeCommand("STATE", {
      symbols: ["EURUSD", "EURUSD", "bad symbol", 5, "XAUUSD", "A1", "B2", "C3", "D4"],
    });
    expect(parsed.kind === "STATE" && parsed.payload.symbols).toEqual(["EURUSD", "XAUUSD", "A1", "B2", "C3"]);
    expect(MAX_WATCHED_SYMBOLS).toBe(5);
    expect(parseTradeCommand("STATE", undefined)).toEqual({ kind: "STATE", payload: { symbols: [] } });
  });

  test("symbols: no payload", () => {
    expect(parseTradeCommand("SYMBOLS", { anything: 1 })).toEqual({ kind: "SYMBOLS", payload: {} });
  });
});
