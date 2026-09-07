-- Enable RLS on public tables flagged by Supabase security advisors.
-- billing_products remains readable by app clients; _migrations is internal.

alter table public.billing_products enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'billing_products'
      and policyname = 'Billing products are readable'
  ) then
    create policy "Billing products are readable"
    on public.billing_products
    for select
    to anon, authenticated
    using (true);
  end if;
end $$;

alter table public._migrations enable row level security;

revoke all on table public._migrations from anon;
revoke all on table public._migrations from authenticated;
