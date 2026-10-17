/**
 * What a trade server's answer to an order means. Pure - no I/O, no environment - and
 * shared by the WSA Trade panel, the copy engine and the AWS workers.
 *
 * A bridge answers an order in one of three ways:
 *   - an object with a MetaTrader 5 return code (`retcode`: 10009 done, 10019 no money ...),
 *   - an object with a ticket (`ticket` / `order` / `orderId` / `positionId`),
 *   - an HTTP error whose text carries an MT4 error number or name ("130", "ERR_INVALID_STOPS").
 * Until now every refusal was shown as "The broker rejected the operation." - the reason
 * (`comment`, `retcode`) was thrown away, so nobody could tell a closed market from a
 * bad stop loss. This file turns all of it into a sentence a trader can act on.
 */

import { publicApi2TradeError, publicTradeRejection } from "./api2TradeErrors";

interface CodeInfo {
  text: string;
  /** the trade server confirms the request was NOT executed and asking again is safe */
  retry?: boolean;
}

/** MetaTrader 5 trade server return codes (TRADE_RETCODE_*). */
const MT5_CODES: Record<number, CodeInfo> = {
  10004: { text: "Requote - the price changed, please try again.", retry: true },
  10006: { text: "The request was rejected by the trade server." },
  10007: { text: "The request was cancelled." },
  10011: { text: "The trade server could not process the request." },
  10012: { text: "The request timed out at the trade server." },
  10013: { text: "Invalid request." },
  10014: { text: "Invalid volume - check the lot size and the lot step of this symbol." },
  10015: { text: "Invalid price." },
  10016: { text: "Invalid stop loss / take profit - too close to the price or on the wrong side." },
  10017: { text: "Trading is disabled for this account." },
  10018: { text: "The market is closed for this symbol." },
  10019: { text: "Not enough free margin for this order." },
  10020: { text: "The price changed, please try again.", retry: true },
  10021: { text: "No quotes at the moment (off quotes), please try again.", retry: true },
  10022: { text: "Invalid order expiration." },
  10023: { text: "The order state changed meanwhile." },
  10024: { text: "Too many requests, please try again in a moment.", retry: true },
  10025: { text: "Nothing was changed (the values are the same)." },
  10026: { text: "Automated trading is disabled by the broker's server." },
  10027: { text: "Automated trading is disabled in the terminal." },
  10028: { text: "The request is locked for processing, please try again.", retry: true },
  10029: { text: "The order or position is frozen (too close to the market)." },
  10030: { text: "The broker does not support this order filling mode." },
  10031: { text: "No connection with the broker's trade server." },
  10032: { text: "This operation is allowed on live accounts only." },
  10033: { text: "The limit of pending orders is reached." },
  10034: { text: "The volume limit for this symbol is reached." },
  10035: { text: "Wrong or prohibited order type." },
  10036: { text: "The position is already closed." },
  10038: { text: "The volume to close is bigger than the position." },
  10039: { text: "A closing order already exists for this position." },
  10040: { text: "The limit of open positions is reached." },
  10041: { text: "The pending order was rejected and cancelled." },
  10042: { text: "Only long (buy) positions are allowed for this symbol." },
  10043: { text: "Only short (sell) positions are allowed for this symbol." },
  10044: { text: "Only closing of positions is allowed for this symbol." },
  10045: { text: "Closing is allowed in FIFO order only (close the oldest position first)." },
  10046: { text: "Opposite positions on one symbol are not allowed (hedging is off)." },
};

/** MetaTrader 4 error numbers (the ones an order can run into). */
const MT4_CODES: Record<number, CodeInfo> = {
  1: { text: "Nothing was changed (the values are the same)." },
  2: { text: "The trade server reported a common error." },
  3: { text: "Invalid trade parameters." },
  4: { text: "The trade server is busy, please try again.", retry: true },
  6: { text: "No connection with the broker's trade server." },
  7: { text: "Not enough rights to trade." },
  8: { text: "Too many requests, please try again in a moment.", retry: true },
  9: { text: "The trade operation was malfunctional." },
  64: { text: "The account is disabled." },
  65: { text: "Invalid account." },
  128: { text: "The trade request timed out." },
  129: { text: "Invalid price." },
  130: { text: "Invalid stop loss / take profit - too close to the price or on the wrong side." },
  131: { text: "Invalid volume - check the lot size and the lot step of this symbol." },
  132: { text: "The market is closed for this symbol." },
  133: { text: "Trading is disabled for this account or symbol." },
  134: { text: "Not enough free margin for this order." },
  135: { text: "The price changed, please try again.", retry: true },
  136: { text: "No quotes at the moment (off quotes), please try again.", retry: true },
  137: { text: "The broker is busy, please try again.", retry: true },
  138: { text: "Requote - the price changed, please try again.", retry: true },
  139: { text: "The order is locked." },
  140: { text: "Only long (buy) positions are allowed for this symbol." },
  141: { text: "Too many requests, please try again in a moment.", retry: true },
  145: { text: "Modification denied - the order is too close to the market." },
  146: { text: "The trade context is busy, please try again.", retry: true },
  147: { text: "Expiration dates are not allowed by this broker." },
  148: { text: "The limit of open and pending orders is reached." },
  149: { text: "Opposite positions on one symbol are not allowed (hedging is off)." },
  150: { text: "Closing is allowed in FIFO order only (close the oldest position first)." },
  4106: { text: "The broker does not know this symbol." },
  4108: { text: "The position or order does not exist (any more)." },
};

/** Codes that mean "done" (0 is the single-order API's way of saying so). */
const SUCCESS_CODES = new Set([0, 10008, 10009, 10010]);
/** "Nothing to change": the order already has these values - a modify that asks for the same is not a failure. */
const NOTHING_CHANGED_CODES = new Set([10025]);

export function isSuccessCode(code: number): boolean {
  return SUCCESS_CODES.has(code);
}

export interface TradeCodeDescription {
  code: number;
  success: boolean;
  text: string;
  /** the request was certainly not executed and may be repeated at once */
  retry: boolean;
}

/** A trade-server code in words, or null for a code this file does not know. */
export function describeTradeCode(code: number): TradeCodeDescription | null {
  if (!Number.isFinite(code)) return null;
  if (code === 0) return { code, success: true, text: "Done.", retry: false };
  if (code === 10008) return { code, success: true, text: "Order placed.", retry: false };
  if (code === 10009) return { code, success: true, text: "Done.", retry: false };
  if (code === 10010) return { code, success: true, text: "Done - only part of the volume was executed.", retry: false };
  const info = code >= 10000 ? MT5_CODES[code] : MT4_CODES[code];
  if (!info) return null;
  return { code, success: false, text: info.text, retry: info.retry === true };
}

/** Text the provider sent, in words: known error names and phrases become the sentences above. */
const PHRASES: Array<[RegExp, string]> = [
  [/investor|read[\s_-]?only/i, "This account is connected with the read-only (investor) password, so it cannot trade. Reconnect it with the main trading password."],
  [/trade[\s_-]?(is[\s_-]?)?not[\s_-]?allowed|not[\s_-]?allowed[\s_-]?to[\s_-]?trade|trading[\s_-]?(is[\s_-]?)?not[\s_-]?allowed/i, "Trading is not allowed for this account. If it is connected with the read-only (investor) password, reconnect it with the main trading password."],
  [/invalid[\s_-]?stops?|invalid[\s_-]?(sl|tp)\b|stops?[\s_-]?level/i, MT5_CODES[10016].text],
  [/not[\s_-]?enough[\s_-]?(money|margin)|no[\s_-]?money|insufficient[\s_-]?(funds|margin)|margin[\s_-]?is[\s_-]?not[\s_-]?enough/i, MT5_CODES[10019].text],
  [/market[\s_-]?(is[\s_-]?)?closed/i, MT5_CODES[10018].text],
  [/trade[\s_-]?(is[\s_-]?)?disabled|trading[\s_-]?(is[\s_-]?)?disabled/i, MT5_CODES[10017].text],
  [/invalid[\s_-]?(trade[\s_-]?)?(volume|lots?)/i, MT5_CODES[10014].text],
  [/off[\s_-]?quotes|no[\s_-]?quotes/i, MT5_CODES[10021].text],
  [/requote/i, MT5_CODES[10004].text],
  [/price[\s_-]?changed/i, MT5_CODES[10020].text],
  [/invalid[\s_-]?price/i, MT5_CODES[10015].text],
  [/too[\s_-]?many[\s_-]?requests/i, MT5_CODES[10024].text],
  [/(trade[\s_-]?context|broker|server)[\s_-]?(is[\s_-]?)?busy/i, MT4_CODES[146].text],
  [/(unknown|invalid|incorrect)[\s_-]?symbol|symbol[\s_-]?(is[\s_-]?)?not[\s_-]?(found|exist|available)|no[\s_-]?such[\s_-]?symbol/i, "The broker does not know this symbol. Pick it from the symbols of this account."],
  [/invalid[\s_-]?ticket|ticket[\s_-]?not[\s_-]?found|(position|order)[\s_-]?(was[\s_-]?)?not[\s_-]?found|no[\s_-]?such[\s_-]?(position|order)|position[\s_-]?(is[\s_-]?)?(already[\s_-]?)?closed/i, "The position or order does not exist (any more)."],
  [/hedg(e|ing)/i, MT5_CODES[10046].text],
  [/fifo/i, MT5_CODES[10045].text],
  [/auto[\s_-]?trading[\s_-]?(is[\s_-]?)?disabled|expert[\s_-]?advisors?[\s_-]?(are[\s_-]?)?disabled/i, MT5_CODES[10027].text],
  [/(did not answer|timed? ?out|timeout)/i, "The broker did not answer in time. Check the open positions before sending the order again."],
];

/**
 * A provider message in words a trader can act on: a known phrase is replaced by its
 * sentence, anything else keeps its own text - passed through the sanitiser that
 * removes credentials and provider names. A trailing "(retcode 10019)" style hint is
 * dropped when the text is already clear.
 */
export function friendlyTradeMessage(raw: unknown): string {
  const sanitized = publicApi2TradeError(raw).trim();
  if (!sanitized) return "";
  for (const [pattern, sentence] of PHRASES) {
    if (pattern.test(sanitized)) return sentence;
  }
  // unknown wording: kept, sanitised, and a login / credential problem keeps its own advice
  return publicTradeRejection(raw);
}

function numericCode(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function idOf(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "" || value === 0 || value === "0" || value === false) continue;
    const found = String(value).trim();
    if (found && found !== "0") return found;
  }
  return null;
}

function positive(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The fields of an order answer this file reads (`Api2TradeExecutionResponse` fits). */
export interface ExecutionResponseFields {
  ticket?: unknown;
  order?: unknown;
  orderId?: unknown;
  positionId?: unknown;
  message?: unknown;
  comment?: unknown;
  error?: unknown;
  retcode?: unknown;
  code?: unknown;
  done?: unknown;
  success?: unknown;
  volume?: unknown;
  price?: unknown;
}

/**
 * Whatever a bridge answered to an order, as fields. Close and modify answers are not
 * always objects: a bare ticket number, `true`, "OK" or a JSON text all mean something.
 */
export function readExecutionResponse(raw: unknown): ExecutionResponseFields {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "number") return raw > 0 ? { ticket: raw } : {};
  if (typeof raw === "boolean") return { success: raw };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as ExecutionResponseFields;
      } catch {
        // not JSON after all: it is a message
      }
    }
    if (/^\d+$/.test(trimmed)) return { ticket: trimmed };
    if (/^(ok|done|success|true)$/i.test(trimmed)) return { success: true };
    return { message: trimmed };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as ExecutionResponseFields;
  return {};
}

export interface ExecutionSuccess {
  ok: true;
  orderId: string | null;
  positionId: string | null;
  retcode: number | null;
  price: number | null;
  volume: number | null;
  /** e.g. "only part of the volume was executed" */
  note: string | null;
}

export interface ExecutionFailure {
  ok: false;
  /** a sentence for the person */
  message: string;
  retcode: number | null;
  /** the trade server confirmed that nothing was executed and the same request may be sent again at once */
  retry: boolean;
}

export type ExecutionOutcome = ExecutionSuccess | ExecutionFailure;

/**
 * Success or refusal of an order answer, with the reason. A ticket alone is success
 * (the answer of the Basic bridge); a return code decides when there is one; an error
 * field is always a refusal.
 */
export function evaluateExecutionResponse(response: ExecutionResponseFields): ExecutionOutcome {
  // `retcode` is a trade-server code. A bare numeric `code` counts only when it is one this file
  // knows from the MT5 table (some bridges put an HTTP-like 200 there).
  const explicit = numericCode(response.retcode);
  const fallback = numericCode(response.code);
  const retcode = explicit ?? (fallback !== null && (fallback === 0 || (fallback >= 10000 && describeTradeCode(fallback))) ? fallback : null);
  const reason = text(response.error) || text(response.comment) || text(response.message);
  const orderId = idOf(response.orderId, response.order, response.ticket);
  const positionId = idOf(response.positionId, response.ticket, response.orderId, response.order);
  const price = positive(response.price);
  const volume = positive(response.volume);

  const fail = (message: string, code: number | null, retry = false): ExecutionFailure => ({
    ok: false,
    message: message || "The broker rejected the operation.",
    retcode: code,
    retry,
  });
  const done = (code: number | null, note: string | null = null): ExecutionSuccess => ({
    ok: true,
    orderId,
    positionId,
    retcode: code,
    price,
    volume,
    note,
  });

  if (text(response.error)) {
    const description = retcode !== null ? describeTradeCode(retcode) : null;
    return fail(friendlyTradeMessage(response.error) || description?.text || "", retcode, description?.retry === true);
  }

  if (retcode !== null) {
    const description = describeTradeCode(retcode);
    if (description?.success) return done(retcode, retcode === 10010 ? description.text : null);
    if (NOTHING_CHANGED_CODES.has(retcode) && description) return done(retcode, description.text);
    if (description) return fail(description.text, retcode, description.retry);
    const own = reason ? friendlyTradeMessage(reason) : "";
    return fail(own || `The trade server refused the request (code ${retcode}).`, retcode);
  }

  if (response.success === true || response.done === true) return done(null);
  if (response.success === false || response.done === false) return fail(friendlyTradeMessage(reason), null);
  if (orderId || positionId) return done(null);
  const lowered = reason.toLowerCase();
  if (lowered.includes("done") || lowered.includes("success") || lowered.includes("placed")) return done(null);
  return fail(friendlyTradeMessage(reason), null);
}

/**
 * The reason inside a failed provider call ("Broker service request failed (400): {...}"):
 * the JSON body's message / comment / retcode, or the plain text, in words - and whether
 * the trade server said the request was certainly not executed (a requote), which makes
 * sending it again safe.
 */
export function describeProviderFailure(error: unknown): { message: string; retry: boolean } {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const afterStatus = raw.replace(/^[\s\S]*?request failed \(\d+\):\s*/i, "");
  const body = afterStatus.trim();
  if (/^<(!doctype|html)/i.test(body)) return { message: "The broker service is temporarily unavailable.", retry: false };
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const outcome = evaluateExecutionResponse({
        retcode: parsed.retcode ?? parsed.code,
        error: parsed.error,
        comment: parsed.comment,
        message: parsed.message ?? parsed.detail ?? parsed.title,
      });
      if (!outcome.ok) return { message: outcome.message, retry: outcome.retry };
    } catch {
      // a text after all
    }
  }
  const mt4 = /\b(?:error|err|code)\D{0,3}(\d{1,4})\b/i.exec(body);
  const described = mt4 ? describeTradeCode(Number(mt4[1])) : null;
  if (described && !described.success) return { message: described.text, retry: described.retry };
  return { message: friendlyTradeMessage(body || raw), retry: false };
}

export function friendlyProviderFailure(error: unknown): string {
  return describeProviderFailure(error).message;
}
