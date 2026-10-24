"use client";

import { useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  Info,
  ListChecks,
  Loader2,
  MessageSquare,
  ScreenShare,
  ScreenShareOff,
  Send,
  SlidersHorizontal,
} from "lucide-react";
import { TradingViewAdvancedChart } from "@/components/trading/TradingViewAdvancedChart";
import { TradingViewOptionsPanel } from "@/components/trading/TradingViewOptionsPanel";
import { TradingViewWatchlistEditor } from "@/components/trading/TradingViewWatchlistEditor";
import { AI_ASSISTANT_NAME, ASK_ASSISTANT_LABEL, BRAND_NAME } from "@/lib/brand";
import { buildSymbolOptions, tradingViewChartUrl } from "@/lib/terminal/tradingview";
import {
  TERMINAL_TIMEFRAMES,
  TIMEFRAME_TO_INTERVAL,
  symbolLabel,
  type TradingViewPanels,
  type TradingViewPatch,
  type TradingViewWorkspace,
} from "@/lib/terminal/workspace";

type CropTargetConstructor = { fromElement(element: Element): Promise<unknown> };
type CroppableTrack = MediaStreamTrack & { cropTo?: (target: unknown) => Promise<void> };

const PANEL_TOGGLES: ReadonlyArray<{ key: keyof TradingViewPanels; label: string; hint: string }> = [
  { key: "watchlist", label: "Watchlist", hint: "Symbol list on the right of the chart (your list)" },
  { key: "details", label: "Details", hint: "Symbol details panel" },
  { key: "hotlist", label: "Hotlist", hint: "Top gainers and losers" },
];

function cropTargetApi(): CropTargetConstructor | undefined {
  return (window as typeof window & { CropTarget?: CropTargetConstructor }).CropTarget;
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

async function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The shared chart did not become ready."));
    }, 5000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", onReady);
    };
    video.addEventListener("loadeddata", onReady, { once: true });
  });
}

export interface TradingChartProps {
  accountId?: string;
  /** symbol, timeframe, watchlist, panels and chart options - owned by the terminal workspace */
  settings: TradingViewWorkspace;
  onSettingsChange: (patch: TradingViewPatch) => void;
  /** height of the chart area (the split layout uses a lower one) */
  chartHeight?: string;
}

export function TradingChart({
  accountId,
  settings,
  onSettingsChange,
  chartHeight = "clamp(520px, 78dvh, 820px)",
}: TradingChartProps) {
  const { symbol: selectedSymbol, timeframe, watchlist, panels, chart } = settings;
  const [editorOpen, setEditorOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [assistantError, setAssistantError] = useState("");
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [captureEnabled, setCaptureEnabled] = useState(true);
  const [captureCapabilityLoaded, setCaptureCapabilityLoaded] = useState(false);
  const [chartShared, setChartShared] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const chartRegionRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const streamIsRegionCroppedRef = useRef(false);

  const selectedSymbolLabel = symbolLabel(selectedSymbol);
  const symbolOptions = buildSymbolOptions(watchlist, selectedSymbol, symbolLabel);
  const tvSymbol = selectedSymbol;
  const tvInterval = TIMEFRAME_TO_INTERVAL[timeframe];
  const captureSupported = typeof window !== "undefined"
    && Boolean(
      navigator.mediaDevices
      && "getDisplayMedia" in navigator.mediaDevices,
    );

  useEffect(() => {
    let active = true;
    void fetch("/api/ai/chart-assistant")
      .then((response) => response.json())
      .then((json) => {
        if (active) setCaptureEnabled(Boolean(json.ok && json.data?.screenshotsEnabled));
      })
      .catch(() => {
        // Keep the default enabled. The POST route remains authoritative.
      })
      .finally(() => {
        if (active) setCaptureCapabilityLoaded(true);
      });

    return () => {
      active = false;
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  function stopChartShare(): void {
    stopStream(streamRef.current);
    streamRef.current = null;
    streamIsRegionCroppedRef.current = false;
    if (videoRef.current) videoRef.current.srcObject = null;
    setChartShared(false);
  }

  async function startChartShare(): Promise<boolean> {
    if (!captureEnabled || !captureSupported || shareLoading) return false;
    const chartRegion = chartRegionRef.current;
    const video = videoRef.current;
    const CropTarget = cropTargetApi();
    if (!chartRegion || !video) return false;

    setShareLoading(true);
    setAssistantError("");
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
      } as DisplayMediaStreamOptions);

      const track = stream.getVideoTracks()[0] as CroppableTrack | undefined;
      if (!track || track.getSettings().displaySurface !== "browser") {
        throw new Error(`Choose the current browser tab so ${BRAND_NAME} can isolate the chart safely.`);
      }
      let regionCropped = false;
      if (CropTarget && typeof track.cropTo === "function") {
        const cropTarget = await CropTarget.fromElement(chartRegion);
        await track.cropTo(cropTarget);
        regionCropped = true;
      }

      stopStream(streamRef.current);
      streamRef.current = stream;
      streamIsRegionCroppedRef.current = regionCropped;
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await waitForVideoFrame(video);
      track.addEventListener("ended", () => {
        streamRef.current = null;
        streamIsRegionCroppedRef.current = false;
        setChartShared(false);
      }, { once: true });
      setChartShared(true);
      stream = null;
      return true;
    } catch (error) {
      setAssistantError(
        error instanceof Error
          ? error.message
          : "Chart sharing was cancelled or could not start.",
      );
      return false;
    } finally {
      stopStream(stream);
      setShareLoading(false);
    }
  }

  async function captureChartFrame(): Promise<Blob> {
    const video = videoRef.current;
    if (!video || !streamRef.current) throw new Error("Share the chart before asking for a visual review.");
    await waitForVideoFrame(video);

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) throw new Error("The shared chart frame is unavailable.");
    const canvas = document.createElement("canvas");
    let sourceX = 0;
    let sourceY = 0;
    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;

    if (!streamIsRegionCroppedRef.current) {
      const chartRegion = chartRegionRef.current;
      if (!chartRegion) throw new Error("The chart region is unavailable.");
      const rect = chartRegion.getBoundingClientRect();
      const scaleX = sourceWidth / window.innerWidth;
      const scaleY = sourceHeight / window.innerHeight;
      sourceX = Math.max(0, Math.round(rect.left * scaleX));
      sourceY = Math.max(0, Math.round(rect.top * scaleY));
      cropWidth = Math.min(sourceWidth - sourceX, Math.max(1, Math.round(rect.width * scaleX)));
      cropHeight = Math.min(sourceHeight - sourceY, Math.max(1, Math.round(rect.height * scaleY)));
    }

    const outputScale = Math.min(1, 1600 / cropWidth);
    canvas.width = Math.max(1, Math.round(cropWidth * outputScale));
    canvas.height = Math.max(1, Math.round(cropHeight * outputScale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not capture the chart frame.");
    context.drawImage(
      video,
      sourceX,
      sourceY,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.88);
    });
    if (!blob) throw new Error("The browser could not encode the chart frame.");
    return blob;
  }

  async function askWsaGlobal() {
    const message = question.trim();
    if (!message || assistantLoading) return;

    setAssistantLoading(true);
    setAssistantError("");
    setAnswer("");
    try {
      if (captureEnabled && !streamRef.current) {
        const shareStarted = await startChartShare();
        if (!shareStarted) return;
      }

      const form = new FormData();
      form.set("message", message);
      form.set("symbol", selectedSymbolLabel);
      form.set("timeframe", timeframe);
      if (accountId) form.set("accountId", accountId);
      if (streamRef.current) {
        form.set("chartImage", await captureChartFrame(), "tradingview-chart.jpg");
      }

      const response = await fetch("/api/ai/chart-assistant", {
        method: "POST",
        body: form,
      });
      const json = await response.json();
      if (!json.ok) {
        setAssistantError(json.error?.message ?? `${BRAND_NAME} chart assistance is unavailable.`);
        return;
      }
      setAnswer(json.data.message);
    } catch (error) {
      setAssistantError(
        error instanceof Error ? error.message : "Network error while contacting the chart assistant.",
      );
    } finally {
      setAssistantLoading(false);
    }
  }

  const visionStatus = chartShared
    ? "Live chart shared"
    : captureEnabled
      ? captureSupported
        ? "Ready to share"
        : "Browser unsupported"
      : "Context only";

  return (
    <section className="section-surface overflow-hidden">
      <video ref={videoRef} playsInline className="pointer-events-none fixed h-px w-px opacity-0" />

      <div className="flex flex-col items-start justify-between gap-4 border-b border-line px-4 py-4 sm:flex-row sm:flex-wrap sm:px-5 sm:py-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="status-pill px-3 py-1 text-xs">{selectedSymbolLabel}</span>
            <span className="text-xs font-medium text-muted">TradingView live chart</span>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
            <h3 className="text-lg font-semibold text-foreground">Advanced chart</h3>
            <p className="text-sm text-muted">TradingView market chart embedded for live visual analysis.</p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          <label className="sr-only" htmlFor="trading-chart-symbol">
            Chart symbol
          </label>
          <select
            id="trading-chart-symbol"
            value={selectedSymbol}
            onChange={(event) => onSettingsChange({ symbol: event.target.value })}
            className="h-9 min-w-36 rounded-[4px] border border-line bg-background px-3 text-xs font-semibold text-foreground outline-none transition focus:border-accent"
          >
            {symbolOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="invisible-scrollbar flex max-w-full flex-nowrap gap-2 overflow-x-auto sm:flex-wrap">
            {TERMINAL_TIMEFRAMES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onSettingsChange({ timeframe: item })}
                aria-pressed={timeframe === item}
                className={`btn-dark h-9 px-4 text-xs ${timeframe === item ? "btn-active" : ""}`}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2" role="group" aria-label="Chart panels">
          {PANEL_TOGGLES.map((toggle) => (
            <button
              key={toggle.key}
              type="button"
              title={toggle.hint}
              aria-pressed={panels[toggle.key]}
              onClick={() => {
                const next: Partial<TradingViewPanels> = {};
                next[toggle.key] = !panels[toggle.key];
                onSettingsChange({ panels: next });
              }}
              className={`btn-dark text-xs ${panels[toggle.key] ? "btn-active" : ""}`}
            >
              {toggle.label}
            </button>
          ))}
          <button
            type="button"
            aria-expanded={editorOpen}
            onClick={() => setEditorOpen((open) => !open)}
            className={`btn-dark text-xs ${editorOpen ? "btn-active" : ""}`}
          >
            <ListChecks className="h-4 w-4" aria-hidden="true" />
            Edit watchlist
          </button>
          <button
            type="button"
            aria-expanded={optionsOpen}
            onClick={() => setOptionsOpen((open) => !open)}
            className={`btn-dark text-xs ${optionsOpen ? "btn-active" : ""}`}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            Chart options
          </button>
          <a
            href={tradingViewChartUrl(tvSymbol, tvInterval)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-dark text-xs"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open on TradingView
          </a>
        </div>
      </div>

      {optionsOpen ? (
        <TradingViewOptionsPanel chart={chart} onChange={(patch) => onSettingsChange({ chart: patch })} />
      ) : null}

      {editorOpen ? (
        <TradingViewWatchlistEditor
          watchlist={watchlist}
          activeSymbol={selectedSymbol}
          onChange={(next) => onSettingsChange({ watchlist: next })}
          onSelect={(symbol) => onSettingsChange({ symbol })}
        />
      ) : null}

      <div className="px-3 py-3 sm:px-5 sm:py-5">
        <div className="relative w-full">
          <div ref={chartRegionRef}>
            <TradingViewAdvancedChart
              symbol={tvSymbol}
              interval={tvInterval}
              height={chartHeight}
              watchlist={watchlist}
              panels={panels}
              chart={chart}
            />
          </div>
          <button
            type="button"
            onClick={() => setAssistantOpen((open) => !open)}
            className="absolute bottom-3 right-3 inline-flex min-h-11 max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-[5px] border border-accent/40 bg-background/95 px-3 text-sm font-semibold text-accent transition hover:bg-panel sm:bottom-4 sm:right-4 sm:px-4"
          >
            <MessageSquare className="h-4 w-4" />
            {ASK_ASSISTANT_LABEL}
          </button>
        </div>

        <details className="mt-3 text-xs leading-5 text-muted">
          <summary className="flex cursor-pointer items-center gap-2 font-semibold text-foreground/80 hover:text-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Why can&apos;t I sign in to my TradingView account here?
          </summary>
          <div className="mt-2 max-w-3xl space-y-2">
            <p>
              TradingView does not allow other websites to show its sign-in page, so your TradingView account - saved
              layouts, alerts and personal watchlists - cannot be opened inside this chart. What you see is
              TradingView&apos;s free embedded chart: live prices, the drawing tools and indicators, and the
              watchlist you keep here in WSA. Drawings made here are not stored in a TradingView account.
            </p>
            <p>
              For your own TradingView layouts and alerts use <strong>Open on TradingView</strong> (new tab). Both
              can stay open next to each other.
            </p>
            <p>
              <strong className="text-foreground/90">Your own Pine scripts</strong> cannot be loaded into this chart.
              TradingView runs Pine only on tradingview.com; every embedded chart (this free one and the licensed
              libraries brokers use) offers its built-in indicators and nothing else. Pick them under{" "}
              <strong>Chart options</strong> - they are saved in your WSA profile and come back every time. Open your
              scripts on tradingview.com with the button above; the symbol and the time frame you have here are
              passed on.
            </p>
          </div>
        </details>
      </div>

      {assistantOpen ? (
        <div className="border-t border-line px-4 py-4 sm:px-5 sm:py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-foreground">{ASK_ASSISTANT_LABEL} about this chart</h4>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
                {chartShared
                  ? `${AI_ASSISTANT_NAME} will capture the visible ${selectedSymbolLabel} ${timeframe} chart when you ask. The frame is processed for this answer and is not stored.`
                  : captureEnabled
                    ? `When you ask, choose this browser tab. ${AI_ASSISTANT_NAME} will capture the TradingView region and review the visible candles.`
                    : `Uses ${selectedSymbolLabel}, timeframe, selected-account metrics, recent trades, and news. Live chart capture is disabled on this deployment.`}
              </p>
            </div>
            <span className="rounded-[4px] border border-line bg-background px-3 py-1 text-xs font-semibold text-muted">
              {visionStatus}
            </span>
          </div>

          {captureCapabilityLoaded && captureEnabled ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {chartShared ? (
                <button type="button" onClick={stopChartShare} className="btn-dark min-h-10 px-4 text-xs">
                  <ScreenShareOff className="h-4 w-4" />
                  Stop sharing
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void startChartShare()}
                  disabled={!captureSupported || shareLoading}
                  className="inline-flex min-h-10 items-center gap-2 rounded-[4px] bg-accent px-4 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {shareLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScreenShare className="h-4 w-4" />}
                  {shareLoading ? "Starting…" : "Share live chart"}
                </button>
              )}
              <p className="text-xs text-muted">
                Select <strong className="text-foreground">This Tab</strong> in the browser prompt.
              </p>
            </div>
          ) : null}

          <form
            className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void askWsaGlobal();
            }}
          >
            <label className="grid flex-1 gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              Question
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={2000}
                rows={2}
                placeholder={`Review the visible ${selectedSymbolLabel} structure, key zones, and invalidation risk.`}
                className="min-h-[54px] resize-none rounded-[4px] border border-line bg-background px-4 py-3 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-accent"
              />
            </label>
            <button
              type="submit"
              disabled={assistantLoading || question.trim().length === 0 || (captureEnabled && !captureSupported)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[4px] bg-accent px-4 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              {assistantLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {assistantLoading ? "Analyzing…" : chartShared ? "Review chart" : ASK_ASSISTANT_LABEL}
            </button>
          </form>
          {assistantError ? (
            <div className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
              {assistantError}
            </div>
          ) : null}
          {answer ? (
            <div className="mt-4 whitespace-pre-wrap rounded-[4px] border border-line bg-background px-4 py-4 text-sm leading-6 text-foreground/90">
              {answer}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
