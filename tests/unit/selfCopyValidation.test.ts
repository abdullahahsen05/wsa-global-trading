import { describe, expect, it } from "vitest";
import { selfCopyCreateSchema } from "@/lib/validation/schemas";
import { selfCopyGraphHasPath } from "@/lib/services/selfCopyService";

const settings = {
  copyEnabled: true,
  copyMode: "BALANCE_RATIO",
  fixedLot: null,
  lotMultiplier: null,
  riskPercent: null,
  minLot: 0.01,
  maxLot: 1,
  maxOpenTrades: 5,
  maxDailyLossPercent: 5,
  maxDrawdownPercent: 10,
  allowedSymbols: null,
  blockedSymbols: null,
  symbolMapping: {},
  copyNewTradesOnly: true,
  reverseCopy: false,
  pauseOnDisconnect: true,
  emergencyStop: false,
};

describe("self-copy validation", () => {
  it("detects paths used to prevent circular chains", () => {
    const edges = [
      { source: "a", follower: "b" },
      { source: "b", follower: "c" },
    ];
    expect(selfCopyGraphHasPath(edges, "a", "c")).toBe(true);
    expect(selfCopyGraphHasPath(edges, "c", "a")).toBe(false);
  });

  it("requires UUID account IDs and validated copy settings", () => {
    expect(selfCopyCreateSchema.safeParse({
      sourceAccountId: "00000000-0000-4000-8000-000000000001",
      followerAccountId: "00000000-0000-4000-8000-000000000002",
      copySettings: settings,
    }).success).toBe(true);
    expect(selfCopyCreateSchema.safeParse({
      sourceAccountId: "not-an-id",
      followerAccountId: "also-not-an-id",
      copySettings: settings,
    }).success).toBe(false);
  });
});
