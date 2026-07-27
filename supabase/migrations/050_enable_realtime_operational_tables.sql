-- Publish the operational tables used by authenticated dashboards.
-- RLS remains authoritative: Realtime only delivers rows the subscriber can select.
DO $$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'trading_accounts',
    'risk_rules',
    'copy_execution_logs',
    'copy_trade_links',
    'copy_master_events',
    'copy_strategy_followers',
    'self_copy_relationships',
    'self_copy_trade_links'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = relation_name
      )
    THEN
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime ADD TABLE public.%I',
        relation_name
      );
    END IF;
  END LOOP;
END
$$;
