import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { requireTrader } from "@/lib/auth/session";
import { BROKER_EXEC_ERROR, BrokerExecutionError, type BrokerAdapter } from "@/lib/broker/BrokerAdapter";
import { createBrokerAdapter } from "@/lib/broker/provider";
import { longPollKnownOff, resetGatewayState } from "@/lib/gateway/gatewayDb";
import { resetGatewayAvailability } from "@/lib/gateway/gatewayQueue";
import { createSupabaseGatewayStore } from "@/lib/gateway/gatewayStore";
import { GatewayWorker } from "@/lib/gateway/gatewayWorker";
import { writeAuditLog } from "@/lib/services/auditService";
import { getPlatformSubscriptionAccess, hasActivePlatformProductSubscription } from "@/lib/services/billingService";
import { getRiskEnforcementState } from "@/lib/services/riskService";
import { GET as listAccounts } from "@/app/api/terminal/trade/accounts/route";
import { GET as readState } from "@/app/api/terminal/trade/state/route";
import { GET as readSymbols } from "@/app/api/terminal/trade/symbols/route";
import { POST as openOrder } from "@/app/api/terminal/trade/open/route";
import { POST as modifyPosition } from "@/app/api/terminal/trade/modify/route";
import { POST as closePosition } from "@/app/api/terminal/trade/close/route";
import { POST as cancelOrder } from "@/app/api/terminal/trade/cancel/route";
import { POST as closeBulk } from "@/app/api/terminal/trade/close-bulk/route";
import { resetWebTradeCaches } from "@/lib/services/webTradeService";
import { WEB_TRADE_COMMENT } from "@/lib/trade/webTrade";
import { sharedClient, sharedDb as db } from "./helpers/memoryDb";
import {
  ACCOUNT,
  accountRow,
  FOREIGN_ACCOUNT,
  freshUserId,
  getRequest,
  LOSER,
  makeAdapter,
  openBody as openBodyFor,
  OTHER_USER,
  PENDING,
  POSITION,
  post,
  readJson,
  stateRequest,
  tradingState,
} from "./helpers/webTradeFixtures";

// WSA Trade through the trade gateway, end to end and in one process: the web routes write
// commands into the (in-memory) database, a REAL GatewayWorker takes them, runs them
// through a fake broker connection and writes the answer back - exactly what happens
// between Vercel, Supabase and the AWS worker. Only the clock of the web side is faked
// where a test needs to wait for a time-out.

vi.mock("@/lib/supabase/admin", async () => {
  const { sharedClient: client } = await import("./helpers/memoryDb");
  return { createAdminClient: () => client };
});

vi.mock("@/lib/auth/session", () => {
  class AuthError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly statusCode: number = 401,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  // (no token facts: the order routes then take the ordinary cached sign-in, not an order pass)
  return { AuthError, requireTrader: vi.fn(), currentTokenFacts: vi.fn(async () => null) };
});

vi.mock("@/lib/services/auditService", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/lib/services/billingService", () => ({
  getPlatformSubscriptionAccess: vi.fn(),
  hasActivePlatformProductSubscription: vi.fn(),
}));
vi.mock("@/lib/services/riskService", () => ({ getRiskEnforcementState: vi.fn() }));
vi.mock("@/lib/broker/provider", () => ({ createBrokerAdapter: vi.fn() }));

let USER = "";
let worker: GatewayWorker;
let workerAdapter = makeAdapter();

// ── the web server (Vercel): it has no broker bridge of its own ──────────────

function notConfigured(): never {
  throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED, "No broker bridge on this server.", 503);
}

function makeWebAdapter(overrides: Record<string, unknown> = {}) {
  return {
    executionAvailable: vi.fn(() => false),
    fetchTradingState: vi.fn(async () => notConfigured()),
    fetchQuote: vi.fn(async () => notConfigured()),
    fetchSymbolList: vi.fn(async () => notConfigured()),
    openTrade: vi.fn(async () => notConfigured()),
    closeTrade: vi.fn(async () => notConfigured()),
    modifyTrade: vi.fn(async () => notConfigured()),
    cancelOrder: vi.fn(async () => notConfigured()),
    ...overrides,
  };
}

let webAdapter = makeWebAdapter();

// ── the AWS side: a real worker with a fake broker connection ────────────────

function useWorkerAdapter(overrides: Record<string, unknown> = {}) {
  workerAdapter = makeAdapter(overrides);
  worker = new GatewayWorker({
    store: createSupabaseGatewayStore(sharedClient),
    adapter: workerAdapter as unknown as BrokerAdapter,
    workerId: "w1",
    log: () => undefined,
    warn: () => undefined,
    watchListMs: 250,
  });
}

/** The database side of migration 060: unique request ids, column defaults and the claim function. */
function installGatewayTables() {
  db.unique.trade_commands = [["user_id", "client_request_id"]];
  db.defaults.trade_commands = () => ({
    id: randomUUID(),
    status: "PENDING",
    result: null,
    error_code: null,
    error_message: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 90_000).toISOString(),
    claimed_at: null,
    claimed_by: null,
    completed_at: null,
  });
  db.rpcHandlers.claim_trade_commands = (args) => {
    const nowIso = new Date().toISOString();
    const rows = (db.tables.trade_commands ?? [])
      .filter((row) => row.status === "PENDING" && String(row.expires_at) > nowIso)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
      .slice(0, Number(args.p_limit));
    for (const row of rows) Object.assign(row, { status: "RUNNING", claimed_at: nowIso, claimed_by: String(args.p_worker) });
    return { data: rows.map((row) => ({ ...row })), error: null };
  };
}

/** The worker says "I am here" (and whether it may place orders). */
function beat(executionAvailable = true) {
  db.tables.gateway_heartbeat = [
    { worker: "w1", role: "trade-gateway", updated_at: new Date().toISOString(), info: { executionAvailable } },
  ];
  resetGatewayAvailability();
}

function commands() {
  return db.tables.trade_commands ?? [];
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Lets the worker do its rounds while a web request waits for its answer. */
async function withWorker(request: Promise<Response>): Promise<Response> {
  let finished = false;
  const answer = request.finally(() => {
    finished = true;
  });
  for (let round = 0; !finished; round += 1) {
    if (round > 600) throw new Error("the request was not answered");
    await worker.pollCommandsOnce();
    await worker.refreshStatesOnce();
    await worker.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return answer;
}

function freezeClock() {
  vi.useFakeTimers({ now: new Date("2026-10-12T12:00:00.000Z") });
  beat();
}

function signIn(overrides: Record<string, unknown> = {}) {
  vi.mocked(requireTrader).mockResolvedValue({
    id: USER,
    email: "trader@example.com",
    role: "TRADER",
    status: "ACTIVE",
    ...overrides,
  } as Awaited<ReturnType<typeof requireTrader>>);
}

const openBody = (overrides: Record<string, unknown> = {}) => openBodyFor(ACCOUNT, overrides);

function auditCall(index = 0) {
  return vi.mocked(writeAuditLog).mock.calls[index][0];
}

beforeEach(() => {
  USER = freshUserId();
  db.reset();
  resetGatewayState();
  resetGatewayAvailability();
  installGatewayTables();
  db.tables.trading_accounts = [accountRow(ACCOUNT, USER), accountRow(FOREIGN_ACCOUNT, OTHER_USER)];
  beat();
  vi.mocked(writeAuditLog).mockClear();
  resetWebTradeCaches();
  vi.mocked(getPlatformSubscriptionAccess).mockReset();
  vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "ACTIVE" } as never);
  vi.mocked(hasActivePlatformProductSubscription).mockReset();
  vi.mocked(hasActivePlatformProductSubscription).mockResolvedValue(false);
  vi.mocked(getRiskEnforcementState).mockReset();
  vi.mocked(getRiskEnforcementState).mockResolvedValue(null);
  signIn();
  webAdapter = makeWebAdapter();
  vi.mocked(createBrokerAdapter).mockReturnValue(webAdapter as never);
  useWorkerAdapter();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the panel is told how orders travel", () => {
  test("through the AWS system while a worker reports in", async () => {
    const data = (await readJson(await listAccounts())).data;

    expect(data.route).toBe("gateway");
    expect(data.gate).toEqual({ canOpen: true, canManage: true, reason: null, message: null });
  });

  test("a worker that reports the execution switch off makes the panel read-only", async () => {
    beat(false);

    const data = (await readJson(await listAccounts())).data;

    expect(data.route).toBe("none");
    expect(data.gate).toMatchObject({ canOpen: false, canManage: false, reason: "EXECUTION_DISABLED" });
  });

  test("no worker and no bridge on this server: the trading system is not responding", async () => {
    db.tables.gateway_heartbeat = [];
    resetGatewayAvailability();

    const data = (await readJson(await listAccounts())).data;

    expect(data.route).toBe("none");
    expect(data.gate).toMatchObject({ canOpen: false, reason: "GATEWAY_OFFLINE" });
    expect(data.gate.message).toContain("not responding");
  });

  test("a worker that has not reported for twenty seconds is gone", async () => {
    db.tables.gateway_heartbeat = [
      { worker: "w1", role: "trade-gateway", updated_at: iso(-25_000), info: { executionAvailable: true } },
    ];
    resetGatewayAvailability();

    expect((await readJson(await listAccounts())).data.gate.reason).toBe("GATEWAY_OFFLINE");
  });
});

describe("an order through the AWS system", () => {
  test("travels web → command → worker → broker and comes back with its timing", async () => {
    const response = await withWorker(
      openOrder(post(openBody({ symbol: "EURUSD.r", side: "SELL", volume: 0.25, stopLoss: 1.12, takeProfit: 1.08 }))),
    );
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      ok: true,
      ticket: "9001",
      timing: {
        // the trading system's part ...
        queueMs: expect.any(Number),
        runMs: expect.any(Number),
        // ... and the web server's own: the whole request, and the wait for the answer within it
        serverMs: expect.any(Number),
        waitMs: expect.any(Number),
      },
    });
    expect(body.data.timing.serverMs).toBeGreaterThanOrEqual(body.data.timing.waitMs);
    expect(workerAdapter.openTrade).toHaveBeenCalledWith({
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
    expect(webAdapter.openTrade).not.toHaveBeenCalled();
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toMatchObject({ kind: "OPEN", user_id: USER, account_id: ACCOUNT, status: "DONE" });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(auditCall()).toMatchObject({
      actorUserId: USER,
      action: "WEB_TRADE_ORDER_OPENED",
      entityId: ACCOUNT,
      metadata: { symbol: "EURUSD.r", ticket: "9001", route: "gateway" },
    });
  });

  test("a pending order carries its kind and price through the queue", async () => {
    await withWorker(openOrder(post(openBody({ symbol: "EURUSD.r", orderKind: "STOP", price: 1.09, stopLoss: 1.08, takeProfit: 1.12 }))));

    expect(workerAdapter.openTrade).toHaveBeenCalledWith(
      expect.objectContaining({ orderKind: "STOP", price: 1.09, stopLoss: 1.08, takeProfit: 1.12 }),
    );
  });

  test("the same request id sent again is answered with the first answer - never a second order", async () => {
    const body = openBody();

    await withWorker(openOrder(post(body)));
    const second = await readJson(await openOrder(post(body)));

    expect(second.data).toMatchObject({ ok: true, ticket: "9001", repeated: true });
    expect(workerAdapter.openTrade).toHaveBeenCalledTimes(1);
    expect(commands()).toHaveLength(1);
  });

  test("a refusal of the broker comes back in its own words; nothing is audited", async () => {
    useWorkerAdapter({
      openTrade: vi.fn(async () => {
        throw new BrokerExecutionError("PROVIDER_ERROR", "Invalid stops", 502);
      }),
    });

    const response = await withWorker(openOrder(post(openBody())));

    expect(response.status).toBe(502);
    expect((await readJson(response)).error).toEqual({ code: "PROVIDER_ERROR", message: "Invalid stops" });
    expect(commands()[0]).toMatchObject({ status: "FAILED", error_code: "PROVIDER_ERROR" });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("a worker whose own execution switch is off refuses the order", async () => {
    useWorkerAdapter({ executionAvailable: vi.fn(() => false) });

    const response = await withWorker(openOrder(post(openBody())));

    expect(response.status).toBe(503);
    expect((await readJson(response)).error?.code).toBe("EXECUTION_DISABLED");
    expect(workerAdapter.openTrade).not.toHaveBeenCalled();
  });

  test("closing a position needs no reading of the account first", async () => {
    const response = await withWorker(closePosition(post({ accountId: ACCOUNT, ticket: "5001", volume: 0.2 })));

    expect(response.status).toBe(200);
    expect(workerAdapter.closeTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "5001",
      volume: 0.2,
      comment: WEB_TRADE_COMMENT,
      stages: expect.any(Object),
    });
    expect(workerAdapter.fetchTradingState).not.toHaveBeenCalled();
    expect(commands()[0]).toMatchObject({ kind: "CLOSE", status: "DONE" });
    expect(auditCall()).toMatchObject({ action: "WEB_TRADE_POSITION_CLOSED", metadata: { partial: true, route: "gateway" } });
  });

  test("a modification is checked against the live position on the AWS side", async () => {
    const accepted = await withWorker(modifyPosition(post({ accountId: ACCOUNT, ticket: "5001", takeProfit: 2420 })));
    expect(accepted.status).toBe(200);
    expect(workerAdapter.modifyTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "5001",
      stopLoss: 2380,
      takeProfit: 2420,
      stages: expect.any(Object),
    });
    expect(auditCall()).toMatchObject({ action: "WEB_TRADE_POSITION_MODIFIED", metadata: { symbol: "XAUUSD", takeProfit: 2420, route: "gateway" } });

    const refused = await withWorker(modifyPosition(post({ accountId: ACCOUNT, ticket: "5001", stopLoss: 2430 })));
    expect(refused.status).toBe(400);
    expect((await readJson(refused)).error?.message).toContain("stop loss must be below the take profit");

    const gone = await withWorker(modifyPosition(post({ accountId: ACCOUNT, ticket: "7777", takeProfit: 2420 })));
    expect(gone.status).toBe(404);
    expect((await readJson(gone)).error?.code).toBe("POSITION_NOT_FOUND");
    expect(workerAdapter.modifyTrade).toHaveBeenCalledTimes(1);
  });

  test("a pending order is deleted by its ticket - an open position is not", async () => {
    const deleted = await withWorker(cancelOrder(post({ accountId: ACCOUNT, ticket: PENDING.ticket })));
    expect(deleted.status).toBe(200);
    expect(workerAdapter.cancelOrder).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerOrderId: "6001",
      stages: expect.any(Object),
    });
    expect(auditCall()).toMatchObject({ action: "WEB_TRADE_ORDER_CANCELLED", metadata: { ticket: "6001", route: "gateway" } });

    const refused = await withWorker(cancelOrder(post({ accountId: ACCOUNT, ticket: POSITION.ticket })));
    expect(refused.status).toBe(400);
    expect(workerAdapter.cancelOrder).toHaveBeenCalledTimes(1);
  });

  test("closing the losers closes only the losers and says how many", async () => {
    useWorkerAdapter({ fetchTradingState: vi.fn(async () => tradingState({ positions: [POSITION, LOSER] })) });

    const response = await withWorker(closeBulk(post({ accountId: ACCOUNT, scope: "LOSS" })));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ ok: true, closed: 1, failed: 0, timing: { queueMs: expect.any(Number), runMs: expect.any(Number) } });
    expect(workerAdapter.closeTrade).toHaveBeenCalledTimes(1);
    expect(workerAdapter.closeTrade).toHaveBeenCalledWith(expect.objectContaining({ brokerPositionId: "5002" }));
    expect(auditCall()).toMatchObject({ action: "WEB_TRADE_BULK_CLOSED", metadata: { scope: "LOSS", closed: 1, failed: 0, route: "gateway" } });
  });
});

describe("the gates are checked before anything is queued", () => {
  test.each([
    ["no platform subscription", async () => void vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "NONE" } as never), 403],
    [
      "an account whose risk rules block new orders",
      async () =>
        void vi.mocked(getRiskEnforcementState).mockResolvedValue({ blockedNewTrades: true, breachedRules: [{ name: "Max drawdown" }] } as never),
      423,
    ],
    ["an account that is not connected", async () => void (db.tables.trading_accounts = [accountRow(ACCOUNT, USER, { status: "DISCONNECTED" })]), 409],
  ])("%s", async (_name, arrange, status) => {
    await arrange();

    const response = await openOrder(post(openBody()));

    expect(response.status).toBe(status);
    expect(commands()).toHaveLength(0);
  });

  test("another user's account, an invalid body and a missing worker queue nothing", async () => {
    expect((await openOrder(post(openBody({ accountId: FOREIGN_ACCOUNT })))).status).toBe(404);
    expect((await openOrder(post(openBody({ volume: 0 })))).status).toBe(400);

    db.tables.gateway_heartbeat = [];
    resetGatewayAvailability();
    const offline = await openOrder(post(openBody()));
    expect(offline.status).toBe(503);
    expect((await readJson(offline)).error?.code).toBe("GATEWAY_OFFLINE");

    beat(false);
    const switchedOff = await openOrder(post(openBody()));
    expect(switchedOff.status).toBe(503);
    expect((await readJson(switchedOff)).error?.code).toBe("EXECUTION_DISABLED");

    expect(commands()).toHaveLength(0);
  });

  test("reducing risk is never blocked by the risk rules: close and modify are queued", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue({ blockedNewTrades: true, breachedRules: [{ name: "Max drawdown" }] } as never);

    expect((await withWorker(closePosition(post({ accountId: ACCOUNT, ticket: "5001" })))).status).toBe(200);
    expect((await withWorker(modifyPosition(post({ accountId: ACCOUNT, ticket: "5001", takeProfit: 2420 })))).status).toBe(200);
    expect(getRiskEnforcementState).not.toHaveBeenCalled();
  });
});

describe("when the AWS system does not answer", () => {
  test("an order nobody picks up is cancelled, never sent later, and the person is told", async () => {
    freezeClock();

    const pending = openOrder(post(openBody()));
    await vi.advanceTimersByTimeAsync(25_000);
    const response = await pending;
    const body = await readJson(response);

    expect(response.status).toBe(504);
    expect(body.error?.code).toBe("GATEWAY_TIMEOUT");
    expect(body.error?.message).toContain("NOT sent");
    expect(commands()[0]).toMatchObject({ status: "EXPIRED", error_code: "NOT_SENT" });

    // the worker wakes up late: the command is closed, there is nothing for it to run
    await worker.pollCommandsOnce();
    await worker.idle();
    expect(workerAdapter.openTrade).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("an order the worker took but did not answer is reported as uncertain - and a repeat never doubles it", async () => {
    freezeClock();
    let finishOrder: () => void = () => undefined;
    useWorkerAdapter({
      openTrade: vi.fn(
        () =>
          new Promise((resolve) => {
            finishOrder = () => resolve({ ok: true, brokerPositionId: "9001", brokerOrderId: "9001" });
          }),
      ),
    });
    const body = openBody();

    const first = openOrder(post(body));
    await vi.advanceTimersByTimeAsync(150);
    await worker.pollCommandsOnce(); // the worker takes it and now waits for the broker
    expect(commands()[0].status).toBe("RUNNING");
    await vi.advanceTimersByTimeAsync(25_000);

    const uncertain = await first;
    expect(uncertain.status).toBe(504);
    const uncertainBody = await readJson(uncertain);
    expect(uncertainBody.error?.code).toBe("ORDER_UNCERTAIN");
    expect(uncertainBody.error?.message).toContain("Check the open positions");
    expect(writeAuditLog).not.toHaveBeenCalled();

    // the broker answered after all; the person presses the same button again (same request id)
    finishOrder();
    await worker.idle();
    beat();
    const again = openOrder(post(body));
    await vi.advanceTimersByTimeAsync(300);
    const answered = await again;

    expect(answered.status).toBe(200);
    expect((await readJson(answered)).data).toMatchObject({ ok: true, ticket: "9001", repeated: true });
    expect(workerAdapter.openTrade).toHaveBeenCalledTimes(1);
    expect(commands()).toHaveLength(1);
  });

  test("no worker and no bridge here: orders, positions and symbols all say the system is offline", async () => {
    db.tables.gateway_heartbeat = [];
    resetGatewayAvailability();

    const order = await openOrder(post(openBody()));
    const state = await readState(stateRequest({ accountId: ACCOUNT }));
    const symbols = await readSymbols(getRequest("symbols", { accountId: ACCOUNT }));

    for (const response of [order, state, symbols]) {
      expect(response.status).toBe(503);
      expect((await readJson(response)).error?.code).toBe("GATEWAY_OFFLINE");
    }
    expect(commands()).toHaveLength(0);
  });

  test("pinned to the gateway, this server never trades by itself even if it could", async () => {
    vi.stubEnv("WSA_TRADE_ROUTE", "gateway");
    webAdapter = makeWebAdapter({ executionAvailable: vi.fn(() => true), openTrade: vi.fn(async () => ({ ok: true, brokerPositionId: "1" })) });
    vi.mocked(createBrokerAdapter).mockReturnValue(webAdapter as never);
    db.tables.gateway_heartbeat = [];
    resetGatewayAvailability();

    const order = await openOrder(post(openBody()));
    const state = await readState(stateRequest({ accountId: ACCOUNT }));

    expect(order.status).toBe(503);
    expect(state.status).toBe(503);
    expect((await readJson(state)).error?.code).toBe("GATEWAY_OFFLINE");
    expect(webAdapter.openTrade).not.toHaveBeenCalled();
    expect(webAdapter.fetchTradingState).not.toHaveBeenCalled();
  });

  test("with no worker but a bridge on this server, the single-box route takes over", async () => {
    webAdapter = makeWebAdapter({
      executionAvailable: vi.fn(() => true),
      openTrade: vi.fn(async () => ({ ok: true, brokerPositionId: "4242" })),
    });
    vi.mocked(createBrokerAdapter).mockReturnValue(webAdapter as never);
    db.tables.gateway_heartbeat = [];
    resetGatewayAvailability();

    const response = await openOrder(post(openBody()));

    expect(response.status).toBe(200);
    expect((await readJson(response)).data.ticket).toBe("4242");
    expect(commands()).toHaveLength(0);
    expect(auditCall()).toMatchObject({ metadata: { route: "direct" } });
  });
});

describe("reading an account through the AWS system", () => {
  test("the first look asks the worker to watch the account and waits for the first picture", async () => {
    const response = await withWorker(readState(stateRequest({ accountId: ACCOUNT, symbol: "XAUUSD" })));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      accountId: ACCOUNT,
      route: "gateway",
      delayed: false,
      balance: 10_000,
      equity: 10_012.5,
      pendingOrders: 1,
      quote: { symbol: "XAUUSD", bid: 2400.1, ask: 2400.4 },
    });
    expect(body.data.positions).toHaveLength(1);
    expect(body.data.pending).toEqual([PENDING]);
    expect(db.tables.terminal_account_state[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: USER,
      watch_symbols: ["XAUUSD"],
    });
    expect(webAdapter.fetchTradingState).not.toHaveBeenCalled();
  });

  test("a picture that is a second old is served at once, without writing anything", async () => {
    db.tables.terminal_account_state = [
      {
        account_id: ACCOUNT,
        user_id: USER,
        state: { ...tradingState(), quotes: {} },
        state_at: iso(-1_000),
        error: null,
        error_at: null,
        watch_until: iso(40_000),
        watch_symbols: [],
      },
    ];

    const response = await readState(stateRequest({ accountId: ACCOUNT }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ route: "gateway", delayed: false, equity: 10_012.5 });
    expect(db.callsTo("terminal_account_state", "upsert")).toHaveLength(0);
    expect(workerAdapter.fetchTradingState).not.toHaveBeenCalled();
  });

  test("a symbol that is not watched yet is added to the list the worker keeps fresh", async () => {
    db.tables.terminal_account_state = [
      {
        account_id: ACCOUNT,
        user_id: USER,
        state: { ...tradingState(), quotes: {} },
        state_at: iso(-500),
        error: null,
        error_at: null,
        watch_until: iso(40_000),
        watch_symbols: ["XAUUSD"],
      },
    ];

    const body = await readJson(await readState(stateRequest({ accountId: ACCOUNT, symbol: "EURUSD.r" })));

    expect(db.tables.terminal_account_state[0].watch_symbols).toEqual(["EURUSD.r", "XAUUSD"]);
    // the price of the new symbol follows with the next picture; the rest is shown right away
    expect(body.data.quote).toBeNull();
    expect(body.data.equity).toBe(10_012.5);
  });

  test("an old picture is served as delayed when the worker does not renew it", async () => {
    freezeClock();
    db.tables.terminal_account_state = [
      {
        account_id: ACCOUNT,
        user_id: USER,
        state: { ...tradingState(), quotes: {} },
        state_at: iso(-30_000),
        error: null,
        error_at: null,
        watch_until: iso(40_000),
        watch_symbols: [],
      },
    ];

    const pending = readState(stateRequest({ accountId: ACCOUNT }));
    await vi.advanceTimersByTimeAsync(7_000);
    const body = await readJson(await pending);

    expect(body.data).toMatchObject({ route: "gateway", delayed: true, equity: 10_012.5 });
  });

  test("a picture older than two minutes is not shown at all", async () => {
    freezeClock();
    db.tables.terminal_account_state = [
      {
        account_id: ACCOUNT,
        user_id: USER,
        state: { ...tradingState(), quotes: {} },
        state_at: iso(-300_000),
        error: null,
        error_at: null,
        watch_until: iso(40_000),
        watch_symbols: [],
      },
    ];

    const pending = readState(stateRequest({ accountId: ACCOUNT }));
    await vi.advanceTimersByTimeAsync(7_000);
    const response = await pending;

    expect(response.status).toBe(504);
    expect((await readJson(response)).error?.code).toBe("GATEWAY_TIMEOUT");
  });

  test("what the worker could not read is passed on in words", async () => {
    db.tables.terminal_account_state = [
      {
        account_id: ACCOUNT,
        user_id: USER,
        state: null,
        state_at: null,
        error: "Broker not reachable.",
        error_at: iso(-1_000),
        watch_until: iso(40_000),
        watch_symbols: [],
      },
    ];

    const response = await readState(stateRequest({ accountId: ACCOUNT }));

    expect(response.status).toBe(502);
    expect(await readJson(response)).toMatchObject({ ok: false, error: { code: "BROKER_ERROR", message: "Broker not reachable." } });
  });

  test("another user's account is not found and nobody starts watching it", async () => {
    const response = await readState(stateRequest({ accountId: FOREIGN_ACCOUNT }));

    expect(response.status).toBe(404);
    expect(db.callsTo("terminal_account_state", "upsert")).toHaveLength(0);
    expect(getRiskEnforcementState).not.toHaveBeenCalled();
  });

  test("without the gateway tables the panel says the trading system is offline", async () => {
    db.errors.terminal_account_state = { code: "42P01", message: 'relation "terminal_account_state" does not exist' };

    const response = await readState(stateRequest({ accountId: ACCOUNT }));

    expect(response.status).toBe(503);
    expect((await readJson(response)).error?.code).toBe("GATEWAY_OFFLINE");
  });
});

describe("the symbols of the account", () => {
  const stored = [{ name: "EURUSD.r", description: "Euro vs US Dollar", path: "Forex\\EURUSD.r", digits: 5 }];

  test("a list read within the last hours is served as it is, without a command", async () => {
    db.tables.terminal_account_symbols = [{ account_id: ACCOUNT, symbols: stored, updated_at: iso(-3_600_000) }];

    const body = await readJson(await readSymbols(getRequest("symbols", { accountId: ACCOUNT })));

    expect(body.data).toEqual({ symbols: stored, updatedAt: expect.any(String), route: "gateway" });
    expect(commands()).toHaveLength(0);
  });

  test("nothing stored yet: the worker reads the broker's list and keeps it", async () => {
    const response = await withWorker(readSymbols(getRequest("symbols", { accountId: ACCOUNT })));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data.symbols).toEqual([{ name: "XAUUSD", description: "Gold", path: "Metals\\XAUUSD", digits: 2 }]);
    expect(body.data.route).toBe("gateway");
    expect(commands()[0]).toMatchObject({ kind: "SYMBOLS", status: "DONE" });
    expect(db.tables.terminal_account_symbols[0]).toMatchObject({ account_id: ACCOUNT });
  });

  test("an old list is better than none when the worker cannot read a new one", async () => {
    db.tables.terminal_account_symbols = [{ account_id: ACCOUNT, symbols: stored, updated_at: iso(-7 * 3_600_000) }];
    useWorkerAdapter({
      fetchSymbolList: vi.fn(async () => {
        throw new Error("bridge down");
      }),
    });

    const response = await withWorker(readSymbols(getRequest("symbols", { accountId: ACCOUNT })));

    expect(response.status).toBe(200);
    expect((await readJson(response)).data.symbols).toEqual(stored);
    expect(commands()[0]).toMatchObject({ kind: "SYMBOLS", status: "FAILED" });
  });

  test("with no list at all and a failing bridge the person gets the error", async () => {
    useWorkerAdapter({
      fetchSymbolList: vi.fn(async () => {
        throw new Error("bridge down");
      }),
    });

    const response = await withWorker(readSymbols(getRequest("symbols", { accountId: ACCOUNT })));

    expect(response.status).toBe(502);
    expect((await readJson(response)).error?.code).toBe("BROKER_ERROR");
  });

  test("an empty list is not asked again for two minutes", async () => {
    db.tables.terminal_account_symbols = [{ account_id: ACCOUNT, symbols: [], updated_at: iso(-10_000) }];

    const body = await readJson(await readSymbols(getRequest("symbols", { accountId: ACCOUNT })));

    expect(body.data.symbols).toEqual([]);
    expect(commands()).toHaveLength(0);
  });

  test("another user's account has no symbols to read", async () => {
    const response = await readSymbols(getRequest("symbols", { accountId: FOREIGN_ACCOUNT }));

    expect(response.status).toBe(404);
    expect(commands()).toHaveLength(0);
  });
});

describe("waiting for the answer inside the database (migration 062)", () => {
  /** The database side of 062 for one command. The in-memory database cannot wait: it answers with what is there. */
  function installLongPoll() {
    const asked: Array<{ args: Record<string, unknown>; writtenBefore: number }> = [];
    db.rpcHandlers.await_trade_command = (args) => {
      asked.push({ args, writtenBefore: db.callsTo("trade_commands", "insert").length });
      const row = commands().find(
        (candidate) => candidate.user_id === args.p_user_id && candidate.client_request_id === args.p_client_request_id,
      );
      return { data: row ? [{ ...row }] : [], error: null };
    };
    return asked;
  }

  /** A worker that waits for commands inside the database and reports what it measures. */
  function beatLive(info: Record<string, unknown> = {}) {
    db.tables.gateway_heartbeat = [
      {
        worker: "w1",
        role: "trade-gateway",
        updated_at: new Date().toISOString(),
        info: { executionAvailable: true, longPoll: true, dbRttMs: 12.4, loopLagMs: 3, ...info },
      },
    ];
    resetGatewayAvailability();
  }

  test("the wait starts together with the write and finds the command by user and request id", async () => {
    const asked = installLongPoll();
    beatLive();
    const body = openBody();

    const response = await withWorker(openOrder(post(body)));

    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toMatchObject({ ok: true, ticket: "9001" });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0].args).toMatchObject({ p_user_id: USER, p_client_request_id: body.clientRequestId });
    // the first look was asked before the command was even written - the wait does not wait for the write
    expect(asked[0].writtenBefore).toBe(0);
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toMatchObject({ status: "DONE" });
  });

  test("nothing looks the command up again and again, and the report says the wake-up was live", async () => {
    installLongPoll();
    beatLive();

    const response = await withWorker(openOrder(post(openBody())));
    const timing = (await readJson(response)).data.timing;

    expect(timing).toMatchObject({
      wake: "live",
      awsDbMs: 12,
      awsLoopMs: 3,
      insertMs: expect.any(Number),
      checksMs: expect.any(Number),
      signInMs: expect.any(Number),
    });
    expect(db.callsTo("trade_commands", "select")).toHaveLength(0);
  });

  test("without 062 the web server asks again and again as before - and once it knows, it does not try the wait again", async () => {
    let attempts = 0;
    db.rpcHandlers.await_trade_command = () => {
      attempts += 1;
      return {
        data: null,
        error: { code: "PGRST202", message: "Could not find the function public.await_trade_command(p_client_request_id) in the schema cache" },
      };
    };
    beatLive();

    const first = (await readJson(await withWorker(openOrder(post(openBody()))))).data;
    const second = (await readJson(await withWorker(openOrder(post(openBody()))))).data;

    expect(first).toMatchObject({ ok: true, ticket: "9001", timing: { wake: "web-poll" } });
    expect(second).toMatchObject({ ok: true, ticket: "9001", timing: { wake: "web-poll" } });
    expect(attempts).toBe(1);
    expect(longPollKnownOff()).toBe(true);
  });

  test("a wait the database refuses (a time-out) falls back to asking again at once - the order is not lost", async () => {
    let attempts = 0;
    db.rpcHandlers.await_trade_command = () => {
      attempts += 1;
      return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    };
    beatLive();

    const first = (await readJson(await withWorker(openOrder(post(openBody()))))).data;
    const second = (await readJson(await withWorker(openOrder(post(openBody()))))).data;

    expect(first).toMatchObject({ ok: true, ticket: "9001", timing: { wake: "web-poll" } });
    expect(second).toMatchObject({ ok: true, ticket: "9001", timing: { wake: "web-poll" } });
    expect(attempts).toBe(1); // twenty seconds of plain asking before the wait is tried again
    expect(workerAdapter.openTrade).toHaveBeenCalledTimes(2);
  });

  test("a worker that still polls the database for commands is named in the report - the order goes through all the same", async () => {
    installLongPoll();
    beatLive({ longPoll: false });
    const flagged = (await readJson(await withWorker(openOrder(post(openBody()))))).data;

    // an older worker does not say anything about it: it counts as polling
    beatLive({ longPoll: undefined });
    const silent = (await readJson(await withWorker(openOrder(post(openBody()))))).data;

    expect(flagged).toMatchObject({ ok: true, ticket: "9001", timing: { wake: "aws-poll" } });
    expect(silent).toMatchObject({ ok: true, ticket: "9001", timing: { wake: "aws-poll" } });
  });

  test("a refusal of the broker arrives through the wait like any answer - nothing is audited", async () => {
    useWorkerAdapter({
      openTrade: vi.fn(async () => {
        throw new BrokerExecutionError("PROVIDER_ERROR", "Invalid stops", 502);
      }),
    });
    installLongPoll();
    beatLive();

    const response = await withWorker(openOrder(post(openBody())));

    expect(response.status).toBe(502);
    expect((await readJson(response)).error).toEqual({ code: "PROVIDER_ERROR", message: "Invalid stops" });
    expect(commands()[0]).toMatchObject({ status: "FAILED", error_code: "PROVIDER_ERROR" });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("the same request id sent again is the same command: the wait finds the answer that is already there", async () => {
    installLongPoll();
    beatLive();
    const body = openBody();

    await withWorker(openOrder(post(body)));
    const second = await readJson(await openOrder(post(body)));

    expect(second.data).toMatchObject({ ok: true, ticket: "9001", repeated: true });
    expect(workerAdapter.openTrade).toHaveBeenCalledTimes(1);
    expect(commands()).toHaveLength(1);
  });

  test("an order nobody picks up is still cancelled and never sent later", async () => {
    freezeClock();
    installLongPoll();
    beatLive();

    const pending = openOrder(post(openBody()));
    await vi.advanceTimersByTimeAsync(25_000);
    const response = await pending;

    expect(response.status).toBe(504);
    expect((await readJson(response)).error?.code).toBe("GATEWAY_TIMEOUT");
    expect(commands()[0]).toMatchObject({ status: "EXPIRED", error_code: "NOT_SENT" });

    await worker.pollCommandsOnce();
    await worker.idle();
    expect(workerAdapter.openTrade).not.toHaveBeenCalled();
  });
});
