import { createAdminClient } from '@/lib/supabase/admin'
import type {
  AdminSummaryDto,
  AdminTradingAccountSummary,
  AdminUserDirectoryDto,
  AdminUserDirectoryItemDto,
  UserRole,
} from '@/lib/domain/types'
import { mapAccountToDto } from '@/lib/mappers/accountMapper'

export async function getAdminSummary(): Promise<AdminSummaryDto> {
  const supabase = createAdminClient()

  const [
    { count: activeTraders },
    { count: connectedAccounts },
    { count: openRiskEvents },
  ] = await Promise.all([
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'TRADER')
      .eq('status', 'ACTIVE'),
    supabase
      .from('trading_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'CONNECTED'),
    supabase
      .from('risk_events')
      .select('id', { count: 'exact', head: true })
      .is('acknowledged_at', null),
  ])

  const { data: activeSubscriptions, error: subscriptionError } = await supabase
    .from('subscriptions')
    .select('billing_products(amount, currency, billing_interval)')
    .eq('status', 'ACTIVE')
  if (subscriptionError) throw new Error(`Failed to calculate MRR: ${subscriptionError.message}`)

  const recurringProducts = (activeSubscriptions ?? [])
    .map((subscription) => {
      const relation = subscription.billing_products
      return Array.isArray(relation) ? relation[0] : relation
    })
    .filter((product) => product?.billing_interval === 'MONTHLY')
  const recurringCurrencies = [...new Set(recurringProducts.map((product) => product?.currency).filter(Boolean))]
  const monthlyRecurringRevenue = recurringCurrencies.length > 1
    ? { amount: 0, currency: 'USD' }
    : {
        amount: Number(recurringProducts.reduce((sum, product) => sum + Number(product?.amount ?? 0), 0).toFixed(2)),
        currency: recurringCurrencies[0] ?? 'USD',
      }

  return {
    activeTraders: activeTraders ?? 0,
    connectedAccounts: connectedAccounts ?? 0,
    openRiskEvents: openRiskEvents ?? 0,
    monthlyRecurringRevenue,
  }
}

type UserDirectoryOptions = {
  page?: number
  pageSize?: number
  search?: string
  role?: UserRole | 'ALL'
  status?: 'ACTIVE' | 'SUSPENDED' | 'PENDING' | 'ALL'
  sort?: 'NEWEST' | 'OLDEST' | 'NAME'
}

type UserDirectoryRow = {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING'
  created_at: string
  trader_profiles?: { partner_id: string | null } | { partner_id: string | null }[] | null
}

function safeSearchTerm(value: string): string {
  return value.trim().replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').slice(0, 120)
}

function extractPartnerId(
  relation: UserDirectoryRow['trader_profiles'],
): string | null {
  if (!relation) return null
  if (Array.isArray(relation)) return relation[0]?.partner_id ?? null
  return relation.partner_id ?? null
}

export async function listUsers(
  options: UserDirectoryOptions = {},
): Promise<AdminUserDirectoryDto> {
  const supabase = createAdminClient()
  const page = Math.max(1, Math.trunc(options.page ?? 1))
  const pageSize = Math.min(100, Math.max(10, Math.trunc(options.pageSize ?? 25)))
  const search = safeSearchTerm(options.search ?? '')
  const role = options.role ?? 'ALL'
  const status = options.status ?? 'ALL'
  const sort = options.sort ?? 'NEWEST'

  let query = supabase
    .from('profiles')
    .select(
      'id, email, full_name, role, status, created_at, trader_profiles!user_id(partner_id)',
      { count: 'exact' },
    )

  if (search) {
    query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`)
  }
  if (role !== 'ALL') query = query.eq('role', role)
  if (status !== 'ALL') query = query.eq('status', status)

  if (sort === 'NAME') {
    query = query.order('full_name', { ascending: true, nullsFirst: false })
  } else {
    query = query.order('created_at', { ascending: sort === 'OLDEST' })
  }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const [
    { data, error, count },
    totalResult,
    traderResult,
    adminResult,
    partnerResult,
    pendingResult,
    suspendedResult,
  ] = await Promise.all([
    query.range(from, to),
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'TRADER'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).in('role', ['ADMIN', 'SUPER_ADMIN']),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'PARTNER'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'PENDING'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'SUSPENDED'),
  ])

  if (error) throw new Error(`Failed to fetch users: ${error.message}`)
  const rows = (data ?? []) as unknown as UserDirectoryRow[]
  const items: AdminUserDirectoryItemDto[] = rows.map((row) => ({
    id: row.id,
    name: row.full_name?.trim() || row.email,
    email: row.email,
    role: row.role,
    status: row.status,
    partnerId: extractPartnerId(row.trader_profiles),
    joinedAt: row.created_at,
  }))
  const total = count ?? 0

  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
    counts: {
      total: totalResult.count ?? 0,
      traders: traderResult.count ?? 0,
      admins: adminResult.count ?? 0,
      partners: partnerResult.count ?? 0,
      pending: pendingResult.count ?? 0,
      suspended: suspendedResult.count ?? 0,
    },
  }
}

export async function updateUserStatus(userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'PENDING') {
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('profiles')
    .update({ status })
    .eq('id', userId)

  if (error) throw new Error(`Failed to update user status: ${error.message}`)
}

export async function listAllAccounts(): Promise<AdminTradingAccountSummary[]> {
  const supabase = createAdminClient()

  const { data: accounts, error } = await supabase
    .from('trading_accounts')
    .select('id, account_name, broker_name, broker_server, broker_platform, status, currency, updated_at, user_id')
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) throw new Error(`Failed to fetch accounts: ${error.message}`)

  const accountIds = (accounts ?? []).map(account => account.id)
  const traderIds = [...new Set((accounts ?? []).map(account => account.user_id))]
  if (accountIds.length === 0) return []

  const [
    { data: snapshots, error: snapshotError },
    { data: counts, error: countError },
    { data: profiles, error: profileError },
  ] = await Promise.all([
    supabase
      .from('latest_account_snapshots')
      .select('trading_account_id, balance, equity, floating_pnl, drawdown_percent')
      .in('trading_account_id', accountIds),
    supabase
      .from('account_open_trade_counts')
      .select('trading_account_id, open_trade_count')
      .in('trading_account_id', accountIds),
    supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', traderIds),
  ])

  if (snapshotError) throw new Error(`Failed to fetch latest account snapshots: ${snapshotError.message}`)
  if (countError) throw new Error(`Failed to fetch open trade counts: ${countError.message}`)
  if (profileError) throw new Error(`Failed to fetch account owners: ${profileError.message}`)

  const snapshotMap = new Map(
    (snapshots ?? []).map(snapshot => [snapshot.trading_account_id, snapshot])
  )
  const countMap = new Map(
    (counts ?? []).map(count => [count.trading_account_id, count.open_trade_count as number])
  )
  const profileMap = new Map(
    (profiles ?? []).map(profile => [profile.id, profile])
  )

  return accounts.map(account => {
    const profile = profileMap.get(account.user_id)
    const traderEmail = profile?.email?.trim() ?? ''

    return {
      ...mapAccountToDto(
        account,
        snapshotMap.get(account.id) ?? null,
        countMap.get(account.id) ?? 0,
      ),
      traderId: account.user_id,
      traderName: profile?.full_name?.trim() || traderEmail || 'Unnamed trader',
      traderEmail,
    }
  })
}

export async function listAuditLogs() {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('audit_logs')
    .select('id, actor_user_id, action, entity_type, entity_id, metadata, created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) throw new Error(`Failed to fetch audit logs: ${error.message}`)
  return data ?? []
}

// Backwards-compatible alias used by existing API routes
export { listUsers as listAdminUsers }
