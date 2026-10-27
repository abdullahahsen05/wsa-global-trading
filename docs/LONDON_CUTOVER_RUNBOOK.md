# Seoul → London Supabase cutover: execution checklist

Production is still `platformtrade` (`brtdyxidblyimqteduph`, Seoul). The approved London project is `platformtrade-london-stage` (`vyuyifegaacqigkzgiws`). This document does **not** authorize starting a cutover without the client's explicit maintenance-window and master-trading pause confirmation. No live-money test orders are included.

## Before touching production

1. Client confirms the window has begun and **new master MT5 trades are paused**. Tell traders the platform will briefly be unavailable and they will need to sign in again afterward because the new Supabase project has a different Auth signing key.
2. Record the current Vercel production deployment, the three AWS worker service states, and the current Supabase URLs/parameter names without printing secrets. Keep the Seoul project intact for rollback and retain a final backup in a protected location.
3. Run `npx tsx scripts/check-london-cutover.ts`. Zero pending strategy/self-copy links, `EXECUTE_COPY_EVENT` jobs, and unexpired gateway commands is necessary but **not sufficient**: verify open broker activity and outstanding order confirmations directly. Repeat after the web and workers are stopped.

## Freeze and final data copy

4. Enable `WSA_MAINTENANCE_MODE=true` in **Vercel Production** and redeploy. Verify dynamic page and API requests return 503. The gate does not stop already-open browsers from writing directly to Supabase; the agreed web-write pause remains essential. Ensure Stripe/webhook retries will be reconciled afterward.
5. After all in-flight copy and manual orders settle, stop `wsa-copy-worker`, `wsa-background-worker`, and `wsa-risk-worker` on the London EC2 host. Do not stop the services while an order is in flight. Confirm no new source events or database writes are arriving, then capture a fresh, consistent Seoul logical dump (application data plus Auth users/identities and Storage metadata). Do not reuse the earlier staging snapshot.
6. Transactionally refresh **London only** from that dump; preserve the schema, RLS, functions, triggers, publications, and extensions already validated in staging. Do not use `RESTART IDENTITY` on managed Auth tables. Verify the restore completed with `ON_ERROR_STOP=1` and no partial commit.
7. Run `npx tsx scripts/check-london-cutover.ts --exact --require-identical`. It compares all 79 public table counts plus managed counts and schema inventory. Resolve every mismatch before switching. Row-count equality does not prove all row contents match; also reconcile recent trades, copy links, user/account associations, and the final dump/restore log.

## Coordinated switch

8. Update **Vercel Production only**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to the London project values, keeping maintenance mode enabled. Redeploy and verify the new build is Ready before opening traffic. Do not put keys in shell history, logs, or Git.
9. Update AWS SSM SecureString parameters `/wsa/test/NEXT_PUBLIC_SUPABASE_URL` and `/wsa/test/SUPABASE_SERVICE_ROLE_KEY` in `eu-west-2` to the matching London values. Leave broker credentials, encryption key, and direct-lane secret unchanged. Verify every worker will load the same project, then start the three worker services and confirm they are active and error-free.
10. With master trading still paused, perform read-only checks of login, own-profile RLS, connected accounts, dashboard/trades, copy relationships, and worker heartbeats. Place only a separately approved **demo-account** copy test and confirm both master and follower MT5 timestamps, execution quality, and zero duplicates. Do not infer MT5 confirmation from an API2Trade HTTP acknowledgement.
11. Remove maintenance mode and redeploy only after the web, workers, Auth, data, and demo test agree on London. Then obtain client approval to resume master trading. Measure a new broker-confirmed p50/p95/p99 latency distribution rather than presenting the HTTP probe as the final result.

## If the switch fails

Keep web and master trading paused. If **any** data was written to London, do not simply switch URLs back to Seoul: reconcile those writes and broker orders first, or they will disappear from the old database. Preserve both projects and the final dump while diagnosing. Roll back web and all workers together only after the data reconciliation plan is clear; never run half the system against each project.
