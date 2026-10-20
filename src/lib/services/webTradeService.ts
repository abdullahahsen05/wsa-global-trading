if (typeof window !== "undefined") {
  throw new Error("[wsa] webTradeService is server-only.");
}

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { AuthError, type SessionUser } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/rbac";
import { jsonFail } from "@/lib/api/envelope";
import { publicTradeRejection } from "@/lib/broker/api2TradeErrors";
import { BROKER_EXEC_ERROR, BrokerExecutionError, type BrokerAdapter } from "@/lib/broker/BrokerAdapter";
import { createBrokerAdapter } from "@/lib/broker/provider";
import type { AccountStatus, RiskEnforcementStateDto } from "@/lib/domain/types";
import { GatewayNotInstalledError, longPollKnownOff, type CommandRow } from "@/lib/gateway/gatewayDb";
import {
  abandonCommand,
  awaitCommand,
  commandAnswer,
  enqueueCommand,
  gatewayAvailability,
  keepWatching,
  readAccountWatch,
  readStoredSymbols,
  waitForCommand,
  type GatewayAvailability,
  type WatchRow,
} from "@/lib/gateway/gatewayQueue";
import {
  parseTradeCommand,
  TradeCommandError,
  type GatewayTradingState,
  type ParsedTradeCommand,
  type TradeCommandKind,
  type TradeCommandOutcome,
} from "@/lib/gateway/tradeCommands";
import { executeTradeCommand } from "@/lib/gateway/tradeExecutor";
import { writeAuditLog, type AuditAction, type WriteAuditLogParams } from "@/lib/services/auditService";
import { getPlatformSubscriptionAccess, hasActivePlatformProductSubscription } from "@/lib/services/billingService";
import { getRiskEnforcementState } from "@/lib/services/riskService";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTerminalPlatform, sanitizeServer } from "@/lib/terminal/metatrader";
import type {
  WebTradeAccount,
  WebTradeAccountsResponse,
  WebTradeGate,
  WebTradeGateReason,
  WebTradeOrderResult,
  WebTradeRoute,
  WebTradeState,
  WebTradeSymbols,
  WebTradeTiming,
} from "@/lib/trade/webTrade";
import { WebTradeGuard } from "@/lib/trade/webTradeGuard";
import type {
  WebTradeCancelInput,
  WebTradeCloseBulkInput,
  WebTradeCloseInput,
  WebTradeModifyInput,
  WebTradeOpenInput,
} from "@/lib/trade/webTradeSchemas";

// ─────────────────────────────────────────────────────────────────────────────
// WSA Trade: the server side of the terminal's native order panel.
//
// Every call is for the CALLER'S OWN accounts (explicit user_id filter, admins
// included - the admin terminal trades the admin's own accounts, never a client's).
//
// WHERE the broker is reached from (the "route"):
//   gateway  the normal way. Everything MetaTrader lives on the AWS system, so the web
//            tier (Vercel) writes a COMMAND row (migration 060) and the AWS worker runs
//            it through the broker sessions it already holds and writes the answer back;
//            the live picture of an account (figures, positions, pending orders, price)
//            is published by the same worker while somebody is looking at it.
//   direct   this server has the broker bridge AND the execution switch itself
//            (a single-box install): the same executor runs right here.
//   none     neither - the panel is read-only and says why.
// WSA_TRADE_ROUTE=gateway|direct pins the choice; the default (auto) takes the gateway
// while a worker reports in and falls back to direct, then to none.
//
// The gates are always checked HERE, before anything is queued: platform subscription
// (admins exempt), the account's risk rules (new orders only - reducing risk is never
// refused), ownership and connection of the account, and a ceiling of orders per minute.
// Nothing here ever reads, returns or logs credentials.
// ─────────────────────────────────────────────────────────────────────────────

export class WebTradeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "WebTradeError";
  }
}

const REACHABLE_STATUSES: ReadonlySet<string> = new Set(["CONNECTED", "SYNCING", "RESTRICTED"]);
const ACCOUNT_COLUMNS =
  "id, account_name, broker_name, broker_server, broker_platform, currency, status, provider_account_id";
const STATUS_ORDER: Record<string, number> = {
  CONNECTED: 0,
  SYNCING: 1,
  RESTRICTED: 2,
  PENDING: 3,
  INACTIVE: 4,
  DISCONNECTED: 5,
};

/** How long the route waits for the AWS system to carry out an order. Below the 30 s the order routes may run. */
export const ORDER_WAIT_MS = 24_000;
const SYMBOLS_WAIT_MS = 20_000;
const SYMBOLS_COMMAND_TTL_MS = 30_000;
/** A published picture this young is served as it is. */
const STATE_FRESH_MS = 4_000;
/** How long a request waits for the AWS system to publish a first / newer picture. */
const STATE_WAIT_MS = 6_000;
const STATE_LOOK_MS = 150;
/** An older picture than this is not shown at all. */
const STATE_STALE_MAX_MS = 120_000;
const QUOTE_FRESH_MS = 10_000;
const SYMBOLS_FRESH_MS = 6 * 3_600_000;
const SYMBOLS_EMPTY_FRESH_MS = 2 * 60_000;

const GATEWAY_OFFLINE_MESSAGE =
  "The WSA trading system is not responding right now, so orders cannot be sent. Try again in a minute.";
const EXECUTION_OFF_MESSAGE =
  "Order execution is switched off on this platform. You can still follow your positions here.";

interface AccountRow {
  id: string;
  account_name: string | null;
  broker_name: string | null;
  broker_server: string | null;
  broker_platform: string | null;
  currency: string | null;
  status: string | null;
  provider_account_id: string | null;
}

/** One guard per server instance: repeat protection and a ceiling of changes per user and minute. */
const guard = new WebTradeGuard<WebTradeOrderResult>();

function statusOf(value: string | null): AccountStatus {
  switch (value) {
    case "PENDING":
    case "CONNECTED":
    case "SYNCING":
    case "DISCONNECTED":
    case "RESTRICTED":
    case "INACTIVE":
      return value;
    default:
      return "PENDING";
  }
}

function toAccount(row: AccountRow): WebTradeAccount {
  const server = sanitizeServer(row.broker_server);
  return {
    accountId: row.id,
    name: row.account_name?.trim() || "Trading account",
    broker: row.broker_name?.trim() || "WSA GLOBAL",
    platform: resolveTerminalPlatform(row.broker_platform, server),
    server,
    currency: row.currency?.trim() || "USD",
    status: statusOf(row.status),
    reachable: REACHABLE_STATUSES.has(row.status ?? "") && Boolean(row.provider_account_id),
  };
}

/** A database failure: the details go to the log, the user gets a plain message. */
function databaseProblem(what: string, detail: string): WebTradeError {
  console.error(`[web-trade] could not ${what}:`, detail);
  return new WebTradeError("SERVICE_UNAVAILABLE", "Your accounts could not be loaded. Try again in a moment.", 503);
}

function assertMayTrade(user: SessionUser): void {
  // Partners have no trading terminal (same rule as the MetaTrader pane).
  if (user.role === "PARTNER") {
    throw new WebTradeError("FORBIDDEN", "Partners do not have a trading terminal.", 403);
  }
}

function isReachable(row: AccountRow): boolean {
  return REACHABLE_STATUSES.has(row.status ?? "") && Boolean(row.provider_account_id);
}

/**
 * Accounts the caller was just seen to own that are connected: the row and when it was read. An order reads this
 * instead of the database (a round trip less on every order); the panel's own polls keep it young
 * (`warmWebTradeGates`). Only a valid account is ever kept - a missing or disconnected one is asked again every
 * time, and the AWS worker checks the owner of the account once more before it runs anything.
 */
const ACCOUNT_HOLD_MS = 15_000;
const ACCOUNT_HOLD_MAX = 2_000;
const accountHeld = new Map<string, { row: AccountRow; at: number }>();

function holdAccount(userId: string, row: AccountRow, now: number = Date.now()): void {
  if (accountHeld.size >= ACCOUNT_HOLD_MAX) accountHeld.clear();
  accountHeld.set(`${userId}:${row.id}`, { row, at: now });
}

/** The caller's own account, reachable through the broker service - or a precise error. */
async function loadOwnedAccount(
  userId: string,
  accountId: string,
  maxAgeMs: number = ACCOUNT_HOLD_MS,
): Promise<AccountRow> {
  const key = `${userId}:${accountId}`;
  const held = accountHeld.get(key);
  if (held && Date.now() - held.at < maxAgeMs) return held.row;
  accountHeld.delete(key);

  const { data, error } = await createAdminClient()
    .from("trading_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseProblem("load the trading account", error.message);
  if (!data) throw new WebTradeError("ACCOUNT_NOT_FOUND", "Trading account not found.", 404);
  const row = data as AccountRow;
  if (!isReachable(row)) {
    throw new WebTradeError(
      "ACCOUNT_NOT_CONNECTED",
      "This account is not connected to the broker service. Reconnect it under Trading Accounts first.",
      409,
    );
  }
  holdAccount(userId, row);
  return row;
}

type RiskState = RiskEnforcementStateDto | null;

/**
 * The risk verdict of an account, as the last read saw it. Only a verdict that lets new orders through is kept (for
 * a few seconds - the risk worker itself re-evaluates every ~5 s); a block is never kept, so a lifted block is seen
 * at once. Reducing risk (close, modify, cancel) never asks.
 */
const RISK_HOLD_MS = 4_000;
const RISK_HOLD_MAX = 2_000;
const riskHeld = new Map<string, { state: RiskState; at: number }>();

async function riskStateOf(accountId: string, maxAgeMs: number = RISK_HOLD_MS): Promise<RiskState> {
  const held = riskHeld.get(accountId);
  if (held && Date.now() - held.at < maxAgeMs) return held.state;
  riskHeld.delete(accountId);
  const state = await getRiskEnforcementState(accountId);
  if (!state?.blockedNewTrades) {
    if (riskHeld.size >= RISK_HOLD_MAX) riskHeld.clear();
    riskHeld.set(accountId, { state, at: Date.now() });
  }
  return state;
}

function riskMessage(rules: ReadonlyArray<{ name: string }>): string {
  const names = rules.map((rule) => rule.name).filter(Boolean).slice(0, 3);
  return names.length > 0
    ? `Risk rules block new orders on this account (${names.join(", ")}). You can still close positions and change stop loss / take profit.`
    : "Risk rules block new orders on this account. You can still close positions and change stop loss / take profit.";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

type RouteMode = "auto" | "gateway" | "direct";

function routeMode(): RouteMode {
  const value = process.env.WSA_TRADE_ROUTE?.trim().toLowerCase();
  return value === "gateway" || value === "direct" ? value : "auto";
}

/** What the AWS worker said about itself in its latest heartbeat (a field is absent when the worker does not report it). */
interface AwsFacts {
  /** its own round trip to the database, ms */
  dbMs?: number;
  /** how late its event loop ran, ms */
  loopMs?: number;
  /** it waits for commands inside the database (migration 062) instead of asking again and again */
  longPoll: boolean;
}

type OrderRoute =
  | { via: "gateway"; aws: AwsFacts }
  | { via: "direct"; adapter: BrokerAdapter }
  | { via: "none"; reason: WebTradeGateReason; message: string };

/** Is the AWS system there? ("direct" mode never looks.) Any trouble asking counts as "offline". */
async function gatewayState(maxAgeMs?: number): Promise<GatewayAvailability> {
  if (routeMode() === "direct") return { state: "not_installed" };
  try {
    return await gatewayAvailability(createAdminClient(), Date.now(), maxAgeMs);
  } catch {
    return { state: "offline" };
  }
}

function awsFacts(gateway: Extract<GatewayAvailability, { state: "online" }>): AwsFacts {
  return {
    ...(gateway.awsDbMs !== undefined ? { dbMs: gateway.awsDbMs } : {}),
    ...(gateway.awsLoopMs !== undefined ? { loopMs: gateway.awsLoopMs } : {}),
    // a worker that does not report the flag is an older one: it asks again and again
    longPoll: gateway.awsLongPoll === true,
  };
}

/** How orders reach the broker right now. */
async function orderRoute(): Promise<OrderRoute> {
  const gateway = await gatewayState();
  if (gateway.state === "online") {
    return gateway.executionEnabled
      ? { via: "gateway", aws: awsFacts(gateway) }
      : {
          via: "none",
          reason: "EXECUTION_DISABLED",
          message: "Order execution is switched off on the trading system. You can still follow your positions here.",
        };
  }
  if (routeMode() !== "gateway") {
    const adapter = createBrokerAdapter();
    if (adapter.executionAvailable()) return { via: "direct", adapter };
  }
  if (gateway.state === "offline") return { via: "none", reason: "GATEWAY_OFFLINE", message: GATEWAY_OFFLINE_MESSAGE };
  return { via: "none", reason: "EXECUTION_DISABLED", message: EXECUTION_OFF_MESSAGE };
}

function routeName(route: OrderRoute): WebTradeRoute {
  return route.via;
}

type ReadAdapter = BrokerAdapter & Required<Pick<BrokerAdapter, "fetchTradingState">>;
type ReadRoute = { via: "gateway" } | { via: "direct"; adapter: ReadAdapter; gateway: GatewayAvailability };

/** Where positions are read from: the AWS system while it reports in, else this server's own bridge. */
async function readRoute(): Promise<ReadRoute> {
  const gateway = await gatewayState();
  if (gateway.state === "online") return { via: "gateway" };
  if (routeMode() === "gateway") throw new WebTradeError("GATEWAY_OFFLINE", GATEWAY_OFFLINE_MESSAGE, 503);
  const adapter = createBrokerAdapter();
  if (!adapter.fetchTradingState) {
    throw new WebTradeError("NOT_SUPPORTED", "The broker connection cannot read positions.", 501);
  }
  return { via: "direct", adapter: adapter as ReadAdapter, gateway };
}

/** A direct read that failed because this server has no bridge: say what is really wrong. */
function directReadFailure(error: unknown, gateway: GatewayAvailability): unknown {
  if (error instanceof BrokerExecutionError && error.code === BROKER_EXEC_ERROR.PROVIDER_NOT_CONFIGURED) {
    return gateway.state === "offline"
      ? new WebTradeError("GATEWAY_OFFLINE", GATEWAY_OFFLINE_MESSAGE, 503)
      : new WebTradeError(
          "SERVICE_UNAVAILABLE",
          "Live account data is not available here: the trading system is not connected to this server.",
          503,
        );
  }
  return error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Users this server instance has just seen hold an ACTIVE platform subscription, and until when that is
 * taken as still true. A subscription is a monthly thing: not asking the database again for half a minute
 * costs nothing, and saves a round trip on every order of a series (and on every poll of the accounts).
 * Only a "yes" is kept - a user who has just paid is never held back by an old "no".
 */
const SUBSCRIPTION_OK_MS = 30_000;
const SUBSCRIPTION_OK_MAX = 2_000;
/** user id -> when an ACTIVE subscription was last seen */
const subscriptionSeenAt = new Map<string, number>();

/** Test helper: forget what this instance has cached. */
export function resetWebTradeCaches(): void {
  subscriptionSeenAt.clear();
  accountHeld.clear();
  riskHeld.clear();
}

/** The platform subscription check (admins exempt). Null = allowed. */
async function subscriptionProblem(
  user: SessionUser,
  maxAgeMs: number = SUBSCRIPTION_OK_MS,
): Promise<WebTradeError | null> {
  if (isAdmin(user.role)) return null;
  const now = Date.now();
  const seen = subscriptionSeenAt.get(user.id);
  if (seen !== undefined && now - seen < maxAgeMs) return null;
  // One cheap query settles the usual case (an active subscriber). Anything else gets the full billing
  // picture, which also repairs records of the old manual-approval policy - so the answer is never stricter than before.
  let active = await hasActivePlatformProductSubscription(user.id).catch(() => false);
  if (!active) active = (await getPlatformSubscriptionAccess(user.id)).status === "ACTIVE";
  if (!active) {
    subscriptionSeenAt.delete(user.id);
    return new WebTradeError(
      "SUBSCRIPTION_REQUIRED",
      "Activate your platform subscription to place and manage orders from WSA Trade.",
      403,
    );
  }
  if (subscriptionSeenAt.size >= SUBSCRIPTION_OK_MAX) subscriptionSeenAt.clear();
  subscriptionSeenAt.set(user.id, now);
  return null;
}

// What the background upkeep renews, and when: a kept copy that is older than this is read again (about half of
// how long an order would still trust it), so an order always finds young copies while the panel is polling.
const WARM_AVAILABILITY_MS = 3_000;
const WARM_SUBSCRIPTION_MS = 15_000;
const WARM_ACCOUNT_MS = 7_000;
const WARM_RISK_MS = 2_000;

/**
 * Keeps what the next order checks young, so the order itself finds everything already in memory and spends its
 * time on the one thing only it can do - writing the command. The parts are the AWS system's heartbeat, the account,
 * its risk verdict and the platform subscription. Each is read only when its kept copy is half old.
 *
 * It runs AFTER a poll's answer has left (`establish` false: the subscription is only renewed for somebody whose
 * subscription was seen to be active, an unpaid user does not cost a check on every poll) and as the warm-up the
 * panel sends when somebody reaches for the buttons (`establish` true: also the first check). Nothing here throws
 * and nothing here can refuse anything - the order path still decides on its own.
 */
export async function warmWebTradeGates(user: SessionUser, accountId: string, establish: boolean): Promise<void> {
  if (user.role === "PARTNER") return;
  const subscription =
    establish || subscriptionSeenAt.has(user.id) ? subscriptionProblem(user, WARM_SUBSCRIPTION_MS) : Promise.resolve(null);
  await Promise.allSettled([
    gatewayState(WARM_AVAILABILITY_MS),
    subscription,
    loadOwnedAccount(user.id, accountId, WARM_ACCOUNT_MS).then((account) => riskStateOf(account.id, WARM_RISK_MS)),
  ]);
}

/** The upkeep as a task for after the answer has left; where there is no request to hang it on it is simply not done. */
function warmAfterResponse(user: SessionUser, accountId: string): void {
  try {
    after(() => warmWebTradeGates(user, accountId, false));
  } catch {
    // a script or a unit test: the upkeep is a courtesy, the next order reads what it needs by itself
  }
}

/** Platform-wide part of the gate: where orders can go, and the platform subscription. */
async function platformGate(user: SessionUser, route: OrderRoute): Promise<WebTradeGate> {
  if (route.via === "none") {
    return { canOpen: false, canManage: false, reason: route.reason, message: route.message };
  }
  const problem = await subscriptionProblem(user);
  if (problem) {
    return { canOpen: false, canManage: false, reason: "SUBSCRIPTION_REQUIRED", message: problem.message };
  }
  return { canOpen: true, canManage: true, reason: null, message: null };
}

function takeSlot(user: SessionUser): void {
  if (!guard.allow(user.id)) {
    throw new WebTradeError("RATE_LIMITED", "Too many orders in a short time. Wait a moment and try again.", 429);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** The caller's own accounts and the platform-wide part of the gate. */
export async function listWebTradeAccounts(user: SessionUser): Promise<WebTradeAccountsResponse> {
  assertMayTrade(user);
  const { data, error } = await createAdminClient()
    .from("trading_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw databaseProblem("list the trading accounts", error.message);

  // The list is what the panel opens with: the connected accounts are kept in memory too, so the first order on any
  // of them does not have to read its account again.
  const listedAt = Date.now();
  for (const row of (data ?? []) as AccountRow[]) {
    if (isReachable(row)) holdAccount(user.id, row, listedAt);
  }

  const accounts = ((data ?? []) as AccountRow[])
    .map((row, index) => ({ account: toAccount(row), index }))
    .sort(
      (left, right) =>
        (STATUS_ORDER[left.account.status] ?? 9) - (STATUS_ORDER[right.account.status] ?? 9) ||
        left.index - right.index,
    )
    .map((entry) => entry.account);

  const route = await orderRoute();
  return { accounts, gate: await platformGate(user, route), route: routeName(route) };
}

function ageOf(iso: string | null | undefined, now: number): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? Math.max(0, now - time) : Number.POSITIVE_INFINITY;
}

/**
 * The picture of an account that the AWS system publishes while somebody looks at it.
 * Says "somebody is looking", then serves the freshest picture; when there is none yet
 * (the first poll) it waits a moment for the first one. An error the worker met while
 * reading the account is passed on in words.
 */
async function readGatewayPicture(
  userId: string,
  accountId: string,
  symbol: string | undefined,
  earlier: WatchRow | null,
): Promise<{ state: GatewayTradingState; delayed: boolean }> {
  const db = createAdminClient();
  const startedAt = Date.now();
  let row = earlier;
  try {
    await keepWatching(db, { accountId, userId, symbol: symbol ?? null, current: row }, startedAt);
    const deadline = startedAt + STATE_WAIT_MS;
    for (;;) {
      const now = Date.now();
      if (row?.state && ageOf(row.stateAt, now) <= STATE_FRESH_MS) return { state: row.state, delayed: false };
      if (row?.error && ageOf(row.errorAt, now) <= STATE_FRESH_MS) {
        throw new WebTradeError("BROKER_ERROR", row.error, 502);
      }
      if (now >= deadline) break;
      await pause(Math.min(STATE_LOOK_MS, deadline - now));
      row = await readAccountWatch(db, accountId, userId);
    }
  } catch (error) {
    if (error instanceof GatewayNotInstalledError) {
      throw new WebTradeError("GATEWAY_OFFLINE", GATEWAY_OFFLINE_MESSAGE, 503);
    }
    throw error;
  }
  if (row?.state && ageOf(row.stateAt, Date.now()) <= STATE_STALE_MAX_MS) return { state: row.state, delayed: true };
  if (row?.error) throw new WebTradeError("BROKER_ERROR", row.error, 502);
  throw new WebTradeError("GATEWAY_TIMEOUT", "The trading system did not answer in time. Try again in a moment.", 504);
}

/** Figures, positions, pending orders and (when a symbol is given) the price of one of the caller's accounts. */
export async function getWebTradeState(
  user: SessionUser,
  query: { accountId: string; symbol?: string },
): Promise<WebTradeState> {
  assertMayTrade(user);
  const route = await readRoute();
  const db = route.via === "gateway" ? createAdminClient() : null;
  // The account is checked first; the risk state is only read for an account that is the caller's.
  const accountPromise = loadOwnedAccount(user.id, query.accountId);
  const riskPromise = accountPromise.then(
    (owned) => riskStateOf(owned.id).catch(() => null),
    () => null,
  );
  // (the picture is filtered by the caller's id too, so reading it next to the account check is safe)
  const watchPromise = db ? readAccountWatch(db, query.accountId, user.id).catch(() => null) : Promise.resolve(null);
  const account = await accountPromise;
  const [earlier, risk] = await Promise.all([watchPromise, riskPromise]);

  let state: GatewayTradingState;
  let delayed = false;
  let quote: WebTradeState["quote"] = null;

  if (route.via === "gateway") {
    const picture = await readGatewayPicture(user.id, account.id, query.symbol, earlier);
    state = picture.state;
    delayed = picture.delayed;
    const entry = query.symbol ? state.quotes?.[query.symbol] : undefined;
    if (query.symbol && entry && ageOf(entry.at, Date.now()) <= QUOTE_FRESH_MS) {
      quote = { symbol: query.symbol, bid: entry.bid, ask: entry.ask };
    }
  } else {
    try {
      state = { ...(await route.adapter.fetchTradingState(account.id)), quotes: {} };
      // Sequential on purpose: the state call has just made sure the broker session is ready.
      quote =
        query.symbol && route.adapter.fetchQuote
          ? await route.adapter.fetchQuote(account.id, query.symbol).catch(() => null)
          : null;
    } catch (error) {
      throw directReadFailure(error, route.gateway);
    }
  }

  const riskBlocked = Boolean(risk?.blockedNewTrades);
  // A poll is also the moment to renew what the next order will check (after this answer has left).
  warmAfterResponse(user, account.id);
  return {
    accountId: account.id,
    currency: state.currency,
    balance: state.balance,
    equity: state.equity,
    floatingProfit: state.floatingProfit,
    margin: state.margin,
    freeMargin: state.freeMargin,
    marginLevel: state.marginLevel,
    positions: state.positions,
    pending: state.pending ?? [],
    pendingOrders: state.pendingOrders ?? state.pending?.length ?? 0,
    quote,
    readOnly: state.readOnly === true,
    riskBlocked,
    riskMessage: riskBlocked ? riskMessage(risk?.breachedRules ?? []) : null,
    fetchedAt: state.fetchedAt,
    route: route.via,
    delayed,
  };
}

/** Every symbol the account can trade, with the broker's own spelling (the panel's symbol picker). */
export async function getWebTradeSymbols(user: SessionUser, query: { accountId: string }): Promise<WebTradeSymbols> {
  assertMayTrade(user);
  const account = await loadOwnedAccount(user.id, query.accountId);
  const route = await readRoute();

  if (route.via === "direct") {
    try {
      const symbols = route.adapter.fetchSymbolList ? await route.adapter.fetchSymbolList(account.id) : [];
      return { symbols, updatedAt: null, route: "direct" };
    } catch (error) {
      throw directReadFailure(error, route.gateway);
    }
  }

  const db = createAdminClient();
  const stored = await readStoredSymbols(db, account.id).catch(() => null);
  if (stored) {
    const limit = stored.symbols.length > 0 ? SYMBOLS_FRESH_MS : SYMBOLS_EMPTY_FRESH_MS;
    if (ageOf(stored.updatedAt, Date.now()) <= limit) {
      return { symbols: stored.symbols, updatedAt: stored.updatedAt, route: "gateway" };
    }
  }
  try {
    const { outcome } = await sendThroughGateway(
      user.id,
      account.id,
      parseCommand("SYMBOLS", {}),
      undefined,
      { waitMs: SYMBOLS_WAIT_MS, ttlMs: SYMBOLS_COMMAND_TTL_MS },
    );
    return { symbols: outcome.symbols ?? [], updatedAt: new Date().toISOString(), route: "gateway" };
  } catch (error) {
    // an older list is better than none
    if (stored && stored.symbols.length > 0) {
      return { symbols: stored.symbols, updatedAt: stored.updatedAt, route: "gateway" };
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────────────────────

function parseCommand(kind: TradeCommandKind, payload: unknown): ParsedTradeCommand {
  try {
    return parseTradeCommand(kind, payload);
  } catch (error) {
    if (error instanceof TradeCommandError) throw new WebTradeError("VALIDATION_ERROR", error.message, 400);
    throw error;
  }
}

function isFinishedStatus(status: CommandRow["status"]): boolean {
  return status === "DONE" || status === "FAILED" || status === "EXPIRED";
}

interface GatewayReply {
  outcome: TradeCommandOutcome;
  repeated: boolean;
  /** from just before the command was written to its answer being seen */
  waitedMs: number;
  /** writing the command: one round trip between this server and the database */
  insertMs: number;
  /** the answer was waited for inside the database (migration 062) or by asking again and again */
  wake: "live" | "poll";
}

/**
 * Hands a command to the AWS system and waits for its answer. The same (user, request id)
 * is one command: a repeated request gets the command that already exists.
 *
 * The wait for the answer starts TOGETHER with the write. It finds the command by (user, request id) - not by the
 * id the write will return - so it does not have to wait for the write to come back, and the database answers it
 * the moment the worker stores the result (migration 062): no second round trip before the wait, no polling gaps
 * after it. Without 062 (or when the database refuses the long wait) the old polling takes over, with the time
 * that is left.
 */
async function sendThroughGateway(
  userId: string,
  accountId: string,
  command: ParsedTradeCommand,
  requestId: string | undefined,
  options: { waitMs: number; ttlMs?: number },
): Promise<GatewayReply> {
  const db = createAdminClient();
  const sentAt = Date.now();
  const clientRequestId = requestId ?? randomUUID();

  const stopWaiting = new AbortController();
  const live = longPollKnownOff(sentAt)
    ? null
    : settled(awaitCommand(db, { userId, clientRequestId, timeoutMs: options.waitMs, signal: stopWaiting.signal }));

  try {
    let queued: Awaited<ReturnType<typeof enqueueCommand>>;
    try {
      queued = await enqueueCommand(db, {
        userId,
        accountId,
        kind: command.kind,
        payload: command.payload,
        clientRequestId,
        ttlMs: options.ttlMs,
      });
    } catch (error) {
      if (error instanceof GatewayNotInstalledError) {
        throw new WebTradeError("GATEWAY_OFFLINE", GATEWAY_OFFLINE_MESSAGE, 503);
      }
      console.error("[web-trade] could not queue a command:", error instanceof Error ? error.message : "unknown error");
      // nothing was sent: this is not an uncertain order
      throw new WebTradeError("SERVICE_UNAVAILABLE", "The order could not be queued. Try again in a moment.", 503);
    }
    const insertMs = Math.max(0, Date.now() - sentAt);

    let row: CommandRow | null = queued.row;
    let wake: "live" | "poll" = live ? "live" : "poll";
    if (!isFinishedStatus(row.status)) {
      row = null;
      if (live) {
        const verdict = await live;
        if (verdict.ok) row = verdict.value;
        else wake = "poll";
      }
      if (!row && wake === "poll") {
        const left = Math.max(0, options.waitMs - (Date.now() - sentAt));
        row = await waitForCommand(db, queued.row.id, left).catch(() => null);
      }
    }
    if (!row) {
      const fate = await abandonCommand(db, queued.row.id).catch((): "RUNNING" => "RUNNING");
      if (fate === "CANCELLED") {
        throw new WebTradeError(
          "GATEWAY_TIMEOUT",
          "The trading system did not pick the order up in time, so it was NOT sent to the broker. Try again.",
          504,
        );
      }
      // taken by a worker, or finished just now
      row = fate === "FINISHED" ? await waitForCommand(db, queued.row.id, 1_500).catch(() => null) : null;
      if (!row) {
        throw new WebTradeError(
          "ORDER_UNCERTAIN",
          "The order was sent, but its answer has not arrived yet. Check the open positions before sending it again.",
          504,
        );
      }
    }
    const answer = commandAnswer(row);
    if (!answer.ok) throw new WebTradeError(answer.error.code, answer.error.message, answer.error.statusCode);
    return { outcome: answer.outcome, repeated: queued.existing, waitedMs: Date.now() - sentAt, insertMs, wake };
  } finally {
    // (a wait that is still running - the write failed, or the answer was there already - stops at its next look)
    stopWaiting.abort();
  }
}

/** What the broker confirmed, as the panel can use it to show the result before the next picture arrives. */
function orderDetail(outcome: TradeCommandOutcome): WebTradeOrderResult["detail"] | undefined {
  const detail = outcome.detail;
  if (!detail) return undefined;
  const shown: NonNullable<WebTradeOrderResult["detail"]> = {};
  if (detail.symbol !== undefined) shown.symbol = detail.symbol;
  if (detail.volume !== undefined) shown.volume = detail.volume;
  if (detail.fillPrice !== undefined) shown.fillPrice = detail.fillPrice;
  if (detail.stopLoss !== undefined) shown.stopLoss = detail.stopLoss;
  if (detail.takeProfit !== undefined) shown.takeProfit = detail.takeProfit;
  if (detail.price !== undefined) shown.price = detail.price;
  return Object.keys(shown).length > 0 ? shown : undefined;
}

function toOrderResult(outcome: TradeCommandOutcome): WebTradeOrderResult {
  const result: WebTradeOrderResult = { ok: true, ticket: outcome.ticket ?? null };
  if (outcome.note) result.note = outcome.note;
  if (outcome.closed !== undefined) {
    result.closed = outcome.closed;
    result.failed = outcome.failed ?? 0;
    if (outcome.failures && outcome.failures.length > 0) result.failures = outcome.failures;
  }
  const detail = orderDetail(outcome);
  if (detail) result.detail = detail;
  if (outcome.timing) result.timing = { ...outcome.timing };
  return result;
}

/** The parts of the web server's own time (and what it knows about the AWS side) that go into the time report. */
interface TimingStages {
  signInMs?: number;
  checksMs?: number;
  insertMs?: number;
  awsDbMs?: number;
  awsLoopMs?: number;
  wake?: WebTradeTiming["wake"];
}

/** Adds the web server's own part to the time report of an order (when the order has one). */
function stampTiming(
  result: WebTradeOrderResult,
  startedAt: number,
  waitedMs: number | null,
  stages: TimingStages = {},
): WebTradeOrderResult {
  if (!result.timing) return result;
  const timing: WebTradeTiming = { ...result.timing, serverMs: Math.max(0, Date.now() - startedAt) };
  if (waitedMs !== null) timing.waitMs = waitedMs;
  if (stages.signInMs !== undefined) timing.signInMs = stages.signInMs;
  if (stages.checksMs !== undefined) timing.checksMs = stages.checksMs;
  if (stages.insertMs !== undefined) timing.insertMs = stages.insertMs;
  if (stages.awsDbMs !== undefined) timing.awsDbMs = stages.awsDbMs;
  if (stages.awsLoopMs !== undefined) timing.awsLoopMs = stages.awsLoopMs;
  if (stages.wake !== undefined) timing.wake = stages.wake;
  return { ...result, timing };
}

/**
 * The audit entry is written AFTER the answer has left (Next's `after`): the person waits for the
 * order, not for the log. Where there is no request to hang it on (a script, a unit test) it is
 * simply written in the background. Writing never fails an order - `writeAuditLog` swallows errors.
 */
function auditAfterResponse(entry: WriteAuditLogParams): void {
  try {
    after(() => writeAuditLog(entry));
  } catch {
    void writeAuditLog(entry);
  }
}

interface OrderRequest {
  kind: TradeCommandKind;
  accountId: string;
  payload: Record<string, unknown>;
  clientRequestId?: string;
  /** new orders are refused while the account's risk rules block them; reducing risk never is */
  checkRisk: boolean;
  /** how long the AWS system may take */
  waitMs?: number;
  audit: (info: { outcome: TradeCommandOutcome; route: WebTradeRoute; accountId: string }) => {
    action: AuditAction;
    metadata: Record<string, unknown>;
  };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A promise that never rejects: its outcome as a value, so several can be awaited together and judged in a chosen order. */
function settled<T>(task: Promise<T>): Promise<Settled<T>> {
  return task.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  );
}

/** Optional details about the request the caller can pass along (the route notes when the request arrived). */
export interface WebTradeRequestMeta {
  /** `Date.now()` when the request reached the route; the time report is measured from here. */
  startedAt?: number;
  /** `Date.now()` when the sign-in check was done; the time report shows what it cost. */
  signedInAt?: number;
}

/** The whole life of one order or change: gates, route, execution, repeat protection, audit. */
async function runOrder(
  user: SessionUser,
  request: OrderRequest,
  meta: WebTradeRequestMeta = {},
): Promise<WebTradeOrderResult> {
  const startedAt = meta.startedAt ?? Date.now();
  assertMayTrade(user);
  const requestId = request.clientRequestId;
  if (requestId) {
    const earlier = guard.recall(user.id, requestId);
    if (earlier) return { ...earlier, repeated: true };
    if (!guard.begin(user.id, requestId)) {
      throw new WebTradeError("ORDER_IN_PROGRESS", "This order is already being sent.", 409);
    }
  }
  try {
    takeSlot(user);
    // The checks do not depend on each other, so they are asked together - one round trip to the database
    // instead of three in a row. The verdicts are read in the order the checks always had.
    const [routeVerdict, subscriptionVerdict, accountVerdict, riskVerdict] = await Promise.all([
      settled(orderRoute()),
      settled(subscriptionProblem(user)),
      settled(loadOwnedAccount(user.id, request.accountId)),
      request.checkRisk ? settled(riskStateOf(request.accountId)) : Promise.resolve(null),
    ]);
    if (!routeVerdict.ok) throw routeVerdict.error;
    const route = routeVerdict.value;
    if (route.via === "none") {
      throw new WebTradeError(route.reason, route.message, 503);
    }
    if (!subscriptionVerdict.ok) throw subscriptionVerdict.error;
    if (subscriptionVerdict.value) throw subscriptionVerdict.value;
    if (!accountVerdict.ok) throw accountVerdict.error;
    const account = accountVerdict.value;
    if (riskVerdict) {
      // (read next to the account check; it only counts once the account is known to be the caller's)
      if (!riskVerdict.ok) throw riskVerdict.error;
      if (riskVerdict.value?.blockedNewTrades) {
        throw new WebTradeError("RISK_BLOCKED", riskMessage(riskVerdict.value.breachedRules), 423);
      }
    }

    const command = parseCommand(request.kind, request.payload);
    // Where the web server's own time went before the command was written (the time report shows it).
    const stages: TimingStages = {};
    if (meta.signedInAt !== undefined) stages.signInMs = Math.max(0, meta.signedInAt - startedAt);
    stages.checksMs = Math.max(0, Date.now() - (meta.signedInAt ?? startedAt));
    let outcome: TradeCommandOutcome;
    let repeated = false;
    let waitedMs: number | null = null;
    if (route.via === "gateway") {
      const sent = await sendThroughGateway(user.id, account.id, command, requestId, {
        waitMs: request.waitMs ?? ORDER_WAIT_MS,
      });
      outcome = sent.outcome;
      repeated = sent.repeated;
      waitedMs = sent.waitedMs;
      stages.insertMs = sent.insertMs;
      if (route.aws.dbMs !== undefined) stages.awsDbMs = route.aws.dbMs;
      if (route.aws.loopMs !== undefined) stages.awsLoopMs = route.aws.loopMs;
      stages.wake = sent.wake === "poll" ? "web-poll" : route.aws.longPoll ? "live" : "aws-poll";
    } else {
      outcome = await executeTradeCommand(route.adapter, account.id, command);
    }

    if (command.kind === "CLOSE_BULK" && (outcome.closed ?? 0) === 0 && (outcome.failed ?? 0) > 0) {
      const first = outcome.failures?.[0]?.message;
      throw new WebTradeError(
        "BULK_FAILED",
        first ? `Nothing could be closed: ${first}` : "Nothing could be closed.",
        502,
      );
    }

    const result = toOrderResult(outcome);
    if (requestId) guard.remember(user.id, requestId, result);
    const entry = request.audit({ outcome, route: routeName(route), accountId: account.id });
    auditAfterResponse({
      actorUserId: user.id,
      action: entry.action,
      entityType: "trading_account",
      entityId: account.id,
      metadata: entry.metadata,
    });
    const stamped = stampTiming(result, startedAt, waitedMs, stages);
    return repeated ? { ...stamped, repeated: true } : stamped;
  } finally {
    if (requestId) guard.end(user.id, requestId);
  }
}

/** A new order: at the market, or a limit / stop order that waits for its price. */
export async function placeWebTradeOrder(
  user: SessionUser,
  input: WebTradeOpenInput,
  meta?: WebTradeRequestMeta,
): Promise<WebTradeOrderResult> {
  const orderKind = input.orderKind ?? "MARKET";
  return runOrder(
    user,
    {
      kind: "OPEN",
      accountId: input.accountId,
      clientRequestId: input.clientRequestId,
      checkRisk: true,
      payload: {
        symbol: input.symbol,
        side: input.side,
        volume: input.volume,
        orderKind,
        price: orderKind === "MARKET" ? null : (input.price ?? null),
        stopLoss: input.stopLoss ?? null,
        takeProfit: input.takeProfit ?? null,
      },
      audit: ({ outcome, route }) => ({
        action: "WEB_TRADE_ORDER_OPENED",
        metadata: {
          symbol: input.symbol,
          side: input.side,
          volume: input.volume,
          orderKind,
          price: orderKind === "MARKET" ? null : (input.price ?? null),
          stopLoss: input.stopLoss ?? null,
          takeProfit: input.takeProfit ?? null,
          ticket: outcome.ticket ?? null,
          route,
        },
      }),
    },
    meta,
  );
}

/** New stop loss / take profit of an open position, or entry price / levels of a pending order (a level can be removed). */
export async function modifyWebTradePosition(
  user: SessionUser,
  input: WebTradeModifyInput,
  meta?: WebTradeRequestMeta,
): Promise<WebTradeOrderResult> {
  const payload: Record<string, unknown> = { ticket: input.ticket };
  if (input.stopLoss !== undefined) payload.stopLoss = input.stopLoss;
  if (input.takeProfit !== undefined) payload.takeProfit = input.takeProfit;
  if (input.price !== undefined) payload.price = input.price;
  return runOrder(
    user,
    {
      kind: "MODIFY",
      accountId: input.accountId,
      clientRequestId: input.clientRequestId,
      checkRisk: false,
      payload,
      audit: ({ outcome, route }) => ({
        action: "WEB_TRADE_POSITION_MODIFIED",
        metadata: {
          ticket: outcome.ticket ?? input.ticket,
          symbol: outcome.detail?.symbol ?? null,
          stopLoss: outcome.detail?.stopLoss ?? null,
          takeProfit: outcome.detail?.takeProfit ?? null,
          price: outcome.detail?.price ?? null,
          route,
        },
      }),
    },
    meta,
  );
}

/** Closes a position, or only `volume` lots of it. */
export async function closeWebTradePosition(
  user: SessionUser,
  input: WebTradeCloseInput,
  meta?: WebTradeRequestMeta,
): Promise<WebTradeOrderResult> {
  return runOrder(
    user,
    {
      kind: "CLOSE",
      accountId: input.accountId,
      clientRequestId: input.clientRequestId,
      checkRisk: false,
      payload: { ticket: input.ticket, volume: input.volume ?? null },
      audit: ({ outcome, route }) => ({
        action: "WEB_TRADE_POSITION_CLOSED",
        metadata: {
          ticket: input.ticket,
          requestedVolume: input.volume ?? null,
          closedVolume: outcome.detail?.volume ?? input.volume ?? null,
          partial: input.volume !== undefined,
          route,
        },
      }),
    },
    meta,
  );
}

/** Deletes a pending order. */
export async function cancelWebTradeOrder(
  user: SessionUser,
  input: WebTradeCancelInput,
  meta?: WebTradeRequestMeta,
): Promise<WebTradeOrderResult> {
  return runOrder(
    user,
    {
      kind: "CANCEL",
      accountId: input.accountId,
      clientRequestId: input.clientRequestId,
      checkRisk: false,
      payload: { ticket: input.ticket },
      audit: ({ outcome, route }) => ({
        action: "WEB_TRADE_ORDER_CANCELLED",
        metadata: { ticket: input.ticket, symbol: outcome.detail?.symbol ?? null, route },
      }),
    },
    meta,
  );
}

/** Closes several positions (all, the winners, the losers, one side, one symbol) or deletes the pending orders. */
export async function closeWebTradeBulk(
  user: SessionUser,
  input: WebTradeCloseBulkInput,
  meta?: WebTradeRequestMeta,
): Promise<WebTradeOrderResult> {
  return runOrder(
    user,
    {
      kind: "CLOSE_BULK",
      accountId: input.accountId,
      clientRequestId: input.clientRequestId,
      checkRisk: false,
      waitMs: ORDER_WAIT_MS,
      payload: { scope: input.scope, symbol: input.symbol ?? null },
      audit: ({ outcome, route }) => ({
        action: "WEB_TRADE_BULK_CLOSED",
        metadata: {
          scope: input.scope,
          symbol: input.symbol ?? null,
          closed: outcome.closed ?? 0,
          failed: outcome.failed ?? 0,
          route,
        },
      }),
    },
    meta,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

/** One mapping of errors to the API envelope for all WSA Trade routes. Messages are safe to show. */
export function webTradeErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
  if (error instanceof WebTradeError) return jsonFail(error.code, error.message, error.statusCode);
  if (error instanceof TradeCommandError) return jsonFail(error.code, error.message, error.statusCode);
  if (error instanceof BrokerExecutionError) return jsonFail(error.code, error.message, error.statusCode);
  // What is left comes from the broker path (session, bridge, network). The text is sanitised
  // (no credentials, no provider names); the log gets the message only.
  console.error("[web-trade] request failed:", error instanceof Error ? error.message : "unknown error");
  return jsonFail("BROKER_ERROR", publicTradeRejection(error), 502);
}
