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

  test("BALANCE_PROPORTIONAL scales only by master balance over follower balance", () => {
    const r = calculateFollowerLot({
      masterLot: 2,
      masterBalance: 100000,
      followerBalance: 25000,
      scalingMode: "BALANCE_PROPORTIONAL",
      riskMultiplier: 2,
    });
    // 2 * (100000/25000) = 8.0; multiplier is intentionally ignored.
    expect(r.lot).toBe(8);
  });

  test("BALANCE_PROPORTIONAL follows the balance-ratio formula", () => {
    expect(calculateFollowerLot({
      masterLot: 1,
      masterBalance: 10000,
      followerBalance: 5000,
      scalingMode: "BALANCE_PROPORTIONAL",
    }).lot).toBe(2);

    expect(calculateFollowerLot({
      masterLot: 1,
      masterBalance: 10000,
      followerBalance: 20000,
      scalingMode: "BALANCE_PROPORTIONAL",
    }).lot).toBe(0.5);
  });

  test("BALANCE_PROPORTIONAL ignores lot and risk multipliers", () => {
    expect(calculateFollowerLot({
      masterLot: 0.2,
      masterBalance: 10000,
      followerBalance: 10000,
      scalingMode: "BALANCE_PROPORTIONAL",
      lotMultiplier: 10,
      riskMultiplier: 2,
    }).lot).toBe(0.2);
  });

  test("FIXED_MULTIPLIER multiplies master lot", () => {
    expect(calculateFollowerLot({ masterLot: 0.5, scalingMode: "FIXED_MULTIPLIER", riskMultiplier: 3 }).lot).toBe(1.5);
  });

  test("FIXED_MULTIPLIER uses the follower lot multiplier as master lot times multiplier", () => {
    expect(calculateFollowerLot({ masterLot: 0.01, scalingMode: "FIXED_MULTIPLIER", lotMultiplier: 5 }).lot).toBe(0.05);
    expect(calculateFollowerLot({ masterLot: 0.09, scalingMode: "FIXED_MULTIPLIER", lotMultiplier: 2 }).lot).toBe(0.18);
  });

  test("FIXED_MULTIPLIER accepts decimal multipliers", () => {
    expect(calculateFollowerLot({ masterLot: 1, scalingMode: "FIXED_MULTIPLIER", lotMultiplier: 1.1 }).lot).toBe(1.1);
    expect(calculateFollowerLot({ masterLot: 1, scalingMode: "FIXED_MULTIPLIER", lotMultiplier: 1.2 }).lot).toBe(1.2);
    expect(calculateFollowerLot({ masterLot: 1, scalingMode: "FIXED_MULTIPLIER", lotMultiplier: 0.3 }).lot).toBe(0.3);
    expect(calculateFollowerLot({ masterLot: 1, scalingMode: "FIXED_MULTIPLIER", lotMultiplier: 0.4 }).lot).toBe(0.4);
  });

  test("FIXED_MULTIPLIER requires an explicit saved multiplier", () => {
    const result = calculateFollowerLot({ masterLot: 0.09, scalingMode: "FIXED_MULTIPLIER" });
    expect(result.lot).toBe(0);
    expect(result.reason).toContain("Lot multiplier");
  });

  test("FIXED_MULTIPLIER prefers lotMultiplier over legacy riskMultiplier", () => {
    expect(calculateFollowerLot({
      masterLot: 0.09,
      scalingMode: "FIXED_MULTIPLIER",
      lotMultiplier: 5,
      riskMultiplier: 1,
    }).lot).toBe(0.45);
  });

  test("FIXED_LOT returns the fixed lot", () => {
    expect(calculateFollowerLot({ masterLot: 99, scalingMode: "FIXED_LOT", fixedLot: 0.2 }).lot).toBe(0.2);
  });

  test("FIXED_LOT follows the follower lot instead of mirroring the tiny master lot", () => {
    expect(calculateFollowerLot({ masterLot: 0.01, scalingMode: "FIXED_LOT", fixedLot: 5 }).lot).toBe(5);
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

  test("RISK_PERCENT uses broker volume step, min and max from symbol specs", () => {
    const roundedByBrokerStep = calculateFollowerLot({
      masterLot: 1,
      followerEquity: 10000,
      entryPrice: 1.2,
      stopLoss: 1.19,
      scalingMode: "RISK_PERCENT",
      riskPercent: 1,
      symbolSpecifications: {
        tickSize: 0.0001,
        tickValue: 10,
        volumeStep: 0.1,
        minVolume: 0.1,
        maxVolume: 1,
      },
    });
    expect(roundedByBrokerStep.rawLot).toBeCloseTo(0.1, 6);
    expect(roundedByBrokerStep.lot).toBe(0.1);

    const cappedByBrokerMax = calculateFollowerLot({
      masterLot: 1,
      followerEquity: 100000,
      entryPrice: 1.2,
      stopLoss: 1.19,
      scalingMode: "RISK_PERCENT",
      riskPercent: 5,
      symbolSpecifications: {
        tickSize: 0.0001,
        tickValue: 10,
        volumeStep: 0.01,
        maxVolume: 2,
      },
    });
    expect(cappedByBrokerMax.lot).toBe(2);
  });

  test("RISK_PERCENT applies account currency conversion and rejects missing required conversion", () => {
    const converted = calculateFollowerLot({
      masterLot: 1,
      followerEquity: 10000,
      entryPrice: 100,
      stopLoss: 90,
      scalingMode: "RISK_PERCENT",
      riskPercent: 1,
      symbolSpecifications: {
        tickSize: 1,
        tickValue: 50,
        accountCurrency: "USD",
        profitCurrency: "EUR",
        accountCurrencyConversionRate: 2,
      },
    });
    // $100 risk / ((10 ticks * €50) * 2 USD/EUR) = 0.10
    expect(converted.lot).toBe(0.1);

    const missingConversion = calculateFollowerLot({
      masterLot: 1,
      followerEquity: 10000,
      entryPrice: 100,
      stopLoss: 90,
      scalingMode: "RISK_PERCENT",
      riskPercent: 1,
      symbolSpecifications: {
        tickSize: 1,
        tickValue: 50,
        accountCurrency: "USD",
        profitCurrency: "EUR",
      },
    });
    expect(missingConversion.lot).toBe(0);
    expect(missingConversion.reason).toContain("conversion rate");
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
