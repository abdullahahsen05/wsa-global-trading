import { describe, expect, test } from "vitest";
import { MAX_SYMBOLS, parseSymbolList } from "@/lib/broker/symbolList";

const bare = (name: string) => ({ name, description: null, path: null, digits: null });

describe("parseSymbolList", () => {
  test("a plain list of names keeps each broker's own spelling", () => {
    expect(parseSymbolList(["EURUSD.r", "XAUUSDm", "GOLD", "US30.cash", "BTCUSD#"])).toEqual([
      bare("EURUSD.r"),
      bare("XAUUSDm"),
      bare("GOLD"),
      bare("US30.cash"),
      bare("BTCUSD#"),
    ]);
  });

  test("objects: the symbol, its description, folder and digits", () => {
    expect(
      parseSymbolList([
        { symbol: "EURUSD", description: "Euro vs US Dollar", path: "Forex\\Majors", digits: 5 },
        { Name: "XAUUSD", Description: "Gold", Digits: 2 },
        { name: "Euro vs US Dollar" }, // not a symbol name
      ]),
    ).toEqual([
      { name: "EURUSD", description: "Euro vs US Dollar", path: "Forex\\Majors", digits: 5 },
      { name: "XAUUSD", description: "Gold", path: null, digits: 2 },
    ]);
  });

  test("an object that wraps the list, or a JSON text of it", () => {
    expect(parseSymbolList({ symbols: ["A1", "B2"] })).toEqual([bare("A1"), bare("B2")]);
    expect(parseSymbolList({ result: [{ symbol: "EURUSD" }] })).toEqual([bare("EURUSD")]);
    expect(parseSymbolList('["EURUSD","GBPUSD"]')).toEqual([bare("EURUSD"), bare("GBPUSD")]);
    expect(parseSymbolList('{"data":["EURUSD"]}')).toEqual([bare("EURUSD")]);
  });

  test("a map of name -> details", () => {
    expect(parseSymbolList({ EURUSD: { digits: 5 }, GBPUSD: { digits: 5 }, "XAUUSD.r": "Gold" })).toEqual([
      { name: "EURUSD", description: null, path: null, digits: 5 },
      { name: "GBPUSD", description: null, path: null, digits: 5 },
      { name: "XAUUSD.r", description: "Gold", path: null, digits: null },
    ]);
  });

  test("a text separated by commas, spaces or lines", () => {
    expect(parseSymbolList("EURUSD,GBPUSD;USDJPY\nXAUUSD")).toEqual([
      bare("EURUSD"),
      bare("GBPUSD"),
      bare("USDJPY"),
      bare("XAUUSD"),
    ]);
  });

  test("duplicates and things that are not symbols are dropped", () => {
    expect(parseSymbolList(["EURUSD", "EURUSD", "<script>", "", "A B", 5, null, ".bad"])).toEqual([bare("EURUSD")]);
  });

  test("an error record, an empty answer or garbage is an empty list", () => {
    expect(parseSymbolList({ message: "boom" })).toEqual([]);
    expect(parseSymbolList(null)).toEqual([]);
    expect(parseSymbolList(undefined)).toEqual([]);
    expect(parseSymbolList("")).toEqual([]);
    expect(parseSymbolList("{not json")).toEqual([]);
    expect(parseSymbolList(42)).toEqual([]);
  });

  test("a runaway answer is cut", () => {
    const huge = Array.from({ length: MAX_SYMBOLS + 50 }, (_, index) => `S${index}`);
    expect(parseSymbolList(huge)).toHaveLength(MAX_SYMBOLS);
  });
});
