-- AWS worker command gateway. The web tier records a command; a persistent
-- worker claims it and writes a result. All tables remain service-role-only.
create table if not exists public.trade_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.trading_accounts(id) on delete cascade,
  kind text not null check (kind in ('OPEN', 'CLOSE', 'MODIFY', 'CANCEL', 'CLOSE_BULK', 'STATE', 'SYMBOLS')),
  payload jsonb not null default '{}'::jsonb,
  client_request_id text not null check (char_length(client_request_id) between 8 and 64),
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED')),
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 seconds'),
  claimed_at timestamptz,
  claimed_by text,
  completed_at timestamptz,
  constraint trade_commands_user_request_key unique (user_id, client_request_id)
);

create index if not exists idx_trade_commands_pending on public.trade_commands (created_at) where status = 'PENDING';
create index if not exists idx_trade_commands_running on public.trade_commands (claimed_at) where status = 'RUNNING';
create index if not exists idx_trade_commands_account_time on public.trade_commands (account_id, created_at desc);
create index if not exists idx_trade_commands_completed on public.trade_commands (completed_at) where status in ('DONE', 'FAILED', 'EXPIRED');
alter table public.trade_commands enable row level security;

create or replace function public.claim_trade_commands(p_worker text, p_limit integer default 10)
returns setof public.trade_commands
language plpgsql
set search_path = ''
as $$
begin
  return query
  update public.trade_commands c
  set status = 'RUNNING', claimed_at = now(), claimed_by = p_worker
  where c.id in (
    select p.id from public.trade_commands p
    where p.status = 'PENDING' and p.expires_at > now()
    order by p.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  returning c.*;
end;
$$;

revoke all on function public.claim_trade_commands(text, integer) from public, anon, authenticated;
grant execute on function public.claim_trade_commands(text, integer) to service_role;

create table if not exists public.terminal_account_state (
  account_id uuid primary key references public.trading_accounts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  watch_until timestamptz not null default now(),
  watch_symbols jsonb not null default '[]'::jsonb,
  state jsonb,
  state_at timestamptz,
  error text,
  error_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_terminal_account_state_watch on public.terminal_account_state (watch_until);
alter table public.terminal_account_state enable row level security;

create table if not exists public.terminal_account_symbols (
  account_id uuid primary key references public.trading_accounts(id) on delete cascade,
  symbols jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.terminal_account_symbols enable row level security;

create table if not exists public.gateway_heartbeat (
  worker text primary key,
  role text not null default 'trade-gateway',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  info jsonb not null default '{}'::jsonb
);
alter table public.gateway_heartbeat enable row level security;

notify pgrst, 'reload schema';
