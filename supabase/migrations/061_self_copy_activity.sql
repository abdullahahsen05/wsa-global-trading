-- Observability schema for self-copy routes and follower calibration fields.
alter table public.self_copy_relationships
  add column if not exists engine_status text
    check (engine_status is null or engine_status in ('STARTING', 'LIVE', 'ERROR')),
  add column if not exists engine_error text,
  add column if not exists engine_heartbeat_at timestamptz;

create table if not exists public.self_copy_events (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.self_copy_relationships(id) on delete cascade,
  trader_id uuid not null references public.profiles(id) on delete cascade,
  source_account_id uuid not null references public.trading_accounts(id) on delete cascade,
  follower_account_id uuid not null references public.trading_accounts(id) on delete cascade,
  event_type text not null check (event_type in ('OPEN', 'MODIFY', 'CLOSE')),
  source_position_id text not null,
  outcome text not null check (outcome in ('COPIED', 'SKIPPED', 'FAILED')),
  code text not null,
  message text not null default '',
  symbol text,
  follower_symbol text,
  side text check (side is null or side in ('BUY', 'SELL')),
  source_volume numeric,
  copied_volume numeric,
  latency_ms integer,
  timings jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_self_copy_events_route_time on public.self_copy_events (relationship_id, created_at desc);
create index if not exists idx_self_copy_events_trader_time on public.self_copy_events (trader_id, created_at desc);
create index if not exists idx_self_copy_events_created on public.self_copy_events (created_at);
alter table public.self_copy_events enable row level security;
drop policy if exists "self_copy_events_select_own_or_admin" on public.self_copy_events;
create policy "self_copy_events_select_own_or_admin" on public.self_copy_events for select
  using (trader_id = auth.uid() or public.is_admin());

do $$
begin
  if to_regclass('public.copy_strategy_followers') is not null then
    alter table public.copy_strategy_followers
      add column if not exists calibration jsonb not null default '{}'::jsonb;
  end if;
end
$$;
