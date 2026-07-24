-- Create the two monthly products for strategies that were already live when
-- migration 046 introduced speed tiers.

INSERT INTO public.billing_products (code, name, type, amount, currency, billing_interval, active)
SELECT
  'COPY_STRATEGY_' || UPPER(REPLACE(strategy.id::TEXT, '-', '')) || '_STANDARD',
  strategy.name || ' Standard Copy Strategy',
  'COPY_ACCOUNT',
  strategy.standard_monthly_price,
  strategy.currency,
  'MONTHLY',
  strategy.status = 'ACTIVE' AND strategy.live_enabled
FROM public.copy_strategies strategy
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  amount = EXCLUDED.amount,
  currency = EXCLUDED.currency,
  active = EXCLUDED.active;

INSERT INTO public.billing_products (code, name, type, amount, currency, billing_interval, active)
SELECT
  'COPY_STRATEGY_' || UPPER(REPLACE(strategy.id::TEXT, '-', '')) || '_PREMIUM',
  strategy.name || ' Premium Fast Copy Strategy',
  'COPY_ACCOUNT',
  strategy.premium_monthly_price,
  strategy.currency,
  'MONTHLY',
  strategy.status = 'ACTIVE' AND strategy.live_enabled
FROM public.copy_strategies strategy
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  amount = EXCLUDED.amount,
  currency = EXCLUDED.currency,
  active = EXCLUDED.active;

UPDATE public.copy_strategies strategy
SET
  standard_billing_product_id = standard.id,
  premium_billing_product_id = premium.id,
  billing_product_id = standard.id
FROM public.billing_products standard, public.billing_products premium
WHERE standard.code = 'COPY_STRATEGY_' || UPPER(REPLACE(strategy.id::TEXT, '-', '')) || '_STANDARD'
  AND premium.code = 'COPY_STRATEGY_' || UPPER(REPLACE(strategy.id::TEXT, '-', '')) || '_PREMIUM';
