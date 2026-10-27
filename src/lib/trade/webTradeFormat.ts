import type { WebTradeTiming } from "@/lib/trade/webTrade";

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

function isMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** "310 ms" or "330 ms (send 310 ms · session 12 ms)": the trading system's own time with what it was spent on. */
function brokerText(timing: WebTradeTiming, runMs: number): string {
  const parts: string[] = [];
  if (isMs(timing.readMs) && timing.readMs > 0) parts.push(`read ${formatDuration(timing.readMs)}`);
  if (isMs(timing.sessionMs) && timing.sessionMs > 0) parts.push(`session ${formatDuration(timing.sessionMs)}`);
  if (isMs(timing.sendMs)) parts.push(`send ${formatDuration(timing.sendMs)}`);
  if (typeof timing.attempts === "number" && timing.attempts > 1) parts.push(`${timing.attempts} attempts`);
  return parts.length > 0 ? `${formatDuration(runMs)} (${parts.join(" · ")})` : formatDuration(runMs);
}

/** " (sign-in 40 ms · checks 12 ms)": what the web server's own time was spent on (empty when it is not reported). */
function serverDetail(timing: WebTradeTiming): string {
  const parts: string[] = [];
  if (isMs(timing.signInMs)) parts.push(`sign-in ${formatDuration(timing.signInMs)}`);
  if (isMs(timing.checksMs)) parts.push(`checks ${formatDuration(timing.checksMs)}`);
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

/** A busy worker is worth a word from this lag on. */
const NOTABLE_LOOP_LAG_MS = 20;

/**
 * The facts behind the parts, as sentences: how far the database is from the web server and from the AWS worker (the
 * floor of "queue" and "relay"), whether the AWS worker is busy, and how the command and its answer found each other.
 * Empty when the report carries none of it.
 */
function factsText(timing: WebTradeTiming): string {
  const sentences: string[] = [];
  const trips: string[] = [];
  if (isMs(timing.insertMs)) trips.push(`web ${formatDuration(timing.insertMs)}`);
  if (isMs(timing.awsDbMs)) trips.push(`AWS ${formatDuration(timing.awsDbMs)}`);
  if (trips.length > 0) sentences.push(`Database round trip: ${trips.join(" · ")}.`);
  if (isMs(timing.awsLoopMs) && timing.awsLoopMs >= NOTABLE_LOOP_LAG_MS) {
    sentences.push(`The AWS worker is busy: its loop ran ${formatDuration(timing.awsLoopMs)} late.`);
  }
  if (timing.wake === "live") sentences.push("Wake-up: live.");
  else if (timing.wake === "direct") sentences.push("Wake-up: direct.");
  else if (timing.wake === "web-poll") {
    sentences.push("Wake-up: the web server still asks the database again and again - apply migration 062.");
  } else if (timing.wake === "aws-poll") {
    sentences.push("Wake-up: the AWS worker still asks the database again and again - apply migration 062 and update the worker.");
  }
  if (isMs(timing.browserSetupMs) && isMs(timing.browserFirstByteMs) && isMs(timing.browserDownloadMs)) {
    sentences.push(
      `Browser request: setup ${formatDuration(timing.browserSetupMs)} · first byte ${formatDuration(timing.browserFirstByteMs)} (includes server and broker) · download ${formatDuration(timing.browserDownloadMs)}.`,
    );
  }
  if (timing.edgeRegion && timing.functionRegion) {
    sentences.push(`Route: ${timing.edgeRegion} edge → ${timing.functionRegion} function.`);
  }
  return sentences.length > 0 ? ` ${sentences.join(" ")}` : "";
}

/**
 * The time report of an order.
 *
 *  - the whole picture (the browser measured the total and the web server reported its part):
 *    "640 ms in total: network 120 ms · server 90 ms (sign-in 40 ms · checks 12 ms) · queue 60 ms · broker 330 ms (send 310 ms) · relay 40 ms"
 *    followed, when the report has them, by the facts behind it: "Database round trip: web 96 ms · AWS 14 ms. Wake-up: live."
 *  - only what the trading system reports: "183 ms (queue 120 ms · broker 63 ms)"
 *  - nothing to report: ""
 */
export function timingText(timing: WebTradeTiming | null | undefined): string {
  if (!timing) return "";
  const { queueMs, runMs, serverMs, waitMs, totalMs } = timing;
  if (!isMs(queueMs) || !isMs(runMs)) return "";
  const broker = brokerText(timing, runMs);
  if (isMs(totalMs) && isMs(serverMs) && isMs(waitMs)) {
    const network = Math.max(0, totalMs - serverMs);
    const server = Math.max(0, serverMs - waitMs);
    const relay = Math.max(0, waitMs - queueMs - runMs);
    return `${formatDuration(totalMs)} in total: network ${formatDuration(network)} · server ${formatDuration(server)}${serverDetail(timing)} · queue ${formatDuration(queueMs)} · broker ${broker} · relay ${formatDuration(relay)}${factsText(timing)}`;
  }
  return `${formatDuration(queueMs + runMs)} (queue ${formatDuration(queueMs)} · broker ${broker})`;
}

/**
 * The one number shown next to a result: the whole wait ("412 ms") when the browser measured it,
 * else the trading system's own time (queue + broker). "" when nothing was reported.
 */
export function timingHeadline(timing: WebTradeTiming | null | undefined): string {
  if (!timing) return "";
  const { queueMs, runMs, totalMs } = timing;
  if (isMs(totalMs)) return formatDuration(totalMs);
  if (isMs(queueMs) && isMs(runMs)) return formatDuration(queueMs + runMs);
  return "";
}

export type ResultTone = "gain" | "loss" | "flat";

export function resultTone(value: number): ResultTone {
  if (value > 0) return "gain";
  return value < 0 ? "loss" : "flat";
}
