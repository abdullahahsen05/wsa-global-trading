/**
 * A change of a position, as a broker stream reports it, turned into the event the self-copy engine
 * copies. Pure - shared with the AWS copy worker (no Next, React or `server-only` imports).
 *
 * The one thing worth care is the time the trade opened: the engine compares it with the moment the
 * route went live (see `isExistingForRoute`), so a time that is not certainly a UTC instant is NOT
 * used - broker server time (UTC+2 / +3 with summer time) read as UTC would make an old trade look new.
 */

import type { SelfCopyPositionEvent } from "@/lib/copy/selfCopyEngine";

export interface StreamPosition {
  id: string | number;
  type?: string | null;
  symbol: string;
  volume?: number | string | null;
  openPrice?: number | string | null;
  stopLoss?: number | string | null;
  takeProfit?: number | string | null;
  /** when the trade opened: an ISO text with its zone, a Date, or epoch milliseconds / seconds */
  time?: string | number | Date | null;
}

export interface StreamChange {
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  position: StreamPosition;
  /** MODIFY: the position before the change */
  previous?: StreamPosition | null;
  /** when the change reached this process (epoch ms) */
  detectedAt?: number | null;
  /** OPEN: found in the first look at the account, not seen opening */
  existing?: boolean;
}

/** A text that says which zone it is in: `...Z` or `...+02:00` (date-only ISO texts are UTC by definition). */
const WITH_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** An instant as epoch milliseconds, or null when it is missing or cannot be told for certain. */
export function instantMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || !WITH_ZONE.test(text)) return null;
    const ms = Date.parse(text);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

function positive(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function toSelfCopyPositionEvent(sourceAccountId: string, change: StreamChange): SelfCopyPositionEvent {
  const { position, previous } = change;
  return {
    sourceAccountId,
    eventType: change.eventType,
    sourcePositionId: String(position.id),
    symbol: position.symbol,
    side: String(position.type ?? "").toUpperCase().includes("SELL") ? "SELL" : "BUY",
    volume: positive(position.volume) ?? 0,
    previousVolume: previous ? (positive(previous.volume) ?? 0) : null,
    entryPrice: positive(position.openPrice),
    stopLoss: positive(position.stopLoss),
    takeProfit: positive(position.takeProfit),
    // without the levels before the change the engine cannot tell what a MODIFY changed
    ...(previous ? { previousStopLoss: positive(previous.stopLoss), previousTakeProfit: positive(previous.takeProfit) } : {}),
    ...(change.existing === true ? { existing: true } : {}),
    detectedAt: change.detectedAt ?? null,
    openedAt: instantMs(position.time),
  };
}
