-- Partner commission engine: separate Forex and XAUUSD lot rates.
-- Existing configs keep their current generic rebate rate as the XAUUSD default
-- until an admin chooses the dedicated XAUUSD commercial rate.

ALTER TABLE public.partner_broker_configurations
  ADD COLUMN IF NOT EXISTS xauusd_rate_per_lot NUMERIC(18,2);

UPDATE public.partner_broker_configurations
SET xauusd_rate_per_lot = rebate_rate_per_lot
WHERE xauusd_rate_per_lot IS NULL;

ALTER TABLE public.partner_broker_configurations
  ALTER COLUMN xauusd_rate_per_lot SET DEFAULT 5.00,
  ALTER COLUMN xauusd_rate_per_lot SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'partner_broker_configurations_xauusd_rate_nonnegative'
  ) THEN
    ALTER TABLE public.partner_broker_configurations
      ADD CONSTRAINT partner_broker_configurations_xauusd_rate_nonnegative
      CHECK (xauusd_rate_per_lot >= 0);
  END IF;
END $$;
