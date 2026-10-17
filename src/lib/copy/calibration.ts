/**
 * Copy calibration: how a copied trade is shaped before it is sent to the follower account.
 *
 * Pure - no I/O. Shared by the self-copy engine and (for the options that also make sense
 * there) the strategy copy engine; both run on the AWS workers, so nothing in here may
 * import Next, React or `server-only`.
 *
 * Every field has a safe default that reproduces what the platform always did, so a route
 * or follower without a stored calibration behaves exactly as before.
 */

import { findBrokerSymbol } from "@/lib/trade/symbolMatch";

export interface CopyCalibration {
  /** the follower gets a stop loss derived from the source's stop loss */
  copyStopLoss: boolean;
  /** the follower gets a take profit derived from the source's take profit */
  copyTakeProfit: boolean;
  /** a fixed stop-loss distance from the entry, in points. Replaces the source's level. null = off */
  stopLossPoints: number | null;
  /** a fixed take-profit distance from the entry, in points. Replaces the source's level. null = off */
  takeProfitPoints: number | null;
  /** the most the fill may differ from the requested price, in points. null = the platform limit */
  maxSlippagePoints: number | null;
  /** an open signal that is older than this (milliseconds) is not copied. null = no limit */
  maxSignalAgeMs: number | null;
  /** also copy positions that were already open when the stream started (default: new trades only) */
  copyExisting: boolean;
  /** find the follower's own spelling of the symbol in its broker's list */
  autoSymbolMatch: boolean;
}

export const DEFAULT_COPY_CALIBRATION: Readonly<CopyCalibration> = Object.freeze({
  copyStopLoss: true,
  copyTakeProfit: true,
  stopLossPoints: null,
  takeProfitPoints: null,
  maxSlippagePoints: null,
  maxSignalAgeMs: null,
  copyExisting: false,
  autoSymbolMatch: true,
});

export const CALIBRATION_LIMITS = Object.freeze({
  pointsMax: 1_000_000,
  slippageMax: 10_000,
  signalAgeMinMs: 100,
  signalAgeMaxMs: 3_600_000,
});

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** Reads whatever is stored (nothing, a partial object, a damaged one) as a complete calibration. */
export function readCalibration(raw: unknown): CopyCalibration {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const defaults = DEFAULT_COPY_CALIBRATION;
  return {
    copyStopLoss: bool(source.copyStopLoss, defaults.copyStopLoss),
    copyTakeProfit: bool(source.copyTakeProfit, defaults.copyTakeProfit),
    stopLossPoints: boundedNumber(source.stopLossPoints, 0.0001, CALIBRATION_LIMITS.pointsMax),
    takeProfitPoints: boundedNumber(source.takeProfitPoints, 0.0001, CALIBRATION_LIMITS.pointsMax),
    maxSlippagePoints: boundedNumber(source.maxSlippagePoints, 0, CALIBRATION_LIMITS.slippageMax),
    maxSignalAgeMs: boundedNumber(
      source.maxSignalAgeMs,
      CALIBRATION_LIMITS.signalAgeMinMs,
      CALIBRATION_LIMITS.signalAgeMaxMs,
    ),
    copyExisting: bool(source.copyExisting, defaults.copyExisting),
    autoSymbolMatch: bool(source.autoSymbolMatch, defaults.autoSymbolMatch),
  };
}

/** True when nothing differs from the platform defaults (nothing worth storing). */
export function isDefaultCalibration(calibration: CopyCalibration): boolean {
  const defaults = DEFAULT_COPY_CALIBRATION;
  return (Object.keys(defaults) as Array<keyof CopyCalibration>).every((key) => calibration[key] === defaults[key]);
}

/** The slippage limit that applies: the stricter of the platform's and the follower's own. */
export function effectiveSlippage(platform: number | null | undefined, own: number | null | undefined): number | null {
  const limits = [platform, own].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return limits.length > 0 ? Math.min(...limits) : null;
}

// ── protective levels ────────────────────────────────────────────────────────

export interface ProtectiveLevelsInput {
  /** the side the follower trades (after a reverse copy) */
  followerSide: "BUY" | "SELL";
  /** the follower trades against the source */
  reversed: boolean;
  /** the source's entry price (null / 0 = unknown) */
  entryPrice: number | null | undefined;
  /** the source's own levels */
  stopLoss: number | null | undefined;
  takeProfit: number | null | undefined;
  calibration: CopyCalibration;
  /** the price of one point of the follower's symbol (null = unknown) */
  point: number | null;
  /**
   * Leave a level out when it is on the wrong side of the entry price (default: yes). Turn it off
   * for a position that was already open: its stop may have trailed past the entry, and the
   * follower does not enter at the source's price anyway - the broker judges the levels then.
   */
  checkSides?: boolean;
}

export interface ProtectiveLevels {
  stopLoss: number | null;
  takeProfit: number | null;
  /** things the person should know ("the stop loss was on the wrong side and was left out") */
  notes: string[];
  /** set when a level the person asked for cannot be worked out: the trade must not go out without it */
  unavailable: string | null;
}

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The price of one point for a symbol with this many digits (2 digits -> 0.01). */
export function pointFromDigits(digits: number | null | undefined): number | null {
  if (typeof digits !== "number" || !Number.isInteger(digits) || digits < 0 || digits > 10) return null;
  return Number((10 ** -digits).toFixed(digits));
}

/** A price rounded to the grid of a symbol (so 2300.5 - 150 * 0.01 is 2299, not 2298.9999999999995). */
export function roundToPoint(price: number, point: number): number {
  if (!positive(point)) return price;
  const decimals = Math.min(10, Math.max(0, Math.round(-Math.log10(point))));
  return Number((Math.round(price / point) * point).toFixed(decimals));
}

/**
 * The stop loss and take profit the follower's order carries.
 *
 * - A reverse copy swaps the two: the source's take profit sits on the side where the
 *   follower's stop loss belongs. (Copying the levels as they are made every reversed trade
 *   fail at the broker with "invalid stops".)
 * - A level on the wrong side of the entry is left out instead of sending an order that the
 *   broker would refuse as a whole.
 * - "Copy stop loss / take profit" off leaves the level out; a fixed distance in points
 *   replaces whatever the source has.
 */
export function protectiveLevels(input: ProtectiveLevelsInput): ProtectiveLevels {
  const { followerSide, calibration } = input;
  const notes: string[] = [];
  let unavailable: string | null = null;
  const entry = positive(input.entryPrice) ? input.entryPrice : null;

  let stopLoss = positive(input.stopLoss) ? input.stopLoss : null;
  let takeProfit = positive(input.takeProfit) ? input.takeProfit : null;
  if (input.reversed) {
    [stopLoss, takeProfit] = [takeProfit, stopLoss];
    if (stopLoss !== null || takeProfit !== null) notes.push("Reverse copy: the source's stop loss and take profit trade places.");
  }

  if (entry !== null && input.checkSides !== false) {
    if (followerSide === "BUY") {
      if (stopLoss !== null && stopLoss >= entry) {
        stopLoss = null;
        notes.push("The stop loss is not below the entry price and was left out.");
      }
      if (takeProfit !== null && takeProfit <= entry) {
        takeProfit = null;
        notes.push("The take profit is not above the entry price and was left out.");
      }
    } else {
      if (stopLoss !== null && stopLoss <= entry) {
        stopLoss = null;
        notes.push("The stop loss is not above the entry price and was left out.");
      }
      if (takeProfit !== null && takeProfit >= entry) {
        takeProfit = null;
        notes.push("The take profit is not below the entry price and was left out.");
      }
    }
  }

  if (!calibration.copyStopLoss) stopLoss = null;
  if (!calibration.copyTakeProfit) takeProfit = null;

  const fixed = (points: number | null, towardProfit: boolean, label: string): number | null => {
    if (points === null) return null;
    if (entry === null || !positive(input.point)) {
      unavailable ??= `The ${label} in points needs the entry price and the size of one point of the symbol, and one of them is unknown.`;
      return null;
    }
    const direction = (followerSide === "BUY") === towardProfit ? 1 : -1;
    const price = entry + direction * points * input.point;
    return price > 0 ? roundToPoint(price, input.point) : null;
  };
  if (calibration.stopLossPoints !== null) stopLoss = fixed(calibration.stopLossPoints, false, "stop loss");
  if (calibration.takeProfitPoints !== null) takeProfit = fixed(calibration.takeProfitPoints, true, "take profit");

  return { stopLoss, takeProfit, notes, unavailable };
}

// ── the follower's symbol ────────────────────────────────────────────────────

export interface FollowerSymbolInput {
  /** the symbol as the source's broker spells it */
  sourceSymbol: string;
  /** the person's own mapping (source symbol -> follower symbol), keys upper case */
  mapping: Record<string, string> | null | undefined;
  /** every symbol the follower's broker offers, in its own spelling; null = the list is not known */
  followerSymbols: ReadonlyArray<string> | null;
  autoMatch: boolean;
}

export interface FollowerSymbolResolution {
  /** names to try, best first */
  candidates: string[];
  /** how the first candidate was found */
  matchedBy: "mapping" | "same-name" | "auto" | "as-is";
  /** the broker's list is known */
  listKnown: boolean;
  /** the first candidate is in the broker's list (false when the list is unknown) */
  listed: boolean;
}

export function resolveFollowerSymbols(input: FollowerSymbolInput): FollowerSymbolResolution {
  const source = input.sourceSymbol.trim();
  const sourceUpper = source.toUpperCase();
  const list = input.followerSymbols && input.followerSymbols.length > 0 ? input.followerSymbols : null;
  const byLower = new Map<string, string>();
  for (const name of list ?? []) byLower.set(name.toLowerCase(), name);
  /** the broker's own spelling when it has the symbol, else what was given */
  const spell = (name: string) => byLower.get(name.toLowerCase()) ?? name;

  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | null | undefined) => {
    const trimmed = name?.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) return;
    seen.add(trimmed.toLowerCase());
    candidates.push(trimmed);
  };

  let matchedBy: FollowerSymbolResolution["matchedBy"] = "as-is";
  const mapped = input.mapping?.[sourceUpper]?.trim();
  if (mapped) {
    add(spell(mapped));
    matchedBy = "mapping";
  }
  if (list && byLower.has(sourceUpper.toLowerCase())) {
    if (candidates.length === 0) matchedBy = "same-name";
    add(byLower.get(sourceUpper.toLowerCase()));
  }
  if (list && input.autoMatch) {
    const found = findBrokerSymbol(source, list);
    if (found) {
      if (candidates.length === 0) matchedBy = "auto";
      add(found);
    }
  }
  // what the platform always tried: the source's own spelling, and the gold alias
  add(spell(source));
  if (source !== sourceUpper) add(spell(sourceUpper));
  if (sourceUpper === "GOLD") add(spell("XAUUSD"));
  else if (sourceUpper === "XAUUSD") add(spell("GOLD"));

  return {
    candidates,
    matchedBy,
    listKnown: list !== null,
    listed: list !== null && byLower.has((candidates[0] ?? "").toLowerCase()),
  };
}
