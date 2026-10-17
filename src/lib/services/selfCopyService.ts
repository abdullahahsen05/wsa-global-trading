import type { BrokerAdapter } from "@/lib/broker/BrokerAdapter";
import { createBrokerAdapter } from "@/lib/broker/provider";
import { readCalibration, type CopyCalibration } from "@/lib/copy/calibration";
import { isMissingSchema } from "@/lib/copy/activityLog";
import { copyModeToScalingMode } from "@/lib/copy/settings";
import { COPY_ERROR, CopyError } from "@/lib/copy/types";
import {
  closeVanishedPositions,
  planSelfCopyOpen,
  runSelfCopyEvent,
  type SelfCopyPositionEvent,
  type SelfCopyRoute,
  type SelfCopySummary,
} from "@/lib/copy/selfCopyEngine";
import type { SelfCopyCheck } from "@/lib/copy/selfCopyDecision";
import { judgeEngine, type EngineState } from "@/lib/copy/selfCopyEngineStatus";
import {
  createSupabaseSelfCopyStore,
  forgetSelfCopyFacts,
  listSelfCopyActivity,
  loadSelfCopyPlatform,
  routeFromRow,
  type SelfCopyActivityResult,
} from "@/lib/copy/selfCopyStore";
import { gatewayAvailability } from "@/lib/gateway/gatewayQueue";
import type { FollowerSettingsPatch } from "@/lib/services/copyTradingService";
import { writeAuditLog } from "@/lib/services/auditService";
import { createAdminClient } from "@/lib/supabase/admin";

export type { SelfCopyPositionEvent } from "@/lib/copy/selfCopyEngine";

export type SelfCopyStatus = "LIVE" | "PAUSED" | "ARCHIVED";

/** The route form's settings: the follower settings plus the calibration of a copied trade. */
export type SelfCopySettingsInput = FollowerSettingsPatch & { calibration?: Partial<CopyCalibration> };

export interface SelfCopyEngineDto {
  state: EngineState;
  /** the copy worker is connected to the source account right now */
  listening: boolean;
  error: string | null;
  heartbeatAt: string | null;
}

export interface SelfCopyLastActivityDto {
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  outcome: "COPIED" | "SKIPPED" | "FAILED";
  code: string;
  message: string;
  symbol: string | null;
  createdAt: string;
}

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
  copySettings: SelfCopySettingsInput & { calibration: CopyCalibration };
  /** null = the engine columns of migration 061 are not in the database */
  engine: SelfCopyEngineDto | null;
  /** null = nothing recorded yet, or the activity table of migration 061 is missing */
  lastActivity: SelfCopyLastActivityDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface SelfCopyPlatformDto {
  copyEnabled: boolean;
  liveCopyEnabled: boolean;
  emergencyStop: boolean;
  /** the AWS worker's heartbeat (trade gateway, migration 060); "unknown" = not installed */
  worker: "online" | "offline" | "unknown";
  /** the worker may place broker orders (null = not known) */
  workerOrdersAllowed: boolean | null;
}

interface RelationshipRow {
  id: string;
  trader_id: string;
  source_account_id: string;
  follower_account_id: string;
  status: SelfCopyStatus;
  copy_settings: SelfCopySettingsInput | null;
  created_at: string;
  updated_at: string;
  engine_status?: string | null;
  engine_error?: string | null;
  engine_heartbeat_at?: string | null;
}

const ELIGIBLE_ACCOUNT_STATUSES = new Set(["CONNECTED", "SYNCING"]);

const BASE_COLUMNS =
  "id, trader_id, source_account_id, follower_account_id, status, copy_settings, created_at, updated_at";
const ENGINE_COLUMNS = `${BASE_COLUMNS}, engine_status, engine_error, engine_heartbeat_at`;
/** After the engine columns turned out to be missing (migration 061 not applied) they are not asked for again for a while. */
let engineColumnsMissingUntil = 0;

async function ownedAccountMap(traderId: string, accountIds?: string[]) {
  const supabase = createAdminClient();
  let query = supabase
    .from("trading_accounts")
    .select("id, account_name, status, account_usage")
    .eq("user_id", traderId);
  if (accountIds?.length) query = query.in("id", accountIds);
  const { data, error } = await query;
  if (error)
    throw new Error(`Failed to load trader accounts: ${error.message}`);
  return new Map((data ?? []).map((account) => [account.id, account]));
}

function hasPath(
  edges: Array<{ source: string; follower: string }>,
  start: string,
  target: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      edge.follower,
    ]);
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

function validateSupportedSettings(settings: SelfCopySettingsInput): void {
  if (!copyModeToScalingMode(settings.copyMode)) {
    throw new CopyError(
      COPY_ERROR.VALIDATION_ERROR,
      "Selected copy mode is not supported.",
      400,
    );
  }
}

/** What goes into `copy_settings`: the form's values, with the calibration completed and bounded. */
function storableSettings(settings: SelfCopySettingsInput): Record<string, unknown> {
  const { calibration, ...rest } = settings;
  return calibration === undefined ? { ...rest } : { ...rest, calibration: readCalibration(calibration) };
}

/** The route rows of a person (never archived), with the engine columns when the database has them. */
async function loadRouteRows(traderId: string): Promise<{ rows: RelationshipRow[]; engineColumns: boolean }> {
  const supabase = createAdminClient();
  const select = async (columns: string) =>
    supabase
      .from("self_copy_relationships")
      .select(columns)
      .eq("trader_id", traderId)
      .neq("status", "ARCHIVED")
      .order("created_at", { ascending: false });

  if (Date.now() >= engineColumnsMissingUntil) {
    const withEngine = await select(ENGINE_COLUMNS);
    if (!withEngine.error) return { rows: (withEngine.data ?? []) as unknown as RelationshipRow[], engineColumns: true };
    if (!isMissingSchema(withEngine.error)) {
      throw new Error(`Failed to load self-copy setups: ${withEngine.error.message}`);
    }
    engineColumnsMissingUntil = Date.now() + 10 * 60_000;
  }
  const plain = await select(BASE_COLUMNS);
  if (plain.error) throw new Error(`Failed to load self-copy setups: ${plain.error.message}`);
  return { rows: (plain.data ?? []) as unknown as RelationshipRow[], engineColumns: false };
}

/** The latest activity line of every route of a person. Empty when the activity table is not there. */
async function latestActivityByRoute(traderId: string): Promise<Map<string, SelfCopyLastActivityDto>> {
  const latest = new Map<string, SelfCopyLastActivityDto>();
  try {
    const { data, error } = await createAdminClient()
      .from("self_copy_events")
      .select("relationship_id, event_type, outcome, code, message, symbol, created_at")
      .eq("trader_id", traderId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return latest;
    for (const row of data ?? []) {
      const routeId = String(row.relationship_id);
      if (latest.has(routeId)) continue;
      latest.set(routeId, {
        eventType: row.event_type as SelfCopyLastActivityDto["eventType"],
        outcome: row.outcome as SelfCopyLastActivityDto["outcome"],
        code: String(row.code),
        message: String(row.message ?? ""),
        symbol: row.symbol ?? null,
        createdAt: String(row.created_at),
      });
    }
  } catch {
    // the activity is a convenience, never a reason for the list to fail
  }
  return latest;
}

export async function listSelfCopyRelationships(
  traderId: string,
): Promise<SelfCopyRelationshipDto[]> {
  const { rows, engineColumns } = await loadRouteRows(traderId);
  const [accounts, activity] = await Promise.all([
    ownedAccountMap(traderId, [
      ...new Set(rows.flatMap((row) => [row.source_account_id, row.follower_account_id])),
    ]),
    rows.length > 0 ? latestActivityByRoute(traderId) : Promise.resolve(new Map<string, SelfCopyLastActivityDto>()),
  ]);
  const now = Date.now();
  return rows.map((row) => {
    const source = accounts.get(row.source_account_id);
    const follower = accounts.get(row.follower_account_id);
    const stored = (row.copy_settings ?? {}) as SelfCopySettingsInput;
    let engine: SelfCopyEngineDto | null = null;
    if (engineColumns) {
      const verdict = judgeEngine(
        { status: row.engine_status ?? null, error: row.engine_error ?? null, heartbeatAt: row.engine_heartbeat_at ?? null },
        now,
      );
      engine = {
        state: verdict.state,
        listening: verdict.listening,
        error: row.engine_error ?? null,
        heartbeatAt: row.engine_heartbeat_at ?? null,
      };
    }
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
      copySettings: { ...stored, calibration: readCalibration(stored.calibration) },
      engine,
      lastActivity: activity.get(row.id) ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

/** What the platform and the AWS worker allow right now - the banner above the routes. */
export async function getSelfCopyPlatformStatus(): Promise<SelfCopyPlatformDto> {
  const [platform, gateway] = await Promise.all([
    loadSelfCopyPlatform(),
    gatewayAvailability(createAdminClient()).catch(() => null),
  ]);
  return {
    copyEnabled: platform.copyEnabled,
    liveCopyEnabled: platform.liveCopyEnabled,
    emergencyStop: platform.emergencyStop,
    worker: gateway?.state === "online" ? "online" : gateway?.state === "offline" ? "offline" : "unknown",
    workerOrdersAllowed: gateway?.state === "online" ? gateway.executionEnabled : null,
  };
}

export async function createSelfCopyRelationship(params: {
  traderId: string;
  sourceAccountId: string;
  followerAccountId: string;
  copySettings: SelfCopySettingsInput;
}): Promise<SelfCopyRelationshipDto> {
  if (params.sourceAccountId === params.followerAccountId) {
    throw new CopyError(
      COPY_ERROR.VALIDATION_ERROR,
      "Source and follower accounts must be different.",
      400,
    );
  }
  validateSupportedSettings(params.copySettings);
  const accounts = await ownedAccountMap(params.traderId, [
    params.sourceAccountId,
    params.followerAccountId,
  ]);
  if (accounts.size !== 2) {
    throw new CopyError(
      COPY_ERROR.FORBIDDEN,
      "Both accounts must belong to you.",
      403,
    );
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
  if (
    edges.some(
      (edge) =>
        edge.source === params.sourceAccountId &&
        edge.follower === params.followerAccountId,
    )
  ) {
    throw new CopyError(
      COPY_ERROR.VALIDATION_ERROR,
      "This self-copy pair already exists.",
      409,
    );
  }
  if (hasPath(edges, params.followerAccountId, params.sourceAccountId)) {
    throw new CopyError(
      COPY_ERROR.VALIDATION_ERROR,
      "This setup would create a circular copy chain.",
      409,
    );
  }

  const { data, error } = await supabase
    .from("self_copy_relationships")
    .insert({
      trader_id: params.traderId,
      source_account_id: params.sourceAccountId,
      follower_account_id: params.followerAccountId,
      status: "LIVE",
      // "live since" is the route's, never the person's: only trades opened after it are new trades for the route
      copy_settings: { ...storableSettings(params.copySettings), liveSince: new Date().toISOString() },
    })
    .select("id")
    .single();
  if (error || !data) {
    if (error?.code === "23505")
      throw new CopyError(
        COPY_ERROR.VALIDATION_ERROR,
        "This self-copy pair already exists.",
        409,
      );
    throw new Error(`Failed to create self-copy setup: ${error?.message}`);
  }
  forgetSelfCopyFacts();
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
  copySettings?: SelfCopySettingsInput;
}): Promise<void> {
  if (params.copySettings) validateSupportedSettings(params.copySettings);
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("self_copy_relationships")
    .select("id, status, copy_settings")
    .eq("id", params.id)
    .eq("trader_id", params.traderId)
    .maybeSingle();
  if (!data)
    throw new CopyError(
      COPY_ERROR.FORBIDDEN,
      "Self-copy setup not found or not yours.",
      404,
    );
  const patch: Record<string, unknown> = {};
  if (params.status !== undefined) patch.status = params.status;
  // a route that starts copying again copies the trades that open from now on - not those opened while it was paused
  const resuming = params.status === "LIVE" && data.status !== "LIVE";
  if (params.copySettings !== undefined || resuming) {
    const existing = (data.copy_settings ?? {}) as Record<string, unknown>;
    patch.copy_settings = {
      ...existing,
      ...(params.copySettings
        ? {
            ...storableSettings(params.copySettings),
            fixedLot:
              params.copySettings.copyMode === "FIXED_LOT"
                ? params.copySettings.fixedLot
                : null,
            lotMultiplier:
              params.copySettings.copyMode === "LOT_MULTIPLIER"
                ? params.copySettings.lotMultiplier
                : null,
            riskPercent:
              params.copySettings.copyMode === "RISK_PERCENT"
                ? params.copySettings.riskPercent
                : null,
          }
        : {}),
      // whatever the form sent, the start of the route is only ever set here
      liveSince: resuming ? new Date().toISOString() : (existing.liveSince ?? null),
    };
  }
  const { error } = await supabase
    .from("self_copy_relationships")
    .update(patch)
    .eq("id", params.id);
  if (error)
    throw new Error(`Failed to update self-copy setup: ${error.message}`);
  forgetSelfCopyFacts();
  await writeAuditLog({
    actorUserId: params.traderId,
    action: "SELF_COPY_UPDATED",
    entityType: "self_copy_relationship",
    entityId: params.id,
    metadata: {
      status: params.status,
      settingsUpdated: Boolean(params.copySettings),
    },
  });
}

// ── "Check route": what would happen to a trade like the source's latest ─────

export interface SelfCopyCheckDto {
  /** a trade like the sample would be copied right now */
  wouldCopy: boolean;
  code: string;
  message: string;
  checks: SelfCopyCheck[];
  sample: {
    symbol: string;
    side: "BUY" | "SELL";
    volume: number;
    entryPrice: number | null;
    origin: "open-position" | "last-trade" | "example";
  };
  /** what the order would look like; null when the cheap checks already said no */
  plan: {
    followerSymbol: string;
    followerSide: "BUY" | "SELL";
    lot: number;
    stopLoss: number | null;
    takeProfit: number | null;
    symbolMatchedBy: "mapping" | "same-name" | "auto" | "as-is";
    notes: string[];
  } | null;
  checkedAt: string;
}

async function sampleTrade(sourceAccountId: string): Promise<SelfCopyCheckDto["sample"]> {
  const supabase = createAdminClient();
  const select = "symbol, side, volume, open_price";
  const open = await supabase
    .from("trades")
    .select(select)
    .eq("trading_account_id", sourceAccountId)
    .eq("status", "OPEN")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = open.data
    ? null
    : await supabase
        .from("trades")
        .select(select)
        .eq("trading_account_id", sourceAccountId)
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle();
  const row = open.data ?? last?.data ?? null;
  if (!row) return { symbol: "EURUSD", side: "BUY", volume: 1, entryPrice: 1.1, origin: "example" };
  return {
    symbol: String(row.symbol),
    side: row.side === "SELL" ? "SELL" : "BUY",
    volume: Number(row.volume),
    entryPrice: row.open_price == null ? null : Number(row.open_price),
    origin: open.data ? "open-position" : "last-trade",
  };
}

/**
 * Runs the real decision of the copy engine for a trade like the source's latest one - nothing is
 * reserved, nothing is sent. It answers "why does my route do nothing" without waiting for a trade.
 */
export async function checkSelfCopyRoute(params: {
  traderId: string;
  id: string;
  adapter?: BrokerAdapter;
}): Promise<SelfCopyCheckDto> {
  const supabase = createAdminClient();
  const selectRoute = async (columns: string) =>
    supabase
      .from("self_copy_relationships")
      .select(columns)
      .eq("id", params.id)
      .eq("trader_id", params.traderId)
      .maybeSingle();
  let loaded = Date.now() >= engineColumnsMissingUntil ? await selectRoute(ENGINE_COLUMNS) : null;
  if (loaded?.error && isMissingSchema(loaded.error)) {
    engineColumnsMissingUntil = Date.now() + 10 * 60_000;
    loaded = null;
  }
  loaded ??= await selectRoute(BASE_COLUMNS);
  const row = loaded.data as unknown as RelationshipRow | null;
  if (!row)
    throw new CopyError(
      COPY_ERROR.FORBIDDEN,
      "Self-copy setup not found or not yours.",
      404,
    );

  const route: SelfCopyRoute = routeFromRow({
    id: row.id,
    trader_id: row.trader_id,
    source_account_id: row.source_account_id,
    follower_account_id: row.follower_account_id,
    status: row.status,
    copy_settings: row.copy_settings,
    created_at: row.created_at,
  });

  // fresh figures for the check, not the five-second-old ones of the last trade
  forgetSelfCopyFacts();
  const [sample, platform, gateway] = await Promise.all([
    sampleTrade(row.source_account_id),
    loadSelfCopyPlatform(),
    gatewayAvailability(supabase).catch(() => null),
  ]);

  const scalingMode = copyModeToScalingMode(route.settings.copyMode);
  const notes: string[] = [];
  // a risk-percent lot comes from each trade's own stop loss; the sample has none to show
  let stopLoss: number | null = null;
  if (scalingMode === "RISK_PERCENT" && sample.entryPrice) {
    stopLoss = sample.entryPrice * (sample.side === "BUY" ? 0.995 : 1.005);
    notes.push("A risk-percent route sizes each trade from its stop loss. This check assumes a stop loss 0.5 % from the entry.");
  }
  const event: SelfCopyPositionEvent = {
    sourceAccountId: row.source_account_id,
    eventType: "OPEN",
    sourcePositionId: "check",
    symbol: sample.symbol,
    side: sample.side,
    volume: sample.volume,
    entryPrice: sample.entryPrice,
    stopLoss,
    takeProfit: null,
    existing: false,
  };

  const adapter = params.adapter ?? createBrokerAdapter();
  const plan = await planSelfCopyOpen(
    { adapter, store: createSupabaseSelfCopyStore() },
    {
      platform,
      // the order would be sent by the AWS worker, not by this web server
      executionAvailable: gateway?.state === "online" ? gateway.executionEnabled : true,
    },
    route,
    event,
  );

  const engine = judgeEngine(
    row.engine_status !== undefined || row.engine_heartbeat_at !== undefined
      ? { status: row.engine_status ?? null, error: row.engine_error ?? null, heartbeatAt: row.engine_heartbeat_at ?? null }
      : null,
  );
  const checks: SelfCopyCheck[] = [engine.check, ...plan.verdict.checks];
  if (gateway?.state === "offline") {
    checks.push({
      id: "WORKER_ONLINE",
      label: "AWS copy system online",
      status: "warn",
      detail: "No copy worker has reported to the trade gateway in the last seconds. If it is running, it will show up here shortly.",
    });
  }
  if (plan.complete && !plan.resolution.listKnown && route.settings.calibration.autoSymbolMatch) {
    notes.push("The follower's symbol list could not be read from this server; the worker checks the exact spelling when a trade arrives.");
  }
  if (plan.complete) notes.push(...plan.levels.notes);

  return {
    wouldCopy: plan.verdict.allowed,
    code: plan.verdict.code,
    message: plan.verdict.message,
    checks,
    sample,
    plan: plan.complete
      ? {
          followerSymbol: plan.followerSymbol,
          followerSide: plan.followerSide,
          lot: plan.lot.lot,
          stopLoss: plan.levels.stopLoss,
          takeProfit: plan.levels.takeProfit,
          symbolMatchedBy: plan.resolution.matchedBy,
          notes,
        }
      : null,
    checkedAt: new Date().toISOString(),
  };
}

/** The latest activity of one route; the route must belong to the person. */
export async function getSelfCopyActivity(params: {
  traderId: string;
  id: string;
  limit?: number;
}): Promise<SelfCopyActivityResult> {
  const { data } = await createAdminClient()
    .from("self_copy_relationships")
    .select("id")
    .eq("id", params.id)
    .eq("trader_id", params.traderId)
    .maybeSingle();
  if (!data)
    throw new CopyError(
      COPY_ERROR.FORBIDDEN,
      "Self-copy setup not found or not yours.",
      404,
    );
  return listSelfCopyActivity(params.id, params.limit ?? 40);
}

export const selfCopyGraphHasPath = hasPath;

let sharedStore: ReturnType<typeof createSupabaseSelfCopyStore> | null = null;

/**
 * After the copy worker was away: closes the copies whose source position is gone (run by the AWS
 * copy worker). The live positions come from a function so that they are read AFTER the open copies
 * were looked up - see `closeVanishedPositions`.
 */
export async function closeVanishedSelfCopyPositions(
  sourceAccountId: string,
  readLivePositionIds: () => Promise<ReadonlySet<string>>,
  options: { adapter?: BrokerAdapter; log?: (line: string) => void } = {},
): Promise<SelfCopySummary> {
  sharedStore ??= createSupabaseSelfCopyStore();
  return closeVanishedPositions(
    {
      adapter: options.adapter ?? createBrokerAdapter(),
      store: sharedStore,
      ...(options.log ? { log: options.log } : {}),
    },
    sourceAccountId,
    readLivePositionIds,
  );
}

/**
 * Copies one real broker position event across the self-copy routes of its source account (run by the
 * AWS copy worker). A copied public-strategy position is just another real source position, so it
 * naturally continues through A -> B -> C chains.
 */
export async function executeSelfCopyPositionEvent(
  event: SelfCopyPositionEvent,
  options: { routes?: SelfCopyRoute[]; adapter?: BrokerAdapter; log?: (line: string) => void } = {},
): Promise<SelfCopySummary> {
  sharedStore ??= createSupabaseSelfCopyStore();
  const adapter = options.adapter ?? createBrokerAdapter();
  return runSelfCopyEvent(
    { adapter, store: sharedStore, ...(options.log ? { log: options.log } : {}) },
    event,
    options.routes ? { routes: options.routes } : {},
  );
}
