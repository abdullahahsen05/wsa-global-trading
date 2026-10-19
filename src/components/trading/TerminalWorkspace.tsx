"use client";

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CandlestickChart, Columns2, Crosshair, GripVertical, Monitor, Rows2 } from "lucide-react";
import { TradingChart } from "@/components/charts/TradingChart";
import { MetaTraderTerminal } from "@/components/trading/MetaTraderTerminal";
import { WsaTradePanel } from "@/components/trading/WsaTradePanel";
import { useTerminalWorkspace, type WorkspaceSaveState } from "@/hooks/useTerminalWorkspace";
import { useTradingAccountSelection } from "@/providers/TradingAccountSelectionProvider";
import {
  clampShare,
  PANEL_SHARE_MAX,
  PANEL_SHARE_MIN,
  shareFromPointer,
  splitColumns,
  stepShare,
} from "@/lib/trade/panelLayout";
import {
  TERMINAL_VIEWS,
  type MetaTraderPatch,
  type SplitDirection,
  type SplitPartner,
  type TerminalView,
  type TradingViewPatch,
  type WsaTradePatch,
} from "@/lib/terminal/workspace";

/**
 * The terminal page - the same workspace for traders (`/terminal`) and admins
 * (`/admin/terminal`): the TradingView chart, the MetaTrader web terminal and the
 * native WSA Trade order panel as tabs, or the chart next to either of the other two
 * (split view, side by side or stacked).
 *
 * It opens as a TRADE SECTION: the split view with the chart to analyse on the left and the
 * WSA Trade panel (ticket, positions, pending orders, trade rules) on the right. The two stay on
 * the same instrument: a symbol picked in the panel opens on the chart, and a symbol picked on the
 * chart selects the matching symbol of the account's broker (`lib/trade/symbolMatch.ts`).
 *
 * Every pane is created the first time it is shown and then stays mounted, so
 * switching tabs never reloads a chart or drops a terminal session - they keep
 * running in the background, which is what "both open in real time" needs. A hidden
 * pane is not polled (WSA Trade stops asking the broker while it is out of sight).
 *
 * Side by side, the divider between the chart and the order panel can be dragged (or moved with
 * the arrow keys; a double click gives the usual column back), and the order panel scales its own
 * contents (zoom, or "Auto" to fit) - so nobody has to zoom the whole browser to reach the buttons.
 * Both are saved with the workspace.
 */

/** What a screen reader hears for the divider while the panel still has its usual column. */
const USUAL_PANEL_SHARE = 0.33;

const VIEW_TABS: ReadonlyArray<{
  id: TerminalView;
  label: string;
  icon: typeof CandlestickChart;
}> = [
  { id: "tradingview", label: "TradingView", icon: CandlestickChart },
  { id: "metatrader", label: "MetaTrader", icon: Monitor },
  { id: "wsatrade", label: "WSA Trade", icon: Crosshair },
  { id: "split", label: "Split view", icon: Columns2 },
];

const SPLIT_OPTIONS: ReadonlyArray<{
  id: SplitDirection;
  label: string;
  icon: typeof Columns2;
}> = [
  { id: "columns", label: "Side by side", icon: Columns2 },
  { id: "rows", label: "Stacked", icon: Rows2 },
];

const PARTNER_OPTIONS: ReadonlyArray<{ id: SplitPartner; label: string }> = [
  { id: "metatrader", label: "MetaTrader" },
  { id: "wsatrade", label: "WSA Trade" },
];

const SAVE_TEXT: Record<WorkspaceSaveState, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Layout saved",
  error: "Could not save - it will be retried with your next change",
  unavailable: "Saved on this device only",
};

const PANE_ID: Record<"tradingview" | "metatrader" | "wsatrade", string> = {
  tradingview: "terminal-pane-tradingview",
  metatrader: "terminal-pane-metatrader",
  wsatrade: "terminal-pane-wsatrade",
};

export function TerminalWorkspace() {
  const { selectedAccountId } = useTradingAccountSelection();
  const { workspace, update, loaded, saveState, storageAvailable } = useTerminalWorkspace();
  const { view, split, splitWith } = workspace;

  const inSplit = view === "split";
  const showTradingView = view === "tradingview" || inSplit;
  const showMetaTrader = view === "metatrader" || (inSplit && splitWith === "metatrader");
  const showWsaTrade = view === "wsatrade" || (inSplit && splitWith === "wsatrade");

  // A pane is created when it is first shown and kept afterwards.
  const [created, setCreated] = useState({
    tradingview: showTradingView,
    metatrader: showMetaTrader,
    wsatrade: showWsaTrade,
  });
  if (
    (showTradingView && !created.tradingview) ||
    (showMetaTrader && !created.metatrader) ||
    (showWsaTrade && !created.wsatrade)
  ) {
    setCreated({
      tradingview: created.tradingview || showTradingView,
      metatrader: created.metatrader || showMetaTrader,
      wsatrade: created.wsatrade || showWsaTrade,
    });
  }

  const tabRefs = useRef<Partial<Record<TerminalView, HTMLButtonElement | null>>>({});
  const gridRef = useRef<HTMLDivElement | null>(null);
  const wsaPaneRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  /** the share of the width the panel has while the divider is being dragged (saved when it is let go) */
  const [dragShare, setDragShare] = useState<number | null>(null);

  const changeTradingView = useCallback((patch: TradingViewPatch) => update({ tradingview: patch }), [update]);
  const changeMetaTrader = useCallback((patch: MetaTraderPatch) => update({ metatrader: patch }), [update]);
  const changeWsaTrade = useCallback((patch: WsaTradePatch) => update({ wsatrade: patch }), [update]);
  /** the order panel picked a symbol: the chart opens on it */
  const changeChartSymbol = useCallback((symbol: string) => update({ tradingview: { symbol } }), [update]);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = TERMINAL_VIEWS.length - 1;
    let next: number;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    const nextView = TERMINAL_VIEWS[next];
    update({ view: nextView });
    tabRefs.current[nextView]?.focus();
  }

  const stackedSplit = inSplit && split === "rows";
  // tall enough for the whole ticket and a few positions on a big screen, never taller than the screen
  const paneHeight = stackedSplit ? "clamp(380px, 56dvh, 620px)" : "clamp(520px, 80dvh, 1100px)";

  // The container is always `relative`: a pane that is not on screen is taken out of the flow
  // (absolute, invisible) but stays mounted, and needs something to be positioned against.
  // Side by side the chart gets the room; the order panel has a narrower column of its own - 380-440 px
  // unless the person dragged the divider (two equal halves stay for the MetaTrader web terminal, which
  // needs the width). The divider is a third, 16 px column that replaces the gap.
  const withDivider = inSplit && split === "columns" && splitWith === "wsatrade";
  const panelShare = dragShare ?? workspace.wsatrade.panelShare;
  const containerClass = inSplit
    ? split === "columns"
      ? splitWith === "wsatrade"
        ? "relative grid gap-4 lg:grid-cols-[var(--split-columns)] lg:gap-0"
        : "relative grid gap-4 lg:grid-cols-2"
      : "relative grid gap-4"
    : "relative";
  const containerStyle = withDivider ? ({ "--split-columns": splitColumns(panelShare) } as CSSProperties) : undefined;

  /** The share the order panel has right now, measured (the usual column has no stored number). */
  function currentShare(): number {
    const grid = gridRef.current?.getBoundingClientRect().width ?? 0;
    const pane = wsaPaneRef.current?.getBoundingClientRect().width ?? 0;
    return grid > 0 && pane > 0 ? clampShare(pane / grid) : USUAL_PANEL_SHARE;
  }

  function shareAt(event: ReactPointerEvent<HTMLDivElement>): number | null {
    const rect = gridRef.current?.getBoundingClientRect();
    return rect ? shareFromPointer(event.clientX, rect.left, rect.width) : null;
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    // the chart is an iframe: capturing the pointer keeps the drag going when it crosses it
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const share = shareAt(event);
    if (share !== null) setDragShare(share);
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // the pointer was already released
    }
    const share = shareAt(event);
    setDragShare(null);
    if (share !== null) update({ wsatrade: { panelShare: share } });
  }

  function cancelResize() {
    dragging.current = false;
    setDragShare(null);
  }

  function resizeWithKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Home" || event.key === "Enter") {
      event.preventDefault();
      update({ wsatrade: { panelShare: null } });
      return;
    }
    // the divider moves left = the panel gets wider
    const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    update({ wsatrade: { panelShare: stepShare(workspace.wsatrade.panelShare ?? currentShare(), direction) } });
  }
  const paneClass = (visible: boolean) => {
    if (!visible) return "pointer-events-none invisible absolute inset-0 overflow-hidden";
    return inSplit ? "min-w-0" : "relative min-w-0";
  };

  const controlsFor = (id: TerminalView) => {
    const ids: string[] = [];
    const withChart = id === "tradingview" || id === "split";
    const withMetaTrader = id === "metatrader" || (id === "split" && splitWith === "metatrader");
    const withWsaTrade = id === "wsatrade" || (id === "split" && splitWith === "wsatrade");
    if (withChart && created.tradingview) ids.push(PANE_ID.tradingview);
    if (withMetaTrader && created.metatrader) ids.push(PANE_ID.metatrader);
    if (withWsaTrade && created.wsatrade) ids.push(PANE_ID.wsatrade);
    return ids.length > 0 ? ids.join(" ") : undefined;
  };

  const saveText =
    saveState === "saving" || saveState === "error"
      ? SAVE_TEXT[saveState]
      : !storageAvailable
        ? SAVE_TEXT.unavailable
        : SAVE_TEXT[saveState];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Terminal view" className="flex flex-wrap gap-2">
          {VIEW_TABS.map((tab, index) => {
            const selected = view === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tab.id] = node;
                }}
                type="button"
                role="tab"
                id={`terminal-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={controlsFor(tab.id)}
                tabIndex={selected ? 0 : -1}
                onClick={() => update({ view: tab.id })}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                className={`btn-dark text-xs ${selected ? "btn-active" : ""}`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {inSplit ? (
            <>
              <div role="group" aria-label="Next to the chart" className="flex gap-2">
                {PARTNER_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={splitWith === option.id}
                    onClick={() => update({ splitWith: option.id })}
                    className={`btn-dark text-xs ${splitWith === option.id ? "btn-active" : ""}`}
                  >
                    {`Chart + ${option.label}`}
                  </button>
                ))}
              </div>
              <div role="group" aria-label="Split layout" className="flex gap-2">
                {SPLIT_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={split === option.id}
                      onClick={() => update({ split: option.id })}
                      className={`btn-dark text-xs ${split === option.id ? "btn-active" : ""}`}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
          <p role="status" aria-live="polite" className="min-h-4 text-xs text-muted">
            {saveText}
          </p>
        </div>
      </div>

      <div ref={gridRef} className={containerClass} style={containerStyle}>
        {created.tradingview ? (
          <div
            id={PANE_ID.tradingview}
            role="tabpanel"
            aria-label="TradingView chart"
            aria-hidden={showTradingView ? undefined : true}
            inert={!showTradingView}
            className={paneClass(showTradingView)}
          >
            <TradingChart
              accountId={selectedAccountId ?? undefined}
              settings={workspace.tradingview}
              onSettingsChange={changeTradingView}
              chartHeight={paneHeight}
            />
          </div>
        ) : null}
        {withDivider ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the order panel"
            aria-valuemin={Math.round(PANEL_SHARE_MIN * 100)}
            aria-valuemax={Math.round(PANEL_SHARE_MAX * 100)}
            aria-valuenow={Math.round((panelShare ?? USUAL_PANEL_SHARE) * 100)}
            aria-valuetext={
              panelShare === null ? "The usual width" : `${Math.round(panelShare * 100)} percent of the width`
            }
            tabIndex={0}
            title="Drag to resize the order panel · arrow keys · double click for the usual width"
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={cancelResize}
            onDoubleClick={() => update({ wsatrade: { panelShare: null } })}
            onKeyDown={resizeWithKeys}
            className="group hidden cursor-col-resize touch-none select-none items-center justify-center outline-none lg:flex"
          >
            <span className="flex h-16 w-3 items-center justify-center rounded-[4px] border border-line bg-background text-muted transition group-hover:border-accent group-focus-visible:border-accent">
              <GripVertical className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
        ) : null}
        {created.metatrader ? (
          <div
            id={PANE_ID.metatrader}
            role="tabpanel"
            aria-label="MetaTrader web terminal"
            aria-hidden={showMetaTrader ? undefined : true}
            inert={!showMetaTrader}
            className={paneClass(showMetaTrader)}
          >
            <MetaTraderTerminal
              settings={workspace.metatrader}
              onSettingsChange={changeMetaTrader}
              active={showMetaTrader}
              workspaceLoaded={loaded}
              suggestedAccountId={selectedAccountId}
              height={paneHeight}
            />
          </div>
        ) : null}
        {created.wsatrade ? (
          <div
            ref={wsaPaneRef}
            id={PANE_ID.wsatrade}
            role="tabpanel"
            aria-label="WSA Trade order panel"
            aria-hidden={showWsaTrade ? undefined : true}
            inert={!showWsaTrade}
            className={paneClass(showWsaTrade)}
          >
            <WsaTradePanel
              settings={workspace.wsatrade}
              onSettingsChange={changeWsaTrade}
              active={showWsaTrade}
              workspaceLoaded={loaded}
              suggestedAccountId={selectedAccountId}
              height={paneHeight}
              chartSymbol={workspace.tradingview.symbol}
              chartWatchlist={workspace.tradingview.watchlist}
              onChartSymbol={changeChartSymbol}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
