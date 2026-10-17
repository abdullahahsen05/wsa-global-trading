import { describe, expect, it } from "vitest";
import {
  evaluateSelfCopyGates,
  isExistingForRoute,
  LIVE_SINCE_SKEW_MS,
  readSelfCopySettings,
  RESCUE_WINDOW_MS,
  symbolListMatches,
  type SelfCopyCode,
  type SelfCopyGateInput,
  type SelfCopyPlatformFacts,
  type SelfCopySettings,
} from "@/lib/copy/selfCopyDecision";

const PLATFORM: SelfCopyPlatformFacts = {
  copyEnabled: true,
  liveCopyEnabled: true,
  emergencyStop: false,
  executionAvailable: true,
  maxLotSize: null,
  maxCopiedOpenPositions: null,
  maxDailyLossPercent: null,
  maxDrawdownPercent: null,
};

function input(
  overrides: {
    platform?: Partial<SelfCopyPlatformFacts>;
    route?: SelfCopyGateInput["route"];
    settings?: Partial<SelfCopySettings>;
    sourceStatus?: string | null;
    followerStatus?: string | null;
    follower?: Partial<SelfCopyGateInput["follower"]>;
    event?: Partial<SelfCopyGateInput["event"]>;
    alreadyCopied?: string | null;
    lot?: SelfCopyGateInput["lot"];
    levelsUnavailable?: string | null;
  } = {},
): SelfCopyGateInput {
  return {
    platform: { ...PLATFORM, ...overrides.platform },
    route: overrides.route ?? { status: "LIVE" },
    settings: { ...readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 0.5 }), ...overrides.settings },
    sourceStatus: overrides.sourceStatus === undefined ? "CONNECTED" : overrides.sourceStatus,
    followerStatus: overrides.followerStatus === undefined ? "CONNECTED" : overrides.followerStatus,
    follower: { riskBlocked: false, riskMessage: null, openCopies: 0, dailyLossPercent: null, drawdownPercent: null, ...overrides.follower },
    event: { symbol: "EURUSD", followerSymbol: "EURUSD", existing: false, ageMs: 40, ...overrides.event },
    alreadyCopied: overrides.alreadyCopied ?? null,
    lot: overrides.lot === undefined ? { lot: 0.5, reason: null } : overrides.lot,
    levelsUnavailable: overrides.levelsUnavailable ?? null,
  };
}

function codeOf(overrides: Parameters<typeof input>[0]): SelfCopyCode {
  return evaluateSelfCopyGates(input(overrides)).code;
}

describe("evaluateSelfCopyGates", () => {
  it("lets a normal trade through and lists the gates it passed", () => {
    const result = evaluateSelfCopyGates(input());
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("COPY");
    expect(result.message).toBe("Copy.");
    expect(result.checks.some((check) => check.status === "fail")).toBe(false);
    expect(result.checks.find((check) => check.id === "PLATFORM_LIVE_DISABLED")?.status).toBe("pass");
  });

  it.each<[string, Parameters<typeof input>[0], SelfCopyCode]>([
    ["copy trading paused on the platform", { platform: { copyEnabled: false } }, "PLATFORM_COPY_PAUSED"],
    ["emergency stop", { platform: { emergencyStop: true } }, "PLATFORM_EMERGENCY_STOP"],
    ["live copying switched off", { platform: { liveCopyEnabled: false } }, "PLATFORM_LIVE_DISABLED"],
    ["execution not allowed on this server", { platform: { executionAvailable: false } }, "EXECUTION_DISABLED"],
    ["route paused", { route: { status: "PAUSED" } }, "ROUTE_NOT_LIVE"],
    ["route removed", { route: { status: "ARCHIVED" } }, "ROUTE_NOT_LIVE"],
    ["route switched off", { settings: { copyEnabled: false } }, "ROUTE_COPY_OFF"],
    ["route emergency stop", { settings: { emergencyStop: true } }, "ROUTE_EMERGENCY_STOP"],
    ["follower disconnected", { followerStatus: "DISCONNECTED" }, "FOLLOWER_NOT_READY"],
    ["already copied", { alreadyCopied: "This position was copied already." }, "ALREADY_COPIED"],
    ["risk rules block the follower", { follower: { riskBlocked: true, riskMessage: "Daily loss rule" } }, "RISK_BLOCKED"],
    ["lot of zero", { lot: { lot: 0, reason: "Below minimum lot" } }, "LOT_INVALID"],
    ["levels that cannot be worked out", { levelsUnavailable: "The stop loss in points needs the entry price." }, "LEVELS_UNAVAILABLE"],
  ])("blocks: %s", (_name, overrides, expected) => {
    const result = evaluateSelfCopyGates(input(overrides));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe(expected);
    expect(result.message.length).toBeGreaterThan(10);
    expect(result.checks.find((check) => check.id === expected)?.status).toBe("fail");
  });

  it("says what is wrong in words a person can act on", () => {
    expect(evaluateSelfCopyGates(input({ platform: { liveCopyEnabled: false } })).message).toMatch(/Admin|administrator/i);
    expect(evaluateSelfCopyGates(input({ route: { status: "PAUSED" } })).message).toMatch(/paused/);
    expect(evaluateSelfCopyGates(input({ route: { status: "ARCHIVED" } })).message).toMatch(/removed/);
    expect(evaluateSelfCopyGates(input({ follower: { riskBlocked: true, riskMessage: "Max drawdown rule" } })).message).toBe("Max drawdown rule");
    expect(evaluateSelfCopyGates(input({ lot: { lot: 0, reason: "Master balance unavailable" } })).message).toMatch(/Master balance unavailable/);
  });

  it("evaluates every gate and lets the first failing one decide", () => {
    const result = evaluateSelfCopyGates(
      input({ platform: { copyEnabled: false, liveCopyEnabled: false }, settings: { copyEnabled: false } }),
    );
    expect(result.code).toBe("PLATFORM_COPY_PAUSED");
    const failed = result.checks.filter((check) => check.status === "fail").map((check) => check.id);
    expect(failed).toEqual(["PLATFORM_COPY_PAUSED", "PLATFORM_LIVE_DISABLED", "ROUTE_COPY_OFF"]);
  });

  describe("accounts", () => {
    it("accepts a follower that is still doing its first sync, or whose status is not known", () => {
      expect(codeOf({ followerStatus: "SYNCING" })).toBe("COPY");
      expect(codeOf({ followerStatus: null })).toBe("COPY");
    });

    it("lets a disconnected follower through when the route does not pause on disconnect", () => {
      expect(codeOf({ followerStatus: "DISCONNECTED", settings: { pauseOnDisconnect: false } })).toBe("COPY");
    });

    it("only warns about a source account that is not connected", () => {
      const result = evaluateSelfCopyGates(input({ sourceStatus: "ERROR" }));
      expect(result.allowed).toBe(true);
      expect(result.checks.find((check) => check.id === "SOURCE_NOT_READY")?.status).toBe("warn");
    });
  });

  describe("new trades only", () => {
    it("skips a trade that was open when copying started", () => {
      expect(codeOf({ event: { existing: true } })).toBe("EXISTING_POSITION");
    });

    it("copies it when the route asks for existing positions", () => {
      const settings = readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1, calibration: { copyExisting: true } });
      expect(codeOf({ settings, event: { existing: true } })).toBe("COPY");
    });
  });

  describe("signal age", () => {
    const limited = readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1, calibration: { maxSignalAgeMs: 2000 } });

    it("skips a trade that was already too old when it was noticed", () => {
      const result = evaluateSelfCopyGates(input({ settings: limited, event: { ageMs: 5000 } }));
      expect(result.code).toBe("SIGNAL_TOO_OLD");
      expect(result.message).toMatch(/5 s/);
      expect(result.message).toMatch(/2 s/);
    });

    it("copies a trade that is within the limit, or whose age is not known", () => {
      expect(codeOf({ settings: limited, event: { ageMs: 1500 } })).toBe("COPY");
      expect(codeOf({ settings: limited, event: { ageMs: null } })).toBe("COPY");
    });

    it("does not apply the limit to positions that were already open", () => {
      const settings = readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1, calibration: { maxSignalAgeMs: 2000, copyExisting: true } });
      expect(codeOf({ settings, event: { existing: true, ageMs: 600_000 } })).toBe("COPY");
    });
  });

  describe("symbol lists", () => {
    it("blocks a symbol on the blocked list, also under the broker's spelling", () => {
      const settings = readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1, blockedSymbols: ["XAUUSD"] });
      expect(codeOf({ settings, event: { symbol: "XAUUSD", followerSymbol: "XAUUSDm" } })).toBe("SYMBOL_BLOCKED");
      expect(codeOf({ settings, event: { symbol: "EURUSD", followerSymbol: "EURUSD" } })).toBe("COPY");
    });

    it("lets only the allowed symbols through", () => {
      const settings = readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1, allowedSymbols: ["EURUSD", "GOLD"] });
      expect(codeOf({ settings, event: { symbol: "GBPUSD", followerSymbol: "GBPUSD" } })).toBe("SYMBOL_NOT_ALLOWED");
      expect(codeOf({ settings, event: { symbol: "EURUSD", followerSymbol: "EURUSD.r" } })).toBe("COPY");
      // the gold alias: the list says GOLD, the trade is XAUUSD
      expect(codeOf({ settings, event: { symbol: "XAUUSD", followerSymbol: "XAUUSDm" } })).toBe("COPY");
    });
  });

  describe("limits", () => {
    it("stops at the maximum number of open copies, whichever limit is stricter", () => {
      const settings = readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1, maxOpenTrades: 3 });
      expect(codeOf({ settings, follower: { openCopies: 3 } })).toBe("MAX_OPEN_TRADES");
      expect(codeOf({ settings, follower: { openCopies: 2 } })).toBe("COPY");
      expect(codeOf({ settings, platform: { maxCopiedOpenPositions: 2 }, follower: { openCopies: 2 } })).toBe("MAX_OPEN_TRADES");
    });

    it("stops at the daily loss limit and the drawdown limit", () => {
      const settings = readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1, maxDailyLossPercent: 5, maxDrawdownPercent: 10 });
      expect(codeOf({ settings, follower: { dailyLossPercent: 5 } })).toBe("DAILY_LOSS_LIMIT");
      expect(codeOf({ settings, follower: { dailyLossPercent: 4.9 } })).toBe("COPY");
      expect(codeOf({ settings, follower: { drawdownPercent: 12 } })).toBe("DRAWDOWN_LIMIT");
      expect(codeOf({ settings, platform: { maxDrawdownPercent: 8 }, follower: { drawdownPercent: 9 } })).toBe("DRAWDOWN_LIMIT");
    });

    it("does not block on a figure it does not have yet", () => {
      const settings = readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1, maxDailyLossPercent: 5, maxDrawdownPercent: 10 });
      const result = evaluateSelfCopyGates(input({ settings, follower: { dailyLossPercent: null, drawdownPercent: null } }));
      expect(result.allowed).toBe(true);
      expect(result.checks.find((check) => check.id === "DAILY_LOSS_LIMIT")?.status).toBe("info");
    });

    it("stops a lot above the platform limit", () => {
      expect(codeOf({ platform: { maxLotSize: 1 }, lot: { lot: 2, reason: null } })).toBe("PLATFORM_MAX_LOT");
      expect(codeOf({ platform: { maxLotSize: 1 }, lot: { lot: 1, reason: null } })).toBe("COPY");
    });
  });

  it("only informs about the lot when it has not been worked out", () => {
    const result = evaluateSelfCopyGates(input({ lot: null }));
    expect(result.allowed).toBe(true);
    expect(result.checks.find((check) => check.id === "LOT_INVALID")?.status).toBe("info");
  });
});

describe("readSelfCopySettings", () => {
  it("fills everything in for a route without stored settings", () => {
    const settings = readSelfCopySettings(null);
    expect(settings).toMatchObject({
      copyEnabled: true,
      emergencyStop: false,
      pauseOnDisconnect: true,
      reverseCopy: false,
      copyMode: "BALANCE_RATIO",
      fixedLot: null,
      allowedSymbols: null,
      blockedSymbols: null,
      symbolMapping: {},
    });
    expect(settings.calibration.copyStopLoss).toBe(true);
    expect(settings.calibration.copyExisting).toBe(false);
  });

  it("reads what the route form stores, however loosely typed", () => {
    const settings = readSelfCopySettings({
      copyEnabled: true,
      copyMode: "FIXED_LOT",
      fixedLot: "0.5",
      lotMultiplier: 2,
      riskPercent: null,
      minLot: 0.01,
      maxLot: -3,
      maxOpenTrades: "5",
      maxDailyLossPercent: 5,
      maxDrawdownPercent: 10,
      allowedSymbols: ["EURUSD", " ", 5, " GBPUSD "],
      blockedSymbols: [],
      symbolMapping: { xauusd: "GOLD", "": "x", eurusd: " " },
      copyNewTradesOnly: true,
      reverseCopy: true,
      pauseOnDisconnect: false,
      emergencyStop: true,
      calibration: { copyTakeProfit: false, stopLossPoints: 120 },
    });
    expect(settings.copyMode).toBe("FIXED_LOT");
    expect(settings.fixedLot).toBe(0.5);
    expect(settings.lotMultiplier).toBe(2);
    expect(settings.maxLot).toBeNull();
    expect(settings.maxOpenTrades).toBe(5);
    expect(settings.allowedSymbols).toEqual(["EURUSD", "GBPUSD"]);
    expect(settings.blockedSymbols).toBeNull();
    expect(settings.symbolMapping).toEqual({ XAUUSD: "GOLD" });
    expect(settings.reverseCopy).toBe(true);
    expect(settings.pauseOnDisconnect).toBe(false);
    expect(settings.emergencyStop).toBe(true);
    expect(settings.calibration).toMatchObject({ copyTakeProfit: false, copyStopLoss: true, stopLossPoints: 120 });
  });

  it("falls back to the balance ratio for a copy mode it does not know", () => {
    expect(readSelfCopySettings({ copyMode: "MAGIC" }).copyMode).toBe("BALANCE_RATIO");
    expect(readSelfCopySettings({ copyMode: "RISK_PERCENT" }).copyMode).toBe("RISK_PERCENT");
  });

  it("reads when the route went live, as an ISO text or as epoch milliseconds", () => {
    expect(readSelfCopySettings(null).liveSince).toBeNull();
    expect(readSelfCopySettings({ liveSince: "2026-10-12T20:00:00.000Z" }).liveSince).toBe(Date.parse("2026-10-12T20:00:00.000Z"));
    expect(readSelfCopySettings({ liveSince: 1_760_000_000_000 }).liveSince).toBe(1_760_000_000_000);
    for (const damaged of ["", "yesterday", 0, -5, Number.NaN, {}, []]) {
      expect(readSelfCopySettings({ liveSince: damaged }).liveSince).toBeNull();
    }
  });
});

describe("isExistingForRoute", () => {
  const LIVE_SINCE = Date.parse("2026-10-12T20:00:00.000Z");
  const settings = (calibration: Record<string, unknown> = {}) =>
    readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1, liveSince: LIVE_SINCE, calibration });

  it("is false for a trade the stream saw opening", () => {
    expect(isExistingForRoute({ existing: false, openedAt: LIVE_SINCE - 3_600_000, ageMs: 30 }, settings())).toBe(false);
  });

  it("is true for a trade found in the first look that opened before the route went live", () => {
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE - 60_000, ageMs: 60_000 }, settings())).toBe(true);
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE - LIVE_SINCE_SKEW_MS - 1, ageMs: 10 }, settings())).toBe(true);
  });

  it("is false for a trade found in the first look that opened right after the route went live", () => {
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE + 8_000, ageMs: 4_000 }, settings())).toBe(false);
  });

  it("allows for the broker's clock being a few seconds off", () => {
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE - LIVE_SINCE_SKEW_MS + 1, ageMs: 4_000 }, settings())).toBe(false);
  });

  it("stays strict when the route's start or the trade's open time is unknown", () => {
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE + 5_000, ageMs: 1_000 }, readSelfCopySettings({ copyMode: "FIXED_LOT", fixedLot: 1 }))).toBe(true);
    expect(isExistingForRoute({ existing: true, openedAt: null, ageMs: null }, settings())).toBe(true);
  });

  it("does not rescue a trade that has been open for long, even if it opened after the route went live", () => {
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE + 1_000, ageMs: RESCUE_WINDOW_MS + 1 }, settings())).toBe(true);
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE + 1_000, ageMs: RESCUE_WINDOW_MS - 1 }, settings())).toBe(false);
  });

  it("uses the route's own signal age as the freshness limit when it has one", () => {
    const strict = settings({ maxSignalAgeMs: 2_000 });
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE + 1_000, ageMs: 1_500 }, strict)).toBe(false);
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE + 1_000, ageMs: 2_500 }, strict)).toBe(true);
    const relaxed = settings({ maxSignalAgeMs: 30 * 60_000 });
    expect(isExistingForRoute({ existing: true, openedAt: LIVE_SINCE + 1_000, ageMs: 10 * 60_000 }, relaxed)).toBe(false);
  });
});

describe("symbolListMatches", () => {
  it("matches the exact name, the instrument under the broker's marking, and the gold alias", () => {
    expect(symbolListMatches(["eurusd"], "EURUSD")).toBe(true);
    expect(symbolListMatches(["XAUUSD"], "XAUUSDm")).toBe(true);
    expect(symbolListMatches(["gold"], "XAUUSD")).toBe(true);
    expect(symbolListMatches(["EURUSD"], "GBPUSD", "GBPUSD.r")).toBe(false);
  });

  it("ignores empty entries and empty names", () => {
    expect(symbolListMatches(["", "  "], "EURUSD")).toBe(false);
    expect(symbolListMatches(["EURUSD"], "")).toBe(false);
    expect(symbolListMatches([], "EURUSD")).toBe(false);
  });
});
