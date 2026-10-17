"use client";

import { useId, useState } from "react";
import { Plus, RefreshCcw, X } from "lucide-react";
import { POPULAR_TRADING_VIEW_SYMBOLS } from "@/lib/terminal/tradingview";
import {
  MAX_WATCHLIST_SYMBOLS,
  defaultWatchlist,
  normalizeTradingViewSymbol,
  symbolLabel,
} from "@/lib/terminal/workspace";

/**
 * The trader's own watchlist for the embedded TradingView chart. It lives in the
 * WSA profile (terminal workspace) - TradingView's free widget can not read the
 * lists of a TradingView account.
 */
export function TradingViewWatchlistEditor({
  watchlist,
  activeSymbol,
  onChange,
  onSelect,
}: {
  watchlist: ReadonlyArray<string>;
  activeSymbol: string;
  onChange: (next: string[]) => void;
  onSelect: (symbol: string) => void;
}) {
  const inputId = useId();
  const suggestionsId = useId();
  const errorId = `${inputId}-error`;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  function addSymbol() {
    const symbol = normalizeTradingViewSymbol(draft);
    if (!symbol) {
      setError("Use the TradingView symbol, for example OANDA:EURUSD or NASDAQ:AAPL.");
      return;
    }
    if (watchlist.includes(symbol)) {
      setError(`${symbol} is already in your watchlist.`);
      return;
    }
    if (watchlist.length >= MAX_WATCHLIST_SYMBOLS) {
      setError(`The watchlist holds up to ${MAX_WATCHLIST_SYMBOLS} symbols. Remove one first.`);
      return;
    }
    onChange([...watchlist, symbol]);
    setDraft("");
    setError(null);
  }

  const suggestions = POPULAR_TRADING_VIEW_SYMBOLS.filter((symbol) => !watchlist.includes(symbol));

  return (
    <div className="border-b border-line px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Your watchlist</h4>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
            These symbols fill the chart&apos;s watchlist panel and the symbol picker. The list is saved in your WSA
            profile; it is not connected to a TradingView account.
          </p>
        </div>
        <span className="text-xs font-semibold text-muted">
          {watchlist.length} / {MAX_WATCHLIST_SYMBOLS}
        </span>
      </div>

      {watchlist.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Watchlist symbols">
          {watchlist.map((symbol) => {
            const active = symbol === activeSymbol;
            return (
              <li
                key={symbol}
                className={`inline-flex items-stretch overflow-hidden rounded-[4px] border text-xs font-semibold ${
                  active ? "border-accent/60 bg-accent/10 text-accent" : "border-line bg-background text-foreground"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(symbol)}
                  aria-pressed={active}
                  title={symbol}
                  className="px-3 py-1.5 transition hover:text-accent"
                >
                  {symbolLabel(symbol)}
                </button>
                <button
                  type="button"
                  onClick={() => onChange(watchlist.filter((entry) => entry !== symbol))}
                  aria-label={`Remove ${symbolLabel(symbol)} from the watchlist`}
                  className="border-l border-line px-2 text-muted transition hover:text-danger"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted">
          Your watchlist is empty. Add a symbol below or restore the default list.
        </p>
      )}

      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start"
        onSubmit={(event) => {
          event.preventDefault();
          addSymbol();
        }}
      >
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="sr-only">
            Add a symbol to the watchlist
          </label>
          <input
            id={inputId}
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
            placeholder="Add a symbol, e.g. OANDA:EURUSD or NASDAQ:AAPL"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="h-9 w-full rounded-[4px] border border-line bg-background px-3 text-xs font-semibold text-foreground outline-none transition focus:border-accent"
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
        {confirmReset ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>Replace your list with the defaults?</span>
            <button
              type="button"
              className="btn-dark text-xs"
              onClick={() => {
                onChange(defaultWatchlist());
                setConfirmReset(false);
                setError(null);
              }}
            >
              Yes
            </button>
            <button type="button" className="btn-dark text-xs" onClick={() => setConfirmReset(false)}>
              No
            </button>
          </div>
        ) : (
          <button type="button" className="btn-dark text-xs" onClick={() => setConfirmReset(true)}>
            <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            Defaults
          </button>
        )}
      </form>
      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
