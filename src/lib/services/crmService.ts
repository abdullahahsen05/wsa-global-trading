import { createAdminClient } from '@/lib/supabase/admin'
import { mapCrmNoteToDto, mapTraderProfileToDto } from '@/lib/mappers/crmMapper'
import type {
  AccountStatus,
  CrmNoteDto,
  RiskSeverity,
  TraderCrmAccountDto,
  TraderCrmDirectoryDto,
  TraderCrmItemDto,
  TraderProfileDto,
} from '@/lib/domain/types'

type TraderProfileMapperRow = Parameters<typeof mapTraderProfileToDto>[0]

export async function listTraderProfiles(): Promise<TraderProfileDto[]> {
  // Use admin client to bypass RLS — this function is only called from
  // admin API routes that already gate access via requireAdmin().
  const supabase = createAdminClient()

  // trading_accounts.user_id → profiles.id, not trader_profiles.id.
  // Traverse: trader_profiles → profiles → trading_accounts.
  const { data, error } = await supabase
    .from('trader_profiles')
    .select(`
      id,
      user_id,
      segment,
      profiles!user_id(
        full_name,
        email,
        created_at,
        trading_accounts(
          id,
          currency,
          updated_at,
          last_synced_at,
          account_snapshots(equity, captured_at)
        )
      )
    `)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Failed to fetch trader profiles: ${error.message}`)

  return (data ?? []).map((row) => mapTraderProfileToDto(row as unknown as TraderProfileMapperRow))
}

type TraderCrmOptions = {
  page?: number
  pageSize?: number
  search?: string
  segment?: 'ALL' | 'EVALUATION' | 'FUNDED' | 'AT_RISK' | 'VIP'
  profileStatus?: 'ALL' | 'ACTIVE' | 'SUSPENDED' | 'PENDING'
  partnerId?: string
  sort?: 'NEWEST' | 'OLDEST'
}

type TraderProfileDirectoryRow = {
  id: string
  user_id: string
  segment: TraderCrmItemDto['segment']
  partner_id: string | null
  created_at: string
  profiles:
    | {
        full_name: string | null
        email: string
        status: TraderCrmItemDto['profileStatus']
        created_at: string
      }
    | {
        full_name: string | null
        email: string
        status: TraderCrmItemDto['profileStatus']
        created_at: string
      }[]
}

type AccountDirectoryRow = {
  id: string
  user_id: string
  account_name: string
  broker_name: string
  broker_account_id: string | null
  status: AccountStatus
  currency: string
  updated_at: string
  last_synced_at: string | null
}

type SnapshotRow = {
  trading_account_id: string
  equity: number | string
  floating_pnl: number | string
}

type RiskEventRow = {
  trading_account_id: string
  severity: RiskSeverity
}

type EvaluationRow = {
  user_id: string
  status: string
  updated_at: string
}

type SubscriptionRow = {
  user_id: string
  status: string
  current_period_end: string | null
  created_at: string
  billing_products: { name: string } | { name: string }[] | null
}

function safeDirectorySearch(value: string): string {
  return value.trim().replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').slice(0, 120)
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? value[0] ?? null : value
}

function newestIso(values: Array<string | null | undefined>): string | null {
  const timestamps = values.filter(Boolean) as string[]
  if (timestamps.length === 0) return null
  return timestamps.reduce((latest, value) =>
    new Date(value).getTime() > new Date(latest).getTime() ? value : latest,
  )
}

function severityRank(severity: RiskSeverity): number {
  if (severity === 'CRITICAL') return 3
  if (severity === 'WARNING') return 2
  return 1
}

export async function listTraderCrmDirectory(
  options: TraderCrmOptions = {},
): Promise<TraderCrmDirectoryDto> {
  const supabase = createAdminClient()
  const page = Math.max(1, Math.trunc(options.page ?? 1))
  const pageSize = Math.min(100, Math.max(10, Math.trunc(options.pageSize ?? 25)))
  const search = safeDirectorySearch(options.search ?? '')
  const segment = options.segment ?? 'ALL'
  const profileStatus = options.profileStatus ?? 'ALL'
  const sort = options.sort ?? 'NEWEST'

  let matchingUserIds: string[] | null = null
  if (search) {
    const [profilesResult, accountsResult] = await Promise.all([
      supabase
        .from('profiles')
        .select('id')
        .eq('role', 'TRADER')
        .or(`full_name.ilike.%${search}%,email.ilike.%${search}%`)
        .limit(1000),
      supabase
        .from('trading_accounts')
        .select('user_id')
        .or(
          `account_name.ilike.%${search}%,broker_name.ilike.%${search}%,broker_account_id.ilike.%${search}%`,
        )
        .limit(1000),
    ])

    if (profilesResult.error) {
      throw new Error(`Failed to search trader profiles: ${profilesResult.error.message}`)
    }
    if (accountsResult.error) {
      throw new Error(`Failed to search trader accounts: ${accountsResult.error.message}`)
    }

    matchingUserIds = Array.from(new Set([
      ...(profilesResult.data ?? []).map((row) => row.id),
      ...(accountsResult.data ?? []).map((row) => row.user_id),
    ]))
  }

  const [
    totalResult,
    fundedResult,
    evaluationResult,
    atRiskResult,
    vipResult,
    openRiskResult,
    activeSubscriptionsResult,
  ] = await Promise.all([
    supabase.from('trader_profiles').select('id', { count: 'exact', head: true }),
    supabase.from('trader_profiles').select('id', { count: 'exact', head: true }).eq('segment', 'FUNDED'),
    supabase.from('trader_profiles').select('id', { count: 'exact', head: true }).eq('segment', 'EVALUATION'),
    supabase.from('trader_profiles').select('id', { count: 'exact', head: true }).eq('segment', 'AT_RISK'),
    supabase.from('trader_profiles').select('id', { count: 'exact', head: true }).eq('segment', 'VIP'),
    supabase.from('risk_events').select('id', { count: 'exact', head: true }).is('acknowledged_at', null),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
  ])

  const counts = {
    total: totalResult.count ?? 0,
    funded: fundedResult.count ?? 0,
    evaluation: evaluationResult.count ?? 0,
    atRisk: atRiskResult.count ?? 0,
    vip: vipResult.count ?? 0,
    openRiskEvents: openRiskResult.count ?? 0,
    activeSubscriptions: activeSubscriptionsResult.count ?? 0,
  }

  if (matchingUserIds?.length === 0) {
    return {
      items: [],
      pagination: { page, pageSize, total: 0, totalPages: 1 },
      counts,
    }
  }

  let profileQuery = supabase
    .from('trader_profiles')
    .select(
      'id, user_id, segment, partner_id, created_at, profiles!user_id!inner(full_name, email, status, created_at)',
      { count: 'exact' },
    )

  if (matchingUserIds) profileQuery = profileQuery.in('user_id', matchingUserIds)
  if (segment !== 'ALL') profileQuery = profileQuery.eq('segment', segment)
  if (profileStatus !== 'ALL') profileQuery = profileQuery.eq('profiles.status', profileStatus)
  if (options.partnerId) profileQuery = profileQuery.eq('partner_id', options.partnerId)

  const from = (page - 1) * pageSize
  const { data, error, count } = await profileQuery
    .order('created_at', { ascending: sort === 'OLDEST' })
    .range(from, from + pageSize - 1)

  if (error) throw new Error(`Failed to fetch CRM directory: ${error.message}`)

  const profiles = (data ?? []) as unknown as TraderProfileDirectoryRow[]
  const userIds = profiles.map((row) => row.user_id)
  const traderProfileIds = profiles.map((row) => row.id)
  const partnerIds = Array.from(
    new Set(profiles.map((row) => row.partner_id).filter(Boolean) as string[]),
  )

  const [accountsResult, evaluationsResult, subscriptionsResult, notesResult, partnersResult] =
    await Promise.all([
      userIds.length
        ? supabase
            .from('trading_accounts')
            .select(
              'id, user_id, account_name, broker_name, broker_account_id, status, currency, updated_at, last_synced_at',
            )
            .in('user_id', userIds)
        : { data: [], error: null },
      userIds.length
        ? supabase
            .from('evaluation_attempts')
            .select('user_id, status, updated_at')
            .in('user_id', userIds)
            .order('updated_at', { ascending: false })
        : { data: [], error: null },
      userIds.length
        ? supabase
            .from('subscriptions')
            .select('user_id, status, current_period_end, created_at, billing_products(name)')
            .in('user_id', userIds)
            .order('created_at', { ascending: false })
        : { data: [], error: null },
      traderProfileIds.length
        ? supabase
            .from('crm_notes')
            .select('id, trader_profile_id')
            .in('trader_profile_id', traderProfileIds)
        : { data: [], error: null },
      partnerIds.length
        ? supabase.from('profiles').select('id, full_name, email').in('id', partnerIds)
        : { data: [], error: null },
    ])

  if (accountsResult.error) throw new Error(`Failed to fetch trader accounts: ${accountsResult.error.message}`)
  if (evaluationsResult.error) throw new Error(`Failed to fetch evaluations: ${evaluationsResult.error.message}`)
  if (subscriptionsResult.error) throw new Error(`Failed to fetch subscriptions: ${subscriptionsResult.error.message}`)
  if (notesResult.error) throw new Error(`Failed to fetch CRM note counts: ${notesResult.error.message}`)
  if (partnersResult.error) throw new Error(`Failed to fetch assigned partners: ${partnersResult.error.message}`)

  const accounts = (accountsResult.data ?? []) as unknown as AccountDirectoryRow[]
  const accountIds = accounts.map((account) => account.id)
  const [snapshotsResult, riskResult] = await Promise.all([
    accountIds.length
      ? supabase
          .from('latest_account_snapshots')
          .select('trading_account_id, equity, floating_pnl')
          .in('trading_account_id', accountIds)
      : { data: [], error: null },
    accountIds.length
      ? supabase
          .from('risk_events')
          .select('trading_account_id, severity')
          .in('trading_account_id', accountIds)
          .is('acknowledged_at', null)
      : { data: [], error: null },
  ])

  if (snapshotsResult.error) throw new Error(`Failed to fetch account equity: ${snapshotsResult.error.message}`)
  if (riskResult.error) throw new Error(`Failed to fetch risk events: ${riskResult.error.message}`)

  const snapshotByAccount = new Map(
    ((snapshotsResult.data ?? []) as unknown as SnapshotRow[]).map((row) => [
      row.trading_account_id,
      row,
    ]),
  )
  const riskByAccount = new Map<string, RiskEventRow[]>()
  for (const event of (riskResult.data ?? []) as unknown as RiskEventRow[]) {
    riskByAccount.set(event.trading_account_id, [
      ...(riskByAccount.get(event.trading_account_id) ?? []),
      event,
    ])
  }

  const accountsByUser = new Map<string, AccountDirectoryRow[]>()
  for (const account of accounts) {
    accountsByUser.set(account.user_id, [...(accountsByUser.get(account.user_id) ?? []), account])
  }

  const latestEvaluationByUser = new Map<string, EvaluationRow>()
  for (const evaluation of (evaluationsResult.data ?? []) as unknown as EvaluationRow[]) {
    if (!latestEvaluationByUser.has(evaluation.user_id)) {
      latestEvaluationByUser.set(evaluation.user_id, evaluation)
    }
  }

  const subscriptionByUser = new Map<string, SubscriptionRow>()
  for (const subscription of (subscriptionsResult.data ?? []) as unknown as SubscriptionRow[]) {
    const existing = subscriptionByUser.get(subscription.user_id)
    if (!existing || (subscription.status === 'ACTIVE' && existing.status !== 'ACTIVE')) {
      subscriptionByUser.set(subscription.user_id, subscription)
    }
  }

  const noteCountByProfile = new Map<string, number>()
  for (const note of (notesResult.data ?? []) as { trader_profile_id: string }[]) {
    noteCountByProfile.set(
      note.trader_profile_id,
      (noteCountByProfile.get(note.trader_profile_id) ?? 0) + 1,
    )
  }

  const partnerById = new Map(
    ((partnersResult.data ?? []) as { id: string; full_name: string | null; email: string }[]).map(
      (partner) => [partner.id, partner],
    ),
  )

  const items: TraderCrmItemDto[] = profiles.map((profileRow) => {
    const profile = one(profileRow.profiles)
    const userAccounts = accountsByUser.get(profileRow.user_id) ?? []
    const accountDtos: TraderCrmAccountDto[] = userAccounts.map((account) => {
      const snapshot = snapshotByAccount.get(account.id)
      return {
        id: account.id,
        name: account.account_name,
        brokerName: account.broker_name,
        brokerAccountId: account.broker_account_id,
        status: account.status,
        currency: account.currency,
        equity: snapshot === undefined
          ? null
          : { amount: Number(snapshot.equity), currency: account.currency },
        floatingPnl: snapshot === undefined
          ? null
          : { amount: Number(snapshot.floating_pnl), currency: account.currency },
        lastSyncedAt: account.last_synced_at,
      }
    })
    const accountsWithEquity = accountDtos.filter((account) => account.equity)
    const currencies = Array.from(new Set(accountsWithEquity.map((account) => account.currency)))
    const totalEquity =
      accountDtos.length > 0 &&
      accountsWithEquity.length === accountDtos.length &&
      currencies.length === 1
        ? {
            amount: accountDtos.reduce((sum, account) => sum + (account.equity?.amount ?? 0), 0),
            currency: currencies[0],
          }
        : null
    const floatingPnl =
      totalEquity && accountDtos.every((account) => account.floatingPnl)
        ? {
            amount: accountDtos.reduce(
              (sum, account) => sum + (account.floatingPnl?.amount ?? 0),
              0,
            ),
            currency: totalEquity.currency,
          }
        : null
    const riskEvents = userAccounts.flatMap((account) => riskByAccount.get(account.id) ?? [])
    const highestRiskSeverity =
      riskEvents.length === 0
        ? null
        : riskEvents.reduce((highest, event) =>
            severityRank(event.severity) > severityRank(highest) ? event.severity : highest,
          riskEvents[0].severity)
    const subscription = subscriptionByUser.get(profileRow.user_id)
    const product = subscription ? one(subscription.billing_products) : null
    const partnerRow = profileRow.partner_id ? partnerById.get(profileRow.partner_id) : null

    return {
      traderId: profileRow.id,
      userId: profileRow.user_id,
      name: profile?.full_name?.trim() || profile?.email || 'Unnamed trader',
      email: profile?.email ?? '',
      profileStatus: profile?.status ?? 'PENDING',
      segment: profileRow.segment,
      joinedAt: profile?.created_at ?? profileRow.created_at,
      partner: partnerRow
        ? {
            id: partnerRow.id,
            name: partnerRow.full_name?.trim() || partnerRow.email,
            email: partnerRow.email,
          }
        : null,
      accounts: accountDtos,
      connectedAccountCount: accountDtos.filter((account) => account.status === 'CONNECTED').length,
      totalEquity,
      floatingPnl,
      openRiskEventCount: riskEvents.length,
      highestRiskSeverity,
      evaluationStatus: latestEvaluationByUser.get(profileRow.user_id)?.status ?? null,
      subscription: subscription
        ? {
            name: product?.name ?? 'Product unavailable',
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
          }
        : null,
      noteCount: noteCountByProfile.get(profileRow.id) ?? 0,
      lastActivityAt: newestIso(
        userAccounts.flatMap((account) => [account.last_synced_at, account.updated_at]),
      ),
    }
  })
  const total = count ?? 0

  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
    counts,
  }
}

export async function listCrmNotes(traderId?: string): Promise<CrmNoteDto[]> {
  // Use admin client to bypass RLS — only called from admin-gated routes.
  const supabase = createAdminClient()

  let query = supabase
    .from('crm_notes')
    .select('id, trader_profile_id, author_name, note, created_at')
    .order('created_at', { ascending: false })

  if (traderId) {
    query = query.eq('trader_profile_id', traderId)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to fetch CRM notes: ${error.message}`)

  return (data ?? []).map(mapCrmNoteToDto)
}

export async function createCrmNote(data: {
  traderId: string
  authorName: string
  note: string
  authorUserId?: string
}): Promise<CrmNoteDto> {
  // Use admin client — called from admin-gated POST /api/crm/notes.
  const supabase = createAdminClient()

  const { data: note, error } = await supabase
    .from('crm_notes')
    .insert({
      trader_profile_id: data.traderId,
      author_user_id: data.authorUserId ?? null,
      author_name: data.authorName,
      note: data.note,
    })
    .select('id, trader_profile_id, author_name, note, created_at')
    .single()

  if (error || !note) throw new Error(`Failed to create CRM note: ${error?.message}`)
  return mapCrmNoteToDto(note)
}
