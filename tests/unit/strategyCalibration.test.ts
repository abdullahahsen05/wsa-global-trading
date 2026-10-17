import { describe, expect, it } from "vitest";
import { readCalibration } from "@/lib/copy/calibration";
import {
  followsLevels,
  followsMasterLevelsAsTheyAre,
  shapeStrategyModify,
  shapeStrategyOpen,
  signalAge,
  type StrategyOpenInput,
} from "@/lib/copy/strategyCalibration";

const BROKER_LIST = [
  { name: "EURUSDm", digits: 5 },
  { name: "XAUUSDm", digits: 2 },
  { name: "GOLD.pro", digits: 2 },
];

function open(overrides: Partial<StrategyOpenInput> = {}): StrategyOpenInput {
  return {
    sourceSymbol: "EURUSD",
    mapping: {},
    followerSymbols: null,
    followerSide: "BUY",
    reversed: false,
    entryPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    calibration: readCalibration({}),
    platformSlippage: 30,
    signalAgeMs: 120,
    ...overrides,
  };
}

describe("shapeStrategyOpen - defaults", () => {
  it("sends what the strategy engine always sent", () => {
    const shape = shapeStrategyOpen(open());
    expect(shape).toEqual({
      candidates: ["EURUSD"],
      matchedBy: "as-is",
      stopLoss: 1.09,
      takeProfit: 1.12,
      slippage: 30,
      notes: [],
      blocked: null,
    });
  });

  it("keeps the platform's slippage limit, or none", () => {
    expect(shapeStrategyOpen(open({ platformSlippage: null })).slippage).toBeNull();
  });

  it("tries the gold alias after the name it was given", () => {
    expect(shapeStrategyOpen(open({ sourceSymbol: "XAUUSD" })).candidates).toEqual(["XAUUSD", "GOLD"]);
  });
});

describe("shapeStrategyOpen - the follower's symbol", () => {
  it("uses the follower broker's own spelling", () => {
    const shape = shapeStrategyOpen(open({ sourceSymbol: "XAUUSD", followerSymbols: BROKER_LIST, entryPrice: 2300, stopLoss: 2290, takeProfit: 2320 }));
    expect(shape.candidates[0]).toBe("XAUUSDm");
    expect(shape.matchedBy).toBe("auto");
  });

  it("lets the follower's mapping win, in the broker's spelling", () => {
    const shape = shapeStrategyOpen(open({ sourceSymbol: "XAUUSD", mapping: { XAUUSD: "gold.pro" }, followerSymbols: BROKER_LIST }));
    expect(shape.candidates[0]).toBe("GOLD.pro");
    expect(shape.matchedBy).toBe("mapping");
  });

  it("does not look for another name when automatic matching is off", () => {
    const shape = shapeStrategyOpen(open({ sourceSymbol: "XAUUSD", followerSymbols: BROKER_LIST, calibration: readCalibration({ autoSymbolMatch: false }) }));
    expect(shape.candidates[0]).toBe("XAUUSD");
  });
});

describe("shapeStrategyOpen - stop loss and take profit", () => {
  it("swaps the two for a reversed trade", () => {
    const shape = shapeStrategyOpen(open({ followerSide: "SELL", reversed: true }));
    expect(shape.stopLoss).toBe(1.12);
    expect(shape.takeProfit).toBe(1.09);
    expect(shape.notes.join(" ")).toMatch(/Reverse copy/);
  });

  it("leaves a level out when the follower does not copy it", () => {
    const shape = shapeStrategyOpen(open({ calibration: readCalibration({ copyStopLoss: false }) }));
    expect(shape.stopLoss).toBeNull();
    expect(shape.takeProfit).toBe(1.12);
  });

  it("puts a fixed distance in place of the master's level (point from the broker's digits)", () => {
    const shape = shapeStrategyOpen(
      open({
        sourceSymbol: "XAUUSD",
        followerSymbols: BROKER_LIST,
        entryPrice: 2300,
        stopLoss: 2290,
        takeProfit: 2320,
        calibration: readCalibration({ stopLossPoints: 150, takeProfitPoints: 300 }),
      }),
    );
    expect(shape.stopLoss).toBe(2298.5);
    expect(shape.takeProfit).toBe(2303);
    expect(shape.blocked).toBeNull();
  });

  it("uses the fallback point when the list does not know the digits", () => {
    const shape = shapeStrategyOpen(open({ calibration: readCalibration({ stopLossPoints: 100 }), fallbackPoint: 0.00001 }));
    expect(shape.stopLoss).toBe(1.099);
  });

  it("does not send the order when a fixed distance cannot be worked out", () => {
    const shape = shapeStrategyOpen(open({ calibration: readCalibration({ stopLossPoints: 100 }) }));
    expect(shape.blocked).toMatchObject({ code: "LEVELS_UNAVAILABLE" });
    expect(shape.blocked?.message).toMatch(/stop loss in points/);
  });
});

describe("shapeStrategyOpen - slippage and signal age", () => {
  it("takes the stricter slippage limit", () => {
    expect(shapeStrategyOpen(open({ calibration: readCalibration({ maxSlippagePoints: 10 }) })).slippage).toBe(10);
    expect(shapeStrategyOpen(open({ calibration: readCalibration({ maxSlippagePoints: 80 }) })).slippage).toBe(30);
    expect(shapeStrategyOpen(open({ platformSlippage: null, calibration: readCalibration({ maxSlippagePoints: 20 }) })).slippage).toBe(20);
  });

  it("blocks a signal that is older than the follower's limit", () => {
    const shape = shapeStrategyOpen(open({ signalAgeMs: 2_400, calibration: readCalibration({ maxSignalAgeMs: 1_000 }) }));
    expect(shape.blocked).toMatchObject({ code: "SIGNAL_TOO_OLD" });
    expect(shape.blocked?.message).toMatch(/2\.4 s old/);
    expect(shape.blocked?.message).toMatch(/1 s/);
  });

  it("lets a fresh signal, a missing limit and an unknown age through", () => {
    expect(shapeStrategyOpen(open({ signalAgeMs: 300, calibration: readCalibration({ maxSignalAgeMs: 1_000 }) })).blocked).toBeNull();
    expect(shapeStrategyOpen(open({ signalAgeMs: 60_000 })).blocked).toBeNull();
    expect(shapeStrategyOpen(open({ signalAgeMs: null, calibration: readCalibration({ maxSignalAgeMs: 1_000 }) })).blocked).toBeNull();
  });
});

describe("shapeStrategyModify", () => {
  const follower = { followerSide: "BUY" as const, reversed: false, stopLoss: 1.095, takeProfit: 1.12, calibration: readCalibration({}) };

  it("passes the master's new levels on", () => {
    expect(shapeStrategyModify(follower)).toEqual({ followsStopLoss: true, followsTakeProfit: true, stopLoss: 1.095, takeProfit: 1.12 });
  });

  it("keeps a stop that moved past the entry (break-even, trailing stop)", () => {
    expect(shapeStrategyModify({ ...follower, stopLoss: 1.105 }).stopLoss).toBe(1.105);
  });

  it("swaps the levels for a reversed follower", () => {
    const shape = shapeStrategyModify({ ...follower, followerSide: "SELL", reversed: true });
    expect(shape.stopLoss).toBe(1.12);
    expect(shape.takeProfit).toBe(1.095);
  });

  it("says which level the follower takes from the master", () => {
    expect(shapeStrategyModify({ ...follower, calibration: readCalibration({ copyStopLoss: false }) })).toMatchObject({
      followsStopLoss: false,
      followsTakeProfit: true,
      takeProfit: 1.12,
    });
    // a fixed distance is the follower's own level
    expect(followsLevels(readCalibration({ takeProfitPoints: 200 }))).toEqual({ stopLoss: true, takeProfit: false });
  });

  it("knows when a change reaches the follower unchanged", () => {
    expect(followsMasterLevelsAsTheyAre(readCalibration({}), false)).toBe(true);
    expect(followsMasterLevelsAsTheyAre(readCalibration({}), true)).toBe(false);
    expect(followsMasterLevelsAsTheyAre(readCalibration({ copyTakeProfit: false }), false)).toBe(false);
    expect(followsMasterLevelsAsTheyAre(readCalibration({ stopLossPoints: 50 }), false)).toBe(false);
  });
});

describe("signalAge", () => {
  const now = Date.parse("2026-10-12T20:00:10.000Z");

  it("is the time since the master's event", () => {
    expect(signalAge("2026-10-12T20:00:09.500Z", now)).toBe(500);
  });

  it("is never negative and is null when the time cannot be read", () => {
    expect(signalAge("2026-10-12T20:00:12.000Z", now)).toBe(0);
    expect(signalAge("soon", now)).toBeNull();
    expect(signalAge(null, now)).toBeNull();
    expect(signalAge(undefined, now)).toBeNull();
  });
});
