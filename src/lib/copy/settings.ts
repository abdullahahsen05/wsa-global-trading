import type { ScalingMode } from "@/lib/copy/types";

export type FollowerCopyMode = "FIXED_LOT" | "LOT_MULTIPLIER" | "BALANCE_RATIO" | "RISK_PERCENT";

export function copyModeToScalingMode(mode: FollowerCopyMode): ScalingMode | null {
  switch (mode) {
    case "FIXED_LOT":
      return "FIXED_LOT";
    case "LOT_MULTIPLIER":
      return "FIXED_MULTIPLIER";
    case "BALANCE_RATIO":
      return "BALANCE_PROPORTIONAL";
    case "RISK_PERCENT":
      return "RISK_PERCENT";
  }
}

export function scalingModeToCopyMode(mode: ScalingMode | null): FollowerCopyMode {
  switch (mode) {
    case "FIXED_LOT":
      return "FIXED_LOT";
    case "FIXED_MULTIPLIER":
      return "LOT_MULTIPLIER";
    case "RISK_PERCENT":
      return "RISK_PERCENT";
    case "BALANCE_PROPORTIONAL":
    case "EQUITY_PROPORTIONAL":
    default:
      return "BALANCE_RATIO";
  }
}

export function mapFollowerSymbol(
  sourceSymbol: string,
  mapping: Record<string, string> | null | undefined,
): string {
  const source = sourceSymbol.trim().toUpperCase();
  const mapped = mapping?.[source]?.trim().toUpperCase();
  if (mapped) return mapped;
  return source;
}

function pushUniqueSymbol(target: string[], value: string | null | undefined) {
  const symbol = value?.trim().toUpperCase();
  if (symbol && !target.includes(symbol)) target.push(symbol);
}

export function followerSymbolCandidates(
  sourceSymbol: string,
  mapping: Record<string, string> | null | undefined,
): string[] {
  const source = sourceSymbol.trim().toUpperCase();
  const candidates: string[] = [];

  // If the follower has an explicit mapping, treat it as the broker-specific
  // symbol and try it first. Some brokers reject the master symbol entirely
  // (for example EURUSD vs EURUSD+), so falling back only after the master
  // symbol can leave valid follower accounts uncopied.
  pushUniqueSymbol(candidates, mapping?.[source]);
  pushUniqueSymbol(candidates, source);

  // Fallback aliases only run after the exact master symbol fails.
  // They cover common broker naming differences without forcing every follower
  // into one global symbol before execution.
  if (source === "GOLD") {
    pushUniqueSymbol(candidates, "XAUUSD");
  } else if (source === "XAUUSD") {
    pushUniqueSymbol(candidates, "GOLD");
  }

  return candidates;
}

export function reverseFollowerSide(side: string | null, reverse: boolean): string | null {
  if (!reverse) return side;
  if (side === "BUY") return "SELL";
  if (side === "SELL") return "BUY";
  return side;
}
