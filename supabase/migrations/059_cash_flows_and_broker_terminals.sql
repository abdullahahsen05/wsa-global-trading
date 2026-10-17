-- 059 - deposits / withdrawals + broker web terminal directory (OPTIONAL, forward-only).
--
-- Two small tables. The application works WITHOUT this migration: it detects the
-- missing tables, skips the writes, remembers it for ten minutes and behaves as
-- before. Apply manually (Supabase SQL editor) - every statement is idempotent.
--
-- Rollout order (docs/WSA_AGENT_MEMORY.md, rule 6): this migration first, then
-- the web app, then let the AWS workers pull `main`.
--
-- 1) account_cash_flows
--    The deposits and withdrawals found in the broker history. The performance
--    chart takes them out of "growth" and "drawdown": without them a deposit is
--    drawn as profit and a withdrawal as a loss. One row per balance operation;
--    the broker ticket (`external_id`) makes re-syncing harmless.
--
-- 2) broker_web_terminals
--    The MetaTrader web terminal address of a broker, found automatically (or set
--    by an administrator) so that users are never asked to look for it. MT5 web
--    terminals run on the broker's own domain, so the address depends on the
--    account's server. `server_key` = the broker part of the trade-server name,
--    lower case, a colon and the platform (ICMarketsSC-Demo on MT5 ->
--    'icmarketssc:mt5'). `url = null` means "looked, nothing usable found"
--    (looked at again after a few hours). `embeddable = false`: the broker's page
--    forbids being shown inside another page - the platform then opens it in a new
--    tab. Rows with source ADMIN are never replaced by the automatic search; an
--    ADMIN row with url null switches the automatic address off for that broker.
--    Only the server (service role) reads and writes this table.
--
--    Example of an administrator's override:
--      insert into public.broker_web_terminals (server_key, broker_name, url, source)
--      values ('icmarketssc:mt5', 'IC Markets', 'https://webtrader.example-broker.com/', 'ADMIN')
--      on conflict (server_key) do update
--        set url = excluded.url, source = 'ADMIN', embeddable = true, checked_at = now(), updated_at = now();

create table if not exists public.account_cash_flows (
  id                 uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id) on delete cascade,
  external_id        text not null,
  kind               text not null check (kind in ('DEPOSIT', 'WITHDRAWAL')),
  amount             numeric(18,2) not null,
  currency           text,
  occurred_at        timestamptz not null,
  comment            text,
  created_at         timestamptz not null default now(),
  constraint account_cash_flows_account_external_key unique (trading_account_id, external_id)
);

create index if not exists idx_account_cash_flows_account_time
  on public.account_cash_flows (trading_account_id, occurred_at);

alter table public.account_cash_flows enable row level security;

drop policy if exists "account_cash_flows_select" on public.account_cash_flows;
create policy "account_cash_flows_select"
  on public.account_cash_flows for select
  using (
    public.is_admin()
    or exists (
      select 1 from public.trading_accounts ta
      where ta.id = trading_account_id
        and ta.user_id = auth.uid()
    )
  );

create table if not exists public.broker_web_terminals (
  server_key  text primary key check (server_key ~ '^[a-z0-9]{2,40}:mt[45]$'),
  broker_name text,
  url         text check (url is null or url ~ '^https://'),
  source      text not null default 'DISCOVERED' check (source in ('ADMIN', 'DISCOVERED')),
  embeddable  boolean not null default true,
  checked_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.broker_web_terminals enable row level security;
-- No policies on purpose: the table is read and written by server code with the service role only.

-- Make PostgREST pick up the new tables immediately.
notify pgrst, 'reload schema';
