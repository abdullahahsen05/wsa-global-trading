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

  // Always try the exact master symbol first. Most brokers accept the same
  // contract name, and this keeps copy trading automatic instead of depending
  // on per-account manual mappings.
  pushUniqueSymbol(candidates, source);
  pushUniqueSymbol(candidates, mapping?.[source]);

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
