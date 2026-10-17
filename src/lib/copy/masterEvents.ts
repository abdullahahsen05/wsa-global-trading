/**
 * Master events: the row the copy worker writes when a master account's position
 * opens, changes or closes, and the rules for writing it. Pure (the database client is
 * passed in); shared with the AWS workers.
 */

export type MasterPosition = {
  id: string | number;
  type: string;
  symbol: string;
  volume: number;
  openPrice: number;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  time?: Date | string;
  updateTime?: Date | string;
};

export interface DetectedPositionEvent {
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  position: MasterPosition;
  previous?: MasterPosition;
  /** when the change reached this process (epoch ms) */
  detectedAt?: number;
  /** found in the first list after the stream opened, not seen while it was opening */
  existing?: boolean;
}

export interface MasterEventStrategy {
  id: string;
  master_account_id: string;
}

/** What the copy engine needs of a stored master event (the same shape as `LinkedEvent`, without the id). */
export interface MasterEventPayload {
  strategy_id: string;
  event_type: "OPEN" | "MODIFY" | "CLOSE";
  master_trade_id: string;
  symbol: string;
  side: string;
  volume: number;
  previous_volume: number | null;
  open_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  event_time: string;
}

export interface BuiltMasterEvent {
  /** the row for `copy_master_events` */
  insert: Record<string, unknown>;
  dedupeKey: string;
  linked: MasterEventPayload;
}

/** An instant as ISO text; an unusable value (missing, invalid, before the year 2000) is "now". */
export function instantOrNow(value?: Date | string, now: number = Date.now()): string {
  if (!value) return new Date(now).toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) {
    return new Date(now).toISOString();
  }
  return date.toISOString();
}

export function buildMasterEvent(
  strategy: MasterEventStrategy,
  event: DetectedPositionEvent,
  options: { liveBrokerSource: boolean; now?: number },
): BuiltMasterEvent {
  const { eventType, position, previous } = event;
  const now = options.now ?? Date.now();
  const positionId = String(position.id);
  // A position that was already open when the stream started is stamped with the time it
  // really opened, so a follower who copies "new trades only" does not receive trades that
  // predate their setup. A change seen live is stamped with the moment it was seen.
  const eventTime = event.existing
    ? instantOrNow(position.time ?? position.updateTime, now)
    : instantOrNow(position.updateTime ?? position.time, now);
  const fingerprint =
    eventType === "MODIFY"
      ? `${eventTime}:${position.volume}:${position.stopLoss ?? ""}:${position.takeProfit ?? ""}`
      : eventType;
  const dedupeKey = `${strategy.id}:${positionId}:${fingerprint}`;
  const side = position.type === "POSITION_TYPE_SELL" ? "SELL" : "BUY";
  const volume = Number(position.volume ?? 0);
  const previousVolume = previous ? Number(previous.volume ?? 0) : null;
  const openPrice = Number(position.openPrice ?? 0);
  return {
    dedupeKey,
    insert: {
      strategy_id: strategy.id,
      master_account_id: strategy.master_account_id,
      event_type: eventType,
      master_trade_id: positionId,
      symbol: position.symbol,
      side,
      volume,
      previous_volume: previousVolume,
      open_price: openPrice,
      close_price: eventType === "CLOSE" ? Number(position.currentPrice ?? 0) : null,
      stop_loss: position.stopLoss ?? null,
      take_profit: position.takeProfit ?? null,
      event_time: eventTime,
      dedupe_key: dedupeKey,
      source_sequence: fingerprint,
      source: options.liveBrokerSource ? "LIVE_BROKER_SOURCE" : "WSA_STREAM",
      raw_payload: { source: options.liveBrokerSource ? "LIVE_BROKER_SOURCE" : "BROKER_STREAM", eventType },
    },
    linked: {
      strategy_id: strategy.id,
      event_type: eventType,
      master_trade_id: positionId,
      symbol: position.symbol,
      side,
      volume,
      previous_volume: previousVolume,
      open_price: openPrice,
      stop_loss: position.stopLoss ?? null,
      take_profit: position.takeProfit ?? null,
      event_time: eventTime,
    },
  };
}

/** How long a freshly opened trade had been open when this process noticed it (null = unknown). */
export function openedBeforeDetectionMs(event: DetectedPositionEvent, detectedAt: number): number | null {
  if (event.eventType !== "OPEN" || event.existing || !event.position.time) return null;
  const openedAt =
    event.position.time instanceof Date ? event.position.time.getTime() : new Date(event.position.time).getTime();
  const age = detectedAt - openedAt;
  return Number.isFinite(age) && age >= -2_000 && age < 600_000 ? Math.max(0, age) : null;
}

/** The part of the Supabase client the store uses (typed loosely: the real client's generics do not fit a small interface). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MasterEventDatabase = { from: (table: string) => any };

export interface StoreMasterEventOptions {
  /** pauses before each new attempt; its length is the number of retries */
  retryDelaysMs?: readonly number[];
  wait?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, message: string) => void;
}

export const DEFAULT_STORE_RETRY_DELAYS_MS: readonly number[] = [150, 600, 2_000];

/**
 * Stores the master event. Returns its id, or null when it was stored before (the same
 * trade seen again, for instance after a restart). A failing insert is tried again a few
 * times - the copy must not be lost because of one dropped database call - and the last
 * failure is thrown.
 *
 * A duplicate-key answer means "stored before" on the first attempt. After a failed
 * attempt the row may be our own (stored although the answer was lost) and must still
 * be copied: its id is looked up and returned (the (event, follower) uniqueness of the
 * copy links makes a second run of the copy harmless).
 */
export async function storeMasterEvent(
  db: MasterEventDatabase,
  built: BuiltMasterEvent,
  options: StoreMasterEventOptions = {},
): Promise<string | null> {
  const delays = options.retryDelaysMs ?? DEFAULT_STORE_RETRY_DELAYS_MS;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    let failure: { code?: string; message: string };
    try {
      const { data, error } = await db.from("copy_master_events").insert(built.insert).select("id").single();
      if (!error && data) return String(data.id);
      failure = error
        ? { code: (error as { code?: string }).code, message: String((error as { message?: string }).message ?? "unknown error") }
        : { message: "no row was returned" };
    } catch (error) {
      failure = { message: error instanceof Error ? error.message : "unknown error" };
    }
    if (failure.code === "23505") {
      if (attempt === 0) return null;
      const { data: existing } = await db
        .from("copy_master_events")
        .select("id")
        .eq("dedupe_key", built.dedupeKey)
        .maybeSingle();
      return existing ? String(existing.id) : null;
    }
    if (attempt >= delays.length) {
      throw new Error(`Master event could not be stored: ${failure.message}`);
    }
    options.onRetry?.(attempt + 1, failure.message);
    await wait(delays[attempt]);
  }
}
