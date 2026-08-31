import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueJob } from "../src/lib/services/backgroundJobService";
import { runWorkerOnce } from "../src/lib/workers/jobProcessor";
import { executeCopyForEvent, warmCopyStrategyAccounts, type LinkedEvent } from "../src/lib/services/copyTradingService";
import { executeSelfCopyPositionEvent } from "../src/lib/services/selfCopyService";
import { expireStaleTradingAccounts } from "../src/lib/services/tradingAccountLifecycleService";
import { Api2TradeLiveAccountSource } from "../src/lib/broker/api2TradeLiveSource";
import { createBrokerAdapter, getBrokerProviderId } from "../src/lib/broker/provider";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Position = {
  id: string | number; type: string; symbol: string; volume: number; openPrice: number;
  currentPrice?: number; stopLoss?: number; takeProfit?: number;
  time?: Date | string; updateTime?: Date | string;
};
type LiveStrategy = {
  id: string; master_account_id: string;
  trading_accounts: { provider_account_id: string | null } | null;
};
type StreamHandle = {
  reconcile(): Promise<void>;
  close(): Promise<void>;
};
type LiveSelfCopySource = {
  source_account_id: string;
  trading_accounts: { provider_account_id: string | null } | null;
};

const brokerProviderId = getBrokerProviderId();
const defaultCopyPollMs = brokerProviderId === "api2trade" ? "100" : "1000";
const pollMs = Math.max(100, Number.parseInt(process.env.WSA_COPY_POLL_MS ?? defaultCopyPollMs, 10) || Number(defaultCopyPollMs));
const defaultWarmupMs = brokerProviderId === "api2trade" ? "30000" : "5000";
const minWarmupMs = brokerProviderId === "api2trade" ? 30_000 : 5_000;
const warmupMs = Math.max(
  minWarmupMs,
  Number.parseInt(process.env.WSA_COPY_WARMUP_MS ?? defaultWarmupMs, 10) || Number(defaultWarmupMs),
);
const workerId = `wsa-copy-${process.pid}`;
const streams = new Map<string, StreamHandle>();
const selfCopyStreams = new Map<string, StreamHandle>();
let stopping = false;
let nextLifecycleScanAt = 0;
const retryAfter = new Map<string, number>();

function retryDelayMs(): number {
  return 15_000;
}

function iso(value?: Date | string) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) {
    return new Date().toISOString();
  }
  return date.toISOString();
}
function changed(previous: Position, current: Position) {
  return Number(previous.volume) !== Number(current.volume)
    || Number(previous.stopLoss ?? 0) !== Number(current.stopLoss ?? 0)
    || Number(previous.takeProfit ?? 0) !== Number(current.takeProfit ?? 0);
}

async function persistEvent(strategy: LiveStrategy, eventType: "OPEN" | "MODIFY" | "CLOSE", position: Position, previous?: Position) {
  const startedAt = Date.now();
  const supabase = createAdminClient();
  const positionId = String(position.id);
  const eventTime = iso(position.updateTime ?? position.time);
  const fingerprint = eventType === "MODIFY"
    ? `${eventTime}:${position.volume}:${position.stopLoss ?? ""}:${position.takeProfit ?? ""}`
    : eventType;
  const dedupeKey = `${strategy.id}:${positionId}:${fingerprint}`;
  const { data, error } = await supabase.from("copy_master_events").insert({
    strategy_id: strategy.id,
    master_account_id: strategy.master_account_id,
    event_type: eventType,
    master_trade_id: positionId,
    symbol: position.symbol,
    side: position.type === "POSITION_TYPE_SELL" ? "SELL" : "BUY",
    volume: Number(position.volume ?? 0),
    previous_volume: previous ? Number(previous.volume ?? 0) : null,
    open_price: Number(position.openPrice ?? 0),
    close_price: eventType === "CLOSE" ? Number(position.currentPrice ?? 0) : null,
    stop_loss: position.stopLoss ?? null,
    take_profit: position.takeProfit ?? null,
    event_time: eventTime,
    dedupe_key: dedupeKey,
    source_sequence: fingerprint,
    source: getBrokerProviderId() === "api2trade" ? "API2TRADE_LIVE_SOURCE" : "WSA_STREAM",
    raw_payload: { source: getBrokerProviderId() === "api2trade" ? "API2TRADE_LIVE_SOURCE" : "METAAPI_STREAM", eventType },
  }).select("id").single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return;
    throw new Error(`Master event could not be stored: ${error.message}`);
  }
  const brokerEventAgeMs = Date.now() - new Date(eventTime).getTime();
  console.log(
    `[copy-worker] detected ${eventType} ${position.symbol} ${Number(position.volume ?? 0)} lot(s) in ${Date.now() - startedAt}ms; broker event age ${brokerEventAgeMs}ms`,
  );
  if (getBrokerProviderId() === "api2trade" && process.env.WSA_COPY_DIRECT_EXECUTION !== "false") {
    try {
      const result = await executeCopyForEvent({
        id: data.id,
        strategy_id: strategy.id,
        event_type: eventType,
        master_trade_id: positionId,
        symbol: position.symbol,
        side: position.type === "POSITION_TYPE_SELL" ? "SELL" : "BUY",
        volume: Number(position.volume ?? 0),
        previous_volume: previous ? Number(previous.volume ?? 0) : null,
        stop_loss: position.stopLoss ?? null,
        take_profit: position.takeProfit ?? null,
        event_time: eventTime,
      } satisfies LinkedEvent, null, startedAt);
      console.log(
        `[copy-worker] direct copy event ${data.id} finished in ${Date.now() - startedAt}ms: ${result.success} succeeded, ${result.failed} failed, ${result.skipped} skipped`,
      );
      return;
    } catch (error) {
      console.error(
        `[copy-worker] direct copy event failed for ${data.id}; queued retry: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }
  await enqueueJob({
    type: "EXECUTE_COPY_EVENT",
    payload: { masterEventId: data.id },
    uniqueKey: `EXECUTE_COPY_EVENT:${data.id}`,
    priority: 200,
  });
}

async function openStrategyStream(strategy: LiveStrategy): Promise<StreamHandle> {
  const providerAccountId = strategy.trading_accounts?.provider_account_id;
  if (!providerAccountId) throw new Error("Master account has no broker provider account.");
  if (getBrokerProviderId() === "api2trade") {
    const adapter = createBrokerAdapter();
    const health = await adapter.verifyConnection(strategy.master_account_id);
    if (!health.ok) throw new Error(health.message);
    const source = Api2TradeLiveAccountSource.fromEnv(providerAccountId);
    await source.reconnect();
    let lastWarmupAt = 0;
    let warmupInFlight: Promise<void> | null = null;
    const warmStrategyAccounts = async (force = false) => {
      if (!force && Date.now() - lastWarmupAt < warmupMs) return;
      if (warmupInFlight) return warmupInFlight;
      lastWarmupAt = Date.now();
      warmupInFlight = warmCopyStrategyAccounts(strategy.id, strategy.master_account_id, adapter)
        .then((result) => {
          if (result.warmed > 0) {
            console.log(`[copy-worker] prewarmed ${result.warmed} API2Trade account session(s) for strategy ${strategy.id}`);
          }
        })
        .catch((error) => {
          console.error(`[copy-worker] API2Trade prewarm failed for strategy ${strategy.id}: ${error instanceof Error ? error.message : "unknown error"}`);
        })
        .finally(() => {
          warmupInFlight = null;
        });
      return warmupInFlight;
    };
    await warmStrategyAccounts(true);
    const warmTicker = setInterval(() => {
      void warmStrategyAccounts(false);
    }, warmupMs);
    const handle: StreamHandle = {
      async reconcile() {
        const events = await source.reconcile({ emitExistingAsOpen: true });
        for (const event of events) {
          await persistEvent(strategy, event.eventType, event.position, event.previous);
        }
        await createAdminClient().from("copy_strategies").update({
          engine_status: "LIVE",
          engine_error: null,
          engine_heartbeat_at: new Date().toISOString(),
        }).eq("id", strategy.id);
      },
      async close() {
        clearInterval(warmTicker);
        await source.close();
      },
    };
    await handle.reconcile();
    console.log(
      `[copy-worker] API2Trade ${source.usingWebSocket() ? "websocket" : "polling fallback"} synchronized for strategy ${strategy.id}`,
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
      if (!previous) await persistEvent(strategy, "OPEN", position);
      else if (changed(previous, position)) await persistEvent(strategy, "MODIFY", position, previous);
    }
    async onPositionRemoved(_instanceIndex: string, positionId: string) {
      const previous = positions.get(String(positionId));
      positions.delete(String(positionId));
      if (ready && previous) await persistEvent(strategy, "CLOSE", previous);
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
    await persistEvent(strategy, "OPEN", position);
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
        if (!previous) await persistEvent(strategy, "OPEN", position);
        else if (changed(previous, position)) await persistEvent(strategy, "MODIFY", position, previous);
      }
      for (const [key, previous] of positions) {
        if (!current.has(key)) await persistEvent(strategy, "CLOSE", previous);
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

async function openSelfCopyStream(source: LiveSelfCopySource): Promise<StreamHandle> {
  const providerAccountId = source.trading_accounts?.provider_account_id;
  if (!providerAccountId) throw new Error("Self-copy source has no broker provider account.");
  if (getBrokerProviderId() === "api2trade") {
    const health = await createBrokerAdapter().verifyConnection(source.source_account_id);
    if (!health.ok) throw new Error(health.message);
    const liveSource = Api2TradeLiveAccountSource.fromEnv(providerAccountId);
    await liveSource.reconnect();
    let queue = Promise.resolve();
    const dispatch = (eventType: "OPEN" | "MODIFY" | "CLOSE", position: Position, previous?: Position) => {
      queue = queue.then(async () => {
        const outcome = await executeSelfCopyPositionEvent({
          sourceAccountId: source.source_account_id,
          eventType,
          sourcePositionId: String(position.id),
          symbol: position.symbol,
          side: position.type === "POSITION_TYPE_SELL" ? "SELL" : "BUY",
          volume: Number(position.volume ?? 0),
          previousVolume: previous ? Number(previous.volume ?? 0) : null,
          stopLoss: position.stopLoss ?? null,
          takeProfit: position.takeProfit ?? null,
        });
        if (outcome.attempted || outcome.failed) {
          console.log(`[self-copy] ${eventType} ${position.symbol}: ${outcome.success} succeeded, ${outcome.failed} failed, ${outcome.skipped} skipped`);
        }
      }).catch((error) => {
        console.error(`[self-copy] ${eventType} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
      return queue;
    };
    const handle: StreamHandle = {
      async reconcile() {
        const events = await liveSource.reconcile({ emitExistingAsOpen: true });
        for (const event of events) {
          await dispatch(event.eventType, event.position, event.previous);
        }
      },
      async close() {
        await queue;
        await liveSource.close();
      },
    };
    await handle.reconcile();
    console.log(`[self-copy] API2Trade live source synchronized for ${source.source_account_id}`);
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

  const dispatch = (eventType: "OPEN" | "MODIFY" | "CLOSE", position: Position, previous?: Position) => {
    queue = queue.then(async () => {
      const outcome = await executeSelfCopyPositionEvent({
        sourceAccountId: source.source_account_id,
        eventType,
        sourcePositionId: String(position.id),
        symbol: position.symbol,
        side: position.type === "POSITION_TYPE_SELL" ? "SELL" : "BUY",
        volume: Number(position.volume ?? 0),
        previousVolume: previous ? Number(previous.volume ?? 0) : null,
        stopLoss: position.stopLoss ?? null,
        takeProfit: position.takeProfit ?? null,
      });
      if (outcome.attempted || outcome.failed) {
        console.log(`[self-copy] ${eventType} ${position.symbol}: ${outcome.success} succeeded, ${outcome.failed} failed, ${outcome.skipped} skipped`);
      }
    }).catch((error) => {
      console.error(`[self-copy] ${eventType} failed: ${error instanceof Error ? error.message : "unknown error"}`);
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

  // Recover opens and closes missed while the worker was offline.
  for (const position of positions.values()) await dispatch("OPEN", position);
  const { data: openLinks } = await createAdminClient()
    .from("self_copy_trade_links")
    .select("source_position_id, symbol, side, copied_volume")
    .eq("source_account_id", source.source_account_id)
    .eq("status", "OPEN");
  const uniqueMissing = new Map(
    (openLinks ?? [])
      .filter((link) => !positions.has(String(link.source_position_id)))
      .map((link) => [String(link.source_position_id), link]),
  );
  for (const link of uniqueMissing.values()) {
    await dispatch("CLOSE", {
      id: link.source_position_id,
      type: link.side === "SELL" ? "POSITION_TYPE_SELL" : "POSITION_TYPE_BUY",
      symbol: link.symbol,
      volume: Number(link.copied_volume ?? 0),
      openPrice: 0,
    });
  }

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

async function reconcileStreams() {
  if (Date.now() >= nextLifecycleScanAt) {
    const expired = await expireStaleTradingAccounts();
    if (expired > 0) {
      console.log(`[copy-worker] moved ${expired} stale or incomplete account(s) out of live status`);
    }
    nextLifecycleScanAt = Date.now() + 60 * 60 * 1_000;
  }
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("copy_strategies")
    .select("id, master_account_id, trading_accounts!master_account_id(provider_account_id)")
    .eq("status", "ACTIVE").eq("live_enabled", true).in("engine_status", ["LIVE", "STARTING", "ERROR"]).limit(500);
  if (error) throw new Error(`Live strategies could not be loaded: ${error.message}`);
  const active = new Map((data ?? []).map((entry) => [entry.id, entry as unknown as LiveStrategy]));
  for (const [strategyId, handle] of streams) {
    if (!active.has(strategyId)) {
      await handle.close();
      streams.delete(strategyId);
    }
  }
  for (const strategy of active.values()) {
    if (streams.has(strategy.id)) {
      try {
        await streams.get(strategy.id)!.reconcile();
        retryAfter.delete(`strategy:${strategy.id}`);
        await supabase.from("copy_strategies").update({
          engine_status: "LIVE",
          engine_error: null,
          engine_heartbeat_at: new Date().toISOString(),
        }).eq("id", strategy.id);
      } catch (error) {
        await streams.get(strategy.id)!.close().catch(() => undefined);
        streams.delete(strategy.id);
        retryAfter.set(`strategy:${strategy.id}`, Date.now() + retryDelayMs());
        const message = (error instanceof Error ? error.message : "Master stream failed").slice(0, 400);
        await supabase.from("copy_strategies").update({
          engine_status: "ERROR",
          engine_error: message,
        }).eq("id", strategy.id);
        console.error(`[copy-worker] active master stream failed for ${strategy.id}: ${message}`);
      }
      continue;
    }
    if ((retryAfter.get(`strategy:${strategy.id}`) ?? 0) > Date.now()) continue;
    try {
      streams.set(strategy.id, await openStrategyStream(strategy));
      retryAfter.delete(`strategy:${strategy.id}`);
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Master stream failed").slice(0, 400);
      retryAfter.set(`strategy:${strategy.id}`, Date.now() + retryDelayMs());
      await supabase.from("copy_strategies").update({ engine_status: "ERROR", engine_error: message }).eq("id", strategy.id);
    }
  }

  const { data: relationshipRows, error: relationshipError } = await supabase
    .from("self_copy_relationships")
    .select("source_account_id, trading_accounts!source_account_id(provider_account_id)")
    .eq("status", "LIVE")
    .limit(1000);
  if (relationshipError) throw new Error(`Live self-copy sources could not be loaded: ${relationshipError.message}`);
  const activeSources = new Map<string, LiveSelfCopySource>();
  for (const row of relationshipRows ?? []) {
    const source = row as unknown as LiveSelfCopySource;
    activeSources.set(source.source_account_id, source);
  }
  for (const [sourceAccountId, handle] of selfCopyStreams) {
    if (!activeSources.has(sourceAccountId)) {
      await handle.close();
      selfCopyStreams.delete(sourceAccountId);
    }
  }
  for (const source of activeSources.values()) {
    if (selfCopyStreams.has(source.source_account_id)) {
      try {
        await selfCopyStreams.get(source.source_account_id)!.reconcile();
        retryAfter.delete(`self:${source.source_account_id}`);
      } catch (error) {
        await selfCopyStreams.get(source.source_account_id)!.close().catch(() => undefined);
        selfCopyStreams.delete(source.source_account_id);
        retryAfter.set(`self:${source.source_account_id}`, Date.now() + retryDelayMs());
        console.error(
          `[self-copy] active source stream failed for ${source.source_account_id}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
      continue;
    }
    if ((retryAfter.get(`self:${source.source_account_id}`) ?? 0) > Date.now()) continue;
    try {
      selfCopyStreams.set(source.source_account_id, await openSelfCopyStream(source));
      retryAfter.delete(`self:${source.source_account_id}`);
    } catch (error) {
      retryAfter.set(`self:${source.source_account_id}`, Date.now() + retryDelayMs());
      console.error(`[self-copy] source stream failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}

async function shutdown() {
  stopping = true;
  await Promise.allSettled([...streams.values()].map((stream) => stream.close()));
  await Promise.allSettled([...selfCopyStreams.values()].map((stream) => stream.close()));
  streams.clear();
  selfCopyStreams.clear();
  retryAfter.clear();
}

async function main() {
  if (process.env.WSA_COPY_ENGINE_ENABLED !== "true") {
    throw new Error("WSA copy worker is disabled.");
  }
  if (!process.env.API2TRADE_BASE_URL || !(process.env.API2TRADE_USERNAME && process.env.API2TRADE_PASSWORD)) {
    throw new Error("API2Trade copy worker requires API2TRADE_BASE_URL plus paid MT5 API username/password.");
  }
  console.log("[copy-worker] API2Trade websocket-first source enabled; WSA engine remains local.");
  if (process.env.BROKER_EXECUTION_ENABLED !== "true") {
    throw new Error("BROKER_EXECUTION_ENABLED must be true before the live WSA worker can start.");
  }
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  while (!stopping) {
    try {
      await reconcileStreams();
      await runWorkerOnce({ workerId, limit: 25, types: ["EXECUTE_COPY_EVENT", "CLOSE_COPY_STRATEGY", "RETRY_COPY_LOG"] });
    } catch (error) {
      console.error(
        `[copy-worker] reconcile cycle failed; retrying in ${pollMs}ms: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch(async (error) => {
  await shutdown();
  console.error(error instanceof Error ? error.message : "WSA copy worker failed.");
  process.exitCode = 1;
});
