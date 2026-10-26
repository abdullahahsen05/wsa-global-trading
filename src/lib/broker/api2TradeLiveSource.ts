if (typeof window !== "undefined") {
  throw new Error("[wsa] api2TradeLiveSource is server-only.");
}

import {
  Api2TradeClient,
  loadApi2TradeConfig,
  type Api2TradeOrder,
} from "@/lib/broker/api2TradeClient";
import { classifyOrderType, orderVolumeLots, positionTicket } from "@/lib/broker/openPositions";
import { instantIso } from "@/lib/broker/orderNormalization";
import { readOrderUpdateMessage, textOfSocketMessage } from "@/lib/broker/orderUpdateMessage";

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
  /** when the message / answer that revealed the change reached this process (epoch ms) */
  detectedAt?: number;
  detectedBy?: "websocket" | "rest";
  /** OPEN only: the position was already open in the first list this source read (it was not seen opening) */
  existing?: boolean;
}

/**
 * One row of `OpenedOrders` as an open MARKET position, or null when it is not one.
 *
 * `OpenedOrders` lists pending orders (limit / stop) next to the positions. A pending
 * order is NOT a position - the master has not traded anything yet - and it used to be
 * read as one (a sell limit as a BUY!), so followers copied orders that never filled.
 * The row's direction, id and size are read by the same rules as everywhere else on the
 * platform (`openPositions.ts`); a row whose direction cannot be read is never guessed.
 */
export function mapApi2TradeOrderToLivePosition(order: Api2TradeOrder): Api2TradeLivePosition | null {
  const kind = classifyOrderType(order.orderType ?? order.type ?? order.dealType);
  if (!kind.side || kind.pending) return null;
  const id = positionTicket(order);
  if (!id) return null;
  return {
    id,
    type: kind.side === "SELL" ? "POSITION_TYPE_SELL" : "POSITION_TYPE_BUY",
    symbol: String(order.symbol ?? ""),
    volume: orderVolumeLots(order),
    openPrice: Number(order.openPrice ?? 0),
    currentPrice: Number(order.closePrice ?? 0) || undefined,
    stopLoss: order.stopLoss == null ? undefined : Number(order.stopLoss),
    takeProfit: order.takeProfit == null ? undefined : Number(order.takeProfit),
    profit: order.profit == null ? undefined : Number(order.profit),
    // The UTC epoch comes first: `openTime` / `closeTime` are broker server time. Placeholder
    // dates (epoch 0, year 1) that some bridges send for active orders are ignored.
    time: instantIso(order.openTimestampUTC, order.openTime),
    updateTime: instantIso(order.closeTimestampUTC, order.closeTime) ?? new Date().toISOString(),
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

/** The rows of an `OpenedOrders` answer: positions, pending orders (not positions) and rows nobody can read. */
export function splitOpenOrders(orders: ReadonlyArray<Api2TradeOrder>): {
  positions: Api2TradeLivePosition[];
  pending: number;
  unreadable: number;
} {
  const positions: Api2TradeLivePosition[] = [];
  let pending = 0;
  let unreadable = 0;
  for (const order of orders) {
    if (classifyOrderType(order.orderType ?? order.type ?? order.dealType).pending) {
      pending += 1;
      continue;
    }
    const position = mapApi2TradeOrderToLivePosition(order);
    if (position) positions.push(position);
    else unreadable += 1;
  }
  return { positions, pending, unreadable };
}

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** The subset of a `ws` socket this class uses. */
interface SocketLike {
  close(code?: number, reason?: string): void;
  terminate?(): void;
  ping?(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
}

/** A picture older than this is not trusted any more: a failing read is raised instead of being retried quietly. */
const STALE_PICTURE_LIMIT_MS = 6_000;
/** The safety poll found a change the WebSocket had not announced if the stream had been silent this long. */
const SILENT_STREAM_MS = 1_500;
/** After that, poll fast for this long (and again, and again, as long as the stream keeps missing changes). */
const FAST_POLL_WINDOW_MS = 10 * 60_000;
/** Every position vanishing at once is believed only when a second list says the same within this time. */
const MASS_CLOSE_CONFIRM_WINDOW_MS = 5_000;

export interface Api2TradeLiveSourceStats {
  websocket: boolean;
  /** milliseconds since the last complete list of open orders was applied */
  pictureAgeMs: number;
  fastPolling: boolean;
  consecutiveReadErrors: number;
  trackedPositions: number;
  websocketMessages: number;
  websocketSignals: number;
  websocketSnapshots: number;
  websocketIgnored: number;
  websocketEvents: number;
  restReads: number;
  restEvents: number;
  safetyMisses: number;
  /** Safety-poll-discovered changes divided by all changes this source observed. */
  safetyPollDiscoveryRate: number | null;
  lastWebsocketMessageAgeMs: number;
}

interface SnapshotResult {
  events: Api2TradePositionEvent[];
  /** every position seemed to vanish at once: nothing was applied, a second list will say */
  heldBack: boolean;
}

/**
 * One broker account as the copy engine sees it: the list of its open positions,
 * kept current by two channels and turned into OPEN / MODIFY / CLOSE events.
 *
 *  - the order-update WebSocket (instant; a message with the full list is applied
 *    directly, any other message about an order change makes the engine read the list
 *    over REST at once - `onSignal` wakes the caller);
 *  - REST polling of `OpenedOrders` as the safety net: every `API2TRADE_WS_FALLBACK_POLL_MS`
 *    (default 1 s) while the socket is up, every `API2TRADE_REST_POLL_MS` (default 400 ms)
 *    while it is down, and every `API2TRADE_FAST_POLL_MS` (default 300 ms) for ten minutes
 *    after the poll found a change the socket had not announced - a socket that says
 *    nothing is as good as no socket, and the engine then behaves like a fast poller.
 *
 * Lists are applied in the order they were TAKEN, never the order they arrived: a slow
 * REST answer must not undo a newer WebSocket list (the new trade would look closed).
 * A list that cannot be read is an error, never "no open positions", and all open
 * positions vanishing at once is confirmed by a second list before CLOSE is emitted.
 */
export class Api2TradeLiveAccountSource {
  private readonly positions = new Map<string, Api2TradeLivePosition>();
  private bufferedEvents: Api2TradePositionEvent[] = [];
  private readonly signalListeners = new Set<() => void>();

  private ws: SocketLike | null = null;
  private wsConnected = false;
  private wsConnecting: Promise<void> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 250;
  private closing = false;

  private initialized = false;
  private forceSnapshot = false;
  private snapshotInFlight: Promise<void> | null = null;
  private lastSnapshotAt = 0;
  /** when the newest applied list was taken (REST: request start, WebSocket: arrival) */
  private appliedTakenAt = 0;
  private lastWsMessageAt = 0;
  /** Heartbeats do not prove the order-update channel announced a trade. */
  private lastWsRelevantAt = 0;
  private lastWsActivityAt = 0;
  private fastPollUntil = 0;
  private consecutiveReadErrors = 0;
  private massCloseSince = 0;
  private websocketMessages = 0;
  private websocketSignals = 0;
  private websocketSnapshots = 0;
  private websocketIgnored = 0;
  private websocketEvents = 0;
  private restReads = 0;
  private restEvents = 0;
  private safetyMisses = 0;

  constructor(
    private readonly client: Api2TradeClient,
    private readonly providerAccountId: string,
  ) {}

  static fromEnv(providerAccountId: string): Api2TradeLiveAccountSource {
    const config = loadApi2TradeConfig();
    if (!config) {
      throw new Error("Broker connection service is not configured.");
    }
    return new Api2TradeLiveAccountSource(new Api2TradeClient(config), providerAccountId);
  }

  async reconnect(): Promise<void> {
    this.closing = false;
    await this.client.connectByToken(this.providerAccountId).catch(() => undefined);
    await this.client.subscribeOrderUpdate(this.providerAccountId).catch(() => undefined);
    // The socket may take its time (up to ten seconds when the server is unreachable);
    // the first list is read over REST regardless, so only a moment is spent waiting.
    const connecting = this.connectOrderUpdateWebSocket().catch(() => undefined);
    await Promise.race([connecting, new Promise<void>((resolve) => setTimeout(resolve, 1_500))]);
  }

  async readOpenPositions(): Promise<Api2TradeLivePosition[]> {
    const orders = await this.client.openedOrders(this.providerAccountId);
    return splitOpenOrders(orders).positions;
  }

  /**
   * The ids of the positions that are open right now, from two lists taken `gapMs` apart (a position
   * counts as open when either list has it). For decisions that must never rest on one list that may
   * be wrong - closing the copies of positions the source no longer has - not for following the
   * account (that is `reconcile`). A list that cannot be read is an error, never "nothing is open".
   */
  async confirmedOpenPositionIds(gapMs = 1_500): Promise<Set<string>> {
    const ids = new Set<string>();
    for (let read = 0; read < 2; read += 1) {
      if (read > 0) await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
      const split = splitOpenOrders(await this.client.openedOrdersChecked(this.providerAccountId));
      if (split.unreadable > 0 && split.positions.length === 0) {
        throw new Error("The list of open positions could not be read.");
      }
      for (const position of split.positions) ids.add(position.id);
    }
    return ids;
  }

  usingWebSocket(): boolean {
    return this.wsConnected;
  }

  stats(): Api2TradeLiveSourceStats {
    const observedEvents = this.websocketEvents + this.restEvents;
    return {
      websocket: this.wsConnected,
      pictureAgeMs: this.lastSnapshotAt ? Date.now() - this.lastSnapshotAt : -1,
      fastPolling: Date.now() < this.fastPollUntil,
      consecutiveReadErrors: this.consecutiveReadErrors,
      trackedPositions: this.positions.size,
      websocketMessages: this.websocketMessages,
      websocketSignals: this.websocketSignals,
      websocketSnapshots: this.websocketSnapshots,
      websocketIgnored: this.websocketIgnored,
      websocketEvents: this.websocketEvents,
      restReads: this.restReads,
      restEvents: this.restEvents,
      safetyMisses: this.safetyMisses,
      safetyPollDiscoveryRate: observedEvents > 0 ? this.safetyMisses / observedEvents : null,
      lastWebsocketMessageAgeMs: this.lastWsMessageAt ? Date.now() - this.lastWsMessageAt : -1,
    };
  }

  /** Called as soon as the WebSocket reports something worth reading now. Returns the way to stop listening. */
  onSignal(listener: () => void): () => void {
    this.signalListeners.add(listener);
    return () => {
      this.signalListeners.delete(listener);
    };
  }

  private signal(): void {
    for (const listener of this.signalListeners) {
      try {
        listener();
      } catch {
        // a listener must never break the stream
      }
    }
  }

  // ── polling intervals ──────────────────────────────────────────────────────

  private shouldUseWebSocket(): boolean {
    return process.env.API2TRADE_WEBSOCKET_ENABLED !== "false";
  }

  /** Safety poll while the socket is up. */
  private fallbackPollMs(): number {
    return numberFromEnv("API2TRADE_WS_FALLBACK_POLL_MS", 1_000, 250, 60_000);
  }

  /** Poll while the socket is down: REST is then the only way to see a trade. */
  private restPollMs(): number {
    return numberFromEnv("API2TRADE_REST_POLL_MS", 400, 100, 60_000);
  }

  private fastPollMs(): number {
    return numberFromEnv("API2TRADE_FAST_POLL_MS", 300, 100, 60_000);
  }

  private pollIntervalMs(now: number): number {
    if (!this.shouldUseWebSocket() || !this.wsConnected) return this.restPollMs();
    return now < this.fastPollUntil ? this.fastPollMs() : this.fallbackPollMs();
  }

  private shouldPoll(now: number): boolean {
    if (!this.initialized || this.forceSnapshot) return true;
    return now - this.lastSnapshotAt >= this.pollIntervalMs(now);
  }

  // ── applying a list of open orders ─────────────────────────────────────────

  private applySnapshot(
    orders: Api2TradeOrder[],
    takenAt: number,
    arrivedAt: number,
    options: { emitExistingAsOpen?: boolean; detectedBy?: "websocket" | "rest" } = {},
  ): SnapshotResult {
    // taken before the list that is already applied: a newer picture exists, drop this one
    if (takenAt < this.appliedTakenAt) return { events: [], heldBack: false };

    // Pending orders are not positions; a list of nothing but pending orders is a valid list
    // with no position in it. Rows that are neither cannot be told apart: if no position can
    // be read from them the list is an error, never "nothing is open".
    const split = splitOpenOrders(orders);
    if (split.unreadable > 0 && split.positions.length === 0) {
      throw new Error("The list of open positions could not be read.");
    }
    const current = new Map(split.positions.map((position) => [position.id, position]));

    if (this.initialized && current.size === 0 && this.positions.size >= 2) {
      if (this.massCloseSince === 0 || arrivedAt - this.massCloseSince > MASS_CLOSE_CONFIRM_WINDOW_MS) {
        this.massCloseSince = arrivedAt;
        return { events: [], heldBack: true };
      }
    }
    this.massCloseSince = 0;

    const events: Api2TradePositionEvent[] = [];
    for (const [id, position] of current) {
      const previous = this.positions.get(id);
      if (!previous) {
        if (this.initialized) {
          events.push({ eventType: "OPEN", position, detectedAt: arrivedAt, detectedBy: options.detectedBy });
        } else if (options.emitExistingAsOpen) {
          events.push({ eventType: "OPEN", position, detectedAt: arrivedAt, detectedBy: options.detectedBy, existing: true });
        }
        continue;
      }
      if (api2TradePositionChanged(previous, position)) {
        events.push({ eventType: "MODIFY", position, previous, detectedAt: arrivedAt, detectedBy: options.detectedBy });
      }
    }
    for (const [id, previous] of this.positions) {
      if (!current.has(id)) events.push({ eventType: "CLOSE", position: previous, detectedAt: arrivedAt, detectedBy: options.detectedBy });
    }

    this.positions.clear();
    for (const [id, position] of current) this.positions.set(id, position);
    this.initialized = true;
    this.appliedTakenAt = takenAt;
    this.lastSnapshotAt = arrivedAt;
    return { events, heldBack: false };
  }

  /** One REST read of the list. Returns the events it revealed. */
  private async pollSnapshot(options: { emitExistingAsOpen?: boolean }): Promise<Api2TradePositionEvent[]> {
    if (this.snapshotInFlight) {
      // somebody else is reading the list already: wait for it, its events are theirs
      await this.snapshotInFlight;
      return [];
    }
    let finished: () => void = () => undefined;
    this.snapshotInFlight = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const forced = this.forceSnapshot;
    this.forceSnapshot = false;
    try {
      const collected: Api2TradePositionEvent[] = [];
      // a held-back "everything closed" is checked once more straight away
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const takenAt = Date.now();
        const orders = await this.client.openedOrdersChecked(this.providerAccountId);
        this.restReads += 1;
        const arrivedAt = Date.now();
        const result = this.applySnapshot(orders, takenAt, arrivedAt, { ...options, detectedBy: "rest" });
        this.restEvents += result.events.length;
        this.consecutiveReadErrors = 0;
        collected.push(...result.events);
        this.noteSafetyPollResult(result.events.length, forced, arrivedAt);
        if (!result.heldBack) break;
      }
      return collected;
    } catch (error) {
      this.consecutiveReadErrors += 1;
      this.forceSnapshot = true;
      // One failed read of a picture that is still fresh must not tear the stream down.
      if (this.initialized && Date.now() - this.lastSnapshotAt < STALE_PICTURE_LIMIT_MS) return [];
      throw error;
    } finally {
      this.snapshotInFlight = null;
      finished();
    }
  }

  /** A safety poll that finds a change the quiet socket never mentioned means the socket cannot be relied on. */
  private noteSafetyPollResult(eventCount: number, forced: boolean, now: number): void {
    if (eventCount === 0 || forced || !this.wsConnected) return;
    const missedByOrderChannel = now - this.lastWsRelevantAt > SILENT_STREAM_MS;
    if (missedByOrderChannel) this.safetyMisses += eventCount;
    // The stricter rule may increase REST traffic for every affected account. Stage it
    // behind a flag until demo-stream completeness and provider load are measured.
    const strict = process.env.API2TRADE_STRICT_ORDER_STREAM === "true";
    if (now - (strict ? this.lastWsRelevantAt : this.lastWsMessageAt) <= SILENT_STREAM_MS) return;
    if (now >= this.fastPollUntil) {
      console.warn(
        `[api2trade] the order stream did not announce a change that the safety poll found; polling every ${this.fastPollMs()}ms for the next ${Math.round(FAST_POLL_WINDOW_MS / 60_000)} minutes.`,
      );
    }
    this.fastPollUntil = now + FAST_POLL_WINDOW_MS;
  }

  /**
   * The events since the last call. Reads the list over REST when it is due (first call,
   * a signal from the socket, or the polling interval) and returns whatever the socket
   * has already delivered.
   */
  async reconcile(options: { emitExistingAsOpen?: boolean } = {}): Promise<Api2TradePositionEvent[]> {
    // a socket that is down and nobody is rebuilding (normally scheduled already): rebuild it, with backoff
    if (this.shouldUseWebSocket() && !this.wsConnected && !this.wsConnecting) this.scheduleReconnect();

    const events = this.bufferedEvents.splice(0);
    if (this.shouldPoll(Date.now())) events.push(...(await this.pollSnapshot(options)));
    return events;
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  /** One message of the stream (public so it can be tested without a socket). */
  ingestSocketMessage(text: string): void {
    const arrivedAt = Date.now();
    this.websocketMessages += 1;
    this.lastWsMessageAt = arrivedAt;
    this.lastWsActivityAt = arrivedAt;
    const message = readOrderUpdateMessage(text);
    if (message.kind === "ignore") {
      this.websocketIgnored += 1;
      return;
    }
    this.lastWsRelevantAt = arrivedAt;

    if (message.kind === "snapshot" && this.initialized) {
      try {
        this.websocketSnapshots += 1;
        const result = this.applySnapshot(message.orders, arrivedAt, arrivedAt, { detectedBy: "websocket" });
        this.websocketEvents += result.events.length;
        if (result.events.length > 0) this.bufferedEvents.push(...result.events);
        if (result.heldBack) this.forceSnapshot = true;
        if (result.events.length > 0 || result.heldBack) this.signal();
        return;
      } catch {
        // an unreadable list: the REST answer decides
      }
    }
    // A signal, a list that could not be used, or a list before the first REST read.
    this.websocketSignals += 1;
    this.forceSnapshot = true;
    this.signal();
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.closing || !this.shouldUseWebSocket() || this.reconnectTimer || this.wsConnecting || this.wsConnected) return;
    const delay = delayMs ?? this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(5_000, Math.max(250, this.reconnectDelayMs * 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOrderUpdateWebSocket().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private connectOrderUpdateWebSocket(): Promise<void> {
    if (!this.shouldUseWebSocket() || this.closing) return Promise.resolve();
    if (this.wsConnected) return Promise.resolve();
    if (this.wsConnecting) return this.wsConnecting;

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
      const socket = new WebSocketCtor(url, { headers }) as unknown as SocketLike;
      // an 'error' event with nobody listening would crash the process: the handlers below come and go
      socket.on("error", (() => undefined) as (...args: never[]) => void);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          try {
            socket.terminate?.();
          } catch {}
          reject(new Error("Live order update stream timed out."));
        }, 10_000);
        socket.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.once("error", ((error: Error) => {
          clearTimeout(timeout);
          reject(error);
        }) as (...args: never[]) => void);
      });

      if (this.closing) {
        try {
          socket.close();
        } catch {}
        return;
      }
      this.attachSocket(socket);
    })()
      .catch((error: unknown) => {
        this.wsConnected = false;
        throw error;
      })
      .finally(() => {
        this.wsConnecting = null;
        // not connected after all: try again later (with backoff)
        if (!this.wsConnected) this.scheduleReconnect();
      });

    return this.wsConnecting;
  }

  private attachSocket(socket: SocketLike): void {
    this.ws = socket;
    this.wsConnected = true;
    this.lastWsActivityAt = Date.now();
    this.reconnectDelayMs = 250;

    const lost = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.wsConnected = false;
      this.stopLiveness();
      // the picture may have missed changes while the socket was down: poll fast until it is back
      this.forceSnapshot = true;
      this.scheduleReconnect();
    };
    socket.on("message", ((message: Buffer | ArrayBuffer | Buffer[] | string) => {
      this.ingestSocketMessage(textOfSocketMessage(message));
    }) as (...args: never[]) => void);
    socket.on("pong", (() => {
      this.lastWsActivityAt = Date.now();
    }) as (...args: never[]) => void);
    socket.on("close", lost as (...args: never[]) => void);
    socket.on("error", lost as (...args: never[]) => void);
    this.startLiveness(socket);

    // whatever happened between the last list and this connection is read now
    this.forceSnapshot = true;
    this.signal();
  }

  /**
   * A socket can die without a word (a dropped route, a proxy that forgot the
   * connection) and then looks connected forever. Pings keep it honest; silence for
   * `API2TRADE_WS_SILENCE_MS` (default 75 s, 0 = off) ends the connection so that it is
   * rebuilt.
   */
  private startLiveness(socket: SocketLike): void {
    this.stopLiveness();
    const silenceMs = numberFromEnv("API2TRADE_WS_SILENCE_MS", 75_000, 0, 600_000);
    if (silenceMs === 0) return;
    this.livenessTimer = setInterval(() => {
      if (this.ws !== socket) return;
      if (Date.now() - this.lastWsActivityAt > silenceMs) {
        try {
          if (socket.terminate) socket.terminate();
          else socket.close();
        } catch {}
        return;
      }
      try {
        socket.ping?.();
      } catch {}
    }, 20_000);
    this.livenessTimer.unref?.();
  }

  private stopLiveness(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.stopLiveness();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.ws;
    this.ws = null;
    this.wsConnected = false;
    if (socket) {
      try {
        socket.close();
      } catch {}
    }
    this.wsConnecting = null;
    this.forceSnapshot = false;
    this.bufferedEvents = [];
    this.signalListeners.clear();
    this.positions.clear();
    this.initialized = false;
    this.appliedTakenAt = 0;
    this.massCloseSince = 0;
  }
}
