-- Migration 051: allow API2Trade polling to write live risk state rows.

ALTER TABLE public.account_risk_states
  DROP CONSTRAINT IF EXISTS account_risk_states_source_check;

ALTER TABLE public.account_risk_states
  ADD CONSTRAINT account_risk_states_source_check
  CHECK (source IN ('SYNC', 'METAAPI_STREAM', 'API2TRADE_POLL', 'COPY_PREFLIGHT'));
