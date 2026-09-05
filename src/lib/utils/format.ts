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

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
