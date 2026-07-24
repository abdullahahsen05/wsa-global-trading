import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueJob } from "../src/lib/services/backgroundJobService";
import { runWorkerOnce } from "../src/lib/workers/jobProcessor";
import { executeSelfCopyPositionEvent } from "../src/lib/services/selfCopyService";
import { expireStaleTradingAccounts } from "../src/lib/services/tradingAccountLifecycleService";

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

const pollMs = Math.max(500, Number.parseInt(process.env.WSA_COPY_POLL_MS ?? "1000", 10) || 1_000);
const workerId = `wsa-copy-${process.pid}`;
const streams = new Map<string, StreamHandle>();
const selfCopyStreams = new Map<string, StreamHandle>();
let stopping = false;
let nextLifecycleScanAt = 0;

function iso(value?: Date | string) {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function changed(previous: Position, current: Position) {
  return Number(previous.volume) !== Number(current.volume)
    || Number(previous.stopLoss ?? 0) !== Number(current.stopLoss ?? 0)
    || Number(previous.takeProfit ?? 0) !== Number(current.takeProfit ?? 0);
}

async function persistEvent(strategy: LiveStrategy, eventType: "OPEN" | "MODIFY" | "CLOSE", position: Position, previous?: Position) {
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
    source: "WSA_STREAM",
    raw_payload: { source: "METAAPI_STREAM", eventType },
  }).select("id").single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return;
    throw new Error(`Master event could not be stored: ${error.message}`);
  }
  console.log(`[copy-worker] detected ${eventType} ${position.symbol} ${Number(position.volume ?? 0)} lot(s)`);
  await enqueueJob({
    type: "EXECUTE_COPY_EVENT",
    payload: { masterEventId: data.id },
    uniqueKey: `EXECUTE_COPY_EVENT:${data.id}`,
    priority: 200,
  });
}

async function openStrategyStream(strategy: LiveStrategy): Promise<StreamHandle> {
  const providerAccountId = strategy.trading_accounts?.provider_account_id;
  if (!providerAccountId) throw new Error("Master account has no MetaApi provider account.");
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
  if (!providerAccountId) throw new Error("Self-copy source has no MetaApi provider account.");
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
      await streams.get(strategy.id)!.reconcile();
      await supabase.from("copy_strategies").update({ engine_heartbeat_at: new Date().toISOString() }).eq("id", strategy.id);
      continue;
    }
    try {
      streams.set(strategy.id, await openStrategyStream(strategy));
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Master stream failed").slice(0, 400);
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
      await selfCopyStreams.get(source.source_account_id)!.reconcile();
      continue;
    }
    try {
      selfCopyStreams.set(source.source_account_id, await openSelfCopyStream(source));
    } catch (error) {
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
}

async function main() {
  if (!process.env.METAAPI_TOKEN || process.env.WSA_COPY_ENGINE_ENABLED !== "true") {
    throw new Error("WSA copy worker is disabled or METAAPI_TOKEN is missing.");
  }
  if (process.env.BROKER_EXECUTION_ENABLED !== "true") {
    throw new Error("BROKER_EXECUTION_ENABLED must be true before the live WSA worker can start.");
  }
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  while (!stopping) {
    await reconcileStreams();
    await runWorkerOnce({ workerId, limit: 25, types: ["EXECUTE_COPY_EVENT", "CLOSE_COPY_STRATEGY", "RETRY_COPY_LOG"] });
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch(async (error) => {
  await shutdown();
  console.error(error instanceof Error ? error.message : "WSA copy worker failed.");
  process.exitCode = 1;
});
