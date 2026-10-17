/**
 * What one message of the broker service's order-update stream means for the copy
 * engine. Pure (no sockets), shared with the AWS copy worker.
 *
 * Only two things matter to the engine:
 *  - a message that carries the COMPLETE list of open orders (`openedOrders`) is a
 *    snapshot and can be applied at once, without a REST call;
 *  - any other message that talks about an order changing is a SIGNAL: something has
 *    happened, ask the REST API for the list right now.
 * Everything else (empty frames, "OK", heartbeats, account figures without an order)
 * is ignored. The keys are matched in lower case, because a .NET bridge may send
 * `OpenedOrders` where the typings say `openedOrders`.
 *
 * Before this, every shape other than `openedOrders` / `update` was dropped, so a
 * stream in an unexpected format delivered nothing and the engine only noticed a
 * trade at its two-second safety poll.
 */

import type { Api2TradeOrder } from "@/lib/broker/api2TradeClient";

export type OrderUpdateMessage =
  | { kind: "ignore" }
  | { kind: "signal" }
  | { kind: "snapshot"; orders: Api2TradeOrder[] };

const IGNORED_TEXTS = new Set(["ok", "ping", "pong", "heartbeat", "hello", "connected", "subscribed", "null", "[]", "{}"]);

/** Keys of a message that report an order / position change. */
const CHANGE_KEYS = new Set([
  "update",
  "order",
  "orders",
  "ticket",
  "positionid",
  "orderid",
  "closebyticket",
  "deal",
  "trans",
  "action",
  "event",
  "eventtype",
  "trade",
  "trades",
  "position",
  "positions",
]);

function lowerKeys(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key.toLowerCase()] = entry;
  return result;
}

export function readOrderUpdateMessage(text: string): OrderUpdateMessage {
  const trimmed = text.trim();
  if (!trimmed || IGNORED_TEXTS.has(trimmed.toLowerCase())) return { kind: "ignore" };

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return { kind: "ignore" };
  }

  // A bare array of orders may be the whole list or only the changed rows: not safe to
  // apply as a snapshot, but certainly a reason to ask.
  if (Array.isArray(payload)) return payload.length > 0 ? { kind: "signal" } : { kind: "ignore" };
  if (typeof payload !== "object" || payload === null) return { kind: "ignore" };

  const fields = lowerKeys(payload as Record<string, unknown>);
  if (Array.isArray(fields.openedorders)) {
    return { kind: "snapshot", orders: fields.openedorders as Api2TradeOrder[] };
  }
  for (const key of Object.keys(fields)) {
    if (!CHANGE_KEYS.has(key)) continue;
    const entry = fields[key];
    // `update: null` / `order: {}` say nothing happened
    if (entry === null || entry === undefined || entry === "") continue;
    if (typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry as object).length === 0) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    return { kind: "signal" };
  }
  return { kind: "ignore" };
}

/** Text of a raw `ws` message (string, Buffer, ArrayBuffer or a list of Buffers). */
export function textOfSocketMessage(message: Buffer | ArrayBuffer | Buffer[] | string): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return Buffer.concat(message).toString("utf8");
  if (Buffer.isBuffer(message)) return message.toString("utf8");
  return Buffer.from(message).toString("utf8");
}
