-- Broker demo parameters are program-level admin settings because MetaApi's
-- demo-account endpoint requires the server, account type and leverage.

ALTER TABLE public.evaluation_programs
  ADD COLUMN IF NOT EXISTS demo_server_name TEXT,
  ADD COLUMN IF NOT EXISTS demo_account_type TEXT,
  ADD COLUMN IF NOT EXISTS demo_leverage INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS demo_broker_keywords TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

ALTER TABLE public.evaluation_programs
  DROP CONSTRAINT IF EXISTS evaluation_programs_demo_leverage_check;
ALTER TABLE public.evaluation_programs
  ADD CONSTRAINT evaluation_programs_demo_leverage_check
  CHECK (demo_leverage BETWEEN 1 AND 5000);
