-- Cash-flow history and a service-role-only broker web-terminal directory.
create table if not exists public.account_cash_flows (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id) on delete cascade,
  external_id text not null,
  kind text not null check (kind in ('DEPOSIT', 'WITHDRAWAL')),
  amount numeric(18,2) not null,
  currency text,
  occurred_at timestamptz not null,
  comment text,
  created_at timestamptz not null default now(),
  constraint account_cash_flows_account_external_key unique (trading_account_id, external_id)
);

create index if not exists idx_account_cash_flows_account_time
  on public.account_cash_flows (trading_account_id, occurred_at);

alter table public.account_cash_flows enable row level security;
drop policy if exists "account_cash_flows_select" on public.account_cash_flows;
create policy "account_cash_flows_select" on public.account_cash_flows for select
  using (public.is_admin() or exists (
    select 1 from public.trading_accounts ta
    where ta.id = trading_account_id and ta.user_id = auth.uid()
  ));

create table if not exists public.broker_web_terminals (
  server_key text primary key check (server_key ~ '^[a-z0-9]{2,40}:mt[45]$'),
  broker_name text,
  url text check (url is null or url ~ '^https://'),
  source text not null default 'DISCOVERED' check (source in ('ADMIN', 'DISCOVERED')),
  embeddable boolean not null default true,
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.broker_web_terminals enable row level security;
notify pgrst, 'reload schema';
