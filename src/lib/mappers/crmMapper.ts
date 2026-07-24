import type { CrmNoteDto, TraderProfileDto } from '@/lib/domain/types'

interface CrmNoteRow {
  id: string
  trader_profile_id: string
  author_name: string
  note: string
  created_at: string
  trader_profiles?: { user_id: string }
}

interface TraderProfileRow {
  id: string
  user_id: string
  segment: string
  profiles?: {
    full_name: string
    email: string
    created_at: string
    // trading_accounts joined through profiles (profiles.id = trading_accounts.user_id)
    trading_accounts?: {
      id: string
      currency: string
      updated_at: string
      last_synced_at: string | null
      account_snapshots?: { equity: number; captured_at: string }[]
    }[]
  }
}

export function mapCrmNoteToDto(row: CrmNoteRow): CrmNoteDto {
  return {
    id: row.id,
    traderId: row.trader_profile_id,
    authorName: row.author_name,
    note: row.note,
    createdAt: row.created_at,
  }
}

export function mapTraderProfileToDto(row: TraderProfileRow): TraderProfileDto {
  const accounts = row.profiles?.trading_accounts ?? []
  const totalEquity = accounts.reduce((sum, acc) => {
    const latestSnapshot = [...(acc.account_snapshots ?? [])].sort(
      (a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime(),
    )[0]
    return sum + (latestSnapshot ? Number(latestSnapshot.equity) : 0)
  }, 0)
  const activityDates = accounts
    .flatMap((account) => [account.last_synced_at, account.updated_at])
    .filter(Boolean) as string[]
  const lastActivityAt = activityDates.length
    ? activityDates.reduce((latest, value) =>
        new Date(value).getTime() > new Date(latest).getTime() ? value : latest,
      )
    : row.profiles?.created_at ?? ''

  return {
    traderId: row.id,
    name: row.profiles?.full_name ?? 'Unknown',
    email: row.profiles?.email ?? '',
    segment: row.segment as TraderProfileDto['segment'],
    accountCount: accounts.length,
    totalEquity: { amount: totalEquity, currency: 'USD' },
    lastActivityAt,
  }
}
