-- Live self-copy, per-strategy speed tiers, and the complete evaluation lifecycle.
-- Existing simulation self-copy relationships are paused during migration so
-- applying schema changes never starts broker execution by itself.

ALTER TABLE public.copy_strategies
  ADD COLUMN IF NOT EXISTS standard_monthly_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS premium_monthly_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS standard_billing_product_id UUID REFERENCES public.billing_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS premium_billing_product_id UUID REFERENCES public.billing_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS standard_delay_ms INTEGER NOT NULL DEFAULT 2500,
  ADD COLUMN IF NOT EXISTS premium_delay_ms INTEGER NOT NULL DEFAULT 250;

UPDATE public.copy_strategies
SET
  standard_monthly_price = COALESCE(standard_monthly_price, monthly_price),
  premium_monthly_price = COALESCE(premium_monthly_price, GREATEST(monthly_price + 5, monthly_price * 1.5));

ALTER TABLE public.copy_strategies
  ALTER COLUMN standard_monthly_price SET NOT NULL,
  ALTER COLUMN premium_monthly_price SET NOT NULL;

ALTER TABLE public.copy_strategies
  DROP CONSTRAINT IF EXISTS copy_strategies_speed_tiers_check;
ALTER TABLE public.copy_strategies
  ADD CONSTRAINT copy_strategies_speed_tiers_check CHECK (
    standard_monthly_price >= 0
    AND premium_monthly_price >= standard_monthly_price
    AND premium_delay_ms >= 0
    AND standard_delay_ms >= premium_delay_ms
    AND standard_delay_ms <= 15000
  );

UPDATE public.self_copy_relationships
SET status = 'PAUSED'
WHERE status = 'SIMULATION';

ALTER TABLE public.self_copy_relationships
  DROP CONSTRAINT IF EXISTS self_copy_relationships_status_check;
ALTER TABLE public.self_copy_relationships
  ADD CONSTRAINT self_copy_relationships_status_check
  CHECK (status IN ('LIVE','PAUSED','ARCHIVED'));

DROP INDEX IF EXISTS public.idx_self_copy_active_pair;
CREATE UNIQUE INDEX idx_self_copy_active_pair
  ON public.self_copy_relationships(trader_id, source_account_id, follower_account_id)
  WHERE status IN ('LIVE','PAUSED');

DROP INDEX IF EXISTS public.idx_self_copy_source;
CREATE INDEX idx_self_copy_source
  ON public.self_copy_relationships(source_account_id)
  WHERE status = 'LIVE';

CREATE TABLE IF NOT EXISTS public.self_copy_trade_links (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id       UUID NOT NULL REFERENCES public.self_copy_relationships(id) ON DELETE CASCADE,
  trader_id             UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source_account_id     UUID NOT NULL REFERENCES public.trading_accounts(id) ON DELETE CASCADE,
  follower_account_id   UUID NOT NULL REFERENCES public.trading_accounts(id) ON DELETE CASCADE,
  source_position_id    TEXT NOT NULL,
  follower_position_id  TEXT,
  follower_order_id     TEXT,
  symbol                TEXT NOT NULL,
  side                  TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  copied_volume         NUMERIC NOT NULL DEFAULT 0 CHECK (copied_volume >= 0),
  status                TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','OPEN','CLOSING','CLOSED','FAILED')),
  error_code            TEXT,
  error_message         TEXT,
  opened_at             TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (relationship_id, source_position_id)
);

CREATE INDEX IF NOT EXISTS idx_self_copy_links_source
  ON public.self_copy_trade_links(source_account_id, source_position_id, status);
CREATE INDEX IF NOT EXISTS idx_self_copy_links_follower
  ON public.self_copy_trade_links(follower_account_id, status);

CREATE OR REPLACE TRIGGER trg_self_copy_trade_links_updated_at
  BEFORE UPDATE ON public.self_copy_trade_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.self_copy_trade_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "self_copy_links_select_own_or_admin" ON public.self_copy_trade_links;
CREATE POLICY "self_copy_links_select_own_or_admin"
  ON public.self_copy_trade_links FOR SELECT
  USING (trader_id = auth.uid() OR public.is_admin());

ALTER TABLE public.trading_accounts
  DROP CONSTRAINT IF EXISTS trading_accounts_account_usage_check;
ALTER TABLE public.trading_accounts
  ADD CONSTRAINT trading_accounts_account_usage_check
  CHECK (account_usage IN ('TRADER', 'COPY_MASTER', 'EVALUATION'));

ALTER TABLE public.evaluation_attempts
  ADD COLUMN IF NOT EXISTS funding_status TEXT NOT NULL DEFAULT 'NOT_ELIGIBLE',
  ADD COLUMN IF NOT EXISTS funding_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS funding_reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS funding_note TEXT,
  ADD COLUMN IF NOT EXISTS provisioning_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN IF NOT EXISTS provisioning_error TEXT;

ALTER TABLE public.evaluation_attempts
  DROP CONSTRAINT IF EXISTS evaluation_attempts_funding_status_check;
ALTER TABLE public.evaluation_attempts
  ADD CONSTRAINT evaluation_attempts_funding_status_check
  CHECK (funding_status IN ('NOT_ELIGIBLE','PENDING_REVIEW','FUNDED','DECLINED'));

ALTER TABLE public.evaluation_attempts
  DROP CONSTRAINT IF EXISTS evaluation_attempts_provisioning_status_check;
ALTER TABLE public.evaluation_attempts
  ADD CONSTRAINT evaluation_attempts_provisioning_status_check
  CHECK (provisioning_status IN ('NOT_STARTED','PROVISIONING','CONNECTED','ACTION_REQUIRED','FAILED'));

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'RISK_EVENT', 'SYNC_SUCCESS', 'SYNC_FAILURE', 'EVAL_PASSED', 'EVAL_FAILED',
    'EVAL_REVIEW', 'PARTNER_WITHDRAWAL'
  ));

CREATE INDEX IF NOT EXISTS idx_eval_attempts_funding_review
  ON public.evaluation_attempts(funding_status, updated_at DESC)
  WHERE funding_status = 'PENDING_REVIEW';
