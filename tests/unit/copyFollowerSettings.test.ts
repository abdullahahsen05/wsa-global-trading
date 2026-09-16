import { describe, expect, it } from "vitest";
import { copyFollowerSettingsSchema } from "@/lib/validation/schemas";
import {
  copyModeToScalingMode,
  followerSymbolCandidates,
  mapFollowerSymbol,
  reverseFollowerSide,
} from "@/lib/copy/settings";

const validSettings = {
  copyEnabled: true,
  copyMode: "LOT_MULTIPLIER" as const,
  fixedLot: null,
  lotMultiplier: 1.25,
  minLot: 0.01,
  maxLot: 2,
  maxOpenTrades: 5,
  maxDailyLossPercent: 5,
  maxDrawdownPercent: 10,
  allowedSymbols: ["XAUUSD"],
  blockedSymbols: ["BTCUSD"],
  symbolMapping: { XAUUSD: "GOLD" },
  copyNewTradesOnly: true as const,
  reverseCopy: false,
  pauseOnDisconnect: true,
  emergencyStop: false,
};

describe("advanced follower copy settings", () => {
  it("maps supported modes into the existing lot engine", () => {
    expect(copyModeToScalingMode("FIXED_LOT")).toBe("FIXED_LOT");
    expect(copyModeToScalingMode("LOT_MULTIPLIER")).toBe("FIXED_MULTIPLIER");
    expect(copyModeToScalingMode("BALANCE_RATIO")).toBe("BALANCE_PROPORTIONAL");
    expect(copyModeToScalingMode("RISK_PERCENT")).toBeNull();
  });

  it("rejects unsupported risk-percent mode honestly", () => {
    expect(copyFollowerSettingsSchema.safeParse({
      ...validSettings,
      copyMode: "RISK_PERCENT",
    }).success).toBe(false);
  });

  it("rejects max lot below min lot and conflicting symbol lists", () => {
    expect(copyFollowerSettingsSchema.safeParse({
      ...validSettings,
      minLot: 2,
      maxLot: 1,
    }).success).toBe(false);
    expect(copyFollowerSettingsSchema.safeParse({
      ...validSettings,
      blockedSymbols: ["XAUUSD"],
    }).success).toBe(false);
  });

  it("applies symbol mapping and reverse-copy direction deterministically", () => {
    expect(mapFollowerSymbol("xauusd", { XAUUSD: "GOLD" })).toBe("GOLD");
    expect(reverseFollowerSide("BUY", true)).toBe("SELL");
    expect(reverseFollowerSide("SELL", false)).toBe("SELL");
  });

  it("keeps the master symbol as the default follower symbol", () => {
    expect(mapFollowerSymbol("GOLD", {})).toBe("GOLD");
    expect(mapFollowerSymbol("gold", null)).toBe("GOLD");
    expect(mapFollowerSymbol("GOLD", { GOLD: "XAUUSD+" })).toBe("XAUUSD+");
  });

  it("tries exact master symbols before broker aliases", () => {
    expect(followerSymbolCandidates("GOLD", {})).toEqual(["GOLD", "XAUUSD"]);
    expect(followerSymbolCandidates("GOLD", { GOLD: "XAUUSD+" })).toEqual(["GOLD", "XAUUSD+", "XAUUSD"]);
    expect(followerSymbolCandidates("XAUUSD", null)).toEqual(["XAUUSD", "GOLD"]);
    expect(followerSymbolCandidates("EURUSD", { EURUSD: "EURUSD+" })).toEqual(["EURUSD", "EURUSD+"]);
  });
});
