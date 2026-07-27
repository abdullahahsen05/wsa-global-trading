'use client'
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'

/**
 * Subscribe to Supabase Realtime events and invalidate React Query caches.
 * Call this hook once in a top-level layout or dashboard component.
 */
export function useRealtimeUpdates(enabled = true) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!enabled) return

    const supabase = createClient()

    // Subscribe to account snapshots
    const snapshotChannel = supabase
      .channel('account-snapshots')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'account_snapshots',
      }, () => {
        queryClient.invalidateQueries({ queryKey: ['trading-accounts'] })
        queryClient.invalidateQueries({ queryKey: ['equity-curve'] })
        queryClient.invalidateQueries({ queryKey: ['analytics-summary'] })
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
        queryClient.invalidateQueries({ queryKey: ['trades'] })
        queryClient.invalidateQueries({ queryKey: ['analytics-summary'] })
        const newStatus = 'new' in payload ? (payload.new as { status?: string } | null)?.status : undefined
        if (payload.eventType !== 'INSERT' || newStatus === 'OPEN') {
          queryClient.invalidateQueries({ queryKey: ['trading-accounts'] })
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
        queryClient.invalidateQueries({ queryKey: ['trading-accounts'] })
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
        queryClient.invalidateQueries({ queryKey: ['trades'] })
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
        queryClient.invalidateQueries({ queryKey: ['trades'] })
      })
      .subscribe()

    return () => {
      supabase.removeChannel(snapshotChannel)
      supabase.removeChannel(tradeChannel)
      supabase.removeChannel(riskChannel)
      supabase.removeChannel(riskRulesChannel)
      supabase.removeChannel(notificationChannel)
      supabase.removeChannel(accountChannel)
      supabase.removeChannel(copyChannel)
    }
  }, [enabled, queryClient])
}
