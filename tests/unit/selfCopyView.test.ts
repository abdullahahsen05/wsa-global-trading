import { describe, expect, it } from "vitest";
import {
  calibrationFromForm,
  calibrationToForm,
  EMPTY_CALIBRATION_FORM,
  engineBadge,
  formatAgo,
  formatLatency,
  lastActivityLine,
  mappingToText,
  parseSymbolMapping,
  platformNotices,
  type PlatformFactsView,
} from "@/lib/copy/selfCopyView";
import { readCalibration } from "@/lib/copy/calibration";

const NOW = Date.parse("2026-10-12T20:00:00.000Z");
const READY: PlatformFactsView = { copyEnabled: true, liveCopyEnabled: true, emergencyStop: false, worker: "online", workerOrdersAllowed: true };

describe("platformNotices", () => {
  it("says nothing without facts", () => {
    expect(platformNotices(null)).toEqual([]);
    expect(platformNotices(undefined)).toEqual([]);
  });

  it("gives one ready line when nothing is wrong", () => {
    expect(platformNotices(READY)).toEqual([expect.objectContaining({ id: "READY", tone: "ok" })]);
  });

  it("lists every switch that stops copying", () => {
    const ids = platformNotices({ ...READY, copyEnabled: false, emergencyStop: true, liveCopyEnabled: false }).map((notice) => notice.id);
    expect(ids).toEqual(["COPY_PAUSED", "EMERGENCY_STOP", "LIVE_DISABLED"]);
    expect(platformNotices({ ...READY, liveCopyEnabled: false })[0].text).toMatch(/Admin, Copy trading/);
  });

  it("tells a silent worker from one that may not place orders and one that cannot be read", () => {
    expect(platformNotices({ ...READY, worker: "offline" })[0]).toMatchObject({ id: "WORKER_OFFLINE", tone: "danger" });
    expect(platformNotices({ ...READY, workerOrdersAllowed: false })[0]).toMatchObject({ id: "ORDERS_NOT_ALLOWED", tone: "danger" });
    expect(platformNotices({ ...READY, worker: "unknown", workerOrdersAllowed: null })[0]).toMatchObject({ id: "WORKER_UNKNOWN", tone: "warn" });
  });
});

describe("engineBadge", () => {
  it("shows each state of the worker", () => {
    expect(engineBadge({ state: "listening", error: null })).toMatchObject({ label: "Listening", tone: "lime" });
    expect(engineBadge({ state: "starting", error: null })).toMatchObject({ label: "Connecting", tone: "accent" });
    expect(engineBadge({ state: "stale", error: null })).toMatchObject({ label: "Worker silent", tone: "danger" });
    expect(engineBadge({ state: "unreported", error: null })).toMatchObject({ label: "Waiting for worker", tone: "muted" });
  });

  it("carries the worker's own reason when it cannot follow the account", () => {
    const badge = engineBadge({ state: "error", error: "Account is not connected" });
    expect(badge).toMatchObject({ label: "Not listening", tone: "danger" });
    expect(badge.hint).toMatch(/Account is not connected/);
  });

  it("does not claim anything when the database cannot tell", () => {
    expect(engineBadge(null)).toMatchObject({ label: "Worker unknown", tone: "muted" });
  });
});

describe("formatAgo and formatLatency", () => {
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it("reads a time as a person would say it", () => {
    expect(formatAgo(ago(1_000), NOW)).toBe("just now");
    expect(formatAgo(ago(12_000), NOW)).toBe("12 s ago");
    expect(formatAgo(ago(5 * 60_000), NOW)).toBe("5 min ago");
    expect(formatAgo(ago(3 * 3_600_000), NOW)).toBe("3 h ago");
    expect(formatAgo(ago(4 * 86_400_000), NOW)).toBe("4 d ago");
  });

  it("copes with a missing or damaged time", () => {
    expect(formatAgo(null, NOW)).toBe("never");
    expect(formatAgo("soon", NOW)).toBe("never");
    expect(formatAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now");
  });

  it("shows the speed of a copy", () => {
    expect(formatLatency(38.4)).toBe("38 ms");
    expect(formatLatency(1_240)).toBe("1.2 s");
    expect(formatLatency(null)).toBeNull();
    expect(formatLatency(-5)).toBeNull();
  });
});

describe("lastActivityLine", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const base = { eventType: "OPEN", symbol: "XAUUSD", message: "", createdAt: at(12_000) } as const;

  it("says when nothing has happened yet", () => {
    expect(lastActivityLine(null, NOW)).toEqual({ text: "No trade has reached this route yet.", tone: "muted" });
    expect(lastActivityLine(undefined, NOW).tone).toBe("muted");
  });

  it("shows a copy in one short line", () => {
    expect(lastActivityLine({ ...base, outcome: "COPIED" }, NOW)).toEqual({ text: "Last: OPEN XAUUSD copied 12 s ago", tone: "lime" });
  });

  it("carries the reason of a skipped or failed trade", () => {
    expect(lastActivityLine({ ...base, outcome: "SKIPPED", message: " Live copying is switched off. " }, NOW)).toEqual({
      text: "Last: OPEN XAUUSD skipped 12 s ago - Live copying is switched off.",
      tone: "accent",
    });
    expect(lastActivityLine({ ...base, outcome: "FAILED", message: "Order rejected" }, NOW)).toMatchObject({ tone: "danger" });
  });

  it("copes with a trade that has no symbol", () => {
    expect(lastActivityLine({ ...base, eventType: "CLOSE", symbol: null, outcome: "COPIED" }, NOW).text).toBe("Last: CLOSE copied 12 s ago");
  });
});

describe("parseSymbolMapping", () => {
  it("reads one pair per line, or separated by commas", () => {
    expect(parseSymbolMapping("XAUUSD=GOLD.pro\nus30 -> US30.cash, nas100:USTEC").mapping).toEqual({
      XAUUSD: "GOLD.pro",
      US30: "US30.cash",
      NAS100: "USTEC",
    });
  });

  it("keeps the follower's spelling and upper-cases the source's name", () => {
    expect(parseSymbolMapping("eurusd=EURUSDm").mapping).toEqual({ EURUSD: "EURUSDm" });
  });

  it("reports what it cannot read instead of dropping it", () => {
    const result = parseSymbolMapping("XAUUSD=GOLD\nnonsense\nA=B=C\nX=Y");
    expect(result.mapping).toEqual({ XAUUSD: "GOLD" });
    expect(result.invalid).toEqual(["nonsense", "A=B=C", "X=Y"]);
  });

  it("ignores empty lines", () => {
    expect(parseSymbolMapping("\n  \n,,")).toEqual({ mapping: {}, invalid: [] });
  });

  it("round-trips through the text form", () => {
    const mapping = { XAUUSD: "GOLD.pro", EURUSD: "EURUSDm" };
    expect(parseSymbolMapping(mappingToText(mapping)).mapping).toEqual(mapping);
    expect(mappingToText(null)).toBe("");
  });
});

describe("the calibration form", () => {
  it("starts from the platform defaults", () => {
    const parsed = calibrationFromForm(EMPTY_CALIBRATION_FORM);
    expect(parsed).toEqual({ ok: true, calibration: readCalibration({}), symbolMapping: {} });
  });

  it("turns the form into the stored settings (seconds become milliseconds)", () => {
    const parsed = calibrationFromForm({
      ...EMPTY_CALIBRATION_FORM,
      copyTakeProfit: false,
      stopLossPoints: "150",
      maxSlippagePoints: "20",
      maxSignalAgeSeconds: "2.5",
      copyExisting: true,
      symbolMapping: "XAUUSD=GOLD.pro",
    });
    expect(parsed).toEqual({
      ok: true,
      calibration: {
        copyStopLoss: true,
        copyTakeProfit: false,
        stopLossPoints: 150,
        takeProfitPoints: null,
        maxSlippagePoints: 20,
        maxSignalAgeMs: 2500,
        copyExisting: true,
        autoSymbolMatch: true,
      },
      symbolMapping: { XAUUSD: "GOLD.pro" },
    });
  });

  it("shows stored settings in the form and back again unchanged", () => {
    const stored = readCalibration({ stopLossPoints: 120, takeProfitPoints: 300, maxSlippagePoints: 0, maxSignalAgeMs: 1500, copyExisting: true, autoSymbolMatch: false });
    const form = calibrationToForm(stored, { XAUUSD: "GOLD.pro" });
    expect(form).toMatchObject({ stopLossPoints: "120", maxSlippagePoints: "0", maxSignalAgeSeconds: "1.5", autoSymbolMatch: false });
    const back = calibrationFromForm(form);
    expect(back).toEqual({ ok: true, calibration: stored, symbolMapping: { XAUUSD: "GOLD.pro" } });
  });

  it("fills the defaults in for a route that has no stored calibration", () => {
    expect(calibrationToForm(null, { EURUSD: "EURUSDm" })).toEqual({ ...EMPTY_CALIBRATION_FORM, symbolMapping: "EURUSD=EURUSDm" });
  });

  it.each([
    ["stopLossPoints", "-5"],
    ["stopLossPoints", "0"],
    ["takeProfitPoints", "abc"],
    ["maxSlippagePoints", "-1"],
    ["maxSlippagePoints", "20000"],
    ["maxSignalAgeSeconds", "0.01"],
    ["maxSignalAgeSeconds", "4000"],
  ] as const)("refuses %s = %s and says which field", (field, value) => {
    const parsed = calibrationFromForm({ ...EMPTY_CALIBRATION_FORM, [field]: value });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(10);
  });

  it("refuses a symbol mapping it cannot read", () => {
    const parsed = calibrationFromForm({ ...EMPTY_CALIBRATION_FORM, symbolMapping: "XAUUSD GOLD" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/XAUUSD=GOLD\.pro/);
  });
});
