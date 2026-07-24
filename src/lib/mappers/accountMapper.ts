import type { TraderAccountSummary } from '@/lib/domain/types'

interface AccountRow {
  id: string
  account_name: string
  broker_name: string
  broker_server?: string | null
  broker_platform?: string | null
  status: string
  currency: string
  updated_at: string
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

  return {
    accountId: account.id,
    accountName: account.account_name,
    brokerName: account.broker_name?.trim() || 'WSA GLOBAL',
    serverName: account.broker_server ?? null,
    platform: account.broker_platform === 'MT4' || account.broker_platform === 'MT5'
      ? account.broker_platform
      : null,
    status: account.status as TraderAccountSummary['status'],
    balance: { amount: balance, currency },
    equity: { amount: equity, currency },
    floatingPnl: { amount: floatingPnl, currency },
    openTradeCount,
    drawdownPercent: drawdown,
    updatedAt: snapshot?.captured_at ?? account.updated_at,
  }
}
