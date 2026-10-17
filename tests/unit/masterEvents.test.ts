import { describe, expect, test, vi } from "vitest";
import {
  buildMasterEvent,
  instantOrNow,
  openedBeforeDetectionMs,
  storeMasterEvent,
  type BuiltMasterEvent,
  type DetectedPositionEvent,
  type MasterPosition,
} from "@/lib/copy/masterEvents";

const STRATEGY = { id: "strategy-1", master_account_id: "master-1" };
const NOW = Date.parse("2026-10-12T12:00:00.000Z");

function position(overrides: Partial<MasterPosition> = {}): MasterPosition {
  return {
    id: "5001",
    type: "POSITION_TYPE_BUY",
    symbol: "EURUSD",
    volume: 0.5,
    openPrice: 1.1,
    currentPrice: 1.105,
    stopLoss: 1.09,
    takeProfit: 1.12,
    time: "2026-10-12T11:59:59.800Z",
    updateTime: "2026-10-12T12:00:00.000Z",
    ...overrides,
  };
}

function build(event: Partial<DetectedPositionEvent> & { eventType: DetectedPositionEvent["eventType"] }, liveBrokerSource = true) {
  return buildMasterEvent(STRATEGY, { position: position(), ...event }, { liveBrokerSource, now: NOW });
}

describe("instantOrNow", () => {
  test("keeps a good instant", () => {
    expect(instantOrNow("2026-10-12T10:00:00Z", NOW)).toBe("2026-10-12T10:00:00.000Z");
    expect(instantOrNow(new Date("2026-10-12T10:00:00Z"), NOW)).toBe("2026-10-12T10:00:00.000Z");
  });

  test.each([
    ["nothing", undefined],
    ["text that is not a date", "yesterday-ish"],
    ["a placeholder year", "0001-01-01T00:00:00Z"],
    ["epoch zero", "1970-01-01T00:00:00Z"],
  ])("replaces %s by now", (_label, value) => {
    expect(instantOrNow(value as string | undefined, NOW)).toBe(new Date(NOW).toISOString());
  });
});

describe("buildMasterEvent", () => {
  test("an OPEN carries the position and is stamped with the moment it was seen", () => {
    const built = build({ eventType: "OPEN" });

    expect(built.dedupeKey).toBe("strategy-1:5001:OPEN");
    expect(built.insert).toMatchObject({
      strategy_id: "strategy-1",
      master_account_id: "master-1",
      event_type: "OPEN",
      master_trade_id: "5001",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.5,
      previous_volume: null,
      open_price: 1.1,
      close_price: null,
      stop_loss: 1.09,
      take_profit: 1.12,
      event_time: "2026-10-12T12:00:00.000Z",
      dedupe_key: "strategy-1:5001:OPEN",
      source_sequence: "OPEN",
      source: "LIVE_BROKER_SOURCE",
    });
    expect(built.insert.raw_payload).toEqual({ source: "LIVE_BROKER_SOURCE", eventType: "OPEN" });
  });

  test("a position that was already open is stamped with the time it really opened", () => {
    const built = build({ eventType: "OPEN", existing: true });
    expect(built.linked.event_time).toBe("2026-10-12T11:59:59.800Z");
  });

  test("an already-open position without a usable open time falls back to its update time", () => {
    const built = build({ eventType: "OPEN", existing: true, position: position({ time: undefined }) });
    expect(built.linked.event_time).toBe("2026-10-12T12:00:00.000Z");
  });

  test("a sell is recorded as SELL", () => {
    expect(build({ eventType: "OPEN", position: position({ type: "POSITION_TYPE_SELL" }) }).linked.side).toBe("SELL");
  });

  test("a CLOSE records the last price and the same key every time", () => {
    const built = build({ eventType: "CLOSE" });
    expect(built.insert.close_price).toBe(1.105);
    expect(built.dedupeKey).toBe("strategy-1:5001:CLOSE");
  });

  test("a MODIFY records the previous volume and its key tells one change from the next", () => {
    const first = build({
      eventType: "MODIFY",
      previous: position({ volume: 0.5, stopLoss: 1.09 }),
      position: position({ volume: 0.5, stopLoss: 1.095 }),
    });
    const second = build({
      eventType: "MODIFY",
      previous: position({ volume: 0.5, stopLoss: 1.095 }),
      position: position({ volume: 0.5, stopLoss: 1.098 }),
    });

    expect(first.linked.previous_volume).toBe(0.5);
    expect(first.dedupeKey).not.toBe(second.dedupeKey);
    expect(first.dedupeKey).toContain("strategy-1:5001:");
    expect(first.insert.source_sequence).toBe("2026-10-12T12:00:00.000Z:0.5:1.095:1.12");
  });

  test("a missing stop loss or take profit is stored as null", () => {
    const built = build({ eventType: "OPEN", position: position({ stopLoss: undefined, takeProfit: undefined }) });
    expect(built.linked.stop_loss).toBeNull();
    expect(built.linked.take_profit).toBeNull();
  });

  test("a numeric ticket becomes text", () => {
    const built = build({ eventType: "OPEN", position: position({ id: 777 }) });
    expect(built.linked.master_trade_id).toBe("777");
    expect(built.dedupeKey).toBe("strategy-1:777:OPEN");
  });

  test("the stream of another provider is labelled as such", () => {
    const built = build({ eventType: "OPEN" }, false);
    expect(built.insert.source).toBe("WSA_STREAM");
    expect(built.insert.raw_payload).toEqual({ source: "BROKER_STREAM", eventType: "OPEN" });
  });

  test("the copy engine receives exactly the fields it reads", () => {
    const built = build({ eventType: "OPEN" });
    expect(Object.keys(built.linked).sort()).toEqual(
      [
        "event_time",
        "event_type",
        "master_trade_id",
        "open_price",
        "previous_volume",
        "side",
        "stop_loss",
        "strategy_id",
        "symbol",
        "take_profit",
        "volume",
      ].sort(),
    );
  });
});

describe("openedBeforeDetectionMs", () => {
  const event = (overrides: Partial<DetectedPositionEvent> = {}): DetectedPositionEvent => ({
    eventType: "OPEN",
    position: position({ time: "2026-10-12T11:59:59.800Z" }),
    ...overrides,
  });

  test("tells how long the trade had been open when it was seen", () => {
    expect(openedBeforeDetectionMs(event(), NOW)).toBe(200);
  });

  test("is unknown for other events, for positions found at start and for positions without a time", () => {
    expect(openedBeforeDetectionMs(event({ eventType: "CLOSE" }), NOW)).toBeNull();
    expect(openedBeforeDetectionMs(event({ eventType: "MODIFY" }), NOW)).toBeNull();
    expect(openedBeforeDetectionMs(event({ existing: true }), NOW)).toBeNull();
    expect(openedBeforeDetectionMs(event({ position: position({ time: undefined }) }), NOW)).toBeNull();
  });

  test("is unknown when the numbers cannot be right", () => {
    expect(openedBeforeDetectionMs(event({ position: position({ time: "2026-10-12T11:00:00Z" }) }), NOW)).toBeNull();
    expect(openedBeforeDetectionMs(event({ position: position({ time: "2026-10-12T12:30:00Z" }) }), NOW)).toBeNull();
    expect(openedBeforeDetectionMs(event({ position: position({ time: "not a time" }) }), NOW)).toBeNull();
  });

  test("a little clock difference is shown as zero", () => {
    expect(openedBeforeDetectionMs(event({ position: position({ time: "2026-10-12T12:00:00.500Z" }) }), NOW)).toBe(0);
  });

  test("accepts a Date", () => {
    expect(openedBeforeDetectionMs(event({ position: position({ time: new Date(NOW - 50) }) }), NOW)).toBe(50);
  });
});

// ── storing ──────────────────────────────────────────────────────────────────

type Answer = { data: { id: string } | null; error: { code?: string; message: string } | null } | Error;

function fakeDatabase(inserts: Answer[], lookup: { data: { id: string } | null } = { data: null }) {
  const insert = vi.fn();
  const eq = vi.fn();
  let call = 0;
  const db = {
    from: vi.fn(() => ({
      insert: (row: unknown) => {
        insert(row);
        return {
          select: () => ({
            single: async () => {
              const answer = inserts[Math.min(call, inserts.length - 1)];
              call += 1;
              if (answer instanceof Error) throw answer;
              return answer;
            },
          }),
        };
      },
      select: () => ({
        eq: (column: string, value: string) => {
          eq(column, value);
          return { maybeSingle: async () => lookup };
        },
      }),
    })),
  };
  return { db, insert, eq, attempts: () => call };
}

const BUILT: BuiltMasterEvent = build({ eventType: "OPEN" });
const wait = vi.fn(async () => undefined);

describe("storeMasterEvent", () => {
  test("returns the id of the stored row", async () => {
    const { db, insert } = fakeDatabase([{ data: { id: "event-1" }, error: null }]);

    await expect(storeMasterEvent(db, BUILT, { wait })).resolves.toBe("event-1");
    expect(insert).toHaveBeenCalledWith(BUILT.insert);
  });

  test("a duplicate on the first attempt means the trade was seen before: nothing to copy", async () => {
    const { db, eq } = fakeDatabase([{ data: null, error: { code: "23505", message: "duplicate key" } }]);

    await expect(storeMasterEvent(db, BUILT, { wait })).resolves.toBeNull();
    expect(eq).not.toHaveBeenCalled();
  });

  test("a failed insert is tried again after a pause, and the retry's id is used", async () => {
    const { db, attempts } = fakeDatabase([
      { data: null, error: { message: "connection reset" } },
      { data: { id: "event-2" }, error: null },
    ]);
    const onRetry = vi.fn();
    const pause = vi.fn(async () => undefined);

    await expect(
      storeMasterEvent(db, BUILT, { wait: pause, onRetry, retryDelaysMs: [150, 600, 2_000] }),
    ).resolves.toBe("event-2");

    expect(attempts()).toBe(2);
    expect(pause).toHaveBeenCalledWith(150);
    expect(onRetry).toHaveBeenCalledWith(1, "connection reset");
  });

  test("a thrown error is a failed attempt too", async () => {
    const { db } = fakeDatabase([new Error("fetch failed"), { data: { id: "event-3" }, error: null }]);

    await expect(storeMasterEvent(db, BUILT, { wait })).resolves.toBe("event-3");
  });

  test("an answer without a row counts as a failed attempt", async () => {
    const { db } = fakeDatabase([{ data: null, error: null }, { data: { id: "event-4" }, error: null }]);

    await expect(storeMasterEvent(db, BUILT, { wait })).resolves.toBe("event-4");
  });

  test("after a failed attempt a duplicate means the earlier attempt did store it: its id is returned so it is still copied", async () => {
    const { db, eq } = fakeDatabase(
      [
        { data: null, error: { message: "timeout" } },
        { data: null, error: { code: "23505", message: "duplicate key" } },
      ],
      { data: { id: "event-5" } },
    );

    await expect(storeMasterEvent(db, BUILT, { wait })).resolves.toBe("event-5");
    expect(eq).toHaveBeenCalledWith("dedupe_key", BUILT.dedupeKey);
  });

  test("a duplicate after a failed attempt whose row cannot be found is treated as seen before", async () => {
    const { db } = fakeDatabase(
      [
        { data: null, error: { message: "timeout" } },
        { data: null, error: { code: "23505", message: "duplicate key" } },
      ],
      { data: null },
    );

    await expect(storeMasterEvent(db, BUILT, { wait })).resolves.toBeNull();
  });

  test("gives up after the last pause and throws the last failure", async () => {
    const { db, attempts } = fakeDatabase([{ data: null, error: { message: "database is down" } }]);
    const pause = vi.fn(async (ms: number) => void ms);

    await expect(
      storeMasterEvent(db, BUILT, { wait: pause, retryDelaysMs: [10, 20] }),
    ).rejects.toThrow("Master event could not be stored: database is down");

    expect(attempts()).toBe(3);
    expect(pause.mock.calls.map((call) => call[0])).toEqual([10, 20]);
  });

  test("with no pauses configured there is a single attempt", async () => {
    const { db, attempts } = fakeDatabase([{ data: null, error: { message: "nope" } }]);

    await expect(storeMasterEvent(db, BUILT, { wait, retryDelaysMs: [] })).rejects.toThrow("nope");
    expect(attempts()).toBe(1);
  });
});
