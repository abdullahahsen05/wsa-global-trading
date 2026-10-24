'use client'
import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { createClient } from '@/lib/supabase/client'

/** The browser client the channels are opened on (a type only: the code itself is fetched when the connection opens). */
type BrowserClient = ReturnType<typeof createClient>

/**
 * The live connection opens this long after the shell is up. The first screen is fetched with plain requests; the
 * connection (a WebSocket and seven channel joins) used to open at the same moment and compete with them for the
 * network and the browser's main thread. The code behind it (the Supabase client with its realtime layer) is a
 * separate chunk that is only fetched at that moment - it is not part of the bundle every page has to download, parse
 * and run before it can show anything.
 */
const START_DELAY_MS = 1_200

/**
 * Runs `action` at once when nothing ran for `minGapMs`; otherwise once, at the end of the gap, however many times it
 * is called meanwhile. A snapshot arrives every few seconds per account, and the heavy views (statistics, the curve)
 * were refetched in full on each one - this keeps them live without refetching them continuously.
 */
export function throttled(
  minGapMs: number,
  action: () => void,
): { call: () => void; cancel: () => void } {
  let lastRunAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = () => {
    timer = null
    lastRunAt = Date.now()
    action()
  }
  return {
    call() {
      if (timer) return // one is already due at the end of the gap
      const wait = lastRunAt + minGapMs - Date.now()
      if (wait <= 0) fire()
      else timer = setTimeout(fire, wait)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

/** Opens the channels; returns the function that closes them. */
function subscribeToChanges(queryClient: QueryClient, supabase: BrowserClient): () => void {
  // The account performance chart samples the whole history (see
  // usePerformanceSeries), so it is refreshed at most once per quiet period
  // after trades change instead of on every event / snapshot.
  let performanceTimer: ReturnType<typeof setTimeout> | null = null
  const schedulePerformanceRefresh = () => {
    if (performanceTimer) clearTimeout(performanceTimer)
    performanceTimer = setTimeout(() => {
      performanceTimer = null
      queryClient.invalidateQueries({ queryKey: ['account-performance'] })
    }, 8_000)
  }

  // The figures people watch (balance, equity, positions) follow within a couple of seconds; the heavy views are
  // allowed a longer gap.
  const accountsRefresh = throttled(2_000, () => {
    queryClient.invalidateQueries({ queryKey: ['trading-accounts'] })
  })
  const tradesRefresh = throttled(1_500, () => {
    queryClient.invalidateQueries({ queryKey: ['trades'] })
  })
  const analyticsRefresh = throttled(8_000, () => {
    queryClient.invalidateQueries({ queryKey: ['equity-curve'] })
    queryClient.invalidateQueries({ queryKey: ['analytics-summary'] })
  })

  // Subscribe to account snapshots
  const snapshotChannel = supabase
    .channel('account-snapshots')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'account_snapshots',
    }, () => {
      accountsRefresh.call()
      analyticsRefresh.call()
    })
    .subscribe()

  // Subscribe to trades
  const tradeChannel = supabase
    .channel('trades-realtime')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'trades',
    }, (payload) => {
      tradesRefresh.call()
      analyticsRefresh.call()
      schedulePerformanceRefresh()
      const newStatus = 'new' in payload ? (payload.new as { status?: string } | null)?.status : undefined
      if (payload.eventType !== 'INSERT' || newStatus === 'OPEN') {
        accountsRefresh.call()
      }
    })
    .subscribe()

  // Subscribe to risk events
  const riskChannel = supabase
    .channel('risk-events-realtime')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'risk_events',
    }, () => {
      queryClient.invalidateQueries({ queryKey: ['risk-events'] })
    })
    .subscribe()

  const riskRulesChannel = supabase
    .channel('risk-rules-realtime')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'risk_rules',
    }, () => {
      queryClient.invalidateQueries({ queryKey: ['risk-rules'] })
    })
    .subscribe()

  // Subscribe to notifications
  const notificationChannel = supabase
    .channel('notifications-realtime')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
    }, () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    })
    .subscribe()

  const accountChannel = supabase
    .channel('trading-accounts-realtime')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'trading_accounts',
    }, () => {
      accountsRefresh.call()
      queryClient.invalidateQueries({ queryKey: ['admin-accounts'] })
      queryClient.invalidateQueries({ queryKey: ['copy-master-accounts'] })
    })
    .subscribe()

  const copyChannel = supabase
    .channel('copy-operations-realtime')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'copy_execution_logs',
    }, () => {
      queryClient.invalidateQueries({ queryKey: ['copy-logs'] })
      queryClient.invalidateQueries({ queryKey: ['admin-copy-logs'] })
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'copy_trade_links',
    }, () => {
      tradesRefresh.call()
      queryClient.invalidateQueries({ queryKey: ['copy-logs'] })
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'copy_master_events',
    }, () => {
      queryClient.invalidateQueries({ queryKey: ['copy-logs'] })
      queryClient.invalidateQueries({ queryKey: ['admin-copy-strategies'] })
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'copy_strategy_followers',
    }, () => {
      queryClient.invalidateQueries({ queryKey: ['copy-my-subscriptions'] })
      queryClient.invalidateQueries({ queryKey: ['admin-copy-strategies'] })
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'self_copy_relationships',
    }, () => {
      queryClient.invalidateQueries({ queryKey: ['self-copy-relationships'] })
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'self_copy_trade_links',
    }, () => {
      queryClient.invalidateQueries({ queryKey: ['self-copy-relationships'] })
      tradesRefresh.call()
    })
    .subscribe()

  return () => {
    if (performanceTimer) clearTimeout(performanceTimer)
    accountsRefresh.cancel()
    tradesRefresh.cancel()
    analyticsRefresh.cancel()
    supabase.removeChannel(snapshotChannel)
    supabase.removeChannel(tradeChannel)
    supabase.removeChannel(riskChannel)
    supabase.removeChannel(riskRulesChannel)
    supabase.removeChannel(notificationChannel)
    supabase.removeChannel(accountChannel)
    supabase.removeChannel(copyChannel)
  }
}

/**
 * Subscribe to Supabase Realtime events and invalidate React Query caches.
 * Call this hook once in a top-level layout or dashboard component.
 */
export function useRealtimeUpdates(enabled = true) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!enabled) return
    let close: (() => void) | null = null
    let stopped = false
    const timer = setTimeout(() => {
      void import('@/lib/supabase/client')
        .then(({ createClient }) => {
          // (switched off while the chunk was on its way)
          if (stopped) return
          close = subscribeToChanges(queryClient, createClient())
        })
        .catch(() => {
          // the chunk could not be fetched (offline, a deploy in between): the polling every view has keeps it current
        })
    }, START_DELAY_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
      close?.()
    }
  }, [enabled, queryClient])
}
