import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  Api2TradeLiveAccountSource,
  api2TradePositionChanged,
  mapApi2TradeOrderToLivePosition,
  type Api2TradePositionEvent,
} from "@/lib/broker/api2TradeLiveSource";
import type { Api2TradeClient, Api2TradeOrder } from "@/lib/broker/api2TradeClient";

// A stand-in for the `ws` package: a socket the test drives by hand.
const fakeWs = vi.hoisted(() => {
  type Entry = { fn: (...args: unknown[]) => void; once: boolean };
  class FakeSocket {
    static instances: FakeSocket[] = [];
    readonly handlers = new Map<string, Entry[]>();
    closed = false;
    terminated = false;
    pings = 0;
    constructor(
      readonly url: string,
      readonly options: { headers?: Record<string, string> },
    ) {
      FakeSocket.instances.push(this);
    }
    private add(event: string, fn: (...args: unknown[]) => void, once: boolean) {
      const list = this.handlers.get(event) ?? [];
      list.push({ fn, once });
      this.handlers.set(event, list);
      return this;
    }
    on(event: string, fn: (...args: unknown[]) => void) {
      return this.add(event, fn, false);
    }
    once(event: string, fn: (...args: unknown[]) => void) {
      return this.add(event, fn, true);
    }
    emit(event: string, ...args: unknown[]) {
      const list = [...(this.handlers.get(event) ?? [])];
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((entry) => !entry.once),
      );
      for (const entry of list) entry.fn(...args);
      return list.length > 0;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    }
    terminate() {
      this.terminated = true;
      this.close();
    }
    ping() {
      this.pings += 1;
    }
  }
  return { FakeSocket };
});
vi.mock("ws", () => ({ default: fakeWs.FakeSocket }));

const { FakeSocket } = fakeWs;
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

const START = new Date("2026-10-12T12:00:00.000Z");

function order(ticket: number, overrides: Record<string, unknown> = {}): Api2TradeOrder {
  return {
    ticket,
    symbol: "EURUSD",
    orderType: 0,
    lots: 0.1,
    openPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    profit: 3,
    ...overrides,
  } as Api2TradeOrder;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A broker client that answers `OpenedOrders` from what the test sets. */
function fakeClient() {
  const state: {
    answers: Array<Api2TradeOrder[] | Error>;
    hold: Promise<Api2TradeOrder[]> | null;
  } = { answers: [[]], hold: null };
  const client = {
    openedOrdersChecked: vi.fn(async () => {
      if (state.hold) {
        const pending = state.hold;
        state.hold = null;
        return pending;
      }
      const next = state.answers.length > 1 ? state.answers.shift()! : state.answers[0];
      if (next instanceof Error) throw next;
      return next;
    }),
    openedOrders: vi.fn(async () => (state.answers[0] instanceof Error ? [] : (state.answers[0] as Api2TradeOrder[]))),
    connectByToken: vi.fn(async () => "token"),
    subscribeOrderUpdate: vi.fn(async () => "subscribed"),
    basicAuthValue: vi.fn(() => "Basic dXNlcjpwYXNz"),
    authHeaders: vi.fn(() => ({})),
    eventsUrl: vi.fn((path: string, params: Record<string, unknown>) => `wss://events.example/${path.replace(/^\//, "")}?id=${String(params.id)}`),
  };
  return { client, state };
}

function makeSource(initial: Array<Api2TradeOrder[] | Error> = [[]]) {
  const { client, state } = fakeClient();
  state.answers = initial;
  const source = new Api2TradeLiveAccountSource(client as unknown as Api2TradeClient, "provider-account-1");
  return { source, client, state };
}

const types = (events: Api2TradePositionEvent[]) => events.map((event) => `${event.eventType}:${event.position.id}`);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  FakeSocket.instances.length = 0;
  // REST only unless a test turns the socket on
  process.env.API2TRADE_WEBSOCKET_ENABLED = "false";
  delete process.env.API2TRADE_WS_FALLBACK_POLL_MS;
  delete process.env.API2TRADE_REST_POLL_MS;
  delete process.env.API2TRADE_FAST_POLL_MS;
  delete process.env.API2TRADE_WS_SILENCE_MS;
  delete process.env.API2TRADE_STRICT_ORDER_STREAM;
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("mapApi2TradeOrderToLivePosition", () => {
  test("reads side, volume and levels of an order", () => {
    const buy = mapApi2TradeOrderToLivePosition(order(11, { orderType: 0 }));
    const sell = mapApi2TradeOrderToLivePosition(order(12, { orderType: 1 }));
    const named = mapApi2TradeOrderToLivePosition(order(13, { orderType: "Sell", lots: undefined, volume: 0.2 }));

    expect(buy).toMatchObject({ id: "11", type: "POSITION_TYPE_BUY", symbol: "EURUSD", volume: 0.1, stopLoss: 1.09, takeProfit: 1.12 });
    expect(sell?.type).toBe("POSITION_TYPE_SELL");
    expect(named).toMatchObject({ type: "POSITION_TYPE_SELL", volume: 0.2 });
  });

  test("an order without any id is not a position", () => {
    expect(mapApi2TradeOrderToLivePosition({ symbol: "EURUSD" } as Api2TradeOrder)).toBeNull();
  });

  test("a position id wins over the ticket", () => {
    expect(mapApi2TradeOrderToLivePosition(order(5, { positionId: 99 }))?.id).toBe("99");
  });

  test("a pending order is not a position, and a sell limit is never read as a BUY", () => {
    for (const type of [2, 3, 4, 5, 6, 7, "BuyLimit", "SellStop", "sell_limit", "Buy Stop"]) {
      expect(mapApi2TradeOrderToLivePosition(order(21, { orderType: type }))).toBeNull();
    }
  });

  test("a position id of 0 means none: the ticket is the id", () => {
    expect(mapApi2TradeOrderToLivePosition(order(5, { positionId: 0 }))?.id).toBe("5");
    expect(mapApi2TradeOrderToLivePosition(order(5, { positionId: "0" }))?.id).toBe("5");
  });

  test("an order whose direction cannot be read is not guessed", () => {
    expect(mapApi2TradeOrderToLivePosition(order(6, { orderType: undefined }))).toBeNull();
    expect(mapApi2TradeOrderToLivePosition(order(6, { orderType: "Balance" }))).toBeNull();
  });

  test("the volume is read by the same rule as in the trade panel", () => {
    expect(mapApi2TradeOrderToLivePosition(order(7, { lots: undefined, volume: 10_000 }))?.volume).toBe(1);
    expect(mapApi2TradeOrderToLivePosition(order(7, { lots: undefined, volume: 1_000_000 }))?.volume).toBe(0.01);
    expect(mapApi2TradeOrderToLivePosition(order(7, { lots: 0, volume: 0.5 }))?.volume).toBe(0.5);
    expect(mapApi2TradeOrderToLivePosition(order(7, { lots: 150 }))?.volume).toBe(150);
  });

  test("a change in volume, stop loss or take profit counts, a change in profit does not", () => {
    const base = mapApi2TradeOrderToLivePosition(order(1))!;
    expect(api2TradePositionChanged(base, mapApi2TradeOrderToLivePosition(order(1, { lots: 0.2 }))!)).toBe(true);
    expect(api2TradePositionChanged(base, mapApi2TradeOrderToLivePosition(order(1, { stopLoss: 1.095 }))!)).toBe(true);
    expect(api2TradePositionChanged(base, mapApi2TradeOrderToLivePosition(order(1, { takeProfit: 1.13 }))!)).toBe(true);
    expect(api2TradePositionChanged(base, mapApi2TradeOrderToLivePosition(order(1, { profit: 50 }))!)).toBe(false);
  });
});

describe("Api2TradeLiveAccountSource - reading the list over REST", () => {
  test("the first list is only remembered unless the positions already open are asked for", async () => {
    const { source } = makeSource([[order(1), order(2)]]);

    await expect(source.reconcile()).resolves.toEqual([]);
    expect(source.stats().trackedPositions).toBe(2);
  });

  test("positions that were already open are reported as OPEN and flagged as found, not seen opening", async () => {
    const { source } = makeSource([[order(1), order(2)]]);

    const events = await source.reconcile({ emitExistingAsOpen: true });

    expect(types(events)).toEqual(["OPEN:1", "OPEN:2"]);
    expect(events.every((event) => event.existing === true)).toBe(true);
    expect(events.every((event) => typeof event.detectedAt === "number")).toBe(true);
  });

  test("a position that appears later is a plain OPEN with the time it was seen", async () => {
    const { source, state } = makeSource([[order(1)]]);
    await source.reconcile({ emitExistingAsOpen: true });

    vi.advanceTimersByTime(400);
    state.answers = [[order(1), order(2)]];
    const events = await source.reconcile({ emitExistingAsOpen: true });

    expect(types(events)).toEqual(["OPEN:2"]);
    expect(events[0].detectedBy).toBe("rest");
    expect(events[0].existing).toBeUndefined();
    expect(events[0].detectedAt).toBe(Date.now());
  });

  test("a change of volume, stop loss or take profit is a MODIFY that knows the previous state", async () => {
    const { source, state } = makeSource([[order(1)]]);
    await source.reconcile();

    vi.advanceTimersByTime(400);
    state.answers = [[order(1, { stopLoss: 1.095 })]];
    const events = await source.reconcile();

    expect(types(events)).toEqual(["MODIFY:1"]);
    expect(events[0].previous?.stopLoss).toBe(1.09);
    expect(events[0].position.stopLoss).toBe(1.095);
  });

  test("a change in profit alone says nothing", async () => {
    const { source, state } = makeSource([[order(1)]]);
    await source.reconcile();

    vi.advanceTimersByTime(400);
    state.answers = [[order(1, { profit: 80 })]];

    await expect(source.reconcile()).resolves.toEqual([]);
  });

  test("a position that is gone is a CLOSE carrying its last known state", async () => {
    const { source, state } = makeSource([[order(1), order(2)]]);
    await source.reconcile();

    vi.advanceTimersByTime(400);
    state.answers = [[order(1)]];
    const events = await source.reconcile();

    expect(types(events)).toEqual(["CLOSE:2"]);
    expect(events[0].position.symbol).toBe("EURUSD");
  });

  test("the last position closing is reported at once", async () => {
    const { source, state } = makeSource([[order(1)]]);
    await source.reconcile();

    vi.advanceTimersByTime(400);
    state.answers = [[]];

    expect(types(await source.reconcile())).toEqual(["CLOSE:1"]);
  });

  test("an empty body (no open orders) is an empty list", async () => {
    const { source, state } = makeSource([[]]);
    await expect(source.reconcile({ emitExistingAsOpen: true })).resolves.toEqual([]);
    expect(source.stats().trackedPositions).toBe(0);

    vi.advanceTimersByTime(400);
    state.answers = [[order(7)]];
    expect(types(await source.reconcile())).toEqual(["OPEN:7"]);
  });

  test("the list is read once per polling interval, not once per call", async () => {
    const { source, client } = makeSource([[order(1)]]);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(1);

    await source.reconcile();
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(399);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(2);
  });

  test("the polling interval can be set", async () => {
    process.env.API2TRADE_REST_POLL_MS = "1000";
    const { source, client } = makeSource([[order(1)]]);
    await source.reconcile();

    vi.advanceTimersByTime(900);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(2);
  });

  test("a pending order next to a position is no event; when it fills it is an OPEN", async () => {
    const { source, state } = makeSource([[order(1)]]);
    await source.reconcile();

    vi.advanceTimersByTime(400);
    state.answers = [[order(1), order(2, { orderType: 3 })]];
    await expect(source.reconcile()).resolves.toEqual([]);
    expect(source.stats().trackedPositions).toBe(1);

    // the price reaches the order: the same ticket is now a position
    vi.advanceTimersByTime(400);
    state.answers = [[order(1), order(2, { orderType: 1 })]];
    const events = await source.reconcile();
    expect(types(events)).toEqual(["OPEN:2"]);
    expect(events[0].position.type).toBe("POSITION_TYPE_SELL");
  });

  test("a list of nothing but pending orders is a list without positions, not an unreadable one", async () => {
    const { source } = makeSource([[order(3, { orderType: 2 }), order(4, { orderType: 5 })]]);

    await expect(source.reconcile({ emitExistingAsOpen: true })).resolves.toEqual([]);
    expect(source.stats().trackedPositions).toBe(0);
    expect(source.stats().consecutiveReadErrors).toBe(0);
  });

  test("positions closing while only pending orders stay is still confirmed by a second list", async () => {
    const { source, state } = makeSource([[order(1), order(2)]]);
    await source.reconcile();

    vi.advanceTimersByTime(400);
    const onlyPending = [order(9, { orderType: 2 })];
    state.answers = [onlyPending, onlyPending];
    const events = await source.reconcile();

    expect(types(events)).toEqual(["CLOSE:1", "CLOSE:2"]);
  });

  test("readOpenPositions maps the plain list", async () => {
    const { source } = makeSource([[order(1), order(2, { orderType: 1 })]]);

    const positions = await source.readOpenPositions();

    expect(positions.map((position) => `${position.id}:${position.type}`)).toEqual([
      "1:POSITION_TYPE_BUY",
      "2:POSITION_TYPE_SELL",
    ]);
  });
});

describe("Api2TradeLiveAccountSource - everything vanishing at once", () => {
  test("two positions that disappear together are closed only when a second list says the same", async () => {
    const { source, state, client } = makeSource([[order(1), order(2)]]);
    await source.reconcile();

    vi.advanceTimersByTime(400);
    state.answers = [[], []];
    const events = await source.reconcile();

    expect(types(events)).toEqual(["CLOSE:1", "CLOSE:2"]);
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(3);
    expect(source.stats().trackedPositions).toBe(0);
  });

  test("a list that was empty by mistake changes nothing when the second list shows the positions again", async () => {
    const { source, state } = makeSource([[order(1), order(2)]]);
    await source.reconcile();

    vi.advanceTimersByTime(400);
    state.answers = [[], [order(1), order(2)]];
    const events = await source.reconcile();

    expect(events).toEqual([]);
    expect(source.stats().trackedPositions).toBe(2);
  });

  test("a message of the stream that says everything closed is confirmed over REST before anything is closed", async () => {
    process.env.API2TRADE_WEBSOCKET_ENABLED = "true";
    const { source, state, client } = makeSource([[order(1), order(2)]]);
    (source as unknown as { wsConnected: boolean }).wsConnected = true;
    await source.reconcile();
    const listener = vi.fn();
    source.onSignal(listener);

    source.ingestSocketMessage(JSON.stringify({ openedOrders: [] }));

    // held back: nothing is reported yet, but the engine is woken to ask REST
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.stats().trackedPositions).toBe(2);

    state.answers = [[]];
    const events = await source.reconcile();
    expect(types(events)).toEqual(["CLOSE:1", "CLOSE:2"]);
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(2);
  });
});

describe("Api2TradeLiveAccountSource - lists that cannot be read", () => {
  test("rows that cannot be told apart are an error, never 'nothing is open'", async () => {
    const { source } = makeSource([[{ symbol: "EURUSD" } as Api2TradeOrder]]);

    await expect(source.reconcile()).rejects.toThrow("could not be read");
    expect(source.stats().consecutiveReadErrors).toBe(1);
  });

  test("a failed first read is raised", async () => {
    const { source } = makeSource([new Error("Broker service did not answer OpenedOrders within 5s.")]);

    await expect(source.reconcile()).rejects.toThrow("did not answer");
  });

  test("one failed read of a picture that is still fresh is tolerated and read again at once", async () => {
    const { source, state, client } = makeSource([[order(1)]]);
    await source.reconcile();

    vi.advanceTimersByTime(400);
    state.answers = [new Error("socket hang up")];
    await expect(source.reconcile()).resolves.toEqual([]);
    expect(source.stats().consecutiveReadErrors).toBe(1);
    expect(source.stats().trackedPositions).toBe(1);

    // no waiting for the next interval: the very next call reads again and sees the change
    state.answers = [[order(1), order(2)]];
    const events = await source.reconcile();
    expect(types(events)).toEqual(["OPEN:2"]);
    expect(source.stats().consecutiveReadErrors).toBe(0);
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(3);
  });

  test("a picture that has become old is not trusted: the failure is raised", async () => {
    const { source, state } = makeSource([[order(1)]]);
    await source.reconcile();

    vi.advanceTimersByTime(7_000);
    state.answers = [new Error("socket hang up")];

    await expect(source.reconcile()).rejects.toThrow("socket hang up");
  });
});

describe("Api2TradeLiveAccountSource - messages of the order stream", () => {
  test("a list that arrives before the first REST read is not used, but wakes the engine", async () => {
    const { source, client } = makeSource([[order(1)]]);
    const listener = vi.fn();
    source.onSignal(listener);

    source.ingestSocketMessage(JSON.stringify({ openedOrders: [order(1), order(2)] }));
    expect(listener).toHaveBeenCalledTimes(1);

    const events = await source.reconcile({ emitExistingAsOpen: true });
    expect(types(events)).toEqual(["OPEN:1"]);
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(1);
  });

  test("a complete list is applied at once, without a REST call, and the engine is woken", async () => {
    const { source, client } = makeSource([[order(1)]]);
    await source.reconcile();
    const listener = vi.fn();
    source.onSignal(listener);

    source.ingestSocketMessage(JSON.stringify({ openedOrders: [order(1), order(2)] }));

    expect(listener).toHaveBeenCalledTimes(1);
    const events = await source.reconcile();
    expect(types(events)).toEqual(["OPEN:2"]);
    expect(events[0].detectedBy).toBe("websocket");
    expect(source.stats()).toMatchObject({ websocketMessages: 1, websocketSnapshots: 1, websocketEvents: 1, restReads: 1 });
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(1);
    // delivered once
    await expect(source.reconcile()).resolves.toEqual([]);
  });

  test("a list identical to what is known wakes nobody", async () => {
    const { source } = makeSource([[order(1)]]);
    await source.reconcile();
    const listener = vi.fn();
    source.onSignal(listener);

    source.ingestSocketMessage(JSON.stringify({ openedOrders: [order(1)] }));

    expect(listener).not.toHaveBeenCalled();
  });

  test("any other message about an order wakes the engine and makes the next call read REST at once", async () => {
    const { source, state, client } = makeSource([[order(1)]]);
    await source.reconcile();
    const listener = vi.fn();
    source.onSignal(listener);

    source.ingestSocketMessage(JSON.stringify({ update: { ticket: 2, action: "Open" } }));
    expect(listener).toHaveBeenCalledTimes(1);

    state.answers = [[order(1), order(2)]];
    const events = await source.reconcile();

    expect(types(events)).toEqual(["OPEN:2"]);
    expect(events[0].detectedBy).toBe("rest");
    expect(source.stats()).toMatchObject({ websocketSignals: 1, restReads: 2, restEvents: 1 });
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(2);
  });

  test("noise (OK, heartbeats, empty frames) wakes nobody", async () => {
    const { source } = makeSource([[order(1)]]);
    await source.reconcile();
    const listener = vi.fn();
    source.onSignal(listener);

    for (const text of ["OK", "ping", "", "{}", "not json at all", JSON.stringify({ balance: 100 })]) {
      source.ingestSocketMessage(text);
    }

    expect(listener).not.toHaveBeenCalled();
  });

  test("a list of the stream that cannot be read is left to REST", async () => {
    const { source, state } = makeSource([[order(1)]]);
    await source.reconcile();
    const listener = vi.fn();
    source.onSignal(listener);

    source.ingestSocketMessage(JSON.stringify({ openedOrders: [{ symbol: "EURUSD" }] }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.stats().trackedPositions).toBe(1);

    state.answers = [[order(1), order(3)]];
    expect(types(await source.reconcile())).toEqual(["OPEN:3"]);
  });

  test("a REST answer that was taken before a newer list of the stream never undoes it", async () => {
    const { source, client } = makeSource([[order(1)]]);
    await source.reconcile();

    vi.advanceTimersByTime(1_000);
    const slow = deferred<Api2TradeOrder[]>();
    (client.openedOrdersChecked as unknown as { mockImplementationOnce: (fn: () => Promise<Api2TradeOrder[]>) => void })
      .mockImplementationOnce(() => slow.promise);
    const pending = source.reconcile();

    // while REST is still thinking, the stream delivers a newer list that has the new trade
    vi.advanceTimersByTime(10);
    source.ingestSocketMessage(JSON.stringify({ openedOrders: [order(1), order(2)] }));
    vi.advanceTimersByTime(10);
    slow.resolve([order(1)]); // the older picture arrives last

    await expect(pending).resolves.toEqual([]);

    const events = await source.reconcile();
    expect(types(events)).toEqual(["OPEN:2"]);
    expect(source.stats().trackedPositions).toBe(2);
  });

  test("a listener can stop listening, and a listener that throws cannot break the stream", async () => {
    const { source } = makeSource([[order(1)]]);
    await source.reconcile();
    const quiet = vi.fn();
    const stop = source.onSignal(quiet);
    source.onSignal(() => {
      throw new Error("listener bug");
    });
    const loud = vi.fn();
    source.onSignal(loud);

    stop();
    source.ingestSocketMessage(JSON.stringify({ ticket: 5 }));

    expect(quiet).not.toHaveBeenCalled();
    expect(loud).toHaveBeenCalledTimes(1);
  });
});

describe("Api2TradeLiveAccountSource - polling speed", () => {
  beforeEach(() => {
    process.env.API2TRADE_WEBSOCKET_ENABLED = "true";
  });

  test("with the socket up the safety poll runs every second", async () => {
    const { source, client } = makeSource([[order(1)]]);
    (source as unknown as { wsConnected: boolean }).wsConnected = true;
    await source.reconcile();

    vi.advanceTimersByTime(999);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(2);
  });

  test("a change that the safety poll finds although the stream said nothing speeds the polling up", async () => {
    const { source, state, client } = makeSource([[order(1)]]);
    (source as unknown as { wsConnected: boolean }).wsConnected = true;
    await source.reconcile();
    expect(source.stats().fastPolling).toBe(false);

    vi.advanceTimersByTime(1_000);
    state.answers = [[order(1), order(2)]];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const events = await source.reconcile();

    expect(types(events)).toEqual(["OPEN:2"]);
    expect(source.stats().fastPolling).toBe(true);
    expect(source.stats()).toMatchObject({ safetyMisses: 1, safetyPollDiscoveryRate: 1 });
    expect(warn).toHaveBeenCalledTimes(1);

    // from now on every 300 ms instead of every second
    const before = client.openedOrdersChecked.mock.calls.length;
    vi.advanceTimersByTime(299);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(before);
    vi.advanceTimersByTime(1);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(before + 1);
    warn.mockRestore();
  });

  test("a change that the stream announced first does not count against the stream", async () => {
    const { source, state } = makeSource([[order(1)]]);
    (source as unknown as { wsConnected: boolean }).wsConnected = true;
    await source.reconcile();

    vi.advanceTimersByTime(1_000);
    state.answers = [[order(1), order(2)]];
    source.ingestSocketMessage(JSON.stringify({ update: { ticket: 2 } }));
    await source.reconcile();

    expect(source.stats().fastPolling).toBe(false);
  });

  test("a heartbeat does not mask an order update missed by the socket", async () => {
    process.env.API2TRADE_STRICT_ORDER_STREAM = "true";
    const { source, state } = makeSource([[order(1)]]);
    (source as unknown as { wsConnected: boolean }).wsConnected = true;
    await source.reconcile();

    vi.advanceTimersByTime(1_000);
    source.ingestSocketMessage("OK"); // alive, just not about this trade
    vi.advanceTimersByTime(100);
    state.answers = [[order(1), order(2)]];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await source.reconcile();

    expect(source.stats().fastPolling).toBe(true);
    expect(source.stats()).toMatchObject({ websocketIgnored: 1, safetyMisses: 1 });
    warn.mockRestore();
  });

  test("the strict fallback is opt-in while miss diagnostics remain visible", async () => {
    const { source, state } = makeSource([[order(1)]]);
    (source as unknown as { wsConnected: boolean }).wsConnected = true;
    await source.reconcile();
    vi.advanceTimersByTime(1_000);
    source.ingestSocketMessage("OK");
    vi.advanceTimersByTime(100);
    state.answers = [[order(1), order(2)]];
    await source.reconcile();
    expect(source.stats()).toMatchObject({ safetyMisses: 1, fastPolling: false });
  });

  test("the intervals can be set", async () => {
    process.env.API2TRADE_WS_FALLBACK_POLL_MS = "2000";
    const { source, client } = makeSource([[order(1)]]);
    (source as unknown as { wsConnected: boolean }).wsConnected = true;
    await source.reconcile();

    vi.advanceTimersByTime(1_900);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(2);
  });
});

describe("Api2TradeLiveAccountSource - close", () => {
  test("forgets everything and stops listening", async () => {
    const { source } = makeSource([[order(1), order(2)]]);
    await source.reconcile();
    const listener = vi.fn();
    source.onSignal(listener);

    await source.close();

    expect(source.stats().trackedPositions).toBe(0);
    expect(source.usingWebSocket()).toBe(false);
    source.ingestSocketMessage(JSON.stringify({ ticket: 5 }));
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── the WebSocket itself ─────────────────────────────────────────────────────

/** Waits (in real time) until the source has created its next socket. */
async function nextSocket(previousCount: number) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (FakeSocket.instances.length > previousCount) return FakeSocket.instances[previousCount];
    await vi.advanceTimersByTimeAsync(0);
    await realSleep(2);
  }
  throw new Error("the source did not create a socket");
}

async function connect(source: Api2TradeLiveAccountSource) {
  const before = FakeSocket.instances.length;
  const connecting = source.reconnect();
  const socket = await nextSocket(before);
  socket.emit("open");
  await connecting;
  return socket;
}

describe("Api2TradeLiveAccountSource - the order stream connection", () => {
  beforeEach(() => {
    process.env.API2TRADE_WEBSOCKET_ENABLED = "true";
  });

  test("connects with the broker's credentials and is up once the socket opens", async () => {
    const { source, client } = makeSource([[order(1)]]);

    const socket = await connect(source);

    expect(client.connectByToken).toHaveBeenCalledWith("provider-account-1");
    expect(client.subscribeOrderUpdate).toHaveBeenCalledWith("provider-account-1");
    expect(socket.url).toBe("wss://events.example/OnOrderUpdate?id=provider-account-1");
    expect(socket.options.headers).toEqual({ Authorization: "Basic dXNlcjpwYXNz" });
    expect(source.usingWebSocket()).toBe(true);
    await source.close();
  });

  test("a fresh connection makes the engine read the list at once, in case something happened meanwhile", async () => {
    const { source, client } = makeSource([[order(1)]]);
    await source.reconcile();
    const listener = vi.fn();
    source.onSignal(listener);

    await connect(source);

    expect(listener).toHaveBeenCalled();
    await source.reconcile();
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(2);
    await source.close();
  });

  test("messages of the socket reach the source, whatever form they come in", async () => {
    const { source, state } = makeSource([[order(1)]]);
    await source.reconcile();
    const socket = await connect(source);
    const listener = vi.fn();
    source.onSignal(listener);
    await source.reconcile(); // use up the forced read of the fresh connection

    socket.emit("message", Buffer.from(JSON.stringify({ openedOrders: [order(1), order(2)] })));

    expect(listener).toHaveBeenCalledTimes(1);
    state.answers = [[order(1), order(2)]];
    expect(types(await source.reconcile())).toEqual(["OPEN:2"]);
    await source.close();
  });

  test("when the socket drops it is rebuilt shortly after and the picture is checked", async () => {
    const { source } = makeSource([[order(1)]]);
    await source.reconcile();
    const first = await connect(source);

    first.emit("close");
    expect(source.usingWebSocket()).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    const second = await nextSocket(1);
    second.emit("open");
    await vi.advanceTimersByTimeAsync(0);

    expect(source.usingWebSocket()).toBe(true);
    await source.close();
  });

  test("a socket that cannot be opened is tried again with growing pauses", async () => {
    const { source } = makeSource([[order(1)]]);
    const connecting = source.reconnect();
    const first = await nextSocket(0);
    first.emit("error", new Error("connect ECONNREFUSED"));
    await connecting;
    expect(source.usingWebSocket()).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    const second = await nextSocket(1);
    second.emit("error", new Error("connect ECONNREFUSED"));
    await vi.advanceTimersByTimeAsync(0);

    // the second pause is longer than the first
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await nextSocket(2);
    expect(FakeSocket.instances).toHaveLength(3);
    await source.close();
  });

  test("a socket that never opens is given up after ten seconds and the source does not wait for it", async () => {
    const { source } = makeSource([[order(1)]]);
    let returned = false;
    const connecting = source.reconnect().then(() => {
      returned = true;
    });

    await nextSocket(0);
    await vi.advanceTimersByTimeAsync(1_500);
    await connecting;
    expect(returned).toBe(true);
    expect(source.usingWebSocket()).toBe(false);

    await vi.advanceTimersByTimeAsync(8_500);
    expect(FakeSocket.instances[0].terminated).toBe(true);
    await source.close();
  });

  test("a socket that goes silent is pinged and, after the silence limit, torn down and rebuilt", async () => {
    const { source } = makeSource([[order(1)]]);
    const socket = await connect(source);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.pings).toBe(3);
    expect(socket.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.terminated).toBe(true);
    expect(source.usingWebSocket()).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    await nextSocket(1);
    expect(FakeSocket.instances).toHaveLength(2);
    await source.close();
  });

  test("any sign of life keeps the socket", async () => {
    const { source } = makeSource([[order(1)]]);
    const socket = await connect(source);

    for (let minute = 0; minute < 4; minute += 1) {
      await vi.advanceTimersByTimeAsync(40_000);
      socket.emit("pong");
    }

    expect(socket.terminated).toBe(false);
    expect(source.usingWebSocket()).toBe(true);
    await source.close();
  });

  test("the silence limit can be switched off", async () => {
    process.env.API2TRADE_WS_SILENCE_MS = "0";
    const { source } = makeSource([[order(1)]]);
    const socket = await connect(source);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(socket.terminated).toBe(false);
    expect(socket.pings).toBe(0);
    await source.close();
  });

  test("closing the source closes the socket and nothing is rebuilt", async () => {
    const { source } = makeSource([[order(1)]]);
    const socket = await connect(source);

    await source.close();

    expect(socket.closed).toBe(true);
    expect(source.usingWebSocket()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("with the stream switched off no socket is opened", async () => {
    process.env.API2TRADE_WEBSOCKET_ENABLED = "false";
    const { source, client } = makeSource([[order(1)]]);

    await source.reconnect();
    await source.reconcile();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(FakeSocket.instances).toHaveLength(0);
    expect(source.usingWebSocket()).toBe(false);
    expect(client.openedOrdersChecked).toHaveBeenCalled();
  });
});

describe("Api2TradeLiveAccountSource - confirmed open positions", () => {
  test("a position counts as open when either of the two lists has it", async () => {
    const { source, client } = makeSource([[order(1), order(2)], [order(2), order(3)]]);

    const pending = source.confirmedOpenPositionIds(1_500);
    await vi.advanceTimersByTimeAsync(1_500);

    expect([...(await pending)].sort()).toEqual(["1", "2", "3"]);
    expect(client.openedOrdersChecked).toHaveBeenCalledTimes(2);
  });

  test("pending orders are not positions", async () => {
    const { source } = makeSource([[order(1), order(2, { orderType: 2 })]]);

    const pending = source.confirmedOpenPositionIds(100);
    await vi.advanceTimersByTimeAsync(100);

    expect([...(await pending)]).toEqual(["1"]);
  });

  test("two empty lists mean nothing is open", async () => {
    const { source } = makeSource([[]]);

    const pending = source.confirmedOpenPositionIds(100);
    await vi.advanceTimersByTimeAsync(100);

    expect((await pending).size).toBe(0);
  });

  test("a list that cannot be read is an error, never an empty list", async () => {
    const { source } = makeSource([[order(1)], new Error("bridge down")]);

    const pending = source.confirmedOpenPositionIds(100);
    const outcome = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(outcome).resolves.toBe("bridge down");
  });

  test("rows that are neither positions nor pending orders are an error, not an empty list", async () => {
    const { source } = makeSource([[order(1, { orderType: "Balance" })]]);

    await expect(source.confirmedOpenPositionIds(100)).rejects.toThrow(/could not be read/);
  });
});
