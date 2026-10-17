/**
 * TradingView embed helpers (pure, no I/O - safe in the browser and in tests).
 *
 * What the embedded chart can and cannot do (verified against TradingView's
 * public pages and against the widget's own script):
 *  - tradingview.com itself (sign-in, saved layouts, alerts, your own watchlists)
 *    answers with `Content-Security-Policy: frame-ancestors 'none'`, so it can not
 *    be shown inside another site. Hiding that header by proxying the site is not
 *    done: it would put TradingView credentials in front of this platform.
 *  - The free "Advanced Chart" widget has no sign-in. It takes its symbol list
 *    (`watchlist`) and side panels (`details`, `hotlist`) from the embed
 *    configuration, so a per-user watchlist is kept in WSA and passed in here; it
 *    is not synchronised with the user's TradingView account. (There is no
 *    `calendar` option: the widget script ignores unknown keys, so it is not sent.)
 *  - Only the keys the widget's loader whitelists are used: symbol, interval,
 *    timezone, theme, style, locale, backgroundColor, gridColor, allow_symbol_change,
 *    hide_volume, hide_top_toolbar, hide_side_toolbar, hide_legend, save_image,
 *    watchlist, editablewatchlist, studies, extended_hours, details, hotlist,
 *    widgetbar_width, withdateranges, show_popup_button, popup_width/height,
 *    compareSymbols, support_host. `hide_side_toolbar` must be sent explicitly
 *    (left out, the drawing tools are hidden), `range` is never sent (it would
 *    override the interval) and `studies` is an array of objects only (a mix with
 *    plain ids makes the widget ignore the objects).
 *  - The only embeddable product with accounts, saved layouts and trading is the
 *    licensed Advanced Charts / Trading Terminal library, which needs a data feed
 *    of the company's own and a licence from TradingView.
 */

import {
  DEFAULT_SYMBOL,
  DEFAULT_TRADING_VIEW_SYMBOLS,
  TRADING_VIEW_CHART_STYLES,
  TRADING_VIEW_INDICATORS,
  normalizeTradingViewSymbol,
  sanitizeChartOptions,
  sanitizeWatchlist,
  type TradingViewChartOptions,
  type TradingViewPanels,
} from "@/lib/terminal/workspace";

export const TRADING_VIEW_WIDGET_SCRIPT =
  "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

export const TRADING_VIEW_ORIGIN = "https://www.tradingview.com";

export interface TradingViewWidgetOptions {
  symbol: string;
  /** TradingView interval code: "1", "5", "15", "60", "240", "D" */
  interval: string;
  watchlist?: ReadonlyArray<string>;
  panels?: Partial<TradingViewPanels>;
  /** missing fields take the defaults (candles, dark, UTC, MA 50 + MA 200, no volume) */
  chart?: Partial<TradingViewChartOptions>;
  /** IANA name of the browser's time zone, used for "My browser's time" */
  localTimezone?: string | null;
}

const IANA_ZONE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;

/** "local" -> the browser's own zone (when it looks like an IANA name), otherwise exchange time. */
function resolveTimezone(setting: string, localTimezone: string | null | undefined): string {
  if (setting !== "local") return setting;
  return localTimezone && IANA_ZONE.test(localTimezone) ? localTimezone : "exchange";
}

/** The studies the widget is asked to insert: objects only, never a mix with plain ids. */
function studiesFor(chart: TradingViewChartOptions): Array<{ id: string; overlay: boolean; inputs?: Record<string, number> }> {
  const studies: Array<{ id: string; overlay: boolean; inputs?: Record<string, number> }> = [];
  for (const id of chart.indicators) {
    const indicator = TRADING_VIEW_INDICATORS.find((entry) => entry.id === id);
    if (!indicator) continue;
    studies.push({
      id: indicator.study,
      overlay: indicator.overlay,
      ...(indicator.inputs ? { inputs: { ...indicator.inputs } } : {}),
    });
  }
  return studies;
}

/**
 * The JSON the embed script reads. Without options it is the terminal's default
 * chart: dark candles, UTC, MA 50 + MA 200 on the price (no volume), all toolbars
 * and no side panels.
 */
export function buildTradingViewWidgetConfig(options: TradingViewWidgetOptions): Record<string, unknown> {
  const panels = options.panels ?? {};
  const chart = sanitizeChartOptions(options.chart);
  const watchlist = sanitizeWatchlist(options.watchlist ?? []);
  const light = chart.theme === "light";
  const styleCode = TRADING_VIEW_CHART_STYLES.find((entry) => entry.id === chart.style)?.code ?? "1";

  const config: Record<string, unknown> = {
    autosize: true,
    symbol: normalizeTradingViewSymbol(options.symbol) ?? DEFAULT_SYMBOL,
    interval: options.interval,
    timezone: resolveTimezone(chart.timezone, options.localTimezone),
    theme: chart.theme,
    style: styleCode,
    locale: "en",
    backgroundColor: light ? "rgba(255, 255, 255, 1)" : "rgba(10, 10, 10, 1)",
    gridColor: light ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.06)",
    allow_symbol_change: chart.symbolSearch,
    details: panels.details === true,
    hide_side_toolbar: !chart.drawingToolbar,
    hide_top_toolbar: !chart.topToolbar,
    hide_legend: !chart.legend,
    hide_volume: !chart.volume,
    hotlist: panels.hotlist === true,
    save_image: chart.screenshotButton,
    withdateranges: chart.dateRanges,
    support_host: TRADING_VIEW_ORIGIN,
  };

  const studies = studiesFor(chart);
  if (studies.length > 0) config.studies = studies;

  if (chart.compare.length > 0) {
    config.compareSymbols = chart.compare.map((symbol) => ({ symbol, position: chart.compareMode }));
  }
  if (chart.extendedHours) config.extended_hours = true;
  if (chart.popOutButton) {
    config.show_popup_button = true;
    config.popup_width = "1000";
    config.popup_height = "650";
  }

  // an empty list would open an empty panel, so the key is left out instead
  const showWatchlist = panels.watchlist === true && watchlist.length > 0;
  if (showWatchlist) {
    config.watchlist = watchlist;
    if (chart.editableWatchlist) config.editablewatchlist = true;
  }
  if ((showWatchlist || panels.details === true || panels.hotlist === true) && chart.panelWidth > 200) {
    config.widgetbar_width = chart.panelWidth;
  }
  return config;
}

/** The same chart on tradingview.com (opened in a new tab: sign-in, layouts and alerts live there). */
export function tradingViewChartUrl(symbol: string, interval: string): string {
  const url = new URL("/chart/", TRADING_VIEW_ORIGIN);
  url.searchParams.set("symbol", normalizeTradingViewSymbol(symbol) ?? DEFAULT_SYMBOL);
  url.searchParams.set("interval", interval);
  return url.toString();
}

/** TradingView's page of one symbol (target of the widget's required "Chart by TradingView" link). */
export function tradingViewSymbolUrl(symbol: string): string {
  const slug = (normalizeTradingViewSymbol(symbol) ?? DEFAULT_SYMBOL).replace(":", "-");
  return `${TRADING_VIEW_ORIGIN}/symbols/${encodeURIComponent(slug)}/`;
}

export interface SymbolOption {
  label: string;
  value: string;
}

/** Entries of the symbol picker: the watchlist, plus the open symbol when it is not part of it. */
export function buildSymbolOptions(
  watchlist: ReadonlyArray<string>,
  current: string,
  labelOf: (symbol: string) => string,
): SymbolOption[] {
  const values = watchlist.includes(current) ? [...watchlist] : [current, ...watchlist];
  return values.map((value) => ({ value, label: labelOf(value) }));
}

/** Suggestions for the "add symbol" box - all of them are valid TradingView symbols. */
export const POPULAR_TRADING_VIEW_SYMBOLS: ReadonlyArray<string> = [
  ...Object.values(DEFAULT_TRADING_VIEW_SYMBOLS),
  "OANDA:XAGUSD",
  "OANDA:AUDUSD",
  "OANDA:USDCAD",
  "OANDA:USDCHF",
  "OANDA:NZDUSD",
  "OANDA:EURJPY",
  "OANDA:GBPJPY",
  "OANDA:SPX500USD",
  "OANDA:DE30EUR",
  "OANDA:WTICOUSD",
  "BINANCE:SOLUSDT",
  "BINANCE:XRPUSDT",
  "NASDAQ:AAPL",
  "NASDAQ:MSFT",
  "NASDAQ:NVDA",
  "NASDAQ:TSLA",
  "NASDAQ:AMZN",
  "NASDAQ:GOOGL",
];
