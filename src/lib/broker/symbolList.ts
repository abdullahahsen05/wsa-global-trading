/**
 * The list of symbols a broker account can trade, out of whatever shape the bridge
 * answers in. Pure - no I/O. The bridge's `SymbolList` answer is not documented where
 * we could read it, so it can be a plain array of names, an array of objects, an object
 * that wraps such an array, a map name -> details, or a comma / line separated text.
 * Names keep the broker's own spelling ("EURUSD.r", "XAUUSDm", "GOLD", "US30.cash").
 */

import { TRADE_SYMBOL_PATTERN } from "@/lib/trade/webTrade";

export interface ParsedSymbol {
  name: string;
  description: string | null;
  /** the broker's folder, e.g. "Forex\\Majors" */
  path: string | null;
  digits: number | null;
}

const WRAPPER_KEYS = ["symbols", "Symbols", "symbolList", "SymbolList", "result", "Result", "data", "Data", "items", "list"];
const NAME_KEYS = ["symbol", "Symbol", "name", "Name", "symbolName", "SymbolName", "instrument"];
const DESCRIPTION_KEYS = ["description", "Description", "desc", "fullName"];
const PATH_KEYS = ["path", "Path", "group", "Group", "groupName", "category"];
const DIGITS_KEYS = ["digits", "Digits"];

/** More than any broker offers; a runaway answer must not become a runaway page. */
export const MAX_SYMBOLS = 20_000;

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstDigits(record: Record<string, unknown>): number | null {
  for (const key of DIGITS_KEYS) {
    const value = Number(record[key]);
    if (Number.isInteger(value) && value >= 0 && value <= 10) return value;
  }
  return null;
}

function fromEntry(entry: unknown, nameFromKey?: string): ParsedSymbol | null {
  if (typeof entry === "string") {
    const name = entry.trim();
    return TRADE_SYMBOL_PATTERN.test(name) ? { name, description: null, path: null, digits: null } : null;
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return nameFromKey && TRADE_SYMBOL_PATTERN.test(nameFromKey)
      ? { name: nameFromKey, description: null, path: null, digits: null }
      : null;
  }
  const record = entry as Record<string, unknown>;
  const name = firstText(record, NAME_KEYS) ?? nameFromKey ?? null;
  if (!name || !TRADE_SYMBOL_PATTERN.test(name)) return null;
  const description = firstText(record, DESCRIPTION_KEYS);
  return {
    name,
    description: description && description !== name ? description.slice(0, 120) : null,
    path: firstText(record, PATH_KEYS)?.slice(0, 120) ?? null,
    digits: firstDigits(record),
  };
}

function collect(source: unknown[]): ParsedSymbol[] {
  const seen = new Set<string>();
  const symbols: ParsedSymbol[] = [];
  for (const entry of source) {
    const parsed = fromEntry(entry);
    if (!parsed || seen.has(parsed.name)) continue;
    seen.add(parsed.name);
    symbols.push(parsed);
    if (symbols.length >= MAX_SYMBOLS) break;
  }
  return symbols;
}

export function parseSymbolList(raw: unknown): ParsedSymbol[] {
  if (Array.isArray(raw)) return collect(raw);

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return parseSymbolList(JSON.parse(trimmed) as unknown);
      } catch {
        return [];
      }
    }
    return collect(trimmed.split(/[\s,;]+/));
  }

  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    for (const key of WRAPPER_KEYS) {
      const wrapped = record[key];
      if (Array.isArray(wrapped) || typeof wrapped === "string" || (typeof wrapped === "object" && wrapped !== null)) {
        const parsed = parseSymbolList(wrapped);
        if (parsed.length > 0) return parsed;
      }
    }
    // a map: name -> details
    const keys = Object.keys(record);
    if (keys.length >= 3 && keys.every((key) => TRADE_SYMBOL_PATTERN.test(key))) {
      const seen = new Set<string>();
      const symbols: ParsedSymbol[] = [];
      for (const key of keys) {
        const value = record[key];
        // in a map a text is the description of the symbol the key names
        const parsed: ParsedSymbol | null =
          typeof value === "string"
            ? {
                name: key,
                description: value.trim() && value.trim() !== key ? value.trim().slice(0, 120) : null,
                path: null,
                digits: null,
              }
            : fromEntry(value, key);
        if (!parsed || seen.has(parsed.name)) continue;
        seen.add(parsed.name);
        symbols.push(parsed);
        if (symbols.length >= MAX_SYMBOLS) break;
      }
      return symbols;
    }
  }
  return [];
}
