/**
 * Order payload helpers shared by the API2Trade adapter and the live source.
 * Pure functions - no I/O, no environment - so they are safe in the AWS workers
 * and easy to test.
 *
 * Why this exists (the "curve does not match the dates" bug):
 * MT4 / MT5 report order times in BROKER SERVER time - wall-clock text without a
 * zone, e.g. `2026-10-11T14:35:22`, usually UTC+2 / UTC+3 and moving with DST.
 * Read as UTC (what `new Date(text)` does on a UTC server) every trade lands
 * hours away from the equity snapshots, whose `captured_at` is real UTC, so the
 * balance steps, trade markers and the window of the chart no longer line up.
 * The bridge also sends real UTC epochs (`openTimestampUTC` / `closeTimestampUTC`):
 * those win; server-time text is only used when no epoch exists, converted with
 * the server offset the same payload reveals.
 */

/** Anything earlier is a "no time" placeholder (epoch 0, 0001-01-01, ...), never a real trade. */
export const MIN_BROKER_INSTANT_MS = Date.UTC(2000, 0, 1);

/** How far ahead of "now" a broker time may be before it counts as wrong (clock skew only). */
export const BROKER_CLOCK_SKEW_MS = 5 * 60 * 1000;

const MAX_SERVER_OFFSET_MS = 14 * 60 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;
const OFFSET_PAIR_TOLERANCE_MS = 60 * 1000;

/** `2026-10-11T14:35:22`, `2026.10.11 14:35`, `2026-10-11T14:35:22.123+03:00`, `2026-10-11`. */
const WALL_CLOCK =
  /^\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?\s*$/i;
const NUMERIC_TEXT = /^\d{9,16}(?:\.\d+)?$/;

interface WallClock {
  /** the written date and time read as if it were UTC */
  asUtcMs: number;
  /** offset written in the text (`Z` = 0), null when the text has none */
  zoneOffsetMs: number | null;
}

function parseWallClock(text: string): WallClock | null {
  const match = WALL_CLOCK.exec(text);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText = "0", minuteText = "0", secondText = "0", fractionText = "", zoneText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fractionText.slice(0, 3).padEnd(3, "0"));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;

  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const check = new Date(asUtcMs);
  if (Number.isNaN(check.getTime()) || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;

  let zoneOffsetMs: number | null = null;
  if (zoneText) {
    if (zoneText.toUpperCase() === "Z") {
      zoneOffsetMs = 0;
    } else {
      const sign = zoneText.startsWith("-") ? -1 : 1;
      const digits = zoneText.slice(1).replace(":", "");
      const zoneHours = Number(digits.slice(0, 2));
      const zoneMinutes = Number(digits.slice(2, 4) || "0");
      zoneOffsetMs = sign * (zoneHours * 60 + zoneMinutes) * 60 * 1000;
    }
  }
  return { asUtcMs, zoneOffsetMs };
}

/**
 * A UTC epoch in seconds or milliseconds (the bridge's `…TimestampUTC` fields,
 * also accepted as numeric text). Zero, negatives and pre-2000 values are
 * placeholders and give null.
 */
export function epochToMs(value: unknown): number | null {
  let number = Number.NaN;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && NUMERIC_TEXT.test(value.trim())) number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const ms = number > 100_000_000_000 ? number : number * 1000;
  return ms >= MIN_BROKER_INSTANT_MS ? ms : null;
}

/** True for wall-clock text that carries no zone: that is broker SERVER time. */
export function isServerTimeText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const wall = parseWallClock(value.trim());
  return wall !== null && wall.zoneOffsetMs === null;
}

/**
 * Instant (ms since epoch, UTC) of a broker time value. Text without a zone is
 * server time and is converted with `serverOffsetMs` (server clock minus UTC);
 * text with a zone, and epochs, are exact. Placeholders give null.
 */
export function brokerTimeToMs(value: unknown, serverOffsetMs = 0): number | null {
  if (typeof value === "number") return epochToMs(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (NUMERIC_TEXT.test(text)) return epochToMs(text);

  const wall = parseWallClock(text);
  if (wall) {
    const ms = wall.asUtcMs - (wall.zoneOffsetMs ?? serverOffsetMs);
    return ms >= MIN_BROKER_INSTANT_MS ? ms : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed >= MIN_BROKER_INSTANT_MS ? parsed : null;
}

export interface BrokerOrderClock {
  openTime?: unknown;
  closeTime?: unknown;
  openTimestampUTC?: unknown;
  closeTimestampUTC?: unknown;
}

/** Open and close instants of an order: the UTC epoch first, server-time text only as a fallback. */
export function orderTimesMs(
  order: BrokerOrderClock,
  serverOffsetMs = 0,
): { openedAtMs: number | null; closedAtMs: number | null } {
  return {
    openedAtMs: epochToMs(order.openTimestampUTC) ?? brokerTimeToMs(order.openTime, serverOffsetMs),
    closedAtMs: epochToMs(order.closeTimestampUTC) ?? brokerTimeToMs(order.closeTime, serverOffsetMs),
  };
}

/**
 * The server's offset from UTC, learned from orders in the same payload that
 * carry BOTH a server-time text and the UTC epoch of the same moment. Exact and
 * DST-aware because it comes from the broker's own data; null when no order has
 * both. The most frequent offset wins (rows around a DST switch can differ).
 */
export function estimateServerOffsetMs(orders: ReadonlyArray<BrokerOrderClock>): number | null {
  const counts = new Map<number, number>();
  for (const order of orders) {
    const pairs: Array<[unknown, unknown]> = [
      [order.openTimestampUTC, order.openTime],
      [order.closeTimestampUTC, order.closeTime],
    ];
    for (const [utcValue, serverValue] of pairs) {
      const utcMs = epochToMs(utcValue);
      if (utcMs === null || typeof serverValue !== "string") continue;
      const wall = parseWallClock(serverValue.trim());
      if (!wall || wall.zoneOffsetMs !== null) continue;
      const raw = wall.asUtcMs - utcMs;
      const rounded = Math.round(raw / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
      if (Math.abs(rounded) > MAX_SERVER_OFFSET_MS || Math.abs(raw - rounded) > OFFSET_PAIR_TOLERANCE_MS) continue;
      counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [offset, count] of counts) {
    if (count > bestCount) {
      best = offset;
      bestCount = count;
    }
  }
  return best;
}

/** The instant itself when it is not in the future (beyond clock skew), otherwise null. */
export function plausibleInstant(ms: number | null, now: number): number | null {
  return ms !== null && ms <= now + BROKER_CLOCK_SKEW_MS ? ms : null;
}

/**
 * `opened_at` / `closed_at` for a trade, always valid ISO text:
 * - the UTC epoch is used first, server-time text converted with `serverOffsetMs` second;
 * - placeholders (epoch 0, year 1) and instants in the future are ignored;
 * - a closed trade without a usable close time takes its open time (and the other
 *   way round) instead of "now", so a re-sync never moves the trade;
 * - only when nothing usable exists is "now" used.
 */
export function resolveOrderTimes(
  order: BrokerOrderClock,
  status: "OPEN" | "CLOSED",
  options: { serverOffsetMs?: number; now?: number } = {},
): { openedAt: string; closedAt: string | null } {
  const now = options.now ?? Date.now();
  const { openedAtMs, closedAtMs } = orderTimesMs(order, options.serverOffsetMs ?? 0);
  const opened = plausibleInstant(openedAtMs, now);
  const closed = status === "CLOSED" ? plausibleInstant(closedAtMs, now) : null;
  const openedAt = opened ?? closed ?? now;
  const closedAt = status === "CLOSED" ? (closed ?? opened ?? now) : null;
  return {
    openedAt: new Date(openedAt).toISOString(),
    closedAt: closedAt === null ? null : new Date(closedAt).toISOString(),
  };
}

/** ISO text of one broker instant (UTC epoch first), or undefined when there is no usable one. */
export function instantIso(
  utcValue: unknown,
  serverValue: unknown,
  options: { serverOffsetMs?: number; now?: number } = {},
): string | undefined {
  const now = options.now ?? Date.now();
  const ms = plausibleInstant(
    epochToMs(utcValue) ?? brokerTimeToMs(serverValue, options.serverOffsetMs ?? 0),
    now,
  );
  return ms === null ? undefined : new Date(ms).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Money fields of an order
// ─────────────────────────────────────────────────────────────────────────────

/** A finite number from a number or numeric text; 0 for anything else. */
function moneyField(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export interface BrokerOrderMoney {
  profit?: unknown;
  commission?: unknown;
  swap?: unknown;
  fee?: unknown;
}

/**
 * What a CLOSED order really did to the account balance: profit + commission +
 * swap (+ fee). MetaTrader reports them as separate signed fields (a charge is
 * negative) and the balance moves by their sum, so the bare `profit` overstated
 * every trade that paid commission or swap - and with it the cumulative closed
 * P&L, the win rate and every curve rebuilt from trades.
 */
export function orderNetProfit(order: BrokerOrderMoney): number {
  const net =
    moneyField(order.profit) + moneyField(order.commission) + moneyField(order.swap) + moneyField(order.fee);
  return Math.round(net * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deposits and withdrawals (balance operations)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deposit or a withdrawal found in the account history. They are not trades,
 * but they move the balance and the equity, so a growth curve that does not know
 * about them reads a deposit as profit and a withdrawal as a drawdown.
 */
export interface BrokerCashFlow {
  /** the ticket of the balance operation: the idempotency key */
  externalId: string;
  /** when it happened (epoch ms, UTC) */
  t: number;
  /** signed, in account currency: deposit > 0, withdrawal < 0 */
  amount: number;
  kind: "DEPOSIT" | "WITHDRAWAL";
  comment: string | null;
}

export interface BrokerCashFlowRow extends BrokerOrderClock {
  ticket?: unknown;
  id?: unknown;
  orderId?: unknown;
  positionId?: unknown;
  profit?: unknown;
  comment?: unknown;
  type?: unknown;
  orderType?: unknown;
  dealType?: unknown;
}

/** Kinds that are movements of the client's own money (credit, bonus, commission, interest... are not). */
const CASH_FLOW_KINDS = new Set(["balance", "deposit", "withdrawal"]);

/**
 * Deposits and withdrawals out of a raw history payload. The result is stable:
 * the same balance operation always has the same `externalId`, so storing it
 * again changes nothing.
 */
export function extractCashFlows(
  orders: ReadonlyArray<BrokerCashFlowRow>,
  options: { serverOffsetMs?: number; now?: number } = {},
): BrokerCashFlow[] {
  const now = options.now ?? Date.now();
  const found = new Map<string, BrokerCashFlow>();
  for (const order of orders) {
    if (!order || typeof order !== "object") continue;
    const isCashFlow = [order.dealType, order.orderType, order.type].some((kind) =>
      CASH_FLOW_KINDS.has(normalizeKind(kind)),
    );
    if (!isCashFlow) continue;

    const amount = Math.round(moneyField(order.profit) * 100) / 100;
    if (amount === 0) continue;

    const { openedAtMs, closedAtMs } = orderTimesMs(order, options.serverOffsetMs ?? 0);
    const t = plausibleInstant(closedAtMs ?? openedAtMs, now);
    if (t === null) continue;

    const ticket = [order.ticket, order.id, order.orderId, order.positionId]
      .map((value) => (value === undefined || value === null ? "" : String(value).trim()))
      .find((value) => value !== "");
    const externalId = `bal-${ticket ?? `${t}-${amount}`}`;
    const comment = typeof order.comment === "string" && order.comment.trim() ? order.comment.trim().slice(0, 120) : null;
    found.set(externalId, { externalId, t, amount, kind: amount > 0 ? "DEPOSIT" : "WITHDRAWAL", comment });
  }
  return [...found.values()].sort((left, right) => left.t - right.t);
}

/** Account operations that are in the history but are not trades. */
const NON_TRADE_KINDS = new Set([
  "balance",
  "credit",
  "charge",
  "correction",
  "bonus",
  "commission",
  "commissiondaily",
  "commissionmonthly",
  "commissionagent",
  "commissionagentdaily",
  "commissionagentmonthly",
  "interest",
  "interestrate",
  "tax",
  "dividend",
  "dividendfranked",
  "fee",
  "deposit",
  "withdrawal",
]);

function normalizeKind(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/^(deal|order)[_\s-]*type[_\s-]*/, "")
    .replace(/[^a-z]/g, "");
}

/**
 * False for deposits, withdrawals, credit, corrections, bonuses, commissions,
 * cancelled orders and other rows of the account history that are not trades
 * (a deposit would otherwise be counted as a winning trade of lot size 0).
 * A row without a symbol is only dropped when it also has no size and no entry
 * price - the shape of a balance operation - so a payload that names the symbol
 * differently does not lose its trades.
 */
export function isTradeRecord(order: {
  symbol?: unknown;
  type?: unknown;
  orderType?: unknown;
  dealType?: unknown;
  lots?: unknown;
  volume?: unknown;
  closeLots?: unknown;
  closeVolume?: unknown;
  openPrice?: unknown;
}): boolean {
  for (const kind of [order.dealType, order.orderType, order.type]) {
    const normalized = normalizeKind(kind);
    if (!normalized) continue;
    if (NON_TRADE_KINDS.has(normalized)) return false;
    if (normalized.endsWith("canceled") || normalized.endsWith("cancelled")) return false;
  }
  if (typeof order.symbol === "string" && order.symbol.trim()) return true;
  const hasSize = [order.lots, order.volume, order.closeLots, order.closeVolume].some((value) => Number(value) > 0);
  return hasSize || Number(order.openPrice) > 0;
}
