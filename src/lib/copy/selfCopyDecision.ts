/**
 * Self-copy decisions: should this position of the source account be copied to the follower,
 * and if not, why not. Pure - every fact is handed in, nothing is read here.
 *
 * Before this module the executor skipped a trade at any of a dozen places without leaving a
 * trace, so "self-copy does nothing" could not be told apart from "the route is switched off".
 * Now every gate has a code and a sentence a person can act on; the same function drives the
 * live copy (first failing gate wins) and the "check this route" button (all gates are shown).
 */

import { coreSymbol, sameInstrument } from "@/lib/trade/symbolMatch";
import { readCalibration, type CopyCalibration } from "@/lib/copy/calibration";
import type { FollowerCopyMode } from "@/lib/copy/settings";

export type SelfCopyCode =
  | "COPY"
  | "PLATFORM_COPY_PAUSED"
  | "PLATFORM_EMERGENCY_STOP"
  | "PLATFORM_LIVE_DISABLED"
  | "EXECUTION_DISABLED"
  | "ROUTE_NOT_LIVE"
  | "ROUTE_COPY_OFF"
  | "ROUTE_EMERGENCY_STOP"
  | "SOURCE_NOT_READY"
  | "FOLLOWER_NOT_READY"
  | "EXISTING_POSITION"
  | "SIGNAL_TOO_OLD"
  | "ALREADY_COPIED"
  | "RISK_BLOCKED"
  | "SYMBOL_BLOCKED"
  | "SYMBOL_NOT_ALLOWED"
  | "MAX_OPEN_TRADES"
  | "DAILY_LOSS_LIMIT"
  | "DRAWDOWN_LIMIT"
  | "LOT_INVALID"
  | "PLATFORM_MAX_LOT"
  | "LEVELS_UNAVAILABLE";

export type SelfCopyCheckStatus = "pass" | "fail" | "warn" | "info";

export interface SelfCopyCheck {
  /** the gate (same names as the decision codes; a few passing gates have their own) */
  id: string;
  label: string;
  status: SelfCopyCheckStatus;
  /** one sentence for the person */
  detail: string;
}

export interface SelfCopySettings {
  copyEnabled: boolean;
  emergencyStop: boolean;
  pauseOnDisconnect: boolean;
  reverseCopy: boolean;
  copyMode: FollowerCopyMode;
  fixedLot: number | null;
  lotMultiplier: number | null;
  riskPercent: number | null;
  minLot: number | null;
  maxLot: number | null;
  maxOpenTrades: number | null;
  maxDailyLossPercent: number | null;
  maxDrawdownPercent: number | null;
  allowedSymbols: string[] | null;
  blockedSymbols: string[] | null;
  symbolMapping: Record<string, string>;
  calibration: CopyCalibration;
  /**
   * When the route went live (epoch ms): set when it is created and every time it is resumed, never by
   * the person. Trades that opened after this moment are new trades for the route even when the worker
   * only noticed them in the first look at the account (see `isExistingForRoute`). null = unknown.
   */
  liveSince: number | null;
}

const COPY_MODES: ReadonlySet<string> = new Set(["FIXED_LOT", "LOT_MULTIPLIER", "BALANCE_RATIO", "RISK_PERCENT"]);

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function symbolsOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const symbols = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  return symbols.length > 0 ? symbols : null;
}

/** An instant stored as an ISO text or as epoch milliseconds. */
function instantOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function mappingOf(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const mapping: Record<string, string> = {};
  for (const [key, target] of Object.entries(value as Record<string, unknown>)) {
    if (typeof target === "string" && key.trim() && target.trim()) mapping[key.trim().toUpperCase()] = target.trim();
  }
  return mapping;
}

/** Reads the stored `copy_settings` (damaged or from an older version included) as complete settings. */
export function readSelfCopySettings(raw: unknown): SelfCopySettings {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const copyMode = typeof source.copyMode === "string" && COPY_MODES.has(source.copyMode) ? (source.copyMode as FollowerCopyMode) : "BALANCE_RATIO";
  return {
    copyEnabled: source.copyEnabled !== false,
    emergencyStop: source.emergencyStop === true,
    pauseOnDisconnect: source.pauseOnDisconnect !== false,
    reverseCopy: source.reverseCopy === true,
    copyMode,
    fixedLot: numberOrNull(source.fixedLot),
    lotMultiplier: numberOrNull(source.lotMultiplier),
    riskPercent: numberOrNull(source.riskPercent),
    minLot: numberOrNull(source.minLot),
    maxLot: numberOrNull(source.maxLot),
    maxOpenTrades: numberOrNull(source.maxOpenTrades),
    maxDailyLossPercent: numberOrNull(source.maxDailyLossPercent),
    maxDrawdownPercent: numberOrNull(source.maxDrawdownPercent),
    allowedSymbols: symbolsOrNull(source.allowedSymbols),
    blockedSymbols: symbolsOrNull(source.blockedSymbols),
    symbolMapping: mappingOf(source.symbolMapping),
    calibration: readCalibration(source.calibration),
    liveSince: instantOrNull(source.liveSince),
  };
}

/** The broker's clock and ours may differ a little: a trade this close before "live" still counts as new. */
export const LIVE_SINCE_SKEW_MS = 5_000;
/** A trade noticed late is rescued as new only while it is this fresh, unless the route sets its own signal age. */
export const RESCUE_WINDOW_MS = 5 * 60_000;

/**
 * Was this trade already open when copying started?
 *
 * The stream calls everything it finds in its FIRST look at an account "existing". Most of that
 * really is old, but a trade the person opened right after creating (or resuming) the route is also
 * in that first look when the stream opens a moment later - or after a worker restart. Judged by its
 * open time against `liveSince` it is a new trade for this route, as long as it is still fresh.
 */
export function isExistingForRoute(
  event: { existing: boolean; openedAt: number | null; ageMs: number | null },
  settings: Pick<SelfCopySettings, "liveSince" | "calibration">,
): boolean {
  if (!event.existing) return false;
  if (settings.liveSince === null || event.openedAt === null) return true;
  if (event.openedAt < settings.liveSince - LIVE_SINCE_SKEW_MS) return true;
  const freshFor = settings.calibration.maxSignalAgeMs ?? RESCUE_WINDOW_MS;
  return event.ageMs !== null && event.ageMs > freshFor;
}

/** A symbol list entry names the instrument: exact (any case), same instrument without the broker's marking, or the gold alias. */
export function symbolListMatches(list: ReadonlyArray<string>, ...names: ReadonlyArray<string>): boolean {
  for (const entry of list) {
    const wanted = entry.trim();
    if (!wanted) continue;
    for (const name of names) {
      if (!name) continue;
      if (name.toLowerCase() === wanted.toLowerCase()) return true;
      if (coreSymbol(name) !== "" && (coreSymbol(name) === coreSymbol(wanted) || sameInstrument(name, wanted))) return true;
    }
  }
  return false;
}

// ── facts ────────────────────────────────────────────────────────────────────

export interface SelfCopyPlatformFacts {
  copyEnabled: boolean;
  liveCopyEnabled: boolean;
  emergencyStop: boolean;
  /** the bridge may place orders at all (BROKER_EXECUTION_ENABLED) */
  executionAvailable: boolean;
  maxLotSize: number | null;
  maxCopiedOpenPositions: number | null;
  maxDailyLossPercent: number | null;
  maxDrawdownPercent: number | null;
}

export interface SelfCopyGateInput {
  platform: SelfCopyPlatformFacts;
  route: { status: "LIVE" | "PAUSED" | "ARCHIVED" };
  settings: SelfCopySettings;
  sourceStatus: string | null;
  followerStatus: string | null;
  follower: {
    riskBlocked: boolean;
    riskMessage: string | null;
    /** copies of this follower that are open (or being opened) right now */
    openCopies: number;
    dailyLossPercent: number | null;
    drawdownPercent: number | null;
  };
  event: {
    symbol: string;
    /** the symbol the order will carry */
    followerSymbol: string;
    existing: boolean;
    /** how long the trade had been open when it was noticed (null = unknown) */
    ageMs: number | null;
  };
  /** set when this position was copied (or is being copied) on this route already: what to tell the person */
  alreadyCopied: string | null;
  /** the lot the sizing rule gives; null when it was not worked out */
  lot: { lot: number; reason: string | null } | null;
  /** a level the person asked for could not be worked out (see `protectiveLevels`) */
  levelsUnavailable: string | null;
}

export interface SelfCopyGateResult {
  allowed: boolean;
  code: SelfCopyCode;
  /** the sentence for the first failing gate, or "Copy." */
  message: string;
  checks: SelfCopyCheck[];
}

function limitOf(...values: Array<number | null | undefined>): number | null {
  const limits = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return limits.length > 0 ? Math.min(...limits) : null;
}

function percent(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms / 1000)} s`;
}

/** The statuses a follower may copy in: connected, or still doing its first sync. */
const READY_STATUSES: ReadonlySet<string> = new Set(["CONNECTED", "SYNCING"]);

export function evaluateSelfCopyGates(input: SelfCopyGateInput): SelfCopyGateResult {
  const { platform, settings, event, follower } = input;
  const checks: SelfCopyCheck[] = [];
  let first: { code: SelfCopyCode; message: string } | null = null;

  const gate = (code: SelfCopyCode, label: string, failed: boolean, failMessage: string, passDetail: string) => {
    if (failed) {
      checks.push({ id: code, label, status: "fail", detail: failMessage });
      first ??= { code, message: failMessage };
    } else {
      checks.push({ id: code, label, status: "pass", detail: passDetail });
    }
  };
  const note = (id: string, label: string, status: SelfCopyCheckStatus, detail: string) => {
    checks.push({ id, label, status, detail });
  };

  gate(
    "PLATFORM_COPY_PAUSED",
    "Copy trading on the platform",
    !platform.copyEnabled,
    "Copy trading is paused for the whole platform. An administrator has to switch it back on.",
    "Copy trading is switched on.",
  );
  gate(
    "PLATFORM_EMERGENCY_STOP",
    "Emergency stop",
    platform.emergencyStop,
    "The platform's emergency stop is on, so no copy is placed.",
    "The emergency stop is off.",
  );
  gate(
    "PLATFORM_LIVE_DISABLED",
    "Live copying",
    !platform.liveCopyEnabled,
    "Live copying is switched off for the whole platform (Admin, Copy trading, settings). An administrator has to enable it.",
    "Live copying is enabled.",
  );
  gate(
    "EXECUTION_DISABLED",
    "Order placement",
    !platform.executionAvailable,
    "This server is not allowed to place broker orders (BROKER_EXECUTION_ENABLED is not true).",
    "Orders can be placed.",
  );
  gate(
    "ROUTE_NOT_LIVE",
    "Route status",
    input.route.status !== "LIVE",
    `This route is ${input.route.status === "PAUSED" ? "paused" : "removed"}. Resume it to copy.`,
    "The route is live.",
  );
  gate(
    "ROUTE_COPY_OFF",
    "Copying on this route",
    !settings.copyEnabled,
    "Copying is switched off in this route's settings.",
    "Copying is on.",
  );
  gate(
    "ROUTE_EMERGENCY_STOP",
    "Route emergency stop",
    settings.emergencyStop,
    "The emergency stop of this route is on.",
    "The route's emergency stop is off.",
  );

  const sourceReady = input.sourceStatus === null || READY_STATUSES.has(input.sourceStatus);
  if (sourceReady) {
    note("SOURCE_NOT_READY", "Source account", "pass", `The source account is ${input.sourceStatus ?? "known"}.`);
  } else {
    // a stream only exists while the source answers, so this is a warning for the person, not a gate
    note("SOURCE_NOT_READY", "Source account", "warn", `The source account is ${input.sourceStatus}. New trades there may not be seen.`);
  }

  const followerReady = !settings.pauseOnDisconnect || input.followerStatus === null || READY_STATUSES.has(input.followerStatus);
  gate(
    "FOLLOWER_NOT_READY",
    "Follower account",
    !followerReady,
    `The follower account is ${input.followerStatus}, not connected. Reconnect it or turn off "pause when disconnected".`,
    `The follower account is ${input.followerStatus ?? "known"}.`,
  );

  if (event.existing) {
    gate(
      "EXISTING_POSITION",
      "New trades only",
      !settings.calibration.copyExisting,
      "This trade was already open before copying started (or before the copy worker began listening), and this route copies new trades only.",
      "Positions that were already open are copied on this route.",
    );
  } else {
    note("EXISTING_POSITION", "New trades only", "pass", "The trade opened after copying started.");
  }

  const maxAge = settings.calibration.maxSignalAgeMs;
  if (maxAge !== null && event.ageMs !== null && !event.existing) {
    gate(
      "SIGNAL_TOO_OLD",
      "Signal age",
      event.ageMs > maxAge,
      `The trade was already ${seconds(event.ageMs)} old when it was noticed; the limit is ${seconds(maxAge)}.`,
      `The trade was ${seconds(event.ageMs)} old when noticed (limit ${seconds(maxAge)}).`,
    );
  } else {
    note("SIGNAL_TOO_OLD", "Signal age", "info", maxAge === null ? "No age limit is set." : "The age of the trade is not known.");
  }

  gate(
    "ALREADY_COPIED",
    "Not copied yet",
    input.alreadyCopied !== null,
    input.alreadyCopied ?? "",
    "This position has not been copied.",
  );

  gate(
    "RISK_BLOCKED",
    "Risk rules of the follower",
    follower.riskBlocked,
    follower.riskMessage ?? "The platform's risk rules block new trades on the follower account.",
    "No risk rule blocks the follower.",
  );

  const names = [event.symbol, event.followerSymbol];
  if (settings.blockedSymbols) {
    gate(
      "SYMBOL_BLOCKED",
      "Blocked symbols",
      symbolListMatches(settings.blockedSymbols, ...names),
      `${event.symbol} is on this route's blocked list.`,
      `${event.symbol} is not blocked.`,
    );
  } else {
    note("SYMBOL_BLOCKED", "Blocked symbols", "info", "No symbol is blocked.");
  }
  if (settings.allowedSymbols) {
    gate(
      "SYMBOL_NOT_ALLOWED",
      "Allowed symbols",
      !symbolListMatches(settings.allowedSymbols, ...names),
      `${event.symbol} is not on this route's allowed list (${settings.allowedSymbols.join(", ")}).`,
      `${event.symbol} is on the allowed list.`,
    );
  } else {
    note("SYMBOL_NOT_ALLOWED", "Allowed symbols", "info", "Every symbol is allowed.");
  }

  const maxOpen = limitOf(settings.maxOpenTrades, platform.maxCopiedOpenPositions);
  if (maxOpen !== null) {
    gate(
      "MAX_OPEN_TRADES",
      "Open trades",
      follower.openCopies >= maxOpen,
      `${follower.openCopies} copied trades are open already; the limit is ${maxOpen}.`,
      `${follower.openCopies} of ${maxOpen} copied trades are open.`,
    );
  } else {
    note("MAX_OPEN_TRADES", "Open trades", "info", "There is no limit on open trades.");
  }

  const maxDaily = limitOf(settings.maxDailyLossPercent, platform.maxDailyLossPercent);
  if (maxDaily !== null && follower.dailyLossPercent !== null) {
    gate(
      "DAILY_LOSS_LIMIT",
      "Daily loss",
      follower.dailyLossPercent >= maxDaily,
      `The follower has lost ${percent(follower.dailyLossPercent)} today; the limit is ${percent(maxDaily)}.`,
      `Today's loss is ${percent(follower.dailyLossPercent)} (limit ${percent(maxDaily)}).`,
    );
  } else {
    note("DAILY_LOSS_LIMIT", "Daily loss", "info", maxDaily === null ? "There is no daily loss limit." : "Today's loss is not known yet.");
  }

  const maxDrawdown = limitOf(settings.maxDrawdownPercent, platform.maxDrawdownPercent);
  if (maxDrawdown !== null && follower.drawdownPercent !== null) {
    gate(
      "DRAWDOWN_LIMIT",
      "Drawdown",
      follower.drawdownPercent >= maxDrawdown,
      `The follower's drawdown is ${percent(follower.drawdownPercent)}; the limit is ${percent(maxDrawdown)}.`,
      `Drawdown is ${percent(follower.drawdownPercent)} (limit ${percent(maxDrawdown)}).`,
    );
  } else {
    note("DRAWDOWN_LIMIT", "Drawdown", "info", maxDrawdown === null ? "There is no drawdown limit." : "The drawdown is not known yet.");
  }

  if (input.lot) {
    gate(
      "LOT_INVALID",
      "Lot size",
      input.lot.lot <= 0,
      `No lot size could be worked out: ${input.lot.reason ?? "the sizing rule gave zero"}.`,
      `The follower trades ${input.lot.lot} lot.`,
    );
    const platformMax = platform.maxLotSize;
    if (input.lot.lot > 0 && platformMax !== null) {
      gate(
        "PLATFORM_MAX_LOT",
        "Platform lot limit",
        input.lot.lot > platformMax,
        `${input.lot.lot} lot is above the platform limit of ${platformMax}.`,
        `${input.lot.lot} lot is within the platform limit of ${platformMax}.`,
      );
    }
  } else {
    note("LOT_INVALID", "Lot size", "info", "The lot size is worked out when a trade arrives.");
  }

  gate(
    "LEVELS_UNAVAILABLE",
    "Stop loss and take profit",
    input.levelsUnavailable !== null,
    input.levelsUnavailable ?? "",
    "Stop loss and take profit can be set as configured.",
  );

  const failed = first as { code: SelfCopyCode; message: string } | null;
  return failed
    ? { allowed: false, code: failed.code, message: failed.message, checks }
    : { allowed: true, code: "COPY", message: "Copy.", checks };
}
