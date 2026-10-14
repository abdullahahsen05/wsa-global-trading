-- Efficient, forward-only sample functions for real snapshot-based charts.
create or replace function public.account_snapshot_samples(
  p_account_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_points integer default 480,
  p_extra timestamptz[] default '{}'::timestamptz[]
)
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select greatest(2, least(coalesce(p_points, 480), 700)) as n
  ),
  grid as (
    select p_start + (p_end - p_start) * (g::double precision / (params.n - 1)) as sample_at
    from params cross join lateral generate_series(0, params.n - 1) as g
  ),
  extra as (
    select e as sample_at
    from unnest(coalesce(p_extra, '{}'::timestamptz[])) with ordinality as x(e, position)
    where position <= 300 and e between p_start and p_end
  ),
  instants as (
    select sample_at from grid union select sample_at from extra
  ),
  selected as (
    select distinct on (snapshot.id)
      snapshot.id, snapshot.captured_at, to_jsonb(snapshot) - 'trading_account_id' as payload
    from instants
    cross join lateral (
      select s.* from public.account_snapshots as s
      where s.trading_account_id = p_account_id and s.captured_at <= instants.sample_at
      order by s.captured_at desc limit 1
    ) as snapshot
    order by snapshot.id
  )
  select payload from selected order by captured_at asc
$$;

revoke all on function public.account_snapshot_samples(uuid, timestamptz, timestamptz, integer, timestamptz[])
  from public, anon, authenticated;
grant execute on function public.account_snapshot_samples(uuid, timestamptz, timestamptz, integer, timestamptz[])
  to service_role;

create or replace function public.platform_equity_samples(
  p_account_ids uuid[],
  p_start timestamptz,
  p_end timestamptz,
  p_points integer default 480
)
returns table(captured_at timestamptz, balance numeric, equity numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select greatest(2, least(coalesce(p_points, 480), 700)) as n
  ),
  sample_times as (
    select p_start + (p_end - p_start) * (g::double precision / (params.n - 1)) as sample_at
    from params cross join lateral generate_series(0, params.n - 1) as g
  )
  select times.sample_at, round(sum(snapshot.balance)::numeric, 2), round(sum(snapshot.equity)::numeric, 2)
  from sample_times as times
  cross join unnest(p_account_ids) as account(id)
  left join lateral (
    select s.balance, s.equity from public.account_snapshots as s
    where s.trading_account_id = account.id and s.captured_at <= times.sample_at
    order by s.captured_at desc limit 1
  ) as snapshot on true
  group by times.sample_at
  having count(snapshot.equity) > 0
  order by times.sample_at
$$;

revoke all on function public.platform_equity_samples(uuid[], timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.platform_equity_samples(uuid[], timestamptz, timestamptz, integer)
  to service_role;
