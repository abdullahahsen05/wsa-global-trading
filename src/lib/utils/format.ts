import type { MoneyValue } from "@/lib/domain/types";

export function formatMoney(value: MoneyValue): string {
  const hasCents = Math.round(Math.abs(value.amount) * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value.amount);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
