import type { MoneyValue } from "@/lib/domain/types";

export function normalizeMoneyAmount(amount: number): number {
  return Math.round(amount * 100) === 0 ? 0 : amount;
}

export function formatMoney(value: MoneyValue): string {
  const amount = normalizeMoneyAmount(value.amount);
  const hasCents = Math.round(Math.abs(amount) * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const normalized = Object.is(value, -0) ? 0 : value;
  const raw = String(normalized);
  const decimalCount = raw.includes("e")
    ? 5
    : raw.includes(".")
      ? raw.split(".")[1]?.length ?? 0
      : 0;
  const decimals = Math.min(Math.max(decimalCount, 2), 5);
  return normalized.toFixed(decimals);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
