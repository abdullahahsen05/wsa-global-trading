"use client";

import { useEffect, useRef, useState } from "react";
import {
  TRADING_VIEW_WIDGET_SCRIPT,
  buildTradingViewWidgetConfig,
  tradingViewSymbolUrl,
} from "@/lib/terminal/tradingview";
import {
  DEFAULT_TRADING_VIEW_SYMBOLS,
  type TradingViewChartOptions,
  type TradingViewPanels,
} from "@/lib/terminal/workspace";

export const TRADING_VIEW_SYMBOLS: Record<string, string> = DEFAULT_TRADING_VIEW_SYMBOLS;

export type TradingViewAdvancedChartProps = {
  symbol?: string;
  interval?: string;
  height?: number | string;
  /** Symbols of the watchlist panel (shown when `panels.watchlist` is on). */
  watchlist?: ReadonlyArray<string>;
  /** Right-hand panels of the widget. Everything is off by default. */
  panels?: Partial<TradingViewPanels>;
  /** Style, indicators, toolbars ... Missing fields take the terminal's defaults. */
  chart?: Partial<TradingViewChartOptions>;
};

/** The browser's own time zone, for the "My browser's time" choice. */
function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function TradingViewAdvancedChart({
  symbol = "OANDA:XAUUSD",
  interval = "15",
  height = "520px",
  watchlist,
  panels,
  chart,
}: TradingViewAdvancedChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const disableThirdPartyWidget = typeof navigator !== "undefined" && navigator.webdriver;

  // The widget has no update call: any change of the configuration rebuilds it.
  // One string stands for the whole configuration, so a new object or array with
  // the same content does not rebuild it.
  const configJson = JSON.stringify(
    buildTradingViewWidgetConfig({
      symbol,
      interval,
      watchlist,
      panels,
      chart,
      localTimezone: browserTimezone(),
    }),
  );

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

      // TradingView's terms require this attribution link next to the widget.
      const copyright = document.createElement("div");
      copyright.className = "tradingview-widget-copyright";
      copyright.style.cssText =
        "font-size:10px;color:rgba(255,255,255,0.25);text-align:right;padding:4px 8px 0;";
      const attribution = document.createElement("a");
      attribution.href = tradingViewSymbolUrl(symbol);
      attribution.rel = "noopener nofollow";
      attribution.target = "_blank";
      attribution.style.color = "rgba(255,255,255,0.3)";
      attribution.textContent = "Chart by TradingView";
      copyright.appendChild(attribution);

      const script = document.createElement("script");
      script.type = "text/javascript";
      script.src = TRADING_VIEW_WIDGET_SCRIPT;
      script.async = true;

      script.onerror = () => setFailed(true);

      // Config is embedded in the script's text content (official TradingView pattern)
      script.innerHTML = configJson;

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
  }, [configJson, disableThirdPartyWidget, symbol]);

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
