if (typeof window !== 'undefined') {
  throw new Error('[aurix] brokerSyncService is server-only.');
}

import { createAdminClient } from '@/lib/supabase/admin';
import { getDecryptedCredentials, type BrokerCredentialPayload } from '@/lib/services/brokerCredentialService';
import { writeAuditLog } from '@/lib/services/auditService';
import { evaluateAndPersistRiskEvents } from '@/lib/services/riskEvaluationService';
import { createNotification } from '@/lib/services/notificationService';
import { resolveAccountLifecycleStatus } from '@/lib/accounts/lifecycle';
import { publicMetaApiError } from '@/lib/broker/metaApiErrors';
import { Api2TradeBrokerAdapter } from '@/lib/broker/Api2TradeBrokerAdapter';
import { publicApi2TradeError } from '@/lib/broker/api2TradeErrors';
import { acquireOperationalLock } from '@/lib/services/operationalLockService';
import { calculatePartnerRebatesForTradingAccounts } from '@/lib/services/partnerRebateCalculationService';
import {
  brokerProviderConfigured,
  createBrokerAdapter,
  getBrokerProviderId,
  getBrokerProviderLabel,
} from '@/lib/broker/provider';
import type { TradeDto, TraderAccountSummary } from '@/lib/domain/types';

// MetaAPI can return dates as Date objects, ISO strings, or Unix timestamps
// depending on the build variant. Always use this helper.
function safeIso(val: unknown, fallback?: string): string {
  const fb = fallback ?? new Date().toISOString();
  if (val == null) return fb;
  const d = val instanceof Date ? val : new Date(typeof val === 'number' ? val * 1000 : String(val));
  return isNaN(d.getTime()) ? fb : d.toISOString();
}

async function loadCachedTradeRefreshSummary(
  supabase: ReturnType<typeof createAdminClient>,
  accountId: string,
  providerAccountId: string,
  message = 'A broker sync is already running for this account. Showing the latest stored ledger snapshot.',
): Promise<TradeRefreshSummary> {
  const [snapshotResult, openTradesResult] = await Promise.all([
    supabase
      .from('account_snapshots')
      .select('balance, equity')
      .eq('trading_account_id', accountId)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('trades')
      .select('id', { count: 'exact', head: true })
      .eq('trading_account_id', accountId)
      .eq('status', 'OPEN'),
  ]);
  const snapshot = snapshotResult.data;
  return {
    accountId,
    providerAccountId,
    snapshotInserted: false,
    openPositions: openTradesResult.count ?? 0,
    tradesUpserted: 0,
    balance: Number(snapshot?.balance ?? 0),
    equity: Number(snapshot?.equity ?? 0),
    currency: 'USD',
    error: message,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncSummary {
  accountId: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'PENDING';
  snapshotInserted: boolean;
  tradesUpserted: number;
  error?: string;
  pendingMessage?: string;
}

export interface BrokerConnectionStatusSummary {
  accountId: string;
  status: 'PENDING' | 'SYNCING' | 'CONNECTED' | 'DISCONNECTED' | 'RESTRICTED' | 'INACTIVE';
  providerState: string | null;
  providerConnectionStatus: string | null;
  providerReady: boolean;
  lastSyncedAt: string | null;
  message: string;
}

export interface TradeRefreshSummary {
  accountId: string;
  providerAccountId: string;
  snapshotInserted: boolean;
  openPositions: number;
  tradesUpserted: number;
  balance: number;
  equity: number;
  currency: string;
  error?: string;
}

type MetaApiConstructor = new (token: string) => MetaApiClient;

interface MetaApiClient {
  metatraderAccountApi: {
    getAccount(accountId: string): Promise<MetaApiAccount>;
    createAccount(args: MetaApiCreateAccountArgs): Promise<MetaApiAccount>;
  };
  close(): void;
}

interface MetaApiCreateAccountArgs {
  login: string;
  password: string;
  server: string;
  platform: 'mt4' | 'mt5';
  name: string;
  magic: number;
  type: 'cloud';
  reliability: 'regular' | 'high';
}

interface MetaApiAccount {
  id: string;
  state: string;
  connectionStatus?: string;
  reliability?: string;
  deploy(): Promise<void>;
  waitDeployed(timeoutInSeconds: number, intervalInMilliseconds: number): Promise<void>;
  waitConnected(timeoutInSeconds: number, intervalInMilliseconds: number): Promise<void>;
  getRPCConnection(): MetaApiConnection;
}

interface MetaApiConnection {
  connect(): Promise<void>;
  waitSynchronized(timeoutInSeconds: number): Promise<void>;
  close(): Promise<void>;
  getAccountInformation(): Promise<MetaApiAccountInformation | null | undefined>;
  getPositions(): Promise<unknown>;
  getDealsByTimeRange(from: Date, to: Date): Promise<unknown>;
}

interface MetaApiAccountInformation {
  currency?: string;
  balance?: number;
  equity?: number;
  margin?: number;
  freeMargin?: number;
  leverage?: number;
  server?: string;
  brokerName?: string;
}

interface MetaApiPosition {
  id: string | number;
  symbol?: string;
  type?: string;
  volume?: number;
  openPrice?: number;
  profit?: number;
  openTime?: unknown;
}

interface MetaApiDeal {
  id: string | number;
  positionId?: string | number;
  symbol?: string;
  type?: string;
  entryType?: string;
  volume?: number;
  price?: number | null;
  profit?: number;
  time?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeMessage(msg: string, creds: BrokerCredentialPayload): string {
  let s = msg;
  if (creds.login) s = s.split(creds.login).join('[redacted]');
  if (creds.password) s = s.split(creds.password).join('[redacted]');
  if (creds.server) s = s.split(creds.server).join('[redacted]');
  if (msg.includes('high reliability') && msg.includes('top up')) {
    return (
      'MetaAPI rejected regular-reliability provisioning. ' +
      'Your MetaAPI account may have no available slots. ' +
      'Delete unused accounts at app.metaapi.cloud and retry.'
    );
  }
  return s.slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function liveRiskProjectionEnabled(): boolean {
  return getBrokerProviderId() !== 'api2trade'
    && Boolean(process.env.METAAPI_TOKEN)
    && process.env.WSA_RISK_ENGINE_ENABLED === 'true';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readStringOrNumber(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function normalizePositions(value: unknown): MetaApiPosition[] {
  if (!Array.isArray(value)) return [];

  return value.reduce<MetaApiPosition[]>((positions, item) => {
    if (!isRecord(item)) return positions;

    const id = readStringOrNumber(item.id);
    if (id === undefined) return positions;

    positions.push({
      id,
      symbol: readString(item.symbol),
      type: readString(item.type),
      volume: readNumber(item.volume),
      openPrice: readNumber(item.openPrice),
      profit: readNumber(item.profit),
      openTime: item.openTime,
    });

    return positions;
  }, []);
}

function normalizeDeals(value: unknown): MetaApiDeal[] {
  const rawDeals = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.deals)
      ? value.deals
      : [];

  return rawDeals.reduce<MetaApiDeal[]>((deals, item) => {
    if (!isRecord(item)) return deals;

    const id = readStringOrNumber(item.id);
    if (id === undefined) return deals;

    deals.push({
      id,
      positionId: readStringOrNumber(item.positionId),
      symbol: readString(item.symbol),
      type: readString(item.type),
      entryType: readString(item.entryType),
      volume: readNumber(item.volume),
      price: item.price === null ? null : readNumber(item.price),
      profit: readNumber(item.profit),
      time: item.time,
    });

    return deals;
  }, []);
}

export function isClosingDeal(entryType: string | undefined): boolean {
  return entryType === 'DEAL_ENTRY_OUT' || entryType === 'DEAL_ENTRY_OUT_BY';
}

function tradeDtoToRow(trade: TradeDto, currency: string) {
  return {
    trading_account_id: trade.accountId,
    external_trade_id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    status: trade.status,
    volume: trade.volume,
    open_price: trade.openPrice,
    close_price: trade.closePrice,
    profit: trade.profit.amount,
    currency: trade.profit.currency || currency,
    opened_at: trade.openedAt,
    closed_at: trade.closedAt,
  };
}

async function persistBrokerSnapshotAndTrades(params: {
  supabase: ReturnType<typeof createAdminClient>;
  accountId: string;
  snapshot: TraderAccountSummary;
  openTrades: TradeDto[];
  closedTrades: TradeDto[];
}): Promise<{ tradesUpserted: number; openPositions: number; currency: string; balance: number; equity: number }> {
  const { supabase, accountId, snapshot, openTrades, closedTrades } = params;
  const currency = snapshot.equity.currency || snapshot.balance.currency || 'USD';
  const balance = snapshot.balance.amount;
  const equity = snapshot.equity.amount;
  await supabase.from('account_snapshots').insert({
    trading_account_id: accountId,
    balance,
    equity,
    floating_pnl: snapshot.floatingPnl.amount,
    drawdown_percent: snapshot.drawdownPercent,
  });

  const rows = [
    ...openTrades.map((trade) => tradeDtoToRow(trade, currency)),
    ...closedTrades.map((trade) => tradeDtoToRow(trade, currency)),
  ];
  const externalIds = [...new Set(rows.map((row) => row.external_trade_id).filter(Boolean))];
  const existingMap = new Map<string, string>();
  if (externalIds.length > 0) {
    const { data: existing } = await supabase
      .from('trades')
      .select('id, external_trade_id')
      .eq('trading_account_id', accountId)
      .in('external_trade_id', externalIds);
    for (const row of existing ?? []) {
      if (row.external_trade_id) existingMap.set(row.external_trade_id as string, row.id as string);
    }
  }

  let tradesUpserted = 0;
  const toInsert = rows.filter((row) => !existingMap.has(row.external_trade_id));
  if (toInsert.length > 0) {
    const { data, error } = await supabase.from('trades').insert(toInsert).select('id');
    if (error) throw new Error(`Trade insert failed: ${error.message}`);
    tradesUpserted += data?.length ?? 0;
  }
  for (const row of rows.filter((item) => existingMap.has(item.external_trade_id))) {
    const { error } = await supabase
      .from('trades')
      .update({
        symbol: row.symbol,
        side: row.side,
        status: row.status,
        volume: row.volume,
        open_price: row.open_price,
        close_price: row.close_price,
        profit: row.profit,
        currency: row.currency,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
      })
      .eq('trading_account_id', accountId)
      .eq('external_trade_id', row.external_trade_id);
    if (error) throw new Error(`Trade update failed: ${error.message}`);
    tradesUpserted++;
  }

  if (tradesUpserted > 0) {
    try {
      await calculatePartnerRebatesForTradingAccounts([accountId]);
    } catch (error) {
      console.warn(
        `[partner-rebates] skipped automatic rebate calculation for ${accountId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { tradesUpserted, openPositions: openTrades.length, currency, balance, equity };
}

async function loadMetaApi(): Promise<MetaApiConstructor> {
  const metaApiModule = await import('metaapi.cloud-sdk/node');
  return (metaApiModule as unknown as { default: MetaApiConstructor }).default;
}

async function markFailed(
  supabase: ReturnType<typeof createAdminClient>,
  accountId: string,
  message: string,
  previousStatus: string,
): Promise<boolean> {
  const normalized = message.toLowerCase();
  const transientProviderFailure = [
    'timeout',
    'timed out',
    'websocket',
    'socket',
    'network',
    'econn',
    'temporarily unavailable',
    'not connected to broker yet',
    'subscription',
    'synchroniz',
    'too many requests',
    '429',
  ].some((fragment) => normalized.includes(fragment));
  const preserveConnectedStatus =
    (previousStatus === 'CONNECTED' || previousStatus === 'RESTRICTED')
    && transientProviderFailure;

  await supabase
    .from('trading_accounts')
    .update(
      preserveConnectedStatus
        ? { sync_error: message.slice(0, 500) }
        : { status: 'DISCONNECTED', sync_error: message.slice(0, 500) },
    )
    .eq('id', accountId);

  return preserveConnectedStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core MetaAPI sync — single SDK session, all data in one connection
// ─────────────────────────────────────────────────────────────────────────────

async function runMetaApiSync(params: {
  token: string;
  accountId: string;
  supabase: ReturnType<typeof createAdminClient>;
  actorUserId: string | null;
  credentials: BrokerCredentialPayload;
  platform: 'mt4' | 'mt5';
  existingProviderAccountId: string | null;
  preserveRestricted: boolean;
  previousStatus: string;
}): Promise<SyncSummary> {
  const {
    token,
    accountId,
    supabase,
    actorUserId,
    credentials,
    platform,
    existingProviderAccountId,
    preserveRestricted,
    previousStatus,
  } = params;

  // '/node' subpath → dists/cjs/index.js (Node CJS bundle, no window references).
  // Default import() follows the "import" exports condition → dists/esm-web/index.js which references window.
  const MetaApi = await loadMetaApi();
  const api = new MetaApi(token);
  let connection: MetaApiConnection | null = null;

  try {
    // ── 1. Get or create MetaAPI account ───────────────────────────────────
    let metaAccount: MetaApiAccount;

    if (existingProviderAccountId) {
      console.log('[METAAPI_CREATE_OR_REUSE_START]', { providerAccountId: existingProviderAccountId });
      metaAccount = await api.metatraderAccountApi.getAccount(existingProviderAccountId);
      console.log('[METAAPI_ACCOUNT_STATE]', {
        id: metaAccount.id,
        state: metaAccount.state,
        connectionStatus: metaAccount.connectionStatus,
      });
    } else {
      console.log('[METAAPI_CREATE_OR_REUSE_START]', { providerAccountId: null });
      console.log('[MetaAPI_CREATE_PAYLOAD_SAFE]', { reliability: 'regular', platform });

      metaAccount = await api.metatraderAccountApi.createAccount({
        login: credentials.login,
        password: credentials.password,
        server: credentials.server,
        platform,
        // `name` is the label shown in MetaAPI dashboard — not a DB column
        name: credentials.brokerName
          ? credentials.brokerName
          : `Account-${accountId.slice(0, 8)}`,
        magic: 0,
        type: 'cloud',
        reliability: 'regular',
      });

      console.log('[MetaAPI_CREATE_PAYLOAD_SAFE] Account created', {
        id: metaAccount.id,
        state: metaAccount.state,
        reliability: metaAccount.reliability,
      });

      // ── 2. Save provider_account_id IMMEDIATELY — before deploy/connect ──
      // This prevents creating a duplicate MetaAPI account if the request times out.
      await supabase
        .from('trading_accounts')
        .update({
          provider_account_id: metaAccount.id,
          provider: credentials.provider,
          sync_error: null,
        })
        .eq('id', accountId);
    }

    // ── 3. Deploy if not already deployed ─────────────────────────────────
    if (metaAccount.state !== 'DEPLOYED') {
      console.log('[MetaAPI_CREATE_PAYLOAD_SAFE] Deploying', { state: metaAccount.state });
      await metaAccount.deploy();
      await metaAccount.waitDeployed(120, 1000);
    }

    // ── 4. Wait for broker connection ──────────────────────────────────────
    await metaAccount.waitConnected(60, 1000);

    console.log('[METAAPI_ACCOUNT_STATE]', {
      id: metaAccount.id,
      state: metaAccount.state,
      connectionStatus: metaAccount.connectionStatus,
    });

    // ── 5. Open RPC connection and fetch all data in one session ──────────
    connection = metaAccount.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized(60);

    const [info, positions] = await Promise.all([
      connection.getAccountInformation(),
      connection.getPositions(),
    ]);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dealsResult = await connection.getDealsByTimeRange(since, new Date());
    const deals = normalizeDeals(dealsResult);

    const currency: string = info?.currency ?? 'USD';
    const balance: number = info?.balance ?? 0;
    const equity: number = info?.equity ?? 0;

    // ── 6. Insert account snapshot ─────────────────────────────────────────
    await supabase.from('account_snapshots').insert({
      trading_account_id: accountId,
      balance,
      equity,
      floating_pnl: equity - balance,
      drawdown_percent: balance > 0 ? Math.max(0, ((balance - equity) / balance) * 100) : 0,
    });

    // ── 7. Sync trades ─────────────────────────────────────────────────────
    // Use an explicit insert/update split so open positions can transition to
    // closed trades without changing their internal UUID or display ID.
    const openRows = normalizePositions(positions).map((p) => ({
      trading_account_id: accountId,
      external_trade_id: String(p.id),
      symbol: p.symbol ?? '',
      side: p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
      status: 'OPEN' as const,
      volume: p.volume ?? 0,
      open_price: p.openPrice ?? 0,
      close_price: null as null,
      profit: p.profit ?? 0,
      currency,
      opened_at: safeIso(p.openTime),
      closed_at: null as null,
    }));

    const closeDeals = deals.filter((d) => isClosingDeal(d.entryType));

    const allExtIds = [
      ...openRows.map((r) => r.external_trade_id),
      ...closeDeals.map((d) => String(d.positionId ?? d.id)),
    ].filter(Boolean);

    // Load existing rows for this account so we can split insert vs update.
    const existingMap = new Map<string, string>();
    if (allExtIds.length > 0) {
      const { data: existing } = await supabase
        .from('trades')
        .select('id, external_trade_id')
        .eq('trading_account_id', accountId)
        .in('external_trade_id', allExtIds);
      for (const r of existing ?? []) {
        if (r.external_trade_id) existingMap.set(r.external_trade_id as string, r.id as string);
      }
    }

    let tradesUpserted = 0;

    // Insert brand-new open positions.
    const toInsert = openRows.filter((r) => !existingMap.has(r.external_trade_id));
    if (toInsert.length > 0) {
      const { data: inserted, error: insertErr } = await supabase
        .from('trades').insert(toInsert).select('id');
      if (insertErr) throw new Error(`Trade insert failed: ${insertErr.message}`);
      tradesUpserted += inserted?.length ?? 0;
    }

    // Update profit on already-known open positions.
    const toUpdateOpen = openRows.filter((r) => existingMap.has(r.external_trade_id));
    for (const r of toUpdateOpen) {
      await supabase.from('trades')
        .update({ profit: r.profit, status: 'OPEN', close_price: null, closed_at: null })
        .eq('trading_account_id', accountId)
        .eq('external_trade_id', r.external_trade_id);
      tradesUpserted++;
    }

    // Mark closed: deals with DEAL_ENTRY_OUT whose position is in DB.
    for (const d of closeDeals) {
      const extId = String(d.positionId ?? d.id);
      const rowId = existingMap.get(extId);
      const closedAt = safeIso(d.time);
      if (rowId) {
        await supabase.from('trades')
          .update({ status: 'CLOSED', close_price: d.price ?? null, profit: d.profit ?? 0, closed_at: closedAt })
          .eq('id', rowId);
        tradesUpserted++;
      } else {
        // Position closed before we ever saw it open — insert as CLOSED.
        const { data: ins } = await supabase.from('trades').insert({
          trading_account_id: accountId,
          external_trade_id: extId,
          symbol: d.symbol ?? '',
          side: d.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL',
          status: 'CLOSED',
          volume: d.volume ?? 0,
          open_price: 0,
          close_price: d.price ?? null,
          profit: d.profit ?? 0,
          currency,
          opened_at: closedAt,
          closed_at: closedAt,
        }).select('id');
        tradesUpserted += ins?.length ?? 0;
      }
    }

    // ── 8. Mark CONNECTED ──────────────────────────────────────────────────
    await supabase
      .from('trading_accounts')
      .update({
        status: preserveRestricted ? 'RESTRICTED' : 'CONNECTED',
        last_synced_at: new Date().toISOString(),
        sync_error: null,
        provider: credentials.provider,
        provider_account_id: metaAccount.id,
        broker_name: info?.brokerName?.trim() || credentials.brokerName?.trim() || 'WSA GLOBAL',
        broker_server: info?.server?.trim() || credentials.server,
        broker_platform: platform.toUpperCase(),
      })
      .eq('id', accountId);

    console.log('[SYNC_SUCCESS]', { tradingAccountId: accountId, providerAccountId: metaAccount.id });

    void writeAuditLog({
      actorUserId,
      action: 'ACCOUNT_SYNC_COMPLETED',
      entityType: 'trading_account',
      entityId: accountId,
      metadata: { provider: credentials.provider, tradesUpserted, snapshotInserted: true },
    });

    return { accountId, status: 'CONNECTED', snapshotInserted: true, tradesUpserted };

  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    const diagnosticMessage = sanitizeMessage(rawMsg, credentials);
    const safeMsg = publicMetaApiError(diagnosticMessage);
    console.error('[SYNC_ERROR]', {
      tradingAccountId: accountId,
      message: diagnosticMessage,
    });
    const preservedConnectedStatus = await markFailed(
      supabase,
      accountId,
      safeMsg,
      previousStatus,
    );
    if (preservedConnectedStatus) {
      console.warn('[SYNC_TRANSIENT_ERROR_STATUS_PRESERVED]', {
        tradingAccountId: accountId,
        previousStatus,
        message: safeMsg,
      });
    }
    return {
      accountId,
      status: preservedConnectedStatus ? 'CONNECTED' : 'DISCONNECTED',
      snapshotInserted: false,
      tradesUpserted: 0,
      error: safeMsg,
    };

  } finally {
    if (connection) { try { await connection.close(); } catch { /* ignore */ } }
    try { api.close(); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: sync one account
// ─────────────────────────────────────────────────────────────────────────────

async function runApi2TradeSync(params: {
  accountId: string;
  supabase: ReturnType<typeof createAdminClient>;
  actorUserId: string | null;
  credentials: BrokerCredentialPayload;
  platform: 'mt4' | 'mt5';
  existingProviderAccountId: string | null;
  preserveRestricted: boolean;
  previousStatus: string;
}): Promise<SyncSummary> {
  const {
    accountId,
    supabase,
    actorUserId,
    credentials,
    platform,
    existingProviderAccountId,
    preserveRestricted,
    previousStatus,
  } = params;
  const provider = 'api2trade';
  const adapter = new Api2TradeBrokerAdapter();

  try {
    if (!adapter.configured()) {
      return {
        accountId,
        status: 'DISCONNECTED',
        snapshotInserted: false,
        tradesUpserted: 0,
        error: 'API2Trade is not configured.',
      };
    }

    let providerAccountId = existingProviderAccountId;
    if (!providerAccountId) {
      providerAccountId = await adapter.registerAccount({
        accountId,
        login: credentials.login,
        password: credentials.password,
        server: credentials.server,
        platform,
        name: credentials.brokerName?.trim() || `WSA-${accountId.slice(0, 8)}`,
      });
      await supabase
        .from('trading_accounts')
        .update({
          provider_account_id: providerAccountId,
          provider,
          sync_error: null,
        })
        .eq('id', accountId);
    } else {
      await supabase
        .from('trading_accounts')
        .update({ provider, sync_error: null })
        .eq('id', accountId);
    }

    const health = await adapter.verifyConnection(accountId);
    if (!health.ok) {
      const message = health.message || 'API2Trade account is not connected yet.';
      const preservedConnectedStatus = await markFailed(supabase, accountId, message, previousStatus);
      return {
        accountId,
        status: preservedConnectedStatus ? 'CONNECTED' : 'PENDING',
        snapshotInserted: false,
        tradesUpserted: 0,
        pendingMessage: message,
      };
    }

    const [snapshot, openTrades, closedTrades] = await Promise.all([
      adapter.fetchSnapshot(accountId),
      adapter.fetchOpenTrades(accountId),
      adapter.fetchTradeHistory(accountId),
    ]);
    const persisted = await persistBrokerSnapshotAndTrades({
      supabase,
      accountId,
      snapshot,
      openTrades,
      closedTrades,
    });

    await supabase
      .from('trading_accounts')
      .update({
        status: preserveRestricted ? 'RESTRICTED' : 'CONNECTED',
        last_synced_at: new Date().toISOString(),
        sync_error: null,
        provider,
        provider_account_id: providerAccountId,
        broker_name: snapshot.brokerName?.trim() || credentials.brokerName?.trim() || 'WSA GLOBAL',
        broker_server: snapshot.serverName?.trim() || credentials.server,
        broker_platform: platform.toUpperCase(),
      })
      .eq('id', accountId);

    void writeAuditLog({
      actorUserId,
      action: 'ACCOUNT_SYNC_COMPLETED',
      entityType: 'trading_account',
      entityId: accountId,
      metadata: { provider, tradesUpserted: persisted.tradesUpserted, snapshotInserted: true },
    });

    return {
      accountId,
      status: 'CONNECTED',
      snapshotInserted: true,
      tradesUpserted: persisted.tradesUpserted,
    };
  } catch (error) {
    const diagnosticMessage = sanitizeMessage(publicApi2TradeError(error), credentials);
    console.error('[API2TRADE_SYNC_ERROR]', { tradingAccountId: accountId, message: diagnosticMessage });
    const preservedConnectedStatus = await markFailed(supabase, accountId, diagnosticMessage, previousStatus);
    return {
      accountId,
      status: preservedConnectedStatus ? 'CONNECTED' : 'DISCONNECTED',
      snapshotInserted: false,
      tradesUpserted: 0,
      error: diagnosticMessage,
    };
  }
}

export async function syncTradingAccount(
  accountId: string,
  actorUserId: string | null,
  options?: { force?: boolean },
): Promise<SyncSummary> {
  const supabase = createAdminClient();

  console.log('[SYNC_START]', { tradingAccountId: accountId });

  // 1. Load account — do NOT select a `name` column (it may not exist)
  const { data: account, error: loadErr } = await supabase
    .from('trading_accounts')
    .select('id, broker_name, status, provider_account_id, user_id')
    .eq('id', accountId)
    .single();

  if (loadErr || !account) {
    console.error('[SYNC_ERROR]', { tradingAccountId: accountId, message: 'Account not found' });
    return { accountId, status: 'DISCONNECTED', snapshotInserted: false, tradesUpserted: 0, error: 'Account not found.' };
  }

  console.log('[DB_ACCOUNT_BEFORE_SYNC]', {
    id: account.id,
    status: account.status,
    provider_account_id: account.provider_account_id,
  });

  if (
    liveRiskProjectionEnabled()
    && !options?.force
    && (account.status === 'CONNECTED' || account.status === 'RESTRICTED')
  ) {
    await supabase
      .from('trading_accounts')
      .update({ sync_error: null })
      .eq('id', accountId);
    console.log('[SYNC_SKIPPED_LIVE_STREAM_OWNER]', { tradingAccountId: accountId });
    return {
      accountId,
      status: 'CONNECTED',
      snapshotInserted: false,
      tradesUpserted: 0,
    };
  }

  // 2. Load and decrypt credentials (never logged)
  const credentials = await getDecryptedCredentials(accountId);
  if (!credentials) {
    return { accountId, status: 'PENDING', snapshotInserted: false, tradesUpserted: 0, error: 'No broker credentials stored for this account.' };
  }

  // 3. Resolve platform — use stored value, fall back to MT5 for modern brokers
  // Old credentials without `platform` field will have undefined here; default to mt5.
  const platform: 'mt4' | 'mt5' = credentials.platform ?? 'mt5';

  const activeProvider = getBrokerProviderId();
  if (!brokerProviderConfigured()) {
    return {
      accountId,
      status: 'DISCONNECTED',
      snapshotInserted: false,
      tradesUpserted: 0,
      error: `${getBrokerProviderLabel(activeProvider)} is not configured.`,
    };
  }

  // Keep live accounts selectable while refreshing. SYNCING is only an
  // onboarding state; changing a connected account to SYNCING makes it vanish
  // from connected-only trader selectors during every background refresh.
  await supabase
    .from('trading_accounts')
    .update(account.status === 'CONNECTED' || account.status === 'RESTRICTED'
      ? { sync_error: null }
      : { status: 'SYNCING', sync_error: null })
    .eq('id', accountId);

  void writeAuditLog({
    actorUserId,
    action: 'ACCOUNT_SYNC_TRIGGERED',
    entityType: 'trading_account',
    entityId: accountId,
    metadata: { provider: activeProvider, platform },
  });

  const commonSyncParams = {
    accountId,
    supabase,
    actorUserId,
    credentials,
    platform,
    existingProviderAccountId: account.provider_account_id ?? null,
    preserveRestricted: account.status === 'RESTRICTED',
    previousStatus: account.status,
  };
  const result = activeProvider === 'api2trade'
    ? await runApi2TradeSync(commonSyncParams)
    : await runMetaApiSync({
        ...commonSyncParams,
        token: process.env.METAAPI_TOKEN!,
      });


  // ── Post-sync: risk evaluation and notifications ──────────────────────────
  if (result.status === 'CONNECTED') {
    // Fire-and-forget — never let this fail the sync response
    void evaluateAndPersistRiskEvents(accountId, actorUserId).catch((err) =>
      console.error('[SYNC_RISK_EVAL_ERROR]', { accountId, err })
    );

    // account.status is the pre-sync value — intentionally stale to detect first-time connections
    if (account.status !== 'CONNECTED') {
      void createNotification({
        userId: account.user_id,
        accountId,
        type: 'SYNC_SUCCESS',
        title: 'Account connected',
        message: `${account.broker_name} account successfully connected and synced.`,
      }).catch(() => {/* ignore notification errors */});
    }
  }

  if (result.status === 'DISCONNECTED' && result.error) {
    void createNotification({
      userId: account.user_id,
      accountId,
      type: 'SYNC_FAILURE',
      title: 'Account sync failed',
      message: result.error.slice(0, 200),
    }).catch(() => {/* ignore */});
    void writeAuditLog({
      actorUserId,
      action: 'ACCOUNT_SYNC_FAILED',
      entityType: 'trading_account',
      entityId: accountId,
      metadata: { error: result.error.slice(0, 200) },
    });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: lightweight trade refresh — uses existing provider_account_id only.
// No account creation. No credentials required.
// Intended for trader-triggered "Sync Trades" button.
// ─────────────────────────────────────────────────────────────────────────────

/** Lightweight provider-state lookup; no RPC, trade fetch, or execution. */
export async function getBrokerConnectionStatus(
  accountId: string,
): Promise<BrokerConnectionStatusSummary> {
  const supabase = createAdminClient();
  const { data: account, error } = await supabase
    .from('trading_accounts')
    .select('id, status, provider_account_id, last_synced_at, broker_server, broker_platform')
    .eq('id', accountId)
    .maybeSingle();

  if (error || !account) throw new Error('Trading account not found.');
  const localStatus = account.status as BrokerConnectionStatusSummary['status'];
  const { data: snapshot } = await supabase
    .from('latest_account_snapshots')
    .select('captured_at')
    .eq('trading_account_id', accountId)
    .maybeSingle();
  const effectiveLocalStatus = resolveAccountLifecycleStatus({
    status: localStatus,
    lastSyncedAt: account.last_synced_at,
    snapshotCapturedAt: snapshot?.captured_at ?? null,
    serverName: account.broker_server,
    platform: account.broker_platform,
  });
  const activeProvider = getBrokerProviderId();

  if (activeProvider === 'api2trade') {
    if (!account.provider_account_id || !brokerProviderConfigured()) {
      return {
        accountId,
        status: effectiveLocalStatus,
        providerState: account.provider_account_id ? 'CONFIG_MISSING' : null,
        providerConnectionStatus: null,
        providerReady: false,
        lastSyncedAt: account.last_synced_at,
        message: account.provider_account_id
          ? 'API2Trade status is unavailable because the provider is not configured.'
          : effectiveLocalStatus === 'PENDING'
            ? 'Account setup is incomplete. Add broker credentials to start the connection.'
            : 'The API2Trade account has not been provisioned yet.',
      };
    }
    const adapter = createBrokerAdapter();
    const health = await adapter.verifyConnection(accountId);
    const synchronized = effectiveLocalStatus === 'CONNECTED' || effectiveLocalStatus === 'RESTRICTED';
    const status = health.ok
      ? effectiveLocalStatus === 'INACTIVE'
        ? 'INACTIVE'
        : synchronized
          ? effectiveLocalStatus
          : 'SYNCING'
      : effectiveLocalStatus === 'DISCONNECTED' || effectiveLocalStatus === 'INACTIVE'
        ? effectiveLocalStatus
        : 'SYNCING';
    return {
      accountId,
      status,
      providerState: health.ok ? 'READY' : 'CONNECTING',
      providerConnectionStatus: health.ok ? 'CONNECTED' : 'UNKNOWN',
      providerReady: health.ok,
      lastSyncedAt: account.last_synced_at,
      message: status === 'INACTIVE'
        ? 'This account has had no successful broker activity for 10 days. Re-enter or confirm the credentials, then sync it to reconnect.'
        : health.ok
          ? synchronized
            ? 'API2Trade is connected and the account has synchronized.'
            : 'API2Trade is connected, but the first account-data sync has not completed. Run Sync account to finish connecting.'
          : health.message,
    };
  }

  const token = process.env.METAAPI_TOKEN;

  if (!account.provider_account_id || !token) {
    return {
      accountId,
      status: effectiveLocalStatus,
      providerState: null,
      providerConnectionStatus: null,
      providerReady: false,
      lastSyncedAt: account.last_synced_at,
      message: account.provider_account_id
        ? 'MetaApi status is unavailable because the provider is not configured.'
        : effectiveLocalStatus === 'PENDING'
          ? 'Account setup is incomplete. Add broker credentials to start the connection.'
          : 'The MetaApi account has not been provisioned yet.',
    };
  }

  const MetaApi = await loadMetaApi();
  const api = new MetaApi(token);
  try {
    const providerAccount = await api.metatraderAccountApi.getAccount(account.provider_account_id);
    const providerState = providerAccount.state ?? null;
    const providerConnectionStatus = providerAccount.connectionStatus ?? null;
    const providerReady = providerState === 'DEPLOYED' && providerConnectionStatus === 'CONNECTED';

    const synchronized = effectiveLocalStatus === 'CONNECTED' || effectiveLocalStatus === 'RESTRICTED';
    const status = providerReady
      ? effectiveLocalStatus === 'INACTIVE'
        ? 'INACTIVE'
        : synchronized
          ? effectiveLocalStatus
          : 'SYNCING'
      : effectiveLocalStatus === 'DISCONNECTED' || effectiveLocalStatus === 'INACTIVE'
        ? effectiveLocalStatus
        : 'SYNCING';
    return {
      accountId,
      status,
      providerState,
      providerConnectionStatus,
      providerReady,
      lastSyncedAt: account.last_synced_at,
      message: status === 'INACTIVE'
        ? 'This account has had no successful broker activity for 10 days. Re-enter or confirm the credentials, then sync it to reconnect.'
        : providerReady
        ? synchronized
          ? 'MetaApi is connected and the account has synchronized.'
          : 'MetaApi is connected, but the first account-data sync has not completed. Run Sync account to finish connecting.'
        : 'MetaApi is still deploying or connecting this account. No action is required yet.',
    };
  } catch (providerError) {
    const safeMessage = (providerError instanceof Error ? providerError.message : 'Provider status lookup failed.')
      .replace(/password[^,\s]*/gi, '[redacted]')
      .replace(/login[^,\s]*/gi, '[redacted]')
      .slice(0, 300);
    return {
      accountId,
      status: effectiveLocalStatus,
      providerState: null,
      providerConnectionStatus: null,
      providerReady: false,
      lastSyncedAt: account.last_synced_at,
      message: safeMessage,
    };
  } finally {
    try { api.close(); } catch { /* ignore */ }
  }
}

export async function refreshAccountTrades(
  accountId: string,
  actorUserId: string | null,
): Promise<TradeRefreshSummary> {
  const supabase = createAdminClient();

  console.log('[REFRESH_START]', { tradingAccountId: accountId });

  const { data: account, error: loadErr } = await supabase
    .from('trading_accounts')
    .select('id, status, provider_account_id, user_id')
    .eq('id', accountId)
    .single();

  if (loadErr || !account) {
    return { accountId, providerAccountId: '', snapshotInserted: false, openPositions: 0, tradesUpserted: 0, balance: 0, equity: 0, currency: 'USD', error: 'Account not found.' };
  }

  if (!account.provider_account_id) {
    return { accountId, providerAccountId: '', snapshotInserted: false, openPositions: 0, tradesUpserted: 0, balance: 0, equity: 0, currency: 'USD', error: `Account has not been synced yet. No ${getBrokerProviderLabel()} account ID stored.` };
  }

  if (
    liveRiskProjectionEnabled()
    && (account.status === 'CONNECTED' || account.status === 'RESTRICTED')
  ) {
    const [snapshotResult, openTradesResult] = await Promise.all([
      supabase
        .from('account_snapshots')
        .select('balance, equity')
        .eq('trading_account_id', accountId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('trading_account_id', accountId)
        .eq('status', 'OPEN'),
    ]);
    const snapshot = snapshotResult.data;
    console.log('[REFRESH_SKIPPED_LIVE_STREAM_OWNER]', { tradingAccountId: accountId });
    return {
      accountId,
      providerAccountId: account.provider_account_id,
      snapshotInserted: false,
      openPositions: openTradesResult.count ?? 0,
      tradesUpserted: 0,
      balance: Number(snapshot?.balance ?? 0),
      equity: Number(snapshot?.equity ?? 0),
      currency: 'USD',
    };
  }

  if (getBrokerProviderId() === 'api2trade') {
    if (!brokerProviderConfigured()) {
      return {
        accountId,
        providerAccountId: account.provider_account_id,
        snapshotInserted: false,
        openPositions: 0,
        tradesUpserted: 0,
        balance: 0,
        equity: 0,
        currency: 'USD',
        error: 'API2Trade is not configured.',
      };
    }
    const lock = await acquireOperationalLock(`account-sync:${accountId}`, 90);
    if (!lock) {
      return loadCachedTradeRefreshSummary(supabase, accountId, account.provider_account_id);
    }
    try {
      const adapter = createBrokerAdapter();
      const [snapshot, openTrades, closedTrades] = await Promise.all([
        adapter.fetchSnapshot(accountId),
        adapter.fetchOpenTrades(accountId),
        adapter.fetchTradeHistory(accountId),
      ]);
      const persisted = await persistBrokerSnapshotAndTrades({
        supabase,
        accountId,
        snapshot,
        openTrades,
        closedTrades,
      });
      await supabase
        .from('trading_accounts')
        .update({
          last_synced_at: new Date().toISOString(),
          sync_error: null,
          broker_name: snapshot.brokerName?.trim() || 'WSA GLOBAL',
          broker_server: snapshot.serverName?.trim() || null,
        })
        .eq('id', accountId);
      void writeAuditLog({
        actorUserId,
        action: 'ACCOUNT_SYNC_COMPLETED',
        entityType: 'trading_account',
        entityId: accountId,
        metadata: { source: 'trader-refresh', provider: 'api2trade', tradesUpserted: persisted.tradesUpserted, openPositions: persisted.openPositions },
      });
      void evaluateAndPersistRiskEvents(accountId, actorUserId).catch((err) =>
        console.error('[REFRESH_RISK_EVAL_ERROR]', { accountId, err })
      );
      return {
        accountId,
        providerAccountId: account.provider_account_id,
        snapshotInserted: true,
        openPositions: persisted.openPositions,
        tradesUpserted: persisted.tradesUpserted,
        balance: persisted.balance,
        equity: persisted.equity,
        currency: persisted.currency,
      };
    } catch (error) {
      const msg = publicApi2TradeError(error);
      await supabase.from('trading_accounts').update({ sync_error: msg }).eq('id', accountId);
      return {
        accountId,
        providerAccountId: account.provider_account_id,
        snapshotInserted: false,
        openPositions: 0,
        tradesUpserted: 0,
        balance: 0,
        equity: 0,
        currency: 'USD',
        error: msg,
      };
    } finally {
      await lock.release();
    }
  }

  const token = process.env.METAAPI_TOKEN;
  if (!token) {
    return { accountId, providerAccountId: account.provider_account_id, snapshotInserted: false, openPositions: 0, tradesUpserted: 0, balance: 0, equity: 0, currency: 'USD', error: 'METAAPI_TOKEN is not configured.' };
  }

  const lock = await acquireOperationalLock(`account-sync:${accountId}`, 120);
  if (!lock) {
    return loadCachedTradeRefreshSummary(supabase, accountId, account.provider_account_id);
  }

  try {
    const refreshPromise = (async (): Promise<TradeRefreshSummary> => {
    // '/node' subpath → dists/cjs/index.js (Node CJS bundle, no window references).
    // Default import() follows the "import" exports condition → dists/esm-web/index.js which references window.
    const MetaApi = await loadMetaApi();
    const api = new MetaApi(token);
    let connection: MetaApiConnection | null = null;

    try {
      const metaAccount = await api.metatraderAccountApi.getAccount(account.provider_account_id);

      console.log('[METAAPI_ACCOUNT_STATE]', {
        id: metaAccount.id,
        state: metaAccount.state,
        connectionStatus: metaAccount.connectionStatus,
      });

      if (metaAccount.state !== 'DEPLOYED') {
        await metaAccount.deploy();
        await metaAccount.waitDeployed(90, 1000);
      }

      await metaAccount.waitConnected(60, 1000);

      connection = metaAccount.getRPCConnection();
      await connection.connect();
      await connection.waitSynchronized(60);

      // Fetch account info and positions sequentially so we can log each step.
      const info = await connection.getAccountInformation();

      console.log('[REFRESH_ACCOUNT_INFO]', {
        tradingAccountId: accountId,
        balance: info?.balance,
        equity: info?.equity,
        currency: info?.currency,
        margin: info?.margin,
        freeMargin: info?.freeMargin,
        leverage: info?.leverage,
        server: info?.server,
        brokerName: info?.brokerName,
      });

      const rawPositions = await connection.getPositions();

      console.log('[REFRESH_RAW_POSITIONS]', {
        tradingAccountId: accountId,
        isArray: Array.isArray(rawPositions),
        type: typeof rawPositions,
        count: Array.isArray(rawPositions) ? rawPositions.length : 'N/A',
        // Log first position fields (no credentials in position data)
        first: Array.isArray(rawPositions) && rawPositions.length > 0
          ? {
              id: rawPositions[0].id,
              symbol: rawPositions[0].symbol,
              type: rawPositions[0].type,
              volume: rawPositions[0].volume,
              openPrice: rawPositions[0].openPrice,
              profit: rawPositions[0].profit,
            }
          : null,
      });

      // Guard: MetaAPI may return null / undefined / non-array on empty terminal
      const positions = normalizePositions(rawPositions);

      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const dealsResult = await connection.getDealsByTimeRange(since, new Date());

      // getDealsByTimeRange returns { deals: [] } in some SDK versions, plain array in others
      const deals = normalizeDeals(dealsResult);

      const outDeals = deals.filter((d) => isClosingDeal(d.entryType));

      console.log('[REFRESH_RAW_DEALS]', {
        tradingAccountId: accountId,
        resultType: typeof dealsResult,
        isArray: Array.isArray(dealsResult),
        hasDealsKey: dealsResult !== null && typeof dealsResult === 'object' && 'deals' in dealsResult,
        totalDeals: deals.length,
        outDeals: outDeals.length,
        firstDeal: deals.length > 0
          ? {
              id: deals[0].id,
              symbol: deals[0].symbol,
              type: deals[0].type,
              entryType: deals[0].entryType,
              volume: deals[0].volume,
              profit: deals[0].profit,
            }
          : null,
      });

      const currency: string = info?.currency ?? 'USD';
      const balance: number = info?.balance ?? 0;
      const equity: number = info?.equity ?? 0;

      // Insert snapshot
      await supabase.from('account_snapshots').insert({
        trading_account_id: accountId,
        balance,
        equity,
        floating_pnl: equity - balance,
        drawdown_percent: balance > 0 ? Math.max(0, ((balance - equity) / balance) * 100) : 0,
      });

      // Build trade rows
      const openRows = positions.map((p) => ({
        trading_account_id: accountId,
        external_trade_id: String(p.id),
        symbol: p.symbol ?? '',
        side: p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
        status: 'OPEN' as const,
        volume: p.volume ?? 0,
        open_price: p.openPrice ?? 0,
        close_price: null as null,
        profit: p.profit ?? 0,
        currency,
        opened_at: safeIso(p.openTime),
        closed_at: null as null,
      }));

      const allExtIds = [
        ...openRows.map((r) => r.external_trade_id),
        ...outDeals.map((d) => String(d.positionId ?? d.id)),
      ].filter(Boolean);

      const existingMap = new Map<string, string>();
      if (allExtIds.length > 0) {
        const { data: existing } = await supabase
          .from('trades')
          .select('id, external_trade_id')
          .eq('trading_account_id', accountId)
          .in('external_trade_id', allExtIds);
        for (const r of existing ?? []) {
          if (r.external_trade_id) existingMap.set(r.external_trade_id as string, r.id as string);
        }
      }

      console.log('[REFRESH_SYNC_PLAN]', {
        tradingAccountId: accountId,
        openRows: openRows.length,
        closedDeals: outDeals.length,
        existingInDb: existingMap.size,
      });

      let tradesUpserted = 0;

      // Insert brand-new open positions.
      const toInsert = openRows.filter((r) => !existingMap.has(r.external_trade_id));
      if (toInsert.length > 0) {
        const { data: inserted, error: insertErr } = await supabase
          .from('trades').insert(toInsert).select('id');
        if (insertErr) console.error('[REFRESH_INSERT_ERROR]', { tradingAccountId: accountId, message: insertErr.message });
        tradesUpserted += inserted?.length ?? 0;
      }

      // Update profit on already-known open positions.
      for (const r of openRows.filter((row) => existingMap.has(row.external_trade_id))) {
        await supabase.from('trades')
          .update({ profit: r.profit, status: 'OPEN', close_price: null, closed_at: null })
          .eq('trading_account_id', accountId)
          .eq('external_trade_id', r.external_trade_id);
        tradesUpserted++;
      }

      // Mark closed: deals with DEAL_ENTRY_OUT.
      for (const d of outDeals) {
        const extId = String(d.positionId ?? d.id);
        const rowId = existingMap.get(extId);
        const closedAt = safeIso(d.time);
        if (rowId) {
          await supabase.from('trades')
            .update({ status: 'CLOSED', close_price: d.price ?? null, profit: d.profit ?? 0, closed_at: closedAt })
            .eq('id', rowId);
          tradesUpserted++;
        } else {
          const { data: ins } = await supabase.from('trades').insert({
            trading_account_id: accountId,
            external_trade_id: extId,
            symbol: d.symbol ?? '',
            side: d.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL',
            status: 'CLOSED',
            volume: d.volume ?? 0,
            open_price: 0,
            close_price: d.price ?? null,
            profit: d.profit ?? 0,
            currency,
            opened_at: closedAt,
            closed_at: closedAt,
          }).select('id');
          tradesUpserted += ins?.length ?? 0;
        }
      }

      console.log('[REFRESH_SYNC_RESULT]', { tradingAccountId: accountId, tradesUpserted });

      // Update last_synced_at (keep status as-is — admin sets CONNECTED)
      await supabase
        .from('trading_accounts')
        .update({
          last_synced_at: new Date().toISOString(),
          sync_error: null,
          broker_name: info?.brokerName?.trim() || 'WSA GLOBAL',
          broker_server: info?.server?.trim() || null,
        })
        .eq('id', accountId);

      console.log('[REFRESH_SUCCESS]', { tradingAccountId: accountId, openPositions: positions.length, tradesUpserted });

      void writeAuditLog({
        actorUserId,
        action: 'ACCOUNT_SYNC_COMPLETED',
        entityType: 'trading_account',
        entityId: accountId,
        metadata: { source: 'trader-refresh', tradesUpserted, openPositions: positions.length },
      });

      return { accountId, providerAccountId: metaAccount.id, snapshotInserted: true, openPositions: positions.length, tradesUpserted, balance, equity, currency };

    } catch (error) {
      const diagnosticMessage = (error instanceof Error ? error.message : String(error)).slice(0, 400);
      const msg = publicMetaApiError(diagnosticMessage);
      console.error('[REFRESH_ERROR]', { tradingAccountId: accountId, message: diagnosticMessage });
      await supabase.from('trading_accounts').update({ sync_error: msg }).eq('id', accountId);
      return { accountId, providerAccountId: account.provider_account_id, snapshotInserted: false, openPositions: 0, tradesUpserted: 0, balance: 0, equity: 0, currency: 'USD', error: msg };

    } finally {
      if (connection) { try { await connection.close(); } catch { /* ignore */ } }
      try { api.close(); } catch { /* ignore */ }
    }
  })();

  // Do not abandon the SDK promise behind a local timeout. The abandoned
  // refresh retained its sockets and could overlap the next manual refresh.
    const result = await refreshPromise;

    if (result.snapshotInserted) {
      void evaluateAndPersistRiskEvents(accountId, actorUserId).catch((err) =>
        console.error('[REFRESH_RISK_EVAL_ERROR]', { accountId, err })
      );
    }

    return result;
  } finally {
    await lock.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: sync all accounts that have stored credentials
// ─────────────────────────────────────────────────────────────────────────────

export async function syncAllSyncableAccounts(
  actorUserId: string | null,
): Promise<SyncSummary[]> {
  const supabase = createAdminClient();
  const { data: credRows } = await supabase
    .from('broker_credentials')
    .select('trading_account_id');

  if (!credRows || credRows.length === 0) return [];

  const results: SyncSummary[] = [];
  for (const row of credRows) {
    const summary = await syncTradingAccount(row.trading_account_id, actorUserId);
    results.push(summary);
  }
  return results;
}
