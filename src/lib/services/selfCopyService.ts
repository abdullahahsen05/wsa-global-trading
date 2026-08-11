import { calculateFollowerLot } from "@/lib/copy/lotScaling";
import {
  copyModeToScalingMode,
  mapFollowerSymbol,
  reverseFollowerSide,
} from "@/lib/copy/settings";
import { COPY_ERROR, CopyError } from "@/lib/copy/types";
import { BrokerExecutionError } from "@/lib/broker/BrokerAdapter";
import { createBrokerAdapter } from "@/lib/broker/provider";
import type { FollowerSettingsPatch } from "@/lib/services/copyTradingService";
import { getCopyGlobalSettings } from "@/lib/services/copyTradingService";
import { writeAuditLog } from "@/lib/services/auditService";
import { getRiskEnforcementState } from "@/lib/services/riskService";
import { createAdminClient } from "@/lib/supabase/admin";

export type SelfCopyStatus = "LIVE" | "PAUSED" | "ARCHIVED";

export interface SelfCopyRelationshipDto {
  id: string;
  traderId: string;
  sourceAccountId: string;
  sourceAccountName: string;
  sourceStatus: string;
  followerAccountId: string;
  followerAccountName: string;
  followerStatus: string;
  status: SelfCopyStatus;
  copySettings: FollowerSettingsPatch;
  createdAt: string;
  updatedAt: string;
}

interface RelationshipRow {
  id: string;
  trader_id: string;
  source_account_id: string;
  follower_account_id: string;
  status: SelfCopyStatus;
  copy_settings: FollowerSettingsPatch;
  created_at: string;
  updated_at: string;
}

const ELIGIBLE_ACCOUNT_STATUSES = new Set(["CONNECTED", "SYNCING"]);

async function ownedAccountMap(traderId: string, accountIds?: string[]) {
  const supabase = createAdminClient();
  let query = supabase
    .from("trading_accounts")
    .select("id, account_name, status, account_usage")
    .eq("user_id", traderId);
  if (accountIds?.length) query = query.in("id", accountIds);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load trader accounts: ${error.message}`);
  return new Map((data ?? []).map((account) => [account.id, account]));
}

function hasPath(
  edges: Array<{ source: string; follower: string }>,
  start: string,
  target: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.follower]);
  }
  const queue = [start];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function validateSupportedSettings(settings: FollowerSettingsPatch): void {
  if (!copyModeToScalingMode(settings.copyMode)) {
    throw new CopyError(
      COPY_ERROR.VALIDATION_ERROR,
      "Risk-percent mode is coming soon and cannot be enabled yet.",
      400,
    );
  }
}

export async function listSelfCopyRelationships(traderId: string): Promise<SelfCopyRelationshipDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("self_copy_relationships")
    .select("id, trader_id, source_account_id, follower_account_id, status, copy_settings, created_at, updated_at")
    .eq("trader_id", traderId)
    .neq("status", "ARCHIVED")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load self-copy setups: ${error.message}`);
  const rows = (data ?? []) as RelationshipRow[];
  const accounts = await ownedAccountMap(
    traderId,
    [...new Set(rows.flatMap((row) => [row.source_account_id, row.follower_account_id]))],
  );
  return rows.map((row) => {
    const source = accounts.get(row.source_account_id);
    const follower = accounts.get(row.follower_account_id);
    return {
      id: row.id,
      traderId: row.trader_id,
      sourceAccountId: row.source_account_id,
      sourceAccountName: source?.account_name ?? "Source account",
      sourceStatus: source?.status ?? "UNKNOWN",
      followerAccountId: row.follower_account_id,
      followerAccountName: follower?.account_name ?? "Follower account",
      followerStatus: follower?.status ?? "UNKNOWN",
      status: row.status,
      copySettings: row.copy_settings,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export async function createSelfCopyRelationship(params: {
  traderId: string;
  sourceAccountId: string;
  followerAccountId: string;
  copySettings: FollowerSettingsPatch;
}): Promise<SelfCopyRelationshipDto> {
  if (params.sourceAccountId === params.followerAccountId) {
    throw new CopyError(COPY_ERROR.VALIDATION_ERROR, "Source and follower accounts must be different.", 400);
  }
  validateSupportedSettings(params.copySettings);
  const accounts = await ownedAccountMap(params.traderId, [
    params.sourceAccountId,
    params.followerAccountId,
  ]);
  if (accounts.size !== 2) {
    throw new CopyError(COPY_ERROR.FORBIDDEN, "Both accounts must belong to you.", 403);
  }
  for (const accountId of [params.sourceAccountId, params.followerAccountId]) {
    const account = accounts.get(accountId);
    const status = account?.status ?? "UNKNOWN";
    if (account?.account_usage === "EVALUATION") {
      throw new CopyError(
        COPY_ERROR.FOLLOWER_NOT_ELIGIBLE,
        "Evaluation accounts cannot be used for self-copy.",
        409,
      );
    }
    if (!ELIGIBLE_ACCOUNT_STATUSES.has(status)) {
      throw new CopyError(
        COPY_ERROR.FOLLOWER_NOT_ELIGIBLE,
        `Both accounts must be connected or syncing. Account status is ${status}.`,
        409,
      );
    }
  }

  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("self_copy_relationships")
    .select("source_account_id, follower_account_id")
    .eq("trader_id", params.traderId)
    .in("status", ["LIVE", "PAUSED"]);
  const edges = (existing ?? []).map((row) => ({
    source: row.source_account_id as string,
    follower: row.follower_account_id as string,
  }));
  if (edges.some((edge) => edge.source === params.sourceAccountId && edge.follower === params.followerAccountId)) {
    throw new CopyError(COPY_ERROR.VALIDATION_ERROR, "This self-copy pair already exists.", 409);
  }
  if (hasPath(edges, params.followerAccountId, params.sourceAccountId)) {
    throw new CopyError(COPY_ERROR.VALIDATION_ERROR, "This setup would create a circular copy chain.", 409);
  }

  const { data, error } = await supabase
    .from("self_copy_relationships")
    .insert({
      trader_id: params.traderId,
      source_account_id: params.sourceAccountId,
      follower_account_id: params.followerAccountId,
      status: "LIVE",
      copy_settings: params.copySettings,
    })
    .select("id")
    .single();
  if (error || !data) {
    if (error?.code === "23505") throw new CopyError(COPY_ERROR.VALIDATION_ERROR, "This self-copy pair already exists.", 409);
    throw new Error(`Failed to create self-copy setup: ${error?.message}`);
  }
  await writeAuditLog({
    actorUserId: params.traderId,
    action: "SELF_COPY_CREATED",
    entityType: "self_copy_relationship",
    entityId: data.id,
    metadata: {
      sourceAccountId: params.sourceAccountId,
      followerAccountId: params.followerAccountId,
      mode: "LIVE",
    },
  });
  const result = await listSelfCopyRelationships(params.traderId);
  return result.find((relationship) => relationship.id === data.id)!;
}

export async function updateSelfCopyRelationship(params: {
  traderId: string;
  id: string;
  status?: SelfCopyStatus;
  copySettings?: FollowerSettingsPatch;
}): Promise<void> {
  if (params.copySettings) validateSupportedSettings(params.copySettings);
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("self_copy_relationships")
    .select("id")
    .eq("id", params.id)
    .eq("trader_id", params.traderId)
    .maybeSingle();
  if (!data) throw new CopyError(COPY_ERROR.FORBIDDEN, "Self-copy setup not found or not yours.", 404);
  const patch: Record<string, unknown> = {};
  if (params.status !== undefined) patch.status = params.status;
  if (params.copySettings !== undefined) patch.copy_settings = params.copySettings;
  const { error } = await supabase.from("self_copy_relationships").update(patch).eq("id", params.id);
  if (error) throw new Error(`Failed to update self-copy setup: ${error.message}`);
  await writeAuditLog({
    actorUserId: params.traderId,
    action: "SELF_COPY_UPDATED",
    entityType: "self_copy_relationship",
    entityId: params.id,
    metadata: { status: params.status, settingsUpdated: Boolean(params.copySettings) },
  });
}

async function latestSnapshot(accountId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("account_snapshots")
    .select("balance, equity")
    .eq("trading_account_id", accountId)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { balance: Number(data.balance), equity: Number(data.equity) } : null;
}

export async function simulateSelfCopy(params: { traderId: string; id: string }) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("self_copy_relationships")
    .select("id, source_account_id, follower_account_id, status, copy_settings")
    .eq("id", params.id)
    .eq("trader_id", params.traderId)
    .maybeSingle();
  if (!data) throw new CopyError(COPY_ERROR.FORBIDDEN, "Self-copy setup not found or not yours.", 404);
  if (data.status !== "SIMULATION") {
    throw new CopyError(COPY_ERROR.FOLLOWER_NOT_ELIGIBLE, "Resume this setup before simulating it.", 409);
  }
  const accounts = await ownedAccountMap(params.traderId, [
    data.source_account_id,
    data.follower_account_id,
  ]);
  for (const accountId of [data.source_account_id, data.follower_account_id]) {
    const status = accounts.get(accountId)?.status ?? "UNKNOWN";
    if (!ELIGIBLE_ACCOUNT_STATUSES.has(status)) {
      throw new CopyError(
        COPY_ERROR.FOLLOWER_NOT_ELIGIBLE,
        `Simulation paused because an account status is ${status}.`,
        409,
      );
    }
  }
  const settings = data.copy_settings as FollowerSettingsPatch;
  if (!settings.copyEnabled || settings.emergencyStop) {
    throw new CopyError(COPY_ERROR.COPY_RISK_BLOCKED, "Copying is paused by follower settings.", 409);
  }
  const { data: trade } = await supabase
    .from("trades")
    .select("id, symbol, side, volume, opened_at")
    .eq("trading_account_id", data.source_account_id)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!trade) {
    return {
      simulated: false,
      message: "No synced source trade is available for a simulation preview.",
      liveExecution: false,
    };
  }
  const [sourceSnapshot, followerSnapshot] = await Promise.all([
    latestSnapshot(data.source_account_id),
    latestSnapshot(data.follower_account_id),
  ]);
  const scalingMode = copyModeToScalingMode(settings.copyMode);
  if (!scalingMode) throw new CopyError(COPY_ERROR.COPY_INVALID_LOT, "Selected mode is not supported.", 400);
  const lot = calculateFollowerLot({
    masterLot: Number(trade.volume),
    masterBalance: sourceSnapshot?.balance ?? null,
    masterEquity: sourceSnapshot?.equity ?? null,
    followerBalance: followerSnapshot?.balance ?? null,
    followerEquity: followerSnapshot?.equity ?? null,
    scalingMode,
    fixedLot: settings.fixedLot,
    riskMultiplier: settings.lotMultiplier,
    minLot: settings.minLot,
    maxLot: settings.maxLot,
  });
  const result = {
    simulated: lot.lot > 0,
    message: lot.lot > 0
      ? "Simulation preview calculated. No broker order was sent."
      : lot.reason ?? "Simulation could not calculate a safe lot.",
    sourceTradeId: trade.id,
    sourceSymbol: trade.symbol,
    followerSymbol: mapFollowerSymbol(trade.symbol, settings.symbolMapping),
    followerSide: reverseFollowerSide(trade.side, settings.reverseCopy),
    calculatedLot: lot.lot,
    liveExecution: false,
  };
  await writeAuditLog({
    actorUserId: params.traderId,
    action: "SELF_COPY_SIMULATED",
    entityType: "self_copy_relationship",
    entityId: params.id,
    metadata: { simulated: result.simulated, liveExecution: false },
  });
  return result;
}

export const selfCopyGraphHasPath = hasPath;

export interface SelfCopyPositionEvent {
  sourceAccountId: string;
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  sourcePositionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  previousVolume?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

/**
 * Executes one real broker position event across every matching self-copy
 * relationship. A copied public-strategy position is just another real source
 * position, so it naturally continues through A -> B -> C chains.
 */
export async function executeSelfCopyPositionEvent(event: SelfCopyPositionEvent) {
  const supabase = createAdminClient();
  const adapter = createBrokerAdapter();
  const global = await getCopyGlobalSettings();
  const result = { attempted: 0, success: 0, failed: 0, skipped: 0 };

  if (!adapter.executionAvailable()) {
    throw new CopyError(COPY_ERROR.COPY_EXECUTION_NOT_CONFIGURED, "Live broker execution is disabled.", 503);
  }

  if (event.eventType !== "OPEN") {
    const { data: links } = await supabase
      .from("self_copy_trade_links")
      .select("id, follower_account_id, follower_position_id, copied_volume, status")
      .eq("source_account_id", event.sourceAccountId)
      .eq("source_position_id", event.sourcePositionId)
      .in("status", ["OPEN", "CLOSING"]);
    for (const link of links ?? []) {
      if (!link.follower_position_id) {
        result.skipped++;
        continue;
      }
      result.attempted++;
      try {
        if (event.eventType === "CLOSE") {
          await supabase.from("self_copy_trade_links").update({ status: "CLOSING" }).eq("id", link.id);
          await adapter.closeTrade({
            accountId: link.follower_account_id,
            brokerPositionId: link.follower_position_id,
            comment: "wsa:self-copy:close",
          });
          await supabase.from("self_copy_trade_links").update({
            status: "CLOSED",
            closed_at: new Date().toISOString(),
            error_code: null,
            error_message: null,
          }).eq("id", link.id);
        } else {
          const previous = Number(event.previousVolume ?? event.volume);
          if (previous > event.volume && previous > 0) {
            const partialVolume = Number(link.copied_volume) * ((previous - event.volume) / previous);
            if (partialVolume > 0) {
              await adapter.closeTrade({
                accountId: link.follower_account_id,
                brokerPositionId: link.follower_position_id,
                volume: partialVolume,
                comment: "wsa:self-copy:partial",
              });
              await supabase.from("self_copy_trade_links").update({
                copied_volume: Math.max(0, Number(link.copied_volume) - partialVolume),
              }).eq("id", link.id);
            }
          }
          await adapter.modifyTrade({
            accountId: link.follower_account_id,
            brokerPositionId: link.follower_position_id,
            stopLoss: event.stopLoss ?? null,
            takeProfit: event.takeProfit ?? null,
          });
        }
        result.success++;
      } catch (error) {
        const message = (error instanceof Error ? error.message : "Self-copy broker operation failed").slice(0, 400);
        await supabase.from("self_copy_trade_links").update({
          status: event.eventType === "CLOSE" ? "OPEN" : link.status,
          error_code: error instanceof BrokerExecutionError ? error.code : COPY_ERROR.COPY_PROVIDER_ERROR,
          error_message: message,
        }).eq("id", link.id);
        result.failed++;
      }
    }
    return result;
  }

  if (!global.copyEnabled || !global.liveCopyEnabled || global.emergencyStopEnabled) {
    return { ...result, skipped: 1 };
  }

  const { data: relationships, error } = await supabase
    .from("self_copy_relationships")
    .select("id, trader_id, source_account_id, follower_account_id, status, copy_settings")
    .eq("source_account_id", event.sourceAccountId)
    .eq("status", "LIVE");
  if (error) throw new Error(`Failed to load live self-copy relationships: ${error.message}`);

  const sourceSnapshot = await latestSnapshot(event.sourceAccountId);
  for (const relationship of relationships ?? []) {
    const settings = relationship.copy_settings as FollowerSettingsPatch;
    const followerSymbol = mapFollowerSymbol(event.symbol, settings.symbolMapping);
    const followerSide = reverseFollowerSide(event.side, settings.reverseCopy) === "SELL" ? "SELL" : "BUY";

    const { data: existing } = await supabase
      .from("self_copy_trade_links")
      .select("id, status")
      .eq("relationship_id", relationship.id)
      .eq("source_position_id", event.sourcePositionId)
      .maybeSingle();
    if (existing && existing.status !== "FAILED") {
      result.skipped++;
      continue;
    }

    const [{ data: followerAccount }, riskState, followerSnapshot, openLinks] = await Promise.all([
      supabase.from("trading_accounts").select("status").eq("id", relationship.follower_account_id).maybeSingle(),
      getRiskEnforcementState(relationship.follower_account_id),
      latestSnapshot(relationship.follower_account_id),
      supabase.from("self_copy_trade_links").select("id", { count: "exact", head: true })
        .eq("follower_account_id", relationship.follower_account_id).eq("status", "OPEN"),
    ]);
    const symbolAllowed = !settings.allowedSymbols?.length || settings.allowedSymbols.includes(followerSymbol);
    const symbolBlocked = settings.blockedSymbols?.includes(followerSymbol) ?? false;
    const maxOpenReached = settings.maxOpenTrades !== null
      && (openLinks.count ?? 0) >= settings.maxOpenTrades;
    if (
      !settings.copyEnabled
      || settings.emergencyStop
      || followerAccount?.status !== "CONNECTED"
      || riskState?.blockedNewTrades
      || !symbolAllowed
      || symbolBlocked
      || maxOpenReached
    ) {
      result.skipped++;
      continue;
    }

    const scalingMode = copyModeToScalingMode(settings.copyMode);
    if (!scalingMode) {
      result.skipped++;
      continue;
    }
    const lot = calculateFollowerLot({
      masterLot: event.volume,
      masterBalance: sourceSnapshot?.balance ?? null,
      masterEquity: sourceSnapshot?.equity ?? null,
      followerBalance: followerSnapshot?.balance ?? null,
      followerEquity: followerSnapshot?.equity ?? null,
      scalingMode,
      fixedLot: settings.fixedLot,
      riskMultiplier: settings.lotMultiplier,
      minLot: settings.minLot,
      maxLot: settings.maxLot,
    });
    if (lot.lot <= 0) {
      result.skipped++;
      continue;
    }

    result.attempted++;
    let linkId = existing?.id as string | undefined;
    try {
      if (linkId) {
        await supabase.from("self_copy_trade_links").update({
          status: "PENDING", error_code: null, error_message: null,
        }).eq("id", linkId);
      } else {
        const { data: reserved, error: reserveError } = await supabase
          .from("self_copy_trade_links")
          .insert({
            relationship_id: relationship.id,
            trader_id: relationship.trader_id,
            source_account_id: relationship.source_account_id,
            follower_account_id: relationship.follower_account_id,
            source_position_id: event.sourcePositionId,
            symbol: followerSymbol,
            side: followerSide,
            copied_volume: lot.lot,
            status: "PENDING",
          })
          .select("id")
          .single();
        if (reserveError || !reserved) throw new Error(`Self-copy reservation failed: ${reserveError?.message}`);
        linkId = reserved.id;
      }
      const opened = await adapter.openTrade({
        accountId: relationship.follower_account_id,
        symbol: followerSymbol,
        side: followerSide,
        volume: lot.lot,
        stopLoss: event.stopLoss ?? null,
        takeProfit: event.takeProfit ?? null,
        comment: `wsa:self:${relationship.id.slice(0, 8)}`,
      });
      await supabase.from("self_copy_trade_links").update({
        status: "OPEN",
        follower_position_id: opened.brokerPositionId ?? opened.brokerOrderId ?? null,
        follower_order_id: opened.brokerOrderId ?? null,
        copied_volume: opened.executedVolume ?? lot.lot,
        opened_at: new Date().toISOString(),
        error_code: null,
        error_message: null,
      }).eq("id", linkId);
      result.success++;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Self-copy broker execution failed").slice(0, 400);
      if (linkId) {
        await supabase.from("self_copy_trade_links").update({
          status: "FAILED",
          error_code: error instanceof BrokerExecutionError ? error.code : COPY_ERROR.COPY_PROVIDER_ERROR,
          error_message: message,
        }).eq("id", linkId);
      }
      result.failed++;
    }
  }
  return result;
}
