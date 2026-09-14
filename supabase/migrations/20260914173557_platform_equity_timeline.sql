-- A time-aligned portfolio curve. Each point uses the latest known value of
-- each connected account at that instant; summing raw snapshots multiplies
-- the portfolio by the number of updates received in an hour.
create or replace function public.platform_equity_timeline(
  p_account_ids uuid[],
  p_start timestamptz
)
returns table(captured_at timestamptz, balance numeric, equity numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with sample_times as (
    select generate_series(
      date_trunc('hour', p_start),
      date_trunc('hour', now()),
      interval '1 hour'
    ) as sample_at
    union
    select now()
  )
  select times.sample_at,
         round(sum(snapshot.balance)::numeric, 2),
         round(sum(snapshot.equity)::numeric, 2)
  from sample_times as times
  cross join unnest(p_account_ids) as account(id)
  left join lateral (
    select s.balance, s.equity
    from public.account_snapshots as s
    where s.trading_account_id = account.id
      and s.captured_at <= times.sample_at
    order by s.captured_at desc
    limit 1
  ) as snapshot on true
  group by times.sample_at
  having count(snapshot.equity) > 0
  order by times.sample_at;
$$;

revoke all on function public.platform_equity_timeline(uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.platform_equity_timeline(uuid[], timestamptz) to service_role;

-- Keep an account-level equity peak so realized losses remain visible as
-- current drawdown after the position closes. All snapshot writers use this
-- function, avoiding race conditions between concurrent worker updates.
alter table public.trading_accounts
  add column if not exists equity_peak numeric;

update public.trading_accounts as account
set equity_peak = historical.peak
from (
  select trading_account_id, max(equity) as peak
  from public.account_snapshots
  group by trading_account_id
) as historical
where account.id = historical.trading_account_id
  and account.equity_peak is null;

create or replace function public.record_account_snapshot(
  p_account_id uuid,
  p_balance numeric,
  p_equity numeric
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
    (trading_account_id, balance, equity, floating_pnl, drawdown_percent)
  values
    (p_account_id, p_balance, p_equity, p_equity - p_balance, v_drawdown);

  return v_drawdown;
end;
$$;

revoke all on function public.record_account_snapshot(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.record_account_snapshot(uuid, numeric, numeric) to service_role;
