"use client";

import { useEffect, useRef, useState } from "react";

export const TRADING_VIEW_SYMBOLS: Record<string, string> = {
  XAUUSD: "OANDA:XAUUSD",
  EURUSD: "OANDA:EURUSD",
  GBPUSD: "OANDA:GBPUSD",
  USDJPY: "OANDA:USDJPY",
  NAS100: "OANDA:NAS100USD",
  US30: "OANDA:US30USD",
  BTCUSD: "BINANCE:BTCUSDT",
  ETHUSD: "BINANCE:ETHUSDT",
};

export type TradingViewAdvancedChartProps = {
  symbol?: string;
  interval?: string;
  height?: number | string;
  theme?: "dark" | "light";
  allowSymbolChange?: boolean;
};

export function TradingViewAdvancedChart({
  symbol = "OANDA:XAUUSD",
  interval = "15",
  height = "520px",
  theme = "dark",
  allowSymbolChange = true,
}: TradingViewAdvancedChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const disableThirdPartyWidget = typeof navigator !== "undefined" && navigator.webdriver;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";
    setFailed(false);

    // Playwright/automation runs can trigger noisy third-party widget requests
    // that are irrelevant to product behavior. Use the built-in fallback instead.
    if (disableThirdPartyWidget) {
      return;
    }

    let active = true;

    // Defer one paint so the container has computed layout before TradingView
    // tries to attach iframe resize listeners (prevents contentWindow warning).
    const rafId = requestAnimationFrame(() => {
      if (!active) return;
      const mountNode = containerRef.current;
      if (!mountNode) return;

      const widgetContainer = document.createElement("div");
      widgetContainer.className = "tradingview-widget-container";
      widgetContainer.style.height = "100%";
      widgetContainer.style.width = "100%";

      const widgetDiv = document.createElement("div");
      widgetDiv.className = "tradingview-widget-container__widget";
      widgetDiv.style.height = "calc(100% - 32px)";
      widgetDiv.style.width = "100%";

      const copyright = document.createElement("div");
      copyright.className = "tradingview-widget-copyright";
      copyright.style.cssText =
        "font-size:10px;color:rgba(255,255,255,0.25);text-align:right;padding:4px 8px 0;";
      const symbolSlug = symbol.replace(":", "-");
      copyright.innerHTML = `<a href="https://www.tradingview.com/symbols/${symbolSlug}/" rel="noopener nofollow" target="_blank" style="color:rgba(255,255,255,0.3)">Chart by TradingView</a>`;

      const script = document.createElement("script");
      script.type = "text/javascript";
      script.src =
        "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
      script.async = true;

      script.onerror = () => setFailed(true);

      // Config is embedded in the script's text content (official TradingView pattern)
      script.innerHTML = JSON.stringify({
        autosize: true,
        symbol,
        interval,
        timezone: "Etc/UTC",
        theme,
        style: "1",
        locale: "en",
        backgroundColor: "rgba(10, 10, 10, 1)",
        gridColor: "rgba(255, 255, 255, 0.06)",
        allow_symbol_change: allowSymbolChange,
        calendar: false,
        details: false,
        hide_side_toolbar: false,
        hide_top_toolbar: false,
        hide_legend: false,
        hide_volume: false,
        hotlist: false,
        save_image: false,
        withdateranges: true,
        support_host: "https://www.tradingview.com",
        studies: ["STD;EMA"],
      });

      widgetContainer.appendChild(widgetDiv);
      widgetContainer.appendChild(copyright);
      widgetContainer.appendChild(script);
      mountNode.appendChild(widgetContainer);
    });

    return () => {
      active = false;
      cancelAnimationFrame(rafId);
      container.innerHTML = "";
    };
  }, [allowSymbolChange, disableThirdPartyWidget, symbol, interval, theme]);

  if (disableThirdPartyWidget || failed) {
    return (
      <div
        className="flex items-center justify-center rounded-[4px] border border-white/10 bg-[#0a0a0a] text-center"
        style={{ height, width: "100%" }}
      >
        <p className="max-w-xs text-sm text-muted-foreground">
          TradingView chart could not load. Check your internet connection or
          ad / script blockers.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-[4px] border border-white/10 bg-[#050505]"
      style={{ height, width: "100%" }}
    />
  );
}
