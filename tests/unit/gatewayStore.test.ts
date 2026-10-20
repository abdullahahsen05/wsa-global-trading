import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import {
  CLAIM_FUNCTION,
  CLAIM_WAIT_FUNCTION,
  COMMANDS_TABLE,
  GatewayNotInstalledError,
  HEARTBEAT_TABLE,
  LongPollUnavailableError,
  STATE_TABLE,
  SYMBOLS_TABLE,
} from "@/lib/gateway/gatewayDb";
import { createSupabaseGatewayStore, KEEP_COMMANDS_MS, KEEP_STATE_MS, LOST_AFTER_MS } from "@/lib/gateway/gatewayStore";
import { MemoryDb, memoryClient, type Row } from "./helpers/memoryDb";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const NOW = new Date("2026-10-12T12:00:00.000Z");

const db = new MemoryDb();
const store = createSupabaseGatewayStore(memoryClient(db));

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function commandRow(overrides: Row = {}): Row {
  return {
    id: "cccccccc-0000-4000-8000-000000000001",
    user_id: USER,
    account_id: ACCOUNT,
    kind: "OPEN",
    payload: { symbol: "EURUSD", side: "BUY", volume: 0.1 },
    client_request_id: "request-1",
    status: "RUNNING",
    result: null,
    error_code: null,
    error_message: null,
    created_at: ago(500),
    expires_at: new Date(NOW.getTime() + 90_000).toISOString(),
    claimed_at: ago(100),
    claimed_by: "worker-1",
    completed_at: null,
    ...overrides,
  };
}

function rowOf(table: string, id: string, column = "id"): Row | undefined {
  return (db.tables[table] ?? []).find((row) => row[column] === id);
}

beforeEach(() => {
  db.reset();
});

describe("claiming commands", () => {
  test("asks the database for a batch for this worker and maps the rows", async () => {
    const asked: Row[] = [];
    db.rpcHandlers[CLAIM_FUNCTION] = (args) => {
      asked.push(args);
      return { data: [commandRow()], error: null };
    };

    const claimed = await store.claim("worker-1", 10);

    expect(asked).toEqual([{ p_worker: "worker-1", p_limit: 10 }]);
    expect(claimed).toEqual([
      {
        id: "cccccccc-0000-4000-8000-000000000001",
        userId: USER,
        accountId: ACCOUNT,
        kind: "OPEN",
        payload: { symbol: "EURUSD", side: "BUY", volume: 0.1 },
        clientRequestId: "request-1",
        createdAt: ago(500),
        expiresAt: new Date(NOW.getTime() + 90_000).toISOString(),
      },
    ]);
  });

  test("nothing waiting is an empty list", async () => {
    db.rpcHandlers[CLAIM_FUNCTION] = () => ({ data: null, error: null });
    expect(await store.claim("worker-1", 10)).toEqual([]);
  });

  test("a database without migration 060 raises the 'not installed' error", async () => {
    // the in-memory client answers an unknown function like PostgREST does (PGRST202)
    await expect(store.claim("worker-1", 10)).rejects.toBeInstanceOf(GatewayNotInstalledError);
  });

  test("any other database error is an ordinary error", async () => {
    db.rpcHandlers[CLAIM_FUNCTION] = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    const failure = await store.claim("worker-1", 10).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GatewayNotInstalledError);
    expect(failure.message).toContain("statement timeout");
  });
});

describe("claiming commands by waiting inside the database (migration 062)", () => {
  test("asks the wait function with the worker, the batch size and how long it may wait - and maps the rows like a plain claim", async () => {
    const asked: Row[] = [];
    db.rpcHandlers[CLAIM_WAIT_FUNCTION] = (args) => {
      asked.push(args);
      return { data: [commandRow()], error: null };
    };

    const claimed = await store.claimWait?.("worker-1", 10, 1_000);

    expect(asked).toEqual([{ p_worker: "worker-1", p_limit: 10, p_wait_ms: 1_000 }]);
    expect(claimed).toHaveLength(1);
    expect(claimed?.[0]).toMatchObject({
      id: "cccccccc-0000-4000-8000-000000000001",
      userId: USER,
      accountId: ACCOUNT,
      kind: "OPEN",
      clientRequestId: "request-1",
    });
  });

  test("a wait that ends with nothing is an empty list", async () => {
    db.rpcHandlers[CLAIM_WAIT_FUNCTION] = () => ({ data: null, error: null });
    expect(await store.claimWait?.("worker-1", 10, 1_000)).toEqual([]);

    db.rpcHandlers[CLAIM_WAIT_FUNCTION] = () => ({ data: [], error: null });
    expect(await store.claimWait?.("worker-1", 10, 1_000)).toEqual([]);
  });

  test("without 062 only the wait function is missing: the caller is told so and can go on with the plain claim", async () => {
    // the in-memory client answers an unknown function like PostgREST does (PGRST202, naming the function)
    await expect(store.claimWait?.("worker-1", 10, 1_000)).rejects.toBeInstanceOf(LongPollUnavailableError);
    await expect(store.claimWait?.("worker-1", 10, 1_000)).rejects.not.toBeInstanceOf(GatewayNotInstalledError);

    db.rpcHandlers[CLAIM_FUNCTION] = () => ({ data: [commandRow()], error: null });
    expect(await store.claim("worker-1", 10)).toHaveLength(1);
  });

  test("a missing gateway (migration 060) is still the gateway's error", async () => {
    db.rpcHandlers[CLAIM_WAIT_FUNCTION] = () => ({
      data: null,
      error: { code: "42P01", message: 'relation "trade_commands" does not exist' },
    });

    await expect(store.claimWait?.("worker-1", 10, 1_000)).rejects.toBeInstanceOf(GatewayNotInstalledError);
  });

  test("any other database error is an ordinary error with its sentence", async () => {
    db.rpcHandlers[CLAIM_WAIT_FUNCTION] = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    const failure = await store.claimWait?.("worker-1", 10, 1_000).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GatewayNotInstalledError);
    expect(failure).not.toBeInstanceOf(LongPollUnavailableError);
    expect(failure.message).toContain("statement timeout");
  });
});

describe("who owns an account", () => {
  test("returns the owner and the broker account id", async () => {
    db.tables.trading_accounts = [{ id: ACCOUNT, user_id: USER, provider_account_id: "provider-1" }];
    expect(await store.owner(ACCOUNT)).toEqual({ userId: USER, providerAccountId: "provider-1" });
  });

  test("an unknown account is null, a broken read an error", async () => {
    db.tables.trading_accounts = [];
    expect(await store.owner(ACCOUNT)).toBeNull();

    db.errors.trading_accounts = { message: "permission denied" };
    await expect(store.owner(ACCOUNT)).rejects.toThrow("could not read the account");
  });
});

describe("storing the answer", () => {
  test("a finished command becomes DONE with its result", async () => {
    db.tables[COMMANDS_TABLE] = [commandRow()];

    await store.complete("cccccccc-0000-4000-8000-000000000001", { ticket: "9001", timing: { queueMs: 12, runMs: 40 } });

    expect(rowOf(COMMANDS_TABLE, "cccccccc-0000-4000-8000-000000000001")).toMatchObject({
      status: "DONE",
      result: { ticket: "9001", timing: { queueMs: 12, runMs: 40 } },
      completed_at: expect.any(String),
    });
  });

  test("a command that is not RUNNING any more is left alone", async () => {
    db.tables[COMMANDS_TABLE] = [commandRow({ status: "FAILED", error_code: "WORKER_LOST", result: { statusCode: 504 } })];

    await store.complete("cccccccc-0000-4000-8000-000000000001", { ticket: "9001" });
    await store.fail("cccccccc-0000-4000-8000-000000000001", { code: "BROKER_ERROR", message: "x", statusCode: 502 });

    expect(rowOf(COMMANDS_TABLE, "cccccccc-0000-4000-8000-000000000001")).toMatchObject({
      status: "FAILED",
      error_code: "WORKER_LOST",
      result: { statusCode: 504 },
    });
  });

  test("a failure keeps its code, its sentence (cut at 500 characters) and its HTTP status", async () => {
    db.tables[COMMANDS_TABLE] = [commandRow()];

    await store.fail("cccccccc-0000-4000-8000-000000000001", {
      code: "BROKER_PROVIDER_ERROR",
      message: "x".repeat(900),
      statusCode: 502,
    });

    const row = rowOf(COMMANDS_TABLE, "cccccccc-0000-4000-8000-000000000001");
    expect(row).toMatchObject({ status: "FAILED", error_code: "BROKER_PROVIDER_ERROR", result: { statusCode: 502 } });
    expect((row?.error_message as string).length).toBe(500);
  });

  test("a missing table is reported as 'not installed'", async () => {
    db.errors[COMMANDS_TABLE] = { code: "42P01", message: 'relation "trade_commands" does not exist' };

    await expect(store.complete("x", { ticket: "1" })).rejects.toBeInstanceOf(GatewayNotInstalledError);
    await expect(store.fail("x", { code: "A", message: "b", statusCode: 400 })).rejects.toBeInstanceOf(GatewayNotInstalledError);
  });
});

describe("housekeeping", () => {
  test("expires what nobody picked up, fails what a dead worker left running, deletes what is old", async () => {
    db.tables[COMMANDS_TABLE] = [
      commandRow({ id: "pending-late", status: "PENDING", claimed_at: null, claimed_by: null, expires_at: ago(1_000) }),
      commandRow({ id: "pending-fresh", status: "PENDING", claimed_at: null, claimed_by: null, expires_at: new Date(NOW.getTime() + 60_000).toISOString() }),
      commandRow({ id: "running-lost", status: "RUNNING", claimed_at: ago(LOST_AFTER_MS + 1_000) }),
      commandRow({ id: "running-fresh", status: "RUNNING", claimed_at: ago(5_000) }),
      commandRow({ id: "done-old", status: "DONE", completed_at: ago(KEEP_COMMANDS_MS + 1_000) }),
      commandRow({ id: "done-recent", status: "DONE", completed_at: ago(3_600_000) }),
      commandRow({ id: "failed-old", status: "FAILED", completed_at: ago(KEEP_COMMANDS_MS + 5_000) }),
    ];
    db.tables[STATE_TABLE] = [
      { account_id: "state-old", watch_until: ago(KEEP_STATE_MS + 1_000) },
      { account_id: "state-fresh", watch_until: ago(60_000) },
    ];
    db.tables[HEARTBEAT_TABLE] = [
      { worker: "dead-worker", updated_at: ago(KEEP_STATE_MS + 1_000) },
      { worker: "live-worker", updated_at: ago(2_000) },
    ];

    const result = await store.sweep(NOW);

    expect(result).toEqual({ expired: 1, lost: 1, purged: 4 });
    expect(rowOf(COMMANDS_TABLE, "pending-late")).toMatchObject({ status: "EXPIRED", error_code: "NOT_SENT", result: { statusCode: 504 } });
    expect(rowOf(COMMANDS_TABLE, "pending-fresh")).toMatchObject({ status: "PENDING" });
    expect(rowOf(COMMANDS_TABLE, "running-lost")).toMatchObject({ status: "FAILED", error_code: "WORKER_LOST" });
    expect(rowOf(COMMANDS_TABLE, "running-fresh")).toMatchObject({ status: "RUNNING" });
    expect(rowOf(COMMANDS_TABLE, "done-old")).toBeUndefined();
    expect(rowOf(COMMANDS_TABLE, "failed-old")).toBeUndefined();
    expect(rowOf(COMMANDS_TABLE, "done-recent")).toBeDefined();
    expect(rowOf(STATE_TABLE, "state-old", "account_id")).toBeUndefined();
    expect(rowOf(STATE_TABLE, "state-fresh", "account_id")).toBeDefined();
    expect(rowOf(HEARTBEAT_TABLE, "dead-worker", "worker")).toBeUndefined();
    expect(rowOf(HEARTBEAT_TABLE, "live-worker", "worker")).toBeDefined();
  });

  test("a running order is never put back in the queue: a lost worker's command ends as FAILED", async () => {
    db.tables[COMMANDS_TABLE] = [commandRow({ id: "running-lost", status: "RUNNING", claimed_at: ago(LOST_AFTER_MS + 1_000) })];

    await store.sweep(NOW);

    const row = rowOf(COMMANDS_TABLE, "running-lost");
    expect(row?.status).toBe("FAILED");
    expect(row?.error_message).toContain("Check the open positions before sending it again");
  });

  test("a quiet database is an empty result", async () => {
    expect(await store.sweep(NOW)).toEqual({ expired: 0, lost: 0, purged: 0 });
  });
});

describe("watched accounts", () => {
  test("lists the accounts somebody is looking at, with the symbols on screen", async () => {
    db.tables[STATE_TABLE] = [
      { account_id: ACCOUNT, user_id: USER, watch_until: new Date(NOW.getTime() + 30_000).toISOString(), watch_symbols: ["EURUSD.r", 5, "XAUUSD"] },
      { account_id: "expired", user_id: USER, watch_until: ago(1_000), watch_symbols: ["GBPUSD"] },
      { account_id: "no-symbols", user_id: USER, watch_until: new Date(NOW.getTime() + 5_000).toISOString(), watch_symbols: null },
    ];

    expect(await store.watched(NOW)).toEqual([
      { accountId: ACCOUNT, userId: USER, symbols: ["EURUSD.r", "XAUUSD"] },
      { accountId: "no-symbols", userId: USER, symbols: [] },
    ]);
  });
});

describe("the live picture", () => {
  const picture = {
    currency: "USD",
    balance: 10_000,
    equity: 10_010,
    floatingProfit: 10,
    margin: 100,
    freeMargin: 9_910,
    marginLevel: 10_010,
    positions: [],
    pending: [],
    pendingOrders: 0,
    fetchedAt: NOW.toISOString(),
    quotes: {},
  };

  test("a reading replaces the picture and clears an old error", async () => {
    db.tables[STATE_TABLE] = [{ account_id: ACCOUNT, state: null, error: "old trouble", error_at: ago(10_000) }];

    await store.saveState(ACCOUNT, picture, null, NOW);

    expect(rowOf(STATE_TABLE, ACCOUNT, "account_id")).toMatchObject({
      state: picture,
      state_at: NOW.toISOString(),
      error: null,
      error_at: null,
    });
  });

  test("a failed reading keeps the last picture and records the trouble", async () => {
    db.tables[STATE_TABLE] = [{ account_id: ACCOUNT, state: picture, state_at: ago(8_000), error: null, error_at: null }];

    await store.saveState(ACCOUNT, null, "Broker not reachable.", NOW);

    expect(rowOf(STATE_TABLE, ACCOUNT, "account_id")).toMatchObject({
      state: picture,
      state_at: ago(8_000),
      error: "Broker not reachable.",
      error_at: NOW.toISOString(),
    });
  });

  test("a reading for an account nobody watches creates nothing", async () => {
    await store.saveState(ACCOUNT, picture, null, NOW);
    expect(db.tables[STATE_TABLE] ?? []).toEqual([]);
  });

  test("an empty or very long error is stored in a readable form", async () => {
    db.tables[STATE_TABLE] = [{ account_id: ACCOUNT }];

    await store.saveState(ACCOUNT, null, null, NOW);
    expect(rowOf(STATE_TABLE, ACCOUNT, "account_id")?.error).toBe("The account could not be read.");

    await store.saveState(ACCOUNT, null, "y".repeat(2_000), NOW);
    expect((rowOf(STATE_TABLE, ACCOUNT, "account_id")?.error as string).length).toBe(500);
  });
});

describe("symbols, heartbeat and retiring", () => {
  test("the symbol list of an account is replaced as a whole", async () => {
    await store.saveSymbols(ACCOUNT, [{ name: "EURUSD.r", description: "Euro", path: null, digits: 5 }], NOW);
    await store.saveSymbols(ACCOUNT, [{ name: "XAUUSD", description: "Gold", path: null, digits: 2 }], NOW);

    expect(db.tables[SYMBOLS_TABLE]).toHaveLength(1);
    expect(rowOf(SYMBOLS_TABLE, ACCOUNT, "account_id")).toMatchObject({
      symbols: [{ name: "XAUUSD", description: "Gold", path: null, digits: 2 }],
      updated_at: NOW.toISOString(),
    });
  });

  test("a worker has one heartbeat row, renewed in place", async () => {
    const started = new Date("2026-10-12T11:00:00.000Z");
    await store.heartbeat("worker-1", started, { executionAvailable: true }, NOW);
    await store.heartbeat("worker-1", started, { executionAvailable: false }, new Date(NOW.getTime() + 5_000));

    expect(db.tables[HEARTBEAT_TABLE]).toHaveLength(1);
    expect(rowOf(HEARTBEAT_TABLE, "worker-1", "worker")).toMatchObject({
      role: "trade-gateway",
      started_at: started.toISOString(),
      updated_at: new Date(NOW.getTime() + 5_000).toISOString(),
      info: { executionAvailable: false },
    });
  });

  test("a worker that stops takes its row away and leaves the others", async () => {
    await store.heartbeat("worker-1", NOW, {}, NOW);
    await store.heartbeat("worker-2", NOW, {}, NOW);

    await store.retire("worker-1");

    expect((db.tables[HEARTBEAT_TABLE] ?? []).map((row) => row.worker)).toEqual(["worker-2"]);
  });
});
