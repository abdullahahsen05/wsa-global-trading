"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Loader2, Search } from "lucide-react";
import { searchSymbols, symbolCategory } from "@/lib/trade/symbolMatch";
import { normalizeTradeSymbol, type WebTradeSymbol } from "@/lib/trade/webTrade";
import { FIELD_CLASS, LABEL_CLASS } from "./ui";

/**
 * The symbol box of the order ticket. It lists the symbols of the account's broker - spelled the
 * way that broker spells them (`XAUUSD`, `GOLD`, `EURUSD.m`) - and finds them as the person types
 * ("gold" finds `XAUUSD`, "eur usd" finds `EURUSD.m`). While the list is not there (still loading,
 * or the broker did not give one) it is a plain text box for the broker's own spelling.
 */

const RESULT_LIMIT = 60;

export interface SymbolPickerProps {
  /** id of the text box (the label points at it) */
  id: string;
  /** the symbol the ticket trades now */
  value: string;
  symbols: ReadonlyArray<WebTradeSymbol>;
  loading: boolean;
  disabled?: boolean;
  /** a symbol was chosen (always a name from the list, or - without a list - a valid typed name) */
  onSelect: (symbol: string) => void;
}

export function SymbolPicker({ id, value, symbols, loading, disabled, onSelect }: SymbolPickerProps) {
  const listId = useId();
  const [syncedValue, setSyncedValue] = useState(value);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value);
  }

  const hasList = symbols.length > 0;
  // an untouched box (the draft is the chosen symbol) lists everything; typing narrows it down
  const query = draft === value ? "" : draft;
  const results = useMemo(() => (hasList ? searchSymbols(symbols, query, RESULT_LIMIT) : []), [hasList, symbols, query]);
  const highlighted = Math.min(active, Math.max(0, results.length - 1));

  function choose(name: string) {
    setOpen(false);
    setDraft(name);
    if (name !== value) onSelect(name);
  }

  function revert() {
    setOpen(false);
    setDraft(value);
  }

  /**
   * Enter takes the highlighted symbol of the list (or - without a list - the typed name). Leaving
   * the box only keeps a name that is exactly a symbol of the broker: half-typed text must never
   * change the symbol (and the chart with it) just because the person clicked somewhere else.
   */
  function commit(fromEnter: boolean) {
    if (hasList) {
      const exact = symbols.find((entry) => entry.name.toLowerCase() === draft.trim().toLowerCase());
      if (exact) return choose(exact.name);
      if (fromEnter && open && results.length > 0 && draft !== value) return choose(results[highlighted].name);
      return revert();
    }
    const typed = normalizeTradeSymbol(draft);
    if (typed) return choose(typed);
    revert();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!hasList) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.max(0, Math.min(results.length - 1, highlighted + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      revert();
    }
  }

  const showList = open && hasList;
  return (
    <div className="relative">
      <label className={LABEL_CLASS} htmlFor={id}>
        Symbol
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input
          id={id}
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList && results.length > 0 ? `${listId}-${highlighted}` : undefined}
          aria-autocomplete="list"
          value={draft}
          maxLength={32}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder={loading ? "Loading the broker's symbols…" : "Search the broker's symbols"}
          onFocus={(event) => {
            setOpen(true);
            event.currentTarget.select();
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onBlur={() => commit(false)}
          onKeyDown={onKeyDown}
          className={`${FIELD_CLASS} pl-8 pr-8`}
        />
        {loading ? (
          <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted" aria-hidden="true" />
        ) : null}
      </div>
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Symbols of this broker"
          className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-[4px] border border-line-strong bg-panel-strong py-1 shadow-lg"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted" role="presentation">
              No symbol of this broker looks like “{draft.trim()}”.
            </li>
          ) : (
            results.map((entry, index) => (
              <li
                key={entry.name}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlighted}
                // pressing an option must not blur the box first - that would commit before the click
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(entry.name)}
                className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-xs ${
                  index === highlighted ? "bg-accent/15 text-foreground" : "text-foreground"
                }`}
              >
                <span className="min-w-0">
                  <span className="font-semibold">{entry.name}</span>
                  {entry.description ? <span className="ml-2 truncate text-muted">{entry.description}</span> : null}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">{symbolCategory(entry)}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
