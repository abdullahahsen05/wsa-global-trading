import { describe, expect, it } from "vitest";
import { copyFollowerSettingsSchema } from "@/lib/validation/schemas";
import {
  CALIBRATION_LIMITS,
  DEFAULT_COPY_CALIBRATION,
  effectiveSlippage,
  isDefaultCalibration,
  pointFromDigits,
  protectiveLevels,
  readCalibration,
  resolveFollowerSymbols,
  roundToPoint,
  type CopyCalibration,
} from "@/lib/copy/calibration";

const calibration = (overrides: Partial<CopyCalibration> = {}): CopyCalibration => ({ ...DEFAULT_COPY_CALIBRATION, ...overrides });

describe("readCalibration", () => {
  it("reads nothing, garbage and arrays as the platform defaults", () => {
    for (const raw of [undefined, null, "x", 5, [], [1, 2]]) {
      expect(readCalibration(raw)).toEqual(DEFAULT_COPY_CALIBRATION);
    }
    expect(isDefaultCalibration(readCalibration(undefined))).toBe(true);
  });

  it("keeps valid values and turns damaged ones back into the default", () => {
    const read = readCalibration({
      copyStopLoss: false,
      copyTakeProfit: "yes",
      stopLossPoints: "150",
      takeProfitPoints: -5,
      maxSlippagePoints: 0,
      maxSignalAgeMs: 50,
      copyExisting: true,
      autoSymbolMatch: false,
    });
    expect(read).toEqual({
      copyStopLoss: false,
      copyTakeProfit: true,
      stopLossPoints: 150,
      takeProfitPoints: null,
      maxSlippagePoints: 0,
      maxSignalAgeMs: null,
      copyExisting: true,
      autoSymbolMatch: false,
    });
    expect(isDefaultCalibration(read)).toBe(false);
  });

  it("refuses numbers beyond the limits", () => {
    const read = readCalibration({
      stopLossPoints: CALIBRATION_LIMITS.pointsMax + 1,
      maxSlippagePoints: CALIBRATION_LIMITS.slippageMax + 1,
      maxSignalAgeMs: CALIBRATION_LIMITS.signalAgeMaxMs + 1,
    });
    expect(read.stopLossPoints).toBeNull();
    expect(read.maxSlippagePoints).toBeNull();
    expect(read.maxSignalAgeMs).toBeNull();
    expect(readCalibration({ maxSignalAgeMs: CALIBRATION_LIMITS.signalAgeMinMs }).maxSignalAgeMs).toBe(CALIBRATION_LIMITS.signalAgeMinMs);
  });
});

describe("effectiveSlippage", () => {
  it("takes the stricter of the platform's and the follower's own limit", () => {
    expect(effectiveSlippage(null, null)).toBeNull();
    expect(effectiveSlippage(30, null)).toBe(30);
    expect(effectiveSlippage(undefined, 5)).toBe(5);
    expect(effectiveSlippage(30, 10)).toBe(10);
    expect(effectiveSlippage(10, 30)).toBe(10);
    expect(effectiveSlippage(Number.NaN, 5)).toBe(5);
  });
});

describe("points and rounding", () => {
  it("works out the size of a point from the digits", () => {
    expect(pointFromDigits(2)).toBe(0.01);
    expect(pointFromDigits(5)).toBe(0.00001);
    expect(pointFromDigits(0)).toBe(1);
    expect(pointFromDigits(null)).toBeNull();
    expect(pointFromDigits(11)).toBeNull();
    expect(pointFromDigits(2.5)).toBeNull();
    expect(pointFromDigits(-1)).toBeNull();
  });

  it("rounds a price to the grid of the symbol", () => {
    expect(roundToPoint(2298.9999999999995, 0.01)).toBe(2299);
    expect(roundToPoint(1.1 + 0.2, 0.01)).toBe(1.3);
    expect(roundToPoint(1.0989999999999998, 0.00001)).toBe(1.099);
    expect(roundToPoint(1.2345, 0)).toBe(1.2345);
  });
});

describe("protectiveLevels", () => {
  const buy = { followerSide: "BUY" as const, reversed: false, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, point: 0.00001 };

  it("passes the source's levels on by default", () => {
    expect(protectiveLevels({ ...buy, calibration: calibration() })).toEqual({
      stopLoss: 1.09,
      takeProfit: 1.12,
      notes: [],
      unavailable: null,
    });
  });

  it("treats empty and zero levels as none", () => {
    const result = protectiveLevels({ ...buy, stopLoss: 0, takeProfit: null, calibration: calibration() });
    expect(result.stopLoss).toBeNull();
    expect(result.takeProfit).toBeNull();
  });

  it("swaps stop loss and take profit for a reverse copy", () => {
    const result = protectiveLevels({ ...buy, followerSide: "SELL", reversed: true, calibration: calibration() });
    expect(result.stopLoss).toBe(1.12);
    expect(result.takeProfit).toBe(1.09);
    expect(result.notes.join(" ")).toMatch(/Reverse copy/);
  });

  it("leaves out a level that sits on the wrong side of the entry", () => {
    const wrongBuy = protectiveLevels({ ...buy, stopLoss: 1.11, takeProfit: 1.05, calibration: calibration() });
    expect(wrongBuy.stopLoss).toBeNull();
    expect(wrongBuy.takeProfit).toBeNull();
    expect(wrongBuy.notes).toHaveLength(2);

    const wrongSell = protectiveLevels({
      ...buy,
      followerSide: "SELL",
      stopLoss: 1.09,
      takeProfit: 1.12,
      calibration: calibration(),
    });
    expect(wrongSell.stopLoss).toBeNull();
    expect(wrongSell.takeProfit).toBeNull();
  });

  it("keeps a stop that trailed past the entry when asked not to judge the side", () => {
    const trailed = protectiveLevels({ ...buy, stopLoss: 1.105, checkSides: false, calibration: calibration() });
    expect(trailed.stopLoss).toBe(1.105);
    expect(trailed.notes).toEqual([]);
    // the default still protects a new order from a level the broker would refuse
    expect(protectiveLevels({ ...buy, stopLoss: 1.105, calibration: calibration() }).stopLoss).toBeNull();
  });

  it("still measures a fixed distance from the entry when the side is not judged", () => {
    const gold = { followerSide: "BUY" as const, reversed: false, entryPrice: 2300, stopLoss: 2301, takeProfit: null, point: 0.01, checkSides: false };
    expect(protectiveLevels({ ...gold, calibration: calibration({ stopLossPoints: 150 }) }).stopLoss).toBe(2298.5);
  });

  it("does not judge the side when the entry price is unknown", () => {
    const result = protectiveLevels({ ...buy, entryPrice: null, stopLoss: 1.11, calibration: calibration() });
    expect(result.stopLoss).toBe(1.11);
  });

  it("honours the copy toggles", () => {
    expect(protectiveLevels({ ...buy, calibration: calibration({ copyStopLoss: false }) })).toMatchObject({ stopLoss: null, takeProfit: 1.12 });
    expect(protectiveLevels({ ...buy, calibration: calibration({ copyTakeProfit: false }) })).toMatchObject({ stopLoss: 1.09, takeProfit: null });
  });

  it("puts fixed distances from the entry in place of the source's levels", () => {
    const gold = { followerSide: "BUY" as const, reversed: false, entryPrice: 2300, stopLoss: 2290, takeProfit: 2320, point: 0.01 };
    const long = protectiveLevels({ ...gold, calibration: calibration({ stopLossPoints: 150, takeProfitPoints: 300 }) });
    expect(long.stopLoss).toBe(2298.5);
    expect(long.takeProfit).toBe(2303);
    const short = protectiveLevels({ ...gold, followerSide: "SELL", calibration: calibration({ stopLossPoints: 150, takeProfitPoints: 300 }) });
    expect(short.stopLoss).toBe(2301.5);
    expect(short.takeProfit).toBe(2297);
  });

  it("lets a fixed distance stand in for a level the source does not have, and for a switched-off copy", () => {
    const result = protectiveLevels({
      followerSide: "BUY",
      reversed: false,
      entryPrice: 1.1,
      stopLoss: null,
      takeProfit: null,
      point: 0.00001,
      calibration: calibration({ copyStopLoss: false, stopLossPoints: 100 }),
    });
    expect(result.stopLoss).toBe(1.099);
    expect(result.takeProfit).toBeNull();
  });

  it("refuses to guess a fixed distance without the entry price or the size of a point", () => {
    const withoutEntry = protectiveLevels({ ...buy, entryPrice: null, calibration: calibration({ stopLossPoints: 100 }) });
    expect(withoutEntry.unavailable).toMatch(/stop loss/);
    expect(withoutEntry.stopLoss).toBeNull();

    const withoutPoint = protectiveLevels({ ...buy, point: null, calibration: calibration({ takeProfitPoints: 100 }) });
    expect(withoutPoint.unavailable).toMatch(/take profit/);
    expect(withoutPoint.takeProfit).toBeNull();
  });
});

describe("resolveFollowerSymbols", () => {
  it("finds the broker's own spelling in the follower's list", () => {
    const result = resolveFollowerSymbols({
      sourceSymbol: "XAUUSD",
      mapping: {},
      followerSymbols: ["EURUSD", "XAUUSDm"],
      autoMatch: true,
    });
    expect(result.candidates[0]).toBe("XAUUSDm");
    expect(result.matchedBy).toBe("auto");
    expect(result.listKnown).toBe(true);
    expect(result.listed).toBe(true);
    expect(result.candidates).toContain("GOLD");
  });

  it("prefers the person's own mapping", () => {
    const result = resolveFollowerSymbols({
      sourceSymbol: "xauusd",
      mapping: { XAUUSD: "gold.r" },
      followerSymbols: ["GOLD.r", "XAUUSDm"],
      autoMatch: true,
    });
    expect(result.candidates[0]).toBe("GOLD.r");
    expect(result.matchedBy).toBe("mapping");
  });

  it("uses the same name when the follower has it, in the follower's spelling", () => {
    const result = resolveFollowerSymbols({
      sourceSymbol: "eurusd",
      mapping: null,
      followerSymbols: ["EURUSD", "EURUSD.r"],
      autoMatch: true,
    });
    expect(result.candidates[0]).toBe("EURUSD");
    expect(result.matchedBy).toBe("same-name");
    expect(new Set(result.candidates.map((name) => name.toLowerCase())).size).toBe(result.candidates.length);
  });

  it("keeps trying the names the platform always tried when the list is not known", () => {
    for (const followerSymbols of [null, []]) {
      const result = resolveFollowerSymbols({ sourceSymbol: "xauusd", mapping: undefined, followerSymbols, autoMatch: true });
      // the source's own spelling first; "XAUUSD" would be the same name in another case, so it is not tried twice
      expect(result.candidates).toEqual(["xauusd", "GOLD"]);
      expect(result.matchedBy).toBe("as-is");
      expect(result.listKnown).toBe(false);
      expect(result.listed).toBe(false);
    }
  });

  it("does not match by instrument when automatic matching is off", () => {
    const result = resolveFollowerSymbols({
      sourceSymbol: "XAUUSD",
      mapping: {},
      followerSymbols: ["XAUUSDm"],
      autoMatch: false,
    });
    expect(result.candidates[0]).toBe("XAUUSD");
    expect(result.matchedBy).toBe("as-is");
    expect(result.listed).toBe(false);
  });

  it("offers the gold alias in both directions", () => {
    expect(resolveFollowerSymbols({ sourceSymbol: "GOLD", mapping: {}, followerSymbols: null, autoMatch: true }).candidates).toEqual(["GOLD", "XAUUSD"]);
    expect(resolveFollowerSymbols({ sourceSymbol: "XAUUSD", mapping: {}, followerSymbols: null, autoMatch: true }).candidates).toEqual(["XAUUSD", "GOLD"]);
  });
});

describe("calibration in the route settings schema", () => {
  const settings = {
    copyEnabled: true,
    copyMode: "FIXED_LOT" as const,
    fixedLot: 0.5,
    lotMultiplier: null,
    riskPercent: null,
    minLot: null,
    maxLot: null,
    maxOpenTrades: null,
    maxDailyLossPercent: null,
    maxDrawdownPercent: null,
    allowedSymbols: null,
    blockedSymbols: null,
    symbolMapping: {},
    copyNewTradesOnly: true as const,
    reverseCopy: false,
    pauseOnDisconnect: true,
    emergencyStop: false,
  };

  it("is optional, so routes saved before it existed stay valid", () => {
    expect(copyFollowerSettingsSchema.safeParse(settings).success).toBe(true);
  });

  it("accepts a partial calibration and keeps what it was given", () => {
    const parsed = copyFollowerSettingsSchema.safeParse({
      ...settings,
      calibration: { copyStopLoss: false, stopLossPoints: 150, maxSignalAgeMs: 3000, maxSlippagePoints: null },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.calibration).toEqual({ copyStopLoss: false, stopLossPoints: 150, maxSignalAgeMs: 3000, maxSlippagePoints: null });
    }
  });

  it("refuses values outside the limits", () => {
    for (const calibration of [
      { stopLossPoints: 0 },
      { stopLossPoints: CALIBRATION_LIMITS.pointsMax + 1 },
      { maxSlippagePoints: -1 },
      { maxSignalAgeMs: 10 },
      { maxSignalAgeMs: CALIBRATION_LIMITS.signalAgeMaxMs + 1 },
      { copyExisting: "yes" },
    ]) {
      expect(copyFollowerSettingsSchema.safeParse({ ...settings, calibration }).success).toBe(false);
    }
  });

  it("keeps the broker's spelling of the follower's symbol in a mapping", () => {
    const parsed = copyFollowerSettingsSchema.safeParse({ ...settings, symbolMapping: { xauusd: "XAUUSDm", eurusd: "EURUSD.r" } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.symbolMapping).toEqual({ XAUUSD: "XAUUSDm", EURUSD: "EURUSD.r" });
  });
});
