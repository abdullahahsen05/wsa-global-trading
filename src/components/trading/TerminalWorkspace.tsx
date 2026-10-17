"use client";

import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { CandlestickChart, Columns2, Crosshair, Monitor, Rows2 } from "lucide-react";
import { TradingChart } from "@/components/charts/TradingChart";
import { MetaTraderTerminal } from "@/components/trading/MetaTraderTerminal";
import { WsaTradePanel } from "@/components/trading/WsaTradePanel";
import { useTerminalWorkspace, type WorkspaceSaveState } from "@/hooks/useTerminalWorkspace";
import { useTradingAccountSelection } from "@/providers/TradingAccountSelectionProvider";
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
 */

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
  const paneHeight = stackedSplit ? "clamp(380px, 56dvh, 620px)" : "clamp(520px, 78dvh, 820px)";

  // The container is always `relative`: a pane that is not on screen is taken out of the flow
  // (absolute, invisible) but stays mounted, and needs something to be positioned against.
  // Side by side the chart gets the room; the order panel has a fixed, narrower column (two equal halves
  // stay for the MetaTrader web terminal, which needs the width).
  const containerClass = inSplit
    ? split === "columns"
      ? splitWith === "wsatrade"
        ? "relative grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]"
        : "relative grid gap-4 lg:grid-cols-2"
      : "relative grid gap-4"
    : "relative";
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

      <div className={containerClass}>
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
