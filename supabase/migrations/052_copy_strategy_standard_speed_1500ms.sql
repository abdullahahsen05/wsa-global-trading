-- Migration 052: set WSA copy speed tiers to 1.5s standard and 0ms premium.

ALTER TABLE public.copy_strategies
  ALTER COLUMN standard_delay_ms SET DEFAULT 1500,
  ALTER COLUMN premium_delay_ms SET DEFAULT 0;

UPDATE public.copy_strategies
SET standard_delay_ms = 1500,
    premium_delay_ms = 0
WHERE standard_delay_ms IS NULL
   OR standard_delay_ms = 2500
   OR premium_delay_ms IS NULL
   OR premium_delay_ms = 250;
