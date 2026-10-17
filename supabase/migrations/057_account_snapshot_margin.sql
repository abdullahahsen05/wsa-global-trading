-- 057: margin history for the account performance chart (OPTIONAL, forward-only).
--
-- Adds three nullable columns to account_snapshots (used margin, free margin,
-- margin level) and a second snapshot writer that stores them. The existing
-- public.record_account_snapshot(uuid, numeric, numeric) is NOT touched, so the
-- web app and the AWS workers keep working before and after this migration.
--
-- Rollout order (see docs/WSA_AGENT_MEMORY.md, rule 6): run this migration first,
-- then deploy the web app, then let the AWS workers pull main. The application
-- code falls back to the old writer when this migration has not been applied,
-- so skipping it only means the "Margin" tab of the chart stays empty.
--
-- Safe to re-run: every statement is idempotent.

alter table public.account_snapshots
  add column if not exists margin        numeric(18,2),
  add column if not exists free_margin   numeric(18,2),
  add column if not exists margin_level  numeric(18,2);

create or replace function public.record_account_snapshot_v2(
  p_account_id   uuid,
  p_balance      numeric,
  p_equity       numeric,
  p_margin       numeric default null,
  p_free_margin  numeric default null,
  p_margin_level numeric default null
)
returns numeric
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_peak numeric;
  v_drawdown numeric;
begin
  -- Same logic as record_account_snapshot: keep the account-level equity peak
  -- race-free and store the drawdown against it.
  update public.trading_accounts
  set equity_peak = greatest(coalesce(equity_peak, p_equity), p_equity)
  where id = p_account_id
  returning equity_peak into v_peak;

  if v_peak is null then
    raise exception 'Trading account not found';
  end if;

  v_drawdown := case when v_peak > 0
    then round(greatest(0, (v_peak - p_equity) / v_peak * 100), 2)
    else 0 end;

  insert into public.account_snapshots
    (trading_account_id, balance, equity, floating_pnl, drawdown_percent,
     margin, free_margin, margin_level)
  values
    (p_account_id, p_balance, p_equity, p_equity - p_balance, v_drawdown,
     p_margin, p_free_margin, p_margin_level);

  return v_drawdown;
end;
$$;

revoke all on function public.record_account_snapshot_v2(uuid, numeric, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.record_account_snapshot_v2(uuid, numeric, numeric, numeric, numeric, numeric)
  to service_role;

-- Make PostgREST pick up the new function and columns immediately.
notify pgrst, 'reload schema';
