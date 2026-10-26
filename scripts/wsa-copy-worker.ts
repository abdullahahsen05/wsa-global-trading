import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueJob } from "../src/lib/services/backgroundJobService";
import { runWorkerOnce } from "../src/lib/workers/jobProcessor";
import { executeCopyForEvent, warmCopyStrategyAccounts, type CopyEventTrace, type LinkedEvent } from "../src/lib/services/copyTradingService";
import { closeVanishedSelfCopyPositions, executeSelfCopyPositionEvent } from "../src/lib/services/selfCopyService";
import {
  flushSelfCopyActivity,
  loadSelfCopyRouteEntries,
  loadSourcesWithOpenCopies,
  pruneSelfCopyActivity,
  reportSelfCopyEngine,
} from "../src/lib/copy/selfCopyStore";
import { toSelfCopyPositionEvent } from "../src/lib/copy/selfCopyEvents";
import { pausedOnlySources, planSelfCopySources, type SelfCopySourcePlan } from "../src/lib/copy/selfCopySources";
import type { SelfCopyPositionEvent } from "../src/lib/copy/selfCopyEngine";
import type { BrokerAdapter } from "../src/lib/broker/BrokerAdapter";
import { expireStaleTradingAccounts } from "../src/lib/services/tradingAccountLifecycleService";
import { Api2TradeLiveAccountSource, type Api2TradePositionEvent } from "../src/lib/broker/api2TradeLiveSource";
import { enableApi2TradeConnectionPool } from "../src/lib/broker/api2TradeTransport";
import { createBrokerAdapter, getBrokerProviderId } from "../src/lib/broker/provider";
import { KeyedChains } from "../src/lib/copy/keyedChains";
import { createSupabaseGatewayStore } from "../src/lib/gateway/gatewayStore";
import { startGatewayWorker, type GatewayWorker } from "../src/lib/gateway/gatewayWorker";
import { validDirectSecret } from "../src/lib/gateway/directLane";
import { startDirectLaneServer, type DirectLaneServer } from "../src/lib/gateway/directLaneServer";
import { StreamPump } from "../src/lib/copy/streamPump";
import {
  buildMasterEvent,
  openedBeforeDetectionMs,
  storeMasterEvent,
  type BuiltMasterEvent,
  type DetectedPositionEvent,
  type MasterPosition,
} from "../src/lib/copy/masterEvents";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The live copy worker.
 *
 * Shape (since the 2026-10-12 speed work):
 *  - every live master account ("stream") has its OWN pump: read what changed at the
 *    broker, hand the changes on, rest briefly, repeat. The broker's order stream wakes
 *    the pump the moment something happens, so a trade is picked up in milliseconds;
 *  - copying is never awaited by the pump. Each change goes into a chain keyed by the
 *    master position (OPEN -> MODIFY -> CLOSE of one ticket stay in order, different
 *    tickets and different strategies never wait for each other);
 *  - finding and opening streams (database + broker round trips, up to several seconds)
 *    is a separate loop, so it cannot delay a trade either;
 *  - background retry jobs have their own timer.
 * Before this, ONE loop did all of the above in turn: a slow follower order, a stream
 * that was being opened or a database query stalled the detection of every trade.
 *
 * Self-copy (a trader's own accounts, `self_copy_relationships`) has the same shape since the
 * 2026-10-12 rebuild: one pump per SOURCE account, one chain per source ticket, the routes come
 * from the discovery loop (live ones, and paused ones while copies are still open) and the engine
 * (`lib/copy/selfCopyEngine.ts`) writes the reason for every copy, skip or failure to
 * `self_copy_events`. The worker tells the routes whether it listens (`engine_*`, migration 061).
 * `WSA_SELF_COPY_ENABLED=false` switches it off on this worker.
 */

type Position = MasterPosition;
type DetectedEvent = DetectedPositionEvent;
type LiveStrategy = {
  id: string; master_account_id: string;
  trading_accounts: { provider_account_id: string | null } | null;
};
type StreamHandle = {
  /** One pass: read what changed at the broker and hand it on. Throwing ends the stream. */
  reconcile(): Promise<void>;
  /** The broker's live feed reports a change: the listener runs at once. Returns the way to stop listening. */
  onSignal?(listener: () => void): () => void;
  close(): Promise<void>;
};
type RunningStream = {
  handle: StreamHandle;
  pump: StreamPump;
  unsubscribe: () => void;
  startedAt: number;
};

function intFromEnv(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const brokerProviderId = getBrokerProviderId();
const isApi2Trade = brokerProviderId === "api2trade";
const pollMs = intFromEnv("WSA_COPY_POLL_MS", isApi2Trade ? 100 : 1_000, 100);
const warmupMs = intFromEnv("WSA_COPY_WARMUP_MS", isApi2Trade ? 10_000 : 5_000, 5_000);
const workerId = `wsa-copy-${process.pid}`;
const streams = new Map<string, RunningStream>();
const selfCopyStreams = new Map<string, RunningStream>();
const activeStrategies = new Map<string, LiveStrategy>();
/** The sources followed for self-copy with their routes, as of the last discovery (events read it when they run). */
const selfCopySources = new Map<string, SelfCopySourcePlan>();
let stopping = false;
let shuttingDown: Promise<void> | null = null;
let nextLifecycleScanAt = 0;
const retryAfter = new Map<string, number>();
const failureCounts = new Map<string, number>();
const opening = new Set<string>();
const eventConcurrency = intFromEnv("WSA_COPY_EVENT_CONCURRENCY", isApi2Trade ? 8 : 2, 1);
const backgroundJobPollMs = intFromEnv("WSA_COPY_BACKGROUND_JOB_POLL_MS", 1_000, 250);
const streamDiscoveryMs = intFromEnv("WSA_COPY_STREAM_DISCOVERY_MS", 2_000, 1_000);
const heartbeatMs = intFromEnv("WSA_COPY_HEARTBEAT_MS", 5_000, 2_000);
/** how many streams may be opened at the same time (opening one warms every follower's broker session) */
const maxConcurrentOpens = intFromEnv("WSA_COPY_OPEN_CONCURRENCY", 4, 1, 32);
const streamRetryBaseMs = intFromEnv("WSA_COPY_STREAM_RETRY_MS", 2_000, 500, 60_000);
const streamRetryMaxMs = Math.max(streamRetryBaseMs, 15_000);
/** a stream that ran this long without failing starts again from the shortest retry delay */
const HEALTHY_STREAM_MS = 30_000;
/** Self-copy can be switched off on this worker without touching copy trading of the strategies. */
const selfCopyEnabled = process.env.WSA_SELF_COPY_ENABLED !== "false";
/** How often the routes of a source are told "the worker is listening" (the web calls a report older than 3 minutes stale). */
const selfCopyReportMs = intFromEnv("WSA_SELF_COPY_REPORT_MS", 45_000, 5_000, 120_000);
/** How often the follower accounts' broker sessions are kept warm (the bridge forgets a session after 5 minutes). */
const selfCopyWarmupMs = intFromEnv("WSA_SELF_COPY_WARMUP_MS", 60_000, 10_000, 240_000);
/** The safety net: how often copies of vanished source positions are looked for (the stream normally reports closes at once). */
const selfCopyRecoveryMs = intFromEnv("WSA_SELF_COPY_RECOVERY_MS", 5 * 60_000, 30_000, 24 * 3_600_000);
let nextSelfCopyPruneAt = 0;
let nextBackgroundJobRunAt = 0;
let backgroundJobRun: Promise<void> | null = null;
let backgroundTicker: ReturnType<typeof setInterval> | null = null;
/** The WSA Trade gateway: executes the commands the web app queues and keeps watched accounts fresh (migration 060). */
let tradeGateway: GatewayWorker | null = null;
/** The direct lane: an HTTP port the web server sends WSA Trade orders to (skips the database for the order itself). */
let directLane: DirectLaneServer | null = null;
let wakeDiscovery: (() => void) | null = null;
const strategyHeartbeatAt = new Map<string, number>();
const streamStatusLoggedAt = new Map<string, number>();

function errorMessage(error: unknown, fallback = "unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}

/** Records a failure of the stream under `key` and returns how long to wait before it is opened again. */
function noteFailure(key: string): number {
  const count = (failureCounts.get(key) ?? 0) + 1;
  failureCounts.set(key, count);
  const wait = Math.min(streamRetryMaxMs, streamRetryBaseMs * 2 ** (count - 1));
  retryAfter.set(key, Date.now() + wait);
  return wait;
}

function changed(previous: Position, current: Position) {
  return Number(previous.volume) !== Number(current.volume)
    || Number(previous.stopLoss ?? 0) !== Number(current.stopLoss ?? 0)
    || Number(previous.takeProfit ?? 0) !== Number(current.takeProfit ?? 0);
}

// ── master events: build, store, copy ─────────────────────────────────────────

async function copyStoredEvent(eventId: string, built: BuiltMasterEvent, startedAt: number, trace: CopyEventTrace) {
  const linked = built.linked;
  if (isApi2Trade && process.env.WSA_COPY_DIRECT_EXECUTION !== "false") {
    try {
      const result = await executeCopyForEvent({ id: eventId, ...linked } satisfies LinkedEvent, null, startedAt, trace);
      console.log(
        `[copy-worker] direct copy event ${eventId} finished in ${Date.now() - startedAt}ms: ${result.success} succeeded, ${result.failed} failed, ${result.skipped} skipped`,
      );
      if (
        linked.event_type === "OPEN"
        && result.attempted === 0
        && result.success === 0
        && result.failed === 0
        && result.skipped === 0
      ) {
        await enqueueJob({
          type: "EXECUTE_COPY_EVENT",
          payload: { masterEventId: eventId },
          uniqueKey: `EXECUTE_COPY_EVENT:${eventId}`,
          priority: 200,
          runAfter: new Date(Date.now() + 10_000).toISOString(),
          maxAttempts: 5,
        });
        console.warn(`[copy-worker] direct copy event ${eventId} had no eligible followers; queued delayed retry`);
      }
      return;
    } catch (error) {
      console.error(
        `[copy-worker] direct copy event failed for ${eventId}; queued retry: ${errorMessage(error, "Unknown error")}`,
      );
    }
  }
  await enqueueJob({
    type: "EXECUTE_COPY_EVENT",
    payload: { masterEventId: eventId },
    uniqueKey: `EXECUTE_COPY_EVENT:${eventId}`,
    priority: 200,
  });
}

async function persistEvent(strategy: LiveStrategy, event: DetectedEvent) {
  const startedAt = Date.now();
  const detectedAt = event.detectedAt ?? startedAt;
  const built = buildMasterEvent(strategy, event, { liveBrokerSource: isApi2Trade });
  const eventId = await storeMasterEvent(createAdminClient(), built, {
    onRetry: (attempt, message) =>
      console.warn(`[copy-worker] master event could not be stored (attempt ${attempt}); trying again: ${message}`),
  });
  if (!eventId) return;
  const eventStoredAt = Date.now();
  const openedAge = openedBeforeDetectionMs(event, detectedAt);
  console.log(
    `[copy-worker] detected ${event.eventType} ${event.position.symbol} ${Number(event.position.volume ?? 0)} lot(s): `
    + `waited ${startedAt - detectedAt}ms, stored in ${eventStoredAt - startedAt}ms`
    + (openedAge === null ? "" : `, trade was open ${openedAge}ms when seen`),
  );
  // timings of the copy count from the moment the change was seen, not from when it was stored
  const masterExecutedAtMs = event.position.time
    ? new Date(event.position.time).getTime()
    : null;
  await copyStoredEvent(eventId, built, detectedAt, {
    masterExecutedAtMs: openedAge === null || !Number.isFinite(masterExecutedAtMs) ? null : masterExecutedAtMs,
    eventStoredAtMs: eventStoredAt,
    detectedBy: event.detectedBy,
  });
}

/**
 * Hands detected changes to the copy engine WITHOUT waiting for it. Changes of one master
 * position run in order, everything else in parallel (up to `eventConcurrency`).
 */
function dispatchMasterEvents(
  strategy: LiveStrategy,
  chains: KeyedChains,
  events: DetectedEvent[],
  onFatal: (error: unknown) => void,
) {
  for (const event of events) {
    void chains.run(
      `${strategy.id}:${String(event.position.id)}`,
      () => persistEvent(strategy, event),
      (error) => {
        console.error(
          `[copy-worker] ${event.eventType} ${event.position.symbol} ${event.position.id} could not be processed: ${errorMessage(error)}`,
        );
        onFatal(error);
      },
    );
  }
}

function touchStrategyLiveHeartbeat(strategyId: string) {
  const now = Date.now();
  if (now - (strategyHeartbeatAt.get(strategyId) ?? 0) < heartbeatMs) return;
  strategyHeartbeatAt.set(strategyId, now);
  void createAdminClient().from("copy_strategies").update({
    engine_status: "LIVE",
    engine_error: null,
    engine_heartbeat_at: new Date(now).toISOString(),
  }).eq("id", strategyId).then(({ error }) => {
    if (error) {
      console.error(`[copy-worker] heartbeat update failed for ${strategyId}: ${error.message}`);
    }
  });
}

/** A line about a stream that is not in perfect shape, at most once a minute per stream. */
function reportStreamTrouble(label: string, source: Api2TradeLiveAccountSource) {
  const stats = source.stats();
  const diagnostics = process.env.WSA_COPY_STREAM_DIAGNOSTICS === "true";
  if (!diagnostics && stats.websocket && !stats.fastPolling && stats.consecutiveReadErrors === 0) return;
  const now = Date.now();
  if (now - (streamStatusLoggedAt.get(label) ?? 0) < 60_000) return;
  streamStatusLoggedAt.set(label, now);
  const message =
    `[copy-worker] ${label}: websocket ${stats.websocket ? "up" : "DOWN (polling REST)"}`
    + `${stats.fastPolling ? ", fast polling (the stream missed a change)" : ""}`
    + `, ${stats.consecutiveReadErrors} failed read(s) in a row, ${stats.trackedPositions} open position(s)`
    + `, ws messages/signals/snapshots/ignored/events ${stats.websocketMessages}/${stats.websocketSignals}/${stats.websocketSnapshots}/${stats.websocketIgnored}/${stats.websocketEvents}`
    + `, rest reads/events ${stats.restReads}/${stats.restEvents}, safety misses ${stats.safetyMisses}`
    + `, safety-poll discovery rate ${stats.safetyPollDiscoveryRate === null ? "n/a" : `${(stats.safetyPollDiscoveryRate * 100).toFixed(1)}%`}`
    + `, last ws message ${stats.lastWebsocketMessageAgeMs}ms ago`;
  if (stats.websocket && !stats.fastPolling && stats.consecutiveReadErrors === 0) console.log(message);
  else console.warn(message);
}

// ── streams ──────────────────────────────────────────────────────────────────

async function openStrategyStream(strategy: LiveStrategy, onFatal: (error: unknown) => void): Promise<StreamHandle> {
  const providerAccountId = strategy.trading_accounts?.provider_account_id;
  if (!providerAccountId) throw new Error("Master account has no broker provider account.");
  if (isApi2Trade) {
    const adapter = createBrokerAdapter();
    const health = await adapter.verifyConnection(strategy.master_account_id);
    if (!health.ok) throw new Error(health.message);
    const source = Api2TradeLiveAccountSource.fromEnv(providerAccountId);
    await source.reconnect();
    const chains = new KeyedChains(eventConcurrency);
    let lastWarmupAt = 0;
    let warmupInFlight: Promise<void> | null = null;
    const warmStrategyAccounts = async (force = false) => {
      if (!force && Date.now() - lastWarmupAt < warmupMs) return;
      if (warmupInFlight) return warmupInFlight;
      lastWarmupAt = Date.now();
      warmupInFlight = warmCopyStrategyAccounts(strategy.id, strategy.master_account_id, adapter)
        .then((result) => {
          if (result.warmed > 0) {
            console.log(`[copy-worker] prewarmed ${result.warmed} broker account session(s) for strategy ${strategy.id}`);
          }
        })
        .catch((error) => {
          console.error(`[copy-worker] Broker prewarm failed for strategy ${strategy.id}: ${errorMessage(error)}`);
        })
        .finally(() => {
          warmupInFlight = null;
        });
      return warmupInFlight;
    };
    const handle: StreamHandle = {
      async reconcile() {
        const events = await source.reconcile({ emitExistingAsOpen: true });
        if (events.length > 0) dispatchMasterEvents(strategy, chains, events, onFatal);
        touchStrategyLiveHeartbeat(strategy.id);
        reportStreamTrouble(`strategy ${strategy.id}`, source);
      },
      onSignal: (listener) => source.onSignal(listener),
      async close() {
        clearInterval(warmTicker);
        // copies that are already running are allowed to finish
        await chains.idle();
        await source.close();
      },
    };
    const warmTicker = setInterval(() => {
      void warmStrategyAccounts(false);
    }, warmupMs);
    try {
      await warmStrategyAccounts(true);
      await handle.reconcile();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    console.log(
      `[copy-worker] Broker ${source.usingWebSocket() ? "websocket" : "polling fallback"} synchronized for strategy ${strategy.id}`,
    );
    return handle;
  }
  const sdk = await import("metaapi.cloud-sdk/node") as unknown as {
    default: new (authToken: string) => {
      metatraderAccountApi: { getAccount(id: string): Promise<any> }; close(): void;
    };
    SynchronizationListener: new () => any;
  };
  const api = new sdk.default(process.env.METAAPI_TOKEN!);
  const account = await api.metatraderAccountApi.getAccount(providerAccountId);
  if (account.state !== "DEPLOYED") {
    await account.deploy();
    await account.waitDeployed(120, 1_000);
  }
  await account.waitConnected(120, 1_000);
  const connection = account.getStreamingConnection();
  const positions = new Map<string, Position>();
  let ready = false;
  let lastActivityPersistedAt = 0;

  const persistMasterActivity = async () => {
    const now = Date.now();
    if (now - lastActivityPersistedAt < 30_000) return;
    lastActivityPersistedAt = now;
    const { error } = await createAdminClient()
      .from("trading_accounts")
      .update({ last_synced_at: new Date(now).toISOString(), sync_error: null })
      .eq("id", strategy.master_account_id)
      .in("status", ["CONNECTED", "RESTRICTED"]);
    if (error) {
      console.error(`[copy-worker] master activity update failed for ${strategy.master_account_id}: ${error.message}`);
    }
  };

  class MasterListener extends sdk.SynchronizationListener {
    async onPositionsReplaced(_instanceIndex: string, current: Position[]) {
      positions.clear();
      for (const position of current) positions.set(String(position.id), position);
    }
    async onPositionUpdated(_instanceIndex: string, position: Position) {
      const key = String(position.id);
      const previous = positions.get(key);
      positions.set(key, position);
      if (!ready) return;
      if (!previous) await persistEvent(strategy, { eventType: "OPEN", position });
      else if (changed(previous, position)) await persistEvent(strategy, { eventType: "MODIFY", position, previous });
    }
    async onPositionRemoved(_instanceIndex: string, positionId: string) {
      const previous = positions.get(String(positionId));
      positions.delete(String(positionId));
      if (ready && previous) await persistEvent(strategy, { eventType: "CLOSE", position: previous });
    }
  }
  const listener = new MasterListener();
  connection.addSynchronizationListener(listener);
  await connection.connect();
  await connection.waitSynchronized({ timeoutInSeconds: 120 });
  const synchronizedPositions = (connection.terminalState.positions ?? []) as Position[];
  for (const position of synchronizedPositions) {
    positions.set(String(position.id), position);
  }
  ready = true;
  // Reconcile positions that opened while the worker was offline or while the
  // initial synchronization was in progress. The OPEN dedupe key makes this
  // restart-safe, while event_time still protects copy-new-trades-only rules.
  for (const position of synchronizedPositions) {
    await persistEvent(strategy, { eventType: "OPEN", position, existing: true });
  }
  await persistMasterActivity();
  await createAdminClient().from("copy_strategies").update({
    engine_status: "LIVE", engine_error: null, engine_heartbeat_at: new Date().toISOString(),
  }).eq("id", strategy.id);
  console.log(`[copy-worker] master stream synchronized; monitoring ${positions.size} open position(s)`);
  return {
    async reconcile() {
      const current = new Map<string, Position>();
      for (const position of (connection.terminalState.positions ?? []) as Position[]) {
        const key = String(position.id);
        const previous = positions.get(key);
        current.set(key, position);
        if (!previous) await persistEvent(strategy, { eventType: "OPEN", position });
        else if (changed(previous, position)) await persistEvent(strategy, { eventType: "MODIFY", position, previous });
      }
      for (const [key, previous] of positions) {
        if (!current.has(key)) await persistEvent(strategy, { eventType: "CLOSE", position: previous });
      }
      positions.clear();
      for (const [key, position] of current) positions.set(key, position);
      await persistMasterActivity();
    },
    async close() {
      ready = false;
      connection.removeSynchronizationListener(listener);
      await connection.close();
      api.close();
    },
  };
}

// ── self-copy: one stream per source account ─────────────────────────────────
//
// Shape (since the 2026-10-12 self-copy rebuild): the routes are read by the discovery loop and
// kept in `selfCopySources`; a change of a source position is copied on exactly those routes, so
// pausing, resuming or editing a route takes effect within a couple of seconds without reopening
// the stream. Every ticket has its own chain (OPEN -> MODIFY -> CLOSE in order, different tickets
// in parallel) and nothing the engine does is awaited by the pump that watches the account.

let selfCopyBrokerAdapter: BrokerAdapter | null = null;
function selfCopyBroker(): BrokerAdapter {
  selfCopyBrokerAdapter ??= createBrokerAdapter();
  return selfCopyBrokerAdapter;
}

/** Positions of a source already handed to the engine by this process: a stream that is opened anew must not repeat them. */
const selfCopyHandled = new Map<string, Set<string>>();

/** True the first time this process sees the position of the source. */
function firstSightOfPosition(sourceAccountId: string, positionId: string): boolean {
  let handled = selfCopyHandled.get(sourceAccountId);
  if (!handled) {
    handled = new Set<string>();
    selfCopyHandled.set(sourceAccountId, handled);
  }
  if (handled.has(positionId)) return false;
  handled.add(positionId);
  return true;
}

/** A database hiccup BEFORE an order is sent (the engine only throws from those reads) is tried again after these pauses. */
const SELF_COPY_RETRY_DELAYS_MS: readonly number[] = [250, 750];

/** Copies one change of a source position on the routes the last discovery found. */
async function copySelfCopyEvent(event: SelfCopyPositionEvent): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const routes = selfCopySources.get(event.sourceAccountId)?.routes;
    if (!routes || routes.length === 0) return;
    try {
      await executeSelfCopyPositionEvent(event, { routes, adapter: selfCopyBroker(), log: (line) => console.log(line) });
      return;
    } catch (error) {
      if (attempt >= SELF_COPY_RETRY_DELAYS_MS.length) throw error;
      console.warn(
        `[self-copy] ${event.eventType} ${event.symbol} ${event.sourcePositionId}: ${errorMessage(error)}; trying again`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, SELF_COPY_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/** Hands detected changes to the engine WITHOUT waiting for it. */
function dispatchSelfCopyChanges(sourceAccountId: string, chains: KeyedChains, changes: Api2TradePositionEvent[]) {
  for (const change of changes) {
    const positionId = String(change.position.id);
    // found again in the first look of a stream that was opened anew: it was dealt with the first time
    if (change.eventType === "OPEN" && !firstSightOfPosition(sourceAccountId, positionId)) continue;
    if (change.eventType === "CLOSE") selfCopyHandled.get(sourceAccountId)?.delete(positionId);
    const event = toSelfCopyPositionEvent(sourceAccountId, change);
    void chains.run(
      `self:${sourceAccountId}:${positionId}`,
      () => copySelfCopyEvent(event),
      (error) =>
        console.error(`[self-copy] ${event.eventType} ${event.symbol} ${positionId} could not be processed: ${errorMessage(error)}`),
    );
  }
}

const selfCopyWarmups = new Map<string, Promise<void>>();

/** Keeps the follower accounts' broker sessions open and their symbol lists at hand, so the first order of a trade pays for neither. */
function warmSelfCopyFollowers(sourceAccountId: string): Promise<void> {
  const running = selfCopyWarmups.get(sourceAccountId);
  if (running) return running;
  const routes = (selfCopySources.get(sourceAccountId)?.routes ?? []).filter((route) => route.status === "LIVE");
  if (routes.length === 0) return Promise.resolve();
  const adapter = selfCopyBroker();
  const followerIds = [...new Set(routes.map((route) => route.followerAccountId))];
  const needSymbols = [
    ...new Set(
      routes
        .filter((route) => route.settings.calibration.autoSymbolMatch || Object.keys(route.settings.symbolMapping).length > 0)
        .map((route) => route.followerAccountId),
    ),
  ];
  const warming = (async () => {
    await adapter.warmAccounts?.(followerIds);
    await Promise.allSettled(needSymbols.map((accountId) => adapter.fetchSymbolList?.(accountId)));
  })()
    .catch((error) => {
      console.error(`[self-copy] warm-up of the follower accounts of ${sourceAccountId} failed: ${errorMessage(error)}`);
    })
    .finally(() => {
      selfCopyWarmups.delete(sourceAccountId);
    });
  selfCopyWarmups.set(sourceAccountId, warming);
  return warming;
}

const selfCopyRecoveries = new Set<string>();

/** Closes the copies of source positions that are gone (closed while nobody was listening). One run per source at a time. */
async function recoverMissedSelfCopyCloses(sourceAccountId: string, readLive: () => Promise<ReadonlySet<string>>) {
  if (selfCopyRecoveries.has(sourceAccountId)) return;
  selfCopyRecoveries.add(sourceAccountId);
  try {
    const summary = await closeVanishedSelfCopyPositions(sourceAccountId, readLive, {
      adapter: selfCopyBroker(),
      log: (line) => console.log(line),
    });
    if (summary.attempted > 0) {
      console.log(
        `[self-copy] ${sourceAccountId}: closed ${summary.success} copy(ies) whose source position was gone`
        + (summary.failed > 0 ? `, ${summary.failed} could not be closed` : ""),
      );
    }
  } catch (error) {
    console.error(`[self-copy] looking for missed closes of ${sourceAccountId} failed: ${errorMessage(error)}`);
  } finally {
    selfCopyRecoveries.delete(sourceAccountId);
  }
}

async function openSelfCopyStream(plan: SelfCopySourcePlan): Promise<StreamHandle> {
  const sourceAccountId = plan.sourceAccountId;
  const providerAccountId = plan.providerAccountId;
  if (!providerAccountId) {
    throw new Error("The source account has no broker connection yet (it is not registered at the broker bridge).");
  }
  void reportSelfCopyEngine(sourceAccountId, "STARTING", null);

  if (isApi2Trade) {
    const adapter = selfCopyBroker();
    const health = await adapter.verifyConnection(sourceAccountId);
    if (!health.ok) throw new Error(health.message);
    const liveSource = Api2TradeLiveAccountSource.fromEnv(providerAccountId);
    await liveSource.reconnect();
    // OPEN -> MODIFY -> CLOSE of one ticket stay in order; different tickets never wait for each other
    const chains = new KeyedChains(eventConcurrency);
    let lastReportAt = 0;
    let nextRecoveryAt = Date.now() + selfCopyRecoveryMs;
    const handle: StreamHandle = {
      async reconcile() {
        const changes = await liveSource.reconcile({ emitExistingAsOpen: true });
        if (changes.length > 0) dispatchSelfCopyChanges(sourceAccountId, chains, changes);
        const now = Date.now();
        if (now - lastReportAt >= selfCopyReportMs) {
          lastReportAt = now;
          void reportSelfCopyEngine(sourceAccountId, "LIVE", null);
        }
        if (now >= nextRecoveryAt) {
          nextRecoveryAt = now + selfCopyRecoveryMs;
          void recoverMissedSelfCopyCloses(sourceAccountId, () => liveSource.confirmedOpenPositionIds());
        }
        reportStreamTrouble(`self-copy source ${sourceAccountId}`, liveSource);
      },
      onSignal: (listener) => liveSource.onSignal(listener),
      async close() {
        clearInterval(warmTicker);
        // copies that are on their way are allowed to finish
        await chains.idle();
        await liveSource.close();
      },
    };
    const warmTicker = setInterval(() => {
      void warmSelfCopyFollowers(sourceAccountId);
    }, selfCopyWarmupMs);
    warmTicker.unref?.();
    try {
      await warmSelfCopyFollowers(sourceAccountId);
      await handle.reconcile();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    // copies whose source position was closed while nobody was listening
    void recoverMissedSelfCopyCloses(sourceAccountId, () => liveSource.confirmedOpenPositionIds());
    console.log(
      `[self-copy] ${sourceAccountId}: broker ${liveSource.usingWebSocket() ? "websocket" : "polling fallback"} synchronized, `
      + `following ${liveSource.stats().trackedPositions} open position(s) for ${plan.routes.length} route(s)`,
    );
    return handle;
  }

  const sdk = await import("metaapi.cloud-sdk/node") as unknown as {
    default: new (authToken: string) => {
      metatraderAccountApi: { getAccount(id: string): Promise<any> }; close(): void;
    };
    SynchronizationListener: new () => any;
  };
  const api = new sdk.default(process.env.METAAPI_TOKEN!);
  const account = await api.metatraderAccountApi.getAccount(providerAccountId);
  if (account.state !== "DEPLOYED") {
    await account.deploy();
    await account.waitDeployed(120, 1_000);
  }
  await account.waitConnected(120, 1_000);
  const connection = account.getStreamingConnection();
  const positions = new Map<string, Position>();
  let ready = false;
  let queue = Promise.resolve();
  let lastReportAt = Date.now();

  const dispatch = (eventType: "OPEN" | "MODIFY" | "CLOSE", position: Position, previous?: Position, existing = false) => {
    const positionId = String(position.id);
    if (eventType === "OPEN" && !firstSightOfPosition(sourceAccountId, positionId)) return queue;
    if (eventType === "CLOSE") selfCopyHandled.get(sourceAccountId)?.delete(positionId);
    const event = toSelfCopyPositionEvent(sourceAccountId, {
      eventType,
      position,
      previous: previous ?? null,
      detectedAt: Date.now(),
      existing,
    });
    queue = queue.then(() => copySelfCopyEvent(event)).catch((error) => {
      console.error(`[self-copy] ${eventType} failed: ${errorMessage(error)}`);
    });
    return queue;
  };

  class SelfCopyListener extends sdk.SynchronizationListener {
    async onPositionsReplaced(_instanceIndex: string, current: Position[]) {
      positions.clear();
      for (const position of current) positions.set(String(position.id), position);
    }
    async onPositionUpdated(_instanceIndex: string, position: Position) {
      const key = String(position.id);
      const previous = positions.get(key);
      positions.set(key, position);
      if (!ready) return;
      if (!previous) await dispatch("OPEN", position);
      else if (changed(previous, position)) await dispatch("MODIFY", position, previous);
    }
    async onPositionRemoved(_instanceIndex: string, positionId: string) {
      const previous = positions.get(String(positionId));
      positions.delete(String(positionId));
      if (ready && previous) await dispatch("CLOSE", previous);
    }
  }

  const listener = new SelfCopyListener();
  connection.addSynchronizationListener(listener);
  await connection.connect();
  await connection.waitSynchronized({ timeoutInSeconds: 120 });
  for (const position of (connection.terminalState.positions ?? []) as Position[]) {
    positions.set(String(position.id), position);
  }
  ready = true;

  // Trades that were open when the stream started are "existing": the engine copies one only when it opened after the route went live.
  for (const position of positions.values()) await dispatch("OPEN", position, undefined, true);
  void recoverMissedSelfCopyCloses(sourceAccountId, async () => new Set(positions.keys()));
  await reportSelfCopyEngine(sourceAccountId, "LIVE", null);

  return {
    async reconcile() {
      const current = new Map<string, Position>();
      for (const position of (connection.terminalState.positions ?? []) as Position[]) {
        const key = String(position.id);
        const previous = positions.get(key);
        current.set(key, position);
        if (!previous) await dispatch("OPEN", position);
        else if (changed(previous, position)) await dispatch("MODIFY", position, previous);
      }
      for (const [key, previous] of positions) {
        if (!current.has(key)) await dispatch("CLOSE", previous);
      }
      positions.clear();
      for (const [key, position] of current) positions.set(key, position);
      if (Date.now() - lastReportAt >= selfCopyReportMs) {
        lastReportAt = Date.now();
        void reportSelfCopyEngine(sourceAccountId, "LIVE", null);
      }
    },
    async close() {
      ready = false;
      await queue;
      connection.removeSynchronizationListener(listener);
      await connection.close();
      api.close();
    },
  };
}

// ── pumps: one per stream ────────────────────────────────────────────────────

function startPump(handle: StreamHandle, onFailure: (error: unknown) => void | Promise<void>): RunningStream {
  const pump = new StreamPump({ step: () => handle.reconcile(), intervalMs: pollMs, onFailure });
  const unsubscribe = handle.onSignal?.(() => pump.wake()) ?? (() => undefined);
  pump.start();
  return { handle, pump, unsubscribe, startedAt: Date.now() };
}

async function stopRunning(running: RunningStream) {
  running.unsubscribe();
  await running.pump.stop().catch(() => undefined);
  await running.handle.close().catch(() => undefined);
}

/** A running stream broke: close it, say so, and let the discovery loop open it again after a pause. */
async function failStream(
  registry: Map<string, RunningStream>,
  id: string,
  retryKey: string,
  label: string,
  error: unknown,
  report?: (message: string) => Promise<void>,
) {
  const running = registry.get(id);
  if (!running) return;
  registry.delete(id);
  if (Date.now() - running.startedAt > HEALTHY_STREAM_MS) failureCounts.delete(retryKey);
  const wait = noteFailure(retryKey);
  const message = (error instanceof Error ? error.message : "Master stream failed").slice(0, 400);
  console.error(`[copy-worker] ${label} failed: ${message}; opening it again in ${Math.round(wait / 100) / 10}s`);
  await stopRunning(running);
  if (report) await report(message).catch(() => undefined);
}

async function startStrategyStream(strategy: LiveStrategy) {
  const key = `strategy:${strategy.id}`;
  opening.add(key);
  let registered = false;
  let fatal: unknown = null;
  const label = `active master stream ${strategy.id}`;
  const fail = (error: unknown) =>
    failStream(streams, strategy.id, key, label, error, async (message) => {
      await createAdminClient().from("copy_strategies").update({ engine_status: "ERROR", engine_error: message }).eq("id", strategy.id);
    });
  try {
    const handle = await openStrategyStream(strategy, (error) => {
      // storing a change failed for good: the stream is not trustworthy any more
      if (registered) void fail(error);
      else fatal = error ?? new Error("Master event could not be stored.");
    });
    if (stopping || !activeStrategies.has(strategy.id)) {
      await handle.close().catch(() => undefined);
      return;
    }
    streams.set(strategy.id, startPump(handle, fail));
    registered = true;
    retryAfter.delete(key);
    if (fatal) void fail(fatal);
  } catch (error) {
    const wait = noteFailure(key);
    const message = (error instanceof Error ? error.message : "Master stream failed").slice(0, 400);
    console.error(`[copy-worker] master stream ${strategy.id} could not be opened: ${message}; trying again in ${Math.round(wait / 100) / 10}s`);
    await createAdminClient().from("copy_strategies").update({ engine_status: "ERROR", engine_error: message }).eq("id", strategy.id)
      .then(() => undefined, () => undefined);
  } finally {
    opening.delete(key);
  }
}

async function startSelfCopyStream(plan: SelfCopySourcePlan) {
  const sourceAccountId = plan.sourceAccountId;
  const key = `self:${sourceAccountId}`;
  opening.add(key);
  const label = `self-copy source stream ${sourceAccountId}`;
  const fail = (error: unknown) =>
    failStream(selfCopyStreams, sourceAccountId, key, `[self-copy] ${label}`, error, (message) =>
      reportSelfCopyEngine(sourceAccountId, "ERROR", message),
    );
  try {
    const handle = await openSelfCopyStream(plan);
    if (stopping || !selfCopySources.has(sourceAccountId)) {
      await handle.close().catch(() => undefined);
      return;
    }
    selfCopyStreams.set(sourceAccountId, startPump(handle, fail));
    retryAfter.delete(key);
  } catch (error) {
    const wait = noteFailure(key);
    const message = errorMessage(error, "The source stream failed.").slice(0, 400);
    console.error(
      `[self-copy] source stream ${sourceAccountId} could not be opened: ${message}; trying again in ${Math.round(wait / 100) / 10}s`,
    );
    await reportSelfCopyEngine(sourceAccountId, "ERROR", message);
  } finally {
    opening.delete(key);
  }
}

// ── discovery: which streams should exist ────────────────────────────────────

function runHousekeeping() {
  if (Date.now() >= nextLifecycleScanAt) {
    nextLifecycleScanAt = Date.now() + 60 * 60 * 1_000;
    void expireStaleTradingAccounts()
      .then((expired) => {
        if (expired > 0) {
          console.log(`[copy-worker] moved ${expired} stale or incomplete account(s) out of live status`);
        }
      })
      .catch((error) => {
        console.error(`[copy-worker] account lifecycle scan failed: ${errorMessage(error)}`);
      });
  }
  if (selfCopyEnabled && Date.now() >= nextSelfCopyPruneAt) {
    nextSelfCopyPruneAt = Date.now() + 60 * 60 * 1_000;
    void pruneSelfCopyActivity(14).then((removed) => {
      if (removed > 0) console.log(`[self-copy] removed ${removed} old line(s) of activity`);
    });
  }
}

async function discoverStrategyStreams() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("copy_strategies")
    .select("id, master_account_id, trading_accounts!master_account_id(provider_account_id)")
    .eq("status", "ACTIVE").eq("live_enabled", true).in("engine_status", ["LIVE", "STARTING", "ERROR"]).limit(500);
  if (error) throw new Error(`Live strategies could not be loaded: ${error.message}`);

  activeStrategies.clear();
  for (const entry of data ?? []) {
    const strategy = entry as unknown as LiveStrategy;
    activeStrategies.set(strategy.id, strategy);
  }

  // streams nobody wants any more are closed in the background (copies in flight finish first)
  for (const [strategyId, running] of streams) {
    if (!activeStrategies.has(strategyId)) {
      streams.delete(strategyId);
      strategyHeartbeatAt.delete(strategyId);
      void stopRunning(running);
    }
  }

  // missing streams are opened in the background, a few at a time
  const now = Date.now();
  for (const strategy of activeStrategies.values()) {
    const key = `strategy:${strategy.id}`;
    if (stopping || opening.size >= maxConcurrentOpens) break;
    if (streams.has(strategy.id) || opening.has(key)) continue;
    if ((retryAfter.get(key) ?? 0) > now) continue;
    void startStrategyStream(strategy);
  }
}

/** Reads the routes and decides which sources are followed. null = the database could not be read: keep what runs. */
async function readSelfCopyPlans(): Promise<Map<string, SelfCopySourcePlan> | null> {
  if (!selfCopyEnabled) return new Map();
  try {
    const entries = await loadSelfCopyRouteEntries();
    const idle = pausedOnlySources(entries);
    const withOpenCopies = idle.length > 0 ? await loadSourcesWithOpenCopies(idle) : new Set<string>();
    return planSelfCopySources(entries, withOpenCopies);
  } catch (error) {
    console.error(`[self-copy] the routes could not be loaded; the streams that run stay as they are: ${errorMessage(error)}`);
    return null;
  }
}

async function discoverSelfCopyStreams() {
  const plans = await readSelfCopyPlans();
  if (!plans) return;
  selfCopySources.clear();
  for (const [sourceAccountId, plan] of plans) selfCopySources.set(sourceAccountId, plan);

  for (const [sourceAccountId, running] of selfCopyStreams) {
    if (!selfCopySources.has(sourceAccountId)) {
      selfCopyStreams.delete(sourceAccountId);
      selfCopyHandled.delete(sourceAccountId);
      void stopRunning(running);
    }
  }
  const now = Date.now();
  for (const plan of selfCopySources.values()) {
    const key = `self:${plan.sourceAccountId}`;
    if (stopping || opening.size >= maxConcurrentOpens) break;
    if (selfCopyStreams.has(plan.sourceAccountId) || opening.has(key)) continue;
    if ((retryAfter.get(key) ?? 0) > now) continue;
    void startSelfCopyStream(plan);
  }
}

/** Strategies and self-copy are discovered on their own: a failure of one never keeps the other from opening or closing streams. */
async function discoverStreams() {
  runHousekeeping();
  const [strategies, selfCopy] = await Promise.allSettled([discoverStrategyStreams(), discoverSelfCopyStreams()]);
  if (strategies.status === "rejected") {
    console.error(`[copy-worker] stream discovery failed; retrying in ${streamDiscoveryMs}ms: ${errorMessage(strategies.reason)}`);
  }
  if (selfCopy.status === "rejected") {
    console.error(`[self-copy] stream discovery failed; retrying in ${streamDiscoveryMs}ms: ${errorMessage(selfCopy.reason)}`);
  }
}

function sleepUntilWoken(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (wakeDiscovery === done) wakeDiscovery = null;
      resolve();
    }
    wakeDiscovery = done;
  });
}

async function discoveryLoop() {
  while (!stopping) {
    try {
      await discoverStreams();
    } catch (error) {
      console.error(
        `[copy-worker] stream discovery failed; retrying in ${streamDiscoveryMs}ms: ${errorMessage(error)}`,
      );
    }
    if (!stopping) await sleepUntilWoken(streamDiscoveryMs);
  }
}

function shutdown(): Promise<void> {
  if (shuttingDown) return shuttingDown;
  stopping = true;
  wakeDiscovery?.();
  if (backgroundTicker) clearInterval(backgroundTicker);
  backgroundTicker = null;
  shuttingDown = (async () => {
    // the lane closes first: nothing new may arrive while the gateway finishes what it is running
    tradeGateway?.setDirectLane(false);
    await Promise.allSettled([directLane?.close()]);
    directLane = null;
    await Promise.allSettled([tradeGateway?.stop()]);
    tradeGateway = null;
    await backgroundJobRun?.catch(() => undefined);
    await Promise.allSettled([...streams.values()].map(stopRunning));
    await Promise.allSettled([...selfCopyStreams.values()].map(stopRunning));
    // the last lines of activity are written before the process ends
    await flushSelfCopyActivity().catch(() => undefined);
    streams.clear();
    selfCopyStreams.clear();
    selfCopySources.clear();
    selfCopyHandled.clear();
    retryAfter.clear();
    failureCounts.clear();
  })();
  return shuttingDown;
}

function runBackgroundJobsWithoutBlockingRealtime() {
  if (backgroundJobRun || Date.now() < nextBackgroundJobRunAt) return;
  nextBackgroundJobRunAt = Date.now() + backgroundJobPollMs;
  backgroundJobRun = runWorkerOnce({
    workerId,
    limit: 25,
    types: ["EXECUTE_COPY_EVENT", "CLOSE_COPY_STRATEGY", "RETRY_COPY_LOG"],
  })
    .then(() => undefined)
    .catch((error) => {
      console.error(`[copy-worker] background job cycle failed: ${errorMessage(error)}`);
    })
    .finally(() => {
      backgroundJobRun = null;
    });
}

/**
 * Opens the direct lane when `WSA_TRADE_DIRECT_SECRET` (>= 32 characters) is set: the web server then hands a WSA Trade order
 * straight to this process over HTTPS (signed with that secret) instead of through the database queue. The worker
 * still reserves each request in the database before broker execution. It is OFF without the
 * secret, and a port that can not be opened never stops copy trading - the orders simply keep using the database.
 *
 * The port serves HTTPS with a key and a self-signed certificate that both ends work out from the secret (nothing to install
 * or copy). `WSA_TRADE_DIRECT_TLS=off` serves plain HTTP instead - only for a port that a local TLS proxy in front reaches
 * (then also set `WSA_TRADE_DIRECT_HOST=127.0.0.1`).
 */
async function startDirectLane(): Promise<void> {
  const gateway = tradeGateway;
  const secret = process.env.WSA_TRADE_DIRECT_SECRET;
  if (!gateway || !validDirectSecret(secret)) {
    if (secret) console.warn("[copy-worker] WSA_TRADE_DIRECT_SECRET is shorter than 32 characters - the direct lane stays off.");
    return;
  }
  const tlsSetting = process.env.WSA_TRADE_DIRECT_TLS?.trim().toLowerCase();
  const tls = !(tlsSetting === "off" || tlsSetting === "false" || tlsSetting === "0" || tlsSetting === "no");
  try {
    directLane = await startDirectLaneServer({
      secret: secret.trim(),
      port: intFromEnv("WSA_TRADE_DIRECT_PORT", 8787, 1, 65_535),
      host: process.env.WSA_TRADE_DIRECT_HOST?.trim() || "0.0.0.0",
      tls,
      run: (request, receivedAt) => gateway.runDirect(request, receivedAt),
      maxInFlight: intFromEnv("WSA_TRADE_DIRECT_MAX_IN_FLIGHT", 64, 1, 512),
    });
    gateway.setDirectLane(true, directLane.tls);
  } catch (error) {
    gateway.setDirectLane(false);
    console.error(`[copy-worker] the direct lane could not start (${errorMessage(error)}); WSA Trade orders keep using the database.`);
  }
}

async function main() {
  if (process.env.WSA_COPY_ENGINE_ENABLED !== "true") {
    throw new Error("WSA copy worker is disabled.");
  }
  if (!process.env.API2TRADE_BASE_URL || !(process.env.API2TRADE_USERNAME && process.env.API2TRADE_PASSWORD)) {
    throw new Error("Copy worker requires live broker API configuration.");
  }
  if (process.env.BROKER_EXECUTION_ENABLED !== "true") {
    throw new Error("BROKER_EXECUTION_ENABLED must be true before the live WSA worker can start.");
  }
  // Orders go out in bursts (one per follower) after seconds of silence: keep the connections open.
  const pooled = isApi2Trade ? await enableApi2TradeConnectionPool() : false;
  console.log(
    `[copy-worker] Broker websocket-first source enabled; WSA engine remains local. Connection pool: ${pooled ? "keep-alive" : "default fetch"}.`,
  );
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  backgroundTicker = setInterval(runBackgroundJobsWithoutBlockingRealtime, Math.min(backgroundJobPollMs, 500));
  if (isApi2Trade && process.env.WSA_TRADE_GATEWAY_ENABLED !== "false") {
    // Without migration 060 the gateway sleeps and checks again every minute; it never blocks copying.
    tradeGateway = startGatewayWorker({
      store: createSupabaseGatewayStore(),
      adapter: createBrokerAdapter(),
      workerId,
      pollMs: intFromEnv("WSA_TRADE_GATEWAY_POLL_MS", 100, 50, 5_000),
      // a command that arrives while the loop is idle waits at most this long before it is claimed
      idlePollMs: intFromEnv("WSA_TRADE_GATEWAY_IDLE_POLL_MS", 400, 100, 10_000),
      // Migration 062: the claim WAITS inside the database for a command and returns the moment one is written
      // (two such calls run half a window apart, so there is no gap). 0 = poll as before; without 062 the worker
      // notices the missing function and polls by itself.
      longPollMs: intFromEnv("WSA_TRADE_GATEWAY_LONG_POLL_MS", 1_000, 0, 2_000),
      stateRefreshMs: intFromEnv("WSA_TRADE_GATEWAY_STATE_MS", 1_000, 250, 10_000),
      // in the seconds after an order the picture of that account is renewed this often
      hotRefreshMs: intFromEnv("WSA_TRADE_GATEWAY_HOT_STATE_MS", 350, 150, 5_000),
      commandConcurrency: intFromEnv("WSA_TRADE_GATEWAY_CONCURRENCY", 8, 1, 32),
      // STATE / SYMBOLS commands have slots of their own, so they never wait behind an order
      readConcurrency: intFromEnv("WSA_TRADE_GATEWAY_READ_CONCURRENCY", 6, 1, 32),
      stateConcurrency: intFromEnv("WSA_TRADE_GATEWAY_STATE_CONCURRENCY", 6, 1, 32),
    });
    console.log("[copy-worker] WSA Trade gateway started (orders and live account state for the web terminal).");
    await startDirectLane();
  }
  await discoveryLoop();
  await shutdown();
}

main().catch(async (error) => {
  await shutdown();
  console.error(error instanceof Error ? error.message : "WSA copy worker failed.");
  process.exitCode = 1;
});
