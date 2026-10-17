import { describe, expect, it } from "vitest";
import { instantMs, toSelfCopyPositionEvent, type StreamPosition } from "@/lib/copy/selfCopyEvents";

const SOURCE = "aaaaaaaa-0000-4000-8000-000000000001";

function position(overrides: Partial<StreamPosition> = {}): StreamPosition {
  return {
    id: 4711,
    type: "POSITION_TYPE_BUY",
    symbol: "EURUSD",
    volume: 0.5,
    openPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    time: "2026-10-12T20:00:06.000Z",
    ...overrides,
  };
}

describe("instantMs", () => {
  it("reads an instant that says its zone", () => {
    expect(instantMs("2026-10-12T20:00:06.000Z")).toBe(Date.parse("2026-10-12T20:00:06.000Z"));
    expect(instantMs("2026-10-12T22:00:06+02:00")).toBe(Date.parse("2026-10-12T20:00:06.000Z"));
    expect(instantMs(new Date("2026-10-12T20:00:06.000Z"))).toBe(Date.parse("2026-10-12T20:00:06.000Z"));
  });

  it("reads epoch milliseconds and epoch seconds", () => {
    expect(instantMs(1_760_000_000_000)).toBe(1_760_000_000_000);
    expect(instantMs(1_760_000_000)).toBe(1_760_000_000_000);
  });

  it("does not guess a time that has no zone - broker server time is not UTC", () => {
    expect(instantMs("2026-10-12 22:00:06")).toBeNull();
    expect(instantMs("2026.10.12 22:00:06")).toBeNull();
    expect(instantMs("2026-10-12T22:00:06")).toBeNull();
  });

  it("returns null for anything else", () => {
    for (const value of [null, undefined, "", "   ", "soon", 0, -1, 12, Number.NaN, {}, [], new Date("nonsense")]) {
      expect(instantMs(value)).toBeNull();
    }
  });
});

describe("toSelfCopyPositionEvent", () => {
  it("turns a new position into an OPEN event with everything the engine needs", () => {
    const event = toSelfCopyPositionEvent(SOURCE, { eventType: "OPEN", position: position(), detectedAt: 1_760_000_100_000 });
    expect(event).toEqual({
      sourceAccountId: SOURCE,
      eventType: "OPEN",
      sourcePositionId: "4711",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.5,
      previousVolume: null,
      entryPrice: 1.1,
      stopLoss: 1.09,
      takeProfit: 1.12,
      detectedAt: 1_760_000_100_000,
      openedAt: Date.parse("2026-10-12T20:00:06.000Z"),
    });
  });

  it("reads the side of a sell and flags a position found in the first look", () => {
    const event = toSelfCopyPositionEvent(SOURCE, {
      eventType: "OPEN",
      position: position({ type: "POSITION_TYPE_SELL" }),
      existing: true,
    });
    expect(event.side).toBe("SELL");
    expect(event.existing).toBe(true);
    expect(event.detectedAt).toBeNull();
  });

  it("leaves the flag out for a position that was seen opening", () => {
    const event = toSelfCopyPositionEvent(SOURCE, { eventType: "OPEN", position: position(), existing: false });
    expect("existing" in event).toBe(false);
  });

  it("treats a missing stop loss, take profit or price as none", () => {
    const event = toSelfCopyPositionEvent(SOURCE, {
      eventType: "OPEN",
      position: position({ stopLoss: 0, takeProfit: undefined, openPrice: "" }),
    });
    expect(event.stopLoss).toBeNull();
    expect(event.takeProfit).toBeNull();
    expect(event.entryPrice).toBeNull();
  });

  it("gives a MODIFY the volume and the levels from before the change", () => {
    const event = toSelfCopyPositionEvent(SOURCE, {
      eventType: "MODIFY",
      position: position({ volume: 0.3, stopLoss: 1.095 }),
      previous: position({ volume: 0.5, stopLoss: 0 }),
    });
    expect(event).toMatchObject({
      previousVolume: 0.5,
      previousStopLoss: null,
      previousTakeProfit: 1.12,
      stopLoss: 1.095,
      volume: 0.3,
    });
  });

  it("does not use an open time it cannot trust", () => {
    const event = toSelfCopyPositionEvent(SOURCE, { eventType: "OPEN", position: position({ time: "2026-10-12 22:00:06" }) });
    expect(event.openedAt).toBeNull();
  });

  it("keeps a string ticket as it is", () => {
    expect(toSelfCopyPositionEvent(SOURCE, { eventType: "CLOSE", position: position({ id: "98765" }) }).sourcePositionId).toBe("98765");
  });
});
