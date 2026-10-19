/**
 * The arithmetic and the checks behind the WSA Trade ticket. Pure - no React, no I/O - so the
 * panel stays a thin layer of fields and buttons and every rule can be tested on its own.
 *
 * Prices and levels are what the broker's symbol list and quote say (`digits`, `bid`, `ask`);
 * nothing here knows a contract size or a tick value, so there is deliberately NO "risk 1 % of
 * the balance" lot calculator: without the tick value of the symbol it would be a guess, and a
 * wrong lot size costs money. The checks below only refuse what is certainly wrong (a stop on
 * the wrong side of the entry, a volume above the person's own limit); the broker still has the
 * last word on minimum distances (its "stops level") and the volume step.
 */

import {
  isValidLots,
  levelsProblem,
  normalizeTradeSymbol,
  pendingKindForPrice,
  pendingLevelsProblem,
  roundLots,
  type WebTradeBulkScope,
  type WebTradeOrderKind,
  type WebTradePendingOrder,
  type WebTradePosition,
  type WebTradeSide,
} from "@/lib/trade/webTrade";
import { formatPrice, parseDecimal, parseLevelInput } from "@/lib/trade/webTradeFormat";

// ─────────────────────────────────────────────────────────────────────────────
// Digits, points, levels
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DIGITS = 10;

/** One point: the smallest price step of the symbol (`10 ** -digits`); null when the digits are not known. */
export function pointSize(digits: number | null | undefined): number | null {
  if (typeof digits !== "number" || !Number.isInteger(digits) || digits < 0 || digits > MAX_DIGITS) return null;
  return 10 ** -digits;
}

function decimalsOf(price: number): number {
  const text = String(price);
  if (text.includes("e-")) return Math.min(MAX_DIGITS, Number(text.split("e-")[1]));
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : Math.min(MAX_DIGITS, text.length - dot - 1);
}

/**
 * The number of decimals of a symbol's price: the broker's own `digits` when the symbol list has
 * it, else what the live quote shows (a quote of 1.08123 / 1.08125 is a 5-digit symbol).
 */
export function resolveDigits(
  digits: number | null | undefined,
  quote: { bid: number; ask: number } | null,
): number | null {
  if (pointSize(digits) !== null) return digits as number;
  if (!quote || !(quote.bid > 0) || !(quote.ask > 0)) return null;
  return Math.max(decimalsOf(quote.bid), decimalsOf(quote.ask));
}

export type LevelRole = "STOP_LOSS" | "TAKE_PROFIT";

/**
 * The price that lies `points` away from `entry` in the direction a stop loss / take profit of
 * this side goes: for a buy the stop is below and the target above, for a sell the other way round.
 * Null when the digits are unknown, the distance is not a positive number or the result is not a price.
 */
export function levelFromPoints(
  side: WebTradeSide,
  entry: number,
  points: number,
  digits: number | null | undefined,
  role: LevelRole,
): number | null {
  const size = pointSize(digits);
  if (size === null || !(entry > 0) || !(points > 0) || !Number.isFinite(points)) return null;
  const upwards = (side === "BUY") === (role === "TAKE_PROFIT");
  const level = entry + (upwards ? 1 : -1) * points * size;
  if (!(level > 0)) return null;
  return Number(level.toFixed(digits as number));
}

/** The distance between two prices in points (rounded), or null when the digits are unknown. */
export function pointsBetween(a: number, b: number, digits: number | null | undefined): number | null {
  const size = pointSize(digits);
  if (size === null) return null;
  return Math.round(Math.abs(a - b) / size);
}

export interface RiskReward {
  /** price distance entry -> stop loss */
  risk: number;
  /** price distance entry -> take profit */
  reward: number;
  /** reward per unit of risk: 2 means "1 : 2" */
  ratio: number;
}

/** Null unless both levels are set and on the right side of the entry. */
export function riskReward(
  side: WebTradeSide,
  entry: number | null,
  stopLoss: number | null,
  takeProfit: number | null,
): RiskReward | null {
  if (entry === null || stopLoss === null || takeProfit === null) return null;
  const risk = side === "BUY" ? entry - stopLoss : stopLoss - entry;
  const reward = side === "BUY" ? takeProfit - entry : entry - takeProfit;
  if (!(risk > 0) || !(reward > 0)) return null;
  return { risk, reward, ratio: reward / risk };
}

export function formatRatio(value: RiskReward | null): string {
  return value ? `1 : ${value.ratio.toFixed(value.ratio >= 10 ? 0 : 1)}` : "-";
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume
// ─────────────────────────────────────────────────────────────────────────────

const MIN_STEPPED_LOTS = 0.01;
const MAX_STEPPED_LOTS = 100;

/** The step of the "+" / "-" buttons: 0.01 below one lot, 0.1 from one lot, 1 from ten lots. */
export function lotStep(volume: number): number {
  if (volume >= 10) return 1;
  if (volume >= 1) return 0.1;
  return 0.01;
}

/** One step up or down, never below 0.01 or above 100 lots, in thousandths. */
export function stepLots(volume: number, direction: 1 | -1): number {
  const next = roundLots(volume + direction * lotStep(volume));
  return Math.min(MAX_STEPPED_LOTS, Math.max(MIN_STEPPED_LOTS, next));
}

/**
 * A share of a position to close (0.25, 0.5 ...) rounded DOWN to a hundredth of a lot.
 * Null when that is less than 0.01 lot (nothing sensible to close); the whole volume when the
 * share is one or more.
 */
export function partialLots(volume: number, share: number): number | null {
  if (!(volume > 0) || !(share > 0)) return null;
  if (share >= 1) return roundLots(volume);
  const part = Math.floor(volume * share * 100 + 1e-9) / 100;
  return part >= MIN_STEPPED_LOTS ? roundLots(part) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The ticket
// ─────────────────────────────────────────────────────────────────────────────

export interface TicketInput {
  side: WebTradeSide;
  kind: WebTradeOrderKind;
  /** what is in the symbol box */
  symbol: string;
  /** what is in the volume box */
  volumeText: string;
  /** what is in the price box (pending orders) */
  priceText: string;
  /** what is in the stop loss / take profit boxes: prices, or distances in points when `levelMode` is "points" */
  stopLossText: string;
  takeProfitText: string;
  levelMode: "price" | "points";
  /** used when the stop loss / take profit box is empty (null = none) */
  defaultStopLossPoints: number | null;
  defaultTakeProfitPoints: number | null;
  /** the live price of THIS symbol, null when there is none */
  quote: { bid: number; ask: number } | null;
  /** the digits the broker lists for the symbol, null when unknown */
  digits: number | null;
  rules: { requireStopLoss: boolean; maxVolume: number | null };
}

export interface OrderPlan {
  side: WebTradeSide;
  kind: WebTradeOrderKind;
  symbol: string;
  volume: number;
  /** the price a pending order waits for; null for a market order */
  price: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** the price the levels are measured from: the typed price, else the price the order fills at; null when unknown */
  entry: number | null;
}

export type OrderPlanResult = { ok: true; plan: OrderPlan } | { ok: false; message: string };

/** The price a market order of this side fills at: buys at the ask, sells at the bid. */
export function marketEntry(side: WebTradeSide, quote: { bid: number; ask: number } | null): number | null {
  if (!quote) return null;
  const price = side === "BUY" ? quote.ask : quote.bid;
  return price > 0 ? price : null;
}

function kindName(side: WebTradeSide, kind: WebTradeOrderKind): string {
  return `${side === "BUY" ? "Buy" : "Sell"} ${kind === "MARKET" ? "market" : kind.toLowerCase()}`;
}

function levelFromText(
  text: string,
  role: LevelRole,
  input: TicketInput,
  entry: number | null,
  digits: number | null,
  fallbackPoints: number | null,
): { value: number | null } | { error: string } {
  const label = role === "STOP_LOSS" ? "stop loss" : "take profit";
  const parsed = input.levelMode === "points" ? parsePoints(text) : parseLevelInput(text);
  if (parsed === "invalid") {
    return {
      error:
        input.levelMode === "points"
          ? `The ${label} must be a distance in points above zero.`
          : `The ${label} must be a price above zero.`,
    };
  }
  if (parsed === null && fallbackPoints === null) return { value: null };

  // a price typed in price mode is used as it is; everything else is a distance from the entry
  if (parsed !== null && input.levelMode === "price") return { value: parsed };
  const points = parsed ?? fallbackPoints;
  if (points === null) return { value: null };
  if (entry === null || digits === null) {
    return {
      error: `There is no live price for ${input.symbol.trim() || "this symbol"} yet, so the ${label} distance cannot be turned into a price. Type the ${label} as a price, or wait for the price.`,
    };
  }
  const level = levelFromPoints(input.side, entry, points, digits, role);
  return level === null ? { error: `The ${label} distance does not give a valid price.` } : { value: level };
}

/** A distance in points: a number above zero ("" = not set). */
function parsePoints(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const parsed = parseDecimal(text);
  return parsed !== null && parsed > 0 && parsed <= 1_000_000 ? parsed : "invalid";
}

/**
 * Turns what is typed into the ticket into the order that would be sent, or the first reason it
 * cannot be: the checks run in the order the person fills the form (symbol, volume, price,
 * levels) and end with the person's own rules.
 */
export function buildOrderPlan(input: TicketInput): OrderPlanResult {
  const symbol = normalizeTradeSymbol(input.symbol);
  if (!symbol) {
    return { ok: false, message: "Choose a symbol from the list, or type it the way your broker spells it (for example XAUUSD or EURUSD.m)." };
  }
  const volume = parseDecimal(input.volumeText);
  if (volume === null || !isValidLots(volume)) {
    return { ok: false, message: "Volume must be between 0.001 and 100 lots, with at most 3 decimals." };
  }
  if (input.rules.maxVolume !== null && volume > input.rules.maxVolume) {
    return {
      ok: false,
      message: `Your own limit is ${formatPrice(input.rules.maxVolume)} lots per order (Trade settings). Lower the volume or change the limit.`,
    };
  }

  let price: number | null = null;
  let entry: number | null;
  if (input.kind === "MARKET") {
    entry = marketEntry(input.side, input.quote);
  } else {
    const typed = parseLevelInput(input.priceText);
    if (typed === null || typed === "invalid") {
      return { ok: false, message: "Enter the price the order waits for (a number above zero)." };
    }
    price = typed;
    entry = typed;
    const implied = pendingKindForPrice(input.side, typed, input.quote);
    if (implied !== null && implied !== input.kind) {
      const ref = input.side === "BUY" ? input.quote?.ask : input.quote?.bid;
      const refName = input.side === "BUY" ? "ask" : "bid";
      return {
        ok: false,
        message: `${kindName(input.side, input.kind)} must be placed ${
          input.kind === "LIMIT"
            ? input.side === "BUY"
              ? "below"
              : "above"
            : input.side === "BUY"
              ? "above"
              : "below"
        } the current ${refName} (${formatPrice(ref)}). At ${formatPrice(typed)} this is a ${kindName(input.side, implied).toLowerCase()} - switch the order type.`,
      };
    }
  }

  const digits = resolveDigits(input.digits, input.quote);
  const stop = levelFromText(input.stopLossText, "STOP_LOSS", input, entry, digits, input.defaultStopLossPoints);
  if ("error" in stop) return { ok: false, message: stop.error };
  const target = levelFromText(input.takeProfitText, "TAKE_PROFIT", input, entry, digits, input.defaultTakeProfitPoints);
  if ("error" in target) return { ok: false, message: target.error };

  // with a known entry both levels must sit on the right side of it; without one only the pair can be checked
  const mismatch =
    entry !== null
      ? pendingLevelsProblem(input.side, entry, stop.value, target.value)
      : levelsProblem(input.side, stop.value, target.value);
  if (mismatch) return { ok: false, message: mismatch };

  if (input.rules.requireStopLoss && stop.value === null) {
    return { ok: false, message: "Your rule: every new order needs a stop loss (Trade settings). Add one, or switch the rule off." };
  }

  return {
    ok: true,
    plan: { side: input.side, kind: input.kind, symbol, volume, price, stopLoss: stop.value, takeProfit: target.value, entry },
  };
}

/** One line that says an order in words: "Buy 0.1 XAUUSD · at market · SL 2290 · TP 2320". The panel no longer asks before it sends; this is for messages and logs. */
export function describePlan(plan: OrderPlan): string {
  const parts = [`${plan.side === "BUY" ? "Buy" : "Sell"} ${formatPrice(plan.volume)} ${plan.symbol}`];
  parts.push(plan.kind === "MARKET" ? "at market" : `${plan.kind.toLowerCase()} at ${formatPrice(plan.price)}`);
  if (plan.stopLoss !== null) parts.push(`SL ${formatPrice(plan.stopLoss)}`);
  if (plan.takeProfit !== null) parts.push(`TP ${formatPrice(plan.takeProfit)}`);
  return parts.join(" · ");
}

/** The request body of the open route for a plan (the caller adds the account and the request id). */
export function planToRequest(plan: OrderPlan): {
  symbol: string;
  side: WebTradeSide;
  volume: number;
  orderKind: WebTradeOrderKind;
  price: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
} {
  return {
    symbol: plan.symbol,
    side: plan.side,
    volume: plan.volume,
    orderKind: plan.kind,
    price: plan.price,
    stopLoss: plan.stopLoss,
    takeProfit: plan.takeProfit,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Managing what is open
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stop loss that protects a position at its entry price, or null when it is already at or
 * beyond it (a stop that is already in profit must not be pulled back to the entry).
 */
export function breakEvenLevel(position: Pick<WebTradePosition, "side" | "openPrice" | "stopLoss">): number | null {
  if (!(position.openPrice > 0)) return null;
  const { stopLoss, openPrice, side } = position;
  if (stopLoss !== null) {
    if (side === "BUY" && stopLoss >= openPrice) return null;
    if (side === "SELL" && stopLoss <= openPrice) return null;
  }
  return openPrice;
}

/**
 * What a bulk command with this scope would touch. It mirrors the trading system's own rule
 * (`bulkTargets` on the AWS side), so the number on the chip is the number that is closed.
 */
export function bulkPreview(
  scope: WebTradeBulkScope,
  symbol: string | null,
  positions: ReadonlyArray<WebTradePosition>,
  pending: ReadonlyArray<WebTradePendingOrder>,
): { positions: WebTradePosition[]; pending: WebTradePendingOrder[] } {
  const wanted = symbol?.toLowerCase() ?? null;
  const sameSymbol = (entry: { symbol: string }) => wanted === null || entry.symbol.toLowerCase() === wanted;
  switch (scope) {
    case "ALL":
      return { positions: [...positions], pending: [] };
    case "PROFIT":
      return { positions: positions.filter((entry) => entry.profit > 0), pending: [] };
    case "LOSS":
      return { positions: positions.filter((entry) => entry.profit < 0), pending: [] };
    case "BUY":
      return { positions: positions.filter((entry) => entry.side === "BUY"), pending: [] };
    case "SELL":
      return { positions: positions.filter((entry) => entry.side === "SELL"), pending: [] };
    case "SYMBOL":
      return { positions: positions.filter(sameSymbol), pending: [] };
    case "PENDING":
      return { positions: [], pending: pending.filter(sameSymbol) };
  }
}

export const BULK_SCOPE_LABELS: Record<WebTradeBulkScope, string> = {
  ALL: "all positions",
  PROFIT: "the winning positions",
  LOSS: "the losing positions",
  BUY: "all buy positions",
  SELL: "all sell positions",
  SYMBOL: "the positions of this symbol",
  PENDING: "all pending orders",
};

/** The count of a bulk command in words: "Close 3 winning positions?" / "Delete 2 pending orders?". The panel sends on the first click and no longer asks; kept for wording and tests. */
export function bulkQuestion(scope: WebTradeBulkScope, symbol: string | null, count: number): string {
  const noun = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (scope === "PENDING") return `Delete ${noun(count, "pending order")}${symbol ? ` of ${symbol}` : ""}?`;
  const which: Record<Exclude<WebTradeBulkScope, "PENDING">, string> = {
    ALL: "",
    PROFIT: "winning ",
    LOSS: "losing ",
    BUY: "buy ",
    SELL: "sell ",
    SYMBOL: symbol ? `${symbol} ` : "",
  };
  return `Close ${noun(count, `${which[scope]}position`)}?`;
}
