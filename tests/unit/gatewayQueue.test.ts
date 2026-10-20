import { beforeEach, describe, expect, test } from "vitest";
import {
  gatewayKnownMissing,
  GatewayNotInstalledError,
  LONG_POLL_TROUBLE_PAUSE_MS,
  longPollKnownOff,
  LongPollUnavailableError,
  resetGatewayState,
  WATCH_MS,
} from "@/lib/gateway/gatewayDb";
import {
  abandonCommand,
  awaitCommand,
  commandAnswer,
  enqueueCommand,
  gatewayAvailability,
  keepWatching,
  mergeWatchSymbols,
  readAccountWatch,
  readStoredSymbols,
  resetGatewayAvailability,
  waitForCommand,
  type WatchRow,
} from "@/lib/gateway/gatewayQueue";
import { MemoryDb, memoryClient } from "./helpers/memoryDb";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const db = new MemoryDb();
const client = memoryClient(db);

let counter = 0;

beforeEach(() => {
  db.reset();
  counter = 0;
  resetGatewayState();
  resetGatewayAvailability();
  db.unique.trade_commands = [["user_id", "client_request_id"]];
  db.defaults.trade_commands = () => {
    counter += 1;
    return {
      id: `cmd-${counter}`,
      status: "PENDING",
      result: null,
      error_code: null,
      error_message: null,
      created_at: new Date(Date.UTC(2026, 9, 12, 10, 0, counter)).toISOString(),
      completed_at: null,
    };
  };
});

const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("is the AWS system there?", () => {
  test("no heartbeat: offline; a fresh one: online, with the execution switch it reports", async () => {
    db.tables.gateway_heartbeat = [];
    expect(await gatewayAvailability(client, NOW)).toEqual({ state: "offline" });

    resetGatewayAvailability();
    db.tables.gateway_heartbeat = [{ worker: "w1", updated_at: iso(-5_000), info: { executionAvailable: true } }];
    expect(await gatewayAvailability(client, NOW)).toEqual({ state: "online", workers: 1, executionEnabled: true });
  });

  test("a heartbeat older than twenty seconds is a worker that is gone", async () => {
    db.tables.gateway_heartbeat = [{ worker: "w1", updated_at: iso(-25_000), info: {} }];
    expect(await gatewayAvailability(client, NOW)).toEqual({ state: "offline" });
  });

  test("a worker that reports the switch off is online but cannot execute; an older one counts as enabled", async () => {
    db.tables.gateway_heartbeat = [{ worker: "w1", updated_at: iso(-1_000), info: { executionAvailable: false } }];
    expect(await gatewayAvailability(client, NOW)).toMatchObject({ state: "online", executionEnabled: false });

    resetGatewayAvailability();
    db.tables.gateway_heartbeat = [{ worker: "w1", updated_at: iso(-1_000), info: {} }];
    expect(await gatewayAvailability(client, NOW)).toMatchObject({ state: "online", executionEnabled: true });
  });

  test("a missing table means 'not installed' - remembered, so the database is not asked again", async () => {
    db.errors.gateway_heartbeat = { code: "42P01", message: 'relation "gateway_heartbeat" does not exist' };
    expect(await gatewayAvailability(client, NOW)).toEqual({ state: "not_installed" });

    const asked = db.callsTo("gateway_heartbeat").length;
    expect(await gatewayAvailability(client, NOW + 1_000)).toEqual({ state: "not_installed" });
    expect(db.callsTo("gateway_heartbeat")).toHaveLength(asked);
  });

  test("while a worker reports in the answer is kept for six seconds - an order does not ask the heartbeat itself", async () => {
    db.tables.gateway_heartbeat = [{ worker: "w1", updated_at: iso(-1_000), info: {} }];
    await gatewayAvailability(client, NOW);
    await gatewayAvailability(client, NOW + 5_500);
    expect(db.callsTo("gateway_heartbeat")).toHaveLength(1);
    await gatewayAvailability(client, NOW + 6_500);
    expect(db.callsTo("gateway_heartbeat")).toHaveLength(2);
  });

  test("while nobody is there it is asked again after two seconds, so a worker that has just started is noticed at once", async () => {
    db.tables.gateway_heartbeat = [];
    await gatewayAvailability(client, NOW);
    await gatewayAvailability(client, NOW + 1_500);
    expect(db.callsTo("gateway_heartbeat")).toHaveLength(1);
    await gatewayAvailability(client, NOW + 2_500);
    expect(db.callsTo("gateway_heartbeat")).toHaveLength(2);
  });

  test("a caller can ask for a younger answer than the usual keep time (the panel's background upkeep does)", async () => {
    db.tables.gateway_heartbeat = [{ worker: "w1", updated_at: iso(-1_000), info: {} }];
    await gatewayAvailability(client, NOW);

    await gatewayAvailability(client, NOW + 2_000, 3_000);
    expect(db.callsTo("gateway_heartbeat")).toHaveLength(1);

    await gatewayAvailability(client, NOW + 3_500, 3_000);
    expect(db.callsTo("gateway_heartbeat")).toHaveLength(2);

    // a larger limit never makes the answer older than the usual keep time
    await gatewayAvailability(client, NOW + 3_500 + 7_000, 60_000);
    expect(db.callsTo("gateway_heartbeat")).toHaveLength(3);
  });

  test("the newest worker's own measurements come with the answer: round trip to the database, event-loop lateness, waiting inside the database", async () => {
    db.tables.gateway_heartbeat = [
      { worker: "old", updated_at: iso(-9_000), info: { executionAvailable: true, dbRttMs: 400, loopLagMs: 90, longPoll: false } },
      { worker: "new", updated_at: iso(-1_000), info: { executionAvailable: true, dbRttMs: 14.4, loopLagMs: 3, longPoll: true } },
    ];

    expect(await gatewayAvailability(client, NOW)).toEqual({
      state: "online",
      workers: 2,
      executionEnabled: true,
      awsDbMs: 14,
      awsLoopMs: 3,
      awsLongPoll: true,
    });
  });

  test("an older worker reports none of it, and nonsense is left out", async () => {
    db.tables.gateway_heartbeat = [{ worker: "w1", updated_at: iso(-1_000), info: { executionAvailable: true } }];
    expect(await gatewayAvailability(client, NOW)).toEqual({ state: "online", workers: 1, executionEnabled: true });

    resetGatewayAvailability();
    db.tables.gateway_heartbeat = [
      { worker: "w1", updated_at: iso(-1_000), info: { dbRttMs: -5, loopLagMs: "slow", longPoll: "yes" } },
    ];
    expect(await gatewayAvailability(client, NOW)).toEqual({ state: "online", workers: 1, executionEnabled: true });
  });

  test("another database failure is 'offline', not an exception", async () => {
    db.errors.gateway_heartbeat = { code: "08006", message: "connection lost" };
    expect(await gatewayAvailability(client, NOW)).toEqual({ state: "offline" });
  });
});

describe("writing a command", () => {
  const base = { userId: USER, accountId: ACCOUNT, kind: "OPEN" as const, payload: { symbol: "EURUSD" }, clientRequestId: "request-0001" };

  test("one row, pending, for this user and account", async () => {
    const queued = await enqueueCommand(client, base, NOW);

    expect(queued.existing).toBe(false);
    expect(queued.row.status).toBe("PENDING");
    expect(db.tables.trade_commands).toHaveLength(1);
    expect(db.tables.trade_commands[0]).toMatchObject({
      user_id: USER,
      account_id: ACCOUNT,
      kind: "OPEN",
      payload: { symbol: "EURUSD" },
      client_request_id: "request-0001",
    });
  });

  test("the same click sent twice is one command", async () => {
    const first = await enqueueCommand(client, base, NOW);
    const second = await enqueueCommand(client, { ...base, payload: { symbol: "GBPUSD" } }, NOW);

    expect(second.existing).toBe(true);
    expect(second.row.id).toBe(first.row.id);
    expect(db.tables.trade_commands).toHaveLength(1);
    expect(db.tables.trade_commands[0].payload).toEqual({ symbol: "EURUSD" });
  });

  test("another user may use the same request id", async () => {
    await enqueueCommand(client, base, NOW);
    const other = await enqueueCommand(client, { ...base, userId: "22222222-2222-4222-8222-222222222222" }, NOW);

    expect(other.existing).toBe(false);
    expect(db.tables.trade_commands).toHaveLength(2);
  });

  test("a read command can be given a short life", async () => {
    await enqueueCommand(client, { ...base, kind: "SYMBOLS", payload: {}, ttlMs: 30_000 }, NOW);

    expect(db.tables.trade_commands[0].expires_at).toBe(iso(30_000));
  });

  test("a missing table is the 'not installed' error", async () => {
    db.errors.trade_commands = { code: "PGRST205", message: "Could not find the table 'public.trade_commands'" };

    await expect(enqueueCommand(client, base, NOW)).rejects.toBeInstanceOf(GatewayNotInstalledError);
  });

  test("any other database failure is an error that says nothing was queued", async () => {
    db.errors.trade_commands = { code: "XX000", message: "disk full" };

    await expect(enqueueCommand(client, base, NOW)).rejects.toThrow(/could not queue/);
  });
});

describe("waiting for the answer", () => {
  function clock() {
    let now = NOW;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
  }

  test("returns the finished command as soon as the worker has written it", async () => {
    const queued = await enqueueCommand(client, { userId: USER, accountId: ACCOUNT, kind: "CLOSE", payload: {}, clientRequestId: "request-0002" }, NOW);
    const time = clock();
    let looks = 0;
    const sleep = async (ms: number) => {
      await time.sleep(ms);
      looks += 1;
      if (looks === 3) Object.assign(db.tables.trade_commands[0], { status: "DONE", result: { ticket: "5" } });
    };

    const row = await waitForCommand(client, queued.row.id, 10_000, { now: time.now, sleep });

    expect(row?.status).toBe("DONE");
    expect(looks).toBe(3);
  });

  test("gives up with null at the deadline", async () => {
    const queued = await enqueueCommand(client, { userId: USER, accountId: ACCOUNT, kind: "CLOSE", payload: {}, clientRequestId: "request-0003" }, NOW);
    const time = clock();

    const row = await waitForCommand(client, queued.row.id, 1_000, time);

    expect(row).toBeNull();
    expect(time.now() - NOW).toBeLessThanOrEqual(1_300);
  });

  test("a failed look is not an answer - the next one may work", async () => {
    const queued = await enqueueCommand(client, { userId: USER, accountId: ACCOUNT, kind: "CLOSE", payload: {}, clientRequestId: "request-0004" }, NOW);
    const time = clock();
    db.errors.trade_commands = { code: "08006", message: "connection lost" };
    let looks = 0;
    const sleep = async (ms: number) => {
      await time.sleep(ms);
      looks += 1;
      if (looks === 2) {
        delete db.errors.trade_commands;
        Object.assign(db.tables.trade_commands[0], { status: "FAILED", error_code: "X", error_message: "no" });
      }
    };

    const row = await waitForCommand(client, queued.row.id, 10_000, { now: time.now, sleep });

    expect(row?.status).toBe("FAILED");
  });

  test("giving up closes a command nobody has picked up, so it can never run later", async () => {
    const queued = await enqueueCommand(client, { userId: USER, accountId: ACCOUNT, kind: "OPEN", payload: {}, clientRequestId: "request-0005" }, NOW);

    expect(await abandonCommand(client, queued.row.id, NOW)).toBe("CANCELLED");
    expect(db.tables.trade_commands[0]).toMatchObject({ status: "EXPIRED", error_code: "NOT_SENT" });
  });

  test("a command a worker already took is 'running' - the order may exist", async () => {
    const queued = await enqueueCommand(client, { userId: USER, accountId: ACCOUNT, kind: "OPEN", payload: {}, clientRequestId: "request-0006" }, NOW);
    db.tables.trade_commands[0].status = "RUNNING";

    expect(await abandonCommand(client, queued.row.id, NOW)).toBe("RUNNING");
    expect(db.tables.trade_commands[0].status).toBe("RUNNING");
  });

  test("one that finished just now is 'finished'", async () => {
    const queued = await enqueueCommand(client, { userId: USER, accountId: ACCOUNT, kind: "OPEN", payload: {}, clientRequestId: "request-0007" }, NOW);
    db.tables.trade_commands[0].status = "DONE";

    expect(await abandonCommand(client, queued.row.id, NOW)).toBe("FINISHED");
  });
});

describe("waiting for the answer inside the database", () => {
  const DONE = { id: "cmd-1", status: "DONE", result: { ticket: "7" }, error_code: null, error_message: null };

  /** A clock the test moves: `sleep` and the (pretend) waiting of the database both advance it. */
  function clock() {
    let now = NOW;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
      sleep: async (ms: number) => {
        now += ms;
      },
    };
  }

  const input = { userId: USER, clientRequestId: "request-0010", timeoutMs: 24_000 };

  test("one call returns the finished command - found by user and request id, not by its id", async () => {
    const asked: Array<Record<string, unknown>> = [];
    db.rpcHandlers.await_trade_command = (args) => {
      asked.push(args);
      return { data: [DONE], error: null };
    };

    const row = await awaitCommand(client, input, clock());

    expect(row?.status).toBe("DONE");
    expect(asked).toEqual([{ p_user_id: USER, p_client_request_id: "request-0010", p_wait_ms: 2_500 }]);
  });

  test("a wait that ends with the command still running is repeated until the deadline, each call no longer than what is left", async () => {
    const time = clock();
    const waits: number[] = [];
    db.rpcHandlers.await_trade_command = (args) => {
      waits.push(args.p_wait_ms as number);
      time.advance(args.p_wait_ms as number); // the database really did wait
      return { data: [{ ...DONE, status: "RUNNING" }], error: null };
    };

    const row = await awaitCommand(client, { ...input, timeoutMs: 6_000 }, time);

    expect(row).toBeNull();
    expect(waits).toEqual([2_500, 2_500, 1_000]);
  });

  test("a command that is not written yet (the wait began together with the write) is just another round", async () => {
    const time = clock();
    let calls = 0;
    db.rpcHandlers.await_trade_command = () => {
      calls += 1;
      return { data: calls === 1 ? [] : [DONE], error: null };
    };

    const row = await awaitCommand(client, input, time);

    expect(row?.status).toBe("DONE");
    expect(calls).toBe(2);
  });

  test("a call that comes back at once without an answer is not repeated in a tight loop", async () => {
    const time = clock();
    let calls = 0;
    db.rpcHandlers.await_trade_command = () => {
      calls += 1;
      return { data: [], error: null };
    };

    const row = await awaitCommand(client, { ...input, timeoutMs: 300 }, time);

    expect(row).toBeNull();
    expect(calls).toBeLessThanOrEqual(12);
    expect(calls).toBeGreaterThan(1);
  });

  test("a wait the caller no longer needs stops at its next look", async () => {
    const stop = new AbortController();
    let calls = 0;
    db.rpcHandlers.await_trade_command = () => {
      calls += 1;
      stop.abort();
      return { data: [], error: null };
    };

    const row = await awaitCommand(client, { ...input, signal: stop.signal }, clock());

    expect(row).toBeNull();
    expect(calls).toBe(1);

    calls = 0;
    expect(await awaitCommand(client, { ...input, signal: stop.signal }, clock())).toBeNull();
    expect(calls).toBe(0);
  });

  test("without migration 062 it says so and remembers it for ten minutes - the next wait does not even ask", async () => {
    const time = clock();

    await expect(awaitCommand(client, input, time)).rejects.toBeInstanceOf(LongPollUnavailableError);
    expect(longPollKnownOff(NOW + 5 * 60_000)).toBe(true);
    expect(longPollKnownOff(NOW + 11 * 60_000)).toBe(false);

    let asked = 0;
    db.rpcHandlers.await_trade_command = () => {
      asked += 1;
      return { data: [DONE], error: null };
    };
    await expect(awaitCommand(client, input, time)).rejects.toBeInstanceOf(LongPollUnavailableError);
    expect(asked).toBe(0);
  });

  test("any other failure (a time-out, a refused long statement, a dropped connection) sends the caller to the plain way only for a short while", async () => {
    db.rpcHandlers.await_trade_command = () => ({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });

    await expect(awaitCommand(client, input, clock())).rejects.toBeInstanceOf(LongPollUnavailableError);

    expect(longPollKnownOff(NOW + 10_000)).toBe(true);
    expect(longPollKnownOff(NOW + LONG_POLL_TROUBLE_PAUSE_MS + 1)).toBe(false);
  });

  test("a call that throws is the same", async () => {
    db.rpcHandlers.await_trade_command = () => {
      throw new Error("socket hang up");
    };

    await expect(awaitCommand(client, input, clock())).rejects.toThrow(/not available/);
    expect(longPollKnownOff(NOW + 1_000)).toBe(true);
  });

  test("a gateway that is not installed (migration 060) is the gateway's error, not the wait's", async () => {
    db.rpcHandlers.await_trade_command = () => ({
      data: null,
      error: { code: "42P01", message: 'relation "trade_commands" does not exist' },
    });

    await expect(awaitCommand(client, input, clock())).rejects.toBeInstanceOf(GatewayNotInstalledError);
    expect(gatewayKnownMissing(NOW + 1_000)).toBe(true);
    expect(longPollKnownOff(NOW + 1_000)).toBe(false);
  });
});

describe("an answer in words", () => {
  test("done: the outcome the worker stored", () => {
    expect(commandAnswer({ status: "DONE", result: { ticket: "9", timing: { queueMs: 120, runMs: 300 } }, error_code: null, error_message: null })).toEqual({
      ok: true,
      outcome: { ticket: "9", timing: { queueMs: 120, runMs: 300 } },
    });
  });

  test("failed: code, sentence and status as stored", () => {
    expect(commandAnswer({ status: "FAILED", result: { statusCode: 404 }, error_code: "POSITION_NOT_FOUND", error_message: "Gone." })).toEqual({
      ok: false,
      error: { code: "POSITION_NOT_FOUND", message: "Gone.", statusCode: 404 },
    });
  });

  test("expired: it was never sent; a missing or odd status falls back to 502", () => {
    const expired = commandAnswer({ status: "EXPIRED", result: null, error_code: null, error_message: null });
    expect(expired).toMatchObject({ ok: false, error: { code: "NOT_SENT" } });
    expect(commandAnswer({ status: "FAILED", result: { statusCode: 12 }, error_code: "X", error_message: "y" })).toMatchObject({
      error: { statusCode: 502 },
    });
  });
});

describe("the live picture of an account", () => {
  const stored = (overrides: Record<string, unknown> = {}) => ({
    account_id: ACCOUNT,
    user_id: USER,
    watch_until: iso(40_000),
    watch_symbols: ["XAUUSD"],
    state: { balance: 1 },
    state_at: iso(-500),
    error: null,
    error_at: null,
    ...overrides,
  });

  test("reads only the caller's row", async () => {
    db.tables.terminal_account_state = [stored(), stored({ account_id: "other", user_id: "someone-else" })];

    const row = await readAccountWatch(client, ACCOUNT, USER);
    expect(row).toMatchObject({ state: { balance: 1 }, stateAt: iso(-500), watchSymbols: ["XAUUSD"] });
    expect(await readAccountWatch(client, ACCOUNT, "someone-else")).toBeNull();
    const filters = db.callsTo("terminal_account_state")[0].filters;
    expect(filters).toContainEqual({ op: "eq", column: "user_id", value: USER });
  });

  test("symbols: the one on screen first, then the latest others, never more than five", () => {
    expect(mergeWatchSymbols("EURUSD", ["XAUUSD", "EURUSD", "GBPUSD"], true)).toEqual(["EURUSD", "XAUUSD", "GBPUSD"]);
    expect(mergeWatchSymbols("A1", ["B2", "C3", "D4", "E5", "F6"], true)).toEqual(["A1", "B2", "C3", "D4", "E5"]);
    expect(mergeWatchSymbols("EURUSD", ["XAUUSD"], false)).toEqual(["EURUSD"]);
    expect(mergeWatchSymbols(null, [], false)).toEqual([]);
  });

  test("a new watch is written for 45 seconds", async () => {
    await keepWatching(client, { accountId: ACCOUNT, userId: USER, symbol: "EURUSD", current: null }, NOW);

    expect(db.tables.terminal_account_state).toHaveLength(1);
    expect(db.tables.terminal_account_state[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: USER,
      watch_until: iso(WATCH_MS),
      watch_symbols: ["EURUSD"],
    });
  });

  test("a watch that still has plenty of time is not written again", async () => {
    const current: WatchRow = {
      state: null,
      stateAt: null,
      error: null,
      errorAt: null,
      watchUntil: iso(40_000),
      watchSymbols: ["EURUSD"],
    };
    await keepWatching(client, { accountId: ACCOUNT, userId: USER, symbol: "EURUSD", current }, NOW);

    expect(db.callsTo("terminal_account_state", "upsert")).toHaveLength(0);
  });

  test("a watch about to lapse is renewed and keeps its symbols; a new symbol is added in front", async () => {
    const current: WatchRow = {
      state: null,
      stateAt: null,
      error: null,
      errorAt: null,
      watchUntil: iso(10_000),
      watchSymbols: ["EURUSD", "XAUUSD"],
    };
    await keepWatching(client, { accountId: ACCOUNT, userId: USER, symbol: "XAUUSD", current }, NOW);
    expect(db.tables.terminal_account_state[0]).toMatchObject({ watch_until: iso(WATCH_MS), watch_symbols: ["EURUSD", "XAUUSD"] });

    await keepWatching(client, { accountId: ACCOUNT, userId: USER, symbol: "GBPUSD", current: { ...current, watchUntil: iso(40_000) } }, NOW);
    expect(db.tables.terminal_account_state[0].watch_symbols).toEqual(["GBPUSD", "EURUSD", "XAUUSD"]);
  });

  test("a watch that had lapsed starts again from the symbol on screen", async () => {
    const lapsed: WatchRow = {
      state: null,
      stateAt: null,
      error: null,
      errorAt: null,
      watchUntil: iso(-60_000),
      watchSymbols: ["OLD1", "OLD2"],
    };
    await keepWatching(client, { accountId: ACCOUNT, userId: USER, symbol: "EURUSD", current: lapsed }, NOW);

    expect(db.tables.terminal_account_state[0].watch_symbols).toEqual(["EURUSD"]);
  });

  test("the symbols the worker stored", async () => {
    expect(await readStoredSymbols(client, ACCOUNT)).toBeNull();
    db.tables.terminal_account_symbols = [{ account_id: ACCOUNT, symbols: [{ name: "XAUUSD" }], updated_at: iso(-1000) }];

    expect(await readStoredSymbols(client, ACCOUNT)).toEqual({ symbols: [{ name: "XAUUSD" }], updatedAt: iso(-1000) });
  });

  test("without the migration the picture and the symbols say 'not installed'", async () => {
    db.errors.terminal_account_state = { code: "42P01", message: "relation does not exist" };
    await expect(readAccountWatch(client, ACCOUNT, USER)).rejects.toBeInstanceOf(GatewayNotInstalledError);
  });
});
