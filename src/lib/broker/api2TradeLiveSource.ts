if (typeof window !== "undefined") {
  throw new Error("[wsa] api2TradeLiveSource is server-only.");
}

import {
  Api2TradeClient,
  loadApi2TradeConfig,
  type Api2TradeOrder,
  type Api2TradeOrderUpdateSummary,
} from "@/lib/broker/api2TradeClient";

export type Api2TradeLivePosition = {
  id: string;
  type: "POSITION_TYPE_BUY" | "POSITION_TYPE_SELL";
  symbol: string;
  volume: number;
  openPrice: number;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  profit?: number;
  time?: string;
  updateTime?: string;
  raw: Api2TradeOrder;
};

export type Api2TradePositionEventType = "OPEN" | "MODIFY" | "CLOSE";

export interface Api2TradePositionEvent {
  eventType: Api2TradePositionEventType;
  position: Api2TradeLivePosition;
  previous?: Api2TradeLivePosition;
}

function sideFromOrder(order: Api2TradeOrder): "POSITION_TYPE_BUY" | "POSITION_TYPE_SELL" {
  const value = order.orderType ?? order.type ?? order.dealType;
  if (value === 1 || value === "1") return "POSITION_TYPE_SELL";
  const normalized = String(value ?? "").toUpperCase();
  return normalized.includes("SELL") ? "POSITION_TYPE_SELL" : "POSITION_TYPE_BUY";
}

function readVolume(order: Api2TradeOrder): number {
  const raw = Number(order.lots ?? order.volume ?? 0);
  if (order.lots == null && raw >= 100) return raw / 10_000;
  return raw;
}

function safeDate(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const date = typeof value === "number"
    ? new Date(value > 100_000_000_000 ? value : value * 1000)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  // Some MT bridges return sentinel/zero dates for active orders. Postgres
  // rejects year 0000, so ignore anything before normal retail MT history.
  if (date.getUTCFullYear() < 2000) return undefined;
  return date.toISOString();
}

function orderId(order: Api2TradeOrder): string {
  return String(order.positionId ?? order.ticket ?? order.orderId ?? order.id ?? "");
}

export function mapApi2TradeOrderToLivePosition(order: Api2TradeOrder): Api2TradeLivePosition | null {
  const id = orderId(order);
  if (!id) return null;
  return {
    id,
    type: sideFromOrder(order),
    symbol: String(order.symbol ?? ""),
    volume: readVolume(order),
    openPrice: Number(order.openPrice ?? 0),
    currentPrice: Number(order.closePrice ?? 0) || undefined,
    stopLoss: order.stopLoss == null ? undefined : Number(order.stopLoss),
    takeProfit: order.takeProfit == null ? undefined : Number(order.takeProfit),
    profit: order.profit == null ? undefined : Number(order.profit),
    time: safeDate(order.openTime ?? order.openTimestampUTC),
    updateTime: safeDate(order.closeTime ?? order.closeTimestampUTC) ?? new Date().toISOString(),
    raw: order,
  };
}

export function api2TradePositionChanged(
  previous: Api2TradeLivePosition,
  current: Api2TradeLivePosition,
): boolean {
  return Number(previous.volume) !== Number(current.volume)
    || Number(previous.stopLoss ?? 0) !== Number(current.stopLoss ?? 0)
    || Number(previous.takeProfit ?? 0) !== Number(current.takeProfit ?? 0);
}

export class Api2TradeLiveAccountSource {
  private readonly positions = new Map<string, Api2TradeLivePosition>();
  private readonly bufferedEvents: Api2TradePositionEvent[] = [];
  private ws: { close(code?: number, reason?: string): void; readyState?: number } | null = null;
  private wsConnected = false;
  private wsConnecting: Promise<void> | null = null;
  private lastSnapshotAt = 0;
  private lastWebSocketAttemptAt = 0;
  private forceSnapshotOnNextReconcile = false;
  private initialized = false;

  constructor(
    private readonly client: Api2TradeClient,
    private readonly providerAccountId: string,
  ) {}

  static fromEnv(providerAccountId: string): Api2TradeLiveAccountSource {
    const config = loadApi2TradeConfig();
    if (!config) {
      throw new Error("API2Trade is not configured.");
    }
    return new Api2TradeLiveAccountSource(new Api2TradeClient(config), providerAccountId);
  }

  async reconnect(): Promise<void> {
    await this.client.connectByToken(this.providerAccountId).catch(() => undefined);
    await this.client.subscribeOrderUpdate(this.providerAccountId).catch(() => undefined);
    await this.connectOrderUpdateWebSocket().catch(() => undefined);
  }

  async readOpenPositions(): Promise<Api2TradeLivePosition[]> {
    const orders = await this.client.openedOrders(this.providerAccountId);
    return orders
      .map(mapApi2TradeOrderToLivePosition)
      .filter((position): position is Api2TradeLivePosition => Boolean(position));
  }

  usingWebSocket(): boolean {
    return this.wsConnected;
  }

  private shouldUseWebSocket(): boolean {
    return process.env.API2TRADE_WEBSOCKET_ENABLED !== "false";
  }

  private fallbackPollMs(): number {
    const parsed = Number.parseInt(process.env.API2TRADE_WS_FALLBACK_POLL_MS ?? "2000", 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 2_000;
  }

  private async connectOrderUpdateWebSocket(): Promise<void> {
    if (!this.shouldUseWebSocket()) return;
    if (this.wsConnected || this.wsConnecting) return this.wsConnecting ?? Promise.resolve();
    const now = Date.now();
    if (now - this.lastWebSocketAttemptAt < 5_000) return;
    this.lastWebSocketAttemptAt = now;
    const auth = this.client.basicAuthValue();
    const headers: Record<string, string> = {};
    if (auth) {
      headers.Authorization = auth;
    } else {
      const authHeaders = this.client.authHeaders();
      if (authHeaders instanceof Headers) {
        authHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(authHeaders)) {
        for (const [key, value] of authHeaders) headers[key] = value;
      } else {
        Object.assign(headers, authHeaders as Record<string, string>);
      }
    }
    const url = this.client.eventsUrl("/OnOrderUpdate", { id: this.providerAccountId });

    this.wsConnecting = (async () => {
      const wsModule = await import("ws");
      const WebSocketCtor = wsModule.default;
      const socket = new WebSocketCtor(url, {
        headers,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          try {
            socket.close();
          } catch {}
          reject(new Error("API2Trade order update websocket timed out."));
        }, 10_000);

        socket.once("open", () => {
          clearTimeout(timeout);
          this.ws = socket;
          this.wsConnected = true;
          resolve();
        });
        socket.once("error", (error: Error) => {
          clearTimeout(timeout);
          this.wsConnected = false;
          reject(error);
        });
      });

      socket.on("message", (message: Buffer | ArrayBuffer | Buffer[] | string) => {
        const parsed = this.eventsFromWebSocketMessage(message);
        const events = parsed.events;
        if (events.length > 0) this.bufferedEvents.push(...events);
        if (parsed.requiresSnapshot) this.forceSnapshotOnNextReconcile = true;
      });
      socket.on("close", () => {
        this.wsConnected = false;
        if (this.ws === socket) this.ws = null;
      });
      socket.on("error", () => {
        this.wsConnected = false;
        if (this.ws === socket) this.ws = null;
      });
    })().finally(() => {
      this.wsConnecting = null;
    });

    return this.wsConnecting;
  }

  private eventsFromWebSocketMessage(message: Buffer | ArrayBuffer | Buffer[] | string): {
    events: Api2TradePositionEvent[];
    requiresSnapshot: boolean;
  } {
    const text = Array.isArray(message)
      ? Buffer.concat(message).toString("utf8")
      : Buffer.isBuffer(message)
        ? message.toString("utf8")
        : message instanceof ArrayBuffer
          ? Buffer.from(message).toString("utf8")
          : String(message);
    if (!text.trim() || text.trim().toUpperCase() === "OK") {
      return { events: [], requiresSnapshot: false };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { events: [], requiresSnapshot: false };
    }
    const summary = payload as Api2TradeOrderUpdateSummary;
    if (Array.isArray(summary.openedOrders)) {
      return { events: this.eventsFromSnapshot(summary.openedOrders), requiresSnapshot: false };
    }

    // Some API2Trade installations can emit only the update payload. In that
    // case we do not guess open/close state from one order row; the next worker
    // tick immediately reconciles the authoritative open-order snapshot.
    return { events: [], requiresSnapshot: Boolean(summary.update) };
  }

  private eventsFromSnapshot(orders: Api2TradeOrder[], options: { emitExistingAsOpen?: boolean } = {}): Api2TradePositionEvent[] {
    const currentPositions = orders
      .map(mapApi2TradeOrderToLivePosition)
      .filter((position): position is Api2TradeLivePosition => Boolean(position));
    const current = new Map(currentPositions.map((position) => [position.id, position]));
    const events: Api2TradePositionEvent[] = [];

    for (const [id, position] of current) {
      const previous = this.positions.get(id);
      if (!previous) {
        if (this.initialized || options.emitExistingAsOpen) {
          events.push({ eventType: "OPEN", position });
        }
        continue;
      }
      if (api2TradePositionChanged(previous, position)) {
        events.push({ eventType: "MODIFY", position, previous });
      }
    }

    for (const [id, previous] of this.positions) {
      if (!current.has(id)) {
        events.push({ eventType: "CLOSE", position: previous });
      }
    }

    this.positions.clear();
    for (const [id, position] of current) this.positions.set(id, position);
    this.initialized = true;
    this.lastSnapshotAt = Date.now();
    return events;
  }

  async reconcile(options: { emitExistingAsOpen?: boolean } = {}): Promise<Api2TradePositionEvent[]> {
    if (this.shouldUseWebSocket() && !this.wsConnected) {
      await this.connectOrderUpdateWebSocket().catch(() => undefined);
    }

    const events = this.bufferedEvents.splice(0);
    const shouldPoll = !this.initialized
      || !this.wsConnected
      || this.forceSnapshotOnNextReconcile
      || Date.now() - this.lastSnapshotAt >= this.fallbackPollMs();

    if (shouldPoll) {
      this.forceSnapshotOnNextReconcile = false;
      const orders = await this.client.openedOrders(this.providerAccountId);
      events.push(...this.eventsFromSnapshot(orders, options));
    }

    return events;
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
    this.ws = null;
    this.wsConnected = false;
    this.wsConnecting = null;
    this.forceSnapshotOnNextReconcile = false;
    this.bufferedEvents.length = 0;
    this.positions.clear();
    this.initialized = false;
  }
}
