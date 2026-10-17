import { describe, expect, test } from "vitest";
import {
  POPULAR_TRADING_VIEW_SYMBOLS,
  TRADING_VIEW_WIDGET_SCRIPT,
  buildSymbolOptions,
  buildTradingViewWidgetConfig,
  tradingViewChartUrl,
  tradingViewSymbolUrl,
} from "@/lib/terminal/tradingview";
import {
  DEFAULT_SYMBOL,
  DEFAULT_TRADING_VIEW_SYMBOLS,
  MAX_TRADING_VIEW_INDICATORS,
  MAX_WATCHLIST_SYMBOLS,
  TRADING_VIEW_INDICATORS,
  normalizeTradingViewSymbol,
  symbolLabel,
} from "@/lib/terminal/workspace";

/**
 * The keys TradingView's embed loader passes on to the Advanced Chart (read from the
 * loader script itself). Anything else is silently dropped, so a switch built on
 * another key - like the `calendar` of an earlier version - does nothing.
 */
const WIDGET_KEYS = new Set([
  "container_id", "symbol", "interval", "timezone", "theme", "style", "locale", "allow_symbol_change",
  "backgroundColor", "gridColor", "autosize", "width", "height", "hide_volume", "whitelabel", "range",
  "hide_top_toolbar", "hide_side_toolbar", "hide_legend", "save_image", "watchlist", "editablewatchlist",
  "studies", "extended_hours", "details", "hotlist", "hideideasbutton", "widgetbar_width", "withdateranges",
  "customer", "venue", "symbology", "show_popup_button", "popup_height", "popup_width", "studies_overrides",
  "overrides", "enabled_features", "disabled_features", "publish_source", "whotrades", "referral_id",
  "no_referral_id", "fundamental", "percentage", "padding", "greyText", "horztouchdrag", "verttouchdrag",
  "support_host", "compareSymbols",
]);

describe("buildTradingViewWidgetConfig", () => {
  test("the default chart: dark candles, MA 50 + MA 200 on the price and no volume", () => {
    expect(buildTradingViewWidgetConfig({ symbol: "OANDA:XAUUSD", interval: "15" })).toEqual({
      autosize: true,
      symbol: "OANDA:XAUUSD",
      interval: "15",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: "rgba(10, 10, 10, 1)",
      gridColor: "rgba(255, 255, 255, 0.06)",
      allow_symbol_change: true,
      details: false,
      hide_side_toolbar: false,
      hide_top_toolbar: false,
      hide_legend: false,
      hide_volume: true,
      hotlist: false,
      save_image: false,
      withdateranges: true,
      support_host: "https://www.tradingview.com",
      studies: [{ id: "STD;MA%1Cross", overlay: true, inputs: { in_0: 50, in_1: 200 } }],
    });
  });

  test("every key sent is one the widget reads (nothing dead, nothing that would override the interval)", () => {
    const everything = buildTradingViewWidgetConfig({
      symbol: "OANDA:EURUSD",
      interval: "60",
      watchlist: ["OANDA:EURUSD", "NASDAQ:AAPL"],
      panels: { watchlist: true, details: true, hotlist: true },
      chart: {
        style: "line",
        theme: "light",
        timezone: "local",
        volume: true,
        indicators: ["ma50_200", "ema20", "bollinger", "rsi", "macd"],
        compare: ["OANDA:GBPUSD"],
        extendedHours: true,
        screenshotButton: true,
        popOutButton: true,
        editableWatchlist: true,
        panelWidth: 400,
      },
      localTimezone: "Europe/Tirane",
    });
    for (const key of Object.keys(everything)) expect(WIDGET_KEYS.has(key), key).toBe(true);
    expect(everything).not.toHaveProperty("calendar");
    expect(everything).not.toHaveProperty("range");
    expect(everything).not.toHaveProperty("studies_overrides");
    expect(everything).not.toHaveProperty("overrides");
  });

  test("volume is opt-in: the widget is told to hide it unless it is switched on", () => {
    expect(buildTradingViewWidgetConfig({ symbol: "OANDA:XAUUSD", interval: "15" }).hide_volume).toBe(true);
    expect(
      buildTradingViewWidgetConfig({ symbol: "OANDA:XAUUSD", interval: "15", chart: { volume: true } }).hide_volume,
    ).toBe(false);
  });

  test("indicators are inserted as objects only (the widget drops the objects when plain ids are mixed in)", () => {
    const config = buildTradingViewWidgetConfig({
      symbol: "OANDA:XAUUSD",
      interval: "15",
      chart: { indicators: ["ema20", "vwap", "rsi"] },
    });
    expect(config.studies).toEqual([
      { id: "STD;EMA", overlay: true, inputs: { in_0: 20 } },
      { id: "STD;VWAP", overlay: true },
      { id: "STD;RSI", overlay: false },
    ]);
    for (const study of config.studies as Array<unknown>) expect(typeof study).toBe("object");
  });

  test("with no indicator chosen no studies key is sent", () => {
    const config = buildTradingViewWidgetConfig({ symbol: "OANDA:XAUUSD", interval: "15", chart: { indicators: [] } });
    expect("studies" in config).toBe(false);
  });

  test("chart types use TradingView's style codes", () => {
    const code = (style: "candles" | "hollow" | "bars" | "heikin" | "line" | "area" | "baseline") =>
      buildTradingViewWidgetConfig({ symbol: "OANDA:XAUUSD", interval: "15", chart: { style } }).style;
    expect([code("candles"), code("hollow"), code("bars"), code("heikin"), code("line"), code("area"), code("baseline")]).toEqual([
      "1", "9", "0", "8", "2", "3", "10",
    ]);
  });

  test("the light theme gets light background and grid colours", () => {
    const config = buildTradingViewWidgetConfig({ symbol: "OANDA:XAUUSD", interval: "15", chart: { theme: "light" } });
    expect(config).toMatchObject({
      theme: "light",
      backgroundColor: "rgba(255, 255, 255, 1)",
      gridColor: "rgba(0, 0, 0, 0.06)",
    });
  });

  test("time zone: a named zone, exchange time, or the browser's own", () => {
    const zone = (timezone: string, localTimezone?: string | null) =>
      buildTradingViewWidgetConfig({ symbol: "OANDA:XAUUSD", interval: "15", chart: { timezone }, localTimezone }).timezone;
    expect(zone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(zone("exchange")).toBe("exchange");
    expect(zone("local", "Europe/Tirane")).toBe("Europe/Tirane");
    // a browser that does not report a usable zone falls back to exchange time
    expect(zone("local", null)).toBe("exchange");
    expect(zone("local", "<script>")).toBe("exchange");
    // an unknown zone never reaches the widget
    expect(zone("Mars/Base")).toBe("Etc/UTC");
  });

  test("toolbars, legend, date ranges, symbol search and the screenshot button follow their switches", () => {
    const config = buildTradingViewWidgetConfig({
      symbol: "OANDA:XAUUSD",
      interval: "15",
      chart: {
        drawingToolbar: false,
        topToolbar: false,
        legend: false,
        dateRanges: false,
        symbolSearch: false,
        screenshotButton: true,
      },
    });
    // `hide_side_toolbar` is always sent: left out, the widget hides the drawing tools
    expect(config).toMatchObject({
      hide_side_toolbar: true,
      hide_top_toolbar: true,
      hide_legend: true,
      withdateranges: false,
      allow_symbol_change: false,
      save_image: true,
    });
    expect(buildTradingViewWidgetConfig({ symbol: "OANDA:XAUUSD", interval: "15" }).hide_side_toolbar).toBe(false);
  });

  test("compared symbols are sent with the chosen scale", () => {
    const config = buildTradingViewWidgetConfig({
      symbol: "OANDA:XAUUSD",
      interval: "15",
      chart: { compare: ["oanda:eurusd", "NASDAQ:AAPL"], compareMode: "NewPane" },
    });
    expect(config.compareSymbols).toEqual([
      { symbol: "OANDA:EURUSD", position: "NewPane" },
      { symbol: "NASDAQ:AAPL", position: "NewPane" },
    ]);
    expect("compareSymbols" in buildTradingViewWidgetConfig({ symbol: "OANDA:XAUUSD", interval: "15" })).toBe(false);
  });

  test("extended hours and the pop-out button are only sent when they are on", () => {
    const off = buildTradingViewWidgetConfig({ symbol: "NASDAQ:AAPL", interval: "15" });
    expect("extended_hours" in off).toBe(false);
    expect("show_popup_button" in off).toBe(false);

    const on = buildTradingViewWidgetConfig({
      symbol: "NASDAQ:AAPL",
      interval: "15",
      chart: { extendedHours: true, popOutButton: true },
    });
    expect(on).toMatchObject({ extended_hours: true, show_popup_button: true, popup_width: "1000", popup_height: "650" });
  });

  test("the watchlist panel is configured only when it is on and the list is not empty", () => {
    const list = ["oanda:eurusd", "OANDA:EURUSD", "NASDAQ:AAPL"];
    const on = buildTradingViewWidgetConfig({
      symbol: "OANDA:EURUSD",
      interval: "60",
      watchlist: list,
      panels: { watchlist: true },
    });
    expect(on.watchlist).toEqual(["OANDA:EURUSD", "NASDAQ:AAPL"]);

    const off = buildTradingViewWidgetConfig({
      symbol: "OANDA:EURUSD",
      interval: "60",
      watchlist: list,
      panels: { watchlist: false },
    });
    expect("watchlist" in off).toBe(false);

    const empty = buildTradingViewWidgetConfig({
      symbol: "OANDA:EURUSD",
      interval: "60",
      watchlist: [],
      panels: { watchlist: true },
    });
    expect("watchlist" in empty).toBe(false);
  });

  test("an editable watchlist and the panel width need a panel to apply to", () => {
    const base = { symbol: "OANDA:EURUSD", interval: "60", watchlist: ["OANDA:EURUSD"] } as const;
    const editable = buildTradingViewWidgetConfig({
      ...base,
      panels: { watchlist: true },
      chart: { editableWatchlist: true, panelWidth: 300 },
    });
    expect(editable).toMatchObject({ editablewatchlist: true, widgetbar_width: 300 });

    // no panel on: nothing to edit and nothing to widen
    const none = buildTradingViewWidgetConfig({ ...base, chart: { editableWatchlist: true, panelWidth: 400 } });
    expect("editablewatchlist" in none).toBe(false);
    expect("widgetbar_width" in none).toBe(false);

    // the widget's own width (200) is left to the widget
    const narrow = buildTradingViewWidgetConfig({ ...base, panels: { details: true } });
    expect("widgetbar_width" in narrow).toBe(false);
    const detailsOnly = buildTradingViewWidgetConfig({ ...base, panels: { details: true }, chart: { panelWidth: 400 } });
    expect(detailsOnly.widgetbar_width).toBe(400);
  });

  test("details and hotlist follow their flags", () => {
    const config = buildTradingViewWidgetConfig({
      symbol: "NASDAQ:AAPL",
      interval: "D",
      panels: { details: true, hotlist: true },
    });
    expect(config).toMatchObject({ details: true, hotlist: true });
  });

  test("the watchlist is cleaned and capped", () => {
    const many = Array.from({ length: 80 }, (_, index) => `OANDA:SYM${index}`);
    const config = buildTradingViewWidgetConfig({
      symbol: "OANDA:SYM1",
      interval: "5",
      watchlist: ["bad symbol", ...many],
      panels: { watchlist: true },
    });
    expect(config.watchlist).toHaveLength(MAX_WATCHLIST_SYMBOLS);
    expect((config.watchlist as string[]).every((symbol) => normalizeTradingViewSymbol(symbol) === symbol)).toBe(true);
  });

  test("an unusable symbol falls back to the default one", () => {
    expect(buildTradingViewWidgetConfig({ symbol: "</script><b>", interval: "15" }).symbol).toBe(DEFAULT_SYMBOL);
  });

  test("the JSON placed in the script tag can not close it", () => {
    const json = JSON.stringify(
      buildTradingViewWidgetConfig({
        symbol: "</script>",
        interval: "15",
        watchlist: ["</script>", ...POPULAR_TRADING_VIEW_SYMBOLS],
        panels: { watchlist: true, details: true },
        chart: {
          compare: ["</script>", "OANDA:EURUSD"],
          timezone: "</script>",
          indicators: ["rsi", "</script>" as never],
          style: "</script>" as never,
        },
        localTimezone: "</script>",
      }),
    );
    expect(json).not.toContain("<");
  });

  test("the embed script is TradingView's own", () => {
    expect(TRADING_VIEW_WIDGET_SCRIPT).toBe(
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js",
    );
  });
});

describe("indicator catalogue", () => {
  test("ids are unique, studies are TradingView built-ins, and at most five fit the widget", () => {
    const ids = TRADING_VIEW_INDICATORS.map((indicator) => indicator.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const indicator of TRADING_VIEW_INDICATORS) {
      expect(indicator.study).toMatch(/^STD;[A-Za-z0-9_%]+$/);
      expect(indicator.label.length).toBeGreaterThan(0);
    }
    expect(MAX_TRADING_VIEW_INDICATORS).toBe(5);
  });

  test("the default pair is a 50 / 200 moving-average cross", () => {
    const pair = TRADING_VIEW_INDICATORS.find((indicator) => indicator.id === "ma50_200");
    expect(pair).toMatchObject({ study: "STD;MA%1Cross", overlay: true, inputs: { in_0: 50, in_1: 200 } });
  });
});

describe("TradingView links", () => {
  test("pop-out chart address", () => {
    expect(tradingViewChartUrl("OANDA:XAUUSD", "15")).toBe(
      "https://www.tradingview.com/chart/?symbol=OANDA%3AXAUUSD&interval=15",
    );
    expect(tradingViewChartUrl("javascript:alert(1)", "D")).toBe(
      `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(DEFAULT_SYMBOL)}&interval=D`,
    );
  });

  test("symbol page used by the attribution link", () => {
    expect(tradingViewSymbolUrl("OANDA:XAUUSD")).toBe("https://www.tradingview.com/symbols/OANDA-XAUUSD/");
    expect(tradingViewSymbolUrl("aapl")).toBe("https://www.tradingview.com/symbols/AAPL/");
    expect(tradingViewSymbolUrl("<img src=x>")).toBe(
      `https://www.tradingview.com/symbols/${DEFAULT_SYMBOL.replace(":", "-")}/`,
    );
  });
});

describe("buildSymbolOptions", () => {
  test("lists the watchlist in order", () => {
    const options = buildSymbolOptions(["OANDA:XAUUSD", "NASDAQ:AAPL"], "NASDAQ:AAPL", symbolLabel);
    expect(options).toEqual([
      { value: "OANDA:XAUUSD", label: "XAUUSD" },
      { value: "NASDAQ:AAPL", label: "AAPL" },
    ]);
  });

  test("keeps the open symbol selectable even when it is not in the watchlist", () => {
    const options = buildSymbolOptions(["OANDA:XAUUSD"], "NASDAQ:TSLA", symbolLabel);
    expect(options.map((option) => option.value)).toEqual(["NASDAQ:TSLA", "OANDA:XAUUSD"]);
  });

  test("an empty watchlist still offers the open symbol", () => {
    expect(buildSymbolOptions([], "OANDA:EURUSD", symbolLabel)).toEqual([{ value: "OANDA:EURUSD", label: "EURUSD" }]);
  });
});

describe("suggestions", () => {
  test("every suggested symbol is valid and listed once", () => {
    expect(new Set(POPULAR_TRADING_VIEW_SYMBOLS).size).toBe(POPULAR_TRADING_VIEW_SYMBOLS.length);
    for (const symbol of POPULAR_TRADING_VIEW_SYMBOLS) expect(normalizeTradingViewSymbol(symbol)).toBe(symbol);
  });

  test("they include the default symbols", () => {
    for (const symbol of Object.values(DEFAULT_TRADING_VIEW_SYMBOLS)) {
      expect(POPULAR_TRADING_VIEW_SYMBOLS).toContain(symbol);
    }
  });
});
