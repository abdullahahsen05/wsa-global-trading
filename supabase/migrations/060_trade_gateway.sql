-- 060 - trade gateway: the web app (Vercel) asks, the AWS system (MetaTrader side) does
-- (OPTIONAL, forward-only).
--
-- Why: everything that reads or executes on a MetaTrader account lives on AWS (copy engine,
-- self-copy, account sync, API2Trade bridge). The web app only holds the customer database.
-- Until now the WSA Trade order panel tried to reach the broker bridge FROM the web tier,
-- which only works where the web tier happens to carry the bridge credentials and the
-- execution switch (not on Vercel, not on a local test machine). With this gateway the web
-- tier writes a COMMAND row; the AWS worker (scripts/wsa-copy-worker.ts) picks it up in a
-- fraction of a second, executes it through the bridge it already has a session with, and
-- writes the answer back. Account figures and open positions are published the same way by
-- the worker for the accounts a person is looking at.
--
-- The application works WITHOUT this migration: it detects the missing tables, remembers it
-- for ten minutes and falls back to executing from the web tier when that tier has the
-- execution switch (BROKER_EXECUTION_ENABLED=true) - otherwise the order panel stays
-- read-only and says so. Apply manually (Supabase SQL editor); every statement is idempotent.
--
-- Rollout order (docs/WSA_AGENT_MEMORY.md, rule 6): this migration first, then the web
-- app, then let the AWS workers pull `main` (`npm ci`, restart the three units).
--
-- All four tables are read and written by server code with the service role ONLY: row level
-- security is on and there are no policies. Every web query filters by user_id explicitly.

-- 1) trade_commands ---------------------------------------------------------------------
--    One row per thing the web asks the AWS system to do on a trading account.
--    kind: OPEN / CLOSE / MODIFY / CANCEL / CLOSE_BULK (orders), STATE / SYMBOLS (reads).
--    status: PENDING -> RUNNING -> DONE | FAILED; EXPIRED = nobody picked it up in time (it
--    was never sent to the broker). A RUNNING command whose worker disappeared is FAILED
--    (WORKER_LOST) and is never run again by itself: the order may exist.
--    (user_id, client_request_id) is unique: the same click sent twice is one command.
create table if not exists public.trade_commands (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  account_id        uuid not null references public.trading_accounts(id) on delete cascade,
  kind              text not null
                    check (kind in ('OPEN', 'CLOSE', 'MODIFY', 'CANCEL', 'CLOSE_BULK', 'STATE', 'SYMBOLS')),
  payload           jsonb not null default '{}'::jsonb,
  client_request_id text not null check (char_length(client_request_id) between 8 and 64),
  status            text not null default 'PENDING'
                    check (status in ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED')),
  result            jsonb,
  error_code        text,
  error_message     text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '90 seconds'),
  claimed_at        timestamptz,
  claimed_by        text,
  completed_at      timestamptz,
  constraint trade_commands_user_request_key unique (user_id, client_request_id)
);

create index if not exists idx_trade_commands_pending
  on public.trade_commands (created_at)
  where status = 'PENDING';
create index if not exists idx_trade_commands_running
  on public.trade_commands (claimed_at)
  where status = 'RUNNING';
create index if not exists idx_trade_commands_account_time
  on public.trade_commands (account_id, created_at desc);
create index if not exists idx_trade_commands_completed
  on public.trade_commands (completed_at)
  where status in ('DONE', 'FAILED', 'EXPIRED');

alter table public.trade_commands enable row level security;
-- No policies on purpose: service role only.

-- Claims up to p_limit pending commands for one worker (several workers never get the same
-- command: FOR UPDATE SKIP LOCKED). Commands past their expiry are left for the housekeeping
-- of the worker, which marks them EXPIRED.
create or replace function public.claim_trade_commands(p_worker text, p_limit integer default 10)
returns setof public.trade_commands
language plpgsql
as $$
begin
  return query
  update public.trade_commands c
     set status = 'RUNNING',
         claimed_at = now(),
         claimed_by = p_worker
   where c.id in (
     select p.id
       from public.trade_commands p
      where p.status = 'PENDING'
        and p.expires_at > now()
      order by p.created_at asc
      for update skip locked
      limit greatest(1, least(coalesce(p_limit, 10), 50))
   )
  returning c.*;
end;
$$;

revoke all on function public.claim_trade_commands(text, integer) from public, anon, authenticated;
grant execute on function public.claim_trade_commands(text, integer) to service_role;

-- 2) terminal_account_state -------------------------------------------------------------
--    The live picture of an account the AWS worker publishes while somebody is looking at
--    it. The web writes watch_until (+45 s, renewed by the panel's polls) and watch_symbols
--    (the symbols whose price is on screen); the worker refreshes `state` about once a
--    second for every account with watch_until in the future and stops after that.
--    state = { currency, balance, equity, floatingProfit, margin, freeMargin, marginLevel,
--              readOnly, positions[], pending[], pendingOrders, quotes{}, fetchedAt }.
--    error / error_at = why the worker could not read the account at its last try (cleared
--    by the next successful read).
create table if not exists public.terminal_account_state (
  account_id    uuid primary key references public.trading_accounts(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  watch_until   timestamptz not null default now(),
  watch_symbols jsonb not null default '[]'::jsonb,
  state         jsonb,
  state_at      timestamptz,
  error         text,
  error_at      timestamptz,
  updated_at    timestamptz not null default now()
);

create index if not exists idx_terminal_account_state_watch
  on public.terminal_account_state (watch_until);

alter table public.terminal_account_state enable row level security;

-- 3) terminal_account_symbols -----------------------------------------------------------
--    Every symbol an account can trade, spelled the way its broker spells it (the order
--    panel's symbol picker). Large, so kept apart from the state row.
create table if not exists public.terminal_account_symbols (
  account_id uuid primary key references public.trading_accounts(id) on delete cascade,
  symbols    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.terminal_account_symbols enable row level security;

-- 4) gateway_heartbeat ------------------------------------------------------------------
--    Written by every AWS worker that runs the gateway, every few seconds. The web app
--    reads it to know whether orders can be executed right now, and says so honestly when
--    nobody is there.
create table if not exists public.gateway_heartbeat (
  worker     text primary key,
  role       text not null default 'trade-gateway',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  info       jsonb not null default '{}'::jsonb
);

alter table public.gateway_heartbeat enable row level security;

-- Make PostgREST pick up the new tables and the function immediately.
notify pgrst, 'reload schema';
