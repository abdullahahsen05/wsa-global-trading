-- 062 - trade gateway: wake up the moment something happens, not on the next poll
-- (OPTIONAL, forward-only; needs 060).
--
-- Why: until now a WSA Trade order paid for two waiting games. The AWS worker asked the
-- database "anything for me?" every 100-400 ms, and the web server asked "is it done yet?"
-- every 70-300 ms. On a request that otherwise takes ~300 ms of real work that is seconds of
-- sitting around (each question is also a full round trip to the database).
--
-- What: two functions that WAIT INSIDE THE DATABASE and answer the instant the row changes
-- (they look at the row every 10 ms - an indexed lookup, free at this size - and return as
-- soon as there is something):
--
--   claim_trade_commands_wait(worker, limit, wait_ms)
--       the worker's claim, but if nothing is pending it waits up to wait_ms (max 5 s) for a
--       command to arrive; same rules as claim_trade_commands (FOR UPDATE SKIP LOCKED, only
--       commands that have not expired), but with the real clock inside the wait.
--   await_trade_command(user_id, client_request_id, wait_ms)
--       the web server's "wait for the answer": returns the command row as soon as it is
--       DONE / FAILED / EXPIRED (or, after wait_ms (max 5 s), the row as it is - or nothing
--       when it was not written yet, so the call can start together with the write).
--
-- The application works WITHOUT this migration: it detects the missing functions, falls back
-- to polling as before and says so in the time report ("polling - apply migration 062").
-- Apply manually (Supabase SQL editor); every statement is idempotent. Rollout order:
-- this migration first, then the web app, then the AWS workers pull `main` (`npm ci`,
-- restart the three units).
--
-- Both functions are for the service role ONLY, like claim_trade_commands.

create or replace function public.claim_trade_commands_wait(
  p_worker  text,
  p_limit   integer default 10,
  p_wait_ms integer default 1000
)
returns setof public.trade_commands
language plpgsql
set search_path = ''
as $$
declare
  v_until timestamptz := clock_timestamp()
    + make_interval(secs => (greatest(0, least(coalesce(p_wait_ms, 1000), 5000)) / 1000.0)::double precision);
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
begin
  loop
    -- a cheap look first: the usual answer is "nothing yet"
    if exists (
      select 1
        from public.trade_commands p
       where p.status = 'PENDING'
         and p.expires_at > clock_timestamp()
    ) then
      return query
      update public.trade_commands c
         set status = 'RUNNING',
             claimed_at = clock_timestamp(),
             claimed_by = p_worker
       where c.id in (
         select p.id
           from public.trade_commands p
          where p.status = 'PENDING'
            and p.expires_at > clock_timestamp()
          order by p.created_at asc
          for update skip locked
          limit v_limit
       )
      returning c.*;
      if found then
        return;
      end if;
    end if;
    exit when clock_timestamp() >= v_until;
    perform pg_sleep(0.01);
  end loop;
end;
$$;

revoke all on function public.claim_trade_commands_wait(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_trade_commands_wait(text, integer, integer) to service_role;

create or replace function public.await_trade_command(
  p_user_id           uuid,
  p_client_request_id text,
  p_wait_ms           integer default 2500
)
returns setof public.trade_commands
language plpgsql
set search_path = ''
as $$
declare
  v_until timestamptz := clock_timestamp()
    + make_interval(secs => (greatest(0, least(coalesce(p_wait_ms, 2500), 5000)) / 1000.0)::double precision);
begin
  loop
    return query
      select c.*
        from public.trade_commands c
       where c.user_id = p_user_id
         and c.client_request_id = p_client_request_id
         and c.status in ('DONE', 'FAILED', 'EXPIRED');
    if found then
      return;
    end if;
    exit when clock_timestamp() >= v_until;
    perform pg_sleep(0.01);
  end loop;

  -- not finished in time: the row as it is now (nothing at all if it was never written)
  return query
    select c.*
      from public.trade_commands c
     where c.user_id = p_user_id
       and c.client_request_id = p_client_request_id;
end;
$$;

revoke all on function public.await_trade_command(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.await_trade_command(uuid, text, integer) to service_role;

-- Make PostgREST pick up the new functions immediately.
notify pgrst, 'reload schema';
