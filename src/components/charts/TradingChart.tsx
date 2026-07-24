"use client";

import { useEffect, useRef, useState } from "react";
import {
  Eye,
  Loader2,
  ScreenShare,
  ScreenShareOff,
  Send,
  Sparkles,
} from "lucide-react";
import { motion } from "framer-motion";
import {
  TradingViewAdvancedChart,
  TRADING_VIEW_SYMBOLS,
} from "@/components/trading/TradingViewAdvancedChart";
import { AI_ASSISTANT_NAME, ASK_ASSISTANT_LABEL, BRAND_NAME } from "@/lib/brand";

type Timeframe = "1m" | "5m" | "15m" | "1H" | "4H" | "1D";
type CropTargetConstructor = { fromElement(element: Element): Promise<unknown> };
type CroppableTrack = MediaStreamTrack & { cropTo?: (target: unknown) => Promise<void> };

const timeframes: Timeframe[] = ["1m", "5m", "15m", "1H", "4H", "1D"];

const INTERVAL_MAP: Record<Timeframe, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1H": "60",
  "4H": "240",
  "1D": "D",
};

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

export function TradingChart({ accountId }: { accountId?: string }) {
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
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

  const tvSymbol = TRADING_VIEW_SYMBOLS.XAUUSD;
  const tvInterval = INTERVAL_MAP[timeframe];
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
      form.set("symbol", "XAUUSD");
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
    <motion.section layout className="section-surface overflow-hidden">
      <video ref={videoRef} playsInline className="pointer-events-none fixed h-px w-px opacity-0" />

      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="status-pill px-3 py-1 text-xs">XAUUSD</span>
            <span className="text-xs font-medium text-muted">TradingView live chart</span>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
            <h3 className="text-lg font-semibold text-foreground">Advanced chart</h3>
            <p className="text-sm text-muted">TradingView market chart embedded for live visual analysis.</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {timeframes.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTimeframe(item)}
              className={`btn-dark h-9 px-4 text-xs ${timeframe === item ? "btn-active" : ""}`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="grid items-stretch gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1.8fr)_minmax(300px,0.7fr)]">
        <div className="relative">
          <div ref={chartRegionRef}>
            <TradingViewAdvancedChart
              symbol={tvSymbol}
              interval={tvInterval}
              height="520px"
              theme="dark"
              allowSymbolChange={false}
            />
          </div>
          <button
            type="button"
            onClick={() => setAssistantOpen((open) => !open)}
            className="absolute bottom-4 right-4 inline-flex min-h-11 items-center gap-2 rounded-[5px] border border-accent/40 bg-background/95 px-4 text-sm font-semibold text-accent transition hover:bg-panel"
          >
            <Sparkles className="h-4 w-4" />
            {ASK_ASSISTANT_LABEL}
          </button>
        </div>

        <div className="invisible-scrollbar flex min-h-0 flex-col overflow-y-auto border border-line bg-background">
          <div className="border-b border-line p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted">Data source</p>
            <div className="mt-3 flex items-center gap-3">
              <span className="inline-flex h-3 w-3 rounded-full bg-accent" />
              <div>
                <p className="text-sm font-semibold text-foreground">TradingView</p>
                <p className="text-xs text-muted">Live market data via embedded widget.</p>
              </div>
            </div>
          </div>

          <div className="border-b border-line p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted">{AI_ASSISTANT_NAME} chart vision</p>
            <div className="mt-3 flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[4px] bg-accent/10 text-accent">
                <Eye className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{visionStatus}</p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  {chartShared
                    ? `${AI_ASSISTANT_NAME} captures only this chart region when you ask.`
                    : `No trend is claimed until ${AI_ASSISTANT_NAME} receives a chart frame.`}
                </p>
              </div>
            </div>
          </div>

          <div className="p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted">Chart controls</p>
            <p className="mt-3 text-sm leading-6 text-muted">
              Symbol is locked to XAUUSD so the chart and {AI_ASSISTANT_NAME} stay aligned. Use the timeframe controls above.
            </p>
          </div>
        </div>
      </div>

      {assistantOpen ? (
        <div className="border-t border-line px-5 py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-foreground">{ASK_ASSISTANT_LABEL} about this chart</h4>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
                {chartShared
                  ? `${AI_ASSISTANT_NAME} will capture the visible XAUUSD ${timeframe} chart when you ask. The frame is processed for this answer and is not stored.`
                  : captureEnabled
                    ? `When you ask, choose this browser tab. ${AI_ASSISTANT_NAME} will capture the TradingView region and review the visible candles.`
                    : "Uses XAUUSD, timeframe, selected-account metrics, recent trades, and news. Live chart capture is disabled on this deployment."}
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
                placeholder="Review the visible structure, key zones, and invalidation risk."
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
    </motion.section>
  );
}
