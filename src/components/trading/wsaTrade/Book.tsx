"use client";

import { Loader2, Pencil, X } from "lucide-react";
import { bulkPreview, partialLots } from "@/lib/trade/ticketMath";
import {
  isValidLots,
  roundLots,
  type WebTradeBulkScope,
  type WebTradePendingOrder,
  type WebTradePosition,
} from "@/lib/trade/webTrade";
import { formatLots, formatPrice, formatSigned, parseDecimal, resultTone } from "@/lib/trade/webTradeFormat";
import { CHIP_CLASS, DANGER_CHIP_CLASS, FIELD_CLASS, LABEL_CLASS, toneClass } from "./ui";

/**
 * The lists under the ticket: open positions, pending orders and the "close several" bar.
 * Every button here is the command itself - Close, Delete, BE and the "close several" chips act at
 * once; the only forms are the ones that need a number from the person (levels, lots, a pending
 * order's price), and their Save / Close button is the command.
 */

export type RowEdit =
  | { kind: "levels"; ticket: string; stopLoss: string; takeProfit: string }
  | { kind: "close"; ticket: string; lots: string }
  | { kind: "pending"; ticket: string; price: string; stopLoss: string; takeProfit: string };

const SHARES: ReadonlyArray<{ share: number; label: string }> = [
  { share: 0.25, label: "25%" },
  { share: 0.5, label: "50%" },
  { share: 0.75, label: "75%" },
  { share: 1, label: "All" },
];

function SideBadge({ side, text }: { side: "BUY" | "SELL"; text: string }) {
  const color = side === "BUY" ? "bg-accent-2/15 text-accent-2" : "bg-danger/15 text-danger";
  return (
    <span className={`rounded-[3px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${color}`}>{text}</span>
  );
}

function pendingName(order: WebTradePendingOrder): string {
  return `${order.side === "BUY" ? "Buy" : "Sell"} ${order.kind.replace("_", " ").toLowerCase()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Open positions
// ─────────────────────────────────────────────────────────────────────────────

export interface PositionCardProps {
  position: WebTradePosition;
  /** the editor that is open on THIS position, if any */
  editing: RowEdit | null;
  busy: boolean;
  canManage: boolean;
  /** can the stop loss be moved to the entry (not already there or beyond) */
  canBreakEven: boolean;
  onStartLevels: () => void;
  /** closes the whole position at once */
  onClose: () => void;
  onStartPartial: () => void;
  onBreakEven: () => void;
  onChange: (edit: RowEdit) => void;
  onCancelEdit: () => void;
  onSaveLevels: (edit: Extract<RowEdit, { kind: "levels" }>) => void;
  onSubmitClose: (edit: Extract<RowEdit, { kind: "close" }>) => void;
}

export function PositionCard({
  position,
  editing,
  busy,
  canManage,
  canBreakEven,
  onStartLevels,
  onClose,
  onStartPartial,
  onBreakEven,
  onChange,
  onCancelEdit,
  onSaveLevels,
  onSubmitClose,
}: PositionCardProps) {
  const tone = toneClass(resultTone(position.profit));
  const name = `${position.symbol} ${position.ticket}`;
  const off = !canManage || busy;
  return (
    <li className="rounded-[4px] border border-line bg-background p-3" aria-label={`Position ${name}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            <SideBadge side={position.side} text={position.side === "BUY" ? "Buy" : "Sell"} />
            <span className="truncate">{position.symbol}</span>
            <span className="text-xs font-medium text-muted">{formatLots(position.volume)} lots</span>
          </p>
          <p className="mt-1 text-xs tabular-nums text-muted">
            Open {formatPrice(position.openPrice)} · SL {formatPrice(position.stopLoss)} · TP {formatPrice(position.takeProfit)}
          </p>
        </div>
        <p className={`shrink-0 text-right text-sm font-semibold tabular-nums ${tone}`}>{formatSigned(position.profit)}</p>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          className="btn-dark text-xs"
          disabled={off}
          onClick={onStartLevels}
          aria-label={`Change stop loss and take profit of ${name}`}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          SL/TP
        </button>
        <button
          type="button"
          className="btn-dark text-xs"
          disabled={off || !canBreakEven}
          onClick={onBreakEven}
          aria-label={`Move the stop loss of ${name} to break-even`}
          title="Move the stop loss to the entry price"
        >
          BE
        </button>
        <button
          type="button"
          className="btn-dark text-xs"
          disabled={off}
          onClick={onStartPartial}
          aria-label={`Close part of ${name}`}
        >
          Partial
        </button>
        <button
          type="button"
          className="btn-dark text-xs"
          disabled={off}
          onClick={onClose}
          aria-label={`Close ${name}`}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Close
        </button>
      </div>

      {editing?.kind === "levels" ? (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL_CLASS} htmlFor={`sl-${position.ticket}`}>
                Stop loss
              </label>
              <input
                id={`sl-${position.ticket}`}
                inputMode="decimal"
                placeholder="none"
                value={editing.stopLoss}
                onChange={(event) => onChange({ ...editing, stopLoss: event.target.value })}
                className={FIELD_CLASS}
              />
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor={`tp-${position.ticket}`}>
                Take profit
              </label>
              <input
                id={`tp-${position.ticket}`}
                inputMode="decimal"
                placeholder="none"
                value={editing.takeProfit}
                onChange={(event) => onChange({ ...editing, takeProfit: event.target.value })}
                className={FIELD_CLASS}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-active text-xs" disabled={busy} onClick={() => onSaveLevels(editing)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Save levels
            </button>
            <button type="button" className="btn-dark text-xs" disabled={busy} onClick={onCancelEdit}>
              Cancel
            </button>
            <span className="text-[11px] text-muted">Empty = remove that level.</span>
          </div>
        </div>
      ) : null}

      {editing?.kind === "close" ? (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28">
              <label className={LABEL_CLASS} htmlFor={`lots-${position.ticket}`}>
                Lots to close
              </label>
              <input
                id={`lots-${position.ticket}`}
                inputMode="decimal"
                value={editing.lots}
                onChange={(event) => onChange({ ...editing, lots: event.target.value })}
                className={FIELD_CLASS}
              />
            </div>
            <div className="flex gap-1.5 pb-0.5" role="group" aria-label="Share of the position">
              {SHARES.map((entry) => {
                const lots = partialLots(position.volume, entry.share);
                return (
                  <button
                    key={entry.label}
                    type="button"
                    className={CHIP_CLASS}
                    disabled={busy || lots === null}
                    onClick={() => lots !== null && onChange({ ...editing, lots: formatLots(lots) })}
                    aria-label={`Close ${entry.label === "All" ? "all" : entry.label} of ${name}`}
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-active text-xs" disabled={busy} onClick={() => onSubmitClose(editing)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {closeLabel(position, editing.lots)}
            </button>
            <button type="button" className="btn-dark text-xs" disabled={busy} onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function closeLabel(position: WebTradePosition, lotsText: string): string {
  const lots = parseDecimal(lotsText);
  if (lots !== null && isValidLots(lots) && roundLots(lots) < roundLots(position.volume)) {
    return `Close ${formatLots(lots)} lots`;
  }
  return "Close position";
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending orders
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingCardProps {
  order: WebTradePendingOrder;
  editing: RowEdit | null;
  busy: boolean;
  canManage: boolean;
  onStartEdit: () => void;
  /** deletes the pending order at once */
  onDelete: () => void;
  onChange: (edit: RowEdit) => void;
  onCancelEdit: () => void;
  onSave: (edit: Extract<RowEdit, { kind: "pending" }>) => void;
}

export function PendingCard({
  order,
  editing,
  busy,
  canManage,
  onStartEdit,
  onDelete,
  onChange,
  onCancelEdit,
  onSave,
}: PendingCardProps) {
  const name = `${order.symbol} ${order.ticket}`;
  const off = !canManage || busy;
  return (
    <li className="rounded-[4px] border border-line bg-background p-3" aria-label={`Pending order ${name}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            <SideBadge side={order.side} text={pendingName(order)} />
            <span className="truncate">{order.symbol}</span>
            <span className="text-xs font-medium text-muted">{formatLots(order.volume)} lots</span>
          </p>
          <p className="mt-1 text-xs tabular-nums text-muted">
            At {formatPrice(order.price)} · SL {formatPrice(order.stopLoss)} · TP {formatPrice(order.takeProfit)}
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          className="btn-dark text-xs"
          disabled={off}
          onClick={onStartEdit}
          aria-label={`Change price and levels of ${name}`}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Edit
        </button>
        <button
          type="button"
          className="btn-dark text-xs"
          disabled={off}
          onClick={onDelete}
          aria-label={`Delete pending order ${name}`}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Delete
        </button>
      </div>

      {editing?.kind === "pending" ? (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className={LABEL_CLASS} htmlFor={`pp-${order.ticket}`}>
                Price
              </label>
              <input
                id={`pp-${order.ticket}`}
                inputMode="decimal"
                value={editing.price}
                onChange={(event) => onChange({ ...editing, price: event.target.value })}
                className={FIELD_CLASS}
              />
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor={`psl-${order.ticket}`}>
                Stop loss
              </label>
              <input
                id={`psl-${order.ticket}`}
                inputMode="decimal"
                placeholder="none"
                value={editing.stopLoss}
                onChange={(event) => onChange({ ...editing, stopLoss: event.target.value })}
                className={FIELD_CLASS}
              />
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor={`ptp-${order.ticket}`}>
                Take profit
              </label>
              <input
                id={`ptp-${order.ticket}`}
                inputMode="decimal"
                placeholder="none"
                value={editing.takeProfit}
                onChange={(event) => onChange({ ...editing, takeProfit: event.target.value })}
                className={FIELD_CLASS}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-active text-xs" disabled={busy} onClick={() => onSave(editing)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Save order
            </button>
            <button type="button" className="btn-dark text-xs" disabled={busy} onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Close several at once
// ─────────────────────────────────────────────────────────────────────────────

const POSITION_SCOPES: ReadonlyArray<{ scope: WebTradeBulkScope; label: string }> = [
  { scope: "ALL", label: "All" },
  { scope: "PROFIT", label: "Winners" },
  { scope: "LOSS", label: "Losers" },
  { scope: "BUY", label: "Buys" },
  { scope: "SELL", label: "Sells" },
  { scope: "SYMBOL", label: "This symbol" },
];

export interface BulkBarProps {
  /** which list the bar belongs to */
  list: "positions" | "pending";
  symbol: string;
  positions: ReadonlyArray<WebTradePosition>;
  pending: ReadonlyArray<WebTradePendingOrder>;
  busy: boolean;
  canManage: boolean;
  /** does it at once: there is no second click */
  onRun: (scope: WebTradeBulkScope) => void;
}

/** One chip per choice, each with the number of orders it will touch; a chip is the command. */
export function BulkBar({ list, symbol, positions, pending, busy, canManage, onRun }: BulkBarProps) {
  const scopes: ReadonlyArray<{ scope: WebTradeBulkScope; label: string }> =
    list === "positions" ? POSITION_SCOPES : [{ scope: "PENDING", label: "Delete all pending orders" }];
  const symbolFor = (scope: WebTradeBulkScope) => (scope === "SYMBOL" ? symbol : null);
  const countFor = (scope: WebTradeBulkScope) => {
    const targets = bulkPreview(scope, symbolFor(scope), positions, pending);
    return targets.positions.length + targets.pending.length;
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={list === "positions" ? "Close several positions" : "Delete pending orders"}
    >
      {list === "positions" ? <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Close</span> : null}
      {scopes.map((entry) => {
        const count = countFor(entry.scope);
        return (
          <button
            key={entry.scope}
            type="button"
            className={DANGER_CHIP_CLASS}
            disabled={!canManage || busy || count === 0}
            onClick={() => onRun(entry.scope)}
            aria-label={`${entry.scope === "PENDING" ? entry.label : `Close ${entry.label.toLowerCase()}`} (${count})`}
          >
            {entry.label}
            <span className="ml-1 tabular-nums opacity-70">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
