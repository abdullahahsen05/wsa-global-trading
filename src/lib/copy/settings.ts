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
      return null;
  }
}

export function scalingModeToCopyMode(mode: ScalingMode | null): FollowerCopyMode {
  switch (mode) {
    case "FIXED_LOT":
      return "FIXED_LOT";
    case "FIXED_MULTIPLIER":
      return "LOT_MULTIPLIER";
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
  if (source === "GOLD") return "XAUUSD";
  return source;
}

export function reverseFollowerSide(side: string | null, reverse: boolean): string | null {
  if (!reverse) return side;
  if (side === "BUY") return "SELL";
  if (side === "SELL") return "BUY";
  return side;
}
