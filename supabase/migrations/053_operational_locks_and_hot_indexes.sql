-- Operational locks prevent duplicate broker syncs across app/worker processes.
CREATE TABLE IF NOT EXISTS public.operational_locks (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operational_locks_expires
  ON public.operational_locks(expires_at);

CREATE OR REPLACE TRIGGER trg_operational_locks_updated_at
  BEFORE UPDATE ON public.operational_locks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.operational_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "operational_locks_admin_all" ON public.operational_locks;
CREATE POLICY "operational_locks_admin_all"
  ON public.operational_locks FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE OR REPLACE FUNCTION public.try_acquire_operational_lock(
  p_key TEXT,
  p_owner TEXT,
  p_ttl_seconds INTEGER DEFAULT 90
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acquired_key TEXT;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) = 0 THEN
    RAISE EXCEPTION 'Lock key is required';
  END IF;

  INSERT INTO public.operational_locks(key, owner, expires_at)
  VALUES (p_key, p_owner, NOW() + make_interval(secs => GREATEST(5, LEAST(COALESCE(p_ttl_seconds, 90), 600))))
  ON CONFLICT (key) DO UPDATE
    SET owner = EXCLUDED.owner,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    WHERE public.operational_locks.expires_at <= NOW()
       OR public.operational_locks.owner = EXCLUDED.owner
  RETURNING key INTO acquired_key;

  RETURN acquired_key IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_operational_lock(
  p_key TEXT,
  p_owner TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.operational_locks
  WHERE key = p_key
    AND owner = p_owner;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_operational_lock(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_operational_lock(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_operational_lock(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_operational_lock(TEXT, TEXT) TO service_role;

-- Targeted indexes for high-traffic WSA reads/writes.
CREATE INDEX IF NOT EXISTS idx_trading_accounts_user_status_updated
  ON public.trading_accounts(user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_account_status_closed_opened
  ON public.trades(trading_account_id, status, closed_at DESC, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_copy_followers_strategy_status_tier
  ON public.copy_strategy_followers(strategy_id, status, tier, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copy_followers_account_status
  ON public.copy_strategy_followers(follower_account_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copy_master_events_strategy_type_created
  ON public.copy_master_events(strategy_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copy_logs_trader_status_created
  ON public.copy_execution_logs(trader_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copy_logs_follower_created
  ON public.copy_execution_logs(follower_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copy_logs_event_status
  ON public.copy_execution_logs(master_event_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_events_open_created
  ON public.risk_events(created_at DESC)
  WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_status_created
  ON public.payment_orders(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_orders_status_created
  ON public.payment_orders(status, created_at DESC);
