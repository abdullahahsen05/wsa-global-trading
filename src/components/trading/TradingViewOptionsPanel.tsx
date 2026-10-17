"use client";

import { useId, useState, type ReactNode } from "react";
import { Plus, RefreshCcw, X } from "lucide-react";
import { POPULAR_TRADING_VIEW_SYMBOLS } from "@/lib/terminal/tradingview";
import {
  MAX_COMPARE_SYMBOLS,
  MAX_TRADING_VIEW_INDICATORS,
  TRADING_VIEW_CHART_STYLES,
  TRADING_VIEW_COMPARE_MODES,
  TRADING_VIEW_INDICATORS,
  TRADING_VIEW_PANEL_WIDTHS,
  TRADING_VIEW_THEMES,
  TRADING_VIEW_TIMEZONES,
  defaultChartOptions,
  normalizeTradingViewSymbol,
  symbolLabel,
  type TradingViewChartOptions,
  type TradingViewCompareMode,
  type TradingViewChartStyle,
  type TradingViewIndicatorId,
  type TradingViewTheme,
} from "@/lib/terminal/workspace";

/**
 * Everything TradingView's free embed widget can be told, in one place: chart
 * type, theme, time zone, indicators (MA 50 + MA 200 by default - no volume),
 * symbols to compare, the toolbars and buttons of the chart and the width of the
 * side panels. The choices are saved in the WSA profile (terminal workspace) and
 * rebuild the chart, because the widget has no way to change a setting while it
 * runs.
 */

const FIELD_CLASS =
  "h-9 w-full rounded-[4px] border border-line bg-background px-3 text-xs font-semibold text-foreground outline-none transition focus:border-accent";

type ToggleKey =
  | "volume"
  | "drawingToolbar"
  | "topToolbar"
  | "legend"
  | "dateRanges"
  | "symbolSearch"
  | "screenshotButton"
  | "popOutButton"
  | "extendedHours"
  | "editableWatchlist";

const TOGGLES: ReadonlyArray<{ key: ToggleKey; label: string; hint: string }> = [
  { key: "volume", label: "Volume", hint: "Volume bars at the bottom of the chart (off by default)" },
  { key: "drawingToolbar", label: "Drawing tools", hint: "Trend lines, Fibonacci, shapes ... on the left" },
  { key: "topToolbar", label: "Top toolbar", hint: "Symbol, interval, chart type and indicator buttons" },
  { key: "legend", label: "Legend", hint: "Symbol name and OHLC values inside the chart" },
  { key: "dateRanges", label: "Date ranges", hint: "The 1D, 5D, 1M ... buttons below the chart" },
  { key: "symbolSearch", label: "Symbol search", hint: "TradingView's own symbol search in the chart" },
  { key: "screenshotButton", label: "Screenshot button", hint: "Camera button that saves a picture of the chart" },
  { key: "popOutButton", label: "Pop-out button", hint: "Opens the chart in a window of its own" },
  { key: "extendedHours", label: "Extended hours", hint: "Pre-market and after-hours sessions (stocks)" },
  { key: "editableWatchlist", label: "Edit list in chart", hint: "Lets you edit the watchlist panel inside the chart; those edits are not saved in WSA" },
];

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-semibold text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

export interface TradingViewOptionsPanelProps {
  chart: TradingViewChartOptions;
  onChange: (patch: Partial<TradingViewChartOptions>) => void;
}

export function TradingViewOptionsPanel({ chart, onChange }: TradingViewOptionsPanelProps) {
  const baseId = useId();
  const suggestionsId = `${baseId}-compare-suggestions`;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const chosen = new Set<TradingViewIndicatorId>(chart.indicators);
  const indicatorsFull = chosen.size >= MAX_TRADING_VIEW_INDICATORS;

  function setToggle(key: ToggleKey, value: boolean) {
    const patch: Partial<TradingViewChartOptions> = {};
    patch[key] = value;
    onChange(patch);
  }

  function toggleIndicator(id: TradingViewIndicatorId) {
    const next = chosen.has(id)
      ? chart.indicators.filter((entry) => entry !== id)
      : [...chart.indicators, id];
    onChange({ indicators: next });
  }

  function addCompare() {
    const symbol = normalizeTradingViewSymbol(draft);
    if (!symbol) {
      setError("Use the TradingView symbol, for example OANDA:EURUSD or NASDAQ:AAPL.");
      return;
    }
    if (chart.compare.includes(symbol)) {
      setError(`${symbol} is already compared.`);
      return;
    }
    if (chart.compare.length >= MAX_COMPARE_SYMBOLS) {
      setError(`You can compare up to ${MAX_COMPARE_SYMBOLS} symbols. Remove one first.`);
      return;
    }
    onChange({ compare: [...chart.compare, symbol] });
    setDraft("");
    setError(null);
  }

  const suggestions = POPULAR_TRADING_VIEW_SYMBOLS.filter((symbol) => !chart.compare.includes(symbol));

  return (
    <div className="border-b border-line px-4 py-4 sm:px-5" role="group" aria-label="Chart options">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Chart options</h4>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
            Saved in your WSA profile. TradingView&apos;s embedded chart cannot change a setting while it runs, so every
            change reloads the chart.
          </p>
        </div>
        <button type="button" className="btn-dark text-xs" onClick={() => onChange(defaultChartOptions())}>
          <RefreshCcw className="h-4 w-4" aria-hidden="true" />
          Reset options
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Chart type" htmlFor={`${baseId}-style`}>
          <select
            id={`${baseId}-style`}
            value={chart.style}
            onChange={(event) => onChange({ style: event.target.value as TradingViewChartStyle })}
            className={FIELD_CLASS}
          >
            {TRADING_VIEW_CHART_STYLES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Theme" htmlFor={`${baseId}-theme`}>
          <select
            id={`${baseId}-theme`}
            value={chart.theme}
            onChange={(event) => onChange({ theme: event.target.value as TradingViewTheme })}
            className={FIELD_CLASS}
          >
            {TRADING_VIEW_THEMES.map((theme) => (
              <option key={theme} value={theme}>
                {theme === "dark" ? "Dark" : "Light"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Time zone" htmlFor={`${baseId}-timezone`}>
          <select
            id={`${baseId}-timezone`}
            value={chart.timezone}
            onChange={(event) => onChange({ timezone: event.target.value })}
            className={FIELD_CLASS}
          >
            {TRADING_VIEW_TIMEZONES.map((zone) => (
              <option key={zone.value} value={zone.value}>
                {zone.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Side panel width" htmlFor={`${baseId}-width`}>
          <select
            id={`${baseId}-width`}
            value={chart.panelWidth}
            onChange={(event) => onChange({ panelWidth: Number(event.target.value) })}
            className={FIELD_CLASS}
          >
            {TRADING_VIEW_PANEL_WIDTHS.map((width, index) => (
              <option key={width} value={width}>
                {["Narrow", "Medium", "Wide"][index] ?? `${width}px`} ({width}px)
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="mt-4">
        <legend className="text-xs font-semibold text-muted">
          Indicators ({chosen.size} / {MAX_TRADING_VIEW_INDICATORS})
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {TRADING_VIEW_INDICATORS.map((indicator) => {
            const on = chosen.has(indicator.id);
            return (
              <button
                key={indicator.id}
                type="button"
                title={indicator.hint}
                aria-pressed={on}
                disabled={!on && indicatorsFull}
                onClick={() => toggleIndicator(indicator.id)}
                className={`btn-dark text-xs disabled:cursor-not-allowed disabled:opacity-50 ${on ? "btn-active" : ""}`}
              >
                {indicator.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 max-w-3xl text-xs leading-5 text-muted">
          The chart opens with the indicators chosen here (MA 50 and MA 200 by default - no volume bars). Colours or
          lengths changed inside the chart are not saved and are lost when it reloads. Your own Pine scripts cannot
          run in an embedded chart (TradingView allows that on tradingview.com only) - use{" "}
          <strong>Open on TradingView</strong> for them.
        </p>
      </fieldset>

      <div className="mt-4">
        <p className="text-xs font-semibold text-muted">
          Compare with ({chart.compare.length} / {MAX_COMPARE_SYMBOLS})
        </p>
        {chart.compare.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="Compared symbols">
            {chart.compare.map((symbol) => (
              <li
                key={symbol}
                className="inline-flex items-stretch overflow-hidden rounded-[4px] border border-line bg-background text-xs font-semibold text-foreground"
              >
                <span className="px-3 py-1.5" title={symbol}>
                  {symbolLabel(symbol)}
                </span>
                <button
                  type="button"
                  onClick={() => onChange({ compare: chart.compare.filter((entry) => entry !== symbol) })}
                  aria-label={`Stop comparing ${symbolLabel(symbol)}`}
                  className="border-l border-line px-2 text-muted transition hover:text-danger"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <form
          className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            addCompare();
          }}
        >
          <div className="min-w-0 flex-1">
            <label htmlFor={`${baseId}-compare`} className="sr-only">
              Add a symbol to compare
            </label>
            <input
              id={`${baseId}-compare`}
              list={suggestionsId}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) setError(null);
              }}
              maxLength={70}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="Symbol to plot over the chart, e.g. OANDA:EURUSD"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${baseId}-compare-error` : undefined}
              className={FIELD_CLASS}
            />
            <datalist id={suggestionsId}>
              {suggestions.map((symbol) => (
                <option key={symbol} value={symbol} />
              ))}
            </datalist>
          </div>
          <button type="submit" className="btn-dark text-xs">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add
          </button>
          <div className="sm:w-44">
            <label htmlFor={`${baseId}-compare-mode`} className="sr-only">
              Scale of the compared symbols
            </label>
            <select
              id={`${baseId}-compare-mode`}
              value={chart.compareMode}
              onChange={(event) => onChange({ compareMode: event.target.value as TradingViewCompareMode })}
              className={FIELD_CLASS}
            >
              {TRADING_VIEW_COMPARE_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </div>
        </form>
        {error ? (
          <p id={`${baseId}-compare-error`} role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>

      <fieldset className="mt-4">
        <legend className="text-xs font-semibold text-muted">Chart tools</legend>
        <div className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-5">
          {TOGGLES.map((toggle) => (
            <label key={toggle.key} title={toggle.hint} className="flex items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                checked={chart[toggle.key]}
                onChange={(event) => setToggle(toggle.key, event.target.checked)}
              />
              {toggle.label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
