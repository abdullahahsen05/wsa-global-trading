/**
 * The self-copy engine's database: routes, copy links, the facts of a follower and the activity log.
 * Shared with the AWS workers (no Next / React / `server-only`); the service-role client is used, so
 * every function takes the owner (or the route) it works for and nothing here is exposed to a browser.
 *
 * Optional schema (migration 061): `self_copy_events` and the `engine_*` columns of
 * `self_copy_relationships`. Everything works without them - the activity then only reaches the
 * worker's log - and a missing table / column is remembered for ten minutes instead of asked again.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { getCopyGlobalSettings } from "@/lib/services/copyTradingService";
import { getRiskEnforcementState } from "@/lib/services/riskService";
import { ActivityLog, isMissingSchema, type ActivityDbError } from "@/lib/copy/activityLog";
import { readSelfCopySettings } from "@/lib/copy/selfCopyDecision";
import type { SelfCopyRouteEntry } from "@/lib/copy/selfCopySources";
import type {
  SelfCopyActivity,
  SelfCopyFollowerFacts,
  SelfCopyLink,
  SelfCopyLinkPatch,
  SelfCopyLinkStatus,
  SelfCopyPlatform,
  SelfCopyRoute,
  SelfCopyRouteStatus,
  SelfCopyStore,
} from "@/lib/copy/selfCopyEngine";

// ── a small time-limited cache ───────────────────────────────────────────────

interface CacheEntry<T> {
  value: Promise<T>;
  expiresAt: number;
}

const caches = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX_ENTRIES = 2_000;

/** The same question asked twice within `ttlMs` (or while it is still being answered) is answered once. */
function remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = caches.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;
  if (caches.size >= CACHE_MAX_ENTRIES) {
    for (const [cachedKey, entry] of caches) if (entry.expiresAt <= now) caches.delete(cachedKey);
    if (caches.size >= CACHE_MAX_ENTRIES) caches.clear();
  }
  const value = load();
  caches.set(key, { value, expiresAt: now + ttlMs });
  value.catch(() => {
    if (caches.get(key)?.value === value) caches.delete(key);
  });
  return value;
}

/** For tests and for the moment a person changes something the facts depend on. */
export function forgetSelfCopyFacts(): void {
  caches.clear();
}

const PLATFORM_TTL_MS = 3_000;
const STATUS_TTL_MS = 5_000;
const RISK_TTL_MS = 5_000;
const SNAPSHOT_TTL_MS = 10_000;
const DAILY_LOSS_TTL_MS = 30_000;
/** A reserved copy that has not become OPEN within this time is a leftover, not a trade in flight. */
const PENDING_LINK_WINDOW_MS = 2 * 60_000;
/** A copy that has been "closing" this long lost its close (the process died): it may be closed again. */
const STALE_CLOSING_MS = 60_000;
const LINK_WRITE_RETRY_MS: readonly number[] = [100, 400, 1_200];

const LINK_COLUMNS =
  "id, relationship_id, trader_id, source_account_id, follower_account_id, source_position_id, follower_position_id, symbol, side, copied_volume, status, error_code";
const ROUTE_COLUMNS = "id, trader_id, source_account_id, follower_account_id, status, copy_settings, created_at";

interface LinkRow {
  id: string;
  relationship_id: string;
  trader_id: string;
  source_account_id: string;
  follower_account_id: string;
  source_position_id: string;
  follower_position_id: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  copied_volume: number | string | null;
  status: SelfCopyLinkStatus;
  error_code: string | null;
}

interface RouteRow {
  id: string;
  trader_id: string;
  source_account_id: string;
  follower_account_id: string;
  status: SelfCopyRouteStatus;
  copy_settings: unknown;
  created_at: string;
}

export function linkFromRow(row: LinkRow): SelfCopyLink {
  return {
    id: row.id,
    routeId: row.relationship_id,
    traderId: row.trader_id,
    sourceAccountId: row.source_account_id,
    followerAccountId: row.follower_account_id,
    sourcePositionId: row.source_position_id,
    followerPositionId: row.follower_position_id,
    symbol: row.symbol,
    side: row.side,
    copiedVolume: Number(row.copied_volume ?? 0),
    status: row.status,
    errorCode: row.error_code,
  };
}

export function routeFromRow(row: RouteRow): SelfCopyRoute {
  return {
    id: row.id,
    traderId: row.trader_id,
    sourceAccountId: row.source_account_id,
    followerAccountId: row.follower_account_id,
    status: row.status,
    settings: readSelfCopySettings(row.copy_settings),
    createdAt: row.created_at,
  };
}

function linkPatchColumns(patch: SelfCopyLinkPatch): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.symbol !== undefined) columns.symbol = patch.symbol;
  if (patch.side !== undefined) columns.side = patch.side;
  if (patch.followerPositionId !== undefined) columns.follower_position_id = patch.followerPositionId;
  if (patch.followerOrderId !== undefined) columns.follower_order_id = patch.followerOrderId;
  if (patch.copiedVolume !== undefined) columns.copied_volume = patch.copiedVolume;
  if (patch.openedAt !== undefined) columns.opened_at = patch.openedAt;
  if (patch.closedAt !== undefined) columns.closed_at = patch.closedAt;
  if (patch.errorCode !== undefined) columns.error_code = patch.errorCode;
  if (patch.errorMessage !== undefined) columns.error_message = patch.errorMessage;
  return columns;
}

// ── the activity log (migration 061) ─────────────────────────────────────────

function activityRow(activity: SelfCopyActivity): Record<string, unknown> {
  return {
    relationship_id: activity.routeId,
    trader_id: activity.traderId,
    source_account_id: activity.sourceAccountId,
    follower_account_id: activity.followerAccountId,
    event_type: activity.eventType,
    source_position_id: activity.sourcePositionId,
    outcome: activity.outcome,
    code: activity.code,
    message: activity.message.slice(0, 500),
    symbol: activity.symbol,
    follower_symbol: activity.followerSymbol,
    side: activity.side,
    source_volume: activity.sourceVolume,
    copied_volume: activity.copiedVolume,
    latency_ms: activity.latencyMs === null ? null : Math.round(activity.latencyMs),
    timings: activity.timings,
  };
}

let activityLog: ActivityLog<Record<string, unknown>> | null = null;

function getActivityLog(): ActivityLog<Record<string, unknown>> {
  activityLog ??= new ActivityLog<Record<string, unknown>>({
    insert: async (rows) => {
      const { error } = await createAdminClient().from("self_copy_events").insert(rows);
      return { error: error as ActivityDbError | null };
    },
    onProblem: (message) => console.warn(`[self-copy] ${message}`),
  });
  return activityLog;
}

/** Writes what is waiting (the worker calls this when it stops). */
export function flushSelfCopyActivity(): Promise<void> {
  return activityLog ? activityLog.flush() : Promise.resolve();
}

// ── the store ────────────────────────────────────────────────────────────────

function staleClosingFilter(): string {
  const cutoff = new Date(Date.now() - STALE_CLOSING_MS).toISOString();
  return `status.eq.OPEN,and(status.eq.CLOSING,updated_at.lt.${cutoff})`;
}

async function loadPlatform(): Promise<SelfCopyPlatform> {
  const settings = await getCopyGlobalSettings();
  return {
    copyEnabled: settings.copyEnabled,
    liveCopyEnabled: settings.liveCopyEnabled,
    emergencyStop: settings.emergencyStopEnabled,
    maxLotSize: settings.maxLotSize,
    maxCopiedOpenPositions: settings.maxCopiedOpenPositions,
    maxDailyLossPercent: settings.maxDailyLossPercent,
    maxDrawdownPercent: settings.maxDrawdownPercent,
    maxSlippagePoints: settings.maxSlippagePoints,
  };
}

export function loadSelfCopyPlatform(): Promise<SelfCopyPlatform> {
  return remember("platform", PLATFORM_TTL_MS, loadPlatform);
}

export async function loadSelfCopyFollowerFacts(route: SelfCopyRoute): Promise<SelfCopyFollowerFacts> {
  const supabase = createAdminClient();
  const sourceId = route.sourceAccountId;
  const followerId = route.followerAccountId;
  const platform = await loadSelfCopyPlatform();
  const needsDailyLoss = route.settings.maxDailyLossPercent !== null || platform.maxDailyLossPercent !== null;
  const pendingSince = new Date(Date.now() - PENDING_LINK_WINDOW_MS).toISOString();

  const [statuses, risk, snapshots, openLinks, pendingLinks, dailyLoss] = await Promise.all([
    remember(`status:${sourceId}:${followerId}`, STATUS_TTL_MS, async () => {
      const { data } = await supabase.from("trading_accounts").select("id, status").in("id", [sourceId, followerId]);
      return new Map((data ?? []).map((row) => [row.id as string, row.status as string]));
    }),
    remember(`risk:${followerId}`, RISK_TTL_MS, () => getRiskEnforcementState(followerId).catch(() => null)),
    remember(`snapshot:${sourceId}:${followerId}`, SNAPSHOT_TTL_MS, async () => {
      const { data } = await supabase
        .from("latest_account_snapshots")
        .select("trading_account_id, equity, balance, drawdown_percent")
        .in("trading_account_id", [sourceId, followerId]);
      return new Map(
        (data ?? []).map((row) => [
          row.trading_account_id as string,
          {
            equity: Number(row.equity),
            balance: Number(row.balance),
            drawdownPercent: row.drawdown_percent == null ? null : Number(row.drawdown_percent),
          },
        ]),
      );
    }),
    supabase
      .from("self_copy_trade_links")
      .select("id", { count: "exact", head: true })
      .eq("follower_account_id", followerId)
      .in("status", ["OPEN", "CLOSING"]),
    supabase
      .from("self_copy_trade_links")
      .select("id", { count: "exact", head: true })
      .eq("follower_account_id", followerId)
      .eq("status", "PENDING")
      .gte("created_at", pendingSince),
    needsDailyLoss
      ? remember(`daily:${followerId}`, DAILY_LOSS_TTL_MS, async () => {
          const startOfDay = new Date();
          startOfDay.setUTCHours(0, 0, 0, 0);
          const { data } = await supabase
            .from("trades")
            .select("profit")
            .eq("trading_account_id", followerId)
            .eq("status", "CLOSED")
            .gte("closed_at", startOfDay.toISOString())
            .limit(1000);
          return Math.abs((data ?? []).reduce((sum, trade) => sum + Math.min(0, Number(trade.profit)), 0));
        })
      : Promise.resolve(null),
  ]);

  const sourceSnapshot = snapshots.get(sourceId) ?? null;
  const followerSnapshot = snapshots.get(followerId) ?? null;
  return {
    sourceStatus: statuses.get(sourceId) ?? null,
    followerStatus: statuses.get(followerId) ?? null,
    riskBlocked: risk?.blockedNewTrades === true,
    riskMessage:
      risk?.blockedNewTrades === true
        ? risk.breachedRules.length > 0
          ? `A general risk rule blocks new trades on the follower: ${risk.breachedRules
              .map((rule) => (rule as { name?: string }).name ?? "unnamed rule")
              .join(", ")}.`
          : "The platform's general risk controls block new trades on the follower."
        : null,
    openCopies: (openLinks.count ?? 0) + (pendingLinks.count ?? 0),
    sourceBalance: sourceSnapshot?.balance ?? null,
    sourceEquity: sourceSnapshot?.equity ?? null,
    followerBalance: followerSnapshot?.balance ?? null,
    followerEquity: followerSnapshot?.equity ?? null,
    dailyLossPercent:
      dailyLoss !== null && followerSnapshot && followerSnapshot.balance > 0
        ? (dailyLoss / followerSnapshot.balance) * 100
        : null,
    drawdownPercent: followerSnapshot?.drawdownPercent ?? null,
  };
}

export function createSupabaseSelfCopyStore(): SelfCopyStore {
  const supabase = () => createAdminClient();
  return {
    platform: loadSelfCopyPlatform,

    async routesForSource(sourceAccountId) {
      const { data, error } = await supabase()
        .from("self_copy_relationships")
        .select(ROUTE_COLUMNS)
        .eq("source_account_id", sourceAccountId)
        .in("status", ["LIVE", "PAUSED"]);
      if (error) throw new Error(`Self-copy routes could not be loaded: ${error.message}`);
      return ((data ?? []) as RouteRow[]).map(routeFromRow);
    },

    followerFacts: loadSelfCopyFollowerFacts,

    async findLink(routeId, sourcePositionId) {
      const { data, error } = await supabase()
        .from("self_copy_trade_links")
        .select(LINK_COLUMNS)
        .eq("relationship_id", routeId)
        .eq("source_position_id", sourcePositionId)
        .maybeSingle();
      if (error) throw new Error(`The copy link could not be read: ${error.message}`);
      return data ? linkFromRow(data as LinkRow) : null;
    },

    async reserveLink(input) {
      const { data, error } = await supabase()
        .from("self_copy_trade_links")
        .insert({
          relationship_id: input.routeId,
          trader_id: input.traderId,
          source_account_id: input.sourceAccountId,
          follower_account_id: input.followerAccountId,
          source_position_id: input.sourcePositionId,
          symbol: input.symbol,
          side: input.side,
          copied_volume: input.volume,
          status: "PENDING",
        })
        .select(LINK_COLUMNS)
        .single();
      if (error?.code === "23505") return { duplicate: true as const };
      if (error || !data) throw new Error(`The copy could not be reserved: ${error?.message ?? "no row returned"}`);
      return { link: linkFromRow(data as LinkRow) };
    },

    async updateLink(id, patch) {
      const columns = linkPatchColumns(patch);
      let lastMessage = "unknown error";
      for (let attempt = 0; attempt <= LINK_WRITE_RETRY_MS.length; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, LINK_WRITE_RETRY_MS[attempt - 1]));
        try {
          const { error } = await supabase().from("self_copy_trade_links").update(columns).eq("id", id);
          if (!error) return;
          lastMessage = error.message;
        } catch (error) {
          lastMessage = error instanceof Error ? error.message : "the database did not answer";
        }
      }
      throw new Error(lastMessage);
    },

    async openLinks(sourceAccountId, sourcePositionId) {
      const { data, error } = await supabase()
        .from("self_copy_trade_links")
        .select(LINK_COLUMNS)
        .eq("source_account_id", sourceAccountId)
        .eq("source_position_id", sourcePositionId)
        .eq("status", "OPEN")
        .not("follower_position_id", "is", null);
      if (error) throw new Error(`Open copies could not be read: ${error.message}`);
      return ((data ?? []) as LinkRow[]).map(linkFromRow);
    },

    async claimClose(sourceAccountId, sourcePositionId) {
      // Reserving the copies for the close and reading them is one statement: two runs of the
      // same close can never both receive the same row.
      const [claimed, unmapped] = await Promise.all([
        supabase()
          .from("self_copy_trade_links")
          .update({ status: "CLOSING" })
          .eq("source_account_id", sourceAccountId)
          .eq("source_position_id", sourcePositionId)
          .or(staleClosingFilter())
          .not("follower_position_id", "is", null)
          .select(LINK_COLUMNS),
        supabase()
          .from("self_copy_trade_links")
          .select(LINK_COLUMNS)
          .eq("source_account_id", sourceAccountId)
          .eq("source_position_id", sourcePositionId)
          .eq("status", "OPEN")
          .is("follower_position_id", null),
      ]);
      if (claimed.error) throw new Error(`Copies could not be reserved for the close: ${claimed.error.message}`);
      return {
        claimed: ((claimed.data ?? []) as LinkRow[]).map(linkFromRow),
        withoutTicket: ((unmapped.data ?? []) as LinkRow[]).map(linkFromRow),
      };
    },

    async openSourcePositionIds(sourceAccountId) {
      const { data, error } = await supabase()
        .from("self_copy_trade_links")
        .select("source_position_id")
        .eq("source_account_id", sourceAccountId)
        .or(staleClosingFilter())
        .not("follower_position_id", "is", null)
        .limit(2_000);
      if (error) throw new Error(`Open copies could not be listed: ${error.message}`);
      return [...new Set((data ?? []).map((row) => String(row.source_position_id)))];
    },

    record(activity) {
      getActivityLog().record(activityRow(activity));
    },
  };
}

// ── what the worker follows ──────────────────────────────────────────────────

interface WorkerRouteRow extends RouteRow {
  trading_accounts: { provider_account_id: string | null } | null;
}

/** Every live and paused route with the bridge's id of its source account (the worker's discovery loop). */
export async function loadSelfCopyRouteEntries(): Promise<SelfCopyRouteEntry[]> {
  const { data, error } = await createAdminClient()
    .from("self_copy_relationships")
    .select(`${ROUTE_COLUMNS}, trading_accounts!source_account_id(provider_account_id)`)
    .in("status", ["LIVE", "PAUSED"])
    .limit(1000);
  if (error) throw new Error(`Self-copy routes could not be loaded: ${error.message}`);
  return ((data ?? []) as unknown as WorkerRouteRow[]).map((row) => ({
    route: routeFromRow(row),
    providerAccountId: row.trading_accounts?.provider_account_id ?? null,
  }));
}

/** Which of these source accounts still have a copy that is open at the follower. */
export async function loadSourcesWithOpenCopies(sourceAccountIds: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const supabase = createAdminClient();
  for (let index = 0; index < sourceAccountIds.length; index += 100) {
    const { data, error } = await supabase
      .from("self_copy_trade_links")
      .select("source_account_id")
      .in("source_account_id", sourceAccountIds.slice(index, index + 100))
      .in("status", ["OPEN", "CLOSING"])
      .not("follower_position_id", "is", null)
      .limit(1000);
    if (error) throw new Error(`Open copies could not be listed: ${error.message}`);
    for (const row of data ?? []) found.add(String(row.source_account_id));
  }
  return found;
}

// ── engine status of a route (migration 061, optional) ───────────────────────

let engineColumnsMissingUntil = 0;

/** Tells the routes of a source account whether their stream is listening. Never throws. */
export async function reportSelfCopyEngine(
  sourceAccountId: string,
  status: "STARTING" | "LIVE" | "ERROR",
  error: string | null,
): Promise<void> {
  if (Date.now() < engineColumnsMissingUntil) return;
  try {
    const { error: failure } = await createAdminClient()
      .from("self_copy_relationships")
      .update({
        engine_status: status,
        engine_error: error ? error.slice(0, 400) : null,
        engine_heartbeat_at: new Date().toISOString(),
      })
      .eq("source_account_id", sourceAccountId)
      .eq("status", "LIVE");
    if (failure && isMissingSchema(failure)) engineColumnsMissingUntil = Date.now() + 10 * 60_000;
  } catch {
    // a status line is never worth a failed trade
  }
}

// ── reading the activity ─────────────────────────────────────────────────────

export interface SelfCopyActivityDto {
  id: string;
  eventType: "OPEN" | "MODIFY" | "CLOSE";
  outcome: "COPIED" | "SKIPPED" | "FAILED";
  code: string;
  message: string;
  symbol: string | null;
  followerSymbol: string | null;
  side: string | null;
  sourceVolume: number | null;
  copiedVolume: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface SelfCopyActivityResult {
  /** where the lines come from: the activity log, or (without migration 061) the copy links */
  source: "events" | "links";
  items: SelfCopyActivityDto[];
}

/** The latest activity of one route. The caller has checked that the route belongs to the person. */
export async function listSelfCopyActivity(routeId: string, limit = 40): Promise<SelfCopyActivityResult> {
  const supabase = createAdminClient();
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  const { data, error } = await supabase
    .from("self_copy_events")
    .select(
      "id, event_type, outcome, code, message, symbol, follower_symbol, side, source_volume, copied_volume, latency_ms, created_at",
    )
    .eq("relationship_id", routeId)
    .order("created_at", { ascending: false })
    .limit(bounded);
  if (!error) {
    return {
      source: "events",
      items: (data ?? []).map((row) => ({
        id: String(row.id),
        eventType: row.event_type as SelfCopyActivityDto["eventType"],
        outcome: row.outcome as SelfCopyActivityDto["outcome"],
        code: String(row.code),
        message: String(row.message ?? ""),
        symbol: row.symbol ?? null,
        followerSymbol: row.follower_symbol ?? null,
        side: row.side ?? null,
        sourceVolume: row.source_volume == null ? null : Number(row.source_volume),
        copiedVolume: row.copied_volume == null ? null : Number(row.copied_volume),
        latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
        createdAt: String(row.created_at),
      })),
    };
  }
  if (!isMissingSchema(error)) throw new Error(`Self-copy activity could not be loaded: ${error.message}`);

  // Without the activity table the copy links still tell what was opened, closed or failed.
  const { data: links, error: linkError } = await supabase
    .from("self_copy_trade_links")
    .select("id, symbol, side, copied_volume, status, error_code, error_message, created_at, updated_at")
    .eq("relationship_id", routeId)
    .order("updated_at", { ascending: false })
    .limit(bounded);
  if (linkError) throw new Error(`Self-copy activity could not be loaded: ${linkError.message}`);
  return {
    source: "links",
    items: (links ?? []).map((row) => {
      const failed = row.status === "FAILED";
      return {
        id: String(row.id),
        eventType: row.status === "CLOSED" || row.status === "CLOSING" ? "CLOSE" : "OPEN",
        outcome: failed ? "FAILED" : "COPIED",
        code: failed ? String(row.error_code ?? "FAILED") : String(row.status),
        message: failed
          ? String(row.error_message ?? "The copy failed.")
          : `Copy is ${String(row.status).toLowerCase()}.`,
        symbol: row.symbol ?? null,
        followerSymbol: row.symbol ?? null,
        side: row.side ?? null,
        sourceVolume: null,
        copiedVolume: row.copied_volume == null ? null : Number(row.copied_volume),
        latencyMs: null,
        createdAt: String(row.updated_at ?? row.created_at),
      } satisfies SelfCopyActivityDto;
    }),
  };
}

/** Old activity is not worth keeping: the worker clears it now and then. Never throws. */
export async function pruneSelfCopyActivity(olderThanDays = 14): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const { data, error } = await createAdminClient()
      .from("self_copy_events")
      .delete()
      .lt("created_at", cutoff)
      .select("id");
    if (error) return 0;
    return data?.length ?? 0;
  } catch {
    return 0;
  }
}
