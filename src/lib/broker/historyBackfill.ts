if (typeof window !== "undefined") {
  throw new Error("[wsa] historyBackfill is server-only.");
}

import { isTradeRecord, orderTimesMs, type BrokerOrderClock } from "./orderNormalization";

/**
 * Deep order history for the performance charts.
 *
 * Why this exists: the closed-orders list the broker bridge hands over by itself
 * is short, and the only dated fallback asked for the last 30 days. An account
 * that is a year old therefore had a 30-day history on the platform, and every
 * longer period on the chart (3M, 6M, 1Y, All) was empty or an estimate. This
 * walks the dated order history backwards in windows - newest first, from the
 * oldest order already in hand - until the horizon is reached, the account has
 * nothing older, or the time budget of one sync is used up (the next sync then
 * continues where this one stopped).
 *
 * Pure: no I/O of its own. The caller supplies `fetchWindow`, so the logic is
 * unit tested without a broker. Shared by the web app and the AWS workers (no
 * Next / React imports).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Default horizon: a year back covers every chart period the platform offers except a longer "All". */
export const DEFAULT_BACKFILL_DAYS = 365;
export const MAX_BACKFILL_DAYS = 3650;
/** One dated request covers this much time. */
export const BACKFILL_WINDOW_DAYS = 90;
/** Neighbouring windows overlap by this much, so a trade at the border (server vs UTC clock) is never missed. */
export const BACKFILL_OVERLAP_MS = 2 * DAY_MS;
/** Windows without a single trade in a row after which an account that has traded before has nothing older. */
export const BACKFILL_EMPTY_WINDOWS_TO_STOP = 3;
/** A finished backfill is repeated this rarely; the normal sync keeps the recent history current. */
export const BACKFILL_REPEAT_MS = 7 * DAY_MS;
/** After a failed window the next attempt waits this long. */
export const BACKFILL_RETRY_MS = 10 * MINUTE_MS;

export type BackfillMode = "positions" | "orders";

/** What the backfill needs to know about an order: its clock fields and enough to tell a trade from a deposit. */
export type BackfillOrder = BrokerOrderClock & Parameters<typeof isTradeRecord>[0];

export interface BackfillState {
  /** oldest instant already covered; an unfinished backfill continues from here */
  reachedMs: number | null;
  complete: boolean;
  /** no new run before this instant */
  nextRunAt: number;
  /** the endpoint that answered with data, so the other one is not asked for every window */
  mode: BackfillMode | null;
}

export interface BackfillResult<T> {
  rows: T[];
  state: BackfillState;
  /** windows asked for in this run */
  windows: number;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** How many days back to go: `API2TRADE_HISTORY_BACKFILL_DAYS`, 0 switches it off. */
export function backfillDaysFromEnv(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BACKFILL_DAYS;
  return clampInt(parsed, 0, MAX_BACKFILL_DAYS);
}

/** Budget of one run in ms: `API2TRADE_HISTORY_BACKFILL_BUDGET_MS`, between 2 and 45 seconds. */
export function backfillBudgetFromEnv(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return clampInt(Number.isFinite(parsed) ? parsed : 12_000, 2_000, 45_000);
}

/** The oldest close time among the trades (not deposits and the like), or null. */
export function oldestCloseMs(orders: ReadonlyArray<BackfillOrder>): number | null {
  let oldest: number | null = null;
  for (const order of orders) {
    if (!isTradeRecord(order)) continue;
    const { closedAtMs } = orderTimesMs(order);
    if (closedAtMs !== null && (oldest === null || closedAtMs < oldest)) oldest = closedAtMs;
  }
  return oldest;
}

function orderKey(order: unknown): string {
  if (!order || typeof order !== "object") return "";
  const record = order as Record<string, unknown>;
  const id = [record.positionId, record.ticket, record.orderId, record.id]
    .map((value) => (value === undefined || value === null ? "" : String(value).trim()))
    .find((value) => value !== "");
  if (!id) return "";
  const closed = record.closeTimestampUTC ?? record.closeTime ?? "";
  const lots = record.lots ?? record.closeLots ?? record.volume ?? "";
  return `${id}|${String(closed)}|${String(lots)}`;
}

/**
 * `current` followed by the orders of `extra` it does not hold yet. Two
 * neighbouring windows overlap, so repeats inside `extra` are dropped too.
 * Orders that carry no id at all can not be told apart and are all kept.
 */
export function mergeBackfilledOrders<T>(current: ReadonlyArray<T>, extra: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  for (const order of current) {
    const key = orderKey(order);
    if (key) seen.add(key);
  }
  const merged: T[] = [...current];
  for (const order of extra) {
    const key = orderKey(order);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    merged.push(order);
  }
  return merged;
}

export function freshBackfillState(): BackfillState {
  return { reachedMs: null, complete: false, nextRunAt: 0, mode: null };
}

/**
 * Walks the history backwards. Returns the orders found in this run (to be merged
 * with `current`) and the state to keep for the next run.
 */
export async function backfillOrderHistory<T extends BackfillOrder>(input: {
  now: number;
  horizonDays: number;
  budgetMs: number;
  /** orders the normal sync already holds: the walk starts at the oldest of them */
  current: ReadonlyArray<T>;
  state: BackfillState | undefined;
  fetchWindow: (
    fromMs: number,
    toMs: number,
    mode: BackfillMode | null,
  ) => Promise<{ rows: T[]; mode: BackfillMode | null }>;
  /** injectable clock for the budget (tests) */
  clock?: () => number;
}): Promise<BackfillResult<T>> {
  const { now, horizonDays, current } = input;
  const state: BackfillState = { ...(input.state ?? freshBackfillState()) };
  const idle = (): BackfillResult<T> => ({ rows: [], state, windows: 0 });

  if (horizonDays <= 0) {
    state.complete = true;
    state.nextRunAt = now + BACKFILL_REPEAT_MS;
    return idle();
  }
  if (now < state.nextRunAt) return idle();

  const horizon = now - horizonDays * DAY_MS;
  const oldestInHand = oldestCloseMs(current);
  // An unfinished run continues where it stopped; a new one starts at the oldest order in hand.
  const resuming = !state.complete && state.reachedMs !== null;

  // The list the bridge hands over by itself may already reach the horizon.
  if (!resuming && oldestInHand !== null && oldestInHand <= horizon) {
    state.reachedMs = oldestInHand;
    state.complete = true;
    state.nextRunAt = now + BACKFILL_REPEAT_MS;
    return idle();
  }

  let cursor = resuming ? (state.reachedMs as number) : (oldestInHand ?? now);
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const collected: T[] = [];
  let emptyRun = 0;
  let seenTrade = oldestInHand !== null;
  let windows = 0;
  let failed = false;
  let complete = false;

  while (cursor > horizon) {
    if (windows > 0 && clock() - startedAt > input.budgetMs) break;
    const from = Math.max(horizon, cursor - BACKFILL_WINDOW_DAYS * DAY_MS);
    const to = Math.min(now, cursor + BACKFILL_OVERLAP_MS);
    let answer: { rows: T[]; mode: BackfillMode | null };
    try {
      answer = await input.fetchWindow(from, to, state.mode);
    } catch {
      failed = true;
      break;
    }
    windows += 1;
    state.mode = answer.mode ?? state.mode;
    collected.push(...answer.rows);
    if (answer.rows.some((row) => isTradeRecord(row))) {
      emptyRun = 0;
      seenTrade = true;
    } else {
      emptyRun += 1;
    }
    cursor = from;
    // An account that has traded and then shows nothing for a long stretch has nothing older.
    if (seenTrade && emptyRun >= BACKFILL_EMPTY_WINDOWS_TO_STOP) {
      complete = true;
      break;
    }
  }
  if (cursor <= horizon) complete = true;

  state.reachedMs = cursor;
  state.complete = complete;
  state.nextRunAt = failed ? now + BACKFILL_RETRY_MS : complete ? now + BACKFILL_REPEAT_MS : now;
  return { rows: mergeBackfilledOrders([], collected), state, windows };
}
