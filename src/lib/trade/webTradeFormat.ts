/**
 * Reading what the user types into the order panel and showing numbers the way a
 * trading terminal does. Pure.
 */

/** "1.25" and "1,25" -> 1.25; empty, text and non-finite input -> null. */
export function parseDecimal(text: string): number | null {
  const cleaned = text.trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A price level typed by the user: "" = not set (null), a number, or "invalid". */
export function parseLevelInput(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const parsed = parseDecimal(text);
  return parsed !== null && parsed > 0 ? parsed : "invalid";
}

/** A price with the decimals it has (up to 6), no padding: 2345.5 -> "2345.5", 1.08123 -> "1.08123". */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return String(Number(value.toFixed(6)));
}

/** Lots with up to three decimals, no padding: 0.1 -> "0.1", 1 -> "1". */
export function formatLots(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return String(Number(value.toFixed(3)));
}

/** "+12.34" / "-5.00": signed, two decimals, thousands separated. */
export function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value > 0) return `+${text}`;
  return value < 0 ? `-${text}` : text;
}

/** "1,234.50 USD". */
export function formatMoney(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const text = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${text} ${currency}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

/** 183 -> "183 ms", 1250 -> "1.25 s". */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

/** "183 ms (queue 120 ms · broker 63 ms)" for the timing the trading system reports; "" when there is none. */
export function timingText(timing: { queueMs: number; runMs: number } | null | undefined): string {
  if (!timing) return "";
  const total = timing.queueMs + timing.runMs;
  return `${formatDuration(total)} (queue ${formatDuration(timing.queueMs)} · broker ${formatDuration(timing.runMs)})`;
}

export type ResultTone = "gain" | "loss" | "flat";

export function resultTone(value: number): ResultTone {
  if (value > 0) return "gain";
  return value < 0 ? "loss" : "flat";
}
