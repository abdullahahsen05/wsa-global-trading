import { describe, expect, test } from "vitest";
import {
  BACKFILL_EMPTY_WINDOWS_TO_STOP,
  BACKFILL_OVERLAP_MS,
  BACKFILL_REPEAT_MS,
  BACKFILL_RETRY_MS,
  BACKFILL_WINDOW_DAYS,
  DEFAULT_BACKFILL_DAYS,
  MAX_BACKFILL_DAYS,
  backfillBudgetFromEnv,
  backfillDaysFromEnv,
  backfillOrderHistory,
  freshBackfillState,
  mergeBackfilledOrders,
  oldestCloseMs,
  type BackfillMode,
  type BackfillState,
} from "@/lib/broker/historyBackfill";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const HORIZON = NOW - DEFAULT_BACKFILL_DAYS * DAY;

type Order = { ticket: number; symbol?: string; type?: string; lots?: number; closeTimestampUTC?: number };

/** A closed trade; the bridge's UTC close time is in epoch seconds. */
const trade = (ticket: number, closedAt: number, lots = 0.1): Order => ({
  ticket,
  symbol: "EURUSD",
  lots,
  closeTimestampUTC: Math.floor(closedAt / 1000),
});

/** A deposit: a row of the account history that is not a trade. */
const deposit = (ticket: number, at: number): Order => ({
  ticket,
  type: "Balance",
  closeTimestampUTC: Math.floor(at / 1000),
});

type Call = { from: number; to: number; mode: BackfillMode | null };

/** A broker stand-in that answers every window with the rows `answer` builds and remembers what it was asked. */
function fakeBroker(
  answer: (call: Call, index: number) => Order[] | Error,
  mode: BackfillMode | null = "positions",
) {
  const calls: Call[] = [];
  const fetchWindow = async (from: number, to: number, asked: BackfillMode | null) => {
    const call = { from, to, mode: asked };
    calls.push(call);
    const rows = answer(call, calls.length - 1);
    if (rows instanceof Error) throw rows;
    return { rows, mode };
  };
  return { calls, fetchWindow };
}

/** One trade in every window, so the account never looks finished. */
function busyBroker() {
  let ticket = 1_000;
  return fakeBroker((call) => [trade(ticket++, call.from + DAY)]);
}

const run = (
  input: Partial<Parameters<typeof backfillOrderHistory<Order>>[0]> &
    Pick<Parameters<typeof backfillOrderHistory<Order>>[0], "fetchWindow">,
) =>
  backfillOrderHistory<Order>({
    now: NOW,
    horizonDays: DEFAULT_BACKFILL_DAYS,
    budgetMs: 45_000,
    current: [],
    state: undefined,
    ...input,
  });

describe("settings", () => {
  test("the horizon defaults to a year, can be switched off and is capped", () => {
    expect(backfillDaysFromEnv(undefined)).toBe(DEFAULT_BACKFILL_DAYS);
    expect(backfillDaysFromEnv("")).toBe(DEFAULT_BACKFILL_DAYS);
    expect(backfillDaysFromEnv("not a number")).toBe(DEFAULT_BACKFILL_DAYS);
    expect(backfillDaysFromEnv("0")).toBe(0);
    expect(backfillDaysFromEnv("-5")).toBe(0);
    expect(backfillDaysFromEnv("90")).toBe(90);
    expect(backfillDaysFromEnv("180.9")).toBe(180);
    expect(backfillDaysFromEnv("99999")).toBe(MAX_BACKFILL_DAYS);
  });

  test("the time budget of one run stays between 2 and 45 seconds", () => {
    expect(backfillBudgetFromEnv(undefined)).toBe(12_000);
    expect(backfillBudgetFromEnv("junk")).toBe(12_000);
    expect(backfillBudgetFromEnv("500")).toBe(2_000);
    expect(backfillBudgetFromEnv("20000")).toBe(20_000);
    expect(backfillBudgetFromEnv("999999")).toBe(45_000);
  });
});

describe("oldestCloseMs", () => {
  test("is the oldest close time of a trade - deposits and undated rows do not count", () => {
    const undated: Order = { ticket: 4, symbol: "EURUSD", lots: 1 };
    expect(
      oldestCloseMs([trade(1, NOW - 10 * DAY), trade(2, NOW - 30 * DAY), deposit(3, NOW - 400 * DAY), undated]),
    ).toBe(NOW - 30 * DAY);
  });

  test("is null when there is no dated trade", () => {
    expect(oldestCloseMs([])).toBeNull();
    expect(oldestCloseMs([deposit(1, NOW - DAY)])).toBeNull();
  });
});

describe("mergeBackfilledOrders", () => {
  test("keeps what is already there first and adds only orders it does not hold", () => {
    const current = [trade(1, NOW - DAY), trade(2, NOW - 2 * DAY)];
    const extra = [trade(2, NOW - 2 * DAY), trade(3, NOW - 3 * DAY)];
    expect(mergeBackfilledOrders(current, extra).map((order) => order.ticket)).toEqual([1, 2, 3]);
  });

  test("windows overlap, so repeats inside the new orders are dropped too", () => {
    const extra = [trade(5, NOW - DAY), trade(5, NOW - DAY), trade(6, NOW - 2 * DAY)];
    expect(mergeBackfilledOrders([], extra).map((order) => order.ticket)).toEqual([5, 6]);
  });

  test("a position closed in parts is not one order: a different close time or size is a different row", () => {
    const parts = [trade(7, NOW - DAY, 0.5), trade(7, NOW - DAY, 0.3), trade(7, NOW - 2 * DAY, 0.5)];
    expect(mergeBackfilledOrders([], parts)).toHaveLength(3);
  });

  test("orders without any id can not be told apart and are all kept", () => {
    const anonymous = [{ symbol: "EURUSD", lots: 1 }, { symbol: "EURUSD", lots: 1 }];
    expect(mergeBackfilledOrders([], anonymous)).toHaveLength(2);
  });
});

describe("backfillOrderHistory", () => {
  test("switched off: nothing is asked and the account counts as finished", async () => {
    const broker = busyBroker();
    const result = await run({ horizonDays: 0, current: [trade(1, NOW - DAY)], fetchWindow: broker.fetchWindow });
    expect(broker.calls).toHaveLength(0);
    expect(result).toMatchObject({ rows: [], windows: 0 });
    expect(result.state).toMatchObject({ complete: true, nextRunAt: NOW + BACKFILL_REPEAT_MS });
  });

  test("a list that already reaches the horizon needs no extra request", async () => {
    const broker = busyBroker();
    const result = await run({
      current: [trade(1, NOW - DEFAULT_BACKFILL_DAYS * DAY - DAY), trade(2, NOW - DAY)],
      fetchWindow: broker.fetchWindow,
    });
    expect(broker.calls).toHaveLength(0);
    expect(result.state.complete).toBe(true);
  });

  test("walks backwards from the oldest order in hand, window by window, to the horizon", async () => {
    const broker = busyBroker();
    const result = await run({ current: [trade(1, NOW - 20 * DAY)], fetchWindow: broker.fetchWindow });

    const window = BACKFILL_WINDOW_DAYS * DAY;
    const first = NOW - 20 * DAY;
    expect(broker.calls.map((call) => [call.from, call.to])).toEqual([
      [first - window, first + BACKFILL_OVERLAP_MS],
      [first - 2 * window, first - window + BACKFILL_OVERLAP_MS],
      [first - 3 * window, first - 2 * window + BACKFILL_OVERLAP_MS],
      // the last window stops at the horizon, not beyond it
      [HORIZON, first - 3 * window + BACKFILL_OVERLAP_MS],
    ]);
    expect(result.windows).toBe(4);
    expect(result.rows).toHaveLength(4);
    expect(result.state).toEqual({
      reachedMs: HORIZON,
      complete: true,
      nextRunAt: NOW + BACKFILL_REPEAT_MS,
      mode: "positions",
    });
  });

  test("a window never reaches into the future", async () => {
    const broker = busyBroker();
    await run({ current: [trade(1, NOW - DAY)], fetchWindow: broker.fetchWindow });
    expect(broker.calls[0].to).toBe(NOW);
  });

  test("an account with no order at all is searched all the way back", async () => {
    const broker = fakeBroker(() => []);
    const result = await run({ fetchWindow: broker.fetchWindow });
    // 365 days in windows of 90: 90, 180, 270, 360 and the last 5
    expect(broker.calls).toHaveLength(5);
    expect(broker.calls[0]).toMatchObject({ from: NOW - BACKFILL_WINDOW_DAYS * DAY, to: NOW });
    expect(broker.calls[4].from).toBe(HORIZON);
    expect(result.state.complete).toBe(true);
  });

  test("an account that has traded and then shows nothing for a long stretch has nothing older", async () => {
    const broker = fakeBroker(() => []);
    const result = await run({ current: [trade(1, NOW - 10 * DAY)], fetchWindow: broker.fetchWindow });
    expect(broker.calls).toHaveLength(BACKFILL_EMPTY_WINDOWS_TO_STOP);
    expect(result.state).toMatchObject({
      complete: true,
      reachedMs: NOW - 10 * DAY - BACKFILL_EMPTY_WINDOWS_TO_STOP * BACKFILL_WINDOW_DAYS * DAY,
    });
  });

  test("deposits do not make a window busy: only trades reset the count of empty windows", async () => {
    let ticket = 500;
    const broker = fakeBroker((call) => [deposit(ticket++, call.from + DAY)]);
    const result = await run({ current: [trade(1, NOW - 10 * DAY)], fetchWindow: broker.fetchWindow });
    expect(broker.calls).toHaveLength(BACKFILL_EMPTY_WINDOWS_TO_STOP);
    // the deposits are still handed over: the cash flows are read from the same list
    expect(result.rows).toHaveLength(BACKFILL_EMPTY_WINDOWS_TO_STOP);
  });

  test("a trade in between starts the count of empty windows again", async () => {
    // empty, empty, a trade, then the horizon: without the trade the walk would have ended after three windows
    const broker = fakeBroker((call, index) => (index === 2 ? [trade(77, call.from + DAY)] : []));
    const result = await run({ current: [trade(1, NOW - 10 * DAY)], fetchWindow: broker.fetchWindow });
    expect(broker.calls).toHaveLength(4);
    expect(result.state).toMatchObject({ complete: true, reachedMs: HORIZON });
  });

  test("the budget ends a run early; the next run continues where it stopped", async () => {
    const broker = busyBroker();
    let tick = 0;
    // every look at the clock costs ten seconds against a budget of five
    const clock = () => (tick += 10_000);
    const first = await run({
      current: [trade(1, NOW - 20 * DAY)],
      budgetMs: 5_000,
      clock,
      fetchWindow: broker.fetchWindow,
    });
    expect(first.windows).toBe(1);
    expect(first.state).toMatchObject({ complete: false, reachedMs: NOW - 20 * DAY - BACKFILL_WINDOW_DAYS * DAY });
    // not finished: the very next sync may go on
    expect(first.state.nextRunAt).toBe(NOW);

    const second = await run({
      current: [trade(1, NOW - 20 * DAY)],
      state: first.state,
      fetchWindow: broker.fetchWindow,
    });
    // it picks up at the stretch the first run reached, not at the oldest order again
    expect(broker.calls[1].to).toBe(first.state.reachedMs! + BACKFILL_OVERLAP_MS);
    expect(second.state).toMatchObject({ complete: true, reachedMs: HORIZON });
  });

  test("a failed window keeps what was found, waits ten minutes and then continues", async () => {
    let ticket = 900;
    const broker = fakeBroker((call, index) => (index === 1 ? new Error("bridge timeout") : [trade(ticket++, call.from + DAY)]));
    const first = await run({ current: [trade(1, NOW - 20 * DAY)], fetchWindow: broker.fetchWindow });

    expect(first.windows).toBe(1);
    expect(first.rows).toHaveLength(1);
    expect(first.state).toMatchObject({
      complete: false,
      reachedMs: NOW - 20 * DAY - BACKFILL_WINDOW_DAYS * DAY,
      nextRunAt: NOW + BACKFILL_RETRY_MS,
    });

    // too early: no request at all
    const early = await run({ now: NOW + 5 * MINUTE, current: [trade(1, NOW - 20 * DAY)], state: first.state, fetchWindow: broker.fetchWindow });
    expect(early).toMatchObject({ rows: [], windows: 0 });
    expect(broker.calls).toHaveLength(2);

    // after the pause it goes on from the stretch that was reached
    const later = await run({
      now: NOW + 11 * MINUTE,
      current: [trade(1, NOW - 20 * DAY)],
      state: first.state,
      fetchWindow: broker.fetchWindow,
    });
    expect(later.windows).toBeGreaterThan(0);
    expect(broker.calls[2].to).toBe(first.state.reachedMs! + BACKFILL_OVERLAP_MS);
  });

  test("a finished backfill is repeated only after a week", async () => {
    const broker = busyBroker();
    const done: BackfillState = {
      reachedMs: HORIZON,
      complete: true,
      nextRunAt: NOW + 3 * DAY,
      mode: "positions",
    };
    const idle = await run({ current: [trade(1, NOW - 20 * DAY)], state: done, fetchWindow: broker.fetchWindow });
    expect(idle).toMatchObject({ rows: [], windows: 0 });
    expect(broker.calls).toHaveLength(0);

    const again = await run({
      now: NOW + 8 * DAY,
      current: [trade(1, NOW - 20 * DAY)],
      state: done,
      fetchWindow: broker.fetchWindow,
    });
    expect(again.windows).toBeGreaterThan(0);
  });

  test("the endpoint that answered is remembered, so the other one is not asked for every window", async () => {
    const answers: Array<BackfillMode | null> = ["orders", null, null, null];
    let index = 0;
    const calls: Call[] = [];
    const fetchWindow = async (from: number, to: number, mode: BackfillMode | null) => {
      calls.push({ from, to, mode });
      return { rows: [trade(2_000 + index, from + DAY)], mode: answers[index++] ?? null };
    };
    const result = await run({ current: [trade(1, NOW - 20 * DAY)], fetchWindow });
    expect(calls.map((call) => call.mode)).toEqual([null, "orders", "orders", "orders"]);
    expect(result.state.mode).toBe("orders");
  });

  test("the state that was passed in is not changed", async () => {
    const broker = busyBroker();
    const state: BackfillState = { reachedMs: NOW - 50 * DAY, complete: false, nextRunAt: 0, mode: "orders" };
    const before = { ...state };
    await run({ current: [trade(1, NOW - 20 * DAY)], state, fetchWindow: broker.fetchWindow });
    expect(state).toEqual(before);
  });

  test("overlapping windows hand over every order once", async () => {
    // the same trade shows up at the border of two neighbouring windows
    const broker = fakeBroker((call, index) => (index < 2 ? [trade(42, NOW - 100 * DAY), trade(100 + index, call.from + DAY)] : []));
    const result = await run({ current: [trade(1, NOW - 20 * DAY)], fetchWindow: broker.fetchWindow });
    expect(result.rows.filter((order) => order.ticket === 42)).toHaveLength(1);
    expect(result.rows).toHaveLength(3);
  });

  test("a fresh state asks immediately and knows nothing yet", () => {
    expect(freshBackfillState()).toEqual({ reachedMs: null, complete: false, nextRunAt: 0, mode: null });
  });
});
