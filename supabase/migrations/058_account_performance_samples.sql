-- 058 - evenly sampled account history for the performance chart (OPTIONAL).
--
-- The web app works without this migration: it then asks the database for one
-- snapshot per sample instant (240 small queries). With it, the same curve is
-- read in ONE round trip and with twice the detail (480 samples), plus the
-- instants right before / after every closed trade so balance steps are sharp.
--
-- Both functions only READ and only return stored snapshots: every returned
-- row is a real account_snapshots row (the latest one at or before a sample
-- instant). Nothing is interpolated.
--
-- Apply manually (Supabase SQL editor) - forward-only, safe to run twice.

-- One account: rows come back as jsonb so the function does not depend on which
-- optional columns (e.g. the margin columns of migration 057) exist.
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
    from params
    cross join lateral generate_series(0, params.n - 1) as g
  ),
  extra as (
    select e as sample_at
    from unnest(coalesce(p_extra, '{}'::timestamptz[])) with ordinality as x(e, position)
    where position <= 300
      and e between p_start and p_end
  ),
  instants as (
    select sample_at from grid
    union
    select sample_at from extra
  )
  select distinct on (snapshot.id) to_jsonb(snapshot) - 'trading_account_id'
  from instants
  cross join lateral (
    select s.*
    from public.account_snapshots as s
    where s.trading_account_id = p_account_id
      and s.captured_at <= instants.sample_at
    order by s.captured_at desc
    limit 1
  ) as snapshot
  order by snapshot.id
$$;

revoke all on function public.account_snapshot_samples(uuid, timestamptz, timestamptz, integer, timestamptz[])
  from public, anon, authenticated;
grant execute on function public.account_snapshot_samples(uuid, timestamptz, timestamptz, integer, timestamptz[])
  to service_role;

-- Several accounts added together: the portfolio value at evenly spaced
-- instants (each account contributes its latest known value at that instant).
-- Same idea as platform_equity_timeline, but with `p_points` samples between
-- p_start and p_end instead of one per hour.
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
    from params
    cross join lateral generate_series(0, params.n - 1) as g
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

revoke all on function public.platform_equity_samples(uuid[], timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.platform_equity_samples(uuid[], timestamptz, timestamptz, integer)
  to service_role;
