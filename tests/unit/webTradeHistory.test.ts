import { beforeEach, describe, expect, test, vi } from "vitest";
import { requireTrader } from "@/lib/auth/session";
import { GET as readHistory } from "@/app/api/terminal/trade/history/route";
import { resetWebTradeCaches } from "@/lib/services/webTradeService";
import {
  formatHeld,
  historySince,
  mergeHistory,
  rowFromClose,
  sameClosedTrade,
  summarizeHistory,
  type WebTradeHistoryRow,
} from "@/lib/trade/webTradeHistory";
import { sharedDb as db } from "./helpers/memoryDb";
import { ACCOUNT, accountRow, FOREIGN_ACCOUNT, freshUserId, getRequest, OTHER_USER, readJson } from "./helpers/webTradeFixtures";

// The History tab of WSA Trade: the pure helpers, and the route that reads the closed trades of the caller's own account.

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
  return { AuthError, requireTrader: vi.fn(), currentTokenFacts: vi.fn(async () => null) };
});
vi.mock("@/lib/services/auditService", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/lib/services/billingService", () => ({
  getPlatformSubscriptionAccess: vi.fn(),
  hasActivePlatformProductSubscription: vi.fn(),
}));
vi.mock("@/lib/services/riskService", () => ({ getRiskEnforcementState: vi.fn() }));
vi.mock("@/lib/broker/provider", () => ({ createBrokerAdapter: vi.fn() }));

const row = (overrides: Partial<WebTradeHistoryRow> = {}): WebTradeHistoryRow => ({
  ticket: "1001",
  symbol: "EURUSD",
  side: "BUY",
  volume: 0.1,
  openPrice: 1.1,
  closePrice: 1.101,
  profit: 10,
  openedAt: "2026-10-24T09:00:00.000Z",
  closedAt: "2026-10-24T10:00:00.000Z",
  ...overrides,
});

describe("history helpers", () => {
  test("a period starts at the right instant: today at the local midnight, the others that many days back, 'all' at none", () => {
    const now = new Date(2026, 9, 24, 15, 30, 0);
    expect(historySince("today", now)).toBe(new Date(2026, 9, 24, 0, 0, 0, 0).toISOString());
    expect(historySince("week", now)).toBe(new Date(now.getTime() - 7 * 86_400_000).toISOString());
    expect(historySince("month", now)).toBe(new Date(now.getTime() - 30 * 86_400_000).toISOString());
    expect(historySince("quarter", now)).toBe(new Date(now.getTime() - 90 * 86_400_000).toISOString());
    expect(historySince("all", now)).toBeNull();
  });

  test("the figures above the list", () => {
    const summary = summarizeHistory([row({ profit: 30 }), row({ profit: -10, volume: 0.2 }), row({ profit: 0 })]);
    expect(summary).toMatchObject({ count: 3, wins: 1, losses: 1, net: 20, grossProfit: 30, grossLoss: -10, best: 30, worst: -10, lots: 0.4 });
    expect(summary.winRate).toBeCloseTo(33.333, 2);
    expect(summary.profitFactor).toBe(3);

    expect(summarizeHistory([])).toMatchObject({ count: 0, winRate: null, profitFactor: null, best: null, worst: null, net: 0 });
    expect(summarizeHistory([row({ profit: 5 })]).profitFactor).toBeNull();
  });

  test("a trade just closed from the panel is listed in front - until the synced record has it", () => {
    const synced = [row({ ticket: "900", closedAt: "2026-10-24T08:00:00.000Z" })];
    const justClosed = rowFromClose(
      { ticket: "1001", symbol: "EURUSD", side: "BUY", volume: 0.1, openPrice: 1.1, profit: 4.2, openedAt: "2026-10-24T09:30:00.000Z" },
      1.1004,
      "2026-10-24T10:00:00.000Z",
    );
    expect(justClosed).toMatchObject({ local: true, closePrice: 1.1004, profit: 4.2 });
    expect(rowFromClose({ ...justClosed, openedAt: null }, null, "2026-10-24T10:00:00.000Z").closePrice).toBeNull();

    const merged = mergeHistory(synced, [justClosed], null);
    expect(merged.map((entry) => entry.ticket)).toEqual(["1001", "900"]);

    // the record arrives under the same ticket ...
    expect(mergeHistory([row({ ticket: "1001", profit: 4.5, closedAt: "2026-10-24T10:00:03.000Z" }), ...synced], [justClosed], null)).toHaveLength(2);
    // ... or under another id for the same trade
    const spelledDifferently = row({ ticket: "P-1001", profit: 4.5, closedAt: "2026-10-24T10:00:03.000Z", openPrice: 1.1 });
    expect(sameClosedTrade(spelledDifferently, justClosed)).toBe(true);
    expect(mergeHistory([spelledDifferently], [justClosed], null)).toHaveLength(1);
    // another trade is not mistaken for it
    expect(sameClosedTrade(row({ ticket: "P-2", volume: 0.5 }), justClosed)).toBe(false);
    expect(sameClosedTrade(row({ ticket: "P-3", symbol: "GBPUSD" }), justClosed)).toBe(false);

    // outside the period it is not shown; with nothing to add the very same list comes back
    expect(mergeHistory(synced, [justClosed], "2026-10-25T00:00:00.000Z")).toBe(synced);
    expect(mergeHistory(synced, [], null)).toBe(synced);
  });

  test("how long a trade was open", () => {
    const opened = "2026-10-24T09:00:00.000Z";
    expect(formatHeld(opened, "2026-10-24T09:00:35.000Z")).toBe("35 s");
    expect(formatHeld(opened, "2026-10-24T09:14:10.000Z")).toBe("14 min");
    expect(formatHeld(opened, "2026-10-24T11:14:00.000Z")).toBe("2 h 14 min");
    expect(formatHeld(opened, "2026-10-27T13:00:00.000Z")).toBe("3 d 4 h");
    expect(formatHeld(null, opened)).toBe("");
    expect(formatHeld("2026-10-24T10:00:00.000Z", opened)).toBe("");
  });
});

describe("GET /api/terminal/trade/history", () => {
  let user = "";

  function signIn(overrides: Record<string, unknown> = {}) {
    vi.mocked(requireTrader).mockResolvedValue({
      id: user,
      email: "trader@example.com",
      role: "TRADER",
      status: "ACTIVE",
      ...overrides,
    } as Awaited<ReturnType<typeof requireTrader>>);
  }

  const tradeRow = (id: string, account: string, overrides: Record<string, unknown> = {}) => ({
    id: `row-${id}`,
    trading_account_id: account,
    external_trade_id: id,
    symbol: "XAUUSD",
    side: "SELL",
    status: "CLOSED",
    volume: "0.5000",
    open_price: "2350.500000",
    close_price: "2349.000000",
    profit: "75.00",
    opened_at: "2026-10-24T09:00:00.000Z",
    closed_at: "2026-10-24T10:00:00.000Z",
    ...overrides,
  });

  beforeEach(() => {
    user = freshUserId();
    db.reset();
    resetWebTradeCaches();
    db.tables.trading_accounts = [accountRow(ACCOUNT, user), accountRow(FOREIGN_ACCOUNT, OTHER_USER)];
    signIn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("lists the closed trades of the caller's own account, newest first, uncached", async () => {
    db.tables.trades = [
      tradeRow("3", ACCOUNT, { closed_at: "2026-10-24T12:00:00.000Z", profit: "-20.00" }),
      tradeRow("2", ACCOUNT),
      tradeRow("9", ACCOUNT, { status: "OPEN", closed_at: null }),
      tradeRow("7", FOREIGN_ACCOUNT),
    ];
    const since = "2026-10-20T00:00:00.000Z";

    const response = await readHistory(getRequest("history", { accountId: ACCOUNT, since }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.data.accountId).toBe(ACCOUNT);
    expect(body.data.currency).toBe("USD");
    expect(body.data.since).toBe(since);
    expect(body.data.truncated).toBe(false);
    expect(body.data.rows.map((entry: { ticket: string }) => entry.ticket)).toEqual(["3", "2"]);
    expect(body.data.rows[1]).toMatchObject({
      ticket: "2",
      symbol: "XAUUSD",
      side: "SELL",
      volume: 0.5,
      openPrice: 2350.5,
      closePrice: 2349,
      profit: 75,
      closedAt: "2026-10-24T10:00:00.000Z",
    });
    const filters = db.callsTo("trades")[0].filters;
    expect(filters).toContainEqual({ op: "eq", column: "trading_account_id", value: ACCOUNT });
    expect(filters).toContainEqual({ op: "eq", column: "status", value: "CLOSED" });
    expect(filters).toContainEqual({ op: "gte", column: "closed_at", value: since });
  });

  test("says when the period holds more than was asked for", async () => {
    db.tables.trades = [tradeRow("1", ACCOUNT), tradeRow("2", ACCOUNT), tradeRow("3", ACCOUNT)];

    const body = await readJson(await readHistory(getRequest("history", { accountId: ACCOUNT, limit: "2" })));

    expect(body.data.rows).toHaveLength(2);
    expect(body.data.truncated).toBe(true);
  });

  test("another person's account is not found, and nothing is read for it", async () => {
    db.tables.trades = [tradeRow("7", FOREIGN_ACCOUNT)];

    const response = await readHistory(getRequest("history", { accountId: FOREIGN_ACCOUNT }));

    expect(response.status).toBe(404);
    expect((await readJson(response)).error?.code).toBe("ACCOUNT_NOT_FOUND");
    expect(db.callsTo("trades")).toHaveLength(0);
  });

  test("needs a signed-in trader (not a partner) and a valid request", async () => {
    signIn({ role: "PARTNER" });
    expect((await readHistory(getRequest("history", { accountId: ACCOUNT }))).status).toBe(403);

    signIn();
    expect((await readHistory(getRequest("history", {}))).status).toBe(400);
    expect((await readHistory(getRequest("history", { accountId: ACCOUNT, since: "yesterday" }))).status).toBe(400);
    expect((await readHistory(getRequest("history", { accountId: ACCOUNT, limit: "100000" }))).status).toBe(400);
    expect(db.callsTo("trades")).toHaveLength(0);
  });

  test("a database failure is a plain 503 that does not leak the details", async () => {
    db.errors.trades = { message: 'relation "secret_internal_table" does not exist' };

    const response = await readHistory(getRequest("history", { accountId: ACCOUNT }));
    const text = await response.clone().text();

    expect(response.status).toBe(503);
    expect(text).not.toContain("secret_internal_table");
  });
});
