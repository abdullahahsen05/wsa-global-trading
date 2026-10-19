import { describe, expect, test } from "vitest";
import {
  DEFAULT_SYMBOL,
  DEFAULT_TRADING_VIEW_SYMBOLS,
  MAX_BROKER_TERMINALS,
  MAX_COMPARE_SYMBOLS,
  MAX_TRADING_VIEW_INDICATORS,
  MAX_WATCHLIST_SYMBOLS,
  MAX_WORKSPACE_BYTES,
  MAX_WSA_TRADE_LEVEL_POINTS,
  TERMINAL_TIMEFRAMES,
  TIMEFRAME_TO_INTERVAL,
  TRADING_VIEW_INDICATORS,
  defaultChartOptions,
  defaultWatchlist,
  defaultWorkspace,
  defaultWsaTrade,
  isUuid,
  mergeWorkspace,
  normalizeTradingViewSymbol,
  readWorkspaceFromLayout,
  sanitizeWatchlist,
  sanitizeWorkspace,
  symbolLabel,
  withWorkspaceInLayout,
} from "@/lib/terminal/workspace";
import { MAX_MANUAL_ACCOUNTS } from "@/lib/terminal/metatrader";

const ACCOUNT_A = "3f2b8c1e-5d4a-4e7b-9c2d-1a2b3c4d5e6f";
const ACCOUNT_B = "9a8b7c6d-5e4f-4a3b-8c2d-0f1e2d3c4b5a";

function manual(id: string, overrides: Record<string, unknown> = {}) {
  return { id, label: `Account ${id}`, platform: "MT5", login: "123456", server: "Broker-Live", ...overrides };
}

describe("defaults", () => {
  test("a new trader starts in the trade section: the chart with the WSA Trade panel next to it", () => {
    const workspace = defaultWorkspace();
    expect(workspace.version).toBe(3);
    expect(workspace.view).toBe("split");
    expect(workspace.split).toBe("columns");
    expect(workspace.splitWith).toBe("wsatrade");
    expect(workspace.wsatrade).toEqual({
      accountId: null,
      symbol: "XAUUSD",
      volume: 0.01,
      orderKind: "MARKET",
      // fit to the room the pane has, and the panel's usual column next to the chart
      zoom: null,
      panelShare: null,
      levelMode: "price",
      stopLossPoints: null,
      takeProfitPoints: null,
      requireStopLoss: false,
      maxVolume: null,
    });
    expect(workspace.wsatrade).toEqual(defaultWsaTrade());
    expect(workspace.tradingview.symbol).toBe(DEFAULT_SYMBOL);
    expect(workspace.tradingview.timeframe).toBe("15m");
    expect(workspace.tradingview.watchlist).toEqual(Object.values(DEFAULT_TRADING_VIEW_SYMBOLS));
    expect(workspace.tradingview.panels).toEqual({ watchlist: true, details: false, hotlist: false });
    // MA 50 + MA 200 on the chart and no volume bars
    expect(workspace.tradingview.chart).toEqual(defaultChartOptions());
    expect(workspace.tradingview.chart.indicators).toEqual(["ma50_200"]);
    expect(workspace.tradingview.chart.volume).toBe(false);
    // MetaTrader opens the account's own broker terminal, found automatically
    expect(workspace.metatrader).toEqual({
      source: "auto",
      customUrl: null,
      brokerTerminals: {},
      selection: null,
      manualAccounts: [],
      autoLogin: false,
    });
  });

  test("every timeframe has a TradingView interval", () => {
    expect(TERMINAL_TIMEFRAMES.map((timeframe) => TIMEFRAME_TO_INTERVAL[timeframe])).toEqual([
      "1",
      "5",
      "15",
      "30",
      "60",
      "240",
      "D",
      "W",
      "M",
    ]);
  });

  test("symbol labels", () => {
    expect(symbolLabel("OANDA:XAUUSD")).toBe("XAUUSD");
    expect(symbolLabel("BINANCE:BTCUSDT")).toBe("BTCUSD");
    expect(symbolLabel("NASDAQ:AAPL")).toBe("AAPL");
    expect(symbolLabel("AAPL")).toBe("AAPL");
  });
});

describe("normalizeTradingViewSymbol", () => {
  test("upper-cases and trims valid symbols", () => {
    expect(normalizeTradingViewSymbol("oanda:eurusd")).toBe("OANDA:EURUSD");
    expect(normalizeTradingViewSymbol(" aapl ")).toBe("AAPL");
    expect(normalizeTradingViewSymbol("BINANCE:BTCUSDT")).toBe("BINANCE:BTCUSDT");
    expect(normalizeTradingViewSymbol("BTC.D")).toBe("BTC.D");
  });

  test.each([
    ["spaces", "BAD SYMBOL"],
    ["markup", "<script>"],
    ["two colons", "A:B:C"],
    ["quote", 'OANDA:"X"'],
    ["expression", "EURUSD/GBPUSD"],
    ["empty", ""],
    ["too long", `OANDA:${"A".repeat(70)}`],
  ])("rejects %s", (_name, value) => {
    expect(normalizeTradingViewSymbol(value)).toBeNull();
  });

  test("rejects non-strings", () => {
    expect(normalizeTradingViewSymbol(42)).toBeNull();
    expect(normalizeTradingViewSymbol(null)).toBeNull();
    expect(normalizeTradingViewSymbol({})).toBeNull();
  });
});

describe("sanitizeWatchlist", () => {
  test("normalises, drops invalid entries and de-duplicates keeping order", () => {
    expect(sanitizeWatchlist(["oanda:eurusd", "OANDA:EURUSD", "nope nope", 5, null, "AAPL", "oanda:gbpusd"])).toEqual([
      "OANDA:EURUSD",
      "AAPL",
      "OANDA:GBPUSD",
    ]);
  });

  test("is capped", () => {
    const many = Array.from({ length: MAX_WATCHLIST_SYMBOLS + 15 }, (_, index) => `OANDA:SYM${index}`);
    const list = sanitizeWatchlist(many);
    expect(list).toHaveLength(MAX_WATCHLIST_SYMBOLS);
    expect(list[0]).toBe("OANDA:SYM0");
  });

  test("a non-array is an empty list", () => {
    expect(sanitizeWatchlist("OANDA:EURUSD")).toEqual([]);
    expect(sanitizeWatchlist(undefined)).toEqual([]);
  });

  test("default list is valid and unique", () => {
    expect(sanitizeWatchlist(defaultWatchlist())).toEqual(defaultWatchlist());
  });
});

describe("sanitizeWorkspace", () => {
  test.each([[null], [undefined], ["text"], [42], [[]], [{}], [{ version: 99, view: 5 }]])(
    "turns %j into the defaults",
    (input) => {
      expect(sanitizeWorkspace(input)).toEqual(defaultWorkspace());
    },
  );

  test("keeps valid settings", () => {
    const workspace = sanitizeWorkspace({
      view: "split",
      split: "rows",
      tradingview: {
        symbol: "nasdaq:aapl",
        timeframe: "4H",
        watchlist: ["nasdaq:aapl", "oanda:eurusd"],
        // `calendar` was a switch of an earlier version that the widget never honoured: it is dropped
        panels: { watchlist: false, details: true, hotlist: true, calendar: true },
      },
      metatrader: { source: "modern", customUrl: null },
    });
    expect(workspace.view).toBe("split");
    expect(workspace.split).toBe("rows");
    expect(workspace.tradingview).toEqual({
      symbol: "NASDAQ:AAPL",
      timeframe: "4H",
      watchlist: ["NASDAQ:AAPL", "OANDA:EURUSD"],
      panels: { watchlist: false, details: true, hotlist: true },
      chart: defaultChartOptions(),
    });
    expect(workspace.metatrader.source).toBe("modern");
  });

  test("invalid fields fall back one by one", () => {
    const workspace = sanitizeWorkspace({
      view: "hologram",
      split: "diagonal",
      tradingview: {
        symbol: "<x>",
        timeframe: "7m",
        watchlist: "no",
        panels: { watchlist: "yes", calendar: 1 },
        chart: { style: "neon", theme: 3, timezone: "Mars/Base", indicators: "rsi", compare: "x", panelWidth: 999, volume: "yes" },
      },
      metatrader: { source: "proxy", autoLogin: "yes" },
    });
    expect(workspace).toEqual(defaultWorkspace());
  });

  test("a missing watchlist gets the defaults, an emptied one stays empty", () => {
    expect(sanitizeWorkspace({ tradingview: {} }).tradingview.watchlist).toEqual(defaultWatchlist());
    expect(sanitizeWorkspace({ tradingview: { watchlist: [] } }).tradingview.watchlist).toEqual([]);
  });

  test("is idempotent", () => {
    const samples: unknown[] = [
      null,
      { view: "metatrader", tradingview: { watchlist: ["a", "A", "b b"] } },
      {
        metatrader: {
          customUrl: "https://webtrader.example-broker.com/x",
          manualAccounts: [manual("abcdef12"), manual("abcdef12"), manual("short")],
          selection: { kind: "manual", id: "abcdef12" },
        },
      },
      { metatrader: { selection: { kind: "platform", accountId: ACCOUNT_A.toUpperCase() } } },
      {
        version: 2,
        metatrader: {
          source: "auto",
          brokerTerminals: { "icmarketssc:mt5": "https://webtrader.icmarkets.com/", "bad key": "x", "exness:mt4": "http://no" },
        },
      },
      { version: 1, metatrader: { source: "classic" } },
    ];
    for (const sample of samples) {
      const once = sanitizeWorkspace(sample);
      expect(sanitizeWorkspace(once)).toEqual(once);
    }
  });

  test("survives a JSON round trip", () => {
    const workspace = sanitizeWorkspace({
      view: "split",
      metatrader: { manualAccounts: [manual("abcdef12")], selection: { kind: "manual", id: "abcdef12" } },
    });
    expect(sanitizeWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace);
  });
});

describe("workspace: MetaTrader accounts added by hand", () => {
  test("valid entries are kept and cleaned", () => {
    const workspace = sanitizeWorkspace({
      metatrader: {
        manualAccounts: [manual("abcdef12", { label: " <b>Live</b> ", platform: "mt4", login: 987654, server: "A  B" })],
      },
    });
    expect(workspace.metatrader.manualAccounts).toEqual([
      { id: "abcdef12", label: "bLive/b", platform: "MT4", login: "987654", server: "A B" },
    ]);
  });

  test.each([
    ["bad id", manual("a b")],
    ["short id", manual("abc")],
    ["bad platform", manual("abcdef12", { platform: "MT9" })],
    ["bad login", manual("abcdef12", { login: "12ab" })],
    ["bad server", manual("abcdef12", { server: "!" })],
  ])("drops an entry with a %s", (_name, entry) => {
    expect(sanitizeWorkspace({ metatrader: { manualAccounts: [entry] } }).metatrader.manualAccounts).toEqual([]);
  });

  test("duplicate ids keep the first, the list is capped", () => {
    const duplicates = sanitizeWorkspace({
      metatrader: { manualAccounts: [manual("abcdef12", { label: "first" }), manual("abcdef12", { label: "second" })] },
    });
    expect(duplicates.metatrader.manualAccounts.map((entry) => entry.label)).toEqual(["first"]);

    const many = Array.from({ length: MAX_MANUAL_ACCOUNTS + 5 }, (_, index) => manual(`acct-${index + 100}`));
    expect(sanitizeWorkspace({ metatrader: { manualAccounts: many } }).metatrader.manualAccounts).toHaveLength(
      MAX_MANUAL_ACCOUNTS,
    );
  });

  test("a password (or any other extra key) is never stored", () => {
    const workspace = sanitizeWorkspace({
      metatrader: { manualAccounts: [manual("abcdef12", { password: "hunter2", token: "t0k3n" })] },
    });
    const json = JSON.stringify(workspace);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("t0k3n");
    expect(json.toLowerCase()).not.toContain("password");
  });
});

describe("workspace: selection and custom address", () => {
  test("a platform account needs a UUID, which is lower-cased", () => {
    expect(
      sanitizeWorkspace({ metatrader: { selection: { kind: "platform", accountId: ACCOUNT_A.toUpperCase() } } }).metatrader
        .selection,
    ).toEqual({ kind: "platform", accountId: ACCOUNT_A });
    expect(
      sanitizeWorkspace({ metatrader: { selection: { kind: "platform", accountId: "not-a-uuid" } } }).metatrader.selection,
    ).toBeNull();
    expect(isUuid(ACCOUNT_B)).toBe(true);
    expect(isUuid("zzz")).toBe(false);
  });

  test("a manual selection must point at an existing manual account", () => {
    const base = { manualAccounts: [manual("abcdef12")] };
    expect(
      sanitizeWorkspace({ metatrader: { ...base, selection: { kind: "manual", id: "abcdef12" } } }).metatrader.selection,
    ).toEqual({ kind: "manual", id: "abcdef12" });
    expect(
      sanitizeWorkspace({ metatrader: { ...base, selection: { kind: "manual", id: "missing99" } } }).metatrader.selection,
    ).toBeNull();
    expect(sanitizeWorkspace({ metatrader: { selection: { kind: "other" } } }).metatrader.selection).toBeNull();
  });

  test("the custom terminal address must be a safe https address", () => {
    expect(
      sanitizeWorkspace({ metatrader: { customUrl: "https://webtrader.example-broker.com/terminal" } }).metatrader.customUrl,
    ).toBe("https://webtrader.example-broker.com/terminal");
    for (const bad of ["javascript:alert(1)", "http://x.example.com", "https://localhost/", "https://u:p@x.example.com/", 5]) {
      expect(sanitizeWorkspace({ metatrader: { customUrl: bad } }).metatrader.customUrl).toBeNull();
    }
  });
});

describe("workspace: the automatic MetaTrader source and the addresses saved per broker", () => {
  const KEY = "icmarketssc:mt5";
  const ADDRESS = "https://webtrader.icmarkets.com/terminal";
  const EXNESS = "https://mt5.exness.com/";

  test("a document from before version 2 that says classic follows the new default, a version 2 choice stays", () => {
    expect(sanitizeWorkspace({ metatrader: { source: "classic" } }).metatrader.source).toBe("auto");
    expect(sanitizeWorkspace({ version: 1, metatrader: { source: "classic" } }).metatrader.source).toBe("auto");
    expect(sanitizeWorkspace({ version: 2, metatrader: { source: "classic" } }).metatrader.source).toBe("classic");
    // the other choices of an old document were deliberate
    expect(sanitizeWorkspace({ version: 1, metatrader: { source: "custom" } }).metatrader.source).toBe("custom");
    expect(sanitizeWorkspace({ version: 1, metatrader: { source: "modern" } }).metatrader.source).toBe("modern");
    expect(sanitizeWorkspace({ version: 2, metatrader: { source: "auto" } }).metatrader.source).toBe("auto");
    // and a user's choice is not undone when it is saved again
    const chosen = mergeWorkspace(defaultWorkspace(), { metatrader: { source: "classic" } });
    expect(chosen.metatrader.source).toBe("classic");
    expect(sanitizeWorkspace(JSON.parse(JSON.stringify(chosen))).metatrader.source).toBe("classic");
  });

  test("an address saved for a broker is kept per broker and platform", () => {
    const workspace = sanitizeWorkspace({
      metatrader: { brokerTerminals: { [KEY]: ADDRESS, "exness:mt4": "https://mt4.exness.com/" } },
    });
    expect(workspace.metatrader.brokerTerminals).toEqual({ [KEY]: ADDRESS, "exness:mt4": "https://mt4.exness.com/" });
  });

  test.each([
    ["a key without a platform", "icmarketssc"],
    ["a key with a space", "ic markets:mt5"],
    ["an unknown platform", "icmarketssc:mt6"],
    ["a path", "../admin:mt5"],
    ["a one-letter broker", "a:mt5"],
    ["a very long broker", `${"x".repeat(41)}:mt5`],
    ["an upper-case key", "ICMARKETSSC:mt5"],
  ])("drops %s", (_name, key) => {
    expect(sanitizeWorkspace({ metatrader: { brokerTerminals: { [key]: ADDRESS } } }).metatrader.brokerTerminals).toEqual({});
  });

  test.each([
    ["plain http", "http://webtrader.icmarkets.com/"],
    ["a script", "javascript:alert(1)"],
    ["an IP address", "https://127.0.0.1/"],
    ["localhost", "https://localhost/"],
    ["credentials", "https://user:pw@webtrader.icmarkets.com/"],
    ["a number", 5],
    ["an object", {}],
  ])("drops an address that is %s", (_name, address) => {
    expect(sanitizeWorkspace({ metatrader: { brokerTerminals: { [KEY]: address } } }).metatrader.brokerTerminals).toEqual({});
  });

  test("a document that is not an object has no saved addresses", () => {
    for (const value of ["x", 5, null, [ADDRESS]]) {
      expect(sanitizeWorkspace({ metatrader: { brokerTerminals: value } }).metatrader.brokerTerminals).toEqual({});
    }
  });

  test("merging adds, replaces and removes (null) one broker at a time", () => {
    const first = mergeWorkspace(defaultWorkspace(), { metatrader: { brokerTerminals: { [KEY]: ADDRESS } } });
    expect(first.metatrader.brokerTerminals).toEqual({ [KEY]: ADDRESS });

    const second = mergeWorkspace(first, { metatrader: { brokerTerminals: { "exness:mt5": EXNESS } } });
    expect(second.metatrader.brokerTerminals).toEqual({ [KEY]: ADDRESS, "exness:mt5": EXNESS });

    // a patch about something else leaves them alone
    expect(mergeWorkspace(second, { metatrader: { autoLogin: true } }).metatrader.brokerTerminals).toEqual(
      second.metatrader.brokerTerminals,
    );
    expect(mergeWorkspace(second, { view: "split" }).metatrader.brokerTerminals).toEqual(second.metatrader.brokerTerminals);

    const third = mergeWorkspace(second, { metatrader: { brokerTerminals: { [KEY]: "https://mt5.icmarkets.com/" } } });
    expect(third.metatrader.brokerTerminals[KEY]).toBe("https://mt5.icmarkets.com/");

    const fourth = mergeWorkspace(third, { metatrader: { brokerTerminals: { [KEY]: null } } });
    expect(fourth.metatrader.brokerTerminals).toEqual({ "exness:mt5": EXNESS });
  });

  test("an invalid entry in a patch never touches the saved ones", () => {
    const current = mergeWorkspace(defaultWorkspace(), { metatrader: { brokerTerminals: { [KEY]: ADDRESS } } });
    const next = mergeWorkspace(current, {
      metatrader: { brokerTerminals: { [KEY]: "http://nope.example.com/", "bad key": ADDRESS, "exness:mt5": "javascript:1", "exness:mt4": 7 } },
    });
    expect(next.metatrader.brokerTerminals).toEqual({ [KEY]: ADDRESS });
    for (const junk of ["x", 5, [ADDRESS]]) {
      expect(mergeWorkspace(current, { metatrader: { brokerTerminals: junk } }).metatrader.brokerTerminals).toEqual({ [KEY]: ADDRESS });
    }
  });

  test("the list is capped and keeps the newest addresses", () => {
    let workspace = defaultWorkspace();
    for (let index = 0; index < MAX_BROKER_TERMINALS + 5; index += 1) {
      const id = index + 10;
      workspace = mergeWorkspace(workspace, {
        metatrader: { brokerTerminals: { [`broker${id}:mt5`]: `https://mt5.broker${id}.com/` } },
      });
    }
    const keys = Object.keys(workspace.metatrader.brokerTerminals);
    expect(keys).toHaveLength(MAX_BROKER_TERMINALS);
    expect(keys).not.toContain("broker10:mt5");
    expect(keys[keys.length - 1]).toBe(`broker${MAX_BROKER_TERMINALS + 5 + 9}:mt5`);

    // an address written again counts as the newest, so the oldest of the others goes first
    const oldest = keys[0];
    const refreshed = mergeWorkspace(workspace, { metatrader: { brokerTerminals: { [oldest]: "https://mt5.renewed.com/" } } });
    const afterOne = mergeWorkspace(refreshed, { metatrader: { brokerTerminals: { "newest99:mt5": "https://mt5.newest99.com/" } } });
    expect(Object.keys(afterOne.metatrader.brokerTerminals)).toContain(oldest);
    expect(Object.keys(afterOne.metatrader.brokerTerminals)).not.toContain(keys[1]);
    expect(afterOne.metatrader.brokerTerminals[oldest]).toBe("https://mt5.renewed.com/");
  });

  test("nothing but addresses is stored", () => {
    const workspace = mergeWorkspace(defaultWorkspace(), {
      metatrader: { brokerTerminals: { [KEY]: ADDRESS }, password: "hunter2" },
    });
    expect(JSON.stringify(workspace)).not.toContain("hunter2");
  });
});

describe("TradingView chart options", () => {
  const chartOf = (chart: unknown) => sanitizeWorkspace({ tradingview: { chart } }).tradingview.chart;

  test("valid choices are kept", () => {
    const chart = chartOf({
      style: "heikin",
      theme: "light",
      timezone: "Europe/Berlin",
      volume: true,
      indicators: ["rsi", "macd"],
      compare: ["oanda:eurusd"],
      compareMode: "NewPane",
      extendedHours: true,
      drawingToolbar: false,
      topToolbar: false,
      legend: false,
      dateRanges: false,
      symbolSearch: false,
      screenshotButton: true,
      popOutButton: true,
      editableWatchlist: true,
      panelWidth: 300,
    });
    expect(chart).toEqual({
      style: "heikin",
      theme: "light",
      timezone: "Europe/Berlin",
      volume: true,
      indicators: ["rsi", "macd"],
      compare: ["OANDA:EURUSD"],
      compareMode: "NewPane",
      extendedHours: true,
      drawingToolbar: false,
      topToolbar: false,
      legend: false,
      dateRanges: false,
      symbolSearch: false,
      screenshotButton: true,
      popOutButton: true,
      editableWatchlist: true,
      panelWidth: 300,
    });
  });

  test("indicators: only known ones, no duplicates, five at most, in the order of the list", () => {
    const all = TRADING_VIEW_INDICATORS.map((indicator) => indicator.id);
    expect(chartOf({ indicators: ["macd", "rsi", "rsi", "bogus", 7] }).indicators).toEqual(["rsi", "macd"]);
    expect(chartOf({ indicators: [...all, ...all] }).indicators).toHaveLength(MAX_TRADING_VIEW_INDICATORS);
    // the user can switch every indicator off
    expect(chartOf({ indicators: [] }).indicators).toEqual([]);
    // a missing list means the default, MA 50 + MA 200
    expect(chartOf({}).indicators).toEqual(["ma50_200"]);
  });

  test("compared symbols are cleaned, unique and at most three", () => {
    const many = Array.from({ length: 8 }, (_, index) => `OANDA:SYM${index}`);
    expect(chartOf({ compare: ["oanda:eurusd", "OANDA:EURUSD", "bad symbol", ...many] }).compare).toEqual([
      "OANDA:EURUSD",
      "OANDA:SYM0",
      "OANDA:SYM1",
    ]);
    expect(chartOf({ compare: many }).compare).toHaveLength(MAX_COMPARE_SYMBOLS);
  });

  test("only the offered time zones and panel widths are accepted", () => {
    expect(chartOf({ timezone: "exchange" }).timezone).toBe("exchange");
    expect(chartOf({ timezone: "local" }).timezone).toBe("local");
    expect(chartOf({ timezone: "Mars/Base" }).timezone).toBe("Etc/UTC");
    expect(chartOf({ timezone: "<script>" }).timezone).toBe("Etc/UTC");
    expect(chartOf({ panelWidth: 400 }).panelWidth).toBe(400);
    expect(chartOf({ panelWidth: 250 }).panelWidth).toBe(200);
    expect(chartOf({ panelWidth: "400" }).panelWidth).toBe(200);
  });

  test("garbage is turned into the defaults and sanitising twice changes nothing", () => {
    for (const junk of [null, "x", 5, [], { style: {}, indicators: { 0: "rsi" } }]) {
      expect(chartOf(junk)).toEqual(defaultChartOptions());
    }
    const once = chartOf({ style: "area", indicators: ["vwap"], compare: ["aapl"] });
    expect(sanitizeWorkspace({ tradingview: { chart: once } }).tradingview.chart).toEqual(once);
  });
});

describe("mergeWorkspace", () => {
  test("a patch changes only what it names", () => {
    const current = sanitizeWorkspace({
      view: "split",
      tradingview: { symbol: "NASDAQ:AAPL", watchlist: ["NASDAQ:AAPL"] },
      metatrader: { source: "modern", manualAccounts: [manual("abcdef12")], selection: { kind: "manual", id: "abcdef12" } },
    });
    const next = mergeWorkspace(current, { tradingview: { timeframe: "1H" } });
    expect(next).toEqual({ ...current, tradingview: { ...current.tradingview, timeframe: "1H" } });
  });

  test("panels merge flag by flag", () => {
    const next = mergeWorkspace(defaultWorkspace(), { tradingview: { panels: { details: true } } });
    expect(next.tradingview.panels).toEqual({ watchlist: true, details: true, hotlist: false });
  });

  test("chart options merge field by field; lists are replaced", () => {
    const first = mergeWorkspace(defaultWorkspace(), { tradingview: { chart: { style: "line", volume: true } } });
    expect(first.tradingview.chart).toEqual({ ...defaultChartOptions(), style: "line", volume: true });

    const second = mergeWorkspace(first, { tradingview: { chart: { indicators: ["rsi"], theme: "light" } } });
    expect(second.tradingview.chart).toEqual({
      ...defaultChartOptions(),
      style: "line",
      volume: true,
      indicators: ["rsi"],
      theme: "light",
    });

    // an invalid value keeps the old one, an empty list is a real choice
    const third = mergeWorkspace(second, { tradingview: { chart: { style: "neon", indicators: [] } } });
    expect(third.tradingview.chart.style).toBe("line");
    expect(third.tradingview.chart.indicators).toEqual([]);
  });

  test("the MetaTrader auto-login switch merges on its own", () => {
    const next = mergeWorkspace(defaultWorkspace(), { metatrader: { autoLogin: true } });
    expect(next.metatrader.autoLogin).toBe(true);
    expect(mergeWorkspace(next, { metatrader: { source: "modern" } }).metatrader.autoLogin).toBe(true);
    expect(mergeWorkspace(next, { metatrader: { autoLogin: "no" } }).metatrader.autoLogin).toBe(true);
  });

  test("a new list replaces the old one", () => {
    const next = mergeWorkspace(defaultWorkspace(), { tradingview: { watchlist: ["oanda:eurusd"] } });
    expect(next.tradingview.watchlist).toEqual(["OANDA:EURUSD"]);
  });

  test("accounts and the selection can arrive in one patch", () => {
    const next = mergeWorkspace(defaultWorkspace(), {
      metatrader: { manualAccounts: [manual("abcdef12")], selection: { kind: "manual", id: "abcdef12" } },
    });
    expect(next.metatrader.selection).toEqual({ kind: "manual", id: "abcdef12" });
  });

  test("null clears the selection and the custom address", () => {
    const current = sanitizeWorkspace({
      metatrader: {
        customUrl: "https://webtrader.example-broker.com/",
        selection: { kind: "platform", accountId: ACCOUNT_A },
      },
    });
    const next = mergeWorkspace(current, { metatrader: { selection: null, customUrl: null } });
    expect(next.metatrader.selection).toBeNull();
    expect(next.metatrader.customUrl).toBeNull();
  });

  test("removing a manual account drops a selection that pointed at it", () => {
    const current = sanitizeWorkspace({
      metatrader: { manualAccounts: [manual("abcdef12")], selection: { kind: "manual", id: "abcdef12" } },
    });
    const next = mergeWorkspace(current, { metatrader: { manualAccounts: [] } });
    expect(next.metatrader.manualAccounts).toEqual([]);
    expect(next.metatrader.selection).toBeNull();
  });

  test("invalid values are ignored, the previous ones stay", () => {
    const current = sanitizeWorkspace({
      view: "metatrader",
      split: "rows",
      tradingview: { symbol: "NASDAQ:AAPL", timeframe: "1D" },
      metatrader: {
        source: "modern",
        customUrl: "https://webtrader.example-broker.com/",
        selection: { kind: "platform", accountId: ACCOUNT_A },
      },
    });
    const next = mergeWorkspace(current, {
      view: "hologram",
      split: 7,
      tradingview: { symbol: "<x>", timeframe: "7m", watchlist: "no", panels: { watchlist: "yes" } },
      metatrader: { source: "proxy", customUrl: "javascript:1", selection: { kind: "platform", accountId: "bad" } },
    });
    expect(next).toEqual(current);
  });

  test("a patch that is not an object changes nothing", () => {
    const current = defaultWorkspace();
    expect(mergeWorkspace(current, null)).toBe(current);
    expect(mergeWorkspace(current, "x")).toBe(current);
    expect(mergeWorkspace(current, [])).toBe(current);
  });

  test("the result is always a valid workspace", () => {
    const next = mergeWorkspace(defaultWorkspace(), {
      tradingview: { watchlist: Array.from({ length: 100 }, (_, index) => `OANDA:S${index}`) },
      metatrader: { manualAccounts: Array.from({ length: 50 }, (_, index) => manual(`acct-${index + 100}`)) },
    });
    expect(next.tradingview.watchlist).toHaveLength(MAX_WATCHLIST_SYMBOLS);
    expect(next.metatrader.manualAccounts).toHaveLength(MAX_MANUAL_ACCOUNTS);
    expect(sanitizeWorkspace(next)).toEqual(next);
  });
});

describe("WSA Trade settings and the split partner", () => {
  test("the WSA Trade tab and the split partner are valid choices; anything else falls back", () => {
    expect(sanitizeWorkspace({ view: "wsatrade" }).view).toBe("wsatrade");
    expect(sanitizeWorkspace({ view: "split", splitWith: "wsatrade" }).splitWith).toBe("wsatrade");
    expect(sanitizeWorkspace({ view: "split", splitWith: "metatrader" }).splitWith).toBe("metatrader");
    // a partner that does not exist, or none at all, is the trade panel
    expect(sanitizeWorkspace({ splitWith: "tradingview" }).splitWith).toBe("wsatrade");
    expect(sanitizeWorkspace({ view: "split" }).splitWith).toBe("wsatrade");
    // a view that does not exist is the trade section
    expect(sanitizeWorkspace({ view: "terminal" }).view).toBe("split");
    // a document saved before the panel existed and chose the split view has the new defaults
    const old = sanitizeWorkspace({ version: 2, view: "split", split: "rows" });
    expect(old.split).toBe("rows");
    expect(old.splitWith).toBe("wsatrade");
    expect(old.wsatrade).toEqual(defaultWsaTrade());
  });

  test("the ticket settings are validated: broker symbol spelling kept, lots in thousandths, UUID account", () => {
    const ok = sanitizeWorkspace({
      wsatrade: { accountId: ACCOUNT_A.toUpperCase(), symbol: " EURUSD.m ", volume: 0.25 },
    });
    expect(ok.wsatrade).toEqual({ ...defaultWsaTrade(), accountId: ACCOUNT_A, symbol: "EURUSD.m", volume: 0.25 });

    const bad = sanitizeWorkspace({ wsatrade: { accountId: "not-a-uuid", symbol: "EUR USD; DROP", volume: 0.0001 } });
    expect(bad.wsatrade).toEqual(defaultWsaTrade());
    expect(sanitizeWorkspace({ wsatrade: { volume: 1000 } }).wsatrade.volume).toBe(0.01);
    expect(sanitizeWorkspace({ wsatrade: "oops" }).wsatrade).toEqual(defaultWorkspace().wsatrade);
  });

  test("the trade rules and the starting ticket are validated one by one", () => {
    const ok = sanitizeWorkspace({
      wsatrade: {
        orderKind: "LIMIT",
        levelMode: "points",
        stopLossPoints: 250,
        takeProfitPoints: 500,
        requireStopLoss: true,
        maxVolume: 2.5,
      },
    }).wsatrade;
    expect(ok).toEqual({
      ...defaultWsaTrade(),
      orderKind: "LIMIT",
      levelMode: "points",
      stopLossPoints: 250,
      takeProfitPoints: 500,
      requireStopLoss: true,
      maxVolume: 2.5,
    });

    // every wrong value falls back on its own, the valid ones next to it stay
    const bad = sanitizeWorkspace({
      wsatrade: {
        orderKind: "MARKET_ON_CLOSE",
        levelMode: "pips",
        stopLossPoints: 12.5,
        takeProfitPoints: 0,
        requireStopLoss: 1,
        maxVolume: -3,
        zoom: "big",
        panelShare: 7,
        volume: 0.5,
      },
    }).wsatrade;
    expect(bad).toEqual({ ...defaultWsaTrade(), volume: 0.5 });

    for (const orderKind of ["MARKET", "LIMIT", "STOP"] as const) {
      expect(sanitizeWorkspace({ wsatrade: { orderKind } }).wsatrade.orderKind).toBe(orderKind);
    }
    // distances are whole points between 1 and the cap
    expect(sanitizeWorkspace({ wsatrade: { stopLossPoints: 1 } }).wsatrade.stopLossPoints).toBe(1);
    expect(sanitizeWorkspace({ wsatrade: { stopLossPoints: MAX_WSA_TRADE_LEVEL_POINTS } }).wsatrade.stopLossPoints).toBe(
      MAX_WSA_TRADE_LEVEL_POINTS,
    );
    expect(sanitizeWorkspace({ wsatrade: { stopLossPoints: MAX_WSA_TRADE_LEVEL_POINTS + 1 } }).wsatrade.stopLossPoints).toBeNull();
    expect(sanitizeWorkspace({ wsatrade: { takeProfitPoints: "300" } }).wsatrade.takeProfitPoints).toBeNull();
    // a limit on the volume has to be a volume the broker could accept
    expect(sanitizeWorkspace({ wsatrade: { maxVolume: 0.0004 } }).wsatrade.maxVolume).toBeNull();
    expect(sanitizeWorkspace({ wsatrade: { maxVolume: 1000 } }).wsatrade.maxVolume).toBeNull();
    expect(sanitizeWorkspace({ wsatrade: { maxVolume: 0.001 } }).wsatrade.maxVolume).toBe(0.001);
  });

  test("there is no 'ask before sending' switch any more: a stored one is dropped", () => {
    // an older document still carries `confirm`; it is ignored and never written back
    const stored = sanitizeWorkspace({ wsatrade: { confirm: true, volume: 0.5 } }).wsatrade;
    expect(stored).toEqual({ ...defaultWsaTrade(), volume: 0.5 });
    expect(stored).not.toHaveProperty("confirm");
    expect(mergeWorkspace(defaultWorkspace(), { wsatrade: { confirm: true } }).wsatrade).not.toHaveProperty("confirm");
  });

  test("the size of the panel and its share of the split view are validated", () => {
    expect(sanitizeWorkspace({ wsatrade: { zoom: 0.9, panelShare: 0.35 } }).wsatrade).toMatchObject({ zoom: 0.9, panelShare: 0.35 });
    // the limits themselves are valid, a hair outside is not
    expect(sanitizeWorkspace({ wsatrade: { zoom: 0.6 } }).wsatrade.zoom).toBe(0.6);
    expect(sanitizeWorkspace({ wsatrade: { zoom: 1.6 } }).wsatrade.zoom).toBe(1.6);
    expect(sanitizeWorkspace({ wsatrade: { zoom: 0.59 } }).wsatrade.zoom).toBeNull();
    expect(sanitizeWorkspace({ wsatrade: { zoom: 1.61 } }).wsatrade.zoom).toBeNull();
    expect(sanitizeWorkspace({ wsatrade: { panelShare: 0.2 } }).wsatrade.panelShare).toBe(0.2);
    expect(sanitizeWorkspace({ wsatrade: { panelShare: 0.6 } }).wsatrade.panelShare).toBe(0.6);
    expect(sanitizeWorkspace({ wsatrade: { panelShare: 0.19 } }).wsatrade.panelShare).toBeNull();
    expect(sanitizeWorkspace({ wsatrade: { panelShare: 0.61 } }).wsatrade.panelShare).toBeNull();
    // not numbers: back to "fit" / the usual column
    for (const value of ["1", "0.9", true, [], {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sanitizeWorkspace({ wsatrade: { zoom: value, panelShare: value } }).wsatrade).toMatchObject({ zoom: null, panelShare: null });
    }
    // odd decimals are rounded, so a stored document does not grow noise
    expect(sanitizeWorkspace({ wsatrade: { zoom: 0.9000004, panelShare: 0.3500004 } }).wsatrade).toMatchObject({ zoom: 0.9, panelShare: 0.35 });
  });

  test("a patch changes only the ticket fields it names; null clears the account; garbage is ignored", () => {
    const start = mergeWorkspace(defaultWorkspace(), { wsatrade: { accountId: ACCOUNT_A, symbol: "GBPUSD", volume: 0.5 } });
    expect(start.wsatrade).toEqual({ ...defaultWsaTrade(), accountId: ACCOUNT_A, symbol: "GBPUSD", volume: 0.5 });

    expect(mergeWorkspace(start, { wsatrade: { volume: 2 } }).wsatrade).toEqual({
      ...defaultWsaTrade(),
      accountId: ACCOUNT_A,
      symbol: "GBPUSD",
      volume: 2,
    });
    expect(mergeWorkspace(start, { wsatrade: { accountId: null } }).wsatrade.accountId).toBeNull();
    expect(mergeWorkspace(start, { wsatrade: { accountId: "nope", symbol: "<b>", volume: -1 } }).wsatrade).toEqual(
      start.wsatrade,
    );
    expect(mergeWorkspace(start, { splitWith: "wsatrade", view: "split" })).toMatchObject({
      view: "split",
      splitWith: "wsatrade",
    });
    expect(mergeWorkspace(start, { splitWith: "metatrader", view: "split" }).splitWith).toBe("metatrader");
    // an unknown partner keeps the current one
    expect(mergeWorkspace(start, { splitWith: "nope" }).splitWith).toBe("wsatrade");
    expect(mergeWorkspace(mergeWorkspace(start, { splitWith: "metatrader" }), { splitWith: "nope" }).splitWith).toBe(
      "metatrader",
    );
  });

  test("a patch sets, changes and clears the trade rules; a bad value changes nothing", () => {
    const rules = mergeWorkspace(defaultWorkspace(), {
      wsatrade: {
        orderKind: "STOP",
        levelMode: "points",
        stopLossPoints: 300,
        takeProfitPoints: 900,
        requireStopLoss: true,
        maxVolume: 1.5,
      },
    }).wsatrade;
    expect(rules).toEqual({
      ...defaultWsaTrade(),
      orderKind: "STOP",
      levelMode: "points",
      stopLossPoints: 300,
      takeProfitPoints: 900,
      requireStopLoss: true,
      maxVolume: 1.5,
    });
    const start = mergeWorkspace(defaultWorkspace(), { wsatrade: rules });

    // one field at a time
    expect(mergeWorkspace(start, { wsatrade: { stopLossPoints: 120 } }).wsatrade).toEqual({ ...rules, stopLossPoints: 120 });
    expect(mergeWorkspace(start, { wsatrade: { requireStopLoss: false } }).wsatrade).toEqual({
      ...rules,
      requireStopLoss: false,
    });
    expect(mergeWorkspace(start, { wsatrade: { orderKind: "MARKET" } }).wsatrade.orderKind).toBe("MARKET");

    // null switches the optional ones off
    const cleared = mergeWorkspace(start, { wsatrade: { stopLossPoints: null, takeProfitPoints: null, maxVolume: null } });
    expect(cleared.wsatrade).toEqual({ ...rules, stopLossPoints: null, takeProfitPoints: null, maxVolume: null });

    // garbage keeps what is there
    const garbage = mergeWorkspace(start, {
      wsatrade: {
        orderKind: "NOPE",
        levelMode: "pips",
        stopLossPoints: -4,
        takeProfitPoints: 1.5,
        requireStopLoss: "true",
        maxVolume: 1000,
        zoom: 9,
        panelShare: "wide",
      },
    });
    expect(garbage.wsatrade).toEqual(rules);
  });

  test("a patch sets, changes and clears the size of the panel and its share; a bad value changes nothing", () => {
    const sized = mergeWorkspace(defaultWorkspace(), { wsatrade: { zoom: 0.8, panelShare: 0.4 } });
    expect(sized.wsatrade).toEqual({ ...defaultWsaTrade(), zoom: 0.8, panelShare: 0.4 });

    // one at a time
    expect(mergeWorkspace(sized, { wsatrade: { zoom: 1.2 } }).wsatrade).toEqual({ ...sized.wsatrade, zoom: 1.2 });
    expect(mergeWorkspace(sized, { wsatrade: { panelShare: 0.3 } }).wsatrade).toEqual({ ...sized.wsatrade, panelShare: 0.3 });
    // null = fit to the room / the usual column
    expect(mergeWorkspace(sized, { wsatrade: { zoom: null } }).wsatrade).toEqual({ ...sized.wsatrade, zoom: null });
    expect(mergeWorkspace(sized, { wsatrade: { panelShare: null } }).wsatrade).toEqual({ ...sized.wsatrade, panelShare: null });
    // a value out of range or of the wrong type keeps what is there
    expect(mergeWorkspace(sized, { wsatrade: { zoom: 3, panelShare: 0.9 } }).wsatrade).toEqual(sized.wsatrade);
    expect(mergeWorkspace(sized, { wsatrade: { zoom: "1", panelShare: "0.3" } }).wsatrade).toEqual(sized.wsatrade);
    // a patch about something else leaves them alone
    expect(mergeWorkspace(sized, { wsatrade: { volume: 0.5 } }).wsatrade).toEqual({ ...sized.wsatrade, volume: 0.5 });
    // and the result is a valid document
    expect(sanitizeWorkspace(sized)).toEqual(sized);
  });

  test("the document stays valid and idempotent, and still holds no password", () => {
    const next = mergeWorkspace(defaultWorkspace(), {
      view: "wsatrade",
      wsatrade: { accountId: ACCOUNT_B, symbol: "US30.cash", volume: 0.1, password: "secret", token: "abc" },
    });
    expect(sanitizeWorkspace(next)).toEqual(next);
    expect(JSON.stringify(next)).not.toMatch(/secret|password|token/i);
    expect(Object.keys(next.wsatrade).sort()).toEqual([
      "accountId",
      "levelMode",
      "maxVolume",
      "orderKind",
      "panelShare",
      "requireStopLoss",
      "stopLossPoints",
      "symbol",
      "takeProfitPoints",
      "volume",
      "zoom",
    ]);
  });
});

describe("layout documents from before version 3", () => {
  test("the old starting layout (the bare chart next to MetaTrader) opens as the trade section", () => {
    const old = sanitizeWorkspace({ version: 2, view: "tradingview", split: "columns", splitWith: "metatrader" });
    expect(old.version).toBe(3);
    expect(old.view).toBe("split");
    expect(old.split).toBe("columns");
    expect(old.splitWith).toBe("wsatrade");
    expect(old.wsatrade).toEqual(defaultWsaTrade());

    // saved before the order panel existed: no partner at all, and documents without a version are the oldest
    expect(sanitizeWorkspace({ version: 2, view: "tradingview" }).view).toBe("split");
    expect(sanitizeWorkspace({ version: 2, view: "tradingview" }).splitWith).toBe("wsatrade");
    expect(sanitizeWorkspace({ view: "tradingview", splitWith: "metatrader" })).toMatchObject({
      view: "split",
      splitWith: "wsatrade",
    });
  });

  test("a layout the person chose is kept", () => {
    const stored = [
      { version: 2, view: "metatrader", splitWith: "metatrader" },
      { version: 2, view: "wsatrade", splitWith: "wsatrade" },
      { version: 2, view: "split", split: "rows", splitWith: "metatrader" },
      { version: 2, view: "split", split: "columns", splitWith: "metatrader" },
      // the bare chart tab with another partner or stacked: somebody picked that
      { version: 2, view: "tradingview", split: "columns", splitWith: "wsatrade" },
      { version: 2, view: "tradingview", split: "rows", splitWith: "metatrader" },
    ];
    for (const document of stored) {
      const next = sanitizeWorkspace(document);
      expect(next.view).toBe(document.view);
      expect(next.split).toBe(document.split ?? "columns");
      expect(next.splitWith).toBe(document.splitWith);
    }
  });

  test("a version 3 document that says chart + MetaTrader was chosen and is kept", () => {
    const next = sanitizeWorkspace({ version: 3, view: "tradingview", split: "columns", splitWith: "metatrader" });
    expect(next.view).toBe("tradingview");
    expect(next.splitWith).toBe("metatrader");
  });

  test("the move happens once: sanitising again changes nothing", () => {
    const once = sanitizeWorkspace({ version: 2, view: "tradingview", split: "columns", splitWith: "metatrader" });
    expect(sanitizeWorkspace(once)).toEqual(once);
    // the person goes back to the bare chart tab on purpose: it stays there
    const back = mergeWorkspace(once, { view: "tradingview", splitWith: "metatrader" });
    expect(back.view).toBe("tradingview");
    expect(back.splitWith).toBe("metatrader");
    expect(sanitizeWorkspace(JSON.parse(JSON.stringify(back)))).toEqual(back);
  });

  test("the other settings of an old document survive the move", () => {
    const next = sanitizeWorkspace({
      version: 2,
      view: "tradingview",
      splitWith: "metatrader",
      tradingview: { symbol: "oanda:eurusd", timeframe: "1H" },
      metatrader: { source: "auto", autoLogin: true },
      wsatrade: { accountId: ACCOUNT_A, symbol: "EURUSD.m", volume: 0.2 },
    });
    expect(next.tradingview.symbol).toBe("OANDA:EURUSD");
    expect(next.tradingview.timeframe).toBe("1H");
    expect(next.metatrader.autoLogin).toBe(true);
    expect(next.wsatrade).toEqual({ ...defaultWsaTrade(), accountId: ACCOUNT_A, symbol: "EURUSD.m", volume: 0.2 });
  });
});

describe("layout column", () => {
  test("the workspace lives under one key and other keys are kept", () => {
    const workspace = defaultWorkspace();
    const layout = withWorkspaceInLayout({ legacy: { a: 1 } }, workspace);
    expect(layout).toEqual({ legacy: { a: 1 }, workspace });
    expect(withWorkspaceInLayout(null, workspace)).toEqual({ workspace });
    expect(withWorkspaceInLayout("junk", workspace)).toEqual({ workspace });
  });

  test("reading never fails", () => {
    expect(readWorkspaceFromLayout(null)).toEqual(defaultWorkspace());
    expect(readWorkspaceFromLayout({ workspace: "broken" })).toEqual(defaultWorkspace());
    expect(readWorkspaceFromLayout({ workspace: { view: "split" } }).view).toBe("split");
  });

  test("the size guard is 32 KB", () => {
    expect(MAX_WORKSPACE_BYTES).toBe(32 * 1024);
    // a full document (30 symbols, 20 accounts) stays far below it
    const full = sanitizeWorkspace({
      tradingview: { watchlist: Array.from({ length: 30 }, (_, index) => `BINANCE:LONGSYMBOL${index}USDT`) },
      metatrader: {
        manualAccounts: Array.from({ length: 20 }, (_, index) => manual(`acct-${index + 100}`, { label: "x".repeat(40) })),
        brokerTerminals: Object.fromEntries(
          Array.from({ length: MAX_BROKER_TERMINALS }, (_, index) => [
            `broker${index + 10}:mt5`,
            `https://webtrader.a-long-broker-name-${index + 10}.example.com/terminal/mt5/web`,
          ]),
        ),
      },
    });
    expect(Object.keys(full.metatrader.brokerTerminals)).toHaveLength(MAX_BROKER_TERMINALS);
    expect(JSON.stringify({ workspace: full }).length).toBeLessThan(MAX_WORKSPACE_BYTES / 2);
  });
});
