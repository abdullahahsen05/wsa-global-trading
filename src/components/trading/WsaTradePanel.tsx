"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Minus,
  Plus,
  RotateCw,
  Settings2,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  newRequestId,
  requestFastRefresh,
  sendWebTrade,
  useWarmWebTradeRoutes,
  useWebTradeAccounts,
  useWebTradeHistory,
  useWebTradeState,
  useWebTradeSymbols,
  WEB_TRADE_STATE_QUERY_KEY,
  WebTradeRequestError,
  type WebTradeAction,
} from "@/hooks/useWebTrade";
import { BulkBar, PendingCard, PositionCard, type RowEdit } from "@/components/trading/wsaTrade/Book";
import { HistoryTab } from "@/components/trading/wsaTrade/History";
import { SymbolPicker } from "@/components/trading/wsaTrade/SymbolPicker";
import { TradeSettings } from "@/components/trading/wsaTrade/TradeSettings";
import {
  BANNER_CLASS,
  CHIP_CLASS,
  FIELD_CLASS,
  Figure,
  LABEL_CLASS,
  toneClass,
} from "@/components/trading/wsaTrade/ui";
import { coreSymbol, findBrokerSymbol, sameInstrument, toTradingViewSymbol } from "@/lib/trade/symbolMatch";
import {
  breakEvenLevel,
  buildOrderPlan,
  bulkPreview,
  partialLots,
  planToRequest,
  pointsBetween,
  resolveDigits,
  stepLots,
  type OrderPlan,
} from "@/lib/trade/ticketMath";
import { effectiveZoom, isWideLayout, PANEL_ZOOM_MAX, PANEL_ZOOM_MIN, stepZoom, zoomLabel } from "@/lib/trade/panelLayout";
import {
  applyChanges,
  changesFromBulk,
  changesFromClose,
  changesFromModify,
  changesFromOpen,
  OVERLAY_TTL_MS,
  type StateChange,
} from "@/lib/trade/stateOverlay";
import {
  isValidLots,
  levelsProblem,
  pendingLevelsProblem,
  roundLots,
  type WebTradeAccount,
  type WebTradeBulkScope,
  type WebTradeOrderKind,
  type WebTradeOrderResult,
  type WebTradePendingOrder,
  type WebTradePosition,
  type WebTradeRoute,
  type WebTradeSide,
  type WebTradeSymbol,
} from "@/lib/trade/webTrade";
import {
  formatLots,
  formatMoney,
  formatPercent,
  formatPrice,
  formatSigned,
  parseDecimal,
  parseLevelInput,
  resultTone,
  timingHeadline,
  timingText,
} from "@/lib/trade/webTradeFormat";
import {
  DEFAULT_HISTORY_PERIOD,
  LOCAL_ROW_TTL_MS,
  mergeHistory,
  rowFromClose,
  type HistoryPeriodId,
  type WebTradeHistoryRow,
} from "@/lib/trade/webTradeHistory";
import type { WsaTradePatch, WsaTradeWorkspace } from "@/lib/terminal/workspace";

/**
 * WSA Trade: the trade section of the terminal - an order panel that sits to the right of
 * the TradingView chart (or next to / instead of it).
 *
 * The chart is for analysis; this panel is for the trade: pick the symbol (the broker's own
 * names, read from the account), choose market / limit / stop, set the volume and the levels,
 * press Buy or Sell, then manage what is open - move the stop loss, take profit or break-even,
 * close or part-close a position, change or delete a pending order, close several at once.
 * The History tab lists the trades that were closed (a period at a time, with the net result,
 * win rate and best / worst trade); a trade closed from the panel is listed at once.
 * It works for any connected MT4 / MT5 account, with no broker web terminal and no second login.
 *
 * Orders do not go to the broker from the browser or from the web server: they are handed to the
 * WSA trading system (the AWS part that already holds the broker session of every account),
 * which sends them and reports how long it took. Every order passes WSA's gates (subscription,
 * execution switch, risk rules) and is written to the audit log. Only the caller's own accounts
 * are offered. Nothing here touches credentials.
 *
 * A button is the command: Buy, Sell, Close, Delete and "close several" act at once, with no
 * "Confirm" step. What the trading system answered is shown at once on the lists (`stateOverlay`) and
 * the result line says how long it took and where the time went. The panel fits the room it has
 * (zoom "Auto") or the size the person chose with the zoom buttons.
 */

const QUICK_VOLUMES: ReadonlyArray<number> = [0.01, 0.05, 0.1, 0.5, 1];
const MAX_CHIPS = 8;
const EMPTY_POSITIONS: WebTradePosition[] = [];
const EMPTY_PENDING: WebTradePendingOrder[] = [];
const EMPTY_SYMBOLS: WebTradeSymbol[] = [];
const MAX_ACTIVITY = 25;

const ORDER_KINDS: ReadonlyArray<{ id: WebTradeOrderKind; label: string }> = [
  { id: "MARKET", label: "Market" },
  { id: "LIMIT", label: "Limit" },
  { id: "STOP", label: "Stop" },
];

type BookTab = "positions" | "pending" | "history" | "activity";

/** A trade the panel has just closed: kept (with the account it belongs to) until the synced record has it. */
interface ClosedHere {
  accountId: string;
  row: WebTradeHistoryRow;
}

const EMPTY_HISTORY: WebTradeHistoryRow[] = [];

interface Problem {
  message: string;
  /** the request may have reached the broker: check the positions before sending again */
  uncertain: boolean;
}

interface ActivityEntry {
  id: number;
  at: number;
  tone: "ok" | "error";
  text: string;
  /** the whole wait, e.g. "412 ms" */
  headline?: string;
  /** where the time went */
  detail?: string;
}

/** The answer to the last command: what happened, how long it took in all, where the time went. */
interface Notice {
  text: string;
  headline: string;
  detail: string;
}

interface RunOptions {
  /** after a successful answer */
  onDone?: () => void;
  /** what the answer means for the lists; laid over the picture until the real one arrives */
  changes?: (result: WebTradeOrderResult) => StateChange[];
  /** the same order sent again after an answer that never came keeps this id (the server never places it twice) */
  retry?: { key: string; id: string };
  /** the trades this answer closed; they are listed in History at once, until the synced record has them */
  closed?: (result: WebTradeOrderResult) => ClosedHere[];
}

/** How long an order whose answer never came may be re-sent with the same id. */
const RETRY_ID_MS = 90_000;

export interface WsaTradePanelProps {
  settings: WsaTradeWorkspace;
  onSettingsChange: (patch: WsaTradePatch) => void;
  /** the pane is on screen: only then is the account polled */
  active: boolean;
  /** the stored workspace has been read, so the account used last is known */
  workspaceLoaded: boolean;
  /** the account selected elsewhere on the platform */
  suggestedAccountId?: string | null;
  /** height of the panel */
  height: string;
  /** the TradingView symbol of the chart next to the panel: when it changes, the panel follows it */
  chartSymbol?: string | null;
  /** the symbols of the chart's own watchlist: they become one-click symbols of the panel */
  chartWatchlist?: ReadonlyArray<string>;
  /** the person picked a symbol in the panel: show it on the chart too */
  onChartSymbol?: (tradingViewSymbol: string) => void;
}

function accountLabel(account: WebTradeAccount): string {
  const parts = [account.name];
  if (account.platform) parts.push(account.platform);
  parts.push(account.broker);
  const label = parts.join(" · ");
  return account.reachable ? label : `${label} (not connected)`;
}

/** The current time in milliseconds, read from event handlers (the render itself must stay pure). */
function currentTimeMs(): number {
  return Date.now();
}

function clock(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-GB");
}

function routeLabel(route: WebTradeRoute | undefined): string {
  if (route === "gateway") return "WSA trading system";
  if (route === "direct") return "Direct";
  if (route === "none") return "Read only";
  return "Connecting";
}

function openSuccess(plan: OrderPlan): string {
  const what = `${formatLots(plan.volume)} ${plan.symbol}`;
  if (plan.kind === "MARKET") return `${plan.side === "BUY" ? "Buy" : "Sell"} ${what} sent to the broker.`;
  return `${plan.side === "BUY" ? "Buy" : "Sell"} ${plan.kind.toLowerCase()} ${what} placed at ${formatPrice(plan.price)}.`;
}

function bulkSuccess(scope: WebTradeBulkScope, result: WebTradeOrderResult): string {
  const done = result.closed ?? 0;
  if (scope === "PENDING") return `${done} pending order${done === 1 ? "" : "s"} deleted.`;
  return `${done} position${done === 1 ? "" : "s"} closed.`;
}

function rulesSummary(settings: WsaTradeWorkspace): string {
  const parts = ["one click"];
  if (settings.requireStopLoss) parts.push("stop loss required");
  if (settings.maxVolume !== null) parts.push(`max ${formatLots(settings.maxVolume)} lots`);
  if (settings.stopLossPoints !== null) parts.push(`SL ${settings.stopLossPoints} pt`);
  if (settings.takeProfitPoints !== null) parts.push(`TP ${settings.takeProfitPoints} pt`);
  return parts.join(" · ");
}

export function WsaTradePanel({
  settings,
  onSettingsChange,
  active,
  workspaceLoaded,
  suggestedAccountId,
  height,
  chartSymbol,
  chartWatchlist,
  onChartSymbol,
}: WsaTradePanelProps) {
  const queryClient = useQueryClient();
  const idPrefix = useId();
  const accountsQuery = useWebTradeAccounts(true);
  const accounts = accountsQuery.data?.accounts;
  const platformGate = accountsQuery.data?.gate ?? null;

  // The account the panel trades: the saved one, else the one selected elsewhere, else the first ready one.
  const reachable = useMemo(() => (accounts ?? []).filter((account) => account.reachable), [accounts]);
  const accountId = useMemo(() => {
    const pick = (id: string | null | undefined) =>
      id && reachable.some((account) => account.accountId === id) ? id : null;
    return pick(settings.accountId) ?? pick(suggestedAccountId) ?? reachable[0]?.accountId ?? null;
  }, [reachable, settings.accountId, suggestedAccountId]);

  const symbol = settings.symbol;
  const kind = settings.orderKind;
  const reading = active && workspaceLoaded;
  const stateQuery = useWebTradeState(accountId, symbol, reading);
  const symbolsQuery = useWebTradeSymbols(accountId, reading);
  // (a hand on the panel renews what an order checks, so the click itself only has to write the command)
  const warmNow = useWarmWebTradeRoutes(reading, accountId);
  // what the trading system has confirmed since the last picture (shown at once, dropped after a few seconds)
  const [changes, setChanges] = useState<StateChange[]>([]);
  // while another account's answer is still on screen it must not be shown as this account's
  const polled = stateQuery.data && stateQuery.data.accountId === accountId ? stateQuery.data : null;
  const state = useMemo(() => (polled ? applyChanges(polled, changes) : null), [polled, changes]);
  const positions = state?.positions ?? EMPTY_POSITIONS;
  const pendingOrders = state?.pending ?? EMPTY_PENDING;

  // ── the room the panel has -> its zoom and whether ticket and lists stand side by side ──
  const sectionRef = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = sectionRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setBox((current) => (current.width === width && current.height === height ? current : { width, height }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const zoom = effectiveZoom(settings.zoom, box.width, box.height);
  const wide = isWideLayout(box.width, zoom);

  // ── the broker's symbols ──────────────────────────────────────────────────
  const brokerSymbols = useMemo(() => {
    const seen = new Set<string>();
    const list: WebTradeSymbol[] = [];
    for (const entry of symbolsQuery.data?.symbols ?? EMPTY_SYMBOLS) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      list.push(entry);
    }
    return list;
  }, [symbolsQuery.data]);
  const brokerNames = useMemo(() => brokerSymbols.map((entry) => entry.name), [brokerSymbols]);
  const symbolInfo = useMemo(
    () =>
      brokerSymbols.find((entry) => entry.name === symbol) ??
      brokerSymbols.find((entry) => entry.name.toLowerCase() === symbol.toLowerCase()) ??
      null,
    [brokerSymbols, symbol],
  );

  /** the price of THIS symbol (an older answer for another symbol must not be shown as its price) */
  const quote = state?.quote && state.quote.symbol.toLowerCase() === symbol.toLowerCase() ? state.quote : null;
  const digits = resolveDigits(symbolInfo?.digits, quote);

  // one-click symbols: the chart's watchlist in the broker's own spelling
  const symbolChips = useMemo(() => {
    const chips: string[] = [];
    for (const entry of chartWatchlist ?? []) {
      const name = brokerNames.length > 0 ? findBrokerSymbol(entry, brokerNames) : coreSymbol(entry);
      if (name && !chips.includes(name)) chips.push(name);
      if (chips.length >= MAX_CHIPS) break;
    }
    return chips;
  }, [chartWatchlist, brokerNames]);

  // The chart shows something this broker does not list: say so instead of leaving the old symbol silently.
  const chartHasNoMatch =
    Boolean(chartSymbol) &&
    brokerNames.length > 0 &&
    !sameInstrument(chartSymbol as string, symbol) &&
    findBrokerSymbol(chartSymbol as string, brokerNames) === null;

  // ── the chart picks a symbol -> the panel follows (never on mount, never from the panel's own change) ──
  const live = useRef({ names: brokerNames, symbol, change: onSettingsChange });
  useEffect(() => {
    live.current = { names: brokerNames, symbol, change: onSettingsChange };
  });
  const seenChart = useRef(chartSymbol);
  useEffect(() => {
    if (chartSymbol === seenChart.current) return;
    seenChart.current = chartSymbol;
    if (!chartSymbol) return;
    const { names, symbol: current, change } = live.current;
    if (names.length === 0 || sameInstrument(chartSymbol, current)) return;
    const match = findBrokerSymbol(chartSymbol, names);
    if (match && match !== current) change({ symbol: match });
  }, [chartSymbol]);

  // ── the ticket (drafts follow the saved settings when those change) ───────
  const [syncedVolume, setSyncedVolume] = useState(settings.volume);
  const [volumeDraft, setVolumeDraft] = useState(formatLots(settings.volume));
  if (settings.volume !== syncedVolume) {
    setSyncedVolume(settings.volume);
    setVolumeDraft(formatLots(settings.volume));
  }
  const [priceDraft, setPriceDraft] = useState("");
  const [stopLossDraft, setStopLossDraft] = useState("");
  const [takeProfitDraft, setTakeProfitDraft] = useState("");

  const [rowEdit, setRowEdit] = useState<RowEdit | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [tab, setTab] = useState<BookTab>("positions");
  const [historyPeriod, setHistoryPeriod] = useState<HistoryPeriodId>(DEFAULT_HISTORY_PERIOD);
  const [closedHere, setClosedHere] = useState<ClosedHere[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const activityId = useRef(0);
  const overlayTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = overlayTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  // an order whose answer never came: sent again, it keeps its id, so it can never be placed twice
  const retryId = useRef<{ key: string; id: string; at: number } | null>(null);

  // ── History: the closed trades of the account (read only while that tab is open) ──
  const historyQuery = useWebTradeHistory(accountId, historyPeriod, tab === "history" && reading);
  const syncedHistory = historyQuery.data && historyQuery.data.accountId === accountId ? historyQuery.data : null;
  const historyRows = useMemo(() => {
    if (!syncedHistory) return EMPTY_HISTORY;
    const mine = closedHere.filter((entry) => entry.accountId === accountId).map((entry) => entry.row);
    return mergeHistory(syncedHistory.rows, mine, syncedHistory.since);
  }, [syncedHistory, closedHere, accountId]);

  const readOnly = Boolean(state?.readOnly);
  const canOpen = Boolean(platformGate?.canOpen) && !state?.riskBlocked && !readOnly;
  const canManage = Boolean(platformGate?.canManage) && !readOnly;
  const gateMessage = platformGate && !platformGate.canManage ? platformGate.message : null;
  const route = state?.route ?? accountsQuery.data?.route;
  const lane = state?.lane;
  const laneNote = state?.laneNote ?? null;

  function dropTransient() {
    setFormError(null);
  }

  function selectSymbol(name: string) {
    dropTransient();
    onSettingsChange({ symbol: name });
    const chart = toTradingViewSymbol(name);
    if (chart && onChartSymbol && !(chartSymbol && sameInstrument(chart, chartSymbol))) onChartSymbol(chart);
  }

  function selectKind(next: WebTradeOrderKind) {
    dropTransient();
    if (next !== kind) onSettingsChange({ orderKind: next });
  }

  function commitVolume(text: string) {
    const parsed = parseDecimal(text);
    if (parsed === null || !isValidLots(parsed)) {
      setVolumeDraft(formatLots(settings.volume));
      return;
    }
    setVolumeDraft(formatLots(parsed));
    if (parsed !== settings.volume) onSettingsChange({ volume: parsed });
  }

  function stepVolume(direction: 1 | -1) {
    dropTransient();
    const current = parseDecimal(volumeDraft);
    commitVolume(String(stepLots(current !== null && isValidLots(current) ? current : settings.volume, direction)));
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: [WEB_TRADE_STATE_QUERY_KEY, accountId] });
  }

  function log(tone: ActivityEntry["tone"], text: string, headline = "", detail = "") {
    activityId.current += 1;
    const entry: ActivityEntry = { id: activityId.current, at: currentTimeMs(), tone, text, headline, detail };
    setActivity((current) => [entry, ...current].slice(0, MAX_ACTIVITY));
  }

  /** Lays what the answer meant over the lists until the real picture has caught up. */
  function remember(list: StateChange[]) {
    if (list.length === 0) return;
    setChanges((current) => [...current, ...list]);
    const timer = setTimeout(() => {
      overlayTimers.current.delete(timer);
      setChanges((current) => current.filter((entry) => !list.includes(entry)));
    }, OVERLAY_TTL_MS);
    overlayTimers.current.add(timer);
  }

  /** Keeps the trades an answer closed for the History list, until the synced record has them (or a few minutes have passed). */
  function rememberClosed(list: ClosedHere[]) {
    if (list.length === 0) return;
    setClosedHere((current) => [...list, ...current].slice(0, 100));
    const timer = setTimeout(() => {
      overlayTimers.current.delete(timer);
      setClosedHere((current) => current.filter((entry) => !list.includes(entry)));
    }, LOCAL_ROW_TTL_MS);
    overlayTimers.current.add(timer);
  }

  /** The id an order is sent with: the one of the attempt whose answer never came, if this is the same order again. */
  function idFor(key: string): { key: string; id: string } {
    const kept = retryId.current;
    if (kept && kept.key === key && currentTimeMs() - kept.at < RETRY_ID_MS) return { key, id: kept.id };
    return { key, id: newRequestId() };
  }

  /**
   * One request at a time. The answer is shown at once on the lists; the account is read again
   * straight away - also after a failure (it may have gone through) - and every 400 ms for the next
   * few seconds, until the trading system's own picture has caught up.
   */
  async function run(
    action: WebTradeAction,
    body: Record<string, unknown>,
    success: string | ((result: WebTradeOrderResult) => string),
    options: RunOptions = {},
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const result = await sendWebTrade(action, body);
      if (options.retry && retryId.current?.key === options.retry.key) retryId.current = null;
      const base = result.repeated
        ? "This order had already been sent - nothing was sent twice."
        : typeof success === "function"
          ? success(result)
          : success;
      const headline = result.repeated ? "" : timingHeadline(result.timing);
      const detail = result.repeated ? "" : timingText(result.timing);
      setNotice({ text: base, headline, detail });
      log("ok", base, headline, detail);
      if (!result.repeated && options.changes) remember(options.changes(result));
      if (!result.repeated && options.closed) rememberClosed(options.closed(result));
      if (result.failed && result.failed > 0) {
        const failures = (result.failures ?? [])
          .slice(0, 3)
          .map((failure) => `${failure.symbol} ${failure.ticket}: ${failure.message}`)
          .join("; ");
        const message = `${result.failed} could not be handled${failures ? ` - ${failures}` : ""}.`;
        setProblem({ message, uncertain: false });
        log("error", message);
      }
      options.onDone?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The request failed.";
      const uncertain = error instanceof WebTradeRequestError ? error.uncertain : false;
      if (uncertain && options.retry) retryId.current = { ...options.retry, at: currentTimeMs() };
      setProblem({ message, uncertain });
      log("error", message);
    } finally {
      busyRef.current = false;
      setBusy(false);
      requestFastRefresh();
      refresh();
    }
  }

  // ── new orders: Buy / Sell send the order at once ─────────────────────────
  function sendPlan(plan: OrderPlan) {
    if (!accountId) return;
    const request = planToRequest(plan);
    const attempt = idFor(JSON.stringify([accountId, request]));
    void run("open", { accountId, ...request, clientRequestId: attempt.id }, openSuccess(plan), {
      retry: attempt,
      changes: (result) => changesFromOpen(accountId, result, request, quote),
      onDone: () => {
        setPriceDraft("");
        // a distance in points can be reused for the next order; a price cannot
        if (settings.levelMode === "price") {
          setStopLossDraft("");
          setTakeProfitDraft("");
        }
      },
    });
  }

  function startOrder(side: WebTradeSide) {
    setFormError(null);
    setProblem(null);
    setNotice(null);
    const result = buildOrderPlan({
      side,
      kind,
      symbol,
      volumeText: volumeDraft,
      priceText: priceDraft,
      stopLossText: stopLossDraft,
      takeProfitText: takeProfitDraft,
      levelMode: settings.levelMode,
      defaultStopLossPoints: settings.stopLossPoints,
      defaultTakeProfitPoints: settings.takeProfitPoints,
      quote,
      digits: symbolInfo?.digits ?? null,
      rules: { requireStopLoss: settings.requireStopLoss, maxVolume: settings.maxVolume },
    });
    if (!result.ok) return setFormError(result.message);
    sendPlan(result.plan);
  }

  // ── positions ─────────────────────────────────────────────────────────────
  function openEditor(edit: RowEdit) {
    setProblem(null);
    setNotice(null);
    setFormError(null);
    setRowEdit(edit);
  }

  function startLevels(position: WebTradePosition) {
    openEditor({
      kind: "levels",
      ticket: position.ticket,
      stopLoss: position.stopLoss === null ? "" : formatPrice(position.stopLoss),
      takeProfit: position.takeProfit === null ? "" : formatPrice(position.takeProfit),
    });
  }

  /** Closes the position, or only `lots` of it, at once. */
  function closeNow(position: WebTradePosition, lots: number | null) {
    if (!accountId) return;
    const partial = lots !== null && roundLots(lots) < roundLots(position.volume);
    void run(
      "close",
      { accountId, ticket: position.ticket, ...(partial ? { volume: lots } : {}) },
      partial ? `${formatLots(lots)} lots of ${position.symbol} closed.` : `${position.symbol} position closed.`,
      {
        onDone: () => setRowEdit(null),
        changes: (result) => changesFromClose(accountId, result, position, partial ? lots : null),
        // (a whole close is a closed trade at once; the part of a partial close gets its own record from the broker)
        closed: (result) =>
          partial
            ? []
            : [{ accountId, row: rowFromClose(position, result.detail?.fillPrice, new Date(currentTimeMs()).toISOString()) }],
      },
    );
  }

  function startPartial(position: WebTradePosition) {
    openEditor({
      kind: "close",
      ticket: position.ticket,
      lots: formatLots(partialLots(position.volume, 0.5) ?? position.volume),
    });
  }

  function submitClose(position: WebTradePosition, edit: Extract<RowEdit, { kind: "close" }>) {
    const lots = parseDecimal(edit.lots);
    if (lots === null || !isValidLots(lots)) {
      return setProblem({ message: "Enter how many lots to close (at most 3 decimals).", uncertain: false });
    }
    if (roundLots(lots) > roundLots(position.volume)) {
      return setProblem({ message: `The position has ${formatLots(position.volume)} lots open.`, uncertain: false });
    }
    closeNow(position, lots);
  }

  function saveLevels(position: WebTradePosition, edit: Extract<RowEdit, { kind: "levels" }>) {
    if (!accountId) return;
    const stopLoss = parseLevelInput(edit.stopLoss);
    const takeProfit = parseLevelInput(edit.takeProfit);
    if (stopLoss === "invalid" || takeProfit === "invalid") {
      return setProblem({ message: "Stop loss and take profit must be prices above zero.", uncertain: false });
    }
    // only what changed is sent; an emptied field removes the level
    const patch: { stopLoss?: number | null; takeProfit?: number | null } = {};
    if (stopLoss !== position.stopLoss) patch.stopLoss = stopLoss;
    if (takeProfit !== position.takeProfit) patch.takeProfit = takeProfit;
    if (patch.stopLoss === undefined && patch.takeProfit === undefined) {
      return setProblem({ message: "Stop loss and take profit are unchanged.", uncertain: false });
    }
    const mismatch = levelsProblem(position.side, stopLoss, takeProfit);
    if (mismatch) return setProblem({ message: mismatch, uncertain: false });
    void run("modify", { accountId, ticket: position.ticket, ...patch }, `Stop loss / take profit of ${position.symbol} updated.`, {
      onDone: () => setRowEdit(null),
      changes: (result) => changesFromModify(accountId, position.ticket, result, patch),
    });
  }

  function breakEven(position: WebTradePosition) {
    const level = breakEvenLevel(position);
    if (!accountId || level === null) return;
    void run(
      "modify",
      { accountId, ticket: position.ticket, stopLoss: level },
      `Stop loss of ${position.symbol} moved to the entry price ${formatPrice(level)}.`,
      { changes: (result) => changesFromModify(accountId, position.ticket, result, { stopLoss: level }) },
    );
  }

  // ── pending orders ────────────────────────────────────────────────────────
  function startPendingEdit(pending: WebTradePendingOrder) {
    openEditor({
      kind: "pending",
      ticket: pending.ticket,
      price: formatPrice(pending.price),
      stopLoss: pending.stopLoss === null ? "" : formatPrice(pending.stopLoss),
      takeProfit: pending.takeProfit === null ? "" : formatPrice(pending.takeProfit),
    });
  }

  function savePending(pending: WebTradePendingOrder, edit: Extract<RowEdit, { kind: "pending" }>) {
    if (!accountId) return;
    const price = parseLevelInput(edit.price);
    const stopLoss = parseLevelInput(edit.stopLoss);
    const takeProfit = parseLevelInput(edit.takeProfit);
    if (price === null || price === "invalid") {
      return setProblem({ message: "Enter the price the order waits for (a number above zero).", uncertain: false });
    }
    if (stopLoss === "invalid" || takeProfit === "invalid") {
      return setProblem({ message: "Stop loss and take profit must be prices above zero.", uncertain: false });
    }
    const patch: { price?: number; stopLoss?: number | null; takeProfit?: number | null } = {};
    if (price !== pending.price) patch.price = price;
    if (stopLoss !== pending.stopLoss) patch.stopLoss = stopLoss;
    if (takeProfit !== pending.takeProfit) patch.takeProfit = takeProfit;
    if (patch.price === undefined && patch.stopLoss === undefined && patch.takeProfit === undefined) {
      return setProblem({ message: "The order is unchanged.", uncertain: false });
    }
    const mismatch = pendingLevelsProblem(pending.side, price, stopLoss, takeProfit);
    if (mismatch) return setProblem({ message: mismatch, uncertain: false });
    void run("modify", { accountId, ticket: pending.ticket, ...patch }, `Pending order ${pending.symbol} ${pending.ticket} updated.`, {
      onDone: () => setRowEdit(null),
      changes: (result) => changesFromModify(accountId, pending.ticket, result, patch),
    });
  }

  /** Deletes the pending order at once. */
  function cancelNow(pending: WebTradePendingOrder) {
    if (!accountId) return;
    void run("cancel", { accountId, ticket: pending.ticket }, `Pending order ${pending.symbol} ${pending.ticket} deleted.`, {
      onDone: () => setRowEdit(null),
      changes: () => [{ kind: "removed", accountId, ticket: pending.ticket }],
    });
  }

  // ── several at once: a chip is the command ────────────────────────────────
  function runBulk(scope: WebTradeBulkScope) {
    if (!accountId) return;
    const symbolFilter = scope === "SYMBOL" ? symbol : null;
    const targets = bulkPreview(scope, symbolFilter, positions, pendingOrders);
    if (targets.positions.length + targets.pending.length === 0) return;
    const attempt = idFor(JSON.stringify([accountId, scope, symbolFilter]));
    void run(
      "close-bulk",
      { accountId, scope, symbol: symbolFilter, clientRequestId: attempt.id },
      (result) => bulkSuccess(scope, result),
      {
        retry: attempt,
        changes: (result) => changesFromBulk(accountId, result, targets),
        closed: (result) => {
          // Reuse the guarded bulk result: a capped failures list or a changed broker position list does not
          // prove which tickets closed. Never show an unconfirmed position as closed in History.
          const confirmed = new Set(
            changesFromBulk(accountId, result, targets)
              .filter((change) => change.kind === "closed")
              .map((change) => change.ticket),
          );
          const closedAt = new Date(currentTimeMs()).toISOString();
          return targets.positions
            .filter((entry) => confirmed.has(entry.ticket))
            .map((entry) => ({ accountId, row: rowFromClose(entry, null, closedAt) }));
        },
        onDone: () => setRowEdit(null),
      },
    );
  }

  // ── render ────────────────────────────────────────────────────────────────
  const selectedAccount = (accounts ?? []).find((account) => account.accountId === accountId) ?? null;
  const currency = state?.currency ?? selectedAccount?.currency ?? "USD";
  const loadingAccounts = accountsQuery.isPending;
  const noAccounts = accountsQuery.isSuccess && reachable.length === 0;
  const stateError = stateQuery.isError && !state ? stateQuery.error.message : null;
  const ticketOff = !canOpen || busy;
  const symbolsLoading = symbolsQuery.isPending && accountId !== null && reading;
  const spreadPoints = quote ? pointsBetween(quote.ask, quote.bid, digits) : null;
  const pricing = kind !== "MARKET";
  const levelUnit = settings.levelMode === "points" ? "points" : "price";
  const slPlaceholder = settings.stopLossPoints !== null ? `default ${settings.stopLossPoints} pt` : "none";
  const tpPlaceholder = settings.takeProfitPoints !== null ? `default ${settings.takeProfitPoints} pt` : "none";
  const pendingCount = Math.max(pendingOrders.length, state?.pendingOrders ?? 0);

  return (
    <section
      ref={sectionRef}
      aria-label="WSA Trade"
      className="section-surface flex flex-col overflow-hidden"
      style={{ height }}
      onPointerMove={warmNow}
      onPointerDownCapture={warmNow}
      onFocusCapture={warmNow}
      onKeyDownCapture={warmNow}
    >
      {/* the title bar keeps its size whatever the zoom, so the zoom buttons are always in reach */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">WSA Trade</h3>
          <span className="status-pill px-2 py-0.5 text-[10px]">{selectedAccount?.platform ?? "MT4 / MT5"}</span>
          <span
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted"
            title="Where orders run: the WSA trading system holds the broker session of the account and sends them"
          >
            <Zap className="h-3 w-3" aria-hidden="true" />
            {routeLabel(route)}
          </span>
          {lane ? (
            <span
              className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                lane === "direct"
                  ? "border-accent-2/60 bg-accent-2/10 text-accent-2"
                  : laneNote
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-line text-muted"
              }`}
              title={
                lane === "direct"
                  ? "Orders go straight to the trading system in one signed, encrypted request - no database in between."
                  : laneNote
                    ? `Orders go through the database queue (slower). ${laneNote}`
                    : "Orders go through the trading system's queue (the database)."
              }
            >
              {lane === "direct" ? "Direct" : laneNote ? "Standard · direct paused" : "Standard"}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted" aria-live="polite">
            {state ? `Live · updated ${clock(state.fetchedAt)}` : "Broker connection"}
          </span>
          <div role="group" aria-label="Panel size" className="flex items-center gap-1">
            <button
              type="button"
              className={CHIP_CLASS}
              disabled={zoom <= PANEL_ZOOM_MIN}
              onClick={() => onSettingsChange({ zoom: stepZoom(zoom, -1) })}
              aria-label="Make the panel smaller"
              title="Make the panel smaller"
            >
              <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${CHIP_CLASS} min-w-[3.25rem] tabular-nums`}
              onClick={() => onSettingsChange({ zoom: null })}
              aria-label={
                settings.zoom === null
                  ? `Panel size: fits automatically (${zoomLabel(zoom)})`
                  : `Panel size ${zoomLabel(zoom)} - click to fit automatically`
              }
              title={settings.zoom === null ? "Fits the room the panel has" : "Click to fit the room the panel has"}
            >
              {settings.zoom === null ? `Auto ${zoomLabel(zoom)}` : zoomLabel(zoom)}
            </button>
            <button
              type="button"
              className={CHIP_CLASS}
              disabled={zoom >= PANEL_ZOOM_MAX}
              onClick={() => onSettingsChange({ zoom: stepZoom(zoom, 1) })}
              aria-label="Make the panel larger"
              title="Make the panel larger"
            >
              <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {/* everything below is scaled by the zoom: the layout is worked out for the zoomed size */}
      <div className="flex min-h-0 flex-1 flex-col" style={zoom === 1 ? undefined : { zoom }}>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <label className="sr-only" htmlFor={`${idPrefix}-account`}>
            Account to trade
          </label>
          <select
            id={`${idPrefix}-account`}
            value={accountId ?? ""}
            disabled={loadingAccounts || (accounts ?? []).length === 0}
            onChange={(event) => {
              setRowEdit(null);
              setProblem(null);
              setNotice(null);
              onSettingsChange({ accountId: event.target.value || null });
            }}
            className={`${FIELD_CLASS} min-w-0 flex-1`}
          >
            {loadingAccounts ? <option value="">Loading accounts…</option> : null}
            {accountsQuery.isSuccess && (accounts ?? []).length === 0 ? <option value="">No account yet</option> : null}
            {(accounts ?? []).map((account) => (
              <option key={account.accountId} value={account.accountId} disabled={!account.reachable}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-dark text-xs"
            onClick={refresh}
            disabled={!accountId || stateQuery.isFetching}
            aria-label="Refresh positions"
          >
            {stateQuery.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCw className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={
              wide
                ? "grid grid-cols-[minmax(340px,420px)_minmax(0,1fr)] items-start gap-4 p-4"
                : "space-y-3 p-3"
            }
          >
            {/* ── left: banners, figures, the ticket ── */}
            <div className="space-y-3">
              {accountsQuery.isError ? (
                <p role="alert" className={`${BANNER_CLASS} text-danger`}>
                  {accountsQuery.error.message}
                </p>
              ) : null}
              {noAccounts ? (
                <p role="status" className={`${BANNER_CLASS} text-muted`}>
                  None of your accounts is connected to the broker service yet. Add and connect a trading account under
                  Accounts, then come back here.
                </p>
              ) : null}
              {gateMessage ? (
                <p role="status" className={`${BANNER_CLASS} text-muted`}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {gateMessage}
                </p>
              ) : null}
              {readOnly ? (
                <p role="status" className={`${BANNER_CLASS} text-muted`}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  This account is connected with its read-only (investor) password: you can follow it here but not trade
                  it.
                </p>
              ) : null}
              {state?.riskBlocked && state.riskMessage ? (
                <p role="status" className={`${BANNER_CLASS} text-danger`}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {state.riskMessage}
                </p>
              ) : null}
              {state?.delayed ? (
                <p role="status" className={`${BANNER_CLASS} text-muted`}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  The trading system is slow to answer right now, so the figures below can be a few seconds old.
                </p>
              ) : null}
              {stateError ? (
                <p role="alert" className={`${BANNER_CLASS} text-danger`}>
                  {stateError}
                </p>
              ) : null}

              {accountId ? (
                <>
                  <div className="definition-grid grid grid-cols-3 gap-0" aria-label="Account figures">
                    <Figure label="Balance" value={state ? formatMoney(state.balance, currency) : "-"} />
                    <Figure label="Equity" value={state ? formatMoney(state.equity, currency) : "-"} />
                    <Figure
                      label="Floating P/L"
                      value={state ? formatSigned(state.floatingProfit) : "-"}
                      tone={state ? resultTone(state.floatingProfit) : "flat"}
                    />
                    <Figure label="Margin" value={state ? formatMoney(state.margin, currency) : "-"} />
                    <Figure label="Free margin" value={state ? formatMoney(state.freeMargin, currency) : "-"} />
                    <Figure label="Margin level" value={state ? formatPercent(state.marginLevel) : "-"} />
                  </div>

                  <form
                    onSubmit={(event) => event.preventDefault()}
                    className="space-y-3 rounded-[4px] border border-line bg-background p-3"
                    aria-label="Order ticket"
                  >
                    <SymbolPicker
                      id={`${idPrefix}-symbol`}
                      value={symbol}
                      symbols={brokerSymbols}
                      loading={symbolsLoading}
                      disabled={!accountId}
                      onSelect={selectSymbol}
                    />
                    {symbolChips.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Symbols from your chart watchlist">
                        {symbolChips.map((name) => (
                          <button
                            key={name}
                            type="button"
                            className={`${CHIP_CLASS} ${name === symbol ? "border-accent text-foreground" : ""}`}
                            aria-pressed={name === symbol}
                            onClick={() => selectSymbol(name)}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {symbolsQuery.isError ? (
                      <p className="text-[11px] leading-snug text-muted">
                        The broker&apos;s symbol list could not be loaded - type the symbol the way your broker spells it
                        (for example XAUUSD or EURUSD.m).
                      </p>
                    ) : null}
                    {chartHasNoMatch ? (
                      <p className="text-[11px] leading-snug text-muted" role="status">
                        The chart shows {chartSymbol}, which this broker does not list - choose the symbol here.
                      </p>
                    ) : null}

                    <div role="tablist" aria-label="Order type" className="grid grid-cols-3 gap-1.5">
                      {ORDER_KINDS.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          role="tab"
                          aria-selected={kind === entry.id}
                          onClick={() => selectKind(entry.id)}
                          className={`btn-dark text-xs ${kind === entry.id ? "btn-active" : ""}`}
                        >
                          {entry.label}
                        </button>
                      ))}
                    </div>

                    {pricing ? (
                      <div>
                        <label className={LABEL_CLASS} htmlFor={`${idPrefix}-price`}>
                          Price (entry)
                        </label>
                        <div className="flex gap-1.5">
                          <input
                            id={`${idPrefix}-price`}
                            inputMode="decimal"
                            placeholder="price the order waits for"
                            value={priceDraft}
                            autoComplete="off"
                            onChange={(event) => {
                              dropTransient();
                              setPriceDraft(event.target.value);
                            }}
                            className={FIELD_CLASS}
                          />
                          <button
                            type="button"
                            className={CHIP_CLASS}
                            disabled={!quote}
                            onClick={() => quote && setPriceDraft(formatPrice(quote.bid))}
                            aria-label="Use the bid price"
                          >
                            Bid
                          </button>
                          <button
                            type="button"
                            className={CHIP_CLASS}
                            disabled={!quote}
                            onClick={() => quote && setPriceDraft(formatPrice(quote.ask))}
                            aria-label="Use the ask price"
                          >
                            Ask
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div>
                      <label className={LABEL_CLASS} htmlFor={`${idPrefix}-volume`}>
                        Volume (lots)
                      </label>
                      <div className="flex items-center gap-1.5">
                        <button type="button" className={CHIP_CLASS} onClick={() => stepVolume(-1)} aria-label="Decrease volume">
                          <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <input
                          id={`${idPrefix}-volume`}
                          inputMode="decimal"
                          value={volumeDraft}
                          autoComplete="off"
                          onChange={(event) => {
                            dropTransient();
                            setVolumeDraft(event.target.value);
                          }}
                          onBlur={(event) => commitVolume(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitVolume(volumeDraft);
                            }
                          }}
                          className={`${FIELD_CLASS} text-center`}
                        />
                        <button type="button" className={CHIP_CLASS} onClick={() => stepVolume(1)} aria-label="Increase volume">
                          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Quick</span>
                        {QUICK_VOLUMES.map((lots) => (
                          <button
                            key={lots}
                            type="button"
                            className={CHIP_CLASS}
                            onClick={() => {
                              dropTransient();
                              commitVolume(String(lots));
                            }}
                            aria-label={`Set volume to ${lots} lots`}
                          >
                            {lots}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={LABEL_CLASS} htmlFor={`${idPrefix}-sl`}>
                          {`Stop loss (${levelUnit})`}
                        </label>
                        <input
                          id={`${idPrefix}-sl`}
                          inputMode="decimal"
                          placeholder={slPlaceholder}
                          value={stopLossDraft}
                          autoComplete="off"
                          onChange={(event) => {
                            dropTransient();
                            setStopLossDraft(event.target.value);
                          }}
                          className={FIELD_CLASS}
                        />
                      </div>
                      <div>
                        <label className={LABEL_CLASS} htmlFor={`${idPrefix}-tp`}>
                          {`Take profit (${levelUnit})`}
                        </label>
                        <input
                          id={`${idPrefix}-tp`}
                          inputMode="decimal"
                          placeholder={tpPlaceholder}
                          value={takeProfitDraft}
                          autoComplete="off"
                          onChange={(event) => {
                            dropTransient();
                            setTakeProfitDraft(event.target.value);
                          }}
                          className={FIELD_CLASS}
                        />
                      </div>
                    </div>

                    <p className="text-[11px] leading-snug text-muted" aria-live="polite">
                      {quote
                        ? `Bid ${formatPrice(quote.bid)} · Ask ${formatPrice(quote.ask)} · Spread ${formatPrice(
                            quote.ask - quote.bid,
                          )}${spreadPoints === null ? "" : ` (${spreadPoints} pt)`}`
                        : state
                          ? "No price for this symbol - the order is sent at the market price."
                          : ""}
                    </p>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={ticketOff}
                        onClick={() => startOrder("SELL")}
                        aria-label={`Sell ${symbol}${pricing ? ` ${kind.toLowerCase()}` : " at market"}`}
                        className="rounded-[5px] border border-danger/60 bg-danger/15 px-3 py-2 text-danger transition hover:bg-danger/25 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <span className="block text-[10px] font-semibold uppercase tracking-wide">
                          {pricing ? `Sell ${kind.toLowerCase()}` : "Sell"}
                        </span>
                        <span className="block text-base font-bold tabular-nums">{quote ? formatPrice(quote.bid) : "-"}</span>
                      </button>
                      <button
                        type="button"
                        disabled={ticketOff}
                        onClick={() => startOrder("BUY")}
                        aria-label={`Buy ${symbol}${pricing ? ` ${kind.toLowerCase()}` : " at market"}`}
                        className="rounded-[5px] border border-accent-2/60 bg-accent-2/15 px-3 py-2 text-accent-2 transition hover:bg-accent-2/25 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <span className="block text-[10px] font-semibold uppercase tracking-wide">
                          {pricing ? `Buy ${kind.toLowerCase()}` : "Buy"}
                        </span>
                        <span className="block text-base font-bold tabular-nums">{quote ? formatPrice(quote.ask) : "-"}</span>
                      </button>
                    </div>
                    {formError ? (
                      <p role="alert" className="text-xs text-danger">
                        {formError}
                      </p>
                    ) : null}
                  </form>
                </>
              ) : null}
            </div>

            {/* ── right: the result, positions and orders, the person's rules ── */}
            {accountId ? (
              <div className="space-y-3">
                {problem ? (
                  <p role="alert" className={`${BANNER_CLASS} text-danger`}>
                    {problem.message}
                    {problem.uncertain
                      ? " If you are not sure whether it went through, check the positions below before sending it again."
                      : ""}
                  </p>
                ) : null}
                {notice ? (
                  <div role="status" className={`${BANNER_CLASS} flex-col gap-0.5 text-accent-2`}>
                    <p>
                      {notice.text}
                      {notice.headline ? <strong className="ml-2 font-bold tabular-nums">{notice.headline}</strong> : null}
                    </p>
                    {notice.detail ? <p className="text-[11px] tabular-nums text-muted">{notice.detail}</p> : null}
                  </div>
                ) : null}

                <div role="tablist" aria-label="Positions and orders" className="flex flex-wrap gap-1.5">
                  {(
                    [
                      { id: "positions", label: `Positions${state ? ` (${positions.length})` : ""}` },
                      { id: "pending", label: `Pending${state ? ` (${pendingCount})` : ""}` },
                      { id: "history", label: "History" },
                      { id: "activity", label: "Activity" },
                    ] as const
                  ).map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === entry.id}
                      onClick={() => {
                        setTab(entry.id);
                        setRowEdit(null);
                      }}
                      className={`btn-dark text-xs ${tab === entry.id ? "btn-active" : ""}`}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>

                {tab === "positions" ? (
                  <div className="space-y-2" role="tabpanel" aria-label="Open positions">
                    {!state ? (
                      <p className={`${BANNER_CLASS} text-muted`} role="status">
                        {stateQuery.isError ? "Positions could not be read." : "Reading the account from the broker…"}
                      </p>
                    ) : positions.length === 0 ? (
                      <p className={`${BANNER_CLASS} text-muted`} role="status">
                        No open positions on this account.
                      </p>
                    ) : (
                      <>
                        <BulkBar
                          list="positions"
                          symbol={symbol}
                          positions={positions}
                          pending={pendingOrders}
                          busy={busy}
                          canManage={canManage}
                          onRun={runBulk}
                        />
                        <ul className="space-y-2" aria-label="Open positions">
                          {positions.map((position) => (
                            <PositionCard
                              key={position.ticket}
                              position={position}
                              editing={rowEdit && rowEdit.ticket === position.ticket ? rowEdit : null}
                              busy={busy}
                              canManage={canManage}
                              canBreakEven={breakEvenLevel(position) !== null}
                              onStartLevels={() => startLevels(position)}
                              onClose={() => closeNow(position, null)}
                              onStartPartial={() => startPartial(position)}
                              onBreakEven={() => breakEven(position)}
                              onChange={setRowEdit}
                              onCancelEdit={() => setRowEdit(null)}
                              onSaveLevels={(edit) => saveLevels(position, edit)}
                              onSubmitClose={(edit) => submitClose(position, edit)}
                            />
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                ) : null}

                {tab === "pending" ? (
                  <div className="space-y-2" role="tabpanel" aria-label="Pending orders">
                    {!state ? (
                      <p className={`${BANNER_CLASS} text-muted`} role="status">
                        {stateQuery.isError ? "Orders could not be read." : "Reading the account from the broker…"}
                      </p>
                    ) : pendingCount === 0 ? (
                      <p className={`${BANNER_CLASS} text-muted`} role="status">
                        No pending orders on this account.
                      </p>
                    ) : (
                      <>
                        {pendingOrders.length > 0 ? (
                          <BulkBar
                            list="pending"
                            symbol={symbol}
                            positions={positions}
                            pending={pendingOrders}
                            busy={busy}
                            canManage={canManage}
                            onRun={runBulk}
                          />
                        ) : null}
                        <ul className="space-y-2" aria-label="Pending orders">
                          {pendingOrders.map((pending) => (
                            <PendingCard
                              key={pending.ticket}
                              order={pending}
                              editing={rowEdit && rowEdit.ticket === pending.ticket ? rowEdit : null}
                              busy={busy}
                              canManage={canManage}
                              onStartEdit={() => startPendingEdit(pending)}
                              onDelete={() => cancelNow(pending)}
                              onChange={setRowEdit}
                              onCancelEdit={() => setRowEdit(null)}
                              onSave={(edit) => savePending(pending, edit)}
                            />
                          ))}
                        </ul>
                        {pendingCount > pendingOrders.length ? (
                          <p className="text-[11px] leading-snug text-muted">
                            {pendingCount - pendingOrders.length} more pending order
                            {pendingCount - pendingOrders.length === 1 ? "" : "s"} exist at the broker but could not be
                            read here.
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}

                {tab === "history" ? (
                  <HistoryTab
                    period={historyPeriod}
                    onPeriod={setHistoryPeriod}
                    rows={historyRows}
                    currency={syncedHistory?.currency ?? currency}
                    loading={historyQuery.isPending || (historyQuery.isFetching && !syncedHistory)}
                    error={historyQuery.isError ? historyQuery.error.message : null}
                    truncated={syncedHistory?.truncated ?? false}
                    refreshing={historyQuery.isFetching}
                    onRefresh={() => void historyQuery.refetch()}
                  />
                ) : null}

                {tab === "activity" ? (
                  <div role="tabpanel" aria-label="Activity">
                    {activity.length === 0 ? (
                      <p className={`${BANNER_CLASS} text-muted`} role="status">
                        What you send from this panel is listed here, with how long the trading system took.
                      </p>
                    ) : (
                      <ol className="space-y-1.5" aria-label="Activity">
                        {activity.map((entry) => (
                          <li
                            key={entry.id}
                            className={`rounded-[4px] border border-line bg-background px-3 py-2 text-xs ${
                              entry.tone === "error" ? "text-danger" : toneClass("flat")
                            }`}
                          >
                            <span className="mr-2 tabular-nums text-muted">{new Date(entry.at).toLocaleTimeString("en-GB")}</span>
                            {entry.text}
                            {entry.headline ? <strong className="ml-2 font-bold tabular-nums">{entry.headline}</strong> : null}
                            {entry.detail ? <span className="mt-0.5 block text-[11px] tabular-nums text-muted">{entry.detail}</span> : null}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ) : null}

                <div>
                  <button
                    type="button"
                    aria-expanded={settingsOpen}
                    aria-controls={`${idPrefix}-settings`}
                    onClick={() => setSettingsOpen((open) => !open)}
                    className="flex w-full items-center justify-between gap-3 rounded-[4px] border border-line bg-background px-3 py-2 text-left text-xs font-semibold text-foreground"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Settings2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="shrink-0">Trade settings</span>
                      {!settingsOpen ? (
                        <span className="truncate text-[11px] font-medium text-muted">{rulesSummary(settings)}</span>
                      ) : null}
                    </span>
                    {settingsOpen ? (
                      <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                  </button>
                  {settingsOpen ? (
                    <div id={`${idPrefix}-settings`} className="mt-2">
                      <TradeSettings settings={settings} onChange={onSettingsChange} />
                    </div>
                  ) : null}
                </div>

                <p className="text-[11px] leading-relaxed text-muted">
                  Orders sent here use your connected account, pass the platform&apos;s subscription and risk checks and are
                  recorded in the audit log. Prices come from the broker connection and can differ slightly from the fill.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
