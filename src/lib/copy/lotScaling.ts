import type { ScalingMode } from "@/lib/copy/types";

// ─────────────────────────────────────────────────────────────────────────────
// Copy Trading — lot scaling (pure, deterministic, fully unit-tested).
// Never throws; an invalid/unsafe input yields a lot of 0 with a reason so the
// caller logs a SKIPPED row instead of executing a bad trade.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_LOT_STEP = 0.01;
export const DEFAULT_MIN_LOT = 0.01;

/** Round to the nearest broker lot step (e.g. 0.01). */
export function roundToStep(lot: number, step: number = DEFAULT_LOT_STEP): number {
  if (!Number.isFinite(lot) || !Number.isFinite(step) || step <= 0) return 0;
  const steps = Math.round(lot / step);
  // Avoid floating dust like 0.30000000000000004.
  return Number((steps * step).toFixed(6));
}

/** Clamp into [min, max]; max is optional (null = unbounded). */
export function clampLot(lot: number, minLot: number, maxLot: number | null): number {
  let out = lot;
  if (maxLot !== null && Number.isFinite(maxLot)) out = Math.min(out, maxLot);
  out = Math.max(out, minLot);
  return out;
}

export interface LotInputs {
  masterLot: number;
  entryPrice?: number | null;
  stopLoss?: number | null;
  masterEquity?: number | null;
  masterBalance?: number | null;
  followerEquity?: number | null;
  followerBalance?: number | null;
  scalingMode: ScalingMode;
  riskMultiplier?: number | null;
  riskPercent?: number | null;
  fixedLot?: number | null;
  lotStep?: number | null;
  minLot?: number | null;
  maxLot?: number | null;
  symbolSpecifications?: {
    tickSize?: number | null;
    tickValue?: number | null;
    contractSize?: number | null;
  } | null;
}

export interface LotResult {
  lot: number;
  rawLot: number | null;
  normalizedLot: number | null;
  riskAmount: number | null;
  reason: string | null;
}

function positive(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function invalid(reason: string, riskAmount: number | null = null): LotResult {
  return { lot: 0, rawLot: null, normalizedLot: null, riskAmount, reason };
}

/**
 * Calculate the follower lot for a master trade. Returns { lot, reason }.
 * lot === 0 with a reason means "do not copy" (caller logs SKIPPED / COPY_INVALID_LOT).
 */
export function calculateFollowerLot(input: LotInputs): LotResult {
  const step = positive(input.lotStep) ? input.lotStep! : DEFAULT_LOT_STEP;
  const minLot = positive(input.minLot) ? input.minLot! : DEFAULT_MIN_LOT;
  const maxLot = positive(input.maxLot) ? input.maxLot! : null;
  const risk = positive(input.riskMultiplier) ? input.riskMultiplier! : 1;

  let raw: number;
  let riskAmount: number | null = null;

  switch (input.scalingMode) {
    case "FIXED_LOT": {
      if (!positive(input.fixedLot)) return invalid("Fixed lot not set");
      raw = input.fixedLot!;
      break;
    }
    case "FIXED_MULTIPLIER": {
      if (!positive(input.masterLot)) return invalid("Master lot missing");
      raw = input.masterLot * risk;
      break;
    }
    case "BALANCE_PROPORTIONAL": {
      if (!positive(input.masterLot)) return invalid("Master lot missing");
      if (!positive(input.masterBalance)) return invalid("Master balance unavailable");
      if (!positive(input.followerBalance)) return invalid("Follower balance unavailable");
      raw = input.masterLot * (input.followerBalance! / input.masterBalance!) * risk;
      break;
    }
    case "RISK_PERCENT": {
      const basis = positive(input.followerEquity) ? input.followerEquity! : input.followerBalance;
      const riskPercent = positive(input.riskPercent) ? input.riskPercent! : null;
      if (!positive(basis)) return invalid("Follower balance/equity unavailable");
      if (!riskPercent) return invalid("Risk percent not set");
      if (!positive(input.entryPrice)) return invalid("Entry price required for risk-percent sizing");
      if (!positive(input.stopLoss)) return invalid("Stop loss required for risk-percent sizing");

      const stopDistance = Math.abs(input.entryPrice! - input.stopLoss!);
      if (!positive(stopDistance)) return invalid("Stop loss distance is zero");

      const tickSize = input.symbolSpecifications?.tickSize ?? null;
      const tickValue = input.symbolSpecifications?.tickValue ?? null;
      const contractSize = input.symbolSpecifications?.contractSize ?? null;
      let riskPerLot: number | null = null;

      if (positive(tickSize) && positive(tickValue)) {
        riskPerLot = (stopDistance / tickSize) * tickValue;
      } else if (positive(contractSize)) {
        riskPerLot = stopDistance * contractSize;
      }

      if (!positive(riskPerLot)) {
        return invalid("Symbol specifications required for risk-percent sizing");
      }

      riskAmount = basis! * (riskPercent / 100);
      raw = (riskAmount / riskPerLot) * risk;
      break;
    }
    case "EQUITY_PROPORTIONAL":
    default: {
      if (!positive(input.masterLot)) return invalid("Master lot missing");
      if (!positive(input.masterEquity)) return invalid("Master equity unavailable");
      if (!positive(input.followerEquity)) return invalid("Follower equity unavailable");
      raw = input.masterLot * (input.followerEquity! / input.masterEquity!) * risk;
      break;
    }
  }

  if (!Number.isFinite(raw) || raw <= 0) return { lot: 0, rawLot: null, normalizedLot: null, riskAmount, reason: "Calculated lot is zero" };

  const rounded = roundToStep(raw, step);
  const clamped = clampLot(rounded, minLot, maxLot);

  if (clamped < minLot) return { lot: 0, rawLot: raw, normalizedLot: clamped, riskAmount, reason: "Below minimum lot" };
  return { lot: clamped, rawLot: raw, normalizedLot: clamped, riskAmount, reason: null };
}
