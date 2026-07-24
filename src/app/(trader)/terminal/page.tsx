"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { WorkspacePage, Panel } from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";

// When DXFEED_WIDGET_CDN_URL is set, render the Candelabra widget terminal
// instead of the mock terminal. The CDN URL is a NEXT_PUBLIC_ var so it is
// available in the client bundle without exposing any credential.
const DXFEED_CDN = process.env.NEXT_PUBLIC_DXFEED_WIDGET_CDN_URL ?? "";

const DxfeedTerminal = dynamic(
  () => import("@/components/terminal/DxfeedTerminal"),
  { ssr: false }
);
import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type {
  ProviderStatus,
  SymbolInfo,
  QuoteData,
  CandleData,
  DomData,
  VolumeProfileData,
  HeatmapData,
  NewsItem,
  MacroEvent,
  TerminalPreferences,
  Timeframe,
} from "@/lib/terminal/types";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";

const CandleChart = dynamic(() => import("@/components/terminal/CandleChart"), { ssr: false });

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

const IMPACT_COLOR: Record<string, string> = {
  HIGH: "text-red-400",
  MEDIUM: "text-yellow-400",
  LOW: "text-muted-foreground",
};

const SENTIMENT_COLOR: Record<string, string> = {
  bullish: "text-green-400",
  bearish: "text-red-400",
  neutral: "text-muted-foreground",
};

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

export default function TerminalPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage eyebrow="Terminal" title="Professional Terminal" description="Loading your platform access status.">
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (access.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Terminal"
        title="Professional Terminal"
        description="Activate your platform subscription to unlock the trader terminal workspace."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock the professional terminal workspace, chart workflow, and trader terminal tools."
        />
      </WorkspacePage>
    );
  }

  return <TerminalContent />;
}

function TerminalContent() {
  const [symbolOverride, setSymbolOverride] = useState<string | null>(null);
  const [timeframeOverride, setTimeframeOverride] = useState<Timeframe | null>(null);
  const [rightPanel, setRightPanel] = useState<"dom" | "vprofile" | "heatmap">("dom");
  const [bottomPanel, setBottomPanel] = useState<"macro" | "news">("macro");
  const [proOpen, setProOpen] = useState(false);
  const proDialogRef = useRef<HTMLDivElement>(null);

  // Load saved preferences on mount
  const { data: prefs } = useQuery<TerminalPreferences>({
    queryKey: ["terminal-prefs"],
    queryFn: () => apiFetch("/api/terminal/preferences"),
  });

  const symbol = symbolOverride ?? prefs?.symbol ?? "EURUSD";
  const timeframe = timeframeOverride ?? prefs?.timeframe ?? "1h";

  const savePrefsMutation = useMutation({
    mutationFn: (data: Partial<TerminalPreferences>) =>
      apiFetch("/api/terminal/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
  });

  const changeSymbol = useCallback(
    (sym: string) => {
      setSymbolOverride(sym);
      savePrefsMutation.mutate({ symbol: sym });
    },
    [savePrefsMutation]
  );

  const changeTimeframe = useCallback(
    (tf: Timeframe) => {
      setTimeframeOverride(tf);
      savePrefsMutation.mutate({ timeframe: tf });
    },
    [savePrefsMutation]
  );

  const { data: providerStatus } = useQuery<ProviderStatus>({
    queryKey: ["terminal-provider-status"],
    queryFn: () => apiFetch("/api/terminal/provider/status"),
    staleTime: 60_000,
  });

  const { data: symbols = [] } = useQuery<SymbolInfo[]>({
    queryKey: ["terminal-symbols"],
    queryFn: () => apiFetch("/api/terminal/symbols"),
    staleTime: 300_000,
  });

  const { data: quote } = useQuery<QuoteData>({
    queryKey: ["terminal-quote", symbol],
    queryFn: () => apiFetch(`/api/terminal/quote?symbol=${symbol}`),
    refetchInterval: 3000,
    enabled: Boolean(symbol),
  });

  const { data: candles } = useQuery<CandleData>({
    queryKey: ["terminal-candles", symbol, timeframe],
    queryFn: () => apiFetch(`/api/terminal/candles?symbol=${symbol}&timeframe=${timeframe}`),
    staleTime: 10_000,
    enabled: Boolean(symbol),
  });

  const { data: dom } = useQuery<DomData>({
    queryKey: ["terminal-dom", symbol],
    queryFn: () => apiFetch(`/api/terminal/dom?symbol=${symbol}`),
    refetchInterval: 2000,
    enabled: rightPanel === "dom" && Boolean(symbol),
  });

  const { data: vprofile } = useQuery<VolumeProfileData>({
    queryKey: ["terminal-vprofile", symbol],
    queryFn: () => apiFetch(`/api/terminal/volume-profile?symbol=${symbol}`),
    staleTime: 30_000,
    enabled: rightPanel === "vprofile" && Boolean(symbol),
  });

  const { data: heatmap } = useQuery<HeatmapData>({
    queryKey: ["terminal-heatmap", symbol],
    queryFn: () => apiFetch(`/api/terminal/heatmap?symbol=${symbol}`),
    staleTime: 30_000,
    enabled: rightPanel === "heatmap" && Boolean(symbol),
  });

  const { data: macro = [] } = useQuery<MacroEvent[]>({
    queryKey: ["terminal-macro"],
    queryFn: () => apiFetch("/api/terminal/macro"),
    staleTime: 300_000,
  });

  const { data: news = [] } = useQuery<NewsItem[]>({
    queryKey: ["terminal-news", symbol],
    queryFn: () => apiFetch(`/api/terminal/news?symbol=${symbol}`),
    staleTime: 120_000,
  });

  const symbolInfo = symbols.find((s) => s.symbol === symbol);
  const decimals = symbolInfo?.displayDecimals ?? 5;

  const fmtPrice = (p: number) => p.toFixed(decimals);
  const fmtChange = (c: number) =>
    `${c >= 0 ? "+" : ""}${c.toFixed(decimals)} (${quote ? (quote.changePct >= 0 ? "+" : "") + quote.changePct.toFixed(2) + "%" : ""})`;

  const byCategory = (cat: string) => symbols.filter((s) => s.category === cat);

  // Render dxFeed Candelabra widgets when CDN is provisioned
  if (DXFEED_CDN) {
    return (
      <div className="h-screen overflow-hidden">
        <DxfeedTerminal
          initialSymbol={symbol}
          onSymbolChange={changeSymbol}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* ─── Professional Trader locked overlay ───────────────────────── */}
      {proOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={(e) => { if (e.target === e.currentTarget) setProOpen(false); }}
        >
          <div
            ref={proDialogRef}
            className="relative mx-4 w-full max-w-lg rounded-[4px] border border-zinc-700 bg-zinc-900 p-8"
          >
            <button
              onClick={() => setProOpen(false)}
              className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full border border-zinc-700 text-zinc-400 hover:text-zinc-100"
              aria-label="Close"
            >
              ✕
            </button>

            {/* Lock icon */}
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[4px] border border-zinc-700 bg-zinc-800 text-2xl">
              🔒
            </div>

            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
              Professional Tier
            </p>
            <h2 className="text-xl font-bold text-zinc-100">
              Professional Live Market Data
            </h2>
            <p className="mt-3 text-sm leading-6 text-zinc-400">
              Real-time institutional market data is available through our{" "}
              <strong className="text-zinc-200">dxFeed / Devexperts</strong> integration.
              Access is locked until a data redistribution agreement is in place.
            </p>

            <div className="mt-5 space-y-2">
              {[
                "Real-time tick-by-tick price feeds",
                "Institutional-grade order flow & depth",
                "Live Level II DOM data",
                "Full liquidity heatmap",
                "Exchange-sourced volume profile",
              ].map((f) => (
                <div key={f} className="flex items-center gap-2 text-sm text-zinc-400">
                  <span className="text-zinc-600">○</span>
                  {f}
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-[4px] border border-zinc-700 bg-zinc-800/60 px-4 py-3 text-xs text-zinc-400">
              <strong className="text-zinc-300">Current status:</strong> Demo simulation data active.
              Professional data will be enabled once the dxFeed agreement and API credentials are
              configured by your administrator.
            </div>

            <button
              onClick={() => setProOpen(false)}
              className="mt-6 w-full rounded-[4px] bg-zinc-800 py-2.5 text-sm font-semibold text-zinc-300 hover:bg-zinc-700"
            >
              Continue with Demo Data
            </button>
          </div>
        </div>
      )}

      {/* ─── Top bar ──────────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-4 border-b border-border bg-card px-4 py-2">
        {/* Provider badge */}
        <span
          className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            providerStatus?.mode === "live"
              ? "bg-green-900/40 text-green-400"
              : "bg-zinc-800 text-muted-foreground"
          }`}
        >
          {providerStatus?.label ?? "Demo Market Data"}
        </span>

        {/* Professional Data locked button */}
        <button
          onClick={() => setProOpen(true)}
          className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
        >
          <span>🔒</span>
          Professional Data
        </button>

        {/* Symbol + price */}
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-bold">{symbol}</span>
          {quote && (
            <>
              <span className="text-lg font-mono font-semibold tabular-nums">
                {fmtPrice(quote.mid)}
              </span>
              <span
                className={`text-xs font-mono ${
                  quote.changePct >= 0 ? "text-green-400" : "text-red-400"
                }`}
              >
                {fmtChange(quote.change)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                H: {fmtPrice(quote.high24h)} L: {fmtPrice(quote.low24h)}
              </span>
            </>
          )}
        </div>

        {/* Bid/Ask */}
        {quote && (
          <div className="ml-4 flex gap-3 text-xs font-mono tabular-nums">
            <span className="text-red-400">ASK {fmtPrice(quote.ask)}</span>
            <span className="text-green-400">BID {fmtPrice(quote.bid)}</span>
          </div>
        )}

        <div className="ml-auto text-[10px] text-muted-foreground">
          {symbolInfo?.description}
        </div>
      </header>

      {/* ─── Main content ─────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Watchlist sidebar */}
        <aside className="hidden w-36 shrink-0 invisible-scrollbar overflow-y-auto border-r border-border bg-card lg:block">
          {["forex", "commodities", "indices", "crypto"].map((cat) => {
            const items = byCategory(cat);
            if (items.length === 0) return null;
            return (
              <div key={cat} className="border-b border-border">
                <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {cat}
                </div>
                {items.map((s) => (
                  <button
                    key={s.symbol}
                    onClick={() => changeSymbol(s.symbol)}
                    className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-xs hover:bg-border/50 ${
                      s.symbol === symbol ? "bg-accent/10 text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    <span className="font-medium">{s.symbol}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </aside>

        {/* Chart panel */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Timeframe selector */}
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => changeTimeframe(tf)}
                className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                  tf === timeframe
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tf}
              </button>
            ))}

            {/* Mobile symbol selector */}
            <select
              value={symbol}
              onChange={(e) => changeSymbol(e.target.value)}
              className="ml-auto rounded border border-border bg-background px-2 py-0.5 text-xs text-foreground lg:hidden"
            >
              {symbols.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.symbol}
                </option>
              ))}
            </select>
          </div>

          {/* Candle chart */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <CandleChart bars={candles?.bars ?? []} height={undefined} />
          </div>
        </div>

        {/* Right panel — DOM / Volume Profile / Heatmap */}
        <aside className="hidden w-52 shrink-0 flex-col border-l border-border bg-card xl:flex">
          {/* Panel tabs */}
          <div className="flex shrink-0 border-b border-border">
            {(["dom", "vprofile", "heatmap"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setRightPanel(p)}
                className={`flex-1 py-1.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                  rightPanel === p
                    ? "border-b-2 border-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p === "dom" ? "DOM" : p === "vprofile" ? "Vol Profile" : "Heatmap"}
              </button>
            ))}
          </div>

          {/* DOM */}
          {rightPanel === "dom" && dom && (
            <div className="flex-1 invisible-scrollbar overflow-y-auto p-2">
              {/* Asks (reversed — highest at top, lowest closest to spread) */}
              {[...dom.asks].reverse().slice(0, 8).map((l, i) => {
                const maxSize = Math.max(...dom.asks.map((a) => a.size));
                const pct = (l.size / maxSize) * 100;
                return (
                  <div key={i} className="relative mb-px flex items-center justify-between py-0.5">
                    <div
                      className="absolute right-0 top-0 h-full bg-red-900/30"
                      style={{ width: `${pct}%` }}
                    />
                    <span className="relative z-10 font-mono text-[10px] text-red-400">
                      {fmtPrice(l.price)}
                    </span>
                    <span className="relative z-10 font-mono text-[10px] text-muted-foreground">
                      {(l.size / 1000).toFixed(1)}K
                    </span>
                  </div>
                );
              })}

              {/* Spread */}
              <div className="my-1 flex items-center justify-center gap-1 text-[9px] text-muted-foreground">
                <span>SPREAD</span>
                <span className="font-mono text-foreground">
                  {(dom.spread / (symbolInfo?.pipSize ?? 0.0001)).toFixed(1)}
                </span>
                <span>pips</span>
              </div>

              {/* Bids */}
              {dom.bids.slice(0, 8).map((l, i) => {
                const maxSize = Math.max(...dom.bids.map((b) => b.size));
                const pct = (l.size / maxSize) * 100;
                return (
                  <div key={i} className="relative mb-px flex items-center justify-between py-0.5">
                    <div
                      className="absolute left-0 top-0 h-full bg-green-900/30"
                      style={{ width: `${pct}%` }}
                    />
                    <span className="relative z-10 font-mono text-[10px] text-green-400">
                      {fmtPrice(l.price)}
                    </span>
                    <span className="relative z-10 font-mono text-[10px] text-muted-foreground">
                      {(l.size / 1000).toFixed(1)}K
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Volume Profile */}
          {rightPanel === "vprofile" && vprofile && (
            <div className="flex-1 invisible-scrollbar overflow-y-auto p-2">
              <div className="mb-1 text-[9px] text-muted-foreground">
                POC: <span className="font-mono text-foreground">{fmtPrice(vprofile.pocPrice)}</span>
              </div>
              {[...vprofile.bars].reverse().map((bar, i) => {
                const maxVol = Math.max(...vprofile.bars.map((b) => b.volume));
                const pct = (bar.volume / maxVol) * 100;
                return (
                  <div key={i} className="mb-px flex items-center gap-1">
                    <span className="w-16 shrink-0 font-mono text-[9px] text-muted-foreground">
                      {fmtPrice(bar.price)}
                    </span>
                    <div className="flex-1">
                      <div
                        className={`h-2.5 rounded-sm ${
                          bar.isHighVolume ? "bg-accent" : "bg-border"
                        }`}
                        style={{ width: `${Math.max(pct, 4)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Heatmap */}
          {rightPanel === "heatmap" && heatmap && (
            <div className="flex-1 overflow-hidden p-2">
              <div className="mb-1 text-[9px] text-muted-foreground">Liquidity Heatmap</div>
              <div className="grid gap-px" style={{ gridTemplateColumns: "repeat(10, 1fr)" }}>
                {heatmap.cells.map((cell, i) => (
                  <div
                    key={i}
                    title={`${fmtPrice(cell.price)}`}
                    className="h-3 rounded-sm"
                    style={{
                      backgroundColor: `rgba(99,102,241,${cell.volume.toFixed(2)})`,
                    }}
                  />
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between text-[9px] text-muted-foreground">
                <span>{fmtPrice(heatmap.priceMin)}</span>
                <span>price range</span>
                <span>{fmtPrice(heatmap.priceMax)}</span>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* ─── Bottom panel ─────────────────────────────────────────────── */}
      <footer className="flex shrink-0 flex-col border-t border-border bg-card" style={{ maxHeight: 200 }}>
        {/* Panel tabs */}
        <div className="flex shrink-0 items-center border-b border-border">
          {(["macro", "news"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setBottomPanel(p)}
              className={`px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                bottomPanel === p
                  ? "border-b-2 border-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {p === "macro" ? "Economic Calendar" : "News"}
            </button>
          ))}

          {/* AI CTA */}
          <Link
            href={`/ai?symbol=${symbol}`}
            className="ml-auto mr-3 flex items-center gap-1 rounded border border-border px-3 py-1 text-[10px] text-muted-foreground hover:border-accent hover:text-foreground"
          >
            <span className="text-accent">✦</span>
            Ask AI about {symbol}
          </Link>
        </div>

        {/* Macro events */}
        {bottomPanel === "macro" && (
          <div className="flex-1 invisible-scrollbar overflow-x-auto overflow-y-hidden">
            {macro.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">No high-impact events in the next 3 days</div>
            ) : (
              <table className="w-full min-w-max text-xs">
                <thead>
                  <tr className="border-b border-border text-[9px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-1 text-left">Time</th>
                    <th className="px-3 py-1 text-left">Currency</th>
                    <th className="px-3 py-1 text-left">Event</th>
                    <th className="px-3 py-1 text-left">Impact</th>
                    <th className="px-3 py-1 text-right">Actual</th>
                    <th className="px-3 py-1 text-right">Forecast</th>
                    <th className="px-3 py-1 text-right">Previous</th>
                  </tr>
                </thead>
                <tbody>
                  {macro.map((evt) => (
                    <tr
                      key={evt.id}
                      className="border-b border-border/40 last:border-0 hover:bg-border/20"
                    >
                      <td className="px-3 py-1 font-mono tabular-nums text-muted-foreground">
                        {new Date(evt.eventTime).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-3 py-1 font-semibold">{evt.currency}</td>
                      <td className="px-3 py-1 text-foreground">{evt.title}</td>
                      <td className={`px-3 py-1 font-semibold ${IMPACT_COLOR[evt.impact]}`}>
                        {evt.impact}
                      </td>
                      <td className="px-3 py-1 text-right font-mono">{evt.actual ?? "—"}</td>
                      <td className="px-3 py-1 text-right font-mono text-muted-foreground">
                        {evt.forecast ?? "—"}
                      </td>
                      <td className="px-3 py-1 text-right font-mono text-muted-foreground">
                        {evt.previous ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* News feed */}
        {bottomPanel === "news" && (
          <div className="flex-1 invisible-scrollbar overflow-y-auto">
            {news.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">No news available</div>
            ) : (
              news.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 border-b border-border/40 px-3 py-2 last:border-0"
                >
                  <span
                    className={`mt-0.5 shrink-0 text-[9px] font-semibold uppercase ${
                      SENTIMENT_COLOR[item.sentiment]
                    }`}
                  >
                    {item.sentiment}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">{item.headline}</p>
                    <p className="truncate text-[10px] text-muted-foreground">{item.summary}</p>
                  </div>
                  <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
                    {new Date(item.publishedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </footer>
    </div>
  );
}
