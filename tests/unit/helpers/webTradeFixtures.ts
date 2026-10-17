/**
 * Shared fixtures of the WSA Trade tests: accounts, a position, a loser, a pending
 * order, a broker connection that can read and trade, and small request helpers.
 * (The `vi.mock` calls stay in each test file - a mock factory cannot be shared.)
 */

import { vi } from "vitest";
import type { Row } from "./memoryDb";

export const OTHER_USER = "22222222-2222-4222-8222-222222222222";
export const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const SECOND_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
export const FOREIGN_ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
export const PROVIDER_ID = "provider-secret-77";

let userCounter = 0;
/** The service keeps a per-user ceiling in memory for the whole test file, so every test signs in as a user of its own. */
export function freshUserId(): string {
  userCounter += 1;
  return `00000000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
}

let requestCounter = 0;
export function requestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(8, "0")}`;
}

export function accountRow(id: string, userId: string, overrides: Row = {}): Row {
  return {
    id,
    user_id: userId,
    account_name: "Main account",
    broker_name: "IC Markets",
    broker_server: "ICMarketsSC-Demo",
    broker_platform: "MT5",
    currency: "USD",
    status: "CONNECTED",
    provider_account_id: PROVIDER_ID,
    ...overrides,
  };
}

export const POSITION = {
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
};

export const LOSER = {
  ...POSITION,
  ticket: "5002",
  symbol: "EURUSD.r",
  side: "SELL" as const,
  volume: 0.2,
  profit: -8,
  stopLoss: null,
  takeProfit: null,
};

export const PENDING = {
  ticket: "6001",
  symbol: "EURUSD.r",
  side: "BUY" as "BUY" | "SELL",
  kind: "LIMIT" as const,
  volume: 0.2,
  price: 1.08,
  stopLoss: 1.07 as number | null,
  takeProfit: 1.1 as number | null,
  placedAt: "2026-10-12T10:01:00.000Z",
  comment: null,
};

export function tradingState(overrides: Record<string, unknown> = {}) {
  return {
    currency: "USD",
    balance: 10_000,
    equity: 10_012.5,
    floatingProfit: 12.5,
    margin: 200,
    freeMargin: 9812.5,
    marginLevel: 5006,
    positions: [POSITION],
    pending: [PENDING],
    pendingOrders: 1,
    fetchedAt: "2026-10-12T10:05:00.000Z",
    ...overrides,
  };
}

/** A broker connection that can read and trade. */
export function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    executionAvailable: vi.fn(() => true),
    fetchTradingState: vi.fn(async () => tradingState()),
    fetchQuote: vi.fn(async (_account: string, symbol: string) => ({ symbol, bid: 2400.1, ask: 2400.4 })),
    fetchSymbolList: vi.fn(async () => [{ name: "XAUUSD", description: "Gold", path: "Metals\\XAUUSD", digits: 2 }]),
    openTrade: vi.fn(async () => ({ ok: true, brokerPositionId: "9001", brokerOrderId: "9001" })),
    closeTrade: vi.fn(async () => ({ ok: true })),
    modifyTrade: vi.fn(async () => ({ ok: true })),
    cancelOrder: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

export function post(body: unknown): Request {
  return new Request("http://localhost/api/terminal/trade/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function getRequest(path: string, query: Record<string, string>): Request {
  return new Request(`http://localhost/api/terminal/trade/${path}?${new URLSearchParams(query).toString()}`);
}

export const stateRequest = (query: Record<string, string>) => getRequest("state", query);

// the envelope is checked field by field in the tests, so its payload is deliberately loose
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseData = any;

export async function readJson(
  response: Response,
): Promise<{ ok: boolean; data?: LooseData; error?: { code: string; message: string } }> {
  return (await response.json()) as never;
}

export function openBody(account: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: account,
    symbol: "XAUUSD",
    side: "BUY",
    volume: 0.1,
    stopLoss: 2380,
    takeProfit: 2410,
    clientRequestId: requestId(),
    ...overrides,
  };
}
