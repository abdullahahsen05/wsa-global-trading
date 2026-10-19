import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BrokerExecutionError,
  type BrokerAdapter,
  type BrokerTradingState,
  type ExecutionStages,
} from "@/lib/broker/BrokerAdapter";
import { GatewayNotInstalledError } from "@/lib/gateway/gatewayDb";
import type { ClaimedCommand, GatewayStore, WatchedAccount } from "@/lib/gateway/gatewayStore";
import { GatewayWorker, startGatewayWorker } from "@/lib/gateway/gatewayWorker";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OTHER_ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

const clock = { t: Date.parse("2026-10-12T12:00:00.000Z") };
const now = () => clock.t;

function tradingState(overrides: Partial<BrokerTradingState> = {}): BrokerTradingState {
  return {
    currency: "USD",
    balance: 10_000,
    equity: 10_012.5,
    floatingProfit: 12.5,
    margin: 200,
    freeMargin: 9812.5,
    marginLevel: 5006,
    positions: [
      {
        ticket: "5001",
        symbol: "XAUUSD",
        side: "BUY",
        volume: 0.5,
        openPrice: 2390,
        stopLoss: 2380,
        takeProfit: 2410,
        profit: 12.5,
        swap: 0,
        commission: -1,
        openedAt: "2026-10-12T10:00:00.000Z",
        comment: null,
      },
    ],
    pending: [],
    pendingOrders: 0,
    fetchedAt: "2026-10-12T11:59:59.000Z",
    ...overrides,
  };
}

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    executionAvailable: vi.fn(() => true),
    fetchTradingState: vi.fn(async () => tradingState()),
    fetchQuote: vi.fn(async (_account: string, symbol: string) => ({ symbol, bid: 1.0801, ask: 1.0803 })),
    fetchSymbolList: vi.fn(async () => [
      { name: "EURUSD.r", description: "Euro vs US Dollar", path: "Forex\\Majors\\EURUSD.r", digits: 5 },
    ]),
    openTrade: vi.fn(async () => ({ ok: true, brokerPositionId: "9001", brokerOrderId: "9000" })),
    closeTrade: vi.fn(async () => ({ ok: true })),
    modifyTrade: vi.fn(async () => ({ ok: true })),
    cancelOrder: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function makeStore() {
  const queue: ClaimedCommand[] = [];
  return {
    queue,
    claim: vi.fn<GatewayStore["claim"]>(async (_worker, limit) => queue.splice(0, limit)),
    owner: vi.fn<GatewayStore["owner"]>(async () => ({ userId: USER, providerAccountId: "provider-1" })),
    complete: vi.fn<GatewayStore["complete"]>(async () => undefined),
    fail: vi.fn<GatewayStore["fail"]>(async () => undefined),
    sweep: vi.fn<GatewayStore["sweep"]>(async () => ({ expired: 0, lost: 0, purged: 0 })),
    watched: vi.fn<GatewayStore["watched"]>(async () => [] as WatchedAccount[]),
    saveState: vi.fn<GatewayStore["saveState"]>(async () => undefined),
    saveSymbols: vi.fn<GatewayStore["saveSymbols"]>(async () => undefined),
    heartbeat: vi.fn<GatewayStore["heartbeat"]>(async () => undefined),
    retire: vi.fn<GatewayStore["retire"]>(async () => undefined),
  };
}

function command(overrides: Partial<ClaimedCommand> = {}): ClaimedCommand {
  const created = clock.t - 120;
  return {
    id: "cccccccc-0000-4000-8000-000000000001",
    userId: USER,
    accountId: ACCOUNT,
    kind: "OPEN",
    payload: { symbol: "EURUSD.r", side: "BUY", volume: 0.1 },
    clientRequestId: "request-1",
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + 90_000).toISOString(),
    ...overrides,
  };
}

interface Rig {
  store: ReturnType<typeof makeStore>;
  adapter: ReturnType<typeof makeAdapter>;
  worker: GatewayWorker;
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}

function rig(options: { adapter?: Record<string, unknown>; stateRefreshMs?: number } = {}): Rig {
  const store = makeStore();
  const adapter = makeAdapter(options.adapter);
  const log = vi.fn();
  const warn = vi.fn();
  const worker = new GatewayWorker({
    store,
    adapter: adapter as unknown as BrokerAdapter,
    workerId: "worker-1",
    log,
    warn,
    now,
    stateRefreshMs: options.stateRefreshMs ?? 1_000,
  });
  return { store, adapter, worker, log, warn };
}

async function settle(ms = 15): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise the test settles by hand: the broker "answers" exactly when the test says so. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const SECOND_ID = "cccccccc-0000-4000-8000-000000000002";

beforeEach(() => {
  clock.t = Date.parse("2026-10-12T12:00:00.000Z");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("running one command", () => {
  test("claims it, runs it through the broker and stores the answer with its timing", async () => {
    const { store, adapter, worker } = rig({
      adapter: {
        openTrade: vi.fn(async () => {
          clock.t += 35;
          return { ok: true, brokerPositionId: "9001", brokerOrderId: "9000" };
        }),
      },
    });
    store.queue.push(command());

    expect(await worker.pollCommandsOnce()).toBe(1);
    await worker.idle();

    expect(store.claim).toHaveBeenCalledWith("worker-1", 10);
    expect(adapter.openTrade).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, symbol: "EURUSD.r", side: "BUY", volume: 0.1, orderKind: "MARKET" }),
    );
    expect(store.fail).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledTimes(1);
    const [id, outcome] = store.complete.mock.calls[0];
    expect(id).toBe("cccccccc-0000-4000-8000-000000000001");
    expect(outcome).toMatchObject({ ticket: "9001", timing: { queueMs: 120, runMs: 35 } });
  });

  test("nothing to do means no work and no noise", async () => {
    const { store, worker, log } = rig();

    expect(await worker.pollCommandsOnce()).toBe(0);
    await worker.idle();

    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test("a refusal of the broker is stored as it is, with its code and status", async () => {
    const { store, worker } = rig({
      adapter: {
        closeTrade: vi.fn(async () => {
          throw new BrokerExecutionError("BROKER_PROVIDER_ERROR", "That order does not exist any more.", 502);
        }),
      },
    });
    store.queue.push(command({ kind: "CLOSE", payload: { ticket: "4242" } }));

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith("cccccccc-0000-4000-8000-000000000001", {
      code: "BROKER_PROVIDER_ERROR",
      message: "That order does not exist any more.",
      statusCode: 502,
    });
  });

  test("a command the worker does not understand fails without touching the broker", async () => {
    const { store, adapter, worker } = rig();
    store.queue.push(command({ kind: "DROP_TABLE", payload: {} }));
    store.queue.push(command({ id: "cccccccc-0000-4000-8000-000000000002", payload: { symbol: "EURUSD", side: "BUY", volume: 0 } }));

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledTimes(2);
    expect(store.fail.mock.calls[0][1]).toMatchObject({ code: "INVALID_COMMAND", message: "Unknown command." });
    expect(store.fail.mock.calls[1][1]).toMatchObject({ code: "INVALID_COMMAND", message: "Volume is not valid." });
  });

  test("with the execution switch off an order is refused and the account can still be read", async () => {
    const { store, adapter, worker } = rig({ adapter: { executionAvailable: vi.fn(() => false) } });
    store.queue.push(command());
    store.queue.push(command({ id: "cccccccc-0000-4000-8000-000000000002", kind: "STATE", payload: { symbols: [] } }));

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith(
      "cccccccc-0000-4000-8000-000000000001",
      expect.objectContaining({ code: "EXECUTION_DISABLED", statusCode: 503 }),
    );
    expect(store.complete).toHaveBeenCalledTimes(1);
    expect(store.complete.mock.calls[0][1].state?.positions).toHaveLength(1);
  });
});

describe("an order that waited too long", () => {
  test("is not sent: the person was already told it did not go through", async () => {
    const { store, adapter, worker } = rig();
    store.queue.push(command({ expiresAt: new Date(clock.t - 1).toISOString() }));

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith(
      "cccccccc-0000-4000-8000-000000000001",
      expect.objectContaining({ code: "NOT_SENT", statusCode: 504, message: expect.stringContaining("NOT sent") }),
    );
  });

  test("a close or a modify that waited too long is not sent either", async () => {
    const { store, adapter, worker } = rig();
    const late = new Date(clock.t - 1).toISOString();
    store.queue.push(command({ kind: "CLOSE", payload: { ticket: "5001" }, expiresAt: late }));
    store.queue.push(
      command({ id: "cccccccc-0000-4000-8000-000000000002", kind: "MODIFY", payload: { ticket: "5001", takeProfit: 2420 }, expiresAt: late }),
    );

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.closeTrade).not.toHaveBeenCalled();
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledTimes(2);
  });

  test("a read is still answered late: nothing changes at the broker", async () => {
    const { store, worker } = rig();
    store.queue.push(
      command({ kind: "STATE", payload: { symbols: [] }, expiresAt: new Date(clock.t - 60_000).toISOString() }),
    );

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.fail).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledTimes(1);
  });
});

describe("whose account it is", () => {
  test("a command for somebody else's account is refused", async () => {
    const { store, adapter, worker } = rig();
    store.owner.mockResolvedValue({ userId: "99999999-9999-4999-8999-999999999999", providerAccountId: "provider-1" });
    store.queue.push(command());

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith(
      "cccccccc-0000-4000-8000-000000000001",
      expect.objectContaining({ code: "ACCOUNT_NOT_FOUND", statusCode: 404 }),
    );
  });

  test("an account that does not exist any more is refused", async () => {
    const { store, adapter, worker } = rig();
    store.owner.mockResolvedValue(null);
    store.queue.push(command());

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(store.fail.mock.calls[0][1]).toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  test("an account that is not connected to the broker service says so", async () => {
    const { store, adapter, worker } = rig();
    store.owner.mockResolvedValue({ userId: USER, providerAccountId: null });
    store.queue.push(command());

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(store.fail.mock.calls[0][1]).toMatchObject({ code: "ACCOUNT_NOT_CONNECTED", statusCode: 409 });
  });

  test("the owner is looked up once, not for every click", async () => {
    const { store, worker } = rig();
    store.queue.push(command());
    store.queue.push(command({ id: "cccccccc-0000-4000-8000-000000000002", kind: "CLOSE", payload: { ticket: "5001" } }));
    await worker.pollCommandsOnce();
    await worker.idle();

    clock.t += 60_000;
    store.queue.push(command({ id: "cccccccc-0000-4000-8000-000000000003", kind: "CLOSE", payload: { ticket: "5001" } }));
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.owner).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledTimes(3);
  });

  test("another user on the same account id is checked again, never trusted from the cache", async () => {
    const { store, adapter, worker } = rig();
    store.queue.push(command());
    await worker.pollCommandsOnce();
    await worker.idle();

    store.queue.push(command({ id: "cccccccc-0000-4000-8000-000000000002", userId: "99999999-9999-4999-8999-999999999999" }));
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.owner).toHaveBeenCalledTimes(2);
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
    expect(store.fail.mock.calls[0][1]).toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });
});

describe("order of work", () => {
  test("commands of one account run one after the other: a modify never overtakes its open", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const { store, worker } = rig({
      adapter: {
        openTrade: vi.fn(
          () =>
            new Promise((resolve) => {
              seen.push("open started");
              release = () => {
                seen.push("open finished");
                resolve({ ok: true, brokerPositionId: "5001" });
              };
            }),
        ),
        modifyTrade: vi.fn(async () => {
          seen.push("modify");
          return { ok: true };
        }),
      },
    });
    store.queue.push(command());
    store.queue.push(
      command({ id: "cccccccc-0000-4000-8000-000000000002", kind: "MODIFY", payload: { ticket: "5001", takeProfit: 2420 } }),
    );

    await worker.pollCommandsOnce();
    await settle();
    expect(seen).toEqual(["open started"]);

    release();
    await worker.idle();

    expect(seen).toEqual(["open started", "open finished", "modify"]);
    expect(store.complete).toHaveBeenCalledTimes(2);
  });

  test("different accounts never wait for each other", async () => {
    let release!: () => void;
    const { store, worker } = rig({
      adapter: {
        openTrade: vi.fn(
          () =>
            new Promise((resolve) => {
              release = () => resolve({ ok: true, brokerPositionId: "9001" });
            }),
        ),
      },
    });
    store.queue.push(command());
    store.queue.push(command({ id: "cccccccc-0000-4000-8000-000000000002", accountId: OTHER_ACCOUNT, kind: "CLOSE", payload: { ticket: "5001" } }));

    await worker.pollCommandsOnce();
    await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(1));
    expect(store.complete.mock.calls[0][0]).toBe("cccccccc-0000-4000-8000-000000000002");

    release();
    await worker.idle();
    expect(store.complete).toHaveBeenCalledTimes(2);
  });
});

describe("the answer of a command that has run", () => {
  test("is stored again when the database hiccups, and the order is not sent twice", async () => {
    vi.useFakeTimers();
    const { store, adapter, worker } = rig();
    store.complete.mockRejectedValueOnce(new Error("socket hang up")).mockRejectedValueOnce(new Error("socket hang up"));
    store.queue.push(command());

    await worker.pollCommandsOnce();
    const finished = worker.idle();
    await vi.advanceTimersByTimeAsync(1_000);
    await finished;

    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledTimes(3);
    expect(store.fail).not.toHaveBeenCalled();
  });

  test("when it cannot be stored at all the order is still never run again", async () => {
    vi.useFakeTimers();
    const { store, adapter, worker, warn } = rig();
    store.complete.mockRejectedValue(new Error("database is down"));
    store.queue.push(command());

    await worker.pollCommandsOnce();
    const finished = worker.idle();
    await vi.advanceTimersByTimeAsync(2_000);
    await finished;

    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledTimes(3);
    expect(store.fail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ran but its answer could not be stored"));
  });

  test("a failure that cannot be stored is reported, not thrown", async () => {
    vi.useFakeTimers();
    const { store, worker, warn } = rig({ adapter: { openTrade: vi.fn(async () => { throw new Error("boom"); }) } });
    store.fail.mockRejectedValue(new Error("database is down"));
    store.queue.push(command());

    await worker.pollCommandsOnce();
    const finished = worker.idle();
    await vi.advanceTimersByTimeAsync(2_000);
    await finished;

    expect(store.fail).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not store the failure"));
  });

  test("the list of symbols is kept for the next person who opens the panel", async () => {
    const { store, worker } = rig();
    store.queue.push(command({ kind: "SYMBOLS", payload: {} }));

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.saveSymbols).toHaveBeenCalledTimes(1);
    const [accountId, symbols] = store.saveSymbols.mock.calls[0];
    expect(accountId).toBe(ACCOUNT);
    expect(symbols).toEqual([
      { name: "EURUSD.r", description: "Euro vs US Dollar", path: "Forex\\Majors\\EURUSD.r", digits: 5 },
    ]);
    expect(store.complete.mock.calls[0][1].symbols).toEqual(symbols);
  });

  test("a failing symbol store does not fail the command", async () => {
    const { store, worker, warn } = rig();
    store.saveSymbols.mockRejectedValue(new Error("disk full"));
    store.queue.push(command({ kind: "SYMBOLS", payload: {} }));

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not store the symbols"));
    expect(store.complete).toHaveBeenCalledTimes(1);
  });
});

describe("without migration 060", () => {
  test("the gateway sleeps for a minute, says so once and wakes up again", async () => {
    const { store, worker, log } = rig();
    store.claim.mockRejectedValue(new GatewayNotInstalledError());

    expect(await worker.pollCommandsOnce()).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("migration 060 is not applied");

    clock.t += 30_000;
    expect(await worker.pollCommandsOnce()).toBe(0);
    expect(store.claim).toHaveBeenCalledTimes(1);

    clock.t += 31_000;
    store.claim.mockRejectedValue(new GatewayNotInstalledError());
    expect(await worker.pollCommandsOnce()).toBe(0);
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("once the tables exist the worker says it is running", async () => {
    const { store, worker, log } = rig();
    store.claim.mockRejectedValueOnce(new GatewayNotInstalledError());
    await worker.pollCommandsOnce();

    clock.t += 61_000;
    await worker.pollCommandsOnce();
    await worker.heartbeatOnce();

    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("the gateway is running"));
  });

  test("an ordinary database error is not mistaken for a missing migration", async () => {
    const { store, worker } = rig();
    store.claim.mockRejectedValue(new Error("connection refused"));

    await expect(worker.pollCommandsOnce()).rejects.toThrow("connection refused");
    store.claim.mockResolvedValue([]);
    expect(await worker.pollCommandsOnce()).toBe(0);
    expect(store.claim).toHaveBeenCalledTimes(2);
  });

  test("watching sleeps too, and never reads the broker", async () => {
    const { store, adapter, worker } = rig();
    store.claim.mockRejectedValue(new GatewayNotInstalledError());
    await worker.pollCommandsOnce();

    expect(await worker.refreshStatesOnce()).toBe(0);
    expect(store.watched).not.toHaveBeenCalled();
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
  });
});

describe("the live picture of watched accounts", () => {
  const watched: WatchedAccount = { accountId: ACCOUNT, userId: USER, symbols: ["EURUSD.r", "XAUUSD"] };

  test("figures, positions and the prices on screen are stored", async () => {
    const { store, adapter, worker } = rig();
    store.watched.mockResolvedValue([watched]);

    expect(await worker.refreshStatesOnce()).toBe(1);
    await worker.idle();

    expect(adapter.fetchTradingState).toHaveBeenCalledWith(ACCOUNT);
    expect(adapter.fetchQuote).toHaveBeenCalledTimes(2);
    expect(store.saveState).toHaveBeenCalledTimes(1);
    const [accountId, state, error] = store.saveState.mock.calls[0];
    expect(accountId).toBe(ACCOUNT);
    expect(error).toBeNull();
    expect(state?.equity).toBe(10_012.5);
    expect(state?.positions).toHaveLength(1);
    expect(state?.quotes).toEqual({
      "EURUSD.r": { bid: 1.0801, ask: 1.0803, at: expect.any(String) },
      XAUUSD: { bid: 1.0801, ask: 1.0803, at: expect.any(String) },
    });
  });

  test("it is renewed about once a second, not on every tick", async () => {
    const { store, worker } = rig();
    store.watched.mockResolvedValue([watched]);

    await worker.refreshStatesOnce();
    await worker.idle();
    clock.t += 250;
    expect(await worker.refreshStatesOnce()).toBe(0);
    clock.t += 300;
    expect(await worker.refreshStatesOnce()).toBe(0);
    clock.t += 500;
    expect(await worker.refreshStatesOnce()).toBe(1);
    await worker.idle();

    expect(store.saveState).toHaveBeenCalledTimes(2);
  });

  test("the list of watched accounts is read twice a second, not on every tick", async () => {
    const { store, worker } = rig();
    store.watched.mockResolvedValue([watched]);

    await worker.refreshStatesOnce();
    await worker.idle();
    clock.t += 400;
    await worker.refreshStatesOnce();
    expect(store.watched).toHaveBeenCalledTimes(1);

    clock.t += 700;
    await worker.refreshStatesOnce();
    await worker.idle();
    expect(store.watched).toHaveBeenCalledTimes(2);
  });

  test("an account is never read twice at the same time", async () => {
    let release!: () => void;
    const { store, adapter, worker } = rig({
      adapter: {
        fetchTradingState: vi.fn(
          () =>
            new Promise((resolve) => {
              release = () => resolve(tradingState());
            }),
        ),
      },
    });
    store.watched.mockResolvedValue([watched]);

    expect(await worker.refreshStatesOnce()).toBe(1);
    clock.t += 5_000;
    expect(await worker.refreshStatesOnce()).toBe(0);
    expect(adapter.fetchTradingState).toHaveBeenCalledTimes(1);

    release();
    await worker.idle();
    expect(store.saveState).toHaveBeenCalledTimes(1);
  });

  test("a broken read keeps the last picture, records the error and backs off for a few seconds", async () => {
    const { store, adapter, worker, log } = rig({
      adapter: { fetchTradingState: vi.fn(async () => { throw new BrokerExecutionError("BROKER_PROVIDER_ERROR", "Broker not reachable.", 502); }) },
    });
    store.watched.mockResolvedValue([watched]);

    await worker.refreshStatesOnce();
    await worker.idle();

    expect(store.saveState).toHaveBeenCalledTimes(1);
    expect(store.saveState.mock.calls[0][1]).toBeNull();
    expect(store.saveState.mock.calls[0][2]).toBe("Broker not reachable.");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not read account"));

    clock.t += 1_500;
    expect(await worker.refreshStatesOnce()).toBe(0);
    clock.t += 2_000;
    expect(await worker.refreshStatesOnce()).toBe(1);
    await worker.idle();
    expect(adapter.fetchTradingState).toHaveBeenCalledTimes(2);
    // the same trouble is written to the log once a minute, not every three seconds
    expect(log.mock.calls.filter(([line]) => String(line).includes("could not read account"))).toHaveLength(1);
  });

  test("a failing prices call does not spoil the picture", async () => {
    const { store, worker } = rig({ adapter: { fetchQuote: vi.fn(async () => { throw new Error("no quote"); }) } });
    store.watched.mockResolvedValue([watched]);

    await worker.refreshStatesOnce();
    await worker.idle();

    expect(store.saveState.mock.calls[0][1]?.quotes).toEqual({});
    expect(store.saveState.mock.calls[0][2]).toBeNull();
  });

  test("an order that has just been sent refreshes the picture at once - the order itself starts the read", async () => {
    const { store, worker } = rig();
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();
    expect(store.saveState).toHaveBeenCalledTimes(1);

    clock.t += 100;
    store.queue.push(command());
    await worker.pollCommandsOnce();
    await worker.idle();

    // the picture was read again by the order, not by the next tick of the watch loop ...
    expect(store.saveState).toHaveBeenCalledTimes(2);
    // ... and that read counts: the tick that follows has nothing left to do yet
    expect(await worker.refreshStatesOnce()).toBe(0);
  });

  test("a read-only command does not reset the refresh", async () => {
    const { store, worker } = rig();
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();

    clock.t += 100;
    store.queue.push(command({ kind: "STATE", payload: { symbols: [] } }));
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(await worker.refreshStatesOnce()).toBe(0);
  });

  test("several accounts are refreshed together", async () => {
    const { store, worker } = rig();
    store.watched.mockResolvedValue([watched, { accountId: OTHER_ACCOUNT, userId: USER, symbols: [] }]);

    expect(await worker.refreshStatesOnce()).toBe(2);
    await worker.idle();

    expect(store.saveState.mock.calls.map(([accountId]) => accountId).sort()).toEqual([ACCOUNT, OTHER_ACCOUNT].sort());
  });

  test("a failing list of watched accounts is reported to the caller and the next round starts clean", async () => {
    const { store, worker } = rig();
    store.watched.mockRejectedValueOnce(new Error("timeout")).mockResolvedValue([watched]);

    await expect(worker.refreshStatesOnce()).rejects.toThrow("timeout");
    expect(await worker.refreshStatesOnce()).toBe(1);
    await worker.idle();
  });
});

describe("reads and orders on one account", () => {
  test("a slow symbol list does not hold up an order", async () => {
    const symbols = deferred<Array<{ name: string; description: string; path: string | null; digits: number }>>();
    const { store, adapter, worker } = rig({ adapter: { fetchSymbolList: vi.fn(() => symbols.promise) } });
    store.queue.push(command({ kind: "SYMBOLS", payload: {} }));
    store.queue.push(command({ id: SECOND_ID }));

    await worker.pollCommandsOnce();
    await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(1));
    expect(store.complete.mock.calls[0][0]).toBe(SECOND_ID);
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);

    symbols.resolve([{ name: "EURUSD.r", description: "Euro", path: null, digits: 5 }]);
    await worker.idle();
    expect(store.complete).toHaveBeenCalledTimes(2);
  });

  test("a read is answered while an order on the same account is still with the broker", async () => {
    const sent = deferred<{ ok: boolean; brokerPositionId: string }>();
    const { store, worker } = rig({ adapter: { openTrade: vi.fn(() => sent.promise) } });
    store.queue.push(command());
    store.queue.push(command({ id: SECOND_ID, kind: "STATE", payload: { symbols: [] } }));

    await worker.pollCommandsOnce();
    await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(1));
    expect(store.complete.mock.calls[0][0]).toBe(SECOND_ID);

    sent.resolve({ ok: true, brokerPositionId: "9001" });
    await worker.idle();
    expect(store.complete).toHaveBeenCalledTimes(2);
  });

  test("the next order on an account does not wait for the answer of the one before to be stored", async () => {
    const stored = deferred();
    const { store, adapter, worker } = rig();
    store.complete.mockImplementationOnce(() => stored.promise);
    store.queue.push(command());
    store.queue.push(command({ id: SECOND_ID, kind: "CLOSE", payload: { ticket: "5001" } }));

    await worker.pollCommandsOnce();
    await vi.waitFor(() => expect(adapter.closeTrade).toHaveBeenCalledTimes(1));
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);

    stored.resolve();
    await worker.idle();
    expect(store.complete).toHaveBeenCalledTimes(2);
  });
});

describe("right after an order", () => {
  const watched: WatchedAccount = { accountId: ACCOUNT, userId: USER, symbols: ["EURUSD.r"] };

  test("a refused order is followed by a fresh picture too: it may have changed something", async () => {
    const { store, worker } = rig({
      adapter: {
        closeTrade: vi.fn(async () => {
          throw new BrokerExecutionError("BROKER_PROVIDER_ERROR", "Timed out.", 502);
        }),
      },
    });
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();

    store.queue.push(command({ kind: "CLOSE", payload: { ticket: "5001" } }));
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.fail).toHaveBeenCalledTimes(1);
    expect(store.saveState).toHaveBeenCalledTimes(2);
  });

  test("an order that never reached the broker changes nothing, so nothing is read again", async () => {
    const { store, adapter, worker } = rig();
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();

    store.queue.push(command({ expiresAt: new Date(clock.t - 1).toISOString() }));
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(store.fail.mock.calls[0][1]).toMatchObject({ code: "NOT_SENT" });
    expect(store.saveState).toHaveBeenCalledTimes(1);
  });

  test("an account nobody is looking at is not read just because it traded", async () => {
    const { store, adapter, worker } = rig();
    store.queue.push(command());

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.complete).toHaveBeenCalledTimes(1);
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
    expect(store.saveState).not.toHaveBeenCalled();
  });

  test("a read that was under way when the order ended is followed by one more", async () => {
    const first = deferred<BrokerTradingState>();
    const fetchTradingState = vi
      .fn<() => Promise<BrokerTradingState>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => tradingState());
    const { store, worker } = rig({ adapter: { fetchTradingState } });
    store.watched.mockResolvedValue([watched]);

    await worker.refreshStatesOnce(); // the first read is on its way ...
    clock.t += 50;
    store.queue.push(command()); // ... when an order finishes
    await worker.pollCommandsOnce();
    await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(1));
    expect(fetchTradingState).toHaveBeenCalledTimes(1);

    first.resolve(tradingState()); // the old read ends: it may not show the order, so another one follows at once
    await worker.idle();

    expect(fetchTradingState).toHaveBeenCalledTimes(2);
    expect(store.saveState).toHaveBeenCalledTimes(2);
  });

  test("in the seconds after an order the picture is renewed faster, then the usual pace returns", async () => {
    const { store, worker } = rig();
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();

    clock.t += 100;
    store.queue.push(command());
    await worker.pollCommandsOnce();
    await worker.idle();
    expect(store.saveState).toHaveBeenCalledTimes(2);

    clock.t += 300; // 400 ms after the first read: the next one is due at 450 ms
    expect(await worker.refreshStatesOnce()).toBe(0);
    clock.t += 100; // 500 ms: the hot pace (350 ms) is due - the usual one would wait until 1.1 s
    expect(await worker.refreshStatesOnce()).toBe(1);
    await worker.idle();

    clock.t += 6_000; // long after the hot window
    expect(await worker.refreshStatesOnce()).toBe(1);
    await worker.idle();
    clock.t += 400;
    expect(await worker.refreshStatesOnce()).toBe(0); // back to once a second
    clock.t += 700;
    expect(await worker.refreshStatesOnce()).toBe(1);
    await worker.idle();
  });
});

describe("a modify reads the levels from the picture of a moment ago", () => {
  const watched: WatchedAccount = { accountId: ACCOUNT, userId: USER, symbols: [] };
  const modify = (id = "cccccccc-0000-4000-8000-000000000001") =>
    command({ id, kind: "MODIFY", payload: { ticket: "5001", takeProfit: 2420 } });

  test("no read at the broker is needed in front of the change", async () => {
    const { store, adapter, worker } = rig();
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();

    clock.t += 200;
    store.queue.push(modify());
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.modifyTrade).toHaveBeenCalledWith(
      expect.objectContaining({ brokerPositionId: "5001", stopLoss: 2380, takeProfit: 2420 }),
    );
    const answer = store.complete.mock.calls[0][1];
    expect(answer.timing?.readMs).toBeUndefined();
    expect(answer.detail).toMatchObject({ stopLoss: 2380, takeProfit: 2420 });
  });

  test("a picture that is more than a moment old is not trusted", async () => {
    const { store, worker } = rig();
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();

    clock.t += 3_000;
    store.queue.push(modify());
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.complete.mock.calls[0][1].timing?.readMs).toEqual(expect.any(Number));
  });

  test("an account nobody has a picture of is read first", async () => {
    const { store, adapter, worker } = rig();
    store.queue.push(modify());

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.fetchTradingState).toHaveBeenCalledTimes(1);
    expect(store.complete.mock.calls[0][1].timing?.readMs).toEqual(expect.any(Number));
  });

  test("the picture from before an order is dropped when that order ends", async () => {
    const afterOrder = deferred<BrokerTradingState>();
    const fetchTradingState = vi
      .fn<() => Promise<BrokerTradingState>>()
      .mockImplementationOnce(async () => tradingState()) // the picture before the order
      .mockImplementationOnce(() => afterOrder.promise) // the read right after the order, still on its way
      .mockImplementation(async () => tradingState()); // what the modify reads itself
    const { store, worker } = rig({ adapter: { fetchTradingState } });
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();

    clock.t += 100;
    store.queue.push(command());
    await worker.pollCommandsOnce();
    await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(1));

    clock.t += 50;
    store.queue.push(modify(SECOND_ID));
    await worker.pollCommandsOnce();
    await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(2));

    expect(store.complete.mock.calls[1][1].timing?.readMs).toEqual(expect.any(Number));
    expect(fetchTradingState).toHaveBeenCalledTimes(3);

    afterOrder.resolve(tradingState());
    await worker.idle();
  });

  test("a picture whose read began before the last order ended is not trusted either", async () => {
    const first = deferred<BrokerTradingState>();
    const second = deferred<BrokerTradingState>();
    const fetchTradingState = vi
      .fn<() => Promise<BrokerTradingState>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementation(async () => tradingState());
    const { store, worker } = rig({ adapter: { fetchTradingState } });
    store.watched.mockResolvedValue([watched]);

    await worker.refreshStatesOnce(); // read 1 begins and hangs
    await vi.waitFor(() => expect(fetchTradingState).toHaveBeenCalledTimes(1));
    clock.t += 50;
    store.queue.push(command()); // an order ends while it is in flight
    await worker.pollCommandsOnce();
    await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(1));

    clock.t += 10;
    first.resolve(tradingState()); // read 1 ends - it began before the order ended
    await vi.waitFor(() => expect(fetchTradingState).toHaveBeenCalledTimes(2)); // and read 2 begins at once

    store.queue.push(modify(SECOND_ID));
    await worker.pollCommandsOnce();
    await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(2));

    expect(store.complete.mock.calls[1][1].timing?.readMs).toEqual(expect.any(Number));
    expect(fetchTradingState).toHaveBeenCalledTimes(3);

    second.resolve(tradingState());
    await worker.idle();
  });
});

describe("the owner of a watched account", () => {
  const watched: WatchedAccount = { accountId: ACCOUNT, userId: USER, symbols: [] };

  test("is looked up before the first click, so the click does not pay for it", async () => {
    const { store, adapter, worker } = rig();
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();
    expect(store.owner).toHaveBeenCalledTimes(1);

    store.queue.push(command({ kind: "CLOSE", payload: { ticket: "5001" } }));
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.closeTrade).toHaveBeenCalledTimes(1);
    expect(store.owner).toHaveBeenCalledTimes(1);
  });

  test("is not looked up again on every tick", async () => {
    const { store, worker } = rig();
    store.watched.mockResolvedValue([watched]);

    for (let tick = 0; tick < 4; tick += 1) {
      await worker.refreshStatesOnce();
      await worker.idle();
      clock.t += 1_100;
    }

    expect(store.owner).toHaveBeenCalledTimes(1);
  });

  test("a lookup that fails is silent, is not hammered, and is tried again later", async () => {
    const { store, worker, warn } = rig();
    store.owner.mockRejectedValue(new Error("database is down"));
    store.watched.mockResolvedValue([watched]);

    await worker.refreshStatesOnce();
    await worker.idle();
    clock.t += 1_100;
    await worker.refreshStatesOnce();
    await worker.idle();
    expect(store.owner).toHaveBeenCalledTimes(1);

    clock.t += 31_000;
    await worker.refreshStatesOnce();
    await worker.idle();
    expect(store.owner).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  test("an account that is not connected to the broker service is not remembered, and a click on it still says so", async () => {
    const { store, adapter, worker } = rig();
    store.owner.mockResolvedValue({ userId: USER, providerAccountId: null });
    store.watched.mockResolvedValue([watched]);
    await worker.refreshStatesOnce();
    await worker.idle();

    store.queue.push(command());
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(store.fail.mock.calls[0][1]).toMatchObject({ code: "ACCOUNT_NOT_CONNECTED", statusCode: 409 });
    expect(store.owner).toHaveBeenCalledTimes(2);
  });

  test("what is remembered is the real owner: the watch row cannot vouch for somebody else's click", async () => {
    const { store, adapter, worker } = rig();
    store.watched.mockResolvedValue([{ ...watched, userId: "99999999-9999-4999-8999-999999999999" }]);
    await worker.refreshStatesOnce();
    await worker.idle();

    store.queue.push(command({ userId: "99999999-9999-4999-8999-999999999999" }));
    await worker.pollCommandsOnce();
    await worker.idle();

    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(store.fail.mock.calls[0][1]).toMatchObject({ code: "ACCOUNT_NOT_FOUND", statusCode: 404 });
  });
});

describe("the time of a command", () => {
  test("the stored answer and the log line say where it went", async () => {
    const { store, worker, log } = rig({
      adapter: {
        openTrade: vi.fn(async (request: { stages?: ExecutionStages }) => {
          clock.t += 340;
          if (request.stages) Object.assign(request.stages, { sessionMs: 12, sendMs: 310, attempts: 2 });
          return { ok: true, brokerPositionId: "9001" };
        }),
      },
    });
    store.queue.push(command());

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.complete.mock.calls[0][1].timing).toEqual({ queueMs: 120, runMs: 340, sessionMs: 12, sendMs: 310, attempts: 2 });
    expect(log).toHaveBeenCalledWith("[trade-gateway] OPEN aaaaaaaa done in 340ms (queue 120ms, session 12ms, send 310ms, 2 attempts)");
  });

  test("a failed order's log line carries the timing too", async () => {
    const { store, worker, log } = rig({
      adapter: {
        openTrade: vi.fn(async (request: { stages?: ExecutionStages }) => {
          if (request.stages) Object.assign(request.stages, { sessionMs: 0, sendMs: 95, attempts: 1 });
          throw new BrokerExecutionError("BROKER_PROVIDER_ERROR", "Not enough money.", 502);
        }),
      },
    });
    store.queue.push(command());

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.fail).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/failed in \d+ms \(queue 120ms, session 0ms, send 95ms\): BROKER_PROVIDER_ERROR/));
  });

  test("a modify that had to read says how long the read took", async () => {
    const { store, worker, log } = rig();
    store.queue.push(command({ kind: "MODIFY", payload: { ticket: "5001", takeProfit: 2420 } }));

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.complete.mock.calls[0][1].timing?.readMs).toEqual(expect.any(Number));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/MODIFY aaaaaaaa done in \d+ms \(queue 120ms, read \d+ms/));
  });

  test("a read of the account is not written to the log", async () => {
    const { store, worker, log } = rig();
    store.queue.push(command({ kind: "STATE", payload: { symbols: [] } }));

    await worker.pollCommandsOnce();
    await worker.idle();

    expect(store.complete).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("heartbeat and housekeeping", () => {
  test("the heartbeat says whether this worker can place orders", async () => {
    const { store, worker } = rig({ adapter: { executionAvailable: vi.fn(() => false) } });

    await worker.heartbeatOnce();

    expect(store.heartbeat).toHaveBeenCalledTimes(1);
    const [workerId, startedAt, info, at] = store.heartbeat.mock.calls[0];
    expect(workerId).toBe("worker-1");
    expect(startedAt).toBeInstanceOf(Date);
    expect(info).toMatchObject({ executionAvailable: false, watching: 0, commandsRun: 0, commandsFailed: 0 });
    expect(at.getTime()).toBe(clock.t);
  });

  test("the counters follow the work", async () => {
    const { store, worker } = rig();
    store.queue.push(command());
    store.queue.push(command({ id: "cccccccc-0000-4000-8000-000000000002", kind: "DROP", payload: {} }));
    await worker.pollCommandsOnce();
    await worker.idle();

    await worker.heartbeatOnce();

    expect(store.heartbeat.mock.calls[0][2]).toMatchObject({ commandsRun: 1, commandsFailed: 1 });
  });

  test("the sweep is written to the log only when it did something", async () => {
    const { store, worker, log } = rig();

    await worker.sweepOnce();
    expect(log).not.toHaveBeenCalled();

    store.sweep.mockResolvedValue({ expired: 2, lost: 1, purged: 40 });
    await worker.sweepOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2 expired, 1 lost, 40 old rows removed"));
  });
});

describe("the running loops", () => {
  test("take a command, write the heartbeat and take the worker off the heartbeat on stop", async () => {
    const store = makeStore();
    const adapter = makeAdapter();
    const worker = startGatewayWorker({
      store,
      adapter: adapter as unknown as BrokerAdapter,
      workerId: "worker-loop",
      log: vi.fn(),
      warn: vi.fn(),
      now,
      pollMs: 50,
      idlePollMs: 50,
      watchListMs: 250,
    });
    try {
      store.queue.push(command());
      await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      await vi.waitFor(() => expect(store.heartbeat).toHaveBeenCalled(), { timeout: 3_000 });
      expect(store.sweep).toHaveBeenCalled();
      expect(store.watched).toHaveBeenCalled();
    } finally {
      await worker.stop();
    }
    expect(store.retire).toHaveBeenCalledWith("worker-loop");

    const claims = store.claim.mock.calls.length;
    await settle(150);
    expect(store.claim.mock.calls.length).toBe(claims);
  });

  test("a second start does nothing and a stop without a start is harmless", async () => {
    const store = makeStore();
    const worker = new GatewayWorker({
      store,
      adapter: makeAdapter() as unknown as BrokerAdapter,
      workerId: "worker-idle",
      log: vi.fn(),
      warn: vi.fn(),
      now,
      pollMs: 50,
      idlePollMs: 50,
    });

    await worker.stop();
    expect(store.retire).not.toHaveBeenCalled();

    worker.start();
    worker.start();
    await settle(30);
    await worker.stop();
    await worker.stop();

    expect(store.retire).toHaveBeenCalledTimes(1);
  });

  test("a polling error is reported and the loop keeps going", async () => {
    const store = makeStore();
    const warn = vi.fn();
    store.claim.mockRejectedValueOnce(new Error("network down"));
    const worker = startGatewayWorker({
      store,
      adapter: makeAdapter() as unknown as BrokerAdapter,
      workerId: "worker-loop",
      log: vi.fn(),
      warn,
      now,
      pollMs: 50,
      idlePollMs: 50,
    });
    try {
      store.queue.push(command());
      await vi.waitFor(() => expect(store.complete).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("polling for commands failed: network down"));
    } finally {
      await worker.stop();
    }
  });
});
