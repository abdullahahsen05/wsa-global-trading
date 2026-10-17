/**
 * Calibration of a copy strategy's followers (one master, many followers): everything that is
 * decided about an order before it goes out. The strategy engine in `copyTradingService` loads
 * the facts and sends the order; this module turns "the master opened X" and "this follower's
 * settings" into the follower's symbol, stop loss, take profit and slippage limit - or the reason
 * the order must not be sent.
 *
 * A follower without stored calibration gets the platform defaults, which send what the engine
 * always sent. The two differences are fixes nobody wants undone: a reversed trade swaps its
 * stop loss and take profit (the broker refused them as they were) and the follower broker's own
 * spelling of a symbol is used when its list is known.
 *
 * Pure, and shared with the AWS workers: no Next / React / `server-only` imports.
 */

import {
  effectiveSlippage,
  pointFromDigits,
  protectiveLevels,
  resolveFollowerSymbols,
  type CopyCalibration,
  type FollowerSymbolResolution,
} from "@/lib/copy/calibration";

export interface FollowerSymbolEntry {
  name: string;
  digits: number | null;
}

export interface StrategyOpenInput {
  /** the symbol as the master's broker spells it */
  sourceSymbol: string;
  /** the follower's own mapping (source symbol -> follower symbol) */
  mapping: Record<string, string> | null | undefined;
  /** every symbol the follower's broker offers; null = the list is not known */
  followerSymbols: ReadonlyArray<FollowerSymbolEntry> | null;
  /** the side the follower trades (after a reverse copy) */
  followerSide: "BUY" | "SELL";
  reversed: boolean;
  /** the master's entry price and levels */
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  calibration: CopyCalibration;
  /** the platform's slippage limit (points) */
  platformSlippage: number | null;
  /** how old the master's signal is as the order is about to be sent (ms); null = unknown */
  signalAgeMs: number | null;
  /** the size of one point when the symbol list does not tell (for example the symbol's tick size) */
  fallbackPoint?: number | null;
}

export interface StrategyOpenBlock {
  code: "SIGNAL_TOO_OLD" | "LEVELS_UNAVAILABLE";
  /** what the person reads in the copy log */
  message: string;
}

export interface StrategyOpenShape {
  /** the follower's symbol spellings to try, best first (never empty) */
  candidates: string[];
  matchedBy: FollowerSymbolResolution["matchedBy"];
  stopLoss: number | null;
  takeProfit: number | null;
  /** the slippage limit for the order (points); null = none */
  slippage: number | null;
  /** things worth telling the person ("the stop loss was on the wrong side and was left out") */
  notes: string[];
  /** set = the order must not be sent */
  blocked: StrategyOpenBlock | null;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/** What the follower's order looks like, or why it must not be sent. */
export function shapeStrategyOpen(input: StrategyOpenInput): StrategyOpenShape {
  const { calibration } = input;
  const list = input.followerSymbols && input.followerSymbols.length > 0 ? input.followerSymbols : null;
  const resolution = resolveFollowerSymbols({
    sourceSymbol: input.sourceSymbol,
    mapping: input.mapping,
    followerSymbols: list ? list.map((entry) => entry.name) : null,
    autoMatch: calibration.autoSymbolMatch,
  });
  const candidates = resolution.candidates.length > 0 ? resolution.candidates : [input.sourceSymbol.trim().toUpperCase()];
  const chosen = candidates[0].toLowerCase();
  const point =
    pointFromDigits(list?.find((entry) => entry.name.toLowerCase() === chosen)?.digits ?? null) ??
    (typeof input.fallbackPoint === "number" && input.fallbackPoint > 0 ? input.fallbackPoint : null);

  const levels = protectiveLevels({
    followerSide: input.followerSide,
    reversed: input.reversed,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    calibration,
    point,
  });

  let blocked: StrategyOpenBlock | null = null;
  if (calibration.maxSignalAgeMs !== null && input.signalAgeMs !== null && input.signalAgeMs > calibration.maxSignalAgeMs) {
    blocked = {
      code: "SIGNAL_TOO_OLD",
      message: `The master's trade was already ${seconds(input.signalAgeMs)} old when this copy was about to be sent; the limit for this follower is ${seconds(calibration.maxSignalAgeMs)}.`,
    };
  } else if (levels.unavailable) {
    blocked = { code: "LEVELS_UNAVAILABLE", message: levels.unavailable };
  }

  return {
    candidates,
    matchedBy: resolution.matchedBy,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,
    slippage: effectiveSlippage(input.platformSlippage, calibration.maxSlippagePoints),
    notes: levels.notes,
    blocked,
  };
}

// ── a change of the master's stop loss / take profit ─────────────────────────

/** Which of the two levels this follower takes from the master (a fixed distance is the follower's own). */
export function followsLevels(calibration: CopyCalibration): { stopLoss: boolean; takeProfit: boolean } {
  return {
    stopLoss: calibration.copyStopLoss && calibration.stopLossPoints === null,
    takeProfit: calibration.copyTakeProfit && calibration.takeProfitPoints === null,
  };
}

/** True when a change of the master's levels reaches this follower exactly as the master has it. */
export function followsMasterLevelsAsTheyAre(calibration: CopyCalibration, reversed: boolean): boolean {
  const follows = followsLevels(calibration);
  return !reversed && follows.stopLoss && follows.takeProfit;
}

export interface StrategyModifyInput {
  /** the side the follower's position has */
  followerSide: "BUY" | "SELL";
  reversed: boolean;
  /** the master's levels after the change */
  stopLoss: number | null;
  takeProfit: number | null;
  calibration: CopyCalibration;
}

export interface StrategyModifyShape {
  followsStopLoss: boolean;
  followsTakeProfit: boolean;
  /** the follower's level where it follows the master (null = none); not meant for a level it does not follow */
  stopLoss: number | null;
  takeProfit: number | null;
}

/**
 * The levels a change of the master's levels means for one follower. The entry price is left out
 * on purpose: a stop that has moved past the entry (break-even, trailing stop) is valid on an
 * open position - judging the side against the entry is for a new order only.
 */
export function shapeStrategyModify(input: StrategyModifyInput): StrategyModifyShape {
  const follows = followsLevels(input.calibration);
  const wanted = protectiveLevels({
    followerSide: input.followerSide,
    reversed: input.reversed,
    entryPrice: null,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    calibration: { ...input.calibration, stopLossPoints: null, takeProfitPoints: null },
    point: null,
  });
  return {
    followsStopLoss: follows.stopLoss,
    followsTakeProfit: follows.takeProfit,
    stopLoss: wanted.stopLoss,
    takeProfit: wanted.takeProfit,
  };
}

/** How old a master event is now (ms), or null when its time cannot be read. */
export function signalAge(eventTime: string | null | undefined, now: number = Date.now()): number | null {
  if (!eventTime) return null;
  const time = Date.parse(eventTime);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, now - time);
}
