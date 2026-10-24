/**
 * Pure helpers for the account performance chart (Myfxbook-style).
 *
 * This module is shared by the server (`src/lib/services/performanceService.ts`)
 * and the browser (`src/components/charts/*`). It must stay free of React, Next,
 * Supabase and any I/O so it can be unit-tested and reused anywhere.
 *
 * Honesty rule: nothing in here invents data. Every returned point is either a
 * recorded broker snapshot, a closed trade, or an explicitly flagged estimate
 * (`estimated: true`) that is rebuilt from closed trades.
 */

export type PerformanceRange = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "ALL";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The time axis is never narrower than this. */
const MIN_SPAN_MS = 10 * 60 * 1000;

export const PERFORMANCE_RANGE_OPTIONS: ReadonlyArray<{
  id: PerformanceRange;
  label: string;
  ms: number | null;
}> = [
  { id: "1D", label: "1D", ms: DAY_MS },
  { id: "1W", label: "1W", ms: 7 * DAY_MS },
  { id: "1M", label: "1M", ms: 30 * DAY_MS },
  { id: "3M", label: "3M", ms: 90 * DAY_MS },
  { id: "6M", label: "6M", ms: 182 * DAY_MS },
  { id: "1Y", label: "1Y", ms: 365 * DAY_MS },
  { id: "ALL", label: "All", ms: null },
];

export function isPerformanceRange(value: unknown): value is PerformanceRange {
  return PERFORMANCE_RANGE_OPTIONS.some((option) => option.id === value);
}

/** Analytics page periods -> chart ranges. */
export function rangeForAnalyticsPeriod(
  period: "DAILY" | "WEEKLY" | "MONTHLY" | "ALL_TIME",
): PerformanceRange {
  if (period === "DAILY") return "1D";
  if (period === "WEEKLY") return "1W";
  if (period === "MONTHLY") return "1M";
  return "ALL";
}

// ─────────────────────────────────────────────────────────────────────────────
// DTO (what `/api/analytics/performance` returns)
// ─────────────────────────────────────────────────────────────────────────────

export interface PerformanceSample {
  /** epoch milliseconds */
  t: number;
  balance: number;
  equity: number;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  /** true = rebuilt from closed trades, not a recorded snapshot */
  estimated: boolean;
}

export interface PerformanceLedgerPoint {
  t: number;
  profit: number;
  volume: number;
  count: number;
  wins: number;
}

/** A deposit (> 0) or a withdrawal (< 0) of the account holder, in account currency. */
export interface PerformanceCashFlow {
  /** epoch milliseconds */
  t: number;
  amount: number;
  /**
   * `JOIN`: not a payment but an account that was connected to the platform while
   * the combined curve was running - its whole value appears in the sum at once.
   * It is taken out of growth and drawdown exactly like a deposit, and reported
   * separately.
   */
  kind?: "JOIN";
}

export interface PerformanceStats {
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  totalProfit: number;
  grossProfit: number;
  grossLoss: number;
  totalVolume: number;
  bestTrade: number | null;
  worstTrade: number | null;
}

export interface PerformanceCoverage {
  firstSnapshotAt: number | null;
  lastSnapshotAt: number | null;
  /** first / last instant the platform holds any data for (snapshot or closed trade) */
  firstDataAt: number | null;
  lastDataAt: number | null;
  /** recording stopped: the window ends at the last recorded data instead of "now" */
  stale: boolean;
  snapshotSamples: number;
  estimatedSamples: number;
  /** stretches without snapshots that were bridged with a flagged (dotted) estimate */
  gapCount: number;
  closedTrades: number;
  tradesTruncated: boolean;
  /** at least one returned sample carries margin data */
  marginCaptured: boolean;
  /** the database has the margin columns (migration 057) */
  marginSupported: boolean;
  mixedCurrencies: boolean;
  aggregate: boolean;
  /** aggregate (All accounts) curves are limited to this many days (only without migration 058) */
  aggregateLimitedToDays: number | null;
  /** all-time equity peak recorded by the platform for this account */
  equityPeak: number | null;
  /** deposits / withdrawals inside the window that growth and drawdown are adjusted for */
  cashFlowCount?: number;
  /** combined curve: accounts that were connected inside the window (their value is not performance) */
  accountJoinCount?: number;
  /** the database stores deposits / withdrawals (migration 059) */
  cashFlowsSupported?: boolean;
  /** stored readings that were left out because they are impossible (e.g. equity 0 with a positive balance) */
  glitchSamplesDropped?: number;
}

export interface PerformanceSeriesDto {
  accountId: string;
  currency: string | null;
  range: PerformanceRange;
  /** when the server built this response ("now"); `end` can be earlier when recording stopped */
  generatedAt: number;
  start: number;
  end: number;
  samples: PerformanceSample[];
  ledger: PerformanceLedgerPoint[];
  /** deposits / withdrawals inside the window, oldest first (absent = none known) */
  cashFlows?: PerformanceCashFlow[];
  stats: PerformanceStats;
  coverage: PerformanceCoverage;
}

export type TradeLite = { t: number; profit: number; volume: number };

// ─────────────────────────────────────────────────────────────────────────────
// Range / sampling helpers (server)
// ─────────────────────────────────────────────────────────────────────────────

export function rangeDurationMs(range: PerformanceRange): number | null {
  return PERFORMANCE_RANGE_OPTIONS.find((option) => option.id === range)?.ms ?? null;
}

/**
 * First instant shown on the chart.
 *
 * - A fixed range (1D ... 1Y) ALWAYS covers the period the person chose, counted
 *   back from the end of the window - whether the account is a week or five
 *   years old. Cutting the axis at the first data point (what this used to do)
 *   made 1M, 3M, 6M and 1Y look the same on a young account and the chosen
 *   period was not what the axis showed. The stretch before the account has any
 *   data stays on the axis and is marked as such (`historyStartFor`).
 * - "All" starts at the first data point we hold.
 */
export function resolveRangeStart(
  range: PerformanceRange,
  now: number,
  firstDataAt: number | null,
): number {
  const duration = rangeDurationMs(range);
  if (duration !== null) return now - duration;
  const start = firstDataAt !== null && firstDataAt < now ? firstDataAt : now - DAY_MS;
  // never collapse the time axis to a point
  return Math.min(start, now - MIN_SPAN_MS);
}

/**
 * First instant of [start, end] the account has data for: `start` itself when the
 * account is older than the window, or the first data point when the account is
 * younger than the period that was chosen (the time axis then has a stretch
 * before it with nothing to show - and nothing is drawn or invented there).
 */
export function historyStartFor(
  start: number,
  end: number,
  firstDataAt: number | null | undefined,
): number {
  if (typeof firstDataAt !== "number" || !Number.isFinite(firstDataAt)) return start;
  return Math.min(end, Math.max(start, firstDataAt));
}

/** Evenly spaced probe instants over [start, end] (inclusive, `count` >= 2). */
export function buildProbeTimes(start: number, end: number, count: number): number[] {
  const total = Math.max(2, Math.floor(count));
  if (!(end > start)) return [end];
  const step = (end - start) / (total - 1);
  return Array.from({ length: total }, (_, index) =>
    index === total - 1 ? end : Math.round(start + step * index),
  );
}

/** A recording older than this is "stale": the chart then ends at the last recorded data. */
export const PERFORMANCE_STALE_AFTER_MS = 15 * 60 * 1000;

/** Samples asked from the database in one round trip (migration 058). */
export const RPC_SAMPLE_POINTS = 480;
/** Samples when migration 058 is missing and every sample costs one query. */
export const PROBE_SAMPLE_POINTS = 240;

/** Gaps shorter than this are never reported, however dense the recording is. */
const GAP_FLOOR_MS = 15 * MINUTE_MS;

/**
 * The window the chart is calibrated to. A live account runs up to "now"; once
 * the recording stopped (risk worker off, broker disconnected) the window ends at
 * the last data instead, so the curve fills the chart and the date axis only
 * covers days the account really has data for. A fixed range is then counted
 * back from that last instant, so it always spans the period that was chosen.
 */
export function resolveWindow(input: {
  range: PerformanceRange;
  now: number;
  firstDataAt: number | null;
  lastDataAt: number | null;
  staleAfterMs?: number;
}): { start: number; end: number; stale: boolean } {
  const staleAfter = input.staleAfterMs ?? PERFORMANCE_STALE_AFTER_MS;
  const stale = input.lastDataAt !== null && input.now - input.lastDataAt > staleAfter;
  const end = stale && input.lastDataAt !== null ? input.lastDataAt : input.now;
  return { start: resolveRangeStart(input.range, end, input.firstDataAt), end, stale };
}

/**
 * How many samples to ask for over `spanMs`: about one per minute where the
 * span is short, never more than `cap`, never fewer than 48.
 */
export function sampleCountFor(spanMs: number, cap: number): number {
  const perMinute = Number.isFinite(spanMs) ? Math.round(spanMs / MINUTE_MS) : 0;
  return Math.max(2, Math.min(cap, Math.max(48, perMinute)));
}

function pickEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count || count < 2) return items.length <= count ? items : items.slice(0, count);
  const picked: T[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(items[Math.floor((index * (items.length - 1)) / (count - 1))]);
  }
  return picked;
}

/**
 * Extra instants to look the account up at: just before and shortly after a
 * trade closed. Balance only moves at those moments, so sampling both sides
 * draws the step where it really happened instead of a ramp between two grid
 * points. Every instant still returns a stored snapshot - nothing is invented.
 */
export function buildTradeProbeTimes(
  trades: ReadonlyArray<{ t: number }>,
  start: number,
  end: number,
  options: { maxTrades?: number; beforeMs?: number; afterMs?: number } = {},
): number[] {
  const maxTrades = Math.max(1, options.maxTrades ?? 120);
  const beforeMs = options.beforeMs ?? 2_000;
  const afterMs = options.afterMs ?? 90_000;
  const closes = trades
    .map((trade) => trade.t)
    .filter((time) => Number.isFinite(time) && time >= start && time <= end)
    .sort((left, right) => left - right);
  const chosen = pickEvenly(closes, maxTrades);
  const instants = new Set<number>();
  for (const time of chosen) {
    if (time - beforeMs >= start) instants.add(Math.round(time - beforeMs));
    if (time + afterMs <= end) instants.add(Math.round(time + afterMs));
  }
  return [...instants].sort((left, right) => left - right);
}

/**
 * Smallest silence between two neighbouring recorded samples that counts as a
 * recording gap. It scales with the usual spacing of the samples (three times
 * the median), so a sparse recording or a coarse grid is not mistaken for an
 * outage, and never goes below 15 minutes.
 */
export function gapThresholdMs(times: number[], fallbackStepMs: number): number {
  const sorted = times.filter((time) => Number.isFinite(time)).sort((left, right) => left - right);
  const deltas: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const delta = sorted[index] - sorted[index - 1];
    if (delta > 0) deltas.push(delta);
  }
  let typical = Math.max(0, fallbackStepMs);
  if (deltas.length >= 8) {
    deltas.sort((left, right) => left - right);
    typical = deltas[Math.floor(deltas.length / 2)];
  }
  return Math.max(GAP_FLOOR_MS, 3 * typical);
}

/** Sort ascending, drop non-finite rows, keep the last row for equal timestamps. */
export function normalizeSamples(samples: PerformanceSample[]): PerformanceSample[] {
  const valid = samples.filter(
    (sample) =>
      Number.isFinite(sample.t) &&
      Number.isFinite(sample.balance) &&
      Number.isFinite(sample.equity),
  );
  valid.sort((left, right) => left.t - right.t);
  const result: PerformanceSample[] = [];
  for (const sample of valid) {
    const previous = result[result.length - 1];
    if (previous && previous.t === sample.t) result[result.length - 1] = sample;
    else result.push(sample);
  }
  return result;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function summarizeTrades(trades: TradeLite[]): PerformanceStats {
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let totalVolume = 0;
  let best: number | null = null;
  let worst: number | null = null;
  for (const trade of trades) {
    if (trade.profit > 0) {
      wins += 1;
      grossProfit += trade.profit;
    } else if (trade.profit < 0) {
      losses += 1;
      grossLoss += trade.profit;
    }
    totalVolume += trade.volume;
    best = best === null ? trade.profit : Math.max(best, trade.profit);
    worst = worst === null ? trade.profit : Math.min(worst, trade.profit);
  }
  const tradeCount = trades.length;
  return {
    tradeCount,
    wins,
    losses,
    winRate: tradeCount > 0 ? round2((wins / tradeCount) * 100) : 0,
    totalProfit: round2(grossProfit + grossLoss),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    totalVolume: Math.round(totalVolume * 10_000) / 10_000,
    bestTrade: best === null ? null : round2(best),
    worstTrade: worst === null ? null : round2(worst),
  };
}

/** One ledger point per trade, or time buckets when there are too many trades. */
export function buildLedger(
  trades: TradeLite[],
  start: number,
  end: number,
  maxPoints = 400,
): PerformanceLedgerPoint[] {
  const sorted = [...trades]
    .filter((trade) => Number.isFinite(trade.t) && Number.isFinite(trade.profit))
    .sort((left, right) => left.t - right.t);
  if (sorted.length <= maxPoints) {
    return sorted.map((trade) => ({
      t: trade.t,
      profit: round2(trade.profit),
      volume: trade.volume,
      count: 1,
      wins: trade.profit > 0 ? 1 : 0,
    }));
  }
  const width = Math.max(1, (end - start) / maxPoints);
  const buckets = new Map<number, PerformanceLedgerPoint>();
  for (const trade of sorted) {
    const index = Math.min(maxPoints - 1, Math.max(0, Math.floor((trade.t - start) / width)));
    const bucket = buckets.get(index) ?? { t: trade.t, profit: 0, volume: 0, count: 0, wins: 0 };
    bucket.t = Math.max(bucket.t, trade.t);
    bucket.profit += trade.profit;
    bucket.volume += trade.volume;
    bucket.count += 1;
    if (trade.profit > 0) bucket.wins += 1;
    buckets.set(index, bucket);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bucket]) => ({
      ...bucket,
      profit: round2(bucket.profit),
      volume: Math.round(bucket.volume * 10_000) / 10_000,
    }));
}

/** One movement of the balance: a trade that closed or a deposit / withdrawal. */
interface BalanceStep {
  t: number;
  delta: number;
}

/** Valid deposits / withdrawals (finite, non-zero), oldest first. */
export function sortedFlows(flows: ReadonlyArray<PerformanceCashFlow> | undefined): PerformanceCashFlow[] {
  return (flows ?? [])
    .filter((flow) => Number.isFinite(flow.t) && Number.isFinite(flow.amount) && flow.amount !== 0)
    .sort((left, right) => left.t - right.t);
}

/**
 * The deposits / withdrawals the chart needs: those between `from` and `to`.
 * When there are more than `max` of them (a combined curve over many accounts)
 * they are merged per stretch between two samples - growth and drawdown only
 * need the sum per stretch, so nothing is lost and the response stays small.
 */
export function cashFlowsForWindow(
  flows: ReadonlyArray<PerformanceCashFlow>,
  samples: ReadonlyArray<{ t: number }>,
  from: number,
  to: number,
  max = 600,
): PerformanceCashFlow[] {
  const inside = sortedFlows(flows).filter((flow) => flow.t >= from && flow.t <= to);
  if (inside.length <= max) return inside;

  const times = samples.map((sample) => sample.t).sort((left, right) => left - right);
  const merged = new Map<number, number>();
  for (const flow of inside) {
    // first sample at or after the flow: the stretch the money moved in
    let low = 0;
    let high = times.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (times[mid] < flow.t) low = mid + 1;
      else high = mid;
    }
    if (low >= times.length) continue; // after the last reading: no reading to adjust
    merged.set(times[low], (merged.get(times[low]) ?? 0) + flow.amount);
  }
  return [...merged.entries()]
    .map(([t, amount]) => ({ t, amount: round2(amount) }))
    .filter((flow) => flow.amount !== 0)
    .sort((left, right) => left.t - right.t);
}

/** Trades and cash flows as one list of balance movements, oldest first (a flow before a trade at the same instant). */
function balanceSteps(trades: ReadonlyArray<TradeLite>, flows: ReadonlyArray<PerformanceCashFlow>): BalanceStep[] {
  return [
    ...flows.map((flow): BalanceStep & { order: number } => ({ t: flow.t, delta: flow.amount, order: 0 })),
    ...trades.map((trade): BalanceStep & { order: number } => ({ t: trade.t, delta: trade.profit, order: 1 })),
  ]
    .sort((left, right) => left.t - right.t || left.order - right.order)
    .map(({ t, delta }) => ({ t, delta }));
}

/**
 * Rebuilds the balance curve from closed trades (and the deposits / withdrawals
 * the platform knows) when no snapshot exists for part of the window. Balance
 * only changes when a trade closes or when money is paid in or out, so this is
 * an *estimate* and every returned sample is flagged `estimated: true`.
 *
 * - With an anchor (earliest real snapshot): walk BACKWARDS from the anchor
 *   balance through the trades and cash flows that came before it.
 * - Without an anchor: walk FORWARDS from the account's starting balance - the
 *   deposits recorded up to the window start when there are any, otherwise the
 *   account's initial balance - but only when the window covers the whole
 *   history (`allHistory`).
 *
 * An estimate that would need a balance of zero or less is not drawn: the
 * history it was built from is incomplete (typically a withdrawal that is not
 * recorded), and a curve through zero would be worse than none.
 *
 * The estimate never reaches back before `historyStart` (the first instant the
 * platform holds any data for). A window that is wider than the account's
 * history - 1Y chosen on an account that is a month old - gets its estimate from
 * the first known event on, not a flat line through the time before it.
 */
export function reconstructEstimatedSamples(input: {
  start: number;
  end: number;
  anchor: { t: number; balance: number } | null;
  initialBalance: number | null;
  trades: TradeLite[];
  allHistory: boolean;
  maxPoints?: number;
  /** every deposit / withdrawal the platform knows up to `end` (also those before `start`) */
  flows?: ReadonlyArray<PerformanceCashFlow>;
  /** first instant with any data; nothing is estimated before it (default: `start`) */
  historyStart?: number | null;
}): PerformanceSample[] {
  const { start, end, anchor, initialBalance, allHistory } = input;
  const maxPoints = input.maxPoints ?? 200;
  const trades = [...input.trades]
    .filter((trade) => Number.isFinite(trade.t) && Number.isFinite(trade.profit))
    .sort((left, right) => left.t - right.t);
  const flows = sortedFlows(input.flows);
  // Where the estimate begins: the window start, or the first data when that is later.
  // Its opening point sits one millisecond before it so the first step is drawn as a step.
  const origin = historyStartFor(start, end, input.historyStart);
  const openingT = origin > start ? Math.max(start, origin - 1) : start;

  const make = (t: number, balance: number): PerformanceSample => ({
    t,
    balance: round2(balance),
    equity: round2(balance),
    margin: null,
    freeMargin: null,
    marginLevel: null,
    estimated: true,
  });

  let points: PerformanceSample[] = [];

  if (anchor) {
    const before = balanceSteps(
      trades.filter((trade) => trade.t >= origin && trade.t < anchor.t),
      flows.filter((flow) => flow.t >= origin && flow.t < anchor.t),
    );
    if (before.length === 0 || !(anchor.t > origin)) return [];
    const total = before.reduce((sum, step) => sum + step.delta, 0);
    let running = anchor.balance - total;
    points.push(make(openingT, running));
    for (const step of before) {
      running += step.delta;
      points.push(make(step.t, running));
    }
  } else {
    if (!allHistory) return [];
    let startBalance = initialBalance !== null && initialBalance > 0 ? initialBalance : null;
    let eventFlows = flows;
    // The deposits made before the first data are the balance the history starts with.
    if (flows.length > 0 && flows[0].t <= origin) {
      const seed = flows.filter((flow) => flow.t <= origin).reduce((sum, flow) => sum + flow.amount, 0);
      if (seed > 0) {
        startBalance = seed;
        eventFlows = flows.filter((flow) => flow.t > origin);
      }
    }
    if (startBalance === null) return [];
    const steps = balanceSteps(
      trades.filter((trade) => trade.t >= origin && trade.t <= end),
      eventFlows.filter((flow) => flow.t <= end),
    );
    if (steps.length === 0) return [];
    let running = startBalance;
    points.push(make(openingT, running));
    for (const step of steps) {
      running += step.delta;
      points.push(make(step.t, running));
    }
    const last = points[points.length - 1];
    if (last.t < end) points.push(make(end, running));
  }

  if (points.some((point) => !(point.balance > 0))) return [];

  if (points.length > maxPoints) {
    // buckets are counted from where the estimate begins, so a young account in a wide window keeps its detail
    const width = Math.max(1, (end - origin) / maxPoints);
    const byBucket = new Map<number, PerformanceSample>();
    for (const point of points) {
      byBucket.set(Math.floor((point.t - origin) / width), point);
    }
    const first = points[0];
    const last = points[points.length - 1];
    points = [...byBucket.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, point]) => point);
    if (points[0].t !== first.t) points.unshift(first);
    if (points[points.length - 1].t !== last.t) points.push(last);
  }
  return normalizeSamples(points);
}

/**
 * Bridges a recording gap (risk worker stopped, broker disconnected) between
 * two recorded samples with flagged estimates instead of letting the chart draw
 * one solid straight line across unknown time.
 *
 * - The gap starts with a held copy of the last recorded value (1 ms later), so
 *   the join with the next recorded sample is always drawn dotted.
 * - Closed trades and deposits / withdrawals inside the gap move the balance in
 *   steps (a point just before and one at the event); the last known floating
 *   P&L is carried along.
 * - The next recorded sample is NOT forced to match: any difference (swaps,
 *   open trades, money movements the platform does not know) shows up as a
 *   visible jump there.
 *
 * Returns only the estimated samples to add; recorded ones are never changed.
 */
export function fillSnapshotGaps(input: {
  samples: PerformanceSample[];
  trades: TradeLite[];
  gapMs: number;
  maxPointsPerGap?: number;
  flows?: ReadonlyArray<PerformanceCashFlow>;
}): { samples: PerformanceSample[]; gapCount: number } {
  const recorded = input.samples
    .filter((sample) => !sample.estimated)
    .sort((left, right) => left.t - right.t);
  const trades = input.trades
    .filter((trade) => Number.isFinite(trade.t) && Number.isFinite(trade.profit))
    .sort((left, right) => left.t - right.t);
  const steps = balanceSteps(trades, sortedFlows(input.flows));
  const maxPoints = Math.max(4, input.maxPointsPerGap ?? 60);
  const added: PerformanceSample[] = [];
  let gapCount = 0;

  for (let index = 1; index < recorded.length; index += 1) {
    const before = recorded[index - 1];
    const after = recorded[index];
    if (!(after.t - before.t > input.gapMs)) continue;
    gapCount += 1;

    const floating = before.equity - before.balance;
    const make = (t: number, balance: number): PerformanceSample => ({
      t,
      balance: round2(balance),
      equity: round2(balance + floating),
      margin: null,
      freeMargin: null,
      marginLevel: null,
      estimated: true,
    });

    added.push(make(before.t + 1, before.balance));

    const inside = steps.filter((step) => step.t > before.t + 1 && step.t < after.t);
    const stairs = inside.length * 2 <= maxPoints;
    let stepSamples: PerformanceSample[] = [];
    let running = before.balance;
    let lastT = before.t + 1;
    for (const step of inside) {
      if (stairs && step.t - 1 > lastT) {
        stepSamples.push(make(step.t - 1, running));
        lastT = step.t - 1;
      }
      running += step.delta;
      if (step.t > lastT) {
        stepSamples.push(make(step.t, running));
        lastT = step.t;
      } else if (stepSamples.length > 0) {
        // events at the same instant: fold into the previous step
        stepSamples[stepSamples.length - 1] = make(stepSamples[stepSamples.length - 1].t, running);
      }
    }
    if (stepSamples.length > maxPoints) {
      const every = Math.ceil(stepSamples.length / maxPoints);
      stepSamples = stepSamples.filter(
        (_, position) => position % every === every - 1 || position === stepSamples.length - 1,
      );
    }
    added.push(...stepSamples);
  }

  return { samples: added, gapCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Readings that can not be real
// ─────────────────────────────────────────────────────────────────────────────

/** A balance that differs this much from two agreeing neighbours is a glitch... */
const GLITCH_JUMP = 0.2;
/** ...when those neighbours agree within this much. */
const GLITCH_AGREE = 0.08;

function relativeGap(left: number, right: number): number {
  const base = Math.max(Math.abs(left), Math.abs(right));
  return base > 0 ? Math.abs(left - right) / base : 0;
}

/**
 * Leaves out stored readings that can not be real, so one bad row does not draw
 * a crash to zero through the whole curve:
 *  - equity of zero (or less) next to a positive balance - the answer of a
 *    half-loaded broker session; with a positive balance it can not happen;
 *  - a balance that falls (or jumps) by more than 20 % for exactly one reading
 *    while its two neighbours agree with each other. A real deposit or
 *    withdrawal is a step that stays; a floating loss moves the equity, not the
 *    balance - so neither is touched.
 * Needs the samples sorted by time. Returns what was kept and how many were left out.
 */
export function dropGlitchSamples<T extends { balance: number; equity: number }>(
  samples: ReadonlyArray<T>,
): { kept: T[]; dropped: number } {
  const count = samples.length;
  if (count < 2) return { kept: [...samples], dropped: 0 };

  const kept: T[] = [];
  let dropped = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = samples[index];
    const left = index > 0 ? samples[index - 1] : null;
    const right = index < count - 1 ? samples[index + 1] : null;

    const impossibleEquity =
      sample.balance > 0 &&
      sample.equity <= 0 &&
      ((left !== null && left.equity > 0) || (right !== null && right.equity > 0));

    const isolatedBalance =
      left !== null &&
      right !== null &&
      left.balance > 0 &&
      right.balance > 0 &&
      relativeGap(left.balance, right.balance) <= GLITCH_AGREE &&
      relativeGap(sample.balance, (left.balance + right.balance) / 2) > GLITCH_JUMP;

    if (impossibleEquity || isolatedBalance) {
      dropped += 1;
      continue;
    }
    kept.push(sample);
  }
  return { kept, dropped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived series (browser + tests)
// ─────────────────────────────────────────────────────────────────────────────

export interface DerivedPoint {
  t: number;
  balance: number;
  equity: number;
  floating: number;
  /** equity change vs the first point of the window, in % */
  equityGrowth: number;
  /** balance change vs the first point of the window, in % */
  balanceGrowth: number;
  /** drawdown vs the running equity peak inside the window, in % (>= 0) */
  drawdown: number;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  estimated: boolean;
}

export interface PnlPoint {
  t: number;
  /** cumulative closed P&L inside the window (money) */
  cum: number;
  /** same, as % of the growth base */
  growth: number;
}

export interface DerivedSeries {
  start: number;
  end: number;
  /**
   * First instant of [start, end] the account has data for. It is `start` for an
   * account older than the window; a younger account (1Y chosen on a month-old
   * account) has a stretch before it that the chart marks as "no data".
   */
  historyStart: number;
  base: number | null;
  /**
   * What closed P&L is expressed against: the first balance, plus the accounts
   * connected later in a combined curve. Equal to `base` for one account.
   */
  pnlBase: number | null;
  points: DerivedPoint[];
  pnl: PnlPoint[];
  latest: DerivedPoint | null;
  closedPnl: number;
  equityGrowthPct: number;
  balanceGrowthPct: number;
  pnlGrowthPct: number;
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  hasMargin: boolean;
  hasEstimated: boolean;
  /** deposits / withdrawals inside the window that growth and drawdown are adjusted for */
  cashFlowCount: number;
  /** their sum: money paid in minus money taken out */
  netCashFlow: number;
  /** combined curve: accounts connected inside the window, and the value they brought along */
  joinedAccounts: number;
  joinedAmount: number;
}

/**
 * Factor by which an account value grew between two readings once the money
 * paid in or out in between is taken out of the later reading:
 * (value - flow) / previous. 1 when the previous reading can not serve as a base.
 */
function growthFactor(previous: number, value: number, flow: number): number {
  if (!(previous > 0)) return 1;
  const factor = (value - flow) / previous;
  return factor > 0 ? factor : 0;
}

export function deriveSeries(dto: PerformanceSeriesDto): DerivedSeries {
  const samples = normalizeSamples(dto.samples);
  const first = samples[0] ?? null;
  const base = first
    ? first.balance > 0
      ? first.balance
      : first.equity > 0
        ? first.equity
        : null
    : null;

  // Money paid in or out is not performance. Growth and drawdown are therefore
  // chained from reading to reading with the flow in between taken out (a
  // time-weighted return, the way Myfxbook's "Gain" works); without any known
  // flow this is exactly value / first value - 1.
  const flows = sortedFlows(dto.cashFlows);
  let flowCursor = 0;
  const firstT = first?.t ?? 0;
  while (flowCursor < flows.length && flows[flowCursor].t <= firstT) flowCursor += 1;
  const lastT = samples.length > 0 ? samples[samples.length - 1].t : 0;
  let cashFlowCount = 0;
  let netCashFlow = 0;
  let joinedAccounts = 0;
  let joinedAmount = 0;

  let equityIndex = 1;
  let balanceIndex = 1;
  let peakIndex = 1;
  let maxDrawdown = 0;
  const points: DerivedPoint[] = samples.map((sample, position) => {
    if (position > 0) {
      const previous = samples[position - 1];
      let flow = 0;
      while (flowCursor < flows.length && flows[flowCursor].t <= sample.t) {
        const entry = flows[flowCursor];
        flow += entry.amount;
        if (entry.t <= lastT) {
          if (entry.kind === "JOIN") {
            joinedAccounts += 1;
            joinedAmount += entry.amount;
          } else {
            cashFlowCount += 1;
            netCashFlow += entry.amount;
          }
        }
        flowCursor += 1;
      }
      equityIndex *= growthFactor(previous.equity, sample.equity, flow);
      balanceIndex *= growthFactor(previous.balance, sample.balance, flow);
    }
    peakIndex = Math.max(peakIndex, equityIndex);
    const drawdown = peakIndex > 0 ? Math.max(0, ((peakIndex - equityIndex) / peakIndex) * 100) : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    return {
      t: sample.t,
      balance: sample.balance,
      equity: sample.equity,
      floating: round2(sample.equity - sample.balance),
      equityGrowth: (equityIndex - 1) * 100,
      balanceGrowth: (balanceIndex - 1) * 100,
      drawdown,
      margin: sample.margin,
      freeMargin: sample.freeMargin,
      marginLevel: sample.marginLevel,
      estimated: sample.estimated,
    };
  });

  // Closed P&L is measured against the first balance - plus the accounts that were
  // connected later in a combined curve, so their profit is not divided by the
  // smaller account the curve started with.
  const pnlBase = base !== null ? base + joinedAmount : null;

  // The P&L line begins where the account's history begins: a window wider than
  // that history does not get a flat zero line through the time before it.
  const historyStart = historyStartFor(dto.start, dto.end, dto.coverage?.firstDataAt);
  const pnl: PnlPoint[] = [{ t: historyStart, cum: 0, growth: 0 }];
  let cumulative = 0;
  for (const entry of [...dto.ledger].sort((left, right) => left.t - right.t)) {
    if (!Number.isFinite(entry.t) || !Number.isFinite(entry.profit)) continue;
    cumulative = round2(cumulative + entry.profit);
    pnl.push({
      t: Math.max(entry.t, historyStart),
      cum: cumulative,
      growth: pnlBase ? (cumulative / pnlBase) * 100 : 0,
    });
  }
  const lastPnl = pnl[pnl.length - 1];
  if (lastPnl.t < dto.end) {
    pnl.push({ t: dto.end, cum: lastPnl.cum, growth: lastPnl.growth });
  }

  const latest = points[points.length - 1] ?? null;
  return {
    start: dto.start,
    end: dto.end,
    historyStart,
    base,
    pnlBase,
    points,
    pnl,
    latest,
    closedPnl: cumulative,
    equityGrowthPct: latest?.equityGrowth ?? 0,
    balanceGrowthPct: latest?.balanceGrowth ?? 0,
    pnlGrowthPct: pnlBase ? (cumulative / pnlBase) * 100 : 0,
    maxDrawdownPct: maxDrawdown,
    currentDrawdownPct: latest?.drawdown ?? 0,
    hasMargin: points.some(
      (point) => point.margin !== null || point.freeMargin !== null || point.marginLevel !== null,
    ),
    hasEstimated: points.some((point) => point.estimated),
    cashFlowCount,
    netCashFlow: round2(netCashFlow),
    joinedAccounts,
    joinedAmount: round2(joinedAmount),
  };
}

/**
 * The curve reaches "now". While the recording is live and the account's current equity is known, one more point at the
 * end of the axis carries it: the line then ends where the account is (not at the last stored snapshot, up to a quarter
 * of an hour ago) and moves as the equity does. Growth is continued from the last point - a reading seconds after a
 * snapshot has no deposit in between that anyone could know of - and drawdown against the highest point so far.
 *
 * Nothing is added (the very same series is returned) when the recording is stale (a chart ends at the last stored
 * data), when there is no point to continue from, when the reading is not a usable number, or when it is so far from the
 * last snapshot (more than a halving or a doubling) that it can only be a different account value, not a move.
 */
export function withLiveEquity(
  derived: DerivedSeries,
  liveEquity: number | null | undefined,
  stale: boolean,
): DerivedSeries {
  const last = derived.latest;
  if (stale || !last || typeof liveEquity !== "number" || !Number.isFinite(liveEquity) || !(liveEquity > 0)) return derived;
  if (!(last.equity > 0)) return derived;
  const ratio = liveEquity / last.equity;
  if (!(ratio > 0.5 && ratio < 2)) return derived;

  const index = (1 + last.equityGrowth / 100) * ratio;
  let peak = Math.max(1, index);
  for (const point of derived.points) peak = Math.max(peak, 1 + point.equityGrowth / 100);
  const drawdown = peak > 0 ? Math.max(0, ((peak - index) / peak) * 100) : 0;

  // a reading within a second of the last snapshot replaces it instead of standing next to it
  const replaces = derived.end - last.t < 1_000;
  const tail: DerivedPoint = {
    ...last,
    t: replaces ? last.t : derived.end,
    equity: liveEquity,
    floating: round2(liveEquity - last.balance),
    equityGrowth: (index - 1) * 100,
    drawdown,
    // (margin figures are only ever the recorded ones: the margin curve ends at the last snapshot)
    margin: replaces ? last.margin : null,
    freeMargin: replaces ? last.freeMargin : null,
    marginLevel: replaces ? last.marginLevel : null,
    estimated: false,
  };
  return {
    ...derived,
    points: replaces ? [...derived.points.slice(0, -1), tail] : [...derived.points, tail],
    latest: tail,
    equityGrowthPct: tail.equityGrowth,
    currentDrawdownPct: drawdown,
    maxDrawdownPct: Math.max(derived.maxDrawdownPct, drawdown),
  };
}

/** Index of the sample whose time is closest to `t` (times must be ascending). */
export function nearestIndexByTime(times: number[], t: number): number {
  if (times.length === 0) return -1;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (times[mid] < t) low = mid + 1;
    else high = mid;
  }
  if (low > 0 && Math.abs(times[low - 1] - t) <= Math.abs(times[low] - t)) return low - 1;
  return low;
}

/** Last index whose time is <= `t`, or -1. */
export function lastIndexAtOrBefore(times: number[], t: number): number {
  let low = 0;
  let high = times.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export interface LedgerBar {
  t: number;
  volume: number;
  profit: number;
}

/** Groups ledger points into at most `barCount` equal-width time buckets. */
export function bucketLedgerForBars(
  ledger: PerformanceLedgerPoint[],
  start: number,
  end: number,
  barCount: number,
): LedgerBar[] {
  const count = Math.max(1, Math.floor(barCount));
  const width = Math.max(1, (end - start) / count);
  const buckets = new Map<number, LedgerBar>();
  for (const entry of ledger) {
    if (!(entry.t >= start && entry.t <= end)) continue;
    const index = Math.min(count - 1, Math.max(0, Math.floor((entry.t - start) / width)));
    const bar = buckets.get(index) ?? { t: start + width * (index + 0.5), volume: 0, profit: 0 };
    bar.volume += entry.volume;
    bar.profit += entry.profit;
    buckets.set(index, bar);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bar]) => ({ ...bar, profit: round2(bar.profit) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scales and ticks
// ─────────────────────────────────────────────────────────────────────────────

export interface NiceScale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

function niceStep(rawStep: number): number {
  if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const fraction = rawStep / 10 ** exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

/** Fraction digits needed to print `step` exactly (steps are 1/2/2.5/5 x 10^n). */
export function decimalsForStep(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  for (let digits = 0; digits <= 8; digits += 1) {
    const scaled = step * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-7) return digits;
  }
  return 8;
}

/**
 * "Nice" axis for [min, max]: round tick values (1, 2, 2.5, 5 x 10^n), always
 * covering the data. `minSpan` keeps flat series from collapsing to a point.
 */
export function niceScale(
  min: number,
  max: number,
  options: { targetTicks?: number; minSpan?: number; includeZero?: boolean } = {},
): NiceScale {
  const targetTicks = Math.max(2, options.targetTicks ?? 5);
  let low = Number.isFinite(min) ? min : 0;
  let high = Number.isFinite(max) ? max : 0;
  if (options.includeZero) {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }
  if (low > high) [low, high] = [high, low];
  const minSpan = options.minSpan ?? 1;
  if (high - low < minSpan) {
    const middle = (high + low) / 2;
    low = middle - minSpan / 2;
    high = middle + minSpan / 2;
    if (options.includeZero) {
      low = Math.min(low, 0);
      high = Math.max(high, 0);
    }
  }
  const step = niceStep((high - low) / (targetTicks - 1));
  const decimals = decimalsForStep(step);
  const niceMin = Math.floor(low / step + 1e-9) * step;
  const niceMax = Math.ceil(high / step - 1e-9) * step;
  const ticks: number[] = [];
  const count = Math.round((niceMax - niceMin) / step);
  for (let index = 0; index <= count && index < 40; index += 1) {
    ticks.push(Number((niceMin + step * index).toFixed(decimals)));
  }
  return {
    min: Number(niceMin.toFixed(decimals)),
    max: Number(niceMax.toFixed(decimals)),
    step,
    ticks,
  };
}

const TIME_STEPS_MS = [
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  7 * DAY_MS,
  14 * DAY_MS,
];

/** Calendar-aligned tick times (local time) for a time axis. */
export function timeTicks(start: number, end: number, maxTicks = 6): number[] {
  if (!(end > start)) return [start];
  const span = end - start;
  const limit = Math.max(2, maxTicks);

  // Month based steps for long spans.
  if (span / (14 * DAY_MS) > limit) {
    const monthSteps = [1, 2, 3, 6, 12, 24];
    const monthSpan = span / (30.4375 * DAY_MS);
    const stepMonths = monthSteps.find((candidate) => monthSpan / candidate <= limit) ?? 24;
    const cursor = new Date(start);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
    // align month index to the step
    cursor.setMonth(Math.floor(cursor.getMonth() / stepMonths) * stepMonths);
    const ticks: number[] = [];
    for (let guard = 0; guard < 80; guard += 1) {
      const time = cursor.getTime();
      if (time > end) break;
      if (time >= start) ticks.push(time);
      cursor.setMonth(cursor.getMonth() + stepMonths);
    }
    return ticks;
  }

  const step = TIME_STEPS_MS.find((candidate) => span / candidate <= limit) ?? 14 * DAY_MS;
  const ticks: number[] = [];
  if (step >= DAY_MS) {
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    const dayStep = Math.round(step / DAY_MS);
    // multi-day steps are aligned to local epoch days so ticks stay stable
    if (dayStep > 1) {
      const localEpochDay = Math.floor(
        (cursor.getTime() - cursor.getTimezoneOffset() * MINUTE_MS) / DAY_MS,
      );
      cursor.setDate(cursor.getDate() - (localEpochDay % dayStep));
    }
    for (let guard = 0; guard < 200; guard += 1) {
      const time = cursor.getTime();
      if (time > end) break;
      if (time >= start) ticks.push(time);
      cursor.setDate(cursor.getDate() + dayStep);
    }
    return ticks;
  }
  const offset = new Date(start).getTimezoneOffset() * MINUTE_MS;
  let time = Math.ceil((start - offset) / step) * step + offset;
  for (let guard = 0; guard < 200 && time <= end; guard += 1) {
    ticks.push(time);
    time += step;
  }
  return ticks;
}

/** Axis label for a tick, given the whole visible span. */
export function formatTimeTick(time: number, spanMs: number): string {
  const date = new Date(time);
  if (spanMs <= 2 * DAY_MS) {
    // A tick at local midnight carries the date, so a view that crosses days is
    // never a row of bare hours.
    if (spanMs > 6 * HOUR_MS && date.getHours() === 0 && date.getMinutes() === 0) {
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (spanMs <= 120 * DAY_MS) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  // "Oct ’26": a bare "Oct 26" would read as the 26th of October
  const month = date.toLocaleDateString("en-US", { month: "short" });
  return `${month} ’${String(date.getFullYear()).slice(-2)}`;
}

export interface TimeAxisLabel {
  time: number;
  /** the tick's own label: a clock time, a day or a month */
  label: string;
  /** a second, smaller line that says which day / year the label is in (null = not needed) */
  sub: string | null;
}

/**
 * Labels for a time axis, two lines where one is ambiguous: a row of bare clock
 * times says its date under the first tick and wherever the day changes, a row
 * of days says its year under the first tick and wherever the year changes. A
 * period of more than four months carries the year in every label already.
 */
export function timeAxisLabels(ticks: number[], spanMs: number): TimeAxisLabel[] {
  let previous: Date | null = null;
  return ticks.map((time) => {
    const date = new Date(time);
    let sub: string | null = null;
    if (spanMs <= 2 * DAY_MS) {
      const labelIsDate = spanMs > 6 * HOUR_MS && date.getHours() === 0 && date.getMinutes() === 0;
      const dayChanged = previous === null || previous.toDateString() !== date.toDateString();
      if (!labelIsDate && dayChanged) {
        sub = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      }
    } else if (spanMs <= 120 * DAY_MS) {
      if (previous === null || previous.getFullYear() !== date.getFullYear()) {
        sub = String(date.getFullYear());
      }
    }
    previous = date;
    return { time, label: formatTimeTick(time, spanMs), sub };
  });
}

/** Full timestamp for tooltips. */
export function formatTooltipTime(time: number): string {
  return new Date(time).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Number formatting for axes and tooltips
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fraction digits a money label needs on an axis whose ticks are `step` apart:
 * none from 10 up, otherwise the digits the step really has (2.5 -> 1, 0.25 -> 2)
 * so "$2.50" is never printed as "$3".
 */
function moneyDigitsForStep(step: number): number {
  if (!(step > 0) || !Number.isFinite(step) || step >= 10) return 0;
  return Math.min(2, decimalsForStep(step));
}

export function formatAxisMoney(value: number, currency: string, step: number): string {
  const normalized = Math.round(value * 100) === 0 ? 0 : value;
  const compact = Math.abs(normalized) >= 10_000 && step >= 500;
  const digits = compact || normalized === 0 ? 0 : moneyDigitsForStep(step);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    minimumFractionDigits: digits,
    maximumFractionDigits: compact ? 1 : digits,
  }).format(normalized);
}

export function formatAxisPercent(value: number, step: number): string {
  if (Math.abs(value) < 1e-9) return "0%";
  const decimals = Math.min(3, decimalsForStep(step));
  return `${value.toFixed(decimals)}%`;
}

export function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.005) return "0.00%";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}
