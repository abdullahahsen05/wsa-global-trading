import { describe, expect, test } from "vitest";
import { mapSymbolSpecifications } from "@/lib/broker/Api2TradeBrokerAdapter";
import { calculateFollowerLot } from "@/lib/copy/lotScaling";

describe("API2Trade risk-percent symbol specifications", () => {
  test("reads the nested Pro EURUSD answer using lot units, not raw MT volume units", () => {
    const specs = mapSymbolSpecifications("EURUSD", {
      symbolInfo: { points: 0.00001, tickValue: 0, contractSize: 100000, profitCurrency: "USD" },
      symbolGroup: { minLots: 0.01, maxLots: 500, lotsStep: 0.01, minVolume: 1000000, volumeStep: 1000000 },
    }, "USD");
    expect(specs).toMatchObject({
      tickSize: 0.00001, tickValue: null, contractSize: 100000,
      volumeStep: 0.01, minVolume: 0.01, maxVolume: 500,
      accountCurrency: "USD", profitCurrency: "USD", accountCurrencyConversionRate: 1,
    });
    const lot = calculateFollowerLot({
      masterLot: 0.01, entryPrice: 1.11744, stopLoss: 2.11744,
      masterEquity: 100000, masterBalance: 100000,
      followerEquity: 100000, followerBalance: 100000,
      scalingMode: "RISK_PERCENT", riskPercent: 5, riskMultiplier: null,
      lotMultiplier: null, fixedLot: null, minLot: null, maxLot: null,
      symbolSpecifications: specs,
    });
    expect(lot.lot).toBe(0.05);
  });

  test("retains flat responses and refuses to guess missing financial specifications", () => {
    expect(mapSymbolSpecifications("XAUUSD", {
      tickSize: 0.01, tickValue: 1, volumeStep: 0.01, minVolume: 0.01, profitCurrency: "USD",
    }, "USD")).toMatchObject({ tickSize: 0.01, tickValue: 1, volumeStep: 0.01 });
    expect(mapSymbolSpecifications("EURUSD", { symbolInfo: {}, symbolGroup: {} }, "USD")?.contractSize).toBeNull();
  });
});
