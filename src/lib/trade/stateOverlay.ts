/**
 * What the panel already knows the moment the trading system has confirmed an order, laid over the
 * last picture of the account. Pure.
 *
 * The AWS trading system publishes a new picture of the account within a fraction of a second of an
 * order, but the browser only sees it on its next read. Without this the person would watch the old
 * list for a moment after "closed" - so the panel records what the answer said ("ticket 9001 is
 * closed", "stop loss is now 2290", "a buy limit was placed") and shows it at once. The overlay is
 * short-lived: it is dropped after a few seconds, and by then the real picture has caught up. It
 * never invents money figures - balance, equity and margin only change with the next real picture.
 */

import type {
  WebTradeOrderKind,
  WebTradeOrderResult,
  WebTradePendingOrder,
  WebTradePosition,
  WebTradeSide,
  WebTradeState,
} from "@/lib/trade/webTrade";
import { roundLots } from "@/lib/trade/webTrade";

/** How long an overlay entry is kept; the next real pictures arrive every 400 ms right after an order. */
export const OVERLAY_TTL_MS = 6000;

export type StateChange =
  | { kind: "closed"; accountId: string; ticket: string }
  | { kind: "reduced"; accountId: string; ticket: string; volume: number }
  | { kind: "removed"; accountId: string; ticket: string }
  | {
      kind: "levels";
      accountId: string;
      ticket: string;
      stopLoss?: number | null;
      takeProfit?: number | null;
      price?: number;
    }
  | { kind: "opened"; accountId: string; position: WebTradePosition }
  | { kind: "placed"; accountId: string; order: WebTradePendingOrder };

/** The picture with the changes of this account laid over it. The same object when nothing applies. */
export function applyChanges(state: WebTradeState, changes: ReadonlyArray<StateChange>): WebTradeState {
  const mine = changes.filter((change) => change.accountId === state.accountId);
  if (mine.length === 0) return state;

  let positions = state.positions;
  let pending = state.pending;
  let pendingDelta = 0;

  for (const change of mine) {
    switch (change.kind) {
      case "closed":
        if (positions.some((entry) => entry.ticket === change.ticket)) {
          positions = positions.filter((entry) => entry.ticket !== change.ticket);
        }
        break;
      case "reduced":
        positions = positions.map((entry) => {
          if (entry.ticket !== change.ticket || !(entry.volume > change.volume) || !(entry.volume > 0)) return entry;
          const ratio = change.volume / entry.volume;
          return {
            ...entry,
            volume: change.volume,
            profit: entry.profit * ratio,
            swap: entry.swap * ratio,
            commission: entry.commission * ratio,
          };
        });
        break;
      case "removed":
        if (pending.some((entry) => entry.ticket === change.ticket)) {
          pending = pending.filter((entry) => entry.ticket !== change.ticket);
          pendingDelta -= 1;
        }
        break;
      case "levels":
        positions = positions.map((entry) =>
          entry.ticket === change.ticket
            ? {
                ...entry,
                stopLoss: change.stopLoss === undefined ? entry.stopLoss : change.stopLoss,
                takeProfit: change.takeProfit === undefined ? entry.takeProfit : change.takeProfit,
              }
            : entry,
        );
        pending = pending.map((entry) =>
          entry.ticket === change.ticket
            ? {
                ...entry,
                price: change.price === undefined ? entry.price : change.price,
                stopLoss: change.stopLoss === undefined ? entry.stopLoss : change.stopLoss,
                takeProfit: change.takeProfit === undefined ? entry.takeProfit : change.takeProfit,
              }
            : entry,
        );
        break;
      case "opened":
        if (!positions.some((entry) => entry.ticket === change.position.ticket)) {
          positions = [change.position, ...positions];
        }
        break;
      case "placed":
        if (!pending.some((entry) => entry.ticket === change.order.ticket)) {
          pending = [change.order, ...pending];
          pendingDelta += 1;
        }
        break;
    }
  }

  if (positions === state.positions && pending === state.pending && pendingDelta === 0) return state;
  return { ...state, positions, pending, pendingOrders: Math.max(0, state.pendingOrders + pendingDelta) };
}

// ─────────────────────────────────────────────────────────────────────────────
// From the answer of an order to the changes it means
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_STAMP = (): string => new Date().toISOString();

export interface OpenedRequest {
  symbol: string;
  side: WebTradeSide;
  volume: number;
  orderKind: WebTradeOrderKind;
  price: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** A new position (market) or pending order (limit / stop). Nothing when the answer has no ticket or no usable price. */
export function changesFromOpen(
  accountId: string,
  result: WebTradeOrderResult,
  request: OpenedRequest,
  quote: { bid: number; ask: number } | null,
): StateChange[] {
  if (!result.ticket) return [];
  const volume = result.detail?.volume && result.detail.volume > 0 ? result.detail.volume : request.volume;
  const stopLoss = result.detail?.stopLoss !== undefined ? result.detail.stopLoss : request.stopLoss;
  const takeProfit = result.detail?.takeProfit !== undefined ? result.detail.takeProfit : request.takeProfit;

  if (request.orderKind === "MARKET") {
    const quoted = quote ? (request.side === "BUY" ? quote.ask : quote.bid) : null;
    const openPrice = result.detail?.fillPrice ?? quoted;
    if (!openPrice || !(openPrice > 0)) return [];
    return [
      {
        kind: "opened",
        accountId,
        position: {
          ticket: result.ticket,
          symbol: request.symbol,
          side: request.side,
          volume,
          openPrice,
          stopLoss: stopLoss ?? null,
          takeProfit: takeProfit ?? null,
          profit: 0,
          swap: 0,
          commission: 0,
          openedAt: OPEN_STAMP(),
          comment: null,
        },
      },
    ];
  }

  const price = result.detail?.price ?? request.price;
  if (!price || !(price > 0)) return [];
  return [
    {
      kind: "placed",
      accountId,
      order: {
        ticket: result.ticket,
        symbol: request.symbol,
        side: request.side,
        kind: request.orderKind,
        volume,
        price,
        stopLoss: stopLoss ?? null,
        takeProfit: takeProfit ?? null,
        placedAt: OPEN_STAMP(),
        comment: null,
      },
    },
  ];
}

/** A whole close, or - when `closing` lots were asked for and fewer than the position has - a smaller position. */
export function changesFromClose(
  accountId: string,
  result: WebTradeOrderResult,
  position: Pick<WebTradePosition, "ticket" | "volume">,
  closing: number | null,
): StateChange[] {
  const closed = result.detail?.volume && result.detail.volume > 0 ? result.detail.volume : closing;
  if (closed !== null && closed !== undefined && roundLots(closed) < roundLots(position.volume)) {
    return [
      { kind: "reduced", accountId, ticket: position.ticket, volume: roundLots(position.volume - closed) },
    ];
  }
  return [{ kind: "closed", accountId, ticket: position.ticket }];
}

/** The levels now in force, from what the broker confirmed, else from what was asked. */
export function changesFromModify(
  accountId: string,
  ticket: string,
  result: WebTradeOrderResult,
  patch: { stopLoss?: number | null; takeProfit?: number | null; price?: number },
): StateChange[] {
  const stopLoss = result.detail?.stopLoss !== undefined ? result.detail.stopLoss : patch.stopLoss;
  const takeProfit = result.detail?.takeProfit !== undefined ? result.detail.takeProfit : patch.takeProfit;
  const price = result.detail?.price ?? patch.price;
  const change: StateChange = { kind: "levels", accountId, ticket };
  if (stopLoss !== undefined) change.stopLoss = stopLoss;
  if (takeProfit !== undefined) change.takeProfit = takeProfit;
  if (typeof price === "number" && price > 0) change.price = price;
  return [change];
}

/** Several closed / deleted at once, except the ones the trading system reported as failed. */
export function changesFromBulk(
  accountId: string,
  result: WebTradeOrderResult,
  targets: { positions: ReadonlyArray<{ ticket: string }>; pending: ReadonlyArray<{ ticket: string }> },
): StateChange[] {
  const targetCount = targets.positions.length + targets.pending.length;
  const failedCount = result.failed ?? 0;
  // The broker can see a different list from the browser, and large batches cap the
  // reported failures. In either case we cannot identify every successful ticket;
  // wait for the next broker snapshot instead of hiding an unconfirmed position.
  if (
    result.closed === undefined ||
    result.closed + failedCount !== targetCount ||
    failedCount !== (result.failures?.length ?? 0)
  ) return [];
  const failed = new Set((result.failures ?? []).map((failure) => failure.ticket));
  const changes: StateChange[] = [];
  for (const entry of targets.positions) {
    if (!failed.has(entry.ticket)) changes.push({ kind: "closed", accountId, ticket: entry.ticket });
  }
  for (const entry of targets.pending) {
    if (!failed.has(entry.ticket)) changes.push({ kind: "removed", accountId, ticket: entry.ticket });
  }
  return changes;
}
