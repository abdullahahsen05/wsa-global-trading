/**
 * What the self-copy screen shows and sends, as plain functions (so they can be tested without a
 * browser): the notices about the copy system, the badge of a route's worker, the "3 min ago"
 * texts, and the calibration form <-> the stored settings. Pure and client-safe.
 */

export type ViewTone = "lime" | "accent" | "muted" | "danger";

// ── the copy system (the banner above the routes) ────────────────────────────

export interface PlatformFactsView {
  copyEnabled: boolean;
  liveCopyEnabled: boolean;
  emergencyStop: boolean;
  worker: "online" | "offline" | "unknown";
  workerOrdersAllowed: boolean | null;
}

export interface PlatformNotice {
  id: string;
  tone: "danger" | "warn" | "ok";
  text: string;
}

/** What is wrong with the copy system as a whole, or one "ready" line when nothing is. */
export function platformNotices(platform: PlatformFactsView | null | undefined): PlatformNotice[] {
  if (!platform) return [];
  const notices: PlatformNotice[] = [];
  if (!platform.copyEnabled) {
    notices.push({
      id: "COPY_PAUSED",
      tone: "danger",
      text: "Copy trading is paused for the whole platform. Nothing is copied until an administrator switches it back on.",
    });
  }
  if (platform.emergencyStop) {
    notices.push({
      id: "EMERGENCY_STOP",
      tone: "danger",
      text: "The platform's emergency stop is on, so no copy is placed.",
    });
  }
  if (!platform.liveCopyEnabled) {
    notices.push({
      id: "LIVE_DISABLED",
      tone: "danger",
      text: "Live copying is switched off for the whole platform (Admin, Copy trading, settings). Until an administrator enables it, every route skips new trades.",
    });
  }
  if (platform.worker === "offline") {
    notices.push({
      id: "WORKER_OFFLINE",
      tone: "danger",
      text: "The AWS copy system is not responding. Trades are copied only while it runs.",
    });
  } else if (platform.worker === "online" && platform.workerOrdersAllowed === false) {
    notices.push({
      id: "ORDERS_NOT_ALLOWED",
      tone: "danger",
      text: "The AWS copy system is online but not allowed to place orders (BROKER_EXECUTION_ENABLED is not true there).",
    });
  } else if (platform.worker === "unknown") {
    notices.push({
      id: "WORKER_UNKNOWN",
      tone: "warn",
      text: "The state of the AWS copy system cannot be read from here yet. Each route below still shows whether the worker reports on it.",
    });
  }
  if (notices.length === 0) {
    notices.push({
      id: "READY",
      tone: "ok",
      text: "Copy system ready: live copying is on and the AWS copy system is online.",
    });
  }
  return notices;
}

// ── one route ────────────────────────────────────────────────────────────────

export interface EngineView {
  state: "listening" | "starting" | "error" | "stale" | "unreported";
  error: string | null;
}

export interface EngineBadge {
  label: string;
  tone: ViewTone;
  /** a sentence for the tooltip */
  hint: string;
}

/** Whether the AWS worker listens to the source account of a route. null = the database cannot tell (migration 061). */
export function engineBadge(engine: EngineView | null | undefined): EngineBadge {
  if (!engine) {
    return {
      label: "Worker unknown",
      tone: "muted",
      hint: "The database has no worker report for routes yet (migration 061). Copying still works; \"Check route\" explains what it can.",
    };
  }
  switch (engine.state) {
    case "listening":
      return { label: "Listening", tone: "lime", hint: "The AWS worker is connected to the source account and sees its trades as they happen." };
    case "starting":
      return { label: "Connecting", tone: "accent", hint: "The AWS worker is connecting to the source account." };
    case "error":
      return {
        label: "Not listening",
        tone: "danger",
        hint: engine.error?.trim() ? `The AWS worker cannot follow the source account: ${engine.error.trim()}` : "The AWS worker cannot follow the source account.",
      };
    case "stale":
      return { label: "Worker silent", tone: "danger", hint: "The AWS worker has not reported for several minutes. It may be stopped." };
    default:
      return {
        label: "Waiting for worker",
        tone: "muted",
        hint: "The AWS worker has not reported on this route yet. A worker running the latest code reports within a minute.",
      };
  }
}

/** "just now", "12 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function formatAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "never";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The speed of a copy as a person reads it: 38 ms, 1.2 s. */
export function formatLatency(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Math.round(ms / 100) / 10} s`;
}

export interface LastActivityView {
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  outcome: "COPIED" | "SKIPPED" | "FAILED";
  message: string;
  symbol: string | null;
  createdAt: string;
}

export interface LastActivityLine {
  text: string;
  tone: ViewTone;
}

/** The newest thing that happened on a route, as one line under its name ("Last: OPEN XAUUSD copied 12 s ago"). */
export function lastActivityLine(activity: LastActivityView | null | undefined, now: number = Date.now()): LastActivityLine {
  if (!activity) return { text: "No trade has reached this route yet.", tone: "muted" };
  const what = [activity.eventType, activity.symbol].filter(Boolean).join(" ");
  const when = formatAgo(activity.createdAt, now);
  if (activity.outcome === "COPIED") return { text: `Last: ${what} copied ${when}`, tone: "lime" };
  const reason = activity.message.trim() ? ` - ${activity.message.trim()}` : "";
  return {
    text: `Last: ${what} ${activity.outcome === "FAILED" ? "failed" : "skipped"} ${when}${reason}`,
    tone: activity.outcome === "FAILED" ? "danger" : "accent",
  };
}

// ── the calibration form ─────────────────────────────────────────────────────

export interface CalibrationValues {
  copyStopLoss: boolean;
  copyTakeProfit: boolean;
  stopLossPoints: number | null;
  takeProfitPoints: number | null;
  maxSlippagePoints: number | null;
  maxSignalAgeMs: number | null;
  copyExisting: boolean;
  autoSymbolMatch: boolean;
}

/** The calibration as the form holds it: texts for numbers, seconds for the signal age, one line per symbol mapping. */
export interface CalibrationForm {
  copyStopLoss: boolean;
  copyTakeProfit: boolean;
  stopLossPoints: string;
  takeProfitPoints: string;
  maxSlippagePoints: string;
  maxSignalAgeSeconds: string;
  copyExisting: boolean;
  autoSymbolMatch: boolean;
  symbolMapping: string;
}

export const EMPTY_CALIBRATION_FORM: CalibrationForm = {
  copyStopLoss: true,
  copyTakeProfit: true,
  stopLossPoints: "",
  takeProfitPoints: "",
  maxSlippagePoints: "",
  maxSignalAgeSeconds: "",
  copyExisting: false,
  autoSymbolMatch: true,
  symbolMapping: "",
};

const LIMITS = { points: 1_000_000, slippage: 10_000, signalAgeSeconds: 3_600, signalAgeMinSeconds: 0.1 } as const;

function plainNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

export function mappingToText(mapping: Record<string, string> | null | undefined): string {
  return Object.entries(mapping ?? {})
    .map(([from, to]) => `${from}=${to}`)
    .join("\n");
}

/**
 * "XAUUSD=GOLD.pro", one per line or separated by commas ("->" and ":" work as well). The source's
 * name is upper-cased (the engine matches it that way), the follower's spelling is kept as typed.
 */
export function parseSymbolMapping(text: string): { mapping: Record<string, string>; invalid: string[] } {
  const mapping: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const parts = entry.split(/\s*(?:->|=>|=|:)\s*/);
    const from = parts[0]?.trim() ?? "";
    const to = parts[1]?.trim() ?? "";
    if (parts.length !== 2 || from.length < 2 || from.length > 32 || to.length < 2 || to.length > 32) {
      invalid.push(entry);
      continue;
    }
    mapping[from.toUpperCase()] = to;
  }
  return { mapping, invalid };
}

export function calibrationToForm(calibration: CalibrationValues | null | undefined, mapping: Record<string, string> | null | undefined): CalibrationForm {
  if (!calibration) return { ...EMPTY_CALIBRATION_FORM, symbolMapping: mappingToText(mapping) };
  return {
    copyStopLoss: calibration.copyStopLoss,
    copyTakeProfit: calibration.copyTakeProfit,
    stopLossPoints: plainNumber(calibration.stopLossPoints),
    takeProfitPoints: plainNumber(calibration.takeProfitPoints),
    maxSlippagePoints: plainNumber(calibration.maxSlippagePoints),
    maxSignalAgeSeconds: calibration.maxSignalAgeMs === null ? "" : String(Math.round(calibration.maxSignalAgeMs) / 1000),
    copyExisting: calibration.copyExisting,
    autoSymbolMatch: calibration.autoSymbolMatch,
    symbolMapping: mappingToText(mapping),
  };
}

function optionalNumber(text: string, label: string, min: number, max: number, minInclusive: boolean): { value: number | null; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null };
  const value = Number(trimmed);
  const aboveMin = minInclusive ? value >= min : value > min;
  if (!Number.isFinite(value) || !aboveMin || value > max) {
    return { value: null, error: `${label} must be ${minInclusive ? "from" : "above"} ${min} up to ${max}, or left empty.` };
  }
  return { value };
}

export type CalibrationParse =
  | { ok: true; calibration: CalibrationValues; symbolMapping: Record<string, string> }
  | { ok: false; error: string };

/** The form as the settings the server stores, or the first thing the person has to fix. */
export function calibrationFromForm(form: CalibrationForm): CalibrationParse {
  const stopLoss = optionalNumber(form.stopLossPoints, "Fixed stop loss (points)", 0, LIMITS.points, false);
  if (stopLoss.error) return { ok: false, error: stopLoss.error };
  const takeProfit = optionalNumber(form.takeProfitPoints, "Fixed take profit (points)", 0, LIMITS.points, false);
  if (takeProfit.error) return { ok: false, error: takeProfit.error };
  const slippage = optionalNumber(form.maxSlippagePoints, "Maximum slippage (points)", 0, LIMITS.slippage, true);
  if (slippage.error) return { ok: false, error: slippage.error };
  const age = optionalNumber(form.maxSignalAgeSeconds, "Maximum signal age (seconds)", LIMITS.signalAgeMinSeconds, LIMITS.signalAgeSeconds, true);
  if (age.error) return { ok: false, error: age.error };
  const parsedMapping = parseSymbolMapping(form.symbolMapping);
  if (parsedMapping.invalid.length > 0) {
    return {
      ok: false,
      error: `Symbol mapping needs one pair per line like XAUUSD=GOLD.pro. Not understood: ${parsedMapping.invalid.slice(0, 3).join(" | ")}.`,
    };
  }
  if (Object.keys(parsedMapping.mapping).length > 100) return { ok: false, error: "At most 100 symbol mappings." };
  return {
    ok: true,
    calibration: {
      copyStopLoss: form.copyStopLoss,
      copyTakeProfit: form.copyTakeProfit,
      stopLossPoints: stopLoss.value,
      takeProfitPoints: takeProfit.value,
      maxSlippagePoints: slippage.value,
      maxSignalAgeMs: age.value === null ? null : Math.round(age.value * 1000),
      copyExisting: form.copyExisting,
      autoSymbolMatch: form.autoSymbolMatch,
    },
    symbolMapping: parsedMapping.mapping,
  };
}
