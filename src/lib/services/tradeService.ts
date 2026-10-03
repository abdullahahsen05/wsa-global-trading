import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { mapTradeToDto } from '@/lib/mappers/tradeMapper'
import type { TradeDto, TradeStatus } from '@/lib/domain/types'
import { isAdmin, type UserRole } from '@/lib/auth/rbac'

export async function listTrades(params: {
  userId: string
  role: UserRole
  accountId?: string
  status?: TradeStatus
  limit?: number
}): Promise<TradeDto[]> {
  // Admin bypasses RLS to see all trades; traders see only their own via SSR client.
  const supabase = isAdmin(params.role) ? createAdminClient() : await createClient()

  let query = supabase
    .from('trades')
    .select('id, short_trade_id, trading_account_id, external_trade_id, symbol, side, status, volume, open_price, close_price, profit, currency, opened_at, closed_at')
    .order('opened_at', { ascending: false })
    .limit(params.limit ?? 200)

  let scopedAccountIds: string[] | null = params.accountId ? [params.accountId] : null

  if (params.accountId) {
    query = query.eq('trading_account_id', params.accountId)
  }
  if (params.status) {
    query = query.eq('status', params.status)
  }

  // If trader, limit to their own accounts
  if (!isAdmin(params.role)) {
    // Get user's account IDs first
    const { data: userAccounts } = await supabase
      .from('trading_accounts')
      .select('id')
      .eq('user_id', params.userId)

    const accountIds = (userAccounts ?? []).map(a => a.id)
    if (accountIds.length === 0) return []

    scopedAccountIds = params.accountId
      ? accountIds.filter((id) => id === params.accountId)
      : accountIds
    if (scopedAccountIds.length === 0) return []

    query = query.in('trading_account_id', scopedAccountIds)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to fetch trades: ${error.message}`)

  const tradeRows = data ?? []
  const accountIds = scopedAccountIds ?? [...new Set(tradeRows.map((trade) => trade.trading_account_id))]
  const copyDb = createAdminClient()

  // A successful copy is durable before broker-history synchronization finishes.
  // Merge the copy ledger into this view so the trader sees the position at once;
  // the synchronized broker row replaces the fallback once it is available.
  let copyLinkQuery = copyDb
    .from('copy_trade_links')
    .select('id, strategy_id, source_event_id, follower_account_id, follower_position_id, follower_order_id, master_trade_id, symbol, side, copied_volume, status, opened_at, closed_at')
    .in('status', params.status ? [params.status] : ['OPEN', 'CLOSED'])
    .order('created_at', { ascending: false })
    .limit(params.limit ?? 200)

  if (accountIds.length > 0) {
    copyLinkQuery = copyLinkQuery.in('follower_account_id', accountIds)
  } else if (params.accountId) {
    copyLinkQuery = copyLinkQuery.eq('follower_account_id', params.accountId)
  } else if (!isAdmin(params.role)) {
    return tradeRows.map(mapTradeToDto)
  }

  const { data: copyLinks, error: copyLinksError } = await copyLinkQuery
  if (copyLinksError) throw new Error(`Failed to fetch copied trades: ${copyLinksError.message}`)
  if (!copyLinks?.length) return tradeRows.map(mapTradeToDto)

  const strategyIds = [...new Set(copyLinks.map((link) => link.strategy_id))]
  const eventIds = [...new Set(copyLinks.map((link) => link.source_event_id))]
  const masterTradeIds = [...new Set(copyLinks.map((link) => link.master_trade_id))]
  const copyAccountIds = [...new Set(copyLinks.map((link) => link.follower_account_id))]
  const [{ data: strategies }, { data: events }, { data: closeEvents }, { data: accounts }] = await Promise.all([
    copyDb.from('copy_strategies').select('id, name').in('id', strategyIds),
    copyDb.from('copy_master_events').select('id, open_price, close_price, event_time').in('id', eventIds),
    copyDb
      .from('copy_master_events')
      .select('strategy_id, master_trade_id, close_price, event_time')
      .in('strategy_id', strategyIds)
      .in('master_trade_id', masterTradeIds)
      .eq('event_type', 'CLOSE')
      .order('event_time', { ascending: false }),
    copyDb.from('trading_accounts').select('id, currency').in('id', copyAccountIds),
  ])

  const strategyNameById = new Map((strategies ?? []).map((strategy) => [strategy.id, strategy.name]))
  const eventById = new Map((events ?? []).map((event) => [event.id, event]))
  const closeEventByTrade = new Map<string, NonNullable<typeof closeEvents>[number]>()
  for (const event of closeEvents ?? []) {
    const key = `${event.strategy_id}:${event.master_trade_id}`
    if (!closeEventByTrade.has(key)) closeEventByTrade.set(key, event)
  }
  const currencyByAccountId = new Map((accounts ?? []).map((account) => [account.id, account.currency ?? 'USD']))
  const copyLinkByBrokerId = new Map<string, (typeof copyLinks)[number]>()

  for (const link of copyLinks) {
    if (link.follower_position_id) {
      copyLinkByBrokerId.set(`${link.follower_account_id}:${link.follower_position_id}`, link)
    }
    if (link.follower_order_id) {
      copyLinkByBrokerId.set(`${link.follower_account_id}:${link.follower_order_id}`, link)
    }
  }

  const matchedCopyLinkIds = new Set<string>()
  const mappedTrades = tradeRows.map((row) => {
    const link = row.external_trade_id
      ? copyLinkByBrokerId.get(`${row.trading_account_id}:${row.external_trade_id}`)
      : undefined
    if (link) matchedCopyLinkIds.add(link.id)
    return {
      ...mapTradeToDto(row),
      copyStrategyName: link ? strategyNameById.get(link.strategy_id) ?? 'Copy strategy' : null,
    }
  })

  const copyFallbackTrades: TradeDto[] = copyLinks
    .filter((link) => !matchedCopyLinkIds.has(link.id))
    .map((link) => {
      const sourceEvent = eventById.get(link.source_event_id)
      const closeEvent = closeEventByTrade.get(`${link.strategy_id}:${link.master_trade_id}`)
      return {
        id: `copy-${link.id}`,
        shortTradeId: `COPY-${link.id.replaceAll('-', '').slice(0, 8).toUpperCase()}`,
        accountId: link.follower_account_id,
        symbol: link.symbol,
        side: link.side === 'SELL' ? 'SELL' : 'BUY',
        status: link.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
        volume: Number(link.copied_volume),
        openPrice: Number(sourceEvent?.open_price ?? 0),
        closePrice: link.status === 'CLOSED' && closeEvent?.close_price != null
          ? Number(closeEvent.close_price)
          : null,
        profit: { amount: 0, currency: currencyByAccountId.get(link.follower_account_id) ?? 'USD' },
        openedAt: link.opened_at ?? sourceEvent?.event_time ?? new Date(0).toISOString(),
        closedAt: link.closed_at ?? closeEvent?.event_time ?? null,
        copyStrategyName: strategyNameById.get(link.strategy_id) ?? 'Copy strategy',
        copySyncPending: true,
      }
    })

  return [...mappedTrades, ...copyFallbackTrades]
    .sort((a, b) => new Date(b.closedAt ?? b.openedAt).getTime() - new Date(a.closedAt ?? a.openedAt).getTime())
    .slice(0, params.limit ?? 200)
}

export async function getDailyPnl(
  userId: string,
  accountId?: string,
): Promise<{ dailyPnl: number; currency: string }> {
  const supabase = createAdminClient()

  let accountQuery = supabase
    .from('trading_accounts')
    .select('id')
    .eq('user_id', userId)

  if (accountId) {
    accountQuery = accountQuery.eq('id', accountId)
  }

  const { data: accounts } = await accountQuery

  if (!accounts || accounts.length === 0) {
    return { dailyPnl: 0, currency: 'USD' }
  }

  const accountIds = accounts.map((a) => a.id)
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const { data: trades } = await supabase
    .from('trades')
    .select('profit, currency')
    .in('trading_account_id', accountIds)
    .eq('status', 'CLOSED')
    .gte('closed_at', todayStart.toISOString())

  const dailyPnl = (trades ?? []).reduce((sum, t) => sum + Number(t.profit), 0)
  const currency = trades?.[0]?.currency ?? 'USD'
  return { dailyPnl, currency }
}
