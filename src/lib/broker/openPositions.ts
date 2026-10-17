/**
 * Open positions and pending orders as WSA reads them from the broker. Pure - no I/O,
 * no environment - so it is safe next to the AWS workers and easy to test. The WSA
 * Trade panel, the account sync AND the copy engine all read the broker's answer
 * through this one file, so they can never disagree about what a row means.
 *
 * The API2Trade `OpenedOrders` answer mixes market positions and pending orders and
 * is loose about types: the order type is a number (MT4: 0 buy, 1 sell, 2-5 pending;
 * MT5: 0 buy, 1 sell, 2-7 pending) or a word ("Buy", "SellLimit"), the volume sits in
 * `lots` or `volume`, the times are broker SERVER time unless a UTC epoch is present
 * (see `orderNormalization.ts`). Everything here tolerates all of that and drops what
 * cannot be shown rather than guessing.
 */

import { estimateServerOffsetMs, instantIso, orderNetProfit, type BrokerOrderClock } from "./orderNormalization";

export type PositionSide = "BUY" | "SELL";

/** A pending order waits for a price: LIMIT (better price), STOP (breakout) or STOP_LIMIT (MT5). */
export type PendingKind = "LIMIT" | "STOP" | "STOP_LIMIT";

/** One open market position of a broker account. */
export interface BrokerOpenPosition {
  /** the id the broker wants for close / modify (position id, else ticket) */
  ticket: string;
  symbol: string;
  side: PositionSide;
  /** lots */
  volume: number;
  openPrice: number;
  /** null = none set */
  stopLoss: number | null;
  takeProfit: number | null;
  /** floating result: profit + swap + commission (+ fee), account currency */
  profit: number;
  swap: number;
  commission: number;
  /** UTC instant, null when the broker sent none that can be trusted */
  openedAt: string | null;
  comment: string | null;
}

/** One pending (limit / stop) order of a broker account. */
export interface BrokerPendingOrder {
  /** the id the broker wants for modify / cancel */
  ticket: string;
  symbol: string;
  side: PositionSide;
  kind: PendingKind;
  /** lots */
  volume: number;
  /** the price the order waits for (a stop-limit order: its trigger price) */
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** UTC instant the order was placed, null when the broker sent none that can be trusted */
  placedAt: string | null;
  comment: string | null;
}

export interface OpenOrderRow extends BrokerOrderClock {
  ticket?: unknown;
  id?: unknown;
  positionId?: unknown;
  orderId?: unknown;
  type?: unknown;
  orderType?: unknown;
  dealType?: unknown;
  lots?: unknown;
  volume?: unknown;
  closeLots?: unknown;
  closeVolume?: unknown;
  symbol?: unknown;
  openPrice?: unknown;
  stopLoss?: unknown;
  takeProfit?: unknown;
  comment?: unknown;
  profit?: unknown;
  commission?: unknown;
  swap?: unknown;
  fee?: unknown;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/**
 * A volume the broker sent WITHOUT a `lots` field, in lots. Bridges expose MetaTrader's
 * integer volumes: 1 lot = 10 000 (4 decimals) or 100 000 000 (MT5's extended 8 decimals).
 * Real lot sizes sit between 0.01 and a few hundred, so the magnitude tells the scale:
 *   below 100          already lots (0.01 ... 99.99)
 *   100 ... 999 999    1/10 000 lot units (100 = 0.01 lot, 10 000 = 1 lot)
 *   1 000 000 and up   1/100 000 000 lot units (1 000 000 = 0.01 lot)
 */
export function scaleRawVolume(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const lots = raw >= 1_000_000 ? raw / 100_000_000 : raw >= 100 ? raw / 10_000 : raw;
  return Math.round(lots * 1e8) / 1e8;
}

/**
 * Lots of an order. `lots` wins when the bridge sends it (taken as it is); otherwise the
 * integer-style `volume` is scaled by its magnitude. The ONE rule for the whole platform:
 * the copy engine used to scale differently from the WSA Trade panel.
 */
export function orderVolumeLots(order: OpenOrderRow): number {
  const lots = positiveNumber(order.lots) ?? positiveNumber(order.closeLots);
  if (lots !== null) return lots;
  const raw = positiveNumber(order.volume) ?? positiveNumber(order.closeVolume);
  return raw === null ? 0 : scaleRawVolume(raw);
}

/** Side of a broker order type and whether it is a pending order (limit / stop) instead of a position. */
export function classifyOrderType(value: unknown): { side: PositionSide | null; pending: boolean } {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const code = Number(value);
    if (code === 0) return { side: "BUY", pending: false };
    if (code === 1) return { side: "SELL", pending: false };
    // 2 buy limit, 3 sell limit, 4 buy stop, 5 sell stop, (MT5) 6 / 7 stop limit
    if (code >= 2 && code <= 7) return { side: code % 2 === 0 ? "BUY" : "SELL", pending: true };
    return { side: null, pending: false };
  }
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  if (!text) return { side: null, pending: false };
  const side: PositionSide | null = text.includes("sell") ? "SELL" : text.includes("buy") ? "BUY" : null;
  if (!side) return { side: null, pending: false };
  return { side, pending: text.includes("limit") || text.includes("stop") };
}

/** What a pending order waits for; null for anything that is not a pending order. */
export function pendingKindOf(value: unknown): PendingKind | null {
  if (!classifyOrderType(value).pending) return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const code = Number(value);
    return code <= 3 ? "LIMIT" : code <= 5 ? "STOP" : "STOP_LIMIT";
  }
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  if (text.includes("stoplimit")) return "STOP_LIMIT";
  return text.includes("limit") ? "LIMIT" : "STOP";
}

/** A price level; 0 and negatives mean "not set". */
function level(value: unknown): number | null {
  return positiveNumber(value);
}

/** The id close / modify calls use - the same convention as the copy engine (position id, else ticket). */
export function positionTicket(order: OpenOrderRow): string | null {
  for (const candidate of [order.positionId, order.ticket, order.orderId, order.id]) {
    if (candidate === null || candidate === undefined || candidate === "" || candidate === 0 || candidate === "0") continue;
    const text = String(candidate).trim();
    if (text) return text;
  }
  return null;
}

/**
 * Market positions (newest first), the pending orders (newest first) and the number of
 * pending orders found in an `OpenedOrders` answer. `pendingOrders` counts every pending
 * row, `pending` lists the ones that can be shown (an id, a symbol and a size).
 */
export function mapOpenPositions(
  orders: ReadonlyArray<OpenOrderRow>,
  options: { now?: number } = {},
): { positions: BrokerOpenPosition[]; pending: BrokerPendingOrder[]; pendingOrders: number } {
  const now = options.now ?? Date.now();
  const serverOffsetMs = estimateServerOffsetMs(orders) ?? 0;
  const positions: BrokerOpenPosition[] = [];
  const pending: BrokerPendingOrder[] = [];
  let pendingOrders = 0;

  for (const order of orders) {
    const rawType = order.orderType ?? order.type ?? order.dealType;
    const kind = classifyOrderType(rawType);
    if (!kind.side) continue;
    const ticket = positionTicket(order);
    const symbol = typeof order.symbol === "string" ? order.symbol.trim() : "";
    const volume = orderVolumeLots(order);
    const comment = typeof order.comment === "string" && order.comment.trim() ? order.comment.trim().slice(0, 64) : null;
    const openedAt = instantIso(order.openTimestampUTC, order.openTime, { serverOffsetMs, now }) ?? null;

    if (kind.pending) {
      pendingOrders += 1;
      const pendingKind = pendingKindOf(rawType);
      const price = positiveNumber(order.openPrice);
      if (!ticket || !symbol || !(volume > 0) || !pendingKind || price === null) continue;
      pending.push({
        ticket,
        symbol,
        side: kind.side,
        kind: pendingKind,
        volume,
        price,
        stopLoss: level(order.stopLoss),
        takeProfit: level(order.takeProfit),
        placedAt: openedAt,
        comment,
      });
      continue;
    }

    if (!ticket || !symbol || !(volume > 0)) continue;
    positions.push({
      ticket,
      symbol,
      side: kind.side,
      volume,
      openPrice: finiteNumber(order.openPrice) ?? 0,
      stopLoss: level(order.stopLoss),
      takeProfit: level(order.takeProfit),
      profit: orderNetProfit(order),
      swap: finiteNumber(order.swap) ?? 0,
      commission: finiteNumber(order.commission) ?? 0,
      openedAt,
      comment,
    });
  }

  const newestFirst = (left: string | null, right: string | null) => {
    const a = left ? Date.parse(left) : 0;
    const b = right ? Date.parse(right) : 0;
    return b - a;
  };
  positions.sort((left, right) => newestFirst(left.openedAt, right.openedAt));
  pending.sort((left, right) => newestFirst(left.placedAt, right.placedAt));
  return { positions, pending, pendingOrders };
}
