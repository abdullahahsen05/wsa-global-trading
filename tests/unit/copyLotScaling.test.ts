import { describe, expect, test } from "vitest";
import { calculateFollowerLot, clampLot, roundToStep } from "@/lib/copy/lotScaling";

describe("roundToStep", () => {
  test("rounds to broker step without float dust", () => {
    expect(roundToStep(0.297, 0.01)).toBe(0.3);
    expect(roundToStep(1.234, 0.01)).toBe(1.23);
    expect(roundToStep(0.4, 0.1)).toBe(0.4);
  });
  test("invalid step → 0", () => {
    expect(roundToStep(1, 0)).toBe(0);
  });
});

describe("clampLot", () => {
  test("clamps to max and min", () => {
    expect(clampLot(5, 0.01, 2)).toBe(2);
    expect(clampLot(0.001, 0.01, 2)).toBe(0.01);
    expect(clampLot(1, 0.01, null)).toBe(1);
  });
});

describe("calculateFollowerLot", () => {
  test("EQUITY_PROPORTIONAL scales by equity ratio", () => {
    const r = calculateFollowerLot({
      masterLot: 1,
      masterEquity: 100000,
      followerEquity: 50000,
      scalingMode: "EQUITY_PROPORTIONAL",
    });
    expect(r.lot).toBe(0.5);
  });

  test("BALANCE_PROPORTIONAL scales by balance ratio with risk multiplier", () => {
    const r = calculateFollowerLot({
      masterLot: 2,
      masterBalance: 100000,
      followerBalance: 25000,
      scalingMode: "BALANCE_PROPORTIONAL",
      riskMultiplier: 2,
    });
    // 2 * (25000/100000) * 2 = 1.0
    expect(r.lot).toBe(1);
  });

  test("FIXED_MULTIPLIER multiplies master lot", () => {
    expect(calculateFollowerLot({ masterLot: 0.5, scalingMode: "FIXED_MULTIPLIER", riskMultiplier: 3 }).lot).toBe(1.5);
  });

  test("FIXED_LOT returns the fixed lot", () => {
    expect(calculateFollowerLot({ masterLot: 99, scalingMode: "FIXED_LOT", fixedLot: 0.2 }).lot).toBe(0.2);
  });

  test("clamps to maxLot", () => {
    const r = calculateFollowerLot({
      masterLot: 10,
      masterEquity: 100000,
      followerEquity: 100000,
      scalingMode: "EQUITY_PROPORTIONAL",
      maxLot: 2,
    });
    expect(r.lot).toBe(2);
  });

  test("zero/negative equity → lot 0 with reason (no divide-by-zero)", () => {
    const zero = calculateFollowerLot({ masterLot: 1, masterEquity: 0, followerEquity: 100, scalingMode: "EQUITY_PROPORTIONAL" });
    expect(zero.lot).toBe(0);
    expect(zero.reason).toBeTruthy();
    const neg = calculateFollowerLot({ masterLot: 1, masterEquity: 100, followerEquity: -50, scalingMode: "EQUITY_PROPORTIONAL" });
    expect(neg.lot).toBe(0);
  });

  test("missing fixed lot → 0", () => {
    expect(calculateFollowerLot({ masterLot: 1, scalingMode: "FIXED_LOT" }).lot).toBe(0);
  });

  test("RISK_PERCENT sizes from account risk and symbol tick specs", () => {
    const r = calculateFollowerLot({
      masterLot: 1,
      followerEquity: 10000,
      entryPrice: 2635,
      stopLoss: 2600,
      scalingMode: "RISK_PERCENT",
      riskPercent: 1,
      symbolSpecifications: {
        tickSize: 0.01,
        tickValue: 1,
      },
    });
    expect(r.riskAmount).toBe(100);
    expect(r.rawLot).toBeCloseTo(0.028571, 6);
    expect(r.lot).toBe(0.03);
  });

  test("RISK_PERCENT rejects missing stop loss or symbol specs safely", () => {
    const noStop = calculateFollowerLot({
      masterLot: 1,
      followerEquity: 10000,
      entryPrice: 2635,
      scalingMode: "RISK_PERCENT",
      riskPercent: 1,
    });
    expect(noStop.lot).toBe(0);
    expect(noStop.reason).toContain("Stop loss");

    const noSpecs = calculateFollowerLot({
      masterLot: 1,
      followerEquity: 10000,
      entryPrice: 2635,
      stopLoss: 2600,
      scalingMode: "RISK_PERCENT",
      riskPercent: 1,
    });
    expect(noSpecs.lot).toBe(0);
    expect(noSpecs.reason).toContain("Symbol specifications");
  });
});
