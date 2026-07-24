-- Evaluation demo accounts are created by traders outside the platform and
-- connected through the existing encrypted account-connection flow.

UPDATE public.evaluation_attempts
SET
  status = 'PENDING',
  provisioning_status = 'ACTION_REQUIRED',
  provisioning_error = 'Create a fresh demo account, connect it under Accounts, then select it here to start tracking.'
WHERE trading_account_id IS NULL
  AND status IN ('PENDING', 'NEEDS_REVIEW')
  AND provisioning_status IN ('NOT_STARTED', 'PROVISIONING', 'ACTION_REQUIRED', 'FAILED');
