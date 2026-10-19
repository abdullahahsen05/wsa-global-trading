import { describe, expect, test } from "vitest";
import {
  OVERLAY_TTL_MS,
  applyChanges,
  changesFromBulk,
  changesFromClose,
  changesFromModify,
  changesFromOpen,
  type StateChange,
} from "@/lib/trade/stateOverlay";
import type { WebTradeOrderResult, WebTradePendingOrder, WebTradePosition, WebTradeState } from "@/lib/trade/webTrade";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

function position(ticket: string, overrides: Partial<WebTradePosition> = {}): WebTradePosition {
  return {
    ticket,
    symbol: "XAUUSD",
    side: "BUY",
    volume: 0.1,
    openPrice: 2300.5,
    stopLoss: 2290,
    takeProfit: null,
    profit: 50,
    swap: -2,
    commission: -1,
    openedAt: "2026-10-12T09:00:00.000Z",
    comment: null,
    ...overrides,
  };
}

function pending(ticket: string, overrides: Partial<WebTradePendingOrder> = {}): WebTradePendingOrder {
  return {
    ticket,
    symbol: "EURUSD.m",
    side: "BUY",
    kind: "LIMIT",
    volume: 0.2,
    price: 1.08,
    stopLoss: 1.07,
    takeProfit: null,
    placedAt: "2026-10-12T09:10:00.000Z",
    comment: null,
    ...overrides,
  };
}

function stateOf(positions: WebTradePosition[], orders: WebTradePendingOrder[] = [], accountId = A): WebTradeState {
  return {
    accountId,
    currency: "USD",
    balance: 10000,
    equity: 10050,
    floatingProfit: 50,
    margin: 200,
    freeMargin: 9850,
    marginLevel: 5025,
    positions,
    pending: orders,
    pendingOrders: orders.length,
    quote: null,
    readOnly: false,
    riskBlocked: false,
    riskMessage: null,
    fetchedAt: "2026-10-12T09:30:00.000Z",
    route: "gateway",
    delayed: false,
  };
}

const result = (overrides: Partial<WebTradeOrderResult> = {}): WebTradeOrderResult => ({ ok: true, ticket: "9500", ...overrides });

describe("what the panel lays over the last picture of the account", () => {
  test("it lasts a few seconds - long enough for the next real pictures to arrive", () => {
    expect(OVERLAY_TTL_MS).toBe(6000);
  });

  test("with nothing to apply - or only changes of another account - the very same picture comes back", () => {
    const state = stateOf([position("9001")]);
    expect(applyChanges(state, [])).toBe(state);
    expect(applyChanges(state, [{ kind: "closed", accountId: B, ticket: "9001" }])).toBe(state);
  });

  test("a closed position leaves the list; a ticket that is not there changes nothing", () => {
    const state = stateOf([position("9001"), position("9002")]);

    const closed = applyChanges(state, [{ kind: "closed", accountId: A, ticket: "9001" }]);
    expect(closed.positions.map((entry) => entry.ticket)).toEqual(["9002"]);
    // the picture it was laid over is not touched
    expect(state.positions).toHaveLength(2);

    expect(applyChanges(state, [{ kind: "closed", accountId: A, ticket: "7777" }])).toBe(state);
  });

  test("a part-close leaves a smaller position and its money in proportion", () => {
    const state = stateOf([position("9001", { volume: 0.1, profit: 50, swap: -2, commission: -1 })]);

    const reduced = applyChanges(state, [{ kind: "reduced", accountId: A, ticket: "9001", volume: 0.06 }]).positions[0];

    expect(reduced.volume).toBe(0.06);
    expect(reduced.profit).toBeCloseTo(30, 10);
    expect(reduced.swap).toBeCloseTo(-1.2, 10);
    expect(reduced.commission).toBeCloseTo(-0.6, 10);
  });

  test("a part-close never makes a position larger, and an unknown ticket is left alone", () => {
    const state = stateOf([position("9001", { volume: 0.1 })]);

    expect(applyChanges(state, [{ kind: "reduced", accountId: A, ticket: "9001", volume: 0.1 }]).positions[0].volume).toBe(0.1);
    expect(applyChanges(state, [{ kind: "reduced", accountId: A, ticket: "9001", volume: 0.5 }]).positions[0].volume).toBe(0.1);
    expect(applyChanges(state, [{ kind: "reduced", accountId: A, ticket: "7777", volume: 0.01 }]).positions).toEqual(state.positions);
  });

  test("a deleted pending order leaves the list and the count follows - never below zero", () => {
    const state = stateOf([], [pending("9101"), pending("9102")]);

    const one = applyChanges(state, [{ kind: "removed", accountId: A, ticket: "9101" }]);
    expect(one.pending.map((entry) => entry.ticket)).toEqual(["9102"]);
    expect(one.pendingOrders).toBe(1);

    // the broker listed more than could be read: the count comes down by what was removed
    const bigger = { ...state, pendingOrders: 5 };
    expect(applyChanges(bigger, [{ kind: "removed", accountId: A, ticket: "9101" }]).pendingOrders).toBe(4);

    const none = applyChanges(stateOf([], [pending("9101")]), [
      { kind: "removed", accountId: A, ticket: "9101" },
      { kind: "removed", accountId: A, ticket: "9101" },
    ]);
    expect(none.pendingOrders).toBe(0);
    expect(applyChanges(state, [{ kind: "removed", accountId: A, ticket: "7777" }])).toBe(state);
  });

  test("new levels replace the old ones; a level that is not mentioned stays, null removes it", () => {
    const state = stateOf([position("9001", { stopLoss: 2290, takeProfit: 2320 })]);

    const moved = applyChanges(state, [{ kind: "levels", accountId: A, ticket: "9001", stopLoss: 2295 }]).positions[0];
    expect(moved).toMatchObject({ stopLoss: 2295, takeProfit: 2320 });

    const removed = applyChanges(state, [{ kind: "levels", accountId: A, ticket: "9001", takeProfit: null }]).positions[0];
    expect(removed).toMatchObject({ stopLoss: 2290, takeProfit: null });
  });

  test("new levels and a new price of a pending order", () => {
    const state = stateOf([], [pending("9101", { price: 1.08, stopLoss: 1.07, takeProfit: null })]);

    const changed = applyChanges(state, [{ kind: "levels", accountId: A, ticket: "9101", price: 1.079, takeProfit: 1.09 }]).pending[0];

    expect(changed).toMatchObject({ price: 1.079, stopLoss: 1.07, takeProfit: 1.09 });
  });

  test("a new position is listed first - once, even if the real picture has it already", () => {
    const state = stateOf([position("9001")]);
    const opened: StateChange = { kind: "opened", accountId: A, position: position("9500", { volume: 0.01 }) };

    const after = applyChanges(state, [opened]);
    expect(after.positions.map((entry) => entry.ticket)).toEqual(["9500", "9001"]);

    const alreadyThere = stateOf([position("9500"), position("9001")]);
    expect(applyChanges(alreadyThere, [opened])).toBe(alreadyThere);
  });

  test("a new pending order is listed first and counted - once", () => {
    const state = stateOf([], [pending("9101")]);
    const placed: StateChange = { kind: "placed", accountId: A, order: pending("9600", { symbol: "XAUUSD", kind: "STOP" }) };

    const after = applyChanges(state, [placed]);
    expect(after.pending.map((entry) => entry.ticket)).toEqual(["9600", "9101"]);
    expect(after.pendingOrders).toBe(2);

    expect(applyChanges(after, [placed]).pendingOrders).toBe(2);
  });

  test("changes are applied in the order they happened", () => {
    const state = stateOf([position("9001")]);

    const after = applyChanges(state, [
      { kind: "opened", accountId: A, position: position("9500") },
      { kind: "levels", accountId: A, ticket: "9500", stopLoss: 2299 },
      { kind: "closed", accountId: A, ticket: "9001" },
    ]);

    expect(after.positions).toHaveLength(1);
    expect(after.positions[0]).toMatchObject({ ticket: "9500", stopLoss: 2299 });
  });

  test("it never invents money: balance, equity and margin stay as the real picture says", () => {
    const state = stateOf([position("9001")]);

    const after = applyChanges(state, [{ kind: "closed", accountId: A, ticket: "9001" }]);

    expect(after.balance).toBe(10000);
    expect(after.equity).toBe(10050);
    expect(after.floatingProfit).toBe(50);
    expect(after.margin).toBe(200);
    expect(after.freeMargin).toBe(9850);
  });
});

describe("from the answer of an order to the changes it means", () => {
  const request = {
    symbol: "XAUUSD",
    side: "BUY" as const,
    volume: 0.01,
    orderKind: "MARKET" as const,
    price: null,
    stopLoss: 2290 as number | null,
    takeProfit: 2320 as number | null,
  };
  const quote = { bid: 2301.1, ask: 2301.4 };

  test("a market order becomes a position at the price the broker filled it at", () => {
    const [change] = changesFromOpen(A, result({ detail: { fillPrice: 2301.6, volume: 0.01 } }), request, quote);

    expect(change).toMatchObject({
      kind: "opened",
      accountId: A,
      position: { ticket: "9500", symbol: "XAUUSD", side: "BUY", volume: 0.01, openPrice: 2301.6, stopLoss: 2290, takeProfit: 2320, profit: 0 },
    });
    expect(typeof (change as Extract<StateChange, { kind: "opened" }>).position.openedAt).toBe("string");
  });

  test("without a fill price the price on the ticket is used: the ask for a buy, the bid for a sell", () => {
    const buy = changesFromOpen(A, result(), request, quote)[0] as Extract<StateChange, { kind: "opened" }>;
    const sell = changesFromOpen(A, result(), { ...request, side: "SELL" }, quote)[0] as Extract<StateChange, { kind: "opened" }>;

    expect(buy.position.openPrice).toBe(2301.4);
    expect(sell.position.openPrice).toBe(2301.1);
  });

  test("what the broker confirmed wins over what was asked", () => {
    const [change] = changesFromOpen(
      A,
      result({ detail: { fillPrice: 2301.6, volume: 0.005, stopLoss: 2291, takeProfit: null } }),
      request,
      quote,
    );

    expect((change as Extract<StateChange, { kind: "opened" }>).position).toMatchObject({ volume: 0.005, stopLoss: 2291, takeProfit: null });
  });

  test("nothing is shown when there is no ticket or no price to show it at", () => {
    expect(changesFromOpen(A, result({ ticket: null }), request, quote)).toEqual([]);
    expect(changesFromOpen(A, result(), request, null)).toEqual([]);
    expect(changesFromOpen(A, result({ detail: { fillPrice: 0 } }), request, null)).toEqual([]);
  });

  test("a limit or stop order becomes a pending order at its price", () => {
    const limit = { ...request, orderKind: "LIMIT" as const, price: 2295, takeProfit: null };

    const [change] = changesFromOpen(A, result({ ticket: "9600" }), limit, quote);

    expect(change).toMatchObject({
      kind: "placed",
      accountId: A,
      order: { ticket: "9600", symbol: "XAUUSD", side: "BUY", kind: "LIMIT", volume: 0.01, price: 2295, stopLoss: 2290, takeProfit: null },
    });
    expect(changesFromOpen(A, result({ ticket: "9600", detail: { price: 2294.5 } }), limit, quote)[0]).toMatchObject({
      order: { price: 2294.5 },
    });
    expect(changesFromOpen(A, result({ ticket: "9600" }), { ...limit, price: null }, quote)).toEqual([]);
  });

  test("a whole close takes the position away", () => {
    expect(changesFromClose(A, result({ ticket: "9001" }), { ticket: "9001", volume: 0.1 }, null)).toEqual([
      { kind: "closed", accountId: A, ticket: "9001" },
    ]);
    // asking for all of it is a whole close, too
    expect(changesFromClose(A, result({ ticket: "9001" }), { ticket: "9001", volume: 0.1 }, 0.1)).toEqual([
      { kind: "closed", accountId: A, ticket: "9001" },
    ]);
  });

  test("a part-close leaves what is left", () => {
    expect(changesFromClose(A, result({ ticket: "9001" }), { ticket: "9001", volume: 0.1 }, 0.04)).toEqual([
      { kind: "reduced", accountId: A, ticket: "9001", volume: 0.06 },
    ]);
    // the lots the broker really closed win over the lots asked for
    expect(
      changesFromClose(A, result({ ticket: "9001", detail: { volume: 0.05 } }), { ticket: "9001", volume: 0.1 }, 0.04),
    ).toEqual([{ kind: "reduced", accountId: A, ticket: "9001", volume: 0.05 }]);
  });

  test("new levels: from the broker's confirmation, else from what was asked", () => {
    expect(changesFromModify(A, "9001", result({ ticket: "9001" }), { stopLoss: 2295, takeProfit: null })).toEqual([
      { kind: "levels", accountId: A, ticket: "9001", stopLoss: 2295, takeProfit: null },
    ]);
    expect(
      changesFromModify(A, "9001", result({ ticket: "9001", detail: { stopLoss: 2296, takeProfit: 2330 } }), { stopLoss: 2295 }),
    ).toEqual([{ kind: "levels", accountId: A, ticket: "9001", stopLoss: 2296, takeProfit: 2330 }]);
  });

  test("a new price counts only when it is a price", () => {
    expect(changesFromModify(A, "9101", result({ ticket: "9101" }), { price: 1.079 })).toEqual([
      { kind: "levels", accountId: A, ticket: "9101", price: 1.079 },
    ]);
    expect(changesFromModify(A, "9101", result({ ticket: "9101" }), { price: 0 })).toEqual([
      { kind: "levels", accountId: A, ticket: "9101" },
    ]);
  });

  test("several closed at once: everything but what the trading system reported as failed", () => {
    const targets = { positions: [{ ticket: "9001" }, { ticket: "9002" }], pending: [{ ticket: "9101" }] };

    expect(changesFromBulk(A, result({ ticket: null, closed: 3 }), targets)).toEqual([
      { kind: "closed", accountId: A, ticket: "9001" },
      { kind: "closed", accountId: A, ticket: "9002" },
      { kind: "removed", accountId: A, ticket: "9101" },
    ]);
    expect(
      changesFromBulk(
        A,
        result({ ticket: null, closed: 2, failed: 1, failures: [{ ticket: "9002", symbol: "EURUSD.m", message: "Market is closed" }] }),
        targets,
      ),
    ).toEqual([
      { kind: "closed", accountId: A, ticket: "9001" },
      { kind: "removed", accountId: A, ticket: "9101" },
    ]);
    expect(changesFromBulk(A, result({ ticket: null, closed: 0, failed: 0 }), targets)).toEqual([]);
    expect(changesFromBulk(A, result({ ticket: null, closed: 1, failed: 2, failures: [] }), targets)).toEqual([]);
  });
});
