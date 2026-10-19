/**
 * WSA Trade - the order panel of the terminal workspace.
 *
 * Why it exists: a broker's own web terminal can only be embedded when the broker
 * publishes one, and API2Trade has no "open this account in a web terminal" feature.
 * What API2Trade does have is a trading API on the very session WSA already keeps for
 * every connected account. WSA Trade is a native panel on top of it: account figures,
 * open positions, market orders, SL / TP changes and (partial) closes for ANY
 * MT4 / MT5 account, with no broker link, no second login and - unlike an order typed
 * into an embedded broker terminal - through WSA's own gates (platform subscription,
 * risk rules, audit log).
 *
 * This file is pure (types + helpers, no zod); it is shared by the routes and the
 * panel. The request schemas are in `webTradeSchemas.ts`.
 */

import type { AccountStatus } from "@/lib/domain/types";
import type { BrokerOpenPosition, BrokerPendingOrder } from "@/lib/broker/openPositions";

export type { BrokerOpenPosition as WebTradePosition, BrokerPendingOrder as WebTradePendingOrder } from "@/lib/broker/openPositions";

export const WEB_TRADE_SIDES = ["BUY", "SELL"] as const;
export type WebTradeSide = (typeof WEB_TRADE_SIDES)[number];

/** MARKET executes now; LIMIT / STOP wait for a price (a pending order). */
export const WEB_TRADE_ORDER_KINDS = ["MARKET", "LIMIT", "STOP"] as const;
export type WebTradeOrderKind = (typeof WEB_TRADE_ORDER_KINDS)[number];

/** What "close several at once" takes: every position, the winners, the losers, one side, one symbol, or the pending orders. */
export const WEB_TRADE_BULK_SCOPES = ["ALL", "PROFIT", "LOSS", "BUY", "SELL", "SYMBOL", "PENDING"] as const;
export type WebTradeBulkScope = (typeof WEB_TRADE_BULK_SCOPES)[number];

/** The broker's own limits still apply on top of these. */
export const WEB_TRADE_MIN_LOTS = 0.001;
export const WEB_TRADE_MAX_LOTS = 100;
/** How often the open panel refreshes positions and price (the AWS system renews its picture about once a second). */
export const WEB_TRADE_POLL_MS = 1000;
/** Right after an order the panel asks this often, for `WEB_TRADE_BURST_MS`, so the result shows up as soon as the AWS system has read it. */
export const WEB_TRADE_BURST_POLL_MS = 400;
export const WEB_TRADE_BURST_MS = 3500;
/** Order comment seen in the broker's history. It must NOT start with `wsa:` (the copy engine's own marker). */
export const WEB_TRADE_COMMENT = "WSA Trade";

export const TRADE_SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._#@!$&+-]{0,31}$/;
export const TICKET_PATTERN = /^[0-9]{1,20}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_TRADE_LEVEL = 1_000_000_000;

/** A MetaTrader symbol name as the broker spells it: `EURUSD`, `EURUSD.m`, `XAUUSD#`, `US30.cash`. Case is kept. */
export function normalizeTradeSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return TRADE_SYMBOL_PATTERN.test(text) ? text : null;
}

/** Lots with at most three decimals (a thousandth of a lot is the finest step any broker offers). */
export function roundLots(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function isValidLots(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= WEB_TRADE_MIN_LOTS &&
    value <= WEB_TRADE_MAX_LOTS &&
    Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6
  );
}

/**
 * A stop loss / take profit pair that cannot be right whatever the price is: a long
 * position needs the stop below the target, a short one above it. (Which side of the
 * CURRENT price a level may sit on is the broker's call - it knows its stop level.)
 */
export function levelsProblem(
  side: WebTradeSide,
  stopLoss: number | null | undefined,
  takeProfit: number | null | undefined,
): string | null {
  if (!stopLoss || !takeProfit) return null;
  if (side === "BUY" && stopLoss >= takeProfit) return "For a buy the stop loss must be below the take profit.";
  if (side === "SELL" && stopLoss <= takeProfit) return "For a sell the stop loss must be above the take profit.";
  return null;
}

/**
 * A stop loss / take profit pair that cannot be right for an order waiting at `price`:
 * a buy needs the stop below the entry and the target above it, a sell the other way round.
 */
export function pendingLevelsProblem(
  side: WebTradeSide,
  price: number,
  stopLoss: number | null | undefined,
  takeProfit: number | null | undefined,
): string | null {
  if (side === "BUY") {
    if (stopLoss && stopLoss >= price) return "For a buy the stop loss must be below the entry price.";
    if (takeProfit && takeProfit <= price) return "For a buy the take profit must be above the entry price.";
  } else {
    if (stopLoss && stopLoss <= price) return "For a sell the stop loss must be above the entry price.";
    if (takeProfit && takeProfit >= price) return "For a sell the take profit must be below the entry price.";
  }
  return null;
}

/**
 * Which kind of pending order a price makes: a buy BELOW the market is a limit, a buy ABOVE
 * it a stop; a sell above is a limit, below a stop. Null when there is no price to compare.
 */
export function pendingKindForPrice(
  side: WebTradeSide,
  entry: number,
  market: { bid: number; ask: number } | null,
): "LIMIT" | "STOP" | null {
  if (!market || !(entry > 0)) return null;
  if (side === "BUY") return entry < market.ask ? "LIMIT" : "STOP";
  return entry > market.bid ? "LIMIT" : "STOP";
}

/**
 * The stop loss / take profit the broker must be sent for a modification. MetaTrader
 * wants both values every time and reads 0 as "none", so a level the request does not
 * mention keeps the position's current one, and a removed level becomes 0.
 */
export function resolveModifyLevels(
  current: { stopLoss: number | null; takeProfit: number | null },
  patch: { stopLoss?: number | null; takeProfit?: number | null },
): { stopLoss: number; takeProfit: number } {
  const pick = (requested: number | null | undefined, existing: number | null): number =>
    requested === undefined ? (existing ?? 0) : (requested ?? 0);
  return { stopLoss: pick(patch.stopLoss, current.stopLoss), takeProfit: pick(patch.takeProfit, current.takeProfit) };
}

/** The volume left on a position after a partial close, never negative, in thousandths of a lot. */
export function remainingLots(volume: number, closing: number | undefined): number {
  return roundLots(Math.max(0, volume - (closing ?? volume)));
}

// ─────────────────────────────────────────────────────────────────────────────
// What the routes send to the panel
// ─────────────────────────────────────────────────────────────────────────────

export type WebTradeGateReason =
  | "SUBSCRIPTION_REQUIRED"
  | "EXECUTION_DISABLED"
  | "RISK_BLOCKED"
  | "ACCOUNT_NOT_CONNECTED"
  /** the AWS trading system is not reporting in (no heartbeat) - orders wait for it to come back */
  | "GATEWAY_OFFLINE";

/**
 * Where the orders of the panel run: through the WSA trading system on AWS ("gateway",
 * the normal way), straight from this server ("direct", where it has the broker bridge
 * and the execution switch) or nowhere ("none": the panel is read-only).
 */
export type WebTradeRoute = "gateway" | "direct" | "none";

/** Why an account cannot trade right now. `canManage` (change SL / TP, close) is on whenever the account can be reached. */
export interface WebTradeGate {
  canOpen: boolean;
  canManage: boolean;
  reason: WebTradeGateReason | null;
  message: string | null;
}

export interface WebTradeAccount {
  accountId: string;
  name: string;
  broker: string;
  platform: "MT4" | "MT5" | null;
  server: string | null;
  currency: string;
  status: AccountStatus;
  /** CONNECTED and linked to the broker service: positions can be read */
  reachable: boolean;
}

export interface WebTradeAccountsResponse {
  accounts: WebTradeAccount[];
  /** platform-wide part of the gate (subscription, execution switch); the risk part comes with the state of an account */
  gate: WebTradeGate;
  /** where orders run right now */
  route: WebTradeRoute;
}

export interface WebTradeQuote {
  symbol: string;
  bid: number;
  ask: number;
}

export interface WebTradeState {
  accountId: string;
  currency: string;
  balance: number;
  equity: number;
  floatingProfit: number;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  positions: BrokerOpenPosition[];
  /** the pending (limit / stop) orders that can be shown and managed */
  pending: BrokerPendingOrder[];
  /** every pending order the broker listed (can be more than `pending`: rows that could not be read are counted only) */
  pendingOrders: number;
  quote: WebTradeQuote | null;
  /** connected with the read-only (investor) password: the account can be followed but not traded */
  readOnly: boolean;
  /** risk rules of this account that block NEW orders (closing and SL / TP changes stay open) */
  riskBlocked: boolean;
  riskMessage: string | null;
  fetchedAt: string;
  /** where this picture came from */
  route: WebTradeRoute;
  /** the picture is older than it should be (the trading system is slow or busy) */
  delayed: boolean;
}

/** One position or order a bulk command could not handle. */
export interface WebTradeBulkFailure {
  ticket: string;
  symbol: string;
  message: string;
}

/**
 * Where the time of one order went, in milliseconds. Every part is optional: an older server or
 * the direct route reports less, and a step that was not needed (no read in front of a close) is absent.
 *
 *   total   = network + server + queue + broker + relay
 *   network : browser <-> web server (also a cold start of the function)        totalMs - serverMs
 *   server  : the web server's own work: sign-in check, gates, audit            serverMs - waitMs
 *   queue   : the command waited for the AWS worker                             queueMs
 *   broker  : the AWS worker's work, from taking the command to the broker's    runMs
 *             answer (of which `readMs` + `sessionMs` + `sendMs`)
 *   relay   : the database round trips between the web server and the worker    waitMs - queueMs - runMs
 */
export interface WebTradeTiming {
  queueMs?: number;
  runMs?: number;
  /** reading the account in front of the change */
  readMs?: number;
  /** getting a ready broker session (0 = it was warm) */
  sessionMs?: number;
  /** the order request(s) to the broker bridge */
  sendMs?: number;
  /** how often the order was sent (more than once after a requote) */
  attempts?: number;
  /** web server: from the request arriving to the answer leaving */
  serverMs?: number;
  /** web server: from writing the command to seeing its answer */
  waitMs?: number;
  /** browser: from the click to the answer (added by the panel's request helper) */
  totalMs?: number;
}

/** What the broker said about the order, for showing the result before the next picture arrives. */
export interface WebTradeOrderDetail {
  symbol?: string;
  /** lots the broker executed / closed */
  volume?: number;
  /** the price a market order was filled at */
  fillPrice?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  price?: number | null;
}

export interface WebTradeOrderResult {
  ok: true;
  /** the broker's ticket of the new position / order / the one that was changed */
  ticket: string | null;
  /** true when the same clientRequestId had already been handled and nothing new was sent */
  repeated?: boolean;
  /** something the person should know ("only part of the volume was executed") */
  note?: string | null;
  /** bulk commands: how many were closed / could not be, and why */
  closed?: number;
  failed?: number;
  failures?: WebTradeBulkFailure[];
  /** what the broker confirmed (fill price, executed lots, the levels now in force) */
  detail?: WebTradeOrderDetail;
  /** how long the command waited for the trading system and where the time went, in milliseconds */
  timing?: WebTradeTiming | null;
}

/** Every symbol of an account, spelled the way its broker spells it. */
export interface WebTradeSymbol {
  name: string;
  description: string | null;
  path: string | null;
  digits: number | null;
}

export interface WebTradeSymbols {
  symbols: WebTradeSymbol[];
  /** when the list was read from the broker (null = just now / unknown) */
  updatedAt: string | null;
  route: WebTradeRoute;
}

/**
 * Error codes after which the order MAY exist at the broker even though no clear answer came
 * back (a time-out, a worker that disappeared, an unknown failure on the way). The panel then
 * tells the person to check the open positions before sending the order again.
 */
const UNCERTAIN_TRADE_CODES: ReadonlySet<string> = new Set([
  "BROKER_ERROR",
  "BROKER_PROVIDER_TIMEOUT",
  "ORDER_UNCERTAIN",
  "WORKER_LOST",
  "NETWORK_ERROR",
]);

export function isUncertainTradeCode(code: string): boolean {
  return UNCERTAIN_TRADE_CODES.has(code);
}

/** Display name of a position's direction. */
export function sideLabel(side: WebTradeSide): string {
  return side === "BUY" ? "Buy" : "Sell";
}
