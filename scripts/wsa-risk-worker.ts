import { createAdminClient } from "../src/lib/supabase/admin";
import { loadEnvConfig } from "@next/env";
import {
  evaluateAndEnforceRiskValues,
  type LiveRiskValues,
} from "../src/lib/services/riskEvaluationService";

/* eslint-disable @typescript-eslint/no-explicit-any */

loadEnvConfig(process.cwd());

type RiskAccount = { id: string; provider_account_id: string };
type StreamHandle = { evaluateNow(): Promise<void>; close(): Promise<void> };

const reconcileMs = Math.max(
  2_000,
  Number.parseInt(process.env.WSA_RISK_RECONCILE_MS ?? "5000", 10) || 5_000,
);
const snapshotMs = Math.max(
  10_000,
  Number.parseInt(process.env.WSA_RISK_SNAPSHOT_MS ?? "30000", 10) || 30_000,
);
const liveCopyStreamEnabled =
  process.env.WSA_COPY_ENGINE_ENABLED === "true"
  && process.env.BROKER_EXECUTION_ENABLED === "true";
const streams = new Map<string, StreamHandle>();
let stopping = false;

function utcDayStart(): Date {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function isClosingDeal(deal: any): boolean {
  return deal?.entryType === "DEAL_ENTRY_OUT" || deal?.entryType === "DEAL_ENTRY_OUT_BY";
}

function isOpeningDeal(deal: any): boolean {
  return deal?.entryType === "DEAL_ENTRY_IN" || deal?.entryType === "DEAL_ENTRY_INOUT";
}

function safeIso(value: unknown, fallback = new Date().toISOString()): string {
  if (value == null) return fallback;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "number" ? value * 1_000 : String(value));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function numbersMatch(left: unknown, right: unknown): boolean {
  return Math.abs(Number(left ?? 0) - Number(right ?? 0)) < 0.005;
}

function datesMatch(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left === right;
  const leftTime = new Date(String(left)).getTime();
  const rightTime = new Date(String(right)).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

async function openRiskStream(accountRow: RiskAccount): Promise<StreamHandle> {
  const sdk = await import("metaapi.cloud-sdk/node") as unknown as {
    default: new (authToken: string) => {
      metatraderAccountApi: { getAccount(id: string): Promise<any> };
      close(): void;
    };
    SynchronizationListener: new () => any;
  };
  const api = new sdk.default(process.env.METAAPI_TOKEN!);
  const account = await api.metatraderAccountApi.getAccount(accountRow.provider_account_id);
  if (account.state !== "DEPLOYED") {
    await account.deploy();
    await account.waitDeployed(120, 1_000);
  }
  await account.waitConnected(120, 1_000);
  const connection = account.getStreamingConnection(undefined, utcDayStart());
  let ready = false;
  let evaluating: Promise<void> | null = null;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tradeTimer: ReturnType<typeof setTimeout> | null = null;
  let projectingTrades: Promise<void> | null = null;
  let tradeProjectionQueued = false;
  let lastSnapshotAt = 0;
  let lastEvaluationCheckAt = 0;

  const readValues = (): LiveRiskValues => {
    const info = connection.terminalState.accountInformation ?? {};
    const balance = Number(info.balance ?? 0);
    const equity = Number(info.equity ?? balance);
    const dailyProfit = connection.historyStorage
      .getDealsByTimeRange(utcDayStart(), new Date())
      .filter(isClosingDeal)
      .reduce((sum: number, deal: any) => sum + Number(deal.profit ?? 0), 0);
    return {
      balance,
      equity,
      openTradeCount: (connection.terminalState.positions ?? []).length,
      dailyProfit,
    };
  };

  const persistSnapshot = async (values: LiveRiskValues) => {
    const now = Date.now();
    if (now - lastSnapshotAt < snapshotMs) return;
    lastSnapshotAt = now;
    const drawdown = values.balance > 0
      ? Math.max(0, ((values.balance - values.equity) / values.balance) * 100)
      : 0;
    const { error } = await createAdminClient().from("account_snapshots").insert({
      trading_account_id: accountRow.id,
      balance: values.balance,
      equity: values.equity,
      floating_pnl: values.equity - values.balance,
      drawdown_percent: drawdown,
    });
    if (error) console.error(`[risk-worker] snapshot failed for ${accountRow.id}: ${error.message}`);
  };

  const persistLiveTrades = async (): Promise<void> => {
    if (!ready) return;
    if (projectingTrades) {
      tradeProjectionQueued = true;
      return projectingTrades;
    }

    projectingTrades = (async () => {
      do {
        tradeProjectionQueued = false;
        const supabase = createAdminClient();
        const positions = (connection.terminalState.positions ?? []) as any[];
        const accountInfo = connection.terminalState.accountInformation ?? {};
        const currency = String(accountInfo.currency ?? "USD");
        const activePositionIds = new Set(positions.map((position) => String(position.id)));
        const deals = connection.historyStorage.getDealsByTimeRange(utcDayStart(), new Date()) as any[];

        const openRows = positions.map((position) => ({
          trading_account_id: accountRow.id,
          external_trade_id: String(position.id),
          symbol: String(position.symbol ?? ""),
          side: position.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL",
          status: "OPEN" as const,
          volume: Number(position.volume ?? 0),
          open_price: Number(position.openPrice ?? 0),
          close_price: null,
          profit: Number(position.profit ?? 0),
          currency,
          opened_at: safeIso(position.openTime),
          closed_at: null,
        }));

        const closingDealsByPosition = new Map<string, any[]>();
        for (const deal of deals.filter(isClosingDeal)) {
          const positionId = String(deal.positionId ?? deal.id);
          if (activePositionIds.has(positionId)) continue;
          const group = closingDealsByPosition.get(positionId) ?? [];
          group.push(deal);
          closingDealsByPosition.set(positionId, group);
        }

        const externalIds = [
          ...activePositionIds,
          ...closingDealsByPosition.keys(),
        ];
        if (externalIds.length === 0) {
          continue;
        }

        const { data: existingRows, error: existingError } = await supabase
          .from("trades")
          .select("id, external_trade_id, symbol, side, status, volume, open_price, close_price, profit, currency, opened_at, closed_at")
          .eq("trading_account_id", accountRow.id)
          .in("external_trade_id", externalIds);
        if (existingError) throw new Error(existingError.message);
        const existingByExternalId = new Map(
          (existingRows ?? []).map((row) => [String(row.external_trade_id), row]),
        );
        let changedTrade = false;

        for (const row of openRows) {
          const existing = existingByExternalId.get(row.external_trade_id);
          if (!existing) {
            const { error } = await supabase.from("trades").insert(row);
            if (error) throw new Error(error.message);
            changedTrade = true;
            continue;
          }
          const changed =
            existing.status !== "OPEN" ||
            existing.symbol !== row.symbol ||
            existing.side !== row.side ||
            !numbersMatch(existing.volume, row.volume) ||
            !numbersMatch(existing.open_price, row.open_price) ||
            !numbersMatch(existing.profit, row.profit);
          if (!changed) continue;
          const { error } = await supabase
            .from("trades")
            .update({
              symbol: row.symbol,
              side: row.side,
              status: "OPEN",
              volume: row.volume,
              open_price: row.open_price,
              close_price: null,
              profit: row.profit,
              currency: row.currency,
              opened_at: row.opened_at,
              closed_at: null,
            })
            .eq("id", existing.id);
          if (error) throw new Error(error.message);
          changedTrade = true;
        }

        for (const [positionId, closingDeals] of closingDealsByPosition) {
          const ordered = [...closingDeals].sort(
            (left, right) =>
              new Date(safeIso(left.time, "1970-01-01T00:00:00.000Z")).getTime() -
              new Date(safeIso(right.time, "1970-01-01T00:00:00.000Z")).getTime(),
          );
          const lastClose = ordered.at(-1)!;
          const openingDeal = deals
            .filter((deal) => String(deal.positionId ?? deal.id) === positionId && isOpeningDeal(deal))
            .sort(
              (left, right) =>
                new Date(safeIso(left.time, "1970-01-01T00:00:00.000Z")).getTime() -
                new Date(safeIso(right.time, "1970-01-01T00:00:00.000Z")).getTime(),
            )[0];
          const existing = existingByExternalId.get(positionId);
          const closedAt = safeIso(lastClose.time);
          const closedProfit = ordered.reduce(
            (total, deal) => total + Number(deal.profit ?? 0),
            0,
          );
          if (existing) {
            const changed =
              existing.status !== "CLOSED" ||
              !numbersMatch(existing.close_price, lastClose.price) ||
              !numbersMatch(existing.profit, closedProfit) ||
              !datesMatch(existing.closed_at, closedAt);
            if (!changed) continue;
            const { error } = await supabase
              .from("trades")
              .update({
                status: "CLOSED",
                close_price: Number(lastClose.price ?? 0),
                profit: closedProfit,
                closed_at: closedAt,
              })
              .eq("id", existing.id);
            if (error) throw new Error(error.message);
            changedTrade = true;
            continue;
          }

          const openingType = openingDeal?.type;
          const fallbackSide = lastClose.type === "DEAL_TYPE_BUY" ? "SELL" : "BUY";
          const { error } = await supabase.from("trades").insert({
            trading_account_id: accountRow.id,
            external_trade_id: positionId,
            symbol: String(openingDeal?.symbol ?? lastClose.symbol ?? ""),
            side: openingType
              ? openingType === "DEAL_TYPE_BUY" ? "BUY" : "SELL"
              : fallbackSide,
            status: "CLOSED",
            volume: Number(openingDeal?.volume ?? lastClose.volume ?? 0),
            open_price: Number(openingDeal?.price ?? 0),
            close_price: Number(lastClose.price ?? 0),
            profit: closedProfit,
            currency,
            opened_at: safeIso(openingDeal?.time, closedAt),
            closed_at: closedAt,
          });
          if (error) throw new Error(error.message);
          changedTrade = true;
        }

        if (changedTrade) {
          await supabase
            .from("trading_accounts")
            .update({ last_synced_at: new Date().toISOString(), sync_error: null })
            .eq("id", accountRow.id);
        }
      } while (tradeProjectionQueued && !stopping);
    })().finally(() => {
      projectingTrades = null;
    });
    return projectingTrades;
  };

  const evaluate = async () => {
    if (!ready) return;
    if (evaluating) {
      queued = true;
      return evaluating;
    }
    evaluating = (async () => {
      do {
        queued = false;
        const values = readValues();
        await persistSnapshot(values);
        const result = await evaluateAndEnforceRiskValues({
          accountId: accountRow.id,
          actorUserId: null,
          source: "METAAPI_STREAM",
          values,
        });
        if (result.blockedNewTrades) {
          console.warn(
            `[risk-worker] ${accountRow.id} blocked by ${result.breachedRuleNames.join(", ")}`,
          );
        }
        if (Date.now() - lastEvaluationCheckAt >= 30_000) {
          lastEvaluationCheckAt = Date.now();
          const { data: attempt } = await createAdminClient()
            .from("evaluation_attempts")
            .select("id")
            .eq("trading_account_id", accountRow.id)
            .in("status", ["ACTIVE", "NEEDS_REVIEW"])
            .limit(1)
            .maybeSingle();
          if (attempt) {
            const { adminRunEvaluationCheck } = await import("../src/lib/services/evaluationService");
            const outcome = await adminRunEvaluationCheck(attempt.id, null);
            if (outcome.result.result !== "NO_CHANGE") {
              console.log(`[risk-worker] evaluation ${attempt.id}: ${outcome.result.result}`);
            }
          }
        }
      } while (queued && !stopping);
    })().finally(() => {
      evaluating = null;
    });
    return evaluating;
  };

  const scheduleEvaluation = () => {
    if (!ready || stopping) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void evaluate().catch((error) => {
      console.error(
        `[risk-worker] evaluation failed for ${accountRow.id}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }), 150);
  };

  const scheduleTradeProjection = () => {
    if (!ready || stopping) return;
    if (tradeTimer) return;
    tradeTimer = setTimeout(() => {
      tradeTimer = null;
      void persistLiveTrades().catch((error) => {
        console.error(
          `[risk-worker] live trade projection failed for ${accountRow.id}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
    }, 1_000);
  };

  class RiskListener extends sdk.SynchronizationListener {
    async onAccountInformationUpdated() { scheduleEvaluation(); }
    async onPositionsReplaced() { scheduleEvaluation(); scheduleTradeProjection(); }
    async onPositionUpdated() { scheduleEvaluation(); scheduleTradeProjection(); }
    async onPositionRemoved() { scheduleEvaluation(); scheduleTradeProjection(); }
    async onDealAdded() { scheduleEvaluation(); scheduleTradeProjection(); }
  }

  const listener = new RiskListener();
  connection.addSynchronizationListener(listener);
  await connection.connect();
  await connection.waitSynchronized({ timeoutInSeconds: 120 });
  ready = true;
  await persistLiveTrades();
  await evaluate();
  console.log(
    `[risk-worker] monitoring account ${accountRow.id} with ${
      connection.terminalState.positions?.length ?? 0
    } open position(s)`,
  );

  return {
    evaluateNow: evaluate,
    async close() {
      ready = false;
      if (timer) clearTimeout(timer);
      if (tradeTimer) clearTimeout(tradeTimer);
      connection.removeSynchronizationListener(listener);
      await connection.close();
      api.close();
    },
  };
}

async function reconcileStreams() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("trading_accounts")
    .select("id, provider_account_id")
    .not("provider_account_id", "is", null)
    .in("status", ["CONNECTED", "RESTRICTED"])
    .limit(2_000);
  if (error) throw new Error(`Risk accounts could not be loaded: ${error.message}`);
  const copyOwnedMasterIds = new Set<string>();
  if (liveCopyStreamEnabled) {
    const { data: strategyRows, error: strategyError } = await supabase
      .from("copy_strategies")
      .select("master_account_id")
      .eq("status", "ACTIVE")
      .eq("live_enabled", true)
      .in("engine_status", ["LIVE", "STARTING", "ERROR"])
      .limit(1_000);
    if (strategyError) {
      throw new Error(`Copy-owned risk accounts could not be loaded: ${strategyError.message}`);
    }
    for (const strategy of strategyRows ?? []) {
      copyOwnedMasterIds.add(strategy.master_account_id);
    }
  }
  const active = new Map(
    (data ?? [])
      .filter((account) => !copyOwnedMasterIds.has(account.id))
      .map((account) => [account.id, account as RiskAccount]),
  );

  for (const [accountId, stream] of streams) {
    if (!active.has(accountId)) {
      await stream.close();
      streams.delete(accountId);
    }
  }
  for (const accountRow of active.values()) {
    const stream = streams.get(accountRow.id);
    if (stream) {
      await stream.evaluateNow();
      continue;
    }
    try {
      console.log(`[risk-worker] connecting account ${accountRow.id}`);
      streams.set(accountRow.id, await openRiskStream(accountRow));
    } catch (error) {
      console.error(
        `[risk-worker] stream failed for ${accountRow.id}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
}

async function shutdown() {
  stopping = true;
  await Promise.allSettled([...streams.values()].map((stream) => stream.close()));
  streams.clear();
}

async function main() {
  if (!process.env.METAAPI_TOKEN) {
    throw new Error("METAAPI_TOKEN is required for the WSA live risk worker.");
  }
  console.log(`[risk-worker] started; reconciling every ${reconcileMs}ms`);
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  while (!stopping) {
    await reconcileStreams();
    await new Promise((resolve) => setTimeout(resolve, reconcileMs));
  }
}

main().catch(async (error) => {
  await shutdown();
  console.error(error instanceof Error ? error.message : "WSA risk worker failed.");
  process.exitCode = 1;
});
