import { describe, expect, test } from "vitest";
import { readOrderUpdateMessage, textOfSocketMessage } from "@/lib/broker/orderUpdateMessage";

describe("readOrderUpdateMessage", () => {
  test.each([
    ["an empty frame", ""],
    ["only blanks", "   "],
    ["OK", "OK"],
    ["ping", "ping"],
    ["Pong in other case", "Pong"],
    ["a heartbeat word", "heartbeat"],
    ["text that is not JSON", "hello there, world"],
    ["a broken JSON", "{\"update\": "],
    ["null", "null"],
    ["an empty object", "{}"],
    ["an empty array", "[]"],
    ["a bare number", "42"],
    ["a bare string", "\"x\""],
    ["account figures without an order", JSON.stringify({ balance: 1000, equity: 1001 })],
    ["an update that says nothing", JSON.stringify({ update: null })],
    ["an empty order object", JSON.stringify({ order: {} })],
    ["an empty orders list", JSON.stringify({ orders: [] })],
    ["an empty string ticket", JSON.stringify({ ticket: "" })],
  ])("ignores %s", (_label, text) => {
    expect(readOrderUpdateMessage(text)).toEqual({ kind: "ignore" });
  });

  test("a message with the full list of open orders is a snapshot", () => {
    const orders = [{ ticket: 1, symbol: "EURUSD" }, { ticket: 2, symbol: "XAUUSD" }];
    expect(readOrderUpdateMessage(JSON.stringify({ openedOrders: orders }))).toEqual({
      kind: "snapshot",
      orders,
    });
  });

  test("an empty list of open orders is a snapshot too (everything was closed)", () => {
    expect(readOrderUpdateMessage(JSON.stringify({ openedOrders: [] }))).toEqual({ kind: "snapshot", orders: [] });
  });

  test("the key is matched in any case", () => {
    const orders = [{ ticket: 7 }];
    expect(readOrderUpdateMessage(JSON.stringify({ OpenedOrders: orders }))).toEqual({ kind: "snapshot", orders });
    expect(readOrderUpdateMessage(JSON.stringify({ OPENEDORDERS: orders }))).toEqual({ kind: "snapshot", orders });
  });

  test("the list wins when it comes together with an update", () => {
    const orders = [{ ticket: 1 }];
    const message = readOrderUpdateMessage(JSON.stringify({ update: { ticket: 1 }, openedOrders: orders }));
    expect(message.kind).toBe("snapshot");
  });

  test.each([
    ["an update object", { update: { ticket: 55, action: "Open" } }],
    ["a bare order", { order: { ticket: 5 } }],
    ["a ticket", { ticket: 12345 }],
    ["a position id", { positionId: 99 }],
    ["an order id in other case", { OrderId: 77 }],
    ["an action", { action: "Close" }],
    ["an event type", { eventType: "OrderOpen" }],
    ["a deal", { deal: { id: 1 } }],
    ["a position", { position: { id: 1 } }],
    ["a trades list", { trades: [{ id: 1 }] }],
  ])("a message with %s is a signal to read the list", (_label, payload) => {
    expect(readOrderUpdateMessage(JSON.stringify(payload))).toEqual({ kind: "signal" });
  });

  test("a bare non-empty array is a signal, never a snapshot (it may hold only the changed rows)", () => {
    expect(readOrderUpdateMessage(JSON.stringify([{ ticket: 1 }]))).toEqual({ kind: "signal" });
  });

  test("a change key next to empty ones still counts", () => {
    expect(readOrderUpdateMessage(JSON.stringify({ update: null, order: {}, ticket: 5 }))).toEqual({ kind: "signal" });
  });

  test("blanks around the message are ignored", () => {
    expect(readOrderUpdateMessage(`  \n${JSON.stringify({ ticket: 5 })}\n `)).toEqual({ kind: "signal" });
  });
});

describe("textOfSocketMessage", () => {
  test("passes a string through", () => {
    expect(textOfSocketMessage("abc")).toBe("abc");
  });

  test("decodes a Buffer", () => {
    expect(textOfSocketMessage(Buffer.from("héllo", "utf8"))).toBe("héllo");
  });

  test("joins a list of Buffers", () => {
    expect(textOfSocketMessage([Buffer.from("{\"tic"), Buffer.from("ket\":1}")])).toBe("{\"ticket\":1}");
  });

  test("decodes an ArrayBuffer", () => {
    const bytes = new TextEncoder().encode("{\"ticket\":2}");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(textOfSocketMessage(buffer)).toBe("{\"ticket\":2}");
  });
});
