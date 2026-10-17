/**
 * Reading a price quote out of whatever the broker bridge answers. Pure.
 *
 * The bridge's documentation (mt4api.dev) could not be read when this was written,
 * so neither the endpoint name nor the field names are known for certain. The panel
 * therefore tries a short list of plausible endpoints, remembers the one that
 * answered, and understands the usual shapes - `{ bid, ask }`, `{ Bid, Ask }`, an
 * array with one entry per symbol. A quote is optional everywhere: when nothing
 * can be read the panel simply shows no price and orders are still sent at market.
 */

export const QUOTE_ENDPOINTS: ReadonlyArray<string> = ["GetQuote", "Quote", "SymbolInfoTick", "GetTick", "Tick"];

export interface ParsedQuote {
  bid: number;
  ask: number;
}

function read(record: Record<string, unknown>, keys: ReadonlyArray<string>): number | null {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function nameOf(record: Record<string, unknown>): string {
  const raw = record.symbol ?? record.Symbol ?? record.name ?? record.Name;
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

/** Bid and ask of `symbol` from a bridge answer, or null when the answer holds no usable price. */
export function parseQuote(answer: unknown, symbol: string): ParsedQuote | null {
  let record: unknown = answer;
  if (Array.isArray(answer)) {
    const wanted = symbol.trim().toUpperCase();
    const entries = answer.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
    record = entries.find((entry) => nameOf(entry) === wanted) ?? (entries.length === 1 ? entries[0] : null);
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;

  const fields = record as Record<string, unknown>;
  const bid = read(fields, ["bid", "Bid", "BID"]);
  const ask = read(fields, ["ask", "Ask", "ASK"]);
  if (bid === null || ask === null) return null;
  // a crossed price (bid above ask) is a broken reading, not a market
  if (bid > ask) return null;
  return { bid, ask };
}
