-- 061 - self-copy activity log, engine status and follower calibration (OPTIONAL, forward-only).
--
-- Why: self-copy used to skip a trade at a dozen places without leaving a trace, so "it does
-- nothing" could not be told apart from "the route is switched off" or "the stream never
-- opened". The rebuilt engine (src/lib/copy/selfCopyEngine.ts, runs on the AWS copy worker)
-- writes ONE line for every position of every route - copied, skipped (with the reason) or
-- failed (with the broker's answer) - plus how long each stage took. The web app shows those
-- lines on the route, together with whether the worker is listening to the source account.
--
-- The application works WITHOUT this migration: the engine keeps copying, the lines only reach
-- the worker's log, the route shows what the copy links say, and a missing table / column is
-- remembered for ten minutes instead of being asked again. Apply manually (Supabase SQL
-- editor); every statement is idempotent. Order (docs/WSA_AGENT_MEMORY.md, rule 6): this
-- migration, then the web app, then let the AWS workers pull `main` (`npm ci`, restart the
-- three units).

-- 1) engine status on the route ---------------------------------------------------------
--    Written by the copy worker (service role) when it opens / loses the stream of the
--    SOURCE account of a route and every ~60 s while it listens. The web treats a status
--    older than three minutes as "not listening".
alter table public.self_copy_relationships
  add column if not exists engine_status text
    check (engine_status is null or engine_status in ('STARTING', 'LIVE', 'ERROR')),
  add column if not exists engine_error text,
  add column if not exists engine_heartbeat_at timestamptz;

-- 2) self_copy_events -------------------------------------------------------------------
--    One row per decision of the engine. Written in batches by the worker (service role);
--    the owner (and admins) may read their own rows. Rows older than 14 days are removed by
--    the worker. `timings` = milliseconds per stage (queue, facts, reserve, broker, link,
--    total) so a slow copy can be told where it was slow.
create table if not exists public.self_copy_events (
  id                   uuid primary key default gen_random_uuid(),
  relationship_id      uuid not null references public.self_copy_relationships(id) on delete cascade,
  trader_id            uuid not null references public.profiles(id) on delete cascade,
  source_account_id    uuid not null references public.trading_accounts(id) on delete cascade,
  follower_account_id  uuid not null references public.trading_accounts(id) on delete cascade,
  event_type           text not null check (event_type in ('OPEN', 'MODIFY', 'CLOSE')),
  source_position_id   text not null,
  outcome              text not null check (outcome in ('COPIED', 'SKIPPED', 'FAILED')),
  code                 text not null,
  message              text not null default '',
  symbol               text,
  follower_symbol      text,
  side                 text check (side is null or side in ('BUY', 'SELL')),
  source_volume        numeric,
  copied_volume        numeric,
  latency_ms           integer,
  timings              jsonb,
  created_at           timestamptz not null default now()
);

create index if not exists idx_self_copy_events_route_time
  on public.self_copy_events (relationship_id, created_at desc);
create index if not exists idx_self_copy_events_trader_time
  on public.self_copy_events (trader_id, created_at desc);
create index if not exists idx_self_copy_events_created
  on public.self_copy_events (created_at);

alter table public.self_copy_events enable row level security;
drop policy if exists "self_copy_events_select_own_or_admin" on public.self_copy_events;
create policy "self_copy_events_select_own_or_admin"
  on public.self_copy_events for select
  using (trader_id = auth.uid() or public.is_admin());

-- 3) calibration of strategy followers --------------------------------------------------
--    The same calibration options a self-copy route has (copy stop loss / take profit,
--    fixed distances, slippage, signal age, automatic symbol matching). An empty object
--    {} = the platform defaults = exactly the behaviour followers always had.
do $$
begin
  if to_regclass('public.copy_strategy_followers') is not null then
    alter table public.copy_strategy_followers
      add column if not exists calibration jsonb not null default '{}'::jsonb;
  end if;
end
$$;
