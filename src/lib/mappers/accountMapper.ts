import type { TraderAccountSummary } from '@/lib/domain/types'
import {
  latestAccountActivityAt,
  resolveAccountLifecycleStatus,
} from '@/lib/accounts/lifecycle'

interface AccountRow {
  id: string
  account_name: string
  broker_name: string
  broker_server?: string | null
  broker_platform?: string | null
  status: string
  currency: string
  updated_at: string
  last_synced_at?: string | null
}

interface SnapshotRow {
  balance: number
  equity: number
  floating_pnl: number
  drawdown_percent: number
  captured_at?: string
}

export function mapAccountToDto(
  account: AccountRow,
  snapshot: SnapshotRow | null,
  openTradeCount: number
): TraderAccountSummary {
  const currency = account.currency ?? 'USD'
  const balance = snapshot ? Number(snapshot.balance) : 0
  const equity = snapshot ? Number(snapshot.equity) : 0
  const floatingPnl = snapshot ? Number(snapshot.floating_pnl) : 0
  const drawdown = snapshot ? Number(snapshot.drawdown_percent) : 0
  const platform = account.broker_platform === 'MT4' || account.broker_platform === 'MT5'
    ? account.broker_platform
    : null
  const lastSyncedAt = latestAccountActivityAt(
    account.last_synced_at,
    snapshot?.captured_at,
  )
  const status = resolveAccountLifecycleStatus({
    status: account.status as TraderAccountSummary['status'],
    lastSyncedAt: account.last_synced_at,
    snapshotCapturedAt: snapshot?.captured_at,
    serverName: account.broker_server,
    platform,
  })

  return {
    accountId: account.id,
    accountName: account.account_name,
    brokerName: account.broker_name?.trim() || 'WSA GLOBAL',
    serverName: account.broker_server ?? null,
    platform,
    status,
    balance: { amount: balance, currency },
    equity: { amount: equity, currency },
    floatingPnl: { amount: floatingPnl, currency },
    openTradeCount,
    drawdownPercent: drawdown,
    updatedAt: lastSyncedAt ?? account.updated_at,
    lastSyncedAt,
    live: status === 'CONNECTED',
    reconnectRequired: status === 'INACTIVE' || status === 'DISCONNECTED',
  }
}
