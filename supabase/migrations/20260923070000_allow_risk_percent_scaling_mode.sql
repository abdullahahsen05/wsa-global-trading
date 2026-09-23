-- Allow risk-percent copy settings to persist.
--
-- The application maps copy_mode = 'RISK_PERCENT' to scaling_mode = 'RISK_PERCENT'
-- so the live execution path can size lots from stop-loss risk. The original
-- follower scaling constraint predated that mode and rejected saves.

ALTER TABLE public.copy_strategy_followers
  DROP CONSTRAINT IF EXISTS copy_strategy_followers_scaling_mode_check;

ALTER TABLE public.copy_strategy_followers
  ADD CONSTRAINT copy_strategy_followers_scaling_mode_check
  CHECK (
    scaling_mode IS NULL
    OR scaling_mode IN (
      'FIXED_MULTIPLIER',
      'BALANCE_PROPORTIONAL',
      'EQUITY_PROPORTIONAL',
      'FIXED_LOT',
      'RISK_PERCENT'
    )
  );
