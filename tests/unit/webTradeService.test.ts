import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthError, requireTrader, type SessionUser } from "@/lib/auth/session";
import { BROKER_EXEC_ERROR, BrokerExecutionError } from "@/lib/broker/BrokerAdapter";
import { createBrokerAdapter } from "@/lib/broker/provider";
import { resetGatewayState } from "@/lib/gateway/gatewayDb";
import { resetGatewayAvailability } from "@/lib/gateway/gatewayQueue";
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
import { GET as warmOpen } from "@/app/api/terminal/trade/open/route";
import { GET as warmModify } from "@/app/api/terminal/trade/modify/route";
import { GET as warmClose } from "@/app/api/terminal/trade/close/route";
import { GET as warmCancel } from "@/app/api/terminal/trade/cancel/route";
import { GET as warmCloseBulk } from "@/app/api/terminal/trade/close-bulk/route";
import { resetWebTradeCaches, riskPassCacheAgeFor, warmWebTradeGates } from "@/lib/services/webTradeService";
import { WEB_TRADE_COMMENT } from "@/lib/trade/webTrade";
import { sharedDb as db } from "./helpers/memoryDb";
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
  PROVIDER_ID,
  readJson,
  SECOND_ACCOUNT,
  stateRequest,
  tradingState,
} from "./helpers/webTradeFixtures";

// These tests run WSA Trade on a database without migration 060 (no trade gateway): the
// order routes then use this server's own broker bridge - the single-box install. The
// gateway route, with a real worker loop, is in webTradeGateway.test.ts.

test("only the demo pilot account gets a fresher risk verdict for its order pass", () => {
  expect(riskPassCacheAgeFor(ACCOUNT, ACCOUNT)).toBe(500);
  expect(riskPassCacheAgeFor(SECOND_ACCOUNT, ACCOUNT)).toBe(2_000);
  expect(riskPassCacheAgeFor(ACCOUNT, "")).toBe(2_000);
});

vi.mock("@/lib/supabase/admin", async () => {
  const { sharedClient } = await import("./helpers/memoryDb");
  return { createAdminClient: () => sharedClient };
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

// every test signs in as a user of its own (see freshUserId)
let USER = "";

function signIn(overrides: Record<string, unknown> = {}) {
  vi.mocked(requireTrader).mockResolvedValue({
    id: USER,
    email: "trader@example.com",
    role: "TRADER",
    status: "ACTIVE",
    ...overrides,
  } as Awaited<ReturnType<typeof requireTrader>>);
}

let adapter = makeAdapter();

function useAdapter(overrides: Record<string, unknown> = {}) {
  adapter = makeAdapter(overrides);
  vi.mocked(createBrokerAdapter).mockReturnValue(adapter as never);
  return adapter;
}

const openBody = (overrides: Record<string, unknown> = {}) => openBodyFor(ACCOUNT, overrides);

function seedAccounts() {
  db.tables.trading_accounts = [accountRow(ACCOUNT, USER), accountRow(FOREIGN_ACCOUNT, OTHER_USER)];
}

function auditCall(index = 0) {
  return vi.mocked(writeAuditLog).mock.calls[index][0];
}

beforeEach(() => {
  USER = freshUserId();
  db.reset();
  resetGatewayState();
  resetGatewayAvailability();
  // a database without migration 060: there is no trade gateway, the routes use this server's own bridge
  db.errors.gateway_heartbeat = { code: "42P01", message: 'relation "gateway_heartbeat" does not exist' };
  seedAccounts();
  vi.mocked(writeAuditLog).mockClear();
  resetWebTradeCaches();
  vi.mocked(getPlatformSubscriptionAccess).mockReset();
  vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "ACTIVE" } as never);
  // the quick one-query check does not say yes unless a test makes it: the full billing picture decides
  vi.mocked(hasActivePlatformProductSubscription).mockReset();
  vi.mocked(hasActivePlatformProductSubscription).mockResolvedValue(false);
  vi.mocked(getRiskEnforcementState).mockReset();
  vi.mocked(getRiskEnforcementState).mockResolvedValue(null);
  signIn();
  useAdapter();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("who may use WSA Trade", () => {
  test("every route needs a signed-in trader", async () => {
    vi.mocked(requireTrader).mockRejectedValue(new AuthError("UNAUTHORIZED", "Not authenticated", 401));

    expect((await listAccounts()).status).toBe(401);
    expect((await readState(stateRequest({ accountId: ACCOUNT }))).status).toBe(401);
    expect((await readSymbols(getRequest("symbols", { accountId: ACCOUNT }))).status).toBe(401);
    expect((await openOrder(post(openBody()))).status).toBe(401);
    expect((await modifyPosition(post({ accountId: ACCOUNT, ticket: "5001", takeProfit: 2420 }))).status).toBe(401);
    expect((await closePosition(post({ accountId: ACCOUNT, ticket: "5001" }))).status).toBe(401);
    expect((await cancelOrder(post({ accountId: ACCOUNT, ticket: "6001" }))).status).toBe(401);
    expect((await closeBulk(post({ accountId: ACCOUNT, scope: "ALL" }))).status).toBe(401);
    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  test("a partner has no trading terminal, even if the session guard let them through", async () => {
    signIn({ role: "PARTNER" });

    for (const response of [
      await listAccounts(),
      await readState(stateRequest({ accountId: ACCOUNT })),
      await readSymbols(getRequest("symbols", { accountId: ACCOUNT })),
      await openOrder(post(openBody())),
      await modifyPosition(post({ accountId: ACCOUNT, ticket: "5001", takeProfit: 2420 })),
      await closePosition(post({ accountId: ACCOUNT, ticket: "5001" })),
      await cancelOrder(post({ accountId: ACCOUNT, ticket: "6001" })),
      await closeBulk(post({ accountId: ACCOUNT, scope: "ALL" })),
    ]) {
      expect(response.status).toBe(403);
      expect((await readJson(response)).error?.code).toBe("FORBIDDEN");
    }
    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });
});

describe("GET /api/terminal/trade/accounts", () => {
  test("lists the caller's own accounts only, uncached, without provider references", async () => {
    const response = await listAccounts();
    const text = await response.clone().text();
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.data.accounts.map((entry: { accountId: string }) => entry.accountId)).toEqual([ACCOUNT]);
    expect(text).not.toContain(PROVIDER_ID);
    expect(text).not.toContain("provider_account_id");
    expect(db.callsTo("trading_accounts")[0].filters).toContainEqual({ op: "eq", column: "user_id", value: USER });
  });

  test("an administrator also sees only their own accounts", async () => {
    signIn({ role: "ADMIN" });
    db.tables.trading_accounts = [accountRow(FOREIGN_ACCOUNT, OTHER_USER)];

    const body = await readJson(await listAccounts());

    expect(body.data.accounts).toEqual([]);
  });

  test("connected accounts come first and only reachable ones can be used", async () => {
    db.tables.trading_accounts = [
      accountRow("cccccccc-cccc-4ccc-8ccc-ccccccccccc1", USER, { account_name: "Old", status: "DISCONNECTED" }),
      accountRow("cccccccc-cccc-4ccc-8ccc-ccccccccccc2", USER, { account_name: "Waiting", status: "PENDING", provider_account_id: null }),
      accountRow("cccccccc-cccc-4ccc-8ccc-ccccccccccc3", USER, { account_name: "No link", status: "CONNECTED", provider_account_id: null }),
      accountRow("cccccccc-cccc-4ccc-8ccc-ccccccccccc4", USER, { account_name: "Live", status: "CONNECTED" }),
    ];

    const body = await readJson(await listAccounts());
    const summary = body.data.accounts.map((entry: { name: string; reachable: boolean }) => [entry.name, entry.reachable]);

    expect(summary).toEqual([
      ["No link", false],
      ["Live", true],
      ["Waiting", false],
      ["Old", false],
    ]);
  });

  test("tells the panel whether orders are possible at all, and by which route", async () => {
    const open = (await readJson(await listAccounts())).data;
    expect(open.gate).toEqual({ canOpen: true, canManage: true, reason: null, message: null });
    expect(open.route).toBe("direct");

    useAdapter({ executionAvailable: vi.fn(() => false) });
    const switchedOff = (await readJson(await listAccounts())).data;
    expect(switchedOff.gate.canOpen).toBe(false);
    expect(switchedOff.gate.reason).toBe("EXECUTION_DISABLED");
    expect(switchedOff.route).toBe("none");

    useAdapter();
    resetWebTradeCaches();
    vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "NONE" } as never);
    const unpaid = (await readJson(await listAccounts())).data.gate;
    expect(unpaid.canOpen).toBe(false);
    expect(unpaid.canManage).toBe(false);
    expect(unpaid.reason).toBe("SUBSCRIPTION_REQUIRED");
  });

  test("an administrator needs no platform subscription", async () => {
    signIn({ role: "ADMIN" });
    vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "NONE" } as never);

    const gate = (await readJson(await listAccounts())).data.gate;

    expect(gate.canOpen).toBe(true);
    expect(getPlatformSubscriptionAccess).not.toHaveBeenCalled();
  });

  test("a database failure is a plain 503 that does not leak the details", async () => {
    db.errors.trading_accounts = { message: 'relation "secret_internal_table" does not exist' };

    const response = await listAccounts();
    const text = await response.clone().text();

    expect(response.status).toBe(503);
    expect((await readJson(response)).error?.code).toBe("SERVICE_UNAVAILABLE");
    expect(text).not.toContain("secret_internal_table");
  });
});

describe("GET /api/terminal/trade/state", () => {
  test.each([
    ["no account", {}],
    ["an account that is not an id", { accountId: "12345" }],
    ["a symbol with a quote in it", { accountId: ACCOUNT, symbol: "XAU'USD" }],
    ["a symbol that is far too long", { accountId: ACCOUNT, symbol: "A".repeat(40) }],
  ])("rejects a request with %s", async (_name, query) => {
    const response = await readState(stateRequest(query as Record<string, string>));

    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("VALIDATION_ERROR");
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
  });

  test("another user's account is not found - never asked at the broker, its risk never read", async () => {
    const response = await readState(stateRequest({ accountId: FOREIGN_ACCOUNT }));

    expect(response.status).toBe(404);
    expect((await readJson(response)).error?.code).toBe("ACCOUNT_NOT_FOUND");
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
    expect(getRiskEnforcementState).not.toHaveBeenCalled();
    const lookup = db.callsTo("trading_accounts")[0];
    expect(lookup.filters).toContainEqual({ op: "eq", column: "user_id", value: USER });
    expect(lookup.filters).toContainEqual({ op: "eq", column: "id", value: FOREIGN_ACCOUNT });
  });

  test.each([
    ["is still pending", { status: "PENDING" }],
    ["has no broker link", { provider_account_id: null }],
    ["is disconnected", { status: "DISCONNECTED" }],
  ])("an account that %s is a 409, not a broker error", async (_name, overrides) => {
    db.tables.trading_accounts = [accountRow(ACCOUNT, USER, overrides)];

    const response = await readState(stateRequest({ accountId: ACCOUNT }));

    expect(response.status).toBe(409);
    expect((await readJson(response)).error?.code).toBe("ACCOUNT_NOT_CONNECTED");
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
  });

  test("returns figures, positions, pending orders and the price of the symbol", async () => {
    const response = await readState(stateRequest({ accountId: ACCOUNT, symbol: "XAUUSD" }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.data).toMatchObject({
      accountId: ACCOUNT,
      currency: "USD",
      balance: 10_000,
      equity: 10_012.5,
      floatingProfit: 12.5,
      pendingOrders: 1,
      quote: { symbol: "XAUUSD", bid: 2400.1, ask: 2400.4 },
      riskBlocked: false,
      riskMessage: null,
      route: "direct",
      delayed: false,
      readOnly: false,
    });
    expect(body.data.positions).toHaveLength(1);
    expect(body.data.positions[0]).toMatchObject({ ticket: "5001", symbol: "XAUUSD", side: "BUY", volume: 0.5 });
    expect(body.data.pending).toEqual([PENDING]);
    expect(adapter.fetchTradingState).toHaveBeenCalledWith(ACCOUNT);
    expect(adapter.fetchQuote).toHaveBeenCalledWith(ACCOUNT, "XAUUSD");
  });

  test("without a symbol no price is asked", async () => {
    const body = await readJson(await readState(stateRequest({ accountId: ACCOUNT })));

    expect(body.data.quote).toBeNull();
    expect(adapter.fetchQuote).not.toHaveBeenCalled();
  });

  test("a missing price never fails the whole state", async () => {
    useAdapter({
      fetchQuote: vi.fn(async () => {
        throw new Error("quote endpoint missing");
      }),
    });

    const response = await readState(stateRequest({ accountId: ACCOUNT, symbol: "XAUUSD" }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data.quote).toBeNull();
    expect(body.data.positions).toHaveLength(1);
  });

  test("a broker connection that only reads is reported as read-only", async () => {
    useAdapter({ fetchTradingState: vi.fn(async () => tradingState({ readOnly: true })) });

    const body = await readJson(await readState(stateRequest({ accountId: ACCOUNT })));

    expect(body.data.readOnly).toBe(true);
  });

  test("risk rules that block new orders are reported with the rule names", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue({
      accountId: ACCOUNT,
      blockedNewTrades: true,
      restricted: false,
      breachedRules: [{ name: "Daily loss limit" }],
      source: "RISK_WORKER",
      lastEvaluatedAt: "2026-10-12T10:00:00.000Z",
    } as never);

    const body = await readJson(await readState(stateRequest({ accountId: ACCOUNT })));

    expect(body.data.riskBlocked).toBe(true);
    expect(body.data.riskMessage).toContain("Daily loss limit");
    expect(body.data.riskMessage).toContain("close positions");
  });

  test("an unreadable risk state does not hide the positions", async () => {
    vi.mocked(getRiskEnforcementState).mockRejectedValue(new Error("risk table unavailable"));

    const response = await readState(stateRequest({ accountId: ACCOUNT }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data.riskBlocked).toBe(false);
  });

  test("a broker failure is a 502 with a message free of provider names and credentials", async () => {
    useAdapter({
      fetchTradingState: vi.fn(async () => {
        throw new Error("API2Trade request to https://mt5.mt4api.dev/AccountSummary failed: Invalid stops");
      }),
    });

    const response = await readState(stateRequest({ accountId: ACCOUNT }));
    const body = await readJson(response);

    expect(response.status).toBe(502);
    expect(body.error?.code).toBe("BROKER_ERROR");
    expect(body.error?.message).toContain("Invalid stops");
    expect(body.error?.message).not.toMatch(/api2trade|mt4api/i);
  });

  test("a server without the broker bridge says what is really wrong", async () => {
    useAdapter({
      fetchTradingState: vi.fn(async () => {
        throw new BrokerExecutionError(BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED, "No provider.", 503);
      }),
    });

    const response = await readState(stateRequest({ accountId: ACCOUNT }));
    const body = await readJson(response);

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error?.message).toContain("not connected to this server");
  });

  test("an adapter that cannot read positions is a clear 501", async () => {
    useAdapter({ fetchTradingState: undefined });

    const response = await readState(stateRequest({ accountId: ACCOUNT }));

    expect(response.status).toBe(501);
    expect((await readJson(response)).error?.code).toBe("NOT_SUPPORTED");
  });
});

describe("GET /api/terminal/trade/symbols", () => {
  test("lists the symbols with the broker's own spelling", async () => {
    const response = await readSymbols(getRequest("symbols", { accountId: ACCOUNT }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.data).toEqual({
      symbols: [{ name: "XAUUSD", description: "Gold", path: "Metals\\XAUUSD", digits: 2 }],
      updatedAt: null,
      route: "direct",
    });
    expect(adapter.fetchSymbolList).toHaveBeenCalledWith(ACCOUNT);
  });

  test("a bridge without a symbol list gives an empty list, not an error", async () => {
    useAdapter({ fetchSymbolList: undefined });

    const body = await readJson(await readSymbols(getRequest("symbols", { accountId: ACCOUNT })));

    expect(body.data.symbols).toEqual([]);
  });

  test("another user's account is not found and a bad id is a 400", async () => {
    const foreign = await readSymbols(getRequest("symbols", { accountId: FOREIGN_ACCOUNT }));
    expect(foreign.status).toBe(404);
    expect(adapter.fetchSymbolList).not.toHaveBeenCalled();

    const bad = await readSymbols(getRequest("symbols", { accountId: "nope" }));
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/terminal/trade/open", () => {
  test.each([
    ["is not JSON", "{nope"],
    ["has no request id", { ...openBody(), clientRequestId: undefined }],
    ["asks for no volume", openBody({ volume: 0 })],
    ["asks for more than the ceiling", openBody({ volume: 500 })],
    ["asks for a side that does not exist", openBody({ side: "HOLD" })],
    ["has a symbol with spaces", openBody({ symbol: "XAU USD" })],
    ["puts the stop loss above the take profit of a buy", openBody({ stopLoss: 2430, takeProfit: 2410 })],
    ["asks for an order type that does not exist", openBody({ orderKind: "OCO", price: 2390 })],
    ["wants a pending order without its price", openBody({ orderKind: "LIMIT" })],
    ["puts the stop loss of a buy limit above its entry", openBody({ orderKind: "LIMIT", price: 2390, stopLoss: 2400, takeProfit: 2420 })],
  ])("rejects a body that %s", async (_name, body) => {
    const response = await openOrder(post(body));

    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("VALIDATION_ERROR");
    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("with order execution switched off nothing is sent and the answer says why", async () => {
    useAdapter({ executionAvailable: vi.fn(() => false) });

    const response = await openOrder(post(openBody()));
    const body = await readJson(response);

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("EXECUTION_DISABLED");
    expect(adapter.openTrade).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("a trader without an active platform subscription cannot place orders", async () => {
    vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "EXPIRED" } as never);

    const response = await openOrder(post(openBody()));

    expect(response.status).toBe(403);
    expect((await readJson(response)).error?.code).toBe("SUBSCRIPTION_REQUIRED");
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });

  test("an administrator trades their own account without a subscription", async () => {
    signIn({ role: "ADMIN" });
    vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "NONE" } as never);

    const response = await openOrder(post(openBody()));

    expect(response.status).toBe(200);
    expect(getPlatformSubscriptionAccess).not.toHaveBeenCalled();
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
  });

  test("an account whose risk rules block new trades is refused with the rule names", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue({
      accountId: ACCOUNT,
      blockedNewTrades: true,
      restricted: true,
      breachedRules: [{ name: "Max drawdown" }, { name: "Daily loss limit" }],
      source: "RISK_WORKER",
      lastEvaluatedAt: "2026-10-12T10:00:00.000Z",
    } as never);

    const response = await openOrder(post(openBody()));
    const body = await readJson(response);

    expect(response.status).toBe(423);
    expect(body.error?.code).toBe("RISK_BLOCKED");
    expect(body.error?.message).toContain("Max drawdown");
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });

  test("another user's account is not found and no order is sent", async () => {
    const response = await openOrder(post(openBody({ accountId: FOREIGN_ACCOUNT })));

    expect(response.status).toBe(404);
    expect((await readJson(response)).error?.code).toBe("ACCOUNT_NOT_FOUND");
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });

  test("an account that is not connected is a 409", async () => {
    db.tables.trading_accounts = [accountRow(ACCOUNT, USER, { status: "DISCONNECTED" })];

    const response = await openOrder(post(openBody()));

    expect(response.status).toBe(409);
    expect((await readJson(response)).error?.code).toBe("ACCOUNT_NOT_CONNECTED");
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });

  test("places the order through the adapter, marks it as WSA Trade and writes the audit log", async () => {
    const response = await openOrder(post(openBody({ symbol: "EURUSD.m", side: "SELL", volume: 0.25, stopLoss: 1.12, takeProfit: 1.08 })));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({ ok: true, data: { ok: true, ticket: "9001", detail: { symbol: "EURUSD.m" } } });
    expect(adapter.openTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      symbol: "EURUSD.m",
      side: "SELL",
      volume: 0.25,
      orderKind: "MARKET",
      price: null,
      stopLoss: 1.12,
      takeProfit: 1.08,
      comment: WEB_TRADE_COMMENT,
      stages: expect.any(Object),
    });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(auditCall()).toMatchObject({
      actorUserId: USER,
      action: "WEB_TRADE_ORDER_OPENED",
      entityType: "trading_account",
      entityId: ACCOUNT,
      metadata: { symbol: "EURUSD.m", side: "SELL", volume: 0.25, orderKind: "MARKET", price: null, ticket: "9001", route: "direct" },
    });
  });

  test("a pending order carries its kind and price to the broker", async () => {
    const response = await openOrder(
      post(openBody({ symbol: "EURUSD.r", orderKind: "LIMIT", price: 1.08, stopLoss: 1.07, takeProfit: 1.1 })),
    );

    expect(response.status).toBe(200);
    expect(adapter.openTrade).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "EURUSD.r", orderKind: "LIMIT", price: 1.08, stopLoss: 1.07, takeProfit: 1.1 }),
    );
    expect(auditCall()).toMatchObject({ metadata: { orderKind: "LIMIT", price: 1.08 } });
  });

  test("a price sent with a market order is not passed on", async () => {
    await openOrder(post(openBody({ price: 1234 })));

    expect(adapter.openTrade).toHaveBeenCalledWith(expect.objectContaining({ orderKind: "MARKET", price: null }));
  });

  test("the broker's note about a partly filled order reaches the trader", async () => {
    useAdapter({ openTrade: vi.fn(async () => ({ ok: true, brokerPositionId: "9001", note: "Only part of the volume was executed." })) });

    const body = await readJson(await openOrder(post(openBody())));

    expect(body.data).toMatchObject({ ok: true, ticket: "9001", note: "Only part of the volume was executed." });
  });

  test("the order comment can never be mistaken for a copy-engine order", () => {
    expect(WEB_TRADE_COMMENT.toLowerCase().startsWith("wsa:")).toBe(false);
  });

  test("stop loss and take profit are optional", async () => {
    const response = await openOrder(post(openBody({ stopLoss: undefined, takeProfit: null })));

    expect(response.status).toBe(200);
    expect(adapter.openTrade).toHaveBeenCalledWith(expect.objectContaining({ stopLoss: null, takeProfit: null }));
  });

  test("the same request id never places a second order", async () => {
    const body = openBody();

    const first = await readJson(await openOrder(post(body)));
    const second = await readJson(await openOrder(post(body)));

    expect(first.data).toMatchObject({ ok: true, ticket: "9001" });
    expect(first.data.repeated).toBeUndefined();
    expect(second.data).toMatchObject({ ok: true, ticket: "9001", repeated: true });
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  test("a second click while the first order is still travelling is refused", async () => {
    let release: () => void = () => undefined;
    useAdapter({
      openTrade: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true, brokerPositionId: "9002", brokerOrderId: "9002" });
          }),
      ),
    });
    const body = openBody();

    const first = openOrder(post(body));
    await vi.waitFor(() => expect(adapter.openTrade).toHaveBeenCalledTimes(1));
    const second = await openOrder(post(body));

    expect(second.status).toBe(409);
    expect((await readJson(second)).error?.code).toBe("ORDER_IN_PROGRESS");

    release();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect((await readJson(firstResponse)).data.ticket).toBe("9002");
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
  });

  test("a broker rejection reaches the trader in plain words and is not remembered as done", async () => {
    useAdapter({
      openTrade: vi.fn(async () => {
        throw new BrokerExecutionError("PROVIDER_ERROR", "Invalid stops", 502);
      }),
    });
    const body = openBody();

    const response = await openOrder(post(body));
    const parsed = await readJson(response);

    expect(response.status).toBe(502);
    expect(parsed.error).toEqual({ code: "PROVIDER_ERROR", message: "Invalid stops" });
    expect(writeAuditLog).not.toHaveBeenCalled();

    // the trader fixes the stops and sends the same ticket again: it is a new attempt, not a replay
    await openOrder(post(body));
    expect(adapter.openTrade).toHaveBeenCalledTimes(2);
  });

  test("an unexpected failure on the broker path is sanitised", async () => {
    useAdapter({
      openTrade: vi.fn(async () => {
        throw new Error("Api2Trade responded with login=12345678 password=hunter2");
      }),
    });

    const response = await openOrder(post(openBody()));
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("12345678");
    expect(text).not.toMatch(/api2trade/i);
  });

  test("a runaway client is stopped by the per-minute ceiling", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      // an account that is not the caller's: each call is refused early but still counts
      statuses.push((await openOrder(post(openBody({ accountId: FOREIGN_ACCOUNT })))).status);
    }

    expect(statuses.slice(0, 30).every((status) => status === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });
});

describe("POST /api/terminal/trade/modify", () => {
  const modify = (body: Record<string, unknown>) => modifyPosition(post({ accountId: ACCOUNT, ticket: "5001", ...body }));

  test.each([
    ["no ticket", { ticket: undefined, takeProfit: 2420 }],
    ["a ticket with letters", { ticket: "50a1", takeProfit: 2420 }],
    ["nothing to change", {}],
    ["a negative level", { takeProfit: -5 }],
  ])("rejects a request with %s", async (_name, body) => {
    const response = await modify(body);

    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("VALIDATION_ERROR");
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("a position that is no longer open is a 404", async () => {
    const response = await modify({ ticket: "7777", takeProfit: 2420 });

    expect(response.status).toBe(404);
    expect((await readJson(response)).error?.code).toBe("POSITION_NOT_FOUND");
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("changing only the take profit keeps the stop loss", async () => {
    const response = await modify({ takeProfit: 2420 });

    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toMatchObject({
      ok: true,
      ticket: "5001",
      detail: { symbol: "XAUUSD", stopLoss: 2380, takeProfit: 2420 },
    });
    expect(adapter.modifyTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "5001",
      stopLoss: 2380,
      takeProfit: 2420,
      stages: expect.any(Object),
    });
    expect(auditCall()).toMatchObject({
      actorUserId: USER,
      action: "WEB_TRADE_POSITION_MODIFIED",
      entityId: ACCOUNT,
      metadata: { ticket: "5001", symbol: "XAUUSD", stopLoss: 2380, takeProfit: 2420, route: "direct" },
    });
  });

  test("null removes a level (the broker reads 0 as none)", async () => {
    const response = await modify({ stopLoss: null });

    expect(response.status).toBe(200);
    expect(adapter.modifyTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "5001",
      stopLoss: 0,
      takeProfit: 2410,
      stages: expect.any(Object),
    });
    expect(auditCall()).toMatchObject({ metadata: { stopLoss: null, takeProfit: 2410 } });
  });

  test("sending the values the position already has is refused as no change", async () => {
    const response = await modify({ stopLoss: 2380, takeProfit: 2410 });

    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("NO_CHANGE");
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("a stop loss above the existing take profit of a buy is refused", async () => {
    const response = await modify({ stopLoss: 2430 });
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(body.error?.message).toContain("stop loss must be below the take profit");
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("a sell keeps the opposite rule", async () => {
    useAdapter({
      fetchTradingState: vi.fn(async () =>
        tradingState({ positions: [{ ...POSITION, side: "SELL" as const, stopLoss: 2420, takeProfit: 2380 }] }),
      ),
    });

    const refused = await modify({ takeProfit: 2430 });
    expect(refused.status).toBe(400);

    const accepted = await modify({ takeProfit: 2370 });
    expect(accepted.status).toBe(200);
  });

  test("a pending order can be moved: new entry price, its levels kept", async () => {
    const response = await modify({ ticket: "6001", price: 1.075 });

    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toMatchObject({
      ok: true,
      ticket: "6001",
      detail: { price: 1.075, stopLoss: 1.07, takeProfit: 1.1 },
    });
    expect(adapter.modifyTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "6001",
      price: 1.075,
      stopLoss: 1.07,
      takeProfit: 1.1,
      stages: expect.any(Object),
    });
    expect(auditCall()).toMatchObject({ metadata: { ticket: "6001", symbol: "EURUSD.r", price: 1.075, stopLoss: 1.07, takeProfit: 1.1 } });
  });

  test("a pending order cannot be moved to a price that puts its stop on the wrong side", async () => {
    const response = await modify({ ticket: "6001", price: 1.065 });

    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("VALIDATION_ERROR");
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("an entry price only makes sense for a pending order", async () => {
    const response = await modify({ price: 2395 });
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body.error?.message).toContain("pending order");
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("is still allowed when risk rules block new orders - reducing risk is never refused", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue({ blockedNewTrades: true, breachedRules: [{ name: "Max drawdown" }] } as never);

    const response = await modify({ takeProfit: 2420 });

    expect(response.status).toBe(200);
    expect(getRiskEnforcementState).not.toHaveBeenCalled();
    expect(adapter.modifyTrade).toHaveBeenCalledTimes(1);
  });

  test("follows the same platform gate as new orders", async () => {
    useAdapter({ executionAvailable: vi.fn(() => false) });
    const switchedOff = await modify({ takeProfit: 2420 });
    expect(switchedOff.status).toBe(503);

    useAdapter();
    resetWebTradeCaches();
    vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "CANCELED" } as never);
    const unpaid = await modify({ takeProfit: 2420 });
    expect(unpaid.status).toBe(403);

    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("another user's account is not found", async () => {
    const response = await modifyPosition(post({ accountId: FOREIGN_ACCOUNT, ticket: "5001", takeProfit: 2420 }));

    expect(response.status).toBe(404);
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
    expect(adapter.modifyTrade).not.toHaveBeenCalled();
  });

  test("a broker rejection comes back as readable text", async () => {
    useAdapter({
      modifyTrade: vi.fn(async () => {
        throw new BrokerExecutionError("PROVIDER_ERROR", "Invalid stops", 502);
      }),
    });

    const response = await modify({ takeProfit: 2420 });

    expect(response.status).toBe(502);
    expect((await readJson(response)).error?.message).toBe("Invalid stops");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("POST /api/terminal/trade/close", () => {
  const close = (body: Record<string, unknown> = {}) => closePosition(post({ accountId: ACCOUNT, ticket: "5001", ...body }));

  test.each([
    ["no ticket", { ticket: undefined }],
    ["a volume of zero", { volume: 0 }],
    ["a negative volume", { volume: -0.1 }],
  ])("rejects a request with %s", async (_name, body) => {
    const response = await close(body);

    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("VALIDATION_ERROR");
    expect(adapter.closeTrade).not.toHaveBeenCalled();
  });

  test("closes the whole position at once, without reading the account first", async () => {
    const response = await close();

    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toMatchObject({ ok: true, ticket: "5001" });
    expect(adapter.closeTrade).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerPositionId: "5001",
      volume: null,
      comment: WEB_TRADE_COMMENT,
      stages: expect.any(Object),
    });
    expect(adapter.fetchTradingState).not.toHaveBeenCalled();
    expect(auditCall()).toMatchObject({
      actorUserId: USER,
      action: "WEB_TRADE_POSITION_CLOSED",
      entityId: ACCOUNT,
      metadata: { ticket: "5001", requestedVolume: null, partial: false, route: "direct" },
    });
  });

  test("closes only part of the position when a volume is given", async () => {
    const response = await close({ volume: 0.2 });

    expect(response.status).toBe(200);
    expect(adapter.closeTrade).toHaveBeenCalledWith(expect.objectContaining({ volume: 0.2, brokerPositionId: "5001" }));
    expect(auditCall()).toMatchObject({ metadata: { requestedVolume: 0.2, closedVolume: 0.2, partial: true } });
  });

  test("the volume the broker really closed is what the audit log records", async () => {
    useAdapter({ closeTrade: vi.fn(async () => ({ ok: true, executedVolume: 0.15 })) });

    await close({ volume: 0.2 });

    expect(auditCall()).toMatchObject({ metadata: { requestedVolume: 0.2, closedVolume: 0.15 } });
  });

  test("more than what is open is the broker's refusal, in its words", async () => {
    useAdapter({
      closeTrade: vi.fn(async () => {
        throw new BrokerExecutionError("PROVIDER_ERROR", "Invalid volume.", 502);
      }),
    });

    const response = await close({ volume: 0.75 });
    const body = await readJson(response);

    expect(response.status).toBe(502);
    expect(body.error).toEqual({ code: "PROVIDER_ERROR", message: "Invalid volume." });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("a position that is already closed is the broker's 'no such order'", async () => {
    useAdapter({
      closeTrade: vi.fn(async () => {
        throw new BrokerExecutionError("PROVIDER_ERROR", "That order does not exist any more.", 502);
      }),
    });

    const response = await close({ ticket: "4242" });

    expect(response.status).toBe(502);
    expect((await readJson(response)).error?.message).toBe("That order does not exist any more.");
  });

  test("is still allowed when risk rules block new orders", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue({ blockedNewTrades: true, breachedRules: [{ name: "Max drawdown" }] } as never);

    const response = await close();

    expect(response.status).toBe(200);
    expect(getRiskEnforcementState).not.toHaveBeenCalled();
    expect(adapter.closeTrade).toHaveBeenCalledTimes(1);
  });

  test("another user's account is not found", async () => {
    const response = await closePosition(post({ accountId: FOREIGN_ACCOUNT, ticket: "5001" }));

    expect(response.status).toBe(404);
    expect(adapter.closeTrade).not.toHaveBeenCalled();
  });

  test("a second account of the same user is treated on its own", async () => {
    db.tables.trading_accounts = [accountRow(ACCOUNT, USER), accountRow(SECOND_ACCOUNT, USER)];

    const response = await closePosition(post({ accountId: SECOND_ACCOUNT, ticket: "5001" }));

    expect(response.status).toBe(200);
    expect(adapter.closeTrade).toHaveBeenCalledWith(expect.objectContaining({ accountId: SECOND_ACCOUNT }));
  });
});

describe("POST /api/terminal/trade/cancel", () => {
  const cancel = (body: Record<string, unknown> = {}) => cancelOrder(post({ accountId: ACCOUNT, ticket: "6001", ...body }));

  test("deletes a pending order and writes the audit log", async () => {
    const response = await cancel();

    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toMatchObject({ ok: true, ticket: "6001", detail: { symbol: "EURUSD.r" } });
    expect(adapter.cancelOrder).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      brokerOrderId: "6001",
      stages: expect.any(Object),
    });
    expect(auditCall()).toMatchObject({
      actorUserId: USER,
      action: "WEB_TRADE_ORDER_CANCELLED",
      entityId: ACCOUNT,
      metadata: { ticket: "6001", symbol: "EURUSD.r", route: "direct" },
    });
  });

  test("an open position is never closed through this route", async () => {
    const response = await cancel({ ticket: "5001" });
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(body.error?.message).toContain("close it instead");
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
    expect(adapter.closeTrade).not.toHaveBeenCalled();
  });

  test("an order that is gone is a 404", async () => {
    const response = await cancel({ ticket: "7777" });

    expect(response.status).toBe(404);
    expect((await readJson(response)).error?.code).toBe("POSITION_NOT_FOUND");
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
  });

  test("a bridge that cannot delete orders says so", async () => {
    useAdapter({ cancelOrder: undefined });

    const response = await cancel();

    expect(response.status).toBe(501);
    expect((await readJson(response)).error?.code).toBe("NOT_SUPPORTED");
  });

  test("is not blocked by risk rules, but follows the platform gate", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue({ blockedNewTrades: true, breachedRules: [{ name: "Max drawdown" }] } as never);
    expect((await cancel()).status).toBe(200);
    expect(getRiskEnforcementState).not.toHaveBeenCalled();

    resetWebTradeCaches();
    vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "NONE" } as never);
    expect((await cancel()).status).toBe(403);

    useAdapter({ executionAvailable: vi.fn(() => false) });
    vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "ACTIVE" } as never);
    expect((await cancel()).status).toBe(503);
  });

  test("another user's account is not found; a body without a ticket is a 400", async () => {
    expect((await cancelOrder(post({ accountId: FOREIGN_ACCOUNT, ticket: "6001" }))).status).toBe(404);
    expect((await cancel({ ticket: undefined })).status).toBe(400);
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
  });
});

describe("POST /api/terminal/trade/close-bulk", () => {
  const bulk = (body: Record<string, unknown> = {}) => closeBulk(post({ accountId: ACCOUNT, scope: "ALL", ...body }));

  beforeEach(() => {
    useAdapter({ fetchTradingState: vi.fn(async () => tradingState({ positions: [POSITION, LOSER] })) });
  });

  test.each([
    ["no scope", { scope: undefined }],
    ["a scope that does not exist", { scope: "EVERYTHING" }],
    ["one symbol without saying which", { scope: "SYMBOL" }],
  ])("rejects a request with %s", async (_name, body) => {
    const response = await bulk(body);

    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("VALIDATION_ERROR");
    expect(adapter.closeTrade).not.toHaveBeenCalled();
  });

  test("closes the losers only", async () => {
    const response = await bulk({ scope: "LOSS" });

    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toEqual({ ok: true, ticket: null, closed: 1, failed: 0 });
    expect(adapter.closeTrade).toHaveBeenCalledTimes(1);
    expect(adapter.closeTrade).toHaveBeenCalledWith(expect.objectContaining({ brokerPositionId: "5002" }));
    expect(auditCall()).toMatchObject({
      action: "WEB_TRADE_BULK_CLOSED",
      entityId: ACCOUNT,
      metadata: { scope: "LOSS", symbol: null, closed: 1, failed: 0, route: "direct" },
    });
  });

  test("closes everything that is open, and leaves the pending orders alone", async () => {
    const response = await bulk({ scope: "ALL" });

    expect((await readJson(response)).data).toMatchObject({ closed: 2, failed: 0 });
    expect(adapter.closeTrade).toHaveBeenCalledTimes(2);
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
  });

  test("one symbol, matched the way the broker spells it", async () => {
    const response = await bulk({ scope: "SYMBOL", symbol: "eurusd.R" });

    expect((await readJson(response)).data).toMatchObject({ closed: 1 });
    expect(adapter.closeTrade).toHaveBeenCalledWith(expect.objectContaining({ brokerPositionId: "5002" }));
  });

  test("deletes the pending orders", async () => {
    const response = await bulk({ scope: "PENDING" });

    expect((await readJson(response)).data).toMatchObject({ closed: 1, failed: 0 });
    expect(adapter.cancelOrder).toHaveBeenCalledWith({ accountId: ACCOUNT, brokerOrderId: "6001" });
    expect(adapter.closeTrade).not.toHaveBeenCalled();
  });

  test("when part of it fails the answer lists what could not be closed", async () => {
    useAdapter({
      fetchTradingState: vi.fn(async () => tradingState({ positions: [POSITION, LOSER] })),
      closeTrade: vi.fn(async (request: { brokerPositionId: string }) => {
        if (request.brokerPositionId === "5002") throw new BrokerExecutionError("PROVIDER_ERROR", "Market is closed.", 502);
        return { ok: true };
      }),
    });

    const response = await bulk({ scope: "ALL" });
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      closed: 1,
      failed: 1,
      failures: [{ ticket: "5002", symbol: "EURUSD.r", message: "Market is closed." }],
    });
  });

  test("when nothing could be closed it is an error, with the reason", async () => {
    useAdapter({
      fetchTradingState: vi.fn(async () => tradingState({ positions: [POSITION, LOSER] })),
      closeTrade: vi.fn(async () => {
        throw new BrokerExecutionError("PROVIDER_ERROR", "Market is closed.", 502);
      }),
    });

    const response = await bulk({ scope: "ALL" });
    const body = await readJson(response);

    expect(response.status).toBe(502);
    expect(body.error?.code).toBe("BULK_FAILED");
    expect(body.error?.message).toContain("Market is closed.");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("nothing to close is an honest answer, not an error", async () => {
    useAdapter({ fetchTradingState: vi.fn(async () => tradingState({ positions: [POSITION], pending: [] })) });

    const response = await bulk({ scope: "LOSS" });

    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toEqual({
      ok: true,
      ticket: null,
      note: "There was nothing to close.",
      closed: 0,
      failed: 0,
    });
  });

  test("is not blocked by risk rules; another user's account is not found", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue({ blockedNewTrades: true, breachedRules: [{ name: "Max drawdown" }] } as never);

    expect((await bulk({ scope: "LOSS" })).status).toBe(200);
    expect(getRiskEnforcementState).not.toHaveBeenCalled();
    expect((await closeBulk(post({ accountId: FOREIGN_ACCOUNT, scope: "ALL" }))).status).toBe(404);
  });
});


describe("the platform subscription check on the order path", () => {
  test("an active subscriber is settled by the one-query check: the full billing picture is not read", async () => {
    vi.mocked(hasActivePlatformProductSubscription).mockResolvedValue(true);

    const response = await openOrder(post(openBody()));

    expect(response.status).toBe(200);
    expect(hasActivePlatformProductSubscription).toHaveBeenCalledWith(USER);
    expect(getPlatformSubscriptionAccess).not.toHaveBeenCalled();
  });

  test("a yes is remembered for a few seconds, so the next orders cost no billing query at all", async () => {
    vi.mocked(hasActivePlatformProductSubscription).mockResolvedValue(true);

    expect((await openOrder(post(openBody()))).status).toBe(200);
    expect((await openOrder(post(openBody()))).status).toBe(200);
    expect((await closePosition(post({ accountId: ACCOUNT, ticket: "5001" }))).status).toBe(200);

    expect(hasActivePlatformProductSubscription).toHaveBeenCalledTimes(1);
    expect(getPlatformSubscriptionAccess).not.toHaveBeenCalled();
  });

  test("a no is never remembered: the full picture decides every time (and still repairs old records)", async () => {
    vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "NONE" } as never);

    expect((await openOrder(post(openBody()))).status).toBe(403);
    expect((await openOrder(post(openBody()))).status).toBe(403);

    expect(getPlatformSubscriptionAccess).toHaveBeenCalledTimes(2);
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });

  test("a failing quick check never refuses a subscriber: the full picture is asked instead", async () => {
    vi.mocked(hasActivePlatformProductSubscription).mockRejectedValue(new Error("database unavailable"));

    const response = await openOrder(post(openBody()));

    expect(response.status).toBe(200);
    expect(getPlatformSubscriptionAccess).toHaveBeenCalledTimes(1);
  });

  test("an order of a user whose subscription is not the quick kind (manual approval) is still allowed by the full picture", async () => {
    vi.mocked(hasActivePlatformProductSubscription).mockResolvedValue(false);
    vi.mocked(getPlatformSubscriptionAccess).mockResolvedValue({ status: "ACTIVE" } as never);

    expect((await openOrder(post(openBody()))).status).toBe(200);
  });
});

describe("waking the order routes up", () => {
  test("a GET only wakes a route: no sign-in, no database, nothing sent to the broker", async () => {
    vi.mocked(requireTrader).mockClear();
    vi.mocked(requireTrader).mockRejectedValue(new AuthError("UNAUTHORIZED", "Not authenticated", 401));

    for (const warm of [warmOpen, warmModify, warmClose, warmCancel, warmCloseBulk]) {
      const response = await warm();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await readJson(response)).toEqual({ ok: true, data: { warm: true } });
    }

    expect(requireTrader).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
    expect(adapter.openTrade).not.toHaveBeenCalled();
  });

  test("a GET that names an account also reads what an order on it checks - once - so the order finds it in memory", async () => {
    vi.mocked(requireTrader).mockClear();

    const response = await warmOpen(getRequest("open", { accountId: ACCOUNT }));

    expect(await readJson(response)).toEqual({ ok: true, data: { warm: true } });
    // it signed in the cheap way, and looked at the account, its risk verdict and the subscription
    expect(requireTrader).toHaveBeenCalledWith({ cached: true });
    expect(db.callsTo("trading_accounts")).toHaveLength(1);
    expect(getRiskEnforcementState).toHaveBeenCalledTimes(1);
    expect(getPlatformSubscriptionAccess).toHaveBeenCalledTimes(1);

    expect((await openOrder(post(openBody()))).status).toBe(200);

    expect(db.callsTo("trading_accounts")).toHaveLength(1);
    expect(getRiskEnforcementState).toHaveBeenCalledTimes(1);
    expect(getPlatformSubscriptionAccess).toHaveBeenCalledTimes(1);
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
  });

  test("the warm-up never says more than { warm: true }: not for an account that is not the caller's, not when signed out", async () => {
    const foreign = await warmOpen(getRequest("open", { accountId: FOREIGN_ACCOUNT }));
    expect(await readJson(foreign)).toEqual({ ok: true, data: { warm: true } });
    // the foreign account was looked up for the caller and found nothing: nothing is kept, no risk verdict was read
    expect(getRiskEnforcementState).not.toHaveBeenCalled();

    vi.mocked(requireTrader).mockRejectedValue(new AuthError("UNAUTHORIZED", "Not authenticated", 401));
    db.reset();
    const signedOut = await warmOpen(getRequest("open", { accountId: ACCOUNT }));
    expect(signedOut.status).toBe(200);
    expect(await readJson(signedOut)).toEqual({ ok: true, data: { warm: true } });
    expect(db.calls).toHaveLength(0);
  });

  test("an id that is not an account id is ignored: the route is only woken up", async () => {
    vi.mocked(requireTrader).mockClear();

    const response = await warmOpen(getRequest("open", { accountId: "not-an-id" }));

    expect(await readJson(response)).toEqual({ ok: true, data: { warm: true } });
    expect(requireTrader).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });
});

describe("what an order keeps in memory for a few seconds", () => {
  const START = new Date("2026-10-20T10:00:00.000Z");
  /** Only the clock is faked: the routes and the in-memory database run as usual. */
  const clockAt = (offsetMs = 0) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(START.getTime() + offsetMs) });
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const BLOCK = {
    accountId: ACCOUNT,
    blockedNewTrades: true,
    restricted: true,
    breachedRules: [{ name: "Max drawdown" }],
    source: "RISK_WORKER",
    lastEvaluatedAt: "2026-10-20T09:59:58.000Z",
  };
  const trader = () =>
    ({ id: USER, email: "trader@example.com", name: "Test Trader", role: "TRADER", status: "ACTIVE" }) as SessionUser;

  afterEach(() => {
    vi.useRealTimers();
  });

  test("every poll and every order signs in the cheap way (a verified sign-in is reused for a few seconds)", async () => {
    vi.mocked(requireTrader).mockClear();

    await listAccounts();
    await readState(stateRequest({ accountId: ACCOUNT }));
    await readSymbols(getRequest("symbols", { accountId: ACCOUNT }));
    await openOrder(post(openBody()));
    await modifyPosition(post({ accountId: ACCOUNT, ticket: "5001", takeProfit: 2420 }));
    await closePosition(post({ accountId: ACCOUNT, ticket: "5001" }));
    await cancelOrder(post({ accountId: ACCOUNT, ticket: "6001" }));
    await closeBulk(post({ accountId: ACCOUNT, scope: "ALL" }));

    const calls = vi.mocked(requireTrader).mock.calls;
    expect(calls).toHaveLength(8);
    for (const call of calls) expect(call[0]).toEqual({ cached: true });
  });

  test("a connected account is read once for a series of orders and polls - and again after fifteen seconds", async () => {
    clockAt();

    expect((await openOrder(post(openBody()))).status).toBe(200);
    expect((await closePosition(post({ accountId: ACCOUNT, ticket: "5001" }))).status).toBe(200);
    expect((await readState(stateRequest({ accountId: ACCOUNT }))).status).toBe(200);
    expect(db.callsTo("trading_accounts")).toHaveLength(1);

    later(14_000);
    expect((await openOrder(post(openBody()))).status).toBe(200);
    expect(db.callsTo("trading_accounts")).toHaveLength(1);

    later(2_000);
    expect((await openOrder(post(openBody()))).status).toBe(200);
    expect(db.callsTo("trading_accounts")).toHaveLength(2);
    // (always for the signed-in person: the owner is part of every read)
    for (const read of db.callsTo("trading_accounts")) expect(read.filters).toContainEqual({ op: "eq", column: "user_id", value: USER });
  });

  test("listing the accounts is enough for the first order to find its account in memory", async () => {
    await listAccounts();
    expect(db.callsTo("trading_accounts")).toHaveLength(1);

    expect((await openOrder(post(openBody()))).status).toBe(200);

    expect(db.callsTo("trading_accounts")).toHaveLength(1);
  });

  test("an account that is not valid is never kept: reconnecting it is seen by the very next order", async () => {
    clockAt();
    db.tables.trading_accounts = [accountRow(ACCOUNT, USER, { status: "DISCONNECTED" })];
    expect((await openOrder(post(openBody()))).status).toBe(409);
    expect((await openOrder(post(openBody()))).status).toBe(409);
    expect(db.callsTo("trading_accounts")).toHaveLength(2);

    db.tables.trading_accounts = [accountRow(ACCOUNT, USER)];
    expect((await openOrder(post(openBody()))).status).toBe(200);
    expect(db.callsTo("trading_accounts")).toHaveLength(3);

    db.tables.trading_accounts = [];
    later(16_000);
    expect((await openOrder(post(openBody()))).status).toBe(404);
  });

  test("what is kept belongs to the person who was signed in: nobody else gets an account out of memory", async () => {
    expect((await openOrder(post(openBody()))).status).toBe(200);

    signIn({ id: freshUserId() });
    const response = await openOrder(post(openBody()));

    expect(response.status).toBe(404);
    expect((await readJson(response)).error?.code).toBe("ACCOUNT_NOT_FOUND");
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
  });

  test("a risk verdict that lets orders through is kept for four seconds, then read again", async () => {
    clockAt();

    expect((await openOrder(post(openBody()))).status).toBe(200);
    later(3_900);
    expect((await openOrder(post(openBody()))).status).toBe(200);
    expect(getRiskEnforcementState).toHaveBeenCalledTimes(1);

    later(200);
    expect((await openOrder(post(openBody()))).status).toBe(200);
    expect(getRiskEnforcementState).toHaveBeenCalledTimes(2);
  });

  test("a risk block is never kept: it is refused every time, and lifted at the very next order", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue(BLOCK as never);

    expect((await openOrder(post(openBody()))).status).toBe(423);
    expect((await openOrder(post(openBody()))).status).toBe(423);
    expect(getRiskEnforcementState).toHaveBeenCalledTimes(2);

    vi.mocked(getRiskEnforcementState).mockResolvedValue(null);
    expect((await openOrder(post(openBody()))).status).toBe(200);
    expect(getRiskEnforcementState).toHaveBeenCalledTimes(3);
    expect(adapter.openTrade).toHaveBeenCalledTimes(1);
  });

  test("reducing risk never asks about risk at all", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue(BLOCK as never);

    expect((await closePosition(post({ accountId: ACCOUNT, ticket: "5001" }))).status).toBe(200);
    expect((await modifyPosition(post({ accountId: ACCOUNT, ticket: "5001", takeProfit: 2420 }))).status).toBe(200);

    expect(getRiskEnforcementState).not.toHaveBeenCalled();
  });

  test("a poll every second reads the account once and the risk verdict every two seconds (young enough for an order pass to rest on)", async () => {
    clockAt();

    for (let poll = 0; poll < 5; poll += 1) {
      expect((await readState(stateRequest({ accountId: ACCOUNT }))).status).toBe(200);
      later(1_000);
    }

    expect(db.callsTo("trading_accounts")).toHaveLength(1);
    expect(getRiskEnforcementState).toHaveBeenCalledTimes(3); // at 0 s, 2 s and 4 s
  });

  test("a poll still shows a risk block as soon as it is read (and an order is refused with it)", async () => {
    vi.mocked(getRiskEnforcementState).mockResolvedValue(BLOCK as never);

    const state = (await readJson(await readState(stateRequest({ accountId: ACCOUNT })))).data;

    expect(state.riskBlocked).toBe(true);
    expect(state.riskMessage).toContain("Max drawdown");
  });

  describe("the upkeep that keeps all of it young", () => {
    test("renews a copy that is about half old and leaves a young one alone", async () => {
      clockAt();
      vi.mocked(hasActivePlatformProductSubscription).mockResolvedValue(true);
      const reads = () => ({
        accounts: db.callsTo("trading_accounts").length,
        risk: vi.mocked(getRiskEnforcementState).mock.calls.length,
        subscription: vi.mocked(hasActivePlatformProductSubscription).mock.calls.length,
      });

      await warmWebTradeGates(trader(), ACCOUNT, true);
      expect(reads()).toEqual({ accounts: 1, risk: 1, subscription: 1 });

      later(1_000);
      await warmWebTradeGates(trader(), ACCOUNT, false);
      expect(reads()).toEqual({ accounts: 1, risk: 1, subscription: 1 });

      // account (7 s) and risk verdict (2 s) are old enough, the subscription (15 s) is not
      later(7_000);
      await warmWebTradeGates(trader(), ACCOUNT, false);
      expect(reads()).toEqual({ accounts: 2, risk: 2, subscription: 1 });

      later(8_000);
      await warmWebTradeGates(trader(), ACCOUNT, false);
      expect(reads()).toEqual({ accounts: 3, risk: 3, subscription: 2 });
    });

    test("an order that follows finds everything in memory", async () => {
      clockAt();
      vi.mocked(hasActivePlatformProductSubscription).mockResolvedValue(true);
      await warmWebTradeGates(trader(), ACCOUNT, true);

      later(1_500);
      expect((await openOrder(post(openBody()))).status).toBe(200);

      expect(db.callsTo("trading_accounts")).toHaveLength(1);
      expect(getRiskEnforcementState).toHaveBeenCalledTimes(1);
      expect(hasActivePlatformProductSubscription).toHaveBeenCalledTimes(1);
    });

    test("a poll alone never checks the subscription of somebody who was not seen to have one", async () => {
      await warmWebTradeGates(trader(), ACCOUNT, false);

      expect(hasActivePlatformProductSubscription).not.toHaveBeenCalled();
      expect(getPlatformSubscriptionAccess).not.toHaveBeenCalled();
      expect(db.callsTo("trading_accounts")).toHaveLength(1);
    });

    test("it never throws and never refuses anything, whatever fails", async () => {
      db.errors.trading_accounts = { code: "XX000", message: "database down" };
      vi.mocked(hasActivePlatformProductSubscription).mockRejectedValue(new Error("billing down"));
      vi.mocked(getPlatformSubscriptionAccess).mockRejectedValue(new Error("billing down"));

      await expect(warmWebTradeGates(trader(), ACCOUNT, true)).resolves.toBeUndefined();
      expect(getRiskEnforcementState).not.toHaveBeenCalled();
    });

    test("an account that is not the person's costs a lookup and keeps nothing", async () => {
      await warmWebTradeGates(trader(), FOREIGN_ACCOUNT, true);

      expect(getRiskEnforcementState).not.toHaveBeenCalled();
      expect((await openOrder(post(openBody({ accountId: FOREIGN_ACCOUNT })))).status).toBe(404);
    });

    test("a partner is not warmed at all", async () => {
      await warmWebTradeGates({ ...trader(), role: "PARTNER" }, ACCOUNT, true);

      expect(db.calls).toHaveLength(0);
      expect(getRiskEnforcementState).not.toHaveBeenCalled();
    });

    test("an administrator needs no subscription: nothing is asked of billing", async () => {
      await warmWebTradeGates({ ...trader(), role: "ADMIN" }, ACCOUNT, true);

      expect(hasActivePlatformProductSubscription).not.toHaveBeenCalled();
      expect(getPlatformSubscriptionAccess).not.toHaveBeenCalled();
    });
  });
});
