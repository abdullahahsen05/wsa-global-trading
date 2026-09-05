"use client";

/**
 * DxfeedTerminal
 *
 * Mounts the four dxFeed Candelabra white-label widgets:
 *   ┌─────────────────────────────┬───────────────┐
 *   │  Advanced Chart  (main)     │  Depth of Mkt │
 *   │                             │  (DOM)        │
 *   ├──────────────────┬──────────┴───────────────┤
 *   │  Heatmap         │  News                    │
 *   └──────────────────┴──────────────────────────┘
 *
 * Requires:
 *   - DXFEED_WIDGET_CDN_URL set to the Candelabra bundle URL (provisioned by dxFeed)
 *   - All DXFEED_* env vars configured (checked via /api/dxfeed/config)
 *
 * The CDN bundle is loaded once via a <script> tag. Factory functions are
 * called after the script resolves. Widgets are destroyed on component unmount.
 *
 * CDN global names (verify with your provisioned bundle):
 *   window.newAdvancedChartWidget
 *   window.newDepthOfMarketWidget
 *   window.newHeatmapWidget
 *   window.newNewsWidget
 *
 * Reference: https://widgets.dxfeed.com/docs/widgets/
 */

import { useEffect, useRef, useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DxDataProviders {
  ipfPath: string;
  ipfAuthHeader: string;
  schedulePath: string;
  feedPath: string;
  feedAuthHeader: string;
  scannerPath: string;
  scannerAuthHeader: string;
  newsPath: string;
  newsAuthHeader: string;
}

interface DxWidgetOptions {
  element: HTMLElement;
  providers: DxDataProviders;
  symbol?: string;
  theme?: "dark" | "light";
  [key: string]: unknown;
}

interface DxWidget {
  setSymbol?: (symbol: string) => void;
  destroy?: () => void;
  dispose?: () => void;
  [key: string]: unknown;
}

// CDN bundle exposes factory functions as window globals.
// Exact names verified against dxFeed Candelabra v5.9.0 docs.
declare global {
  interface Window {
    newAdvancedChartWidget?: (opts: DxWidgetOptions) => DxWidget;
    newDepthOfMarketWidget?: (opts: DxWidgetOptions) => DxWidget;
    newHeatmapWidget?: (opts: DxWidgetOptions) => DxWidget;
    newNewsWidget?: (opts: DxWidgetOptions) => DxWidget;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function destroyWidget(w: DxWidget | null) {
  if (!w) return;
  try {
    w.destroy?.();
    w.dispose?.();
  } catch {
    // Widget already cleaned up
  }
}

async function loadCdnScript(cdnUrl: string): Promise<void> {
  if (document.querySelector(`script[data-dxfeed-cdn]`)) return; // already loaded
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = cdnUrl;
    s.async = true;
    s.setAttribute("data-dxfeed-cdn", "1");
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load dxFeed CDN bundle: ${cdnUrl}`));
    document.head.appendChild(s);
  });
}

// ── Symbols list ──────────────────────────────────────────────────────────────

const WATCHLIST = [
  { symbol: "EURUSD", label: "EUR/USD" },
  { symbol: "GBPUSD", label: "GBP/USD" },
  { symbol: "USDJPY", label: "USD/JPY" },
  { symbol: "XAUUSD", label: "XAU/USD" },
  { symbol: "NAS100", label: "NAS 100" },
  { symbol: "US30",   label: "US 30"   },
  { symbol: "BTCUSD", label: "BTC/USD" },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  initialSymbol?: string;
  onSymbolChange?: (symbol: string) => void;
}

export default function DxfeedTerminal({ initialSymbol = "EURUSD", onSymbolChange }: Props) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // Container refs for the four widget panels
  const chartRef   = useRef<HTMLDivElement>(null);
  const domRef     = useRef<HTMLDivElement>(null);
  const heatmapRef = useRef<HTMLDivElement>(null);
  const newsRef    = useRef<HTMLDivElement>(null);

  // Widget instance refs for cleanup and symbol updates
  const chartWidget   = useRef<DxWidget | null>(null);
  const domWidget     = useRef<DxWidget | null>(null);
  const heatmapWidget = useRef<DxWidget | null>(null);
  const newsWidget    = useRef<DxWidget | null>(null);

  const providersRef = useRef<DxDataProviders | null>(null);
  const cdnUrlRef    = useRef<string>("");

  // ── Bootstrap ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        // 1. Fetch server-side config (proxy paths, no credentials exposed)
        const cfgRes = await fetch("/api/dxfeed/config");
        const cfg = await cfgRes.json();

        if (!cfg.ok || !cfg.data?.configured) {
          throw new Error(
            cfg.data?.missing
              ? `dxFeed not configured — missing: ${(cfg.data.missing as string[]).join(", ")}`
              : "dxFeed widget configuration incomplete"
          );
        }

        const providers: DxDataProviders = cfg.data.dataProviders;
        cdnUrlRef.current = cfg.data.cdnUrl as string;

        // 2. Fetch short-lived WebSocket feed token (keeps the main secret server-side)
        const tokenRes = await fetch("/api/dxfeed/feed-token", { method: "POST" });
        const tokenData = await tokenRes.json();
        if (tokenData.ok && tokenData.data?.feedUrl) {
          providers.feedPath = tokenData.data.feedUrl as string;
        }

        providersRef.current = providers;

        if (cancelled) return;

        // 3. Load the CDN bundle
        await loadCdnScript(cdnUrlRef.current);

        if (cancelled) return;

        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Unknown error");
          setStatus("error");
        }
      }
    }

    bootstrap();
    return () => { cancelled = true; };
  }, []);

  // ── Mount widgets once CDN is ready ──────────────────────────────────────────

  useEffect(() => {
    if (status !== "ready" || !providersRef.current) return;

    const providers = providersRef.current;
    const opts = (element: HTMLElement): DxWidgetOptions => ({
      element,
      providers,
      symbol,
      theme: "dark",
    });

    if (chartRef.current && window.newAdvancedChartWidget) {
      destroyWidget(chartWidget.current);
      chartWidget.current = window.newAdvancedChartWidget(opts(chartRef.current));
    }

    if (domRef.current && window.newDepthOfMarketWidget) {
      destroyWidget(domWidget.current);
      domWidget.current = window.newDepthOfMarketWidget(opts(domRef.current));
    }

    if (heatmapRef.current && window.newHeatmapWidget) {
      destroyWidget(heatmapWidget.current);
      heatmapWidget.current = window.newHeatmapWidget(opts(heatmapRef.current));
    }

    if (newsRef.current && window.newNewsWidget) {
      destroyWidget(newsWidget.current);
      newsWidget.current = window.newNewsWidget(opts(newsRef.current));
    }

    return () => {
      destroyWidget(chartWidget.current);   chartWidget.current   = null;
      destroyWidget(domWidget.current);     domWidget.current     = null;
      destroyWidget(heatmapWidget.current); heatmapWidget.current = null;
      destroyWidget(newsWidget.current);    newsWidget.current    = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ── Symbol changes propagated to live widgets ─────────────────────────────────

  const handleSymbolChange = useCallback((sym: string) => {
    setSymbol(sym);
    onSymbolChange?.(sym);

    // Push new symbol into mounted widgets without remounting
    chartWidget.current?.setSymbol?.(sym);
    domWidget.current?.setSymbol?.(sym);
    newsWidget.current?.setSymbol?.(sym);
    // Heatmap uses scanner-based scanning — some implementations auto-update;
    // recreate if setSymbol is not available
    if (heatmapWidget.current && !heatmapWidget.current.setSymbol && heatmapRef.current && providersRef.current) {
      destroyWidget(heatmapWidget.current);
      heatmapWidget.current = window.newHeatmapWidget?.({
        element: heatmapRef.current,
        providers: providersRef.current,
        symbol: sym,
        theme: "dark",
      }) ?? null;
    } else {
      heatmapWidget.current?.setSymbol?.(sym);
    }
  }, [onSymbolChange]);

  // ── Render ────────────────────────────────────────────────────────────────────

  if (status === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-background text-center">
        <div className="max-w-md space-y-3 rounded border border-border bg-card p-6">
          <p className="text-sm font-semibold text-red-400">dxFeed Terminal Unavailable</p>
          <p className="text-xs text-muted-foreground">{errorMsg}</p>
          <p className="text-xs text-muted-foreground">
            Obtain data entitlements from{" "}
            <span className="font-mono text-foreground">dxfeed.com</span> and configure all{" "}
            <span className="font-mono">DXFEED_*</span> environment variables.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0f0f10] text-white">
      {/* ── Symbol selector bar ─────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#1a1a1d] px-4 py-2">
        <span className="rounded bg-blue-900/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-300">
          dxFeed Live
        </span>
        <div className="flex gap-1">
          {WATCHLIST.map((s) => (
            <button
              key={s.symbol}
              onClick={() => handleSymbolChange(s.symbol)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                symbol === s.symbol
                  ? "bg-blue-600 text-white"
                  : "text-zinc-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {status === "loading" && (
          <span className="ml-auto text-xs text-zinc-500">Loading widgets…</span>
        )}
      </div>

      {/* ── Widget grid ─────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* Left column: Advanced Chart (top) + Heatmap (bottom) */}
        <div className="flex flex-col" style={{ flex: "0 0 60%" }}>
          {/* Advanced Chart — needs explicit dimensions before factory call */}
          <div
            ref={chartRef}
            className="relative border-b border-r border-white/10 bg-[#131316]"
            style={{ flex: "0 0 62%" }}
          >
            {status === "loading" && <WidgetSkeleton label="Advanced Chart" />}
          </div>

          {/* Heatmap */}
          <div
            ref={heatmapRef}
            className="relative border-r border-white/10 bg-[#131316]"
            style={{ flex: "0 0 38%" }}
          >
            {status === "loading" && <WidgetSkeleton label="Heatmap" />}
          </div>
        </div>

        {/* Right column: DOM (top) + News (bottom) */}
        <div className="flex flex-col" style={{ flex: "0 0 40%" }}>
          {/* Depth of Market */}
          <div
            ref={domRef}
            className="relative border-b border-white/10 bg-[#131316]"
            style={{ flex: "0 0 50%" }}
          >
            {status === "loading" && <WidgetSkeleton label="Depth of Market" />}
          </div>

          {/* News */}
          <div
            ref={newsRef}
            className="relative bg-[#131316]"
            style={{ flex: "0 0 50%" }}
          >
            {status === "loading" && <WidgetSkeleton label="News" />}
          </div>
        </div>
      </div>
    </div>
  );
}

function WidgetSkeleton({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <span className="text-xs text-zinc-600">{label}</span>
    </div>
  );
}
