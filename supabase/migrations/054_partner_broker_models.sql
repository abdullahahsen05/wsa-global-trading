-- Migration 054: broker-specific partner rebate models and trade-linked rebate ledger.

CREATE TABLE IF NOT EXISTS public.partner_broker_configurations (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                 UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  broker_provider_id          UUID REFERENCES public.broker_providers(id) ON DELETE SET NULL,
  model_type                 TEXT NOT NULL DEFAULT 'IB'
                             CHECK (model_type IN ('IB','CPA','HYBRID')),
  rebate_rate_per_lot         NUMERIC(18,2) NOT NULL DEFAULT 5.00 CHECK (rebate_rate_per_lot >= 0),
  cpa_qualification_lots      NUMERIC(18,2) NOT NULL DEFAULT 1.00 CHECK (cpa_qualification_lots >= 0),
  cpa_tier_1_deposit          NUMERIC(18,2) NOT NULL DEFAULT 300.00 CHECK (cpa_tier_1_deposit >= 0),
  cpa_tier_1_payout           NUMERIC(18,2) NOT NULL DEFAULT 350.00 CHECK (cpa_tier_1_payout >= 0),
  cpa_tier_2_deposit          NUMERIC(18,2) NOT NULL DEFAULT 500.00 CHECK (cpa_tier_2_deposit >= 0),
  cpa_tier_2_payout           NUMERIC(18,2) NOT NULL DEFAULT 550.00 CHECK (cpa_tier_2_payout >= 0),
  cpa_tier_3_deposit          NUMERIC(18,2) NOT NULL DEFAULT 1000.00 CHECK (cpa_tier_3_deposit >= 0),
  cpa_tier_3_payout           NUMERIC(18,2) NOT NULL DEFAULT 750.00 CHECK (cpa_tier_3_payout >= 0),
  currency                   TEXT NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by                 UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by                 UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_broker_config_unique_broker
  ON public.partner_broker_configurations(partner_id, broker_provider_id)
  WHERE broker_provider_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_broker_config_unique_default
  ON public.partner_broker_configurations(partner_id)
  WHERE broker_provider_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_partner_broker_config_partner
  ON public.partner_broker_configurations(partner_id, is_active);
CREATE INDEX IF NOT EXISTS idx_partner_broker_config_broker
  ON public.partner_broker_configurations(broker_provider_id, is_active);

CREATE OR REPLACE TRIGGER trg_partner_broker_configurations_updated_at
  BEFORE UPDATE ON public.partner_broker_configurations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.partner_broker_configurations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "partner_broker_config_select_own_or_admin"
  ON public.partner_broker_configurations FOR SELECT
  USING (partner_id = auth.uid() OR public.is_admin());

CREATE POLICY "partner_broker_config_admin_write"
  ON public.partner_broker_configurations FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE public.partner_rebates
  ADD COLUMN IF NOT EXISTS trade_id UUID REFERENCES public.trades(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS broker_provider_id UUID REFERENCES public.broker_providers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS configuration_id UUID REFERENCES public.partner_broker_configurations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS model_type TEXT CHECK (model_type IS NULL OR model_type IN ('IB','CPA','HYBRID')),
  ADD COLUMN IF NOT EXISTS calculation_type TEXT CHECK (calculation_type IS NULL OR calculation_type IN ('IB_VOLUME','CPA_TIER','ADMIN_ADJUSTMENT')),
  ADD COLUMN IF NOT EXISTS volume_lots NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS rate_per_lot NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS qualification_lots NUMERIC(18,2);

CREATE INDEX IF NOT EXISTS idx_partner_rebates_trade
  ON public.partner_rebates(trade_id)
  WHERE trade_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_rebates_partner_calc
  ON public.partner_rebates(partner_id, calculation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_rebates_broker
  ON public.partner_rebates(broker_provider_id)
  WHERE broker_provider_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_rebates_trade_calculation_unique
  ON public.partner_rebates(trade_id, calculation_type)
  WHERE trade_id IS NOT NULL AND calculation_type IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_rebates_cpa_once_unique
  ON public.partner_rebates(partner_id, trader_id, broker_provider_id, calculation_type)
  WHERE calculation_type = 'CPA_TIER' AND trader_id IS NOT NULL;
