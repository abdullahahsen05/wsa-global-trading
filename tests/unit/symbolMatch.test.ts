import { describe, expect, test } from "vitest";
import { DEFAULT_TRADING_VIEW_SYMBOLS, normalizeTradingViewSymbol } from "@/lib/terminal/workspace";
import {
  coreSymbol,
  findBrokerSymbol,
  parseSymbolName,
  sameInstrument,
  searchSymbols,
  symbolCategory,
  toTradingViewSymbol,
} from "@/lib/trade/symbolMatch";
import type { WebTradeSymbol } from "@/lib/trade/webTrade";

// The same instruments, spelled the way different brokers spell them.
const PLAIN = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "XAGUSD", "US30", "USTEC", "US500", "DE40", "UK100", "BTCUSD", "ETHUSD", "USOIL"];
const GLUED = ["EURUSDm", "GBPUSDm", "USDJPYm", "XAUUSDm", "XAGUSDm", "US30m", "USTECm", "US500m", "DE30m", "UK100m", "BTCUSDm", "ETHUSDm", "USOILm"];
const DOTTED = ["EURUSD.pro", "GBPUSD.pro", "XAUUSD.pro", "US30.cash", "NAS100.cash", "SPX500.cash", "GER40.cash", "BTCUSD.a", "AAPL.US"];
const NAMED = ["GOLD", "SILVER", "EURUSD", "NAS100", "DJ30", "SP500", "GER30", "FTSE100", "BITCOIN", "WTI"];

const names = (symbols: ReadonlyArray<WebTradeSymbol>) => symbols.map((entry) => entry.name);
const symbolRow = (name: string, description: string | null = null, path: string | null = null): WebTradeSymbol => ({
  name,
  description,
  path,
  digits: null,
});

describe("parseSymbolName", () => {
  test.each([
    ["XAUUSD", "XAUUSD", ""],
    ["xauusd", "XAUUSD", ""],
    ["OANDA:XAUUSD", "XAUUSD", ""],
    ["EURUSD.m", "EURUSD", "M"],
    ["EURUSD_i", "EURUSD", "I"],
    ["XAUUSDm", "XAUUSD", "M"],
    ["EURUSDpro", "EURUSD", "PRO"],
    ["EURUSD.pro", "EURUSD", "PRO"],
    ["XAUUSD#", "XAUUSD", ""],
    ["US30.cash", "US30", "CASH"],
    ["GER40Cash", "GER40", "CASH"],
    ["EUR/USD", "EURUSD", ""],
    ["BTC-USD", "BTCUSD", ""],
    ["#US30", "US30", ""],
    ["AAPL.US", "AAPL", "US"],
    ["BINANCE:BTCUSDT", "BTCUSDT", ""],
  ])("%s -> %s (+%s)", (input, core, tail) => {
    expect(parseSymbolName(input)).toEqual({ core, tail });
  });

  test("a pair that merely ends like a mark is not cut (USDZAR is not USDZA)", () => {
    expect(parseSymbolName("USDZAR")).toEqual({ core: "USDZAR", tail: "" });
    expect(parseSymbolName("EURCZK")).toEqual({ core: "EURCZK", tail: "" });
    expect(parseSymbolName("USDSEKm").core).toBe("USDSEK");
  });

  test("text without a letter or digit has no core, and nothing throws", () => {
    expect(parseSymbolName("")).toEqual({ core: "", tail: "" });
    expect(parseSymbolName("  ")).toEqual({ core: "", tail: "" });
    expect(parseSymbolName("###")).toEqual({ core: "", tail: "" });
    expect(coreSymbol("OANDA:")).toBe("");
  });
});

describe("sameInstrument", () => {
  test("two spellings of one instrument", () => {
    expect(sameInstrument("XAUUSD", "GOLD")).toBe(true);
    expect(sameInstrument("OANDA:XAUUSD", "XAUUSDm")).toBe(true);
    expect(sameInstrument("EURUSD", "EURUSD.pro")).toBe(true);
    expect(sameInstrument("OANDA:NAS100USD", "USTEC")).toBe(true);
    expect(sameInstrument("BINANCE:BTCUSDT", "BTCUSD")).toBe(true);
  });

  test("different instruments and empty names are never the same", () => {
    expect(sameInstrument("EURUSD", "GBPUSD")).toBe(false);
    expect(sameInstrument("XAUUSD", "XAGUSD")).toBe(false);
    expect(sameInstrument("US30", "USTEC")).toBe(false);
    expect(sameInstrument("", "EURUSD")).toBe(false);
    expect(sameInstrument("AAPL", "MSFT")).toBe(false);
  });
});

describe("findBrokerSymbol - the chart picks a symbol, the broker's own name comes back", () => {
  test("a plain broker", () => {
    expect(findBrokerSymbol("OANDA:XAUUSD", PLAIN)).toBe("XAUUSD");
    expect(findBrokerSymbol("OANDA:EURUSD", PLAIN)).toBe("EURUSD");
    expect(findBrokerSymbol("OANDA:NAS100USD", PLAIN)).toBe("USTEC");
    expect(findBrokerSymbol("OANDA:US30USD", PLAIN)).toBe("US30");
    expect(findBrokerSymbol("OANDA:SPX500USD", PLAIN)).toBe("US500");
    expect(findBrokerSymbol("OANDA:DE30EUR", PLAIN)).toBe("DE40");
    expect(findBrokerSymbol("BINANCE:BTCUSDT", PLAIN)).toBe("BTCUSD");
    expect(findBrokerSymbol("BINANCE:ETHUSDT", PLAIN)).toBe("ETHUSD");
  });

  test("a broker that glues a letter on every name keeps its own spelling", () => {
    expect(findBrokerSymbol("OANDA:XAUUSD", GLUED)).toBe("XAUUSDm");
    expect(findBrokerSymbol("OANDA:GBPUSD", GLUED)).toBe("GBPUSDm");
    expect(findBrokerSymbol("OANDA:NAS100USD", GLUED)).toBe("USTECm");
    expect(findBrokerSymbol("OANDA:DE30EUR", GLUED)).toBe("DE30m");
    expect(findBrokerSymbol("BINANCE:BTCUSDT", GLUED)).toBe("BTCUSDm");
  });

  test("a broker with dotted names", () => {
    expect(findBrokerSymbol("OANDA:XAUUSD", DOTTED)).toBe("XAUUSD.pro");
    expect(findBrokerSymbol("OANDA:US30USD", DOTTED)).toBe("US30.cash");
    expect(findBrokerSymbol("OANDA:NAS100USD", DOTTED)).toBe("NAS100.cash");
    expect(findBrokerSymbol("OANDA:DE30EUR", DOTTED)).toBe("GER40.cash");
    expect(findBrokerSymbol("NASDAQ:AAPL", DOTTED)).toBe("AAPL.US");
  });

  test("a broker that uses words", () => {
    expect(findBrokerSymbol("OANDA:XAUUSD", NAMED)).toBe("GOLD");
    expect(findBrokerSymbol("OANDA:XAGUSD", NAMED)).toBe("SILVER");
    expect(findBrokerSymbol("OANDA:US30USD", NAMED)).toBe("DJ30");
    expect(findBrokerSymbol("OANDA:SPX500USD", NAMED)).toBe("SP500");
    expect(findBrokerSymbol("OANDA:DE30EUR", NAMED)).toBe("GER30");
    expect(findBrokerSymbol("OANDA:UK100GBP", NAMED)).toBe("FTSE100");
    expect(findBrokerSymbol("BINANCE:BTCUSDT", NAMED)).toBe("BITCOIN");
    expect(findBrokerSymbol("OANDA:WTICOUSD", NAMED)).toBe("WTI");
  });

  test("the name of the instrument itself beats another spelling of its group", () => {
    expect(findBrokerSymbol("OANDA:XAUUSD", ["GOLD", "XAUUSD.m"])).toBe("XAUUSD.m");
    expect(findBrokerSymbol("GOLD", ["XAUUSD", "GOLD"])).toBe("GOLD");
  });

  test("a bare name beats a marked one, a shorter marking beats a longer one", () => {
    expect(findBrokerSymbol("EURUSD", ["EURUSD.m", "EURUSD", "EURUSD.pro"])).toBe("EURUSD");
    expect(findBrokerSymbol("EURUSD", ["EURUSD.pro", "EURUSD.m"])).toBe("EURUSD.m");
  });

  test("the broker's case is kept exactly", () => {
    expect(findBrokerSymbol("EURUSD", ["eurusdM", "Other"])).toBe("eurusdM");
  });

  test("nothing like it -> null (never a wrong guess)", () => {
    expect(findBrokerSymbol("OANDA:XAUUSD", ["EURUSD", "GBPUSD"])).toBeNull();
    expect(findBrokerSymbol("OANDA:XAUUSD", [])).toBeNull();
    expect(findBrokerSymbol("", PLAIN)).toBeNull();
    expect(findBrokerSymbol("NASDAQ:AAPL", PLAIN)).toBeNull();
  });

  test("every symbol of the default chart watchlist is found at a typical broker", () => {
    for (const chartSymbol of Object.values(DEFAULT_TRADING_VIEW_SYMBOLS)) {
      for (const list of [PLAIN, GLUED, [...DOTTED, "EURUSD.pro", "GBPUSD.pro", "USDJPY.pro", "ETHUSD.a", "NAS100.cash"]]) {
        const wanted = coreSymbol(chartSymbol);
        const covered = list.some((entry) => sameInstrument(entry, wanted));
        if (covered) expect(findBrokerSymbol(chartSymbol, list)).not.toBeNull();
      }
    }
  });
});

describe("toTradingViewSymbol - the panel picks a symbol, the chart follows", () => {
  test.each([
    ["XAUUSD", "OANDA:XAUUSD"],
    ["XAUUSDm", "OANDA:XAUUSD"],
    ["GOLD", "OANDA:XAUUSD"],
    ["GOLD.pro", "OANDA:XAUUSD"],
    ["EURUSD", "OANDA:EURUSD"],
    ["EURUSD.pro", "OANDA:EURUSD"],
    ["GBPJPYm", "OANDA:GBPJPY"],
    ["USTEC", "OANDA:NAS100USD"],
    ["NAS100.cash", "OANDA:NAS100USD"],
    ["US30", "OANDA:US30USD"],
    ["DJ30", "OANDA:US30USD"],
    ["GER40", "OANDA:DE30EUR"],
    ["BTCUSD", "BINANCE:BTCUSDT"],
    ["BTCUSDT", "BINANCE:BTCUSDT"],
    ["ETHUSDm", "BINANCE:ETHUSDT"],
    ["USOIL", "OANDA:WTICOUSD"],
    ["UKOIL", "OANDA:BCOUSD"],
    ["AAPL", "AAPL"],
    ["AAPL.US", "AAPL"],
  ])("%s -> %s", (broker, tradingView) => {
    expect(toTradingViewSymbol(broker)).toBe(tradingView);
  });

  test("a name that cannot be told leaves the chart alone (null)", () => {
    expect(toTradingViewSymbol("")).toBeNull();
    expect(toTradingViewSymbol("###")).toBeNull();
    expect(toTradingViewSymbol("XYZ12345678")).toBeNull();
  });

  test("what comes out is always a symbol the workspace accepts", () => {
    for (const broker of [...PLAIN, ...GLUED, ...DOTTED, ...NAMED]) {
      const tradingView = toTradingViewSymbol(broker);
      if (tradingView !== null) expect(normalizeTradingViewSymbol(tradingView)).toBe(tradingView);
    }
  });

  test("a round trip lands on the same instrument", () => {
    for (const list of [PLAIN, GLUED, DOTTED, NAMED]) {
      for (const broker of list) {
        const tradingView = toTradingViewSymbol(broker);
        if (tradingView === null) continue;
        const back = findBrokerSymbol(tradingView, list);
        expect(back, `${broker} -> ${tradingView}`).not.toBeNull();
        expect(sameInstrument(back as string, broker)).toBe(true);
      }
    }
  });
});

describe("searchSymbols", () => {
  const list: WebTradeSymbol[] = [
    symbolRow("EURUSD.m", "Euro vs US Dollar", "Forex\\Majors\\EURUSD.m"),
    symbolRow("EURGBP.m", "Euro vs Pound", "Forex\\Minors\\EURGBP.m"),
    symbolRow("XAUUSD.m", "Gold vs US Dollar", "Metals\\XAUUSD.m"),
    symbolRow("USTEC.m", "US Tech 100", "Indices\\USTEC.m"),
    symbolRow("BTCUSD.m", "Bitcoin vs US Dollar", "Crypto\\BTCUSD.m"),
    symbolRow("AAPL.m", "Apple Inc", "Stocks\\AAPL.m"),
  ];

  test("punctuation and spaces do not matter", () => {
    expect(names(searchSymbols(list, "eur usd"))).toEqual(["EURUSD.m"]);
    expect(names(searchSymbols(list, "eurusd"))[0]).toBe("EURUSD.m");
    expect(names(searchSymbols(list, "EURUSD.m"))[0]).toBe("EURUSD.m");
  });

  test("a name the broker spells differently still turns up", () => {
    expect(names(searchSymbols(list, "gold"))[0]).toBe("XAUUSD.m");
    expect(names(searchSymbols(list, "nas100"))[0]).toBe("USTEC.m");
    expect(names(searchSymbols(list, "bitcoin"))[0]).toBe("BTCUSD.m");
  });

  test("the description is searched too", () => {
    expect(names(searchSymbols(list, "apple"))).toEqual(["AAPL.m"]);
    expect(names(searchSymbols(list, "pound"))).toEqual(["EURGBP.m"]);
  });

  test("a prefix ranks above a part of a name", () => {
    expect(names(searchSymbols(list, "eur"))).toEqual(["EURGBP.m", "EURUSD.m"]);
  });

  test("an empty query lists the broker's own order, capped", () => {
    expect(names(searchSymbols(list, ""))).toEqual(names(list));
    expect(searchSymbols(list, "", 2)).toHaveLength(2);
    expect(searchSymbols(list, "e", 3).length).toBeLessThanOrEqual(3);
  });

  test("nothing found is an empty list", () => {
    expect(searchSymbols(list, "zzzz")).toEqual([]);
  });
});

describe("symbolCategory", () => {
  test("the first part of the broker's path wins", () => {
    expect(symbolCategory({ name: "EURUSD.m", path: "Forex\\Majors\\EURUSD.m" })).toBe("Forex");
    expect(symbolCategory({ name: "XAUUSD", path: "Metals/Spot/XAUUSD" })).toBe("Metals");
  });

  test("without a path the name decides", () => {
    expect(symbolCategory({ name: "GOLD", path: null })).toBe("Metals");
    expect(symbolCategory({ name: "US30", path: null })).toBe("Indices");
    expect(symbolCategory({ name: "BTCUSD", path: null })).toBe("Crypto");
    expect(symbolCategory({ name: "USOIL", path: null })).toBe("Energy");
    expect(symbolCategory({ name: "EURUSDm", path: null })).toBe("Forex");
    expect(symbolCategory({ name: "AAPL", path: null })).toBe("Other");
  });
});
