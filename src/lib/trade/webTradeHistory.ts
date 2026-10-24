/**
 * The History tab of WSA Trade: the closed trades of an account, newest first. Pure (types + helpers).
 *
 * Where the rows come from: the platform's own record of the account's closed trades (the table the broker
 * sync keeps, the same one the account pages list), read for the caller's own account only. A trade the
 * person closes from the panel is known the moment the trading system answers, but the synced record only
 * appears a little later - so the panel keeps what it just closed (`rowFromClose`) and shows it at once,
 * flagged `local`, until the real record arrives (`mergeHistory` drops the local row as soon as it does).
 * Nothing here invents a figure: a local row carries the position's last floating result and says so.
 */

import type { WebTradePosition, WebTradeSide } from "@/lib/trade/webTrade";

/** One closed trade. */
export interface WebTradeHistoryRow {
  /** the broker's id of the trade (the position id the panel closes by) */
  ticket: string;
  symbol: string;
  side: WebTradeSide;
  /** lots */
  volume: number;
  openPrice: number;
  closePrice: number | null;
  /** the result in the account currency */
  profit: number;
  /** UTC instant, null when the broker never said */
  openedAt: string | null;
  closedAt: string;
  /** built from the answer of a close made in this panel; the synced record has not arrived yet (the profit is the last floating one) */
  local?: boolean;
}

/** What the history route sends. */
export interface WebTradeHistory {
  accountId: string;
  currency: string;
  /** only trades closed at or after this instant (null = the whole record) */
  since: string | null;
  rows: WebTradeHistoryRow[];
  /** more closed trades exist in the period than `rows` holds (the newest `rows.length` are shown) */
  truncated: boolean;
  fetchedAt: string;
}

/** How many closed trades one request returns by default / at most. */
export const WEB_TRADE_HISTORY_LIMIT = 300;
export const WEB_TRADE_HISTORY_MAX = 1000;

export const HISTORY_PERIODS = [
  { id: "today", label: "Today" },
  { id: "week", label: "7 days" },
  { id: "month", label: "30 days" },
  { id: "quarter", label: "90 days" },
  { id: "all", label: "All" },
] as const;

export type HistoryPeriodId = (typeof HISTORY_PERIODS)[number]["id"];

export const DEFAULT_HISTORY_PERIOD: HistoryPeriodId = "week";

const DAY_MS = 86_400_000;

/** The first instant a period covers, as an ISO string; "today" starts at the person's local midnight. Null = no lower bound. */
export function historySince(period: HistoryPeriodId, now: Date = new Date()): string | null {
  switch (period) {
    case "today": {
      const start = new Date(now.getTime());
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
    case "week":
      return new Date(now.getTime() - 7 * DAY_MS).toISOString();
    case "month":
      return new Date(now.getTime() - 30 * DAY_MS).toISOString();
    case "quarter":
      return new Date(now.getTime() - 90 * DAY_MS).toISOString();
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The figures above the list
// ─────────────────────────────────────────────────────────────────────────────

export interface HistorySummary {
  count: number;
  wins: number;
  losses: number;
  /** wins / trades, in percent (null without trades) */
  winRate: number | null;
  /** the sum of all results */
  net: number;
  grossProfit: number;
  /** negative or zero */
  grossLoss: number;
  /** gross profit / gross loss (null without a loss) */
  profitFactor: number | null;
  best: number | null;
  worst: number | null;
  /** lots traded */
  lots: number;
}

export function summarizeHistory(rows: ReadonlyArray<Pick<WebTradeHistoryRow, "profit" | "volume">>): HistorySummary {
  let wins = 0;
  let losses = 0;
  let net = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let lots = 0;
  let best: number | null = null;
  let worst: number | null = null;
  for (const row of rows) {
    const profit = Number.isFinite(row.profit) ? row.profit : 0;
    net += profit;
    lots += Number.isFinite(row.volume) ? row.volume : 0;
    if (profit > 0) {
      wins += 1;
      grossProfit += profit;
    } else if (profit < 0) {
      losses += 1;
      grossLoss += profit;
    }
    if (best === null || profit > best) best = profit;
    if (worst === null || profit < worst) worst = profit;
  }
  const count = rows.length;
  return {
    count,
    wins,
    losses,
    winRate: count > 0 ? (wins / count) * 100 : null,
    net,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    best,
    worst,
    lots: Math.round(lots * 1000) / 1000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A trade just closed from the panel, until the synced record arrives
// ─────────────────────────────────────────────────────────────────────────────

/** How long a locally known closed trade is kept while waiting for the synced record. */
export const LOCAL_ROW_TTL_MS = 3 * 60_000;

/** The closed trade the panel knows from the answer of a close: the position as it was, the fill price if the broker said one. */
export function rowFromClose(
  position: Pick<WebTradePosition, "ticket" | "symbol" | "side" | "volume" | "openPrice" | "profit" | "openedAt">,
  closePrice: number | null | undefined,
  closedAt: string,
): WebTradeHistoryRow {
  return {
    ticket: position.ticket,
    symbol: position.symbol,
    side: position.side,
    volume: position.volume,
    openPrice: position.openPrice,
    closePrice: typeof closePrice === "number" && closePrice > 0 ? closePrice : null,
    profit: position.profit,
    openedAt: position.openedAt,
    closedAt,
    local: true,
  };
}

function near(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

/**
 * The same closed trade in two lists: the same ticket - or, when the sync spells the id differently, the same symbol,
 * side, volume and entry price closed within a few minutes of each other.
 */
export function sameClosedTrade(left: WebTradeHistoryRow, right: WebTradeHistoryRow): boolean {
  if (left.ticket === right.ticket) return true;
  if (left.side !== right.side || left.symbol.toLowerCase() !== right.symbol.toLowerCase()) return false;
  if (!near(left.volume, right.volume, 1e-6)) return false;
  if (!near(left.openPrice, right.openPrice, Math.max(1e-9, Math.abs(left.openPrice) * 1e-7))) return false;
  const leftAt = Date.parse(left.closedAt);
  const rightAt = Date.parse(right.closedAt);
  return Number.isFinite(leftAt) && Number.isFinite(rightAt) && Math.abs(leftAt - rightAt) <= 10 * 60_000;
}

/**
 * The synced rows with the locally known ones added in front - except the ones the synced record already has, and the
 * ones outside the period. Newest first. The same array when there is nothing to add.
 */
export function mergeHistory(
  synced: ReadonlyArray<WebTradeHistoryRow>,
  local: ReadonlyArray<WebTradeHistoryRow>,
  since: string | null,
): WebTradeHistoryRow[] {
  const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  const extra = local.filter((row) => {
    const closedMs = Date.parse(row.closedAt);
    if (!Number.isFinite(closedMs) || closedMs < sinceMs) return false;
    return !synced.some((entry) => sameClosedTrade(entry, row));
  });
  if (extra.length === 0) return synced as WebTradeHistoryRow[];
  return [...extra, ...synced].sort((left, right) => Date.parse(right.closedAt) - Date.parse(left.closedAt));
}

// ─────────────────────────────────────────────────────────────────────────────
// Showing a row
// ─────────────────────────────────────────────────────────────────────────────

/** "35 s", "14 min", "2 h 14 min", "3 d 4 h": how long a trade was open. Empty when either instant is unknown. */
export function formatHeld(openedAt: string | null, closedAt: string | null): string {
  if (!openedAt || !closedAt) return "";
  const opened = Date.parse(openedAt);
  const closed = Date.parse(closedAt);
  if (!Number.isFinite(opened) || !Number.isFinite(closed) || closed < opened) return "";
  const seconds = Math.round((closed - opened) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

/** "24 Oct, 14:03": a day and a time, in the viewer's own time zone. */
export function formatHistoryTime(iso: string | null): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
