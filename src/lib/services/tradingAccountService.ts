import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { mapAccountToDto } from '@/lib/mappers/accountMapper'
import type { TraderAccountSummary } from '@/lib/domain/types'
import { isAdmin, type UserRole } from '@/lib/auth/rbac'

export async function listTradingAccounts(userId: string, role: UserRole): Promise<TraderAccountSummary[]> {
  const supabase = isAdmin(role) ? createAdminClient() : await createClient()

  let query = supabase
    .from('trading_accounts')
    .select('id, account_name, broker_name, broker_server, broker_platform, status, currency, updated_at, user_id')
    .order('created_at', { ascending: false })
    .limit(500)

  if (!isAdmin(role)) {
    query = query.eq('user_id', userId)
  }

  const { data: accounts, error } = await query
  if (error) throw new Error(`Failed to fetch trading accounts: ${error.message}`)

  const accountIds = (accounts ?? []).map(a => a.id)
  if (accountIds.length === 0) return []

  // Batch: 2 parallel view queries instead of 2N sequential queries
  const [
    { data: snapshots, error: snapshotError },
    { data: counts, error: countError },
  ] = await Promise.all([
    supabase
      .from('latest_account_snapshots')
      .select('trading_account_id, balance, equity, floating_pnl, drawdown_percent, captured_at')
      .in('trading_account_id', accountIds),
    supabase
      .from('account_open_trade_counts')
      .select('trading_account_id, open_trade_count')
      .in('trading_account_id', accountIds),
  ])

  if (snapshotError) throw new Error(`Failed to fetch latest account snapshots: ${snapshotError.message}`)
  if (countError) throw new Error(`Failed to fetch open trade counts: ${countError.message}`)

  const snapshotMap = new Map(
    (snapshots ?? []).map(s => [s.trading_account_id, s])
  )
  const countMap = new Map(
    (counts ?? []).map(c => [c.trading_account_id, c.open_trade_count as number])
  )

  return (accounts ?? []).map(account =>
    mapAccountToDto(
      account,
      snapshotMap.get(account.id) ?? null,
      countMap.get(account.id) ?? 0,
    )
  )
}

export async function getTradingAccount(
  accountId: string,
  userId: string,
  role: UserRole
): Promise<TraderAccountSummary | null> {
  const supabase = isAdmin(role) ? createAdminClient() : await createClient()

  let query = supabase
    .from('trading_accounts')
    .select('id, account_name, broker_name, broker_server, broker_platform, status, currency, updated_at, user_id')
    .eq('id', accountId)

  if (!isAdmin(role)) {
    query = query.eq('user_id', userId)
  }

  const { data, error } = await query.single()
  if (error || !data) return null

  const [
    { data: snapshots, error: snapshotError },
    { data: counts, error: countError },
  ] = await Promise.all([
    supabase
      .from('latest_account_snapshots')
      .select('trading_account_id, balance, equity, floating_pnl, drawdown_percent, captured_at')
      .eq('trading_account_id', accountId),
    supabase
      .from('account_open_trade_counts')
      .select('trading_account_id, open_trade_count')
      .eq('trading_account_id', accountId),
  ])

  if (snapshotError) throw new Error(`Failed to fetch latest account snapshots: ${snapshotError.message}`)
  if (countError) throw new Error(`Failed to fetch open trade counts: ${countError.message}`)

  const snapshot = snapshots?.[0] ?? null
  const openTradeCount = counts?.[0]?.open_trade_count ?? 0

  return mapAccountToDto(data, snapshot, openTradeCount)
}

export async function createTradingAccount(userId: string, data: {
  accountName: string
  brokerName: string
  brokerAccountId?: string
  currency?: string
}): Promise<TraderAccountSummary> {
  const supabase = await createClient()

  const { data: account, error } = await supabase
    .from('trading_accounts')
    .insert({
      user_id: userId,
      account_name: data.accountName,
      broker_name: data.brokerName,
      broker_account_id: data.brokerAccountId ?? null,
      currency: data.currency ?? 'USD',
      status: 'PENDING',
    })
    .select('id, account_name, broker_name, broker_server, broker_platform, status, currency, updated_at, user_id')
    .single()

  if (error || !account) throw new Error(`Failed to create account: ${error?.message}`)

  return mapAccountToDto(account, null, 0)
}
