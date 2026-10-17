/**
 * Symbol names across the places a symbol lives in:
 *
 *  - TradingView:  `OANDA:XAUUSD`, `OANDA:NAS100USD`, `BINANCE:BTCUSDT`, `NASDAQ:AAPL`
 *  - the broker:   `XAUUSD`, `GOLD`, `XAUUSDm`, `EURUSD.pro`, `USTEC`, `US30.cash` - every broker
 *                  spells the same instrument its own way, and the account's symbol list (read from
 *                  API2Trade) is the only truth about what can be traded
 *  - the person:   whatever is typed into a search box ("gold", "nas", "eur usd")
 *
 * The terminal keeps the chart and the order panel on the same instrument with these helpers:
 * a symbol picked in the panel opens the chart on the matching TradingView symbol, and a symbol
 * picked on the chart selects the matching symbol of the account's broker. Nothing here guesses
 * silently: a name that is not recognised maps to `null` and the caller leaves things as they are.
 *
 * Pure - no I/O, no React - so it is shared by the panel, the copy settings and the tests.
 */

import type { WebTradeSymbol } from "@/lib/trade/webTrade";

interface InstrumentGroup {
  /** the name TradingView and most brokers use */
  id: string;
  /** a heading for the picker */
  category: "Metals" | "Energy" | "Indices" | "Crypto";
  /** every spelling brokers use, upper case, letters and digits only; the first is the best known */
  names: ReadonlyArray<string>;
  /** the symbol the chart opens on */
  tradingView: string;
}

const CRYPTO_BASES: ReadonlyArray<string> = [
  "BTC",
  "ETH",
  "LTC",
  "XRP",
  "BCH",
  "ADA",
  "SOL",
  "DOGE",
  "BNB",
  "DOT",
  "LINK",
  "XLM",
  "AVAX",
  "MATIC",
  "TRX",
  "UNI",
  "ATOM",
  "XMR",
  "EOS",
  "DASH",
  "NEO",
  "SHIB",
  "TON",
  "ETC",
  "ZEC",
  "NEAR",
  "AAVE",
  "ALGO",
  "FIL",
  "ICP",
];

const CRYPTO_WORDS: Record<string, ReadonlyArray<string>> = {
  BTC: ["BITCOIN", "XBTUSD"],
  ETH: ["ETHEREUM"],
  LTC: ["LITECOIN"],
  XRP: ["RIPPLE"],
  DOGE: ["DOGECOIN"],
  BCH: ["BITCOINCASH"],
};

const FIXED_GROUPS: ReadonlyArray<InstrumentGroup> = [
  { id: "XAUUSD", category: "Metals", names: ["XAUUSD", "GOLD", "GOLDUSD"], tradingView: "OANDA:XAUUSD" },
  { id: "XAGUSD", category: "Metals", names: ["XAGUSD", "SILVER", "SILVERUSD"], tradingView: "OANDA:XAGUSD" },
  { id: "XPTUSD", category: "Metals", names: ["XPTUSD", "PLATINUM"], tradingView: "OANDA:XPTUSD" },
  { id: "XPDUSD", category: "Metals", names: ["XPDUSD", "PALLADIUM"], tradingView: "OANDA:XPDUSD" },
  {
    id: "USOIL",
    category: "Energy",
    names: ["USOIL", "WTI", "WTIUSD", "XTIUSD", "CRUDEOIL", "OILUSD", "USCRUDE", "WTICOUSD", "OILWTI"],
    tradingView: "OANDA:WTICOUSD",
  },
  {
    id: "UKOIL",
    category: "Energy",
    names: ["UKOIL", "BRENT", "BRENTUSD", "XBRUSD", "BCOUSD", "OILBRENT", "UKBRENT"],
    tradingView: "OANDA:BCOUSD",
  },
  {
    id: "NATGAS",
    category: "Energy",
    names: ["NATGAS", "NGAS", "XNGUSD", "NATURALGAS", "NATGASUSD", "NGCUSD"],
    tradingView: "OANDA:NATGASUSD",
  },
  {
    id: "NAS100",
    category: "Indices",
    names: [
      "NAS100",
      "NAS100USD",
      "USTEC",
      "USTECH",
      "USTECH100",
      "USTEC100",
      "US100",
      "NDX",
      "NDX100",
      "NASDAQ",
      "NASDAQ100",
      "NQ100",
      "TECH100",
      "NSDQ100",
    ],
    tradingView: "OANDA:NAS100USD",
  },
  {
    id: "US30",
    category: "Indices",
    names: ["US30", "US30USD", "DJ30", "DJI", "DJI30", "WS30", "DOW", "DOW30", "DOWJONES", "USWALLST30", "WALLSTREET", "WALLST30"],
    tradingView: "OANDA:US30USD",
  },
  {
    id: "SPX500",
    category: "Indices",
    names: ["SPX500", "SPX500USD", "US500", "SP500", "SPX", "USSPX500", "SPXUSD", "US500USD"],
    tradingView: "OANDA:SPX500USD",
  },
  {
    id: "GER40",
    category: "Indices",
    names: ["GER40", "GER30", "DE40", "DE30", "DE30EUR", "DE40EUR", "DAX", "DAX40", "DAX30", "GERMANY40", "GERMANY30"],
    tradingView: "OANDA:DE30EUR",
  },
  {
    id: "UK100",
    category: "Indices",
    names: ["UK100", "UK100GBP", "FTSE", "FTSE100", "UKX"],
    tradingView: "OANDA:UK100GBP",
  },
  {
    id: "JP225",
    category: "Indices",
    names: ["JP225", "JP225USD", "JPN225", "NIKKEI", "NIKKEI225", "N225", "NI225", "JAPAN225", "NK225"],
    tradingView: "OANDA:JP225USD",
  },
  {
    id: "FRA40",
    category: "Indices",
    names: ["FRA40", "FR40", "FR40EUR", "CAC40", "CAC", "FRANCE40"],
    tradingView: "OANDA:FR40EUR",
  },
  {
    id: "EU50",
    category: "Indices",
    names: ["EU50", "EU50EUR", "STOXX50", "ESTX50", "EUSTX50", "EURO50", "SX5E"],
    tradingView: "OANDA:EU50EUR",
  },
  {
    id: "AUS200",
    category: "Indices",
    names: ["AUS200", "AU200", "AU200AUD", "ASX200", "AUSTRALIA200"],
    tradingView: "OANDA:AU200AUD",
  },
  {
    id: "HK50",
    category: "Indices",
    names: ["HK50", "HK33", "HK33HKD", "HSI", "HSI50", "HKG50", "HONGKONG50"],
    tradingView: "OANDA:HK33HKD",
  },
];

const GROUPS: ReadonlyArray<InstrumentGroup> = [
  ...FIXED_GROUPS,
  ...CRYPTO_BASES.map(
    (base): InstrumentGroup => ({
      id: `${base}USD`,
      category: "Crypto",
      names: [`${base}USD`, `${base}USDT`, `${base}USDC`, ...(CRYPTO_WORDS[base] ?? [])],
      tradingView: `BINANCE:${base}USDT`,
    }),
  ),
];

/** Every spelling -> its group. The first group to claim a spelling keeps it. */
const GROUP_BY_NAME: ReadonlyMap<string, InstrumentGroup> = (() => {
  const index = new Map<string, InstrumentGroup>();
  for (const group of GROUPS) {
    for (const name of group.names) {
      if (!index.has(name)) index.set(name, group);
    }
  }
  return index;
})();

const CURRENCIES: ReadonlySet<string> = new Set([
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "NZD",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "HUF",
  "TRY",
  "ZAR",
  "MXN",
  "SGD",
  "HKD",
  "CNH",
  "CNY",
  "RUB",
  "ILS",
  "THB",
  "RON",
  "BRL",
  "INR",
  "KRW",
  "TWD",
  "AED",
  "SAR",
]);

/** Six letters, both halves a currency: `EURUSD`, `USDZAR`. */
function isForexPair(key: string): boolean {
  return key.length === 6 && CURRENCIES.has(key.slice(0, 3)) && CURRENCIES.has(key.slice(3));
}

function isKnownCore(key: string): boolean {
  return GROUP_BY_NAME.has(key) || isForexPair(key);
}

/** Separators brokers put between the instrument and their own marking: `EURUSD.m`, `XAUUSD#`, `EURUSD_i`. */
const SEPARATOR = /[._#!+@$&-]/;

/** Marks glued onto the name (`XAUUSDm`, `EURUSDpro`, `GER40Cash`), longest first so `PRO` wins over a lone `O`. */
const GLUED_SUFFIXES: ReadonlyArray<string> = [
  "MICRO",
  "CENT",
  "MINI",
  "PLUS",
  "ZERO",
  "CASH",
  "SPOT",
  "PRO",
  "RAW",
  "ECN",
  "STD",
  "STP",
  "SB",
  "M",
  "C",
  "I",
  "Z",
  "X",
  "R",
  "A",
  "B",
  "E",
  "S",
];

export interface ParsedSymbol {
  /** the instrument without the exchange and without the broker's marking: `XAUUSD` */
  core: string;
  /** the marking that was taken off: `M` for `XAUUSDm`, `CASH` for `US30.cash`, "" for none */
  tail: string;
}

/**
 * Splits a symbol of any of the three worlds into the instrument and the marking around it.
 * A name that is not recognised keeps its first part as the core (`AAPL.US` -> `AAPL` + `US`).
 * Never throws; text without a letter or digit gives an empty core.
 */
export function parseSymbolName(value: string): ParsedSymbol {
  if (typeof value !== "string") return { core: "", tail: "" };
  const afterExchange = value.slice(value.lastIndexOf(":") + 1);
  const upper = afterExchange
    .trim()
    .toUpperCase()
    .replace(/[\s/]/g, "")
    .replace(/^[^A-Z0-9]+/, "");
  if (!upper) return { core: "", tail: "" };

  // `EUR/USD`, `BTC-USD`, `XAUUSD#`: the whole name is an instrument once the punctuation is gone
  const whole = upper.replace(/[^A-Z0-9]/g, "");
  if (isKnownCore(whole)) return { core: whole, tail: "" };

  const cut = upper.search(SEPARATOR);
  const head = (cut > 0 ? upper.slice(0, cut) : upper).replace(/[^A-Z0-9]/g, "");
  const tail = cut > 0 ? upper.slice(cut).replace(/[^A-Z0-9]/g, "") : "";
  if (isKnownCore(head)) return { core: head, tail };

  for (const token of GLUED_SUFFIXES) {
    if (head.length > token.length + 2 && head.endsWith(token)) {
      const rest = head.slice(0, head.length - token.length);
      // only strip a mark when what is left IS an instrument (USDZAR must not become USDZA)
      if (isKnownCore(rest)) return { core: rest, tail: `${token}${tail}` };
    }
  }
  return { core: head, tail };
}

/** `OANDA:XAUUSD` -> `XAUUSD`, `GOLD.m` -> `GOLD`: the instrument alone. */
export function coreSymbol(value: string): string {
  return parseSymbolName(value).core;
}

/** Both names are the same instrument: equal after the markings are taken off, or two spellings of one group (`XAUUSD` and `GOLD`). */
export function sameInstrument(a: string, b: string): boolean {
  const first = coreSymbol(a);
  const second = coreSymbol(b);
  if (!first || !second) return false;
  if (first === second) return true;
  const group = GROUP_BY_NAME.get(first);
  return group !== undefined && group === GROUP_BY_NAME.get(second);
}

/**
 * The symbol of this broker that is `wanted` (a TradingView symbol or any other spelling),
 * or null when the broker has nothing like it. The broker's own name is returned untouched
 * (case and marking kept) - it is what the order must carry.
 *
 * Ranking: the wanted instrument's own spelling beats another spelling of its group
 * (`XAUUSD.m` over `GOLD`); within that a bare name beats a marked one (`EURUSD` over
 * `EURUSD.m`) and a shorter name beats a longer one; the broker's order breaks the rest.
 */
export function findBrokerSymbol(wanted: string, available: ReadonlyArray<string>): string | null {
  const core = coreSymbol(wanted);
  if (!core) return null;
  const group = GROUP_BY_NAME.get(core);
  const spellings = group ? [core, ...group.names.filter((name) => name !== core)] : [core];

  let best: { name: string; score: number } | null = null;
  for (const name of available) {
    const parsed = parseSymbolName(name);
    const rank = spellings.indexOf(parsed.core);
    if (rank < 0) continue;
    const base = rank === 0 ? 1000 : 900 - rank;
    const score = base - parsed.tail.length * 3 - name.length * 0.01;
    if (best === null || score > best.score) best = { name, score };
  }
  return best ? best.name : null;
}

/**
 * The TradingView symbol for a broker's symbol, or null when it cannot be told (the chart then
 * stays where it is). Forex pairs, metals, oil, the big indices and crypto are known; a short
 * plain ticker (`AAPL`, `AAPL.US`) is passed on bare because TradingView finds the listing itself.
 */
export function toTradingViewSymbol(brokerSymbol: string): string | null {
  const { core } = parseSymbolName(brokerSymbol);
  if (!core) return null;
  const group = GROUP_BY_NAME.get(core);
  if (group) return group.tradingView;
  if (isForexPair(core)) return `OANDA:${core}`;
  if (/^[A-Z]{1,5}$/.test(core)) return core;
  return null;
}

/** Heading for a symbol in the picker: the first part of the broker's path (`Forex\Majors\EURUSD` -> `Forex`), else a guess from the name. */
export function symbolCategory(symbol: Pick<WebTradeSymbol, "name" | "path">): string {
  const first = (symbol.path ?? "").split(/[\\/]/)[0]?.trim() ?? "";
  if (first) return first.length > 24 ? first.slice(0, 24) : first;
  const { core } = parseSymbolName(symbol.name);
  const group = GROUP_BY_NAME.get(core);
  if (group) return group.category;
  if (isForexPair(core)) return "Forex";
  return "Other";
}

/**
 * The symbols that fit what the person typed, best first. Letters and digits are compared
 * without punctuation (`eur usd` finds `EURUSD.m`), the description is searched too, and a
 * name the broker spells differently still turns up (`gold` finds `XAUUSD`).
 */
export function searchSymbols(
  symbols: ReadonlyArray<WebTradeSymbol>,
  query: string,
  limit = 60,
): WebTradeSymbol[] {
  const needle = query.trim().toUpperCase().replace(/\s+/g, " ");
  if (!needle) return symbols.slice(0, limit);
  const squashed = needle.replace(/[^A-Z0-9]/g, "");
  const needleGroup = GROUP_BY_NAME.get(coreSymbol(needle));

  const scored: Array<{ symbol: WebTradeSymbol; score: number }> = [];
  for (const symbol of symbols) {
    const name = symbol.name.toUpperCase();
    const key = name.replace(/[^A-Z0-9]/g, "");
    let score = 0;
    if (name === needle || (squashed !== "" && key === squashed)) score = 100;
    else if (name.startsWith(needle) || (squashed !== "" && key.startsWith(squashed))) {
      score = 80 - Math.min(20, Math.max(0, key.length - squashed.length));
    } else if (name.includes(needle) || (squashed.length >= 3 && key.includes(squashed))) score = 50;
    else if (needleGroup && GROUP_BY_NAME.get(coreSymbol(symbol.name)) === needleGroup) score = 45;
    else if ((symbol.description ?? "").toUpperCase().includes(needle)) score = 30;
    if (score > 0) scored.push({ symbol, score });
  }
  scored.sort((a, b) => b.score - a.score || a.symbol.name.localeCompare(b.symbol.name));
  return scored.slice(0, limit).map((entry) => entry.symbol);
}
