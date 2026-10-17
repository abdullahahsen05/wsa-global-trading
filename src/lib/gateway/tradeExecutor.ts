if (typeof window !== "undefined") {
  throw new Error("[wsa] tradeExecutor is server-only.");
}

/**
 * Trade gateway - what a command does at the broker.
 *
 * One function per command kind, all on top of the broker adapter. It runs where the
 * MetaTrader side lives (the AWS worker) and is also what the web tier uses when it has
 * the broker bridge itself (a local run, the fallback when no worker is online), so a
 * click means the same thing on both routes.
 *
 * The gates (platform subscription, risk rules, ownership of the account) belong to the
 * caller - the web tier checks them BEFORE it writes a command. What is checked here is
 * the broker side: the switch that allows order execution, that the position or the
 * pending order is really there, and that the levels make sense for it.
 *
 * Speed rules: closing a position and sending an order read nothing first (the broker
 * answers "no such order" itself); only changes that need the current levels, and
 * cancelling (which must be sure the ticket is a PENDING order - a "cancel" that fell
 * through to a close would close a real position), read the account first.
 *
 * No Next / React imports: shared with the AWS worker.
 */

import { publicTradeRejection } from "@/lib/broker/api2TradeErrors";
import {
  BrokerExecutionError,
  type BrokerAdapter,
  type BrokerExecutionResult,
  type BrokerOpenPosition,
  type BrokerPendingOrder,
  type BrokerTradingState,
} from "@/lib/broker/BrokerAdapter";
import { runPool } from "@/lib/copy/pool";
import { levelsProblem, pendingLevelsProblem, resolveModifyLevels, WEB_TRADE_COMMENT } from "@/lib/trade/webTrade";
import {
  TradeCommandError,
  type BulkFailure,
  type BulkScope,
  type CommandDetail,
  type GatewayQuote,
  type GatewayTradingState,
  type ModifyCommand,
  type ParsedTradeCommand,
  type StoredCommandError,
  type TradeCommandOutcome,
} from "./tradeCommands";

/** Orders sent at the same time by one bulk command (the broker session is shared). */
export const BULK_CONCURRENCY = 3;
/** Most positions / orders one bulk command touches. */
export const MAX_BULK_ITEMS = 200;
/** Failures listed in the answer of a bulk command. */
const MAX_LISTED_FAILURES = 20;

type StateReader = BrokerAdapter & Required<Pick<BrokerAdapter, "fetchTradingState">>;

function stateReader(adapter: BrokerAdapter): StateReader {
  if (!adapter.fetchTradingState) {
    throw new TradeCommandError("NOT_SUPPORTED", "The broker connection cannot read positions.", 501);
  }
  return adapter as StateReader;
}

function assertExecution(adapter: BrokerAdapter): void {
  if (!adapter.executionAvailable()) {
    throw new TradeCommandError(
      "EXECUTION_DISABLED",
      "Order execution is switched off on the trading system. You can still follow your positions here.",
      503,
    );
  }
}

// ── errors in words ──────────────────────────────────────────────────────────

/** Any failure as the code / sentence / HTTP status that is stored with a command and shown to the person. */
export function describeCommandError(error: unknown): StoredCommandError {
  if (error instanceof TradeCommandError) {
    return { code: error.code, message: error.message, statusCode: error.statusCode };
  }
  if (error instanceof BrokerExecutionError) {
    return { code: error.code, message: error.message, statusCode: error.statusCode };
  }
  return { code: "BROKER_ERROR", message: publicTradeRejection(error), statusCode: 502 };
}

// ── reads ────────────────────────────────────────────────────────────────────

async function readQuotes(
  adapter: BrokerAdapter,
  accountId: string,
  symbols: readonly string[],
): Promise<Record<string, GatewayQuote>> {
  const quotes: Record<string, GatewayQuote> = {};
  const fetchQuote = adapter.fetchQuote?.bind(adapter);
  if (!fetchQuote || symbols.length === 0) return quotes;
  const answers = await Promise.all(symbols.map((symbol) => fetchQuote(accountId, symbol).catch(() => null)));
  const at = new Date().toISOString();
  answers.forEach((quote, index) => {
    if (quote && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.bid > 0 && quote.ask > 0) {
      quotes[symbols[index]] = { bid: quote.bid, ask: quote.ask, at };
    }
  });
  return quotes;
}

/** Figures, positions and pending orders of an account plus the prices of the symbols on screen. */
export async function readGatewayState(
  adapter: BrokerAdapter,
  accountId: string,
  symbols: readonly string[],
): Promise<GatewayTradingState> {
  const state = await stateReader(adapter).fetchTradingState(accountId);
  // Sequential on purpose: the state call has just made sure the broker session is ready.
  const quotes = await readQuotes(adapter, accountId, symbols);
  return { ...state, quotes };
}

// ── bulk targets ─────────────────────────────────────────────────────────────

/** What a bulk command touches: positions to close and pending orders to delete. Pure. */
export function bulkTargets(
  state: Pick<BrokerTradingState, "positions" | "pending">,
  scope: BulkScope,
  symbol: string | null,
): { positions: BrokerOpenPosition[]; pending: BrokerPendingOrder[] } {
  const wanted = symbol?.toLowerCase() ?? null;
  const sameSymbol = (entry: { symbol: string }) => wanted === null || entry.symbol.toLowerCase() === wanted;
  switch (scope) {
    case "ALL":
      return { positions: [...state.positions], pending: [] };
    case "PROFIT":
      return { positions: state.positions.filter((entry) => entry.profit > 0), pending: [] };
    case "LOSS":
      return { positions: state.positions.filter((entry) => entry.profit < 0), pending: [] };
    case "BUY":
      return { positions: state.positions.filter((entry) => entry.side === "BUY"), pending: [] };
    case "SELL":
      return { positions: state.positions.filter((entry) => entry.side === "SELL"), pending: [] };
    case "SYMBOL":
      return { positions: state.positions.filter(sameSymbol), pending: [] };
    case "PENDING":
      return { positions: [], pending: state.pending.filter(sameSymbol) };
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

function outcomeOf(
  ticket: string | null | undefined,
  result: BrokerExecutionResult,
  detail: CommandDetail = {},
): TradeCommandOutcome {
  const executed = result.executedVolume !== undefined && result.executedVolume > 0 ? { volume: result.executedVolume } : {};
  return { ticket: ticket ?? null, note: result.note ?? null, detail: { ...executed, ...detail } };
}

/** The value a level gets in a modification: the patch wins, `null` removes it, a missing key keeps the current one. 0 = none. */
function levelAfter(patch: number | null | undefined, current: number | null): number {
  return patch === undefined ? (current ?? 0) : (patch ?? 0);
}

async function modifyPosition(
  adapter: BrokerAdapter,
  accountId: string,
  position: BrokerOpenPosition,
  patch: ModifyCommand,
): Promise<TradeCommandOutcome> {
  if (patch.price !== undefined) {
    throw new TradeCommandError("VALIDATION_ERROR", "The entry price can only be changed on a pending order.", 400);
  }
  const levels = resolveModifyLevels(position, patch);
  const problem = levelsProblem(position.side, levels.stopLoss || null, levels.takeProfit || null);
  if (problem) throw new TradeCommandError("VALIDATION_ERROR", problem, 400);
  if (levels.stopLoss === (position.stopLoss ?? 0) && levels.takeProfit === (position.takeProfit ?? 0)) {
    throw new TradeCommandError("NO_CHANGE", "Stop loss and take profit already have these values.", 400);
  }
  const result = await adapter.modifyTrade({
    accountId,
    brokerPositionId: position.ticket,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,
  });
  return outcomeOf(position.ticket, result, {
    symbol: position.symbol,
    stopLoss: levels.stopLoss || null,
    takeProfit: levels.takeProfit || null,
  });
}

async function modifyPendingOrder(
  adapter: BrokerAdapter,
  accountId: string,
  order: BrokerPendingOrder,
  patch: ModifyCommand,
): Promise<TradeCommandOutcome> {
  const price = patch.price ?? order.price;
  const stopLoss = levelAfter(patch.stopLoss, order.stopLoss);
  const takeProfit = levelAfter(patch.takeProfit, order.takeProfit);
  const problem = pendingLevelsProblem(order.side, price, stopLoss || null, takeProfit || null);
  if (problem) throw new TradeCommandError("VALIDATION_ERROR", problem, 400);
  if (price === order.price && stopLoss === (order.stopLoss ?? 0) && takeProfit === (order.takeProfit ?? 0)) {
    throw new TradeCommandError("NO_CHANGE", "The order already has these values.", 400);
  }
  const result = await adapter.modifyTrade({
    accountId,
    brokerPositionId: order.ticket,
    price,
    stopLoss,
    takeProfit,
  });
  return outcomeOf(order.ticket, result, {
    symbol: order.symbol,
    price,
    stopLoss: stopLoss || null,
    takeProfit: takeProfit || null,
  });
}

async function closeBulk(
  adapter: BrokerAdapter,
  accountId: string,
  scope: BulkScope,
  symbol: string | null,
): Promise<TradeCommandOutcome> {
  assertExecution(adapter);
  const state = await stateReader(adapter).fetchTradingState(accountId);
  const targets = bulkTargets(state, scope, symbol);

  type Item = { ticket: string; symbol: string; pending: boolean };
  const everything: Item[] = [
    ...targets.positions.map((entry) => ({ ticket: entry.ticket, symbol: entry.symbol, pending: false })),
    ...targets.pending.map((entry) => ({ ticket: entry.ticket, symbol: entry.symbol, pending: true })),
  ];
  if (everything.length === 0) {
    return { closed: 0, failed: 0, failures: [], note: "There was nothing to close." };
  }
  const work = everything.slice(0, MAX_BULK_ITEMS);
  const cancel = adapter.cancelOrder?.bind(adapter);
  if (work.some((item) => item.pending) && !cancel) {
    throw new TradeCommandError("NOT_SUPPORTED", "The broker connection cannot delete pending orders.", 501);
  }

  let closed = 0;
  const failures: BulkFailure[] = [];
  await runPool(work, BULK_CONCURRENCY, async (item) => {
    try {
      if (item.pending) {
        await (cancel as NonNullable<typeof cancel>)({ accountId, brokerOrderId: item.ticket });
      } else {
        await adapter.closeTrade({
          accountId,
          brokerPositionId: item.ticket,
          symbol: item.symbol,
          volume: null,
          comment: WEB_TRADE_COMMENT,
        });
      }
      closed += 1;
    } catch (error) {
      failures.push({ ticket: item.ticket, symbol: item.symbol, message: describeCommandError(error).message });
    }
  });

  const skipped = everything.length - work.length;
  return {
    closed,
    failed: failures.length,
    failures: failures.slice(0, MAX_LISTED_FAILURES),
    note: skipped > 0 ? `Only the first ${MAX_BULK_ITEMS} were handled - run it again for the other ${skipped}.` : null,
  };
}

/** Runs one (already parsed) command on one account. Throws `TradeCommandError` / `BrokerExecutionError` / whatever the broker path throws. */
export async function executeTradeCommand(
  adapter: BrokerAdapter,
  accountId: string,
  command: ParsedTradeCommand,
): Promise<TradeCommandOutcome> {
  switch (command.kind) {
    case "OPEN": {
      assertExecution(adapter);
      const order = command.payload;
      const result = await adapter.openTrade({
        accountId,
        symbol: order.symbol,
        side: order.side,
        volume: order.volume,
        orderKind: order.orderKind,
        price: order.price,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        comment: WEB_TRADE_COMMENT,
      });
      return outcomeOf(result.brokerPositionId ?? result.brokerOrderId ?? null, result, { symbol: order.symbol });
    }

    case "CLOSE": {
      assertExecution(adapter);
      const result = await adapter.closeTrade({
        accountId,
        brokerPositionId: command.payload.ticket,
        volume: command.payload.volume,
        comment: WEB_TRADE_COMMENT,
      });
      return outcomeOf(command.payload.ticket, result);
    }

    case "MODIFY": {
      assertExecution(adapter);
      const state = await stateReader(adapter).fetchTradingState(accountId);
      const position = state.positions.find((entry) => entry.ticket === command.payload.ticket);
      if (position) return modifyPosition(adapter, accountId, position, command.payload);
      const order = state.pending.find((entry) => entry.ticket === command.payload.ticket);
      if (order) return modifyPendingOrder(adapter, accountId, order, command.payload);
      throw new TradeCommandError("POSITION_NOT_FOUND", "This position is no longer open on the account.", 404);
    }

    case "CANCEL": {
      assertExecution(adapter);
      if (!adapter.cancelOrder) {
        throw new TradeCommandError("NOT_SUPPORTED", "The broker connection cannot delete pending orders.", 501);
      }
      const state = await stateReader(adapter).fetchTradingState(accountId);
      const order = state.pending.find((entry) => entry.ticket === command.payload.ticket);
      if (!order) {
        const isPosition = state.positions.some((entry) => entry.ticket === command.payload.ticket);
        throw new TradeCommandError(
          isPosition ? "VALIDATION_ERROR" : "POSITION_NOT_FOUND",
          isPosition
            ? "This is an open position, not a pending order - close it instead."
            : "This pending order no longer exists on the account.",
          isPosition ? 400 : 404,
        );
      }
      const result = await adapter.cancelOrder({ accountId, brokerOrderId: order.ticket });
      return outcomeOf(order.ticket, result, { symbol: order.symbol });
    }

    case "CLOSE_BULK":
      return closeBulk(adapter, accountId, command.payload.scope, command.payload.symbol);

    case "STATE":
      return { state: await readGatewayState(adapter, accountId, command.payload.symbols) };

    case "SYMBOLS":
      return { symbols: adapter.fetchSymbolList ? await adapter.fetchSymbolList(accountId) : [] };
  }
}
