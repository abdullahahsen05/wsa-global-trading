import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockMarketDataProvider } from "@/lib/terminal/providers/mockMarketDataProvider";
import { DxfeedMarketDataProvider } from "@/lib/terminal/providers/dxfeedMarketDataProvider";
import { resetMarketDataProvider, getMarketDataProvider } from "@/lib/terminal/marketDataService";

// ─── Mock provider ──────────────────────────────────────────────────────────

describe("MockMarketDataProvider", () => {
  let provider: MockMarketDataProvider;

  beforeEach(() => {
    provider = new MockMarketDataProvider();
  });

  describe("getStatus", () => {
    it("returns demo mode by default", async () => {
      const status = await provider.getStatus();
      expect(status.provider).toBe("mock");
      expect(status.mode).toBe("demo");
      expect(status.connected).toBe(true);
      expect(status.label).toBe("Demo Market Data");
    });
  });

  describe("getSymbols", () => {
    it("returns at least 8 symbols", async () => {
      const symbols = await provider.getSymbols();
      expect(symbols.length).toBeGreaterThanOrEqual(8);
    });

    it("includes EURUSD, XAUUSD, BTCUSD", async () => {
      const symbols = await provider.getSymbols();
      const names = symbols.map((s) => s.symbol);
      expect(names).toContain("EURUSD");
      expect(names).toContain("XAUUSD");
      expect(names).toContain("BTCUSD");
    });

    it("each symbol has required fields", async () => {
      const symbols = await provider.getSymbols();
      for (const s of symbols) {
        expect(s.symbol).toBeTruthy();
        expect(s.description).toBeTruthy();
        expect(["forex", "commodities", "indices", "crypto"]).toContain(s.category);
        expect(s.pipSize).toBeGreaterThan(0);
        expect(s.displayDecimals).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("getQuote", () => {
    it("returns a valid EURUSD quote", async () => {
      const q = await provider.getQuote("EURUSD");
      expect(q.symbol).toBe("EURUSD");
      expect(q.bid).toBeGreaterThan(1.0);
      expect(q.ask).toBeGreaterThan(q.bid);
      expect(typeof q.changePct).toBe("number");
      expect(q.high24h).toBeGreaterThan(q.low24h);
      expect(q.timestamp).toBeTruthy();
    });

    it("returns a valid XAUUSD quote (commodity)", async () => {
      const q = await provider.getQuote("XAUUSD");
      expect(q.symbol).toBe("XAUUSD");
      expect(q.mid).toBeGreaterThan(2000);
    });

    it("throws for unknown symbol", async () => {
      await expect(provider.getQuote("FAKESYMBOL")).rejects.toThrow("Unknown symbol");
    });
  });

  describe("getCandles", () => {
    it("returns the requested number of bars for 1h timeframe", async () => {
      const candles = await provider.getCandles("EURUSD", "1h", 50);
      expect(candles.symbol).toBe("EURUSD");
      expect(candles.timeframe).toBe("1h");
      // +1 because we generate limit+1 bars (includes partial current bar)
      expect(candles.bars.length).toBe(51);
    });

    it("bars are in ascending time order", async () => {
      const candles = await provider.getCandles("EURUSD", "1h");
      for (let i = 1; i < candles.bars.length; i++) {
        expect(candles.bars[i].time).toBeGreaterThan(candles.bars[i - 1].time);
      }
    });

    it("OHLC relationships are valid (high >= open/close, low <= open/close)", async () => {
      const candles = await provider.getCandles("BTCUSD", "4h");
      for (const bar of candles.bars) {
        expect(bar.high).toBeGreaterThanOrEqual(bar.open);
        expect(bar.high).toBeGreaterThanOrEqual(bar.close);
        expect(bar.low).toBeLessThanOrEqual(bar.open);
        expect(bar.low).toBeLessThanOrEqual(bar.close);
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
        expect(bar.volume).toBeGreaterThan(0);
      }
    });

    it("all timeframes produce bars", async () => {
      const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
      for (const tf of timeframes) {
        const data = await provider.getCandles("EURUSD", tf, 10);
        expect(data.bars.length).toBeGreaterThan(0);
      }
    });

    it("throws for unknown symbol", async () => {
      await expect(provider.getCandles("FAKE", "1h")).rejects.toThrow("Unknown symbol");
    });
  });

  describe("getDom", () => {
    it("returns bids and asks for EURUSD", async () => {
      const dom = await provider.getDom("EURUSD");
      expect(dom.symbol).toBe("EURUSD");
      expect(dom.bids.length).toBeGreaterThan(0);
      expect(dom.asks.length).toBeGreaterThan(0);
      expect(dom.spread).toBeGreaterThan(0);
    });

    it("bids are below asks", async () => {
      const dom = await provider.getDom("EURUSD");
      const topBid = dom.bids[0].price;
      const bottomAsk = dom.asks[0].price;
      expect(topBid).toBeLessThan(bottomAsk);
    });

    it("all DOM levels have positive size", async () => {
      const dom = await provider.getDom("EURUSD");
      for (const level of [...dom.bids, ...dom.asks]) {
        expect(level.size).toBeGreaterThan(0);
        expect(level.price).toBeGreaterThan(0);
      }
    });

    it("throws for unknown symbol", async () => {
      await expect(provider.getDom("FAKE")).rejects.toThrow("Unknown symbol");
    });
  });

  describe("getHeatmap", () => {
    it("returns cells with normalised volume 0-1", async () => {
      const hm = await provider.getHeatmap("EURUSD");
      expect(hm.cells.length).toBeGreaterThan(0);
      expect(hm.priceMax).toBeGreaterThan(hm.priceMin);
      for (const cell of hm.cells) {
        expect(cell.volume).toBeGreaterThanOrEqual(0);
        expect(cell.volume).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("getVolumeProfile", () => {
    it("returns bars with a valid POC", async () => {
      const vp = await provider.getVolumeProfile("EURUSD");
      expect(vp.bars.length).toBeGreaterThan(0);
      expect(vp.pocPrice).toBeGreaterThan(0);

      // POC should be one of the bar prices
      const barPrices = vp.bars.map((b) => b.price);
      expect(barPrices).toContain(vp.pocPrice);
    });

    it("high-volume bars are flagged", async () => {
      const vp = await provider.getVolumeProfile("XAUUSD");
      const highVolBars = vp.bars.filter((b) => b.isHighVolume);
      expect(highVolBars.length).toBeGreaterThan(0);
    });
  });

  describe("getNews", () => {
    it("returns news items", async () => {
      const news = await provider.getNews();
      expect(news.length).toBeGreaterThan(0);
    });

    it("filters news by symbol", async () => {
      const news = await provider.getNews("EURUSD");
      expect(news.length).toBeGreaterThan(0);
      // All results must reference EURUSD or be fallback items
    });

    it("each item has required fields", async () => {
      const news = await provider.getNews();
      for (const item of news) {
        expect(item.id).toBeTruthy();
        expect(item.headline).toBeTruthy();
        expect(item.source).toBeTruthy();
        expect(item.publishedAt).toBeTruthy();
        expect(["bullish", "bearish", "neutral"]).toContain(item.sentiment);
      }
    });
  });
});

// ─── dxFeed provider (skeleton / unconfigured) ──────────────────────────────

describe("DxfeedMarketDataProvider (unconfigured)", () => {
  let provider: DxfeedMarketDataProvider;

  beforeEach(() => {
    provider = new DxfeedMarketDataProvider();
  });

  it("getStatus returns not-connected when env vars are missing", async () => {
    const status = await provider.getStatus();
    expect(status.connected).toBe(false);
    expect(status.label).toBe("Demo Market Data");
    expect(status.error).toBeTruthy();
  });

  it("getSymbols returns empty array when unconfigured", async () => {
    const symbols = await provider.getSymbols();
    expect(symbols).toEqual([]);
  });

  it("getNews returns empty array when unconfigured", async () => {
    const news = await provider.getNews();
    expect(news).toEqual([]);
  });

  it("getQuote throws when unconfigured", async () => {
    await expect(provider.getQuote("EURUSD")).rejects.toThrow("not configured");
  });

  it("getCandles throws when unconfigured", async () => {
    await expect(provider.getCandles("EURUSD", "1h")).rejects.toThrow("not configured");
  });

  it("getDom throws when unconfigured", async () => {
    await expect(provider.getDom("EURUSD")).rejects.toThrow("not configured");
  });

  it("getHeatmap throws when unconfigured", async () => {
    await expect(provider.getHeatmap("EURUSD")).rejects.toThrow("not configured");
  });

  it("getVolumeProfile throws when unconfigured", async () => {
    await expect(provider.getVolumeProfile("EURUSD")).rejects.toThrow("not configured");
  });
});

// ─── Market data service — provider selection ────────────────────────────────

describe("getMarketDataProvider", () => {
  beforeEach(() => {
    resetMarketDataProvider();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMarketDataProvider();
  });

  it("returns DxfeedMarketDataProvider by default (no env var)", () => {
    vi.stubEnv("MARKET_DATA_PROVIDER", "");
    vi.stubEnv("ALLOW_MOCK_MARKET_DATA", "");
    const provider = getMarketDataProvider();
    expect(provider).toBeInstanceOf(DxfeedMarketDataProvider);
  });

  it("returns MockMarketDataProvider when local mock data is explicitly enabled", () => {
    vi.stubEnv("MARKET_DATA_PROVIDER", "mock");
    vi.stubEnv("ALLOW_MOCK_MARKET_DATA", "true");
    const provider = getMarketDataProvider();
    expect(provider).toBeInstanceOf(MockMarketDataProvider);
  });

  it("returns DxfeedMarketDataProvider when MARKET_DATA_PROVIDER=dxfeed", () => {
    process.env.MARKET_DATA_PROVIDER = "dxfeed";
    const provider = getMarketDataProvider();
    expect(provider).toBeInstanceOf(DxfeedMarketDataProvider);
  });

  it("returns the same singleton instance on repeated calls", () => {
    vi.stubEnv("MARKET_DATA_PROVIDER", "mock");
    vi.stubEnv("ALLOW_MOCK_MARKET_DATA", "true");
    const p1 = getMarketDataProvider();
    const p2 = getMarketDataProvider();
    expect(p1).toBe(p2);
  });

  it("resetMarketDataProvider clears the singleton", () => {
    vi.stubEnv("MARKET_DATA_PROVIDER", "mock");
    vi.stubEnv("ALLOW_MOCK_MARKET_DATA", "true");
    const p1 = getMarketDataProvider();
    resetMarketDataProvider();
    process.env.MARKET_DATA_PROVIDER = "dxfeed";
    const p2 = getMarketDataProvider();
    expect(p1).not.toBe(p2);
    expect(p2).toBeInstanceOf(DxfeedMarketDataProvider);
  });
});
