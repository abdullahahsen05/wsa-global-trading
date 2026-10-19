/**
 * Trade gateway - the commands the web tier sends to the AWS system, and what comes back.
 *
 * Pure: types, validation and errors, no I/O, no environment. Shared by the web app
 * (which writes a command), the AWS worker (which executes it) and the tests. A command
 * is stored as `kind` + a JSON `payload`; the worker never trusts the payload: it goes
 * through `parseTradeCommand` again, whatever wrote the row.
 */

import type { BrokerSymbolInfo, BrokerTradingState, OrderKind } from "@/lib/broker/BrokerAdapter";
import {
  isValidLots,
  MAX_TRADE_LEVEL,
  pendingLevelsProblem,
  TICKET_PATTERN,
  TRADE_SYMBOL_PATTERN,
  WEB_TRADE_BULK_SCOPES,
  WEB_TRADE_ORDER_KINDS,
  WEB_TRADE_SIDES,
  type WebTradeBulkScope,
  type WebTradeSide,
} from "@/lib/trade/webTrade";

export const TRADE_COMMAND_KINDS = ["OPEN", "CLOSE", "MODIFY", "CANCEL", "CLOSE_BULK", "STATE", "SYMBOLS"] as const;
export type TradeCommandKind = (typeof TRADE_COMMAND_KINDS)[number];

/** Commands that change something at the broker (the others only read). */
export const ORDER_COMMAND_KINDS: ReadonlySet<TradeCommandKind> = new Set(["OPEN", "CLOSE", "MODIFY", "CANCEL", "CLOSE_BULK"]);

export const ORDER_KINDS = WEB_TRADE_ORDER_KINDS satisfies ReadonlyArray<OrderKind>;

/** What a bulk close takes: every position, the winners, the losers, one side, one symbol, or the pending orders. */
export const BULK_SCOPES = WEB_TRADE_BULK_SCOPES;
export type BulkScope = WebTradeBulkScope;

/** Most quotes the worker keeps fresh for one watched account. */
export const MAX_WATCHED_SYMBOLS = 5;

/** An error with a code the web tier turns into an API answer. `statusCode` is the HTTP status to use. */
export class TradeCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "TradeCommandError";
  }
}

// ── payloads ─────────────────────────────────────────────────────────────────

export interface OpenCommand {
  symbol: string;
  side: WebTradeSide;
  volume: number;
  orderKind: OrderKind;
  /** entry price of a pending order; null for a market order */
  price: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface CloseCommand {
  ticket: string;
  /** null = the whole position */
  volume: number | null;
}

/** `undefined` (key missing) keeps a value, `null` removes a level, a number sets it. */
export interface ModifyCommand {
  ticket: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** new entry price - only for a pending order */
  price?: number;
}

export interface CancelCommand {
  ticket: string;
}

export interface CloseBulkCommand {
  scope: BulkScope;
  symbol: string | null;
}

export interface StateCommand {
  symbols: string[];
}

export type ParsedTradeCommand =
  | { kind: "OPEN"; payload: OpenCommand }
  | { kind: "CLOSE"; payload: CloseCommand }
  | { kind: "MODIFY"; payload: ModifyCommand }
  | { kind: "CANCEL"; payload: CancelCommand }
  | { kind: "CLOSE_BULK"; payload: CloseBulkCommand }
  | { kind: "STATE"; payload: StateCommand }
  | { kind: "SYMBOLS"; payload: Record<string, never> };

// ── what comes back ──────────────────────────────────────────────────────────

export interface GatewayQuote {
  bid: number;
  ask: number;
  /** ISO time the worker read the price */
  at: string;
}

/** Figures, positions and pending orders of an account, plus the prices of the symbols being watched. */
export interface GatewayTradingState extends BrokerTradingState {
  quotes: Record<string, GatewayQuote>;
}

export interface BulkFailure {
  ticket: string;
  symbol: string;
  message: string;
}

/** What actually happened, as far as the worker knows it - used for the audit log. */
export interface CommandDetail {
  symbol?: string;
  /** levels after a modification (null = none) */
  stopLoss?: number | null;
  takeProfit?: number | null;
  price?: number | null;
  /** lots the broker executed / closed, when it said */
  volume?: number;
  /** the price the broker filled a market order at, when it said */
  fillPrice?: number;
}

/**
 * Where the time of one command went, measured on the AWS side (milliseconds). Everything but
 * `queueMs` and `runMs` is optional: an older worker does not report it, and a step that was not
 * needed (no read in front of a close) is simply absent.
 */
export interface CommandTiming {
  /** the command waited for the worker: worker clock when it took the command minus the time it was written */
  queueMs: number;
  /** the worker's work on it, from taking it up to having the broker's answer (writing the answer is not in it) */
  runMs: number;
  /** reading the account before the change (a modify or a delete needs the current levels / kind) */
  readMs?: number;
  /** getting a ready broker session (0 = it was already warm) */
  sessionMs?: number;
  /** the order request(s) to the broker bridge */
  sendMs?: number;
  /** how often the order was sent (more than once after a requote) */
  attempts?: number;
}

export interface TradeCommandOutcome {
  /** the broker's ticket of the new order / position / the one that was changed */
  ticket?: string | null;
  /** something the person should know ("only part of the volume was executed") */
  note?: string | null;
  detail?: CommandDetail;
  /** CLOSE_BULK */
  closed?: number;
  failed?: number;
  failures?: BulkFailure[];
  /** STATE */
  state?: GatewayTradingState;
  /** SYMBOLS */
  symbols?: BrokerSymbolInfo[];
  /** how long the command waited for the worker and where the worker's time went, in milliseconds */
  timing?: CommandTiming;
}

/** The error half of an answer, as stored in the row. */
export interface StoredCommandError {
  code: string;
  message: string;
  statusCode: number;
}

// ── parsing ──────────────────────────────────────────────────────────────────

function invalid(message: string): never {
  throw new TradeCommandError("INVALID_COMMAND", message, 400);
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function symbolOf(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!TRADE_SYMBOL_PATTERN.test(text)) invalid("Symbol is not valid.");
  return text;
}

function ticketOf(value: unknown): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!TICKET_PATTERN.test(text)) invalid("Position is not valid.");
  return text;
}

function levelOf(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TRADE_LEVEL) {
    invalid(`${name} must be a price above zero.`);
  }
  return value;
}

/** null stays null, a number is checked, a missing key is `undefined`. */
function optionalLevel(record: Record<string, unknown>, key: string, name: string): number | null | undefined {
  if (!(key in record) || record[key] === undefined) return undefined;
  if (record[key] === null) return null;
  return levelOf(record[key], name);
}

export function isTradeCommandKind(value: unknown): value is TradeCommandKind {
  return typeof value === "string" && (TRADE_COMMAND_KINDS as ReadonlyArray<string>).includes(value);
}

/** Checks a stored command and gives it its proper types. Throws `TradeCommandError` (INVALID_COMMAND). */
export function parseTradeCommand(kind: unknown, raw: unknown): ParsedTradeCommand {
  if (!isTradeCommandKind(kind)) invalid("Unknown command.");
  const record = asRecord(raw);

  switch (kind) {
    case "OPEN": {
      const side = record.side;
      if (!(WEB_TRADE_SIDES as ReadonlyArray<unknown>).includes(side)) invalid("Direction must be buy or sell.");
      const volume = record.volume;
      if (!isValidLots(volume)) invalid("Volume is not valid.");
      const orderKind = record.orderKind === undefined ? "MARKET" : record.orderKind;
      if (!(ORDER_KINDS as ReadonlyArray<unknown>).includes(orderKind)) invalid("Order type is not valid.");
      const price = orderKind === "MARKET" ? null : levelOf(record.price, "Price");
      const stopLoss = optionalLevel(record, "stopLoss", "Stop loss") ?? null;
      const takeProfit = optionalLevel(record, "takeProfit", "Take profit") ?? null;
      const typedSide = side as WebTradeSide;
      if (price !== null) {
        const problem = pendingLevelsProblem(typedSide, price, stopLoss, takeProfit);
        if (problem) invalid(problem);
      }
      return {
        kind,
        payload: {
          symbol: symbolOf(record.symbol),
          side: typedSide,
          volume: volume as number,
          orderKind: orderKind as OrderKind,
          price,
          stopLoss,
          takeProfit,
        },
      };
    }
    case "CLOSE": {
      const volume = record.volume;
      if (volume !== undefined && volume !== null && !isValidLots(volume)) invalid("Volume is not valid.");
      return { kind, payload: { ticket: ticketOf(record.ticket), volume: typeof volume === "number" ? volume : null } };
    }
    case "MODIFY": {
      const stopLoss = optionalLevel(record, "stopLoss", "Stop loss");
      const takeProfit = optionalLevel(record, "takeProfit", "Take profit");
      const price = record.price === undefined || record.price === null ? undefined : levelOf(record.price, "Price");
      if (stopLoss === undefined && takeProfit === undefined && price === undefined) invalid("Nothing to change.");
      const payload: ModifyCommand = { ticket: ticketOf(record.ticket) };
      if (stopLoss !== undefined) payload.stopLoss = stopLoss;
      if (takeProfit !== undefined) payload.takeProfit = takeProfit;
      if (price !== undefined) payload.price = price;
      return { kind, payload };
    }
    case "CANCEL":
      return { kind, payload: { ticket: ticketOf(record.ticket) } };
    case "CLOSE_BULK": {
      const scope = record.scope;
      if (!(BULK_SCOPES as ReadonlyArray<unknown>).includes(scope)) invalid("Choose what to close.");
      const symbol = record.symbol === undefined || record.symbol === null ? null : symbolOf(record.symbol);
      if (scope === "SYMBOL" && !symbol) invalid("Choose the symbol to close.");
      return { kind, payload: { scope: scope as BulkScope, symbol } };
    }
    case "STATE": {
      const list = Array.isArray(record.symbols) ? record.symbols : [];
      const symbols: string[] = [];
      for (const entry of list) {
        const text = typeof entry === "string" ? entry.trim() : "";
        if (TRADE_SYMBOL_PATTERN.test(text) && !symbols.includes(text)) symbols.push(text);
        if (symbols.length >= MAX_WATCHED_SYMBOLS) break;
      }
      return { kind, payload: { symbols } };
    }
    case "SYMBOLS":
      return { kind, payload: {} };
  }
}
