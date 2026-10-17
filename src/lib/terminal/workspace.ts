/**
 * Terminal workspace document: which terminal tab is open, the TradingView
 * settings (symbol, timeframe, personal watchlist, side panels, chart options
 * such as style, indicators and toolbars), the MetaTrader web terminal
 * settings (source, selected account, accounts added by hand) and the WSA Trade
 * order panel (account, symbol, volume, order type and the person's own trade
 * rules such as "ask before sending", "always a stop loss", "never above N lots").
 *
 * It is stored per user in `terminal_user_preferences.layout.workspace` (JSONB,
 * migration 016), so no new migration is needed. Everything here is pure and
 * TOTAL: `sanitizeWorkspace` accepts any value (a stale or hand-edited document,
 * a hostile request body) and always returns a valid workspace, so neither the
 * route handler nor the page can ever fail on bad stored data.
 *
 * There is intentionally no password anywhere in this document.
 */

import { isBrokerTerminalKey } from "@/lib/terminal/brokerTerminal";
import {
  isValidLots,
  normalizeTradeSymbol,
  WEB_TRADE_ORDER_KINDS,
  type WebTradeOrderKind,
} from "@/lib/trade/webTrade";
import {
  MAX_MANUAL_ACCOUNTS,
  isMetaTraderSource,
  normalizePlatform,
  sanitizeLabel,
  sanitizeLogin,
  sanitizeServer,
  maskLogin,
  validateCustomTerminalUrl,
  type ManualMetaTraderAccount,
  type MetaTraderSource,
} from "@/lib/terminal/metatrader";

/**
 * 2: the MetaTrader source "auto" became the default and `brokerTerminals` was
 * added. A document saved before (version 1) that still says "classic" never chose
 * it - it was the default - and is read as "auto".
 *
 * 3: the terminal became a trade section. It opens as the split view with the chart
 * on the left and the WSA Trade panel on the right, and the panel got the person's
 * trade rules. A document saved before (version 2) that still holds exactly the old
 * starting layout (the bare chart tab, MetaTrader as the partner, side by side) never
 * chose it - it was the default - and follows the new one.
 */
export const WORKSPACE_VERSION = 3 as const;

/** Addresses of broker web terminals a user typed in, kept per broker + platform. */
export const MAX_BROKER_TERMINALS = 20;

export type TerminalView = "tradingview" | "metatrader" | "wsatrade" | "split";
export type SplitDirection = "columns" | "rows";
/** What sits next to the TradingView chart in the split view. */
export type SplitPartner = "metatrader" | "wsatrade";

export const TERMINAL_VIEWS: ReadonlyArray<TerminalView> = ["tradingview", "metatrader", "wsatrade", "split"];
export const SPLIT_DIRECTIONS: ReadonlyArray<SplitDirection> = ["columns", "rows"];
export const SPLIT_PARTNERS: ReadonlyArray<SplitPartner> = ["metatrader", "wsatrade"];

export type TerminalTimeframe = "1m" | "5m" | "15m" | "30m" | "1H" | "4H" | "1D" | "1W" | "1M";

export const TERMINAL_TIMEFRAMES: ReadonlyArray<TerminalTimeframe> = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1H",
  "4H",
  "1D",
  "1W",
  "1M",
];

/** TradingView's own interval codes. */
export const TIMEFRAME_TO_INTERVAL: Record<TerminalTimeframe, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1H": "60",
  "4H": "240",
  "1D": "D",
  "1W": "W",
  "1M": "M",
};

/** The symbols the terminal always knew; also the starting watchlist. */
export const DEFAULT_TRADING_VIEW_SYMBOLS: Record<string, string> = {
  XAUUSD: "OANDA:XAUUSD",
  EURUSD: "OANDA:EURUSD",
  GBPUSD: "OANDA:GBPUSD",
  USDJPY: "OANDA:USDJPY",
  NAS100: "OANDA:NAS100USD",
  US30: "OANDA:US30USD",
  BTCUSD: "BINANCE:BTCUSDT",
  ETHUSD: "BINANCE:ETHUSDT",
};

export const MAX_WATCHLIST_SYMBOLS = 30;
export const DEFAULT_SYMBOL = DEFAULT_TRADING_VIEW_SYMBOLS.XAUUSD;
export const DEFAULT_TIMEFRAME: TerminalTimeframe = "15m";

export interface TradingViewPanels {
  /** the symbol list on the right of the chart (needs a non-empty watchlist) */
  watchlist: boolean;
  /** symbol details (market cap, sector, ...) */
  details: boolean;
  /** top gainers / losers */
  hotlist: boolean;
}

export type TradingViewChartStyle = "candles" | "hollow" | "bars" | "heikin" | "line" | "area" | "baseline";

/** The `style` codes of TradingView's embed widget (read from the widget's own script). */
export const TRADING_VIEW_CHART_STYLES: ReadonlyArray<{ id: TradingViewChartStyle; label: string; code: string }> = [
  { id: "candles", label: "Candles", code: "1" },
  { id: "hollow", label: "Hollow candles", code: "9" },
  { id: "bars", label: "Bars", code: "0" },
  { id: "heikin", label: "Heikin Ashi", code: "8" },
  { id: "line", label: "Line", code: "2" },
  { id: "area", label: "Area", code: "3" },
  { id: "baseline", label: "Baseline", code: "10" },
];

export type TradingViewTheme = "dark" | "light";
export const TRADING_VIEW_THEMES: ReadonlyArray<TradingViewTheme> = ["dark", "light"];

/** Time zones of the chart's time axis; "local" is the time zone of the browser. */
export const TRADING_VIEW_TIMEZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Etc/UTC", label: "UTC" },
  { value: "local", label: "My browser's time" },
  { value: "exchange", label: "Exchange time" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Berlin", label: "Berlin / Tirana (CET)" },
  { value: "Europe/Athens", label: "Athens (EET)" },
  { value: "Europe/Istanbul", label: "Istanbul" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "America/New_York", label: "New York" },
  { value: "America/Chicago", label: "Chicago" },
  { value: "America/Los_Angeles", label: "Los Angeles" },
];

export type TradingViewIndicatorId =
  | "ma50_200"
  | "ema20"
  | "bollinger"
  | "vwap"
  | "supertrend"
  | "ichimoku"
  | "rsi"
  | "macd"
  | "stochastic";

export interface TradingViewIndicator {
  id: TradingViewIndicatorId;
  label: string;
  hint: string;
  /** TradingView's study id (`STD;...`) */
  study: string;
  /** drawn on the price chart (otherwise in a pane of its own) */
  overlay: boolean;
  /** inputs by TradingView's own names (`in_0`, ...) */
  inputs?: Record<string, number>;
}

/**
 * The indicators that can be switched on from the options panel. Ids and input
 * names come from TradingView's study catalogue; each one is inserted by the
 * widget itself. The default is MA 50 + MA 200 (no volume).
 */
export const TRADING_VIEW_INDICATORS: ReadonlyArray<TradingViewIndicator> = [
  {
    id: "ma50_200",
    label: "MA 50 / MA 200",
    hint: "Simple moving averages of 50 (orange) and 200 (green) bars; a dot marks every crossing",
    study: "STD;MA%1Cross",
    overlay: true,
    inputs: { in_0: 50, in_1: 200 },
  },
  { id: "ema20", label: "EMA 20", hint: "Exponential moving average, 20 bars", study: "STD;EMA", overlay: true, inputs: { in_0: 20 } },
  { id: "bollinger", label: "Bollinger Bands", hint: "20 bars, 2 standard deviations", study: "STD;Bollinger_Bands", overlay: true },
  { id: "vwap", label: "VWAP", hint: "Volume-weighted average price (intraday)", study: "STD;VWAP", overlay: true },
  { id: "supertrend", label: "Supertrend", hint: "ATR 10, factor 3", study: "STD;Supertrend", overlay: true },
  { id: "ichimoku", label: "Ichimoku Cloud", hint: "9 / 26 / 52 / 26", study: "STD;Ichimoku%1Cloud", overlay: true },
  { id: "rsi", label: "RSI (14)", hint: "Relative strength index in its own pane", study: "STD;RSI", overlay: false },
  { id: "macd", label: "MACD", hint: "12 / 26 / 9, in its own pane", study: "STD;MACD", overlay: false },
  { id: "stochastic", label: "Stochastic", hint: "Stochastic oscillator in its own pane", study: "STD;Stochastic", overlay: false },
];

/** The widget inserts at most five studies. */
export const MAX_TRADING_VIEW_INDICATORS = 5;
export const DEFAULT_TRADING_VIEW_INDICATORS: ReadonlyArray<TradingViewIndicatorId> = ["ma50_200"];

export type TradingViewCompareMode = "SameScale" | "NewPriceScale" | "NewPane";
export const TRADING_VIEW_COMPARE_MODES: ReadonlyArray<{ id: TradingViewCompareMode; label: string }> = [
  { id: "SameScale", label: "Same % scale" },
  { id: "NewPriceScale", label: "New price scale" },
  { id: "NewPane", label: "New pane" },
];
export const MAX_COMPARE_SYMBOLS = 3;

/** Width of the right-hand panels (watchlist, details, hotlist) in pixels; 200 is the widget's own. */
export const TRADING_VIEW_PANEL_WIDTHS: ReadonlyArray<number> = [200, 300, 400];

/** What the embedded TradingView chart is told to show. Every field maps to an option of the widget. */
export interface TradingViewChartOptions {
  style: TradingViewChartStyle;
  theme: TradingViewTheme;
  /** one of `TRADING_VIEW_TIMEZONES` */
  timezone: string;
  /** the volume study at the bottom of the chart (off by default) */
  volume: boolean;
  indicators: TradingViewIndicatorId[];
  /** symbols plotted over the main one (at most 3) */
  compare: string[];
  compareMode: TradingViewCompareMode;
  extendedHours: boolean;
  /** drawing tools on the left */
  drawingToolbar: boolean;
  /** symbol, interval, style and indicator buttons on top */
  topToolbar: boolean;
  /** the symbol / OHLC legend inside the chart */
  legend: boolean;
  /** the 1D / 5D / 1M ... buttons below the chart */
  dateRanges: boolean;
  /** TradingView's own symbol search */
  symbolSearch: boolean;
  /** camera button (picture of the chart) */
  screenshotButton: boolean;
  /** button that opens the chart in a window of its own */
  popOutButton: boolean;
  /** lets the user edit the watchlist panel inside the chart (not saved in WSA) */
  editableWatchlist: boolean;
  panelWidth: number;
}

export interface TradingViewWorkspace {
  /** `EXCHANGE:TICKER` */
  symbol: string;
  timeframe: TerminalTimeframe;
  watchlist: string[];
  panels: TradingViewPanels;
  chart: TradingViewChartOptions;
}

export type MetaTraderSelection =
  | { kind: "platform"; accountId: string }
  | { kind: "manual"; id: string };

export interface MetaTraderWorkspace {
  source: MetaTraderSource;
  /** the broker's own web terminal, only used with source "custom" */
  customUrl: string | null;
  /**
   * Web terminal addresses this user entered because the automatic search found
   * none, per broker and platform (`icmarketssc:mt5` -> https address). They win
   * over what the platform finds.
   */
  brokerTerminals: Record<string, string>;
  selection: MetaTraderSelection | null;
  manualAccounts: ManualMetaTraderAccount[];
  /**
   * Let the terminal reconnect on its own to the account it used last (needs a
   * password saved inside the terminal). Off: the sign-in form of the account
   * chosen here always comes up.
   */
  autoLogin: boolean;
}

/** How the stop loss / take profit boxes of the ticket are typed: as prices, or as a distance from the entry in points. */
export type WsaTradeLevelMode = "price" | "points";
export const WSA_TRADE_LEVEL_MODES: ReadonlyArray<WsaTradeLevelMode> = ["price", "points"];

/**
 * The WSA Trade order panel: which of the user's accounts it trades, what the ticket starts
 * with and the person's own trade rules. The rules are checked in the panel BEFORE an order is
 * sent (they are the person's discipline, not the platform's gates, which the server enforces).
 */
export interface WsaTradeWorkspace {
  /** a platform account of this user; null = the first one that is ready */
  accountId: string | null;
  /** the broker's own spelling of the symbol (`XAUUSD`, `EURUSD.m`) */
  symbol: string;
  /** lots the ticket starts with */
  volume: number;
  /** the order type the ticket starts with: at the market, or waiting for a price */
  orderKind: WebTradeOrderKind;
  /** ask once more before an order leaves; off = one click sends it */
  confirm: boolean;
  /** how the stop loss / take profit boxes are typed */
  levelMode: WsaTradeLevelMode;
  /** a new ticket starts with a stop loss this many points from the entry (null = none) */
  stopLossPoints: number | null;
  /** a new ticket starts with a take profit this many points from the entry (null = none) */
  takeProfitPoints: number | null;
  /** rule: refuse to send a new order without a stop loss */
  requireStopLoss: boolean;
  /** rule: refuse to send a new order above this many lots (null = no limit) */
  maxVolume: number | null;
}

export const DEFAULT_WSA_TRADE_SYMBOL = "XAUUSD";
export const DEFAULT_WSA_TRADE_VOLUME = 0.01;
export const DEFAULT_WSA_TRADE_ORDER_KIND: WebTradeOrderKind = "MARKET";
/** A distance in points the ticket may start with (a million points is far beyond any sensible stop). */
export const MAX_WSA_TRADE_LEVEL_POINTS = 1_000_000;

export function defaultWsaTrade(): WsaTradeWorkspace {
  return {
    accountId: null,
    symbol: DEFAULT_WSA_TRADE_SYMBOL,
    volume: DEFAULT_WSA_TRADE_VOLUME,
    orderKind: DEFAULT_WSA_TRADE_ORDER_KIND,
    confirm: true,
    levelMode: "price",
    stopLossPoints: null,
    takeProfitPoints: null,
    requireStopLoss: false,
    maxVolume: null,
  };
}

export interface TerminalWorkspace {
  version: typeof WORKSPACE_VERSION;
  view: TerminalView;
  split: SplitDirection;
  /** what the split view shows next to the chart */
  splitWith: SplitPartner;
  tradingview: TradingViewWorkspace;
  metatrader: MetaTraderWorkspace;
  wsatrade: WsaTradeWorkspace;
}

export type TerminalWorkspacePatch = {
  view?: TerminalView;
  split?: SplitDirection;
  splitWith?: SplitPartner;
  tradingview?: Partial<Omit<TradingViewWorkspace, "panels" | "chart">> & {
    panels?: Partial<TradingViewPanels>;
    chart?: Partial<TradingViewChartOptions>;
  };
  metatrader?: Partial<Omit<MetaTraderWorkspace, "brokerTerminals">> & {
    /** an address sets / replaces the entry of a broker, null removes it */
    brokerTerminals?: Record<string, string | null>;
  };
  wsatrade?: Partial<WsaTradeWorkspace>;
};

export type TradingViewPatch = NonNullable<TerminalWorkspacePatch["tradingview"]>;
export type MetaTraderPatch = NonNullable<TerminalWorkspacePatch["metatrader"]>;
export type WsaTradePatch = NonNullable<TerminalWorkspacePatch["wsatrade"]>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANUAL_ID = /^[A-Za-z0-9_-]{6,64}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
const EXCHANGE_SYMBOL = /^[A-Z0-9_]{1,30}:[A-Z0-9][A-Z0-9._!&-]{0,39}$/;
const BARE_SYMBOL = /^[A-Z0-9][A-Z0-9._!&-]{0,39}$/;

/**
 * `oanda:xauusd` / " EURUSD " -> `OANDA:XAUUSD` / `EURUSD`; anything that is not a
 * plain TradingView symbol (spaces, quotes, markup, expressions) -> null.
 */
export function normalizeTradingViewSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  if (upper.length === 0 || upper.length > 70) return null;
  return EXCHANGE_SYMBOL.test(upper) || BARE_SYMBOL.test(upper) ? upper : null;
}

/** Normalised, de-duplicated, capped list. */
export function sanitizeWatchlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const symbol = normalizeTradingViewSymbol(entry);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    result.push(symbol);
    if (result.length >= MAX_WATCHLIST_SYMBOLS) break;
  }
  return result;
}

export function isTerminalTimeframe(value: unknown): value is TerminalTimeframe {
  return typeof value === "string" && (TERMINAL_TIMEFRAMES as ReadonlyArray<string>).includes(value);
}

/** Short name of a TradingView symbol: `OANDA:XAUUSD` -> `XAUUSD`. */
export function symbolLabel(symbol: string): string {
  const known = Object.entries(DEFAULT_TRADING_VIEW_SYMBOLS).find(([, value]) => value === symbol);
  if (known) return known[0];
  const colon = symbol.indexOf(":");
  return colon >= 0 ? symbol.slice(colon + 1) : symbol;
}

export function defaultWatchlist(): string[] {
  return Object.values(DEFAULT_TRADING_VIEW_SYMBOLS);
}

export function defaultChartOptions(): TradingViewChartOptions {
  return {
    style: "candles",
    theme: "dark",
    timezone: "Etc/UTC",
    volume: false,
    indicators: [...DEFAULT_TRADING_VIEW_INDICATORS],
    compare: [],
    compareMode: "SameScale",
    extendedHours: false,
    drawingToolbar: true,
    topToolbar: true,
    legend: true,
    dateRanges: true,
    symbolSearch: true,
    screenshotButton: false,
    popOutButton: false,
    editableWatchlist: false,
    panelWidth: 200,
  };
}

/** Known indicators only, no duplicates, at most five - in the order of the catalogue. */
function sanitizeIndicators(value: unknown[]): TradingViewIndicatorId[] {
  const chosen = new Set<TradingViewIndicatorId>();
  for (const entry of value) {
    const known = TRADING_VIEW_INDICATORS.find((indicator) => indicator.id === entry);
    if (known) chosen.add(known.id);
    if (chosen.size >= MAX_TRADING_VIEW_INDICATORS) break;
  }
  return TRADING_VIEW_INDICATORS.filter((indicator) => chosen.has(indicator.id)).map((indicator) => indicator.id);
}

function sanitizeCompareSymbols(value: unknown[]): string[] {
  const result: string[] = [];
  for (const entry of value) {
    const symbol = normalizeTradingViewSymbol(entry);
    if (symbol && !result.includes(symbol)) result.push(symbol);
    if (result.length >= MAX_COMPARE_SYMBOLS) break;
  }
  return result;
}

/**
 * Any value in, valid chart options out. A field that is missing or not valid
 * keeps the value of `base` (the defaults, or the options the user has now), so
 * a partial or hostile patch can never reset a setting it did not name.
 */
export function sanitizeChartOptions(
  input: unknown,
  base: TradingViewChartOptions = defaultChartOptions(),
): TradingViewChartOptions {
  const raw = isRecord(input) ? input : {};
  return {
    style: TRADING_VIEW_CHART_STYLES.find((entry) => entry.id === raw.style)?.id ?? base.style,
    theme: TRADING_VIEW_THEMES.find((entry) => entry === raw.theme) ?? base.theme,
    timezone: TRADING_VIEW_TIMEZONES.find((entry) => entry.value === raw.timezone)?.value ?? base.timezone,
    volume: flag(raw.volume, base.volume),
    indicators: Array.isArray(raw.indicators) ? sanitizeIndicators(raw.indicators) : [...base.indicators],
    compare: Array.isArray(raw.compare) ? sanitizeCompareSymbols(raw.compare) : [...base.compare],
    compareMode: TRADING_VIEW_COMPARE_MODES.find((entry) => entry.id === raw.compareMode)?.id ?? base.compareMode,
    extendedHours: flag(raw.extendedHours, base.extendedHours),
    drawingToolbar: flag(raw.drawingToolbar, base.drawingToolbar),
    topToolbar: flag(raw.topToolbar, base.topToolbar),
    legend: flag(raw.legend, base.legend),
    dateRanges: flag(raw.dateRanges, base.dateRanges),
    symbolSearch: flag(raw.symbolSearch, base.symbolSearch),
    screenshotButton: flag(raw.screenshotButton, base.screenshotButton),
    popOutButton: flag(raw.popOutButton, base.popOutButton),
    editableWatchlist: flag(raw.editableWatchlist, base.editableWatchlist),
    panelWidth:
      typeof raw.panelWidth === "number" && TRADING_VIEW_PANEL_WIDTHS.includes(raw.panelWidth)
        ? raw.panelWidth
        : base.panelWidth,
  };
}

export function defaultWorkspace(): TerminalWorkspace {
  return {
    version: WORKSPACE_VERSION,
    // a trade section: the chart to analyse on the left, the order panel on the right
    view: "split",
    split: "columns",
    splitWith: "wsatrade",
    tradingview: {
      symbol: DEFAULT_SYMBOL,
      timeframe: DEFAULT_TIMEFRAME,
      watchlist: defaultWatchlist(),
      panels: { watchlist: true, details: false, hotlist: false },
      chart: defaultChartOptions(),
    },
    metatrader: {
      source: "auto",
      customUrl: null,
      brokerTerminals: {},
      selection: null,
      manualAccounts: [],
      autoLogin: false,
    },
    wsatrade: defaultWsaTrade(),
  };
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A distance in whole points (1 ... 1 000 000) or null. */
function sanitizePoints(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_WSA_TRADE_LEVEL_POINTS
    ? value
    : null;
}

/** A lot limit the ticket accepts, or null. */
function sanitizeMaxVolume(value: unknown): number | null {
  return isValidLots(value) ? value : null;
}

/**
 * A setting that can be switched off with `null`: `null` clears it, a valid value sets it, anything
 * else (missing, wrong type, out of range) leaves the current value.
 */
function patchNullable(raw: unknown, current: number | null, parse: (value: unknown) => number | null): number | null {
  if (raw === null) return null;
  return parse(raw) ?? current;
}

function sanitizeManualAccounts(value: unknown): ManualMetaTraderAccount[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ManualMetaTraderAccount[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" && MANUAL_ID.test(entry.id) ? entry.id : null;
    const platform = normalizePlatform(entry.platform);
    const login = sanitizeLogin(entry.login);
    const server = sanitizeServer(entry.server);
    if (!id || !platform || !login || !server || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      platform,
      login,
      server,
      label: sanitizeLabel(entry.label, `${platform} ${maskLogin(login)}`),
    });
    if (result.length >= MAX_MANUAL_ACCOUNTS) break;
  }
  return result;
}

/** `{ "icmarketssc:mt5": "https://webtrader.example.com/" }` - invalid keys and addresses are dropped. */
function sanitizeBrokerTerminals(value: unknown, current: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = { ...current };
  if (!isRecord(value)) return result;
  for (const [key, entry] of Object.entries(value)) {
    if (!isBrokerTerminalKey(key)) continue;
    if (entry === null) {
      delete result[key];
      continue;
    }
    if (typeof entry !== "string") continue;
    const checked = validateCustomTerminalUrl(entry);
    if (checked.ok) {
      // written last = newest, also when the broker already had an address
      delete result[key];
      result[key] = checked.url;
    }
  }
  // keep the newest entries when there are too many (insertion order = age)
  const keys = Object.keys(result);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_BROKER_TERMINALS))) delete result[key];
  return result;
}

/** A platform account id (lower case) or null. */
function sanitizeAccountId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

function sanitizeSelection(
  value: unknown,
  manualAccounts: ManualMetaTraderAccount[],
): MetaTraderSelection | null {
  if (!isRecord(value)) return null;
  if (value.kind === "platform" && typeof value.accountId === "string" && UUID.test(value.accountId)) {
    return { kind: "platform", accountId: value.accountId.toLowerCase() };
  }
  if (
    value.kind === "manual" &&
    typeof value.id === "string" &&
    manualAccounts.some((account) => account.id === value.id)
  ) {
    return { kind: "manual", id: value.id };
  }
  return null;
}

/** Any value in, a valid workspace out. Idempotent: sanitising twice changes nothing. */
export function sanitizeWorkspace(input: unknown): TerminalWorkspace {
  const base = defaultWorkspace();
  if (!isRecord(input)) return base;

  const storedVersion = typeof input.version === "number" ? input.version : 1;
  let view = TERMINAL_VIEWS.find((candidate) => candidate === input.view) ?? base.view;
  const split = SPLIT_DIRECTIONS.find((candidate) => candidate === input.split) ?? base.split;
  let splitWith = SPLIT_PARTNERS.find((candidate) => candidate === input.splitWith) ?? base.splitWith;
  // A document from before version 3 that still holds exactly the old starting layout (the bare chart
  // tab, MetaTrader - or no partner at all, as before the order panel existed - side by side) never
  // chose it: it was the default. It opens as the new trade section. Any other combination was chosen
  // by the person and is kept.
  if (
    storedVersion < 3 &&
    input.view === "tradingview" &&
    (input.splitWith === undefined || input.splitWith === "metatrader") &&
    split === "columns"
  ) {
    view = base.view;
    splitWith = base.splitWith;
  }

  const tv = isRecord(input.tradingview) ? input.tradingview : {};
  const panels = isRecord(tv.panels) ? tv.panels : {};
  const tradingview: TradingViewWorkspace = {
    symbol: normalizeTradingViewSymbol(tv.symbol) ?? base.tradingview.symbol,
    timeframe: isTerminalTimeframe(tv.timeframe) ? tv.timeframe : base.tradingview.timeframe,
    // a missing list starts with the defaults; an emptied list stays empty
    watchlist: Array.isArray(tv.watchlist) ? sanitizeWatchlist(tv.watchlist) : base.tradingview.watchlist,
    panels: {
      watchlist: flag(panels.watchlist, base.tradingview.panels.watchlist),
      details: flag(panels.details, base.tradingview.panels.details),
      hotlist: flag(panels.hotlist, base.tradingview.panels.hotlist),
    },
    chart: sanitizeChartOptions(tv.chart),
  };

  const mt = isRecord(input.metatrader) ? input.metatrader : {};
  const manualAccounts = sanitizeManualAccounts(mt.manualAccounts);
  const customUrl = (() => {
    if (typeof mt.customUrl !== "string") return null;
    const checked = validateCustomTerminalUrl(mt.customUrl);
    return checked.ok ? checked.url : null;
  })();
  // A document from before version 2 that says "classic" never chose it (it was the
  // default, and MetaQuotes' shared MT5 terminal no longer exists): it follows the new default.
  const source = !isMetaTraderSource(mt.source)
    ? base.metatrader.source
    : mt.source === "classic" && storedVersion < 2
      ? base.metatrader.source
      : mt.source;
  const metatrader: MetaTraderWorkspace = {
    source,
    customUrl,
    brokerTerminals: sanitizeBrokerTerminals(mt.brokerTerminals),
    selection: sanitizeSelection(mt.selection, manualAccounts),
    manualAccounts,
    autoLogin: flag(mt.autoLogin, base.metatrader.autoLogin),
  };

  const wt = isRecord(input.wsatrade) ? input.wsatrade : {};
  const wsatrade: WsaTradeWorkspace = {
    accountId: sanitizeAccountId(wt.accountId),
    symbol: normalizeTradeSymbol(wt.symbol) ?? base.wsatrade.symbol,
    volume: isValidLots(wt.volume) ? wt.volume : base.wsatrade.volume,
    orderKind: WEB_TRADE_ORDER_KINDS.find((kind) => kind === wt.orderKind) ?? base.wsatrade.orderKind,
    confirm: flag(wt.confirm, base.wsatrade.confirm),
    levelMode: WSA_TRADE_LEVEL_MODES.find((mode) => mode === wt.levelMode) ?? base.wsatrade.levelMode,
    stopLossPoints: sanitizePoints(wt.stopLossPoints),
    takeProfitPoints: sanitizePoints(wt.takeProfitPoints),
    requireStopLoss: flag(wt.requireStopLoss, base.wsatrade.requireStopLoss),
    maxVolume: sanitizeMaxVolume(wt.maxVolume),
  };

  return { version: WORKSPACE_VERSION, view, split, splitWith, tradingview, metatrader, wsatrade };
}

/**
 * Applies a (possibly partial, possibly hostile) patch on top of a workspace.
 * A value that is missing or not valid is ignored - the previous value stays - so
 * a bad request can never reset a setting it was not meant to touch.
 */
export function mergeWorkspace(current: TerminalWorkspace, patch: unknown): TerminalWorkspace {
  if (!isRecord(patch)) return current;
  const tv = isRecord(patch.tradingview) ? patch.tradingview : {};
  const panelPatch = isRecord(tv.panels) ? tv.panels : {};
  const mt = isRecord(patch.metatrader) ? patch.metatrader : {};
  const wt = isRecord(patch.wsatrade) ? patch.wsatrade : {};

  const manualAccounts = Array.isArray(mt.manualAccounts)
    ? sanitizeManualAccounts(mt.manualAccounts)
    : current.metatrader.manualAccounts;

  // null clears the selection; anything else must be valid or the old one stays
  let selection: MetaTraderSelection | null = current.metatrader.selection;
  if (mt.selection === null) selection = null;
  else if (mt.selection !== undefined) selection = sanitizeSelection(mt.selection, manualAccounts) ?? selection;
  // a selection never outlives the manual account it points to
  selection = sanitizeSelection(selection, manualAccounts);

  let customUrl = current.metatrader.customUrl;
  if (mt.customUrl === null) customUrl = null;
  else if (typeof mt.customUrl === "string") {
    const checked = validateCustomTerminalUrl(mt.customUrl);
    if (checked.ok) customUrl = checked.url;
  }

  const brokerTerminals = sanitizeBrokerTerminals(mt.brokerTerminals, current.metatrader.brokerTerminals);

  const currentTv = current.tradingview;
  return sanitizeWorkspace({
    version: WORKSPACE_VERSION,
    view: TERMINAL_VIEWS.find((candidate) => candidate === patch.view) ?? current.view,
    split: SPLIT_DIRECTIONS.find((candidate) => candidate === patch.split) ?? current.split,
    splitWith: SPLIT_PARTNERS.find((candidate) => candidate === patch.splitWith) ?? current.splitWith,
    tradingview: {
      symbol: normalizeTradingViewSymbol(tv.symbol) ?? currentTv.symbol,
      timeframe: isTerminalTimeframe(tv.timeframe) ? tv.timeframe : currentTv.timeframe,
      watchlist: Array.isArray(tv.watchlist) ? sanitizeWatchlist(tv.watchlist) : currentTv.watchlist,
      panels: {
        watchlist: flag(panelPatch.watchlist, currentTv.panels.watchlist),
        details: flag(panelPatch.details, currentTv.panels.details),
        hotlist: flag(panelPatch.hotlist, currentTv.panels.hotlist),
      },
      chart: sanitizeChartOptions(tv.chart, currentTv.chart),
    },
    metatrader: {
      source: isMetaTraderSource(mt.source) ? mt.source : current.metatrader.source,
      customUrl,
      brokerTerminals,
      selection,
      manualAccounts,
      autoLogin: flag(mt.autoLogin, current.metatrader.autoLogin),
    },
    wsatrade: {
      // null clears the account; anything else must be a valid id or the old one stays
      accountId: wt.accountId === null ? null : (sanitizeAccountId(wt.accountId) ?? current.wsatrade.accountId),
      symbol: normalizeTradeSymbol(wt.symbol) ?? current.wsatrade.symbol,
      volume: isValidLots(wt.volume) ? wt.volume : current.wsatrade.volume,
      orderKind: WEB_TRADE_ORDER_KINDS.find((kind) => kind === wt.orderKind) ?? current.wsatrade.orderKind,
      confirm: flag(wt.confirm, current.wsatrade.confirm),
      levelMode: WSA_TRADE_LEVEL_MODES.find((mode) => mode === wt.levelMode) ?? current.wsatrade.levelMode,
      // null switches the default distance / the limit off; a bad value changes nothing
      stopLossPoints: patchNullable(wt.stopLossPoints, current.wsatrade.stopLossPoints, sanitizePoints),
      takeProfitPoints: patchNullable(wt.takeProfitPoints, current.wsatrade.takeProfitPoints, sanitizePoints),
      requireStopLoss: flag(wt.requireStopLoss, current.wsatrade.requireStopLoss),
      maxVolume: patchNullable(wt.maxVolume, current.wsatrade.maxVolume, sanitizeMaxVolume),
    },
  });
}

/**
 * The JSON column also holds other (older) layout keys; only `workspace` is ours.
 */
export function withWorkspaceInLayout(layout: unknown, workspace: TerminalWorkspace): Record<string, unknown> {
  return { ...(isRecord(layout) ? layout : {}), workspace };
}

export function readWorkspaceFromLayout(layout: unknown): TerminalWorkspace {
  return sanitizeWorkspace(isRecord(layout) ? layout.workspace : undefined);
}

/** Approximate size guard for request bodies (bytes of the JSON text). */
export const MAX_WORKSPACE_BYTES = 32 * 1024;
