import { describe, expect, test } from "vitest";
import {
  BROKER_CLOCK_SKEW_MS,
  brokerTimeToMs,
  epochToMs,
  estimateServerOffsetMs,
  instantIso,
  isServerTimeText,
  isTradeRecord,
  orderTimesMs,
  resolveOrderTimes,
} from "@/lib/broker/orderNormalization";

const HOUR = 3_600_000;
const MINUTE = 60_000;

// A broker whose server runs on UTC+3 (summer time of most MT brokers).
// The trade opened at 11:35:22 UTC, so the server's clock shows 14:35:22.
const OPENED_UTC = Date.UTC(2026, 9, 11, 11, 35, 22);
const OPENED_SERVER_TEXT = "2026-10-11T14:35:22";
const CLOSED_UTC = OPENED_UTC + 30 * MINUTE;
const CLOSED_SERVER_TEXT = "2026-10-11T15:05:22";
const NOW = Date.UTC(2026, 9, 11, 13, 0, 0);

describe("epochToMs", () => {
  test("seconds and milliseconds are the same instant", () => {
    expect(epochToMs(OPENED_UTC / 1000)).toBe(OPENED_UTC);
    expect(epochToMs(OPENED_UTC)).toBe(OPENED_UTC);
    expect(epochToMs(String(OPENED_UTC / 1000))).toBe(OPENED_UTC);
  });

  test("zero, negatives, pre-2000 values and junk are placeholders", () => {
    for (const value of [0, -5, 86_400, 946_000_000, Number.NaN, null, undefined, "", "abc", {}, true]) {
      expect(epochToMs(value)).toBeNull();
    }
  });
});

describe("brokerTimeToMs", () => {
  test("server-time text is converted with the server offset", () => {
    expect(brokerTimeToMs(OPENED_SERVER_TEXT, 3 * HOUR)).toBe(OPENED_UTC);
    expect(brokerTimeToMs("2026.10.11 14:35:22", 3 * HOUR)).toBe(OPENED_UTC);
    expect(brokerTimeToMs("2026-10-11 14:35", 3 * HOUR)).toBe(OPENED_UTC - 22_000);
  });

  test("without a known offset the text is read as UTC, as before", () => {
    expect(brokerTimeToMs(OPENED_SERVER_TEXT)).toBe(OPENED_UTC + 3 * HOUR);
  });

  test("text that carries its own zone is exact whatever the server offset is", () => {
    expect(brokerTimeToMs("2026-10-11T11:35:22Z", 3 * HOUR)).toBe(OPENED_UTC);
    expect(brokerTimeToMs("2026-10-11T14:35:22+03:00", 5 * HOUR)).toBe(OPENED_UTC);
    expect(brokerTimeToMs("2026-10-11T14:35:22.250+0300")).toBe(OPENED_UTC + 250);
    expect(brokerTimeToMs("2026-10-11T06:35:22-05:00")).toBe(OPENED_UTC);
  });

  test("placeholder dates and junk give null", () => {
    for (const value of ["0001-01-01T00:00:00", "1970-01-01T00:00:00", "1999-12-31T23:59:59", "", "  ", "garbage", null, undefined, "2026-13-40T10:00:00"]) {
      expect(brokerTimeToMs(value, 3 * HOUR)).toBeNull();
    }
  });

  test("a zone-less text is recognised as server time", () => {
    expect(isServerTimeText(OPENED_SERVER_TEXT)).toBe(true);
    expect(isServerTimeText("2026-10-11T11:35:22Z")).toBe(false);
    expect(isServerTimeText(1_791_718_522)).toBe(false);
  });
});

describe("orderTimesMs", () => {
  test("the UTC epoch beats the server-time text (the bug: text was read as UTC and won)", () => {
    const order = {
      openTime: OPENED_SERVER_TEXT,
      openTimestampUTC: OPENED_UTC / 1000,
      closeTime: CLOSED_SERVER_TEXT,
      closeTimestampUTC: CLOSED_UTC / 1000,
    };
    expect(orderTimesMs(order)).toEqual({ openedAtMs: OPENED_UTC, closedAtMs: CLOSED_UTC });
  });

  test("an epoch of 0 on a still open order falls back to the text, which is a placeholder too", () => {
    expect(orderTimesMs({ openTimestampUTC: OPENED_UTC / 1000, closeTimestampUTC: 0, closeTime: "1970-01-01T00:00:00" })).toEqual({
      openedAtMs: OPENED_UTC,
      closedAtMs: null,
    });
  });

  test("without epochs the text is converted with the offset", () => {
    expect(orderTimesMs({ openTime: OPENED_SERVER_TEXT, closeTime: CLOSED_SERVER_TEXT }, 3 * HOUR)).toEqual({
      openedAtMs: OPENED_UTC,
      closedAtMs: CLOSED_UTC,
    });
  });
});

describe("estimateServerOffsetMs", () => {
  const summer = (shiftMinutes = 0) => ({
    openTime: OPENED_SERVER_TEXT,
    openTimestampUTC: OPENED_UTC / 1000 + shiftMinutes * 60,
    closeTime: CLOSED_SERVER_TEXT,
    closeTimestampUTC: CLOSED_UTC / 1000 + shiftMinutes * 60,
  });
  const winter = {
    // UTC+2: 08:00:00 UTC shows 10:00:00
    openTime: "2026-12-01T10:00:00",
    openTimestampUTC: Date.UTC(2026, 11, 1, 8, 0, 0) / 1000,
  };

  test("is learned from an order that carries both clocks", () => {
    expect(estimateServerOffsetMs([summer()])).toBe(3 * HOUR);
  });

  test("the most frequent offset wins (rows around a DST switch differ)", () => {
    expect(estimateServerOffsetMs([summer(), winter, { ...winter }, { ...winter }])).toBe(2 * HOUR);
  });

  test("is unknown when no order has both, and mismatched pairs are not trusted", () => {
    expect(estimateServerOffsetMs([])).toBeNull();
    expect(estimateServerOffsetMs([{ openTime: OPENED_SERVER_TEXT }, { openTimestampUTC: OPENED_UTC / 1000 }])).toBeNull();
    // 2 h 37 min apart is not a time-zone difference
    expect(
      estimateServerOffsetMs([{ openTime: OPENED_SERVER_TEXT, openTimestampUTC: OPENED_UTC / 1000 - 37 * 60 }]),
    ).toBeNull();
    // a text that carries its own zone says nothing about the server clock
    expect(
      estimateServerOffsetMs([{ openTime: "2026-10-11T14:35:22+03:00", openTimestampUTC: OPENED_UTC / 1000 }]),
    ).toBeNull();
  });
});

describe("resolveOrderTimes", () => {
  const closedOrder = {
    openTime: OPENED_SERVER_TEXT,
    openTimestampUTC: OPENED_UTC / 1000,
    closeTime: CLOSED_SERVER_TEXT,
    closeTimestampUTC: CLOSED_UTC / 1000,
  };

  test("a closed trade gets its real UTC times", () => {
    expect(resolveOrderTimes(closedOrder, "CLOSED", { now: NOW })).toEqual({
      openedAt: new Date(OPENED_UTC).toISOString(),
      closedAt: new Date(CLOSED_UTC).toISOString(),
    });
  });

  test("an open trade never gets a close time", () => {
    const result = resolveOrderTimes(closedOrder, "OPEN", { now: NOW });
    expect(result.openedAt).toBe(new Date(OPENED_UTC).toISOString());
    expect(result.closedAt).toBeNull();
  });

  test("server-time text without epochs is converted with the learned offset", () => {
    const result = resolveOrderTimes(
      { openTime: OPENED_SERVER_TEXT, closeTime: CLOSED_SERVER_TEXT },
      "CLOSED",
      { serverOffsetMs: 3 * HOUR, now: NOW },
    );
    expect(result).toEqual({
      openedAt: new Date(OPENED_UTC).toISOString(),
      closedAt: new Date(CLOSED_UTC).toISOString(),
    });
  });

  test("a closed trade with a placeholder close time keeps its open time instead of jumping to now", () => {
    const result = resolveOrderTimes(
      { openTimestampUTC: OPENED_UTC / 1000, closeTime: "0001-01-01T00:00:00", closeTimestampUTC: 0 },
      "CLOSED",
      { now: NOW },
    );
    expect(result.closedAt).toBe(new Date(OPENED_UTC).toISOString());
    expect(result.openedAt).toBe(new Date(OPENED_UTC).toISOString());
  });

  test("an instant in the future is ignored (server time read as UTC), the other side is used", () => {
    // a fresh close 'reads' 3 hours ahead of the real clock when the text is taken as UTC
    const result = resolveOrderTimes(
      { openTimestampUTC: OPENED_UTC / 1000, closeTime: "2026-10-11T16:05:22" },
      "CLOSED",
      { now: NOW },
    );
    expect(result.closedAt).toBe(new Date(OPENED_UTC).toISOString());
    // clock skew below the tolerance is not a problem
    const skewed = resolveOrderTimes(
      { openTimestampUTC: OPENED_UTC / 1000, closeTimestampUTC: (NOW + BROKER_CLOCK_SKEW_MS - 1_000) / 1000 },
      "CLOSED",
      { now: NOW },
    );
    expect(skewed.closedAt).toBe(new Date(NOW + BROKER_CLOCK_SKEW_MS - 1_000).toISOString());
  });

  test("with nothing usable the time is now (and never year 1 or 1970)", () => {
    const result = resolveOrderTimes({ openTime: "0001-01-01T00:00:00", closeTime: "1970-01-01T00:00:00" }, "CLOSED", {
      now: NOW,
    });
    expect(result).toEqual({ openedAt: new Date(NOW).toISOString(), closedAt: new Date(NOW).toISOString() });
  });
});

describe("instantIso", () => {
  test("uses the epoch first and drops placeholders", () => {
    expect(instantIso(OPENED_UTC / 1000, OPENED_SERVER_TEXT, { now: NOW })).toBe(new Date(OPENED_UTC).toISOString());
    expect(instantIso(0, "1970-01-01T00:00:00", { now: NOW })).toBeUndefined();
    expect(instantIso(undefined, "0001-01-01T00:00:00", { now: NOW })).toBeUndefined();
    expect(instantIso(undefined, undefined, { now: NOW })).toBeUndefined();
  });

  test("an instant in the future is dropped", () => {
    expect(instantIso((NOW + HOUR) / 1000, undefined, { now: NOW })).toBeUndefined();
  });
});

describe("isTradeRecord", () => {
  test("market trades pass", () => {
    expect(isTradeRecord({ symbol: "EURUSD", type: "Buy", lots: 0.1 })).toBe(true);
    expect(isTradeRecord({ symbol: "XAUUSD", orderType: 1, volume: 0.02, openPrice: 2650 })).toBe(true);
    expect(isTradeRecord({ symbol: "BTCUSD", dealType: "DEAL_TYPE_SELL", closeLots: 0.01 })).toBe(true);
  });

  test("deposits, withdrawals and other balance rows are not trades", () => {
    expect(isTradeRecord({ symbol: "", type: "Balance", lots: 0, profit: 1_000 } as never)).toBe(false);
    expect(isTradeRecord({ type: "Credit" })).toBe(false);
    expect(isTradeRecord({ dealType: "DEAL_TYPE_BALANCE" })).toBe(false);
    expect(isTradeRecord({ orderType: "Correction", symbol: "" })).toBe(false);
    expect(isTradeRecord({ type: "Commission Daily" })).toBe(false);
    // numeric type codes mean different things in MT4 and MT5: the missing symbol, size and price decide
    expect(isTradeRecord({ symbol: "", type: 6, lots: 0, openPrice: 0 })).toBe(false);
    expect(isTradeRecord({ type: 2 })).toBe(false);
  });

  test("cancelled orders are not trades", () => {
    expect(isTradeRecord({ symbol: "EURUSD", dealType: "BuyCanceled", lots: 0.1 })).toBe(false);
  });

  test("a payload that names the symbol differently keeps its trades", () => {
    expect(isTradeRecord({ type: "Buy", lots: 0.5, openPrice: 1.1 })).toBe(true);
    expect(isTradeRecord({ type: 0, volume: 1 })).toBe(true);
  });
});
