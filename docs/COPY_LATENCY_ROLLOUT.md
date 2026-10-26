# Master-to-follower copy latency rollout

This work targets the time from a master MT5 trade opening to a follower MT5 trade opening. An API2Trade order response is **not** treated as independent MT5 confirmation. No live-money or demo test order is authorized by this document.

## Instrumentation now in the worker

- Each OPEN copy response logs the master broker timestamp (when usable), source detection path (`websocket` or `rest`), event-storage latency, follower preflight, durable reservation, API2Trade session/send time, and response time. Unknown or skewed timestamps are `null`, never zero.
- The API2Trade v1 source counts WebSocket messages, meaningful signals, complete snapshots, ignored frames, resulting events, REST reads/events, and changes first found by the safety poll. An `OK`/heartbeat does not count as an order update in these diagnostics. Set `API2TRADE_STRICT_ORDER_STREAM=true` only for a controlled demo pilot to let a missed order update trigger the existing ten-minute fast-REST safety window even when heartbeats continue; the default leaves the production polling load unchanged.
- Troubled streams log these counters at most once per minute. Set `WSA_COPY_STREAM_DIAGNOSTICS=true` only for a bounded observation window to log healthy streams too; with many accounts this is high-volume. It does not alter execution.
- Run `npx tsx scripts/report-copy-latency.ts --days 7 --limit 500` against an authorized database environment for a read-only broker-synced `trades.opened_at` correlation. It reports match coverage and p50/p95/p99/worst per follower. Incomplete sync or mismatched tickets reduce coverage, not latency. Use a limited time window to avoid large query loads.

The 2026-10-27 read-only seven-day baseline was 20/20 matched links: one follower had 12 samples (p50 1,360 ms, p95 2,750 ms), the other 8 (p50 1,279 ms, p95 2,797 ms). This is a small historical sample, not a post-release measurement or an SLA. The worker's earlier representative trace showed roughly 365 ms source detection, 279 ms event storage, 276–289 ms follower preparation/reservation, and 73/147 ms provider response. Inspect the stage logs after release to see whether those components changed.

## Safe rollout and acceptance

1. Deploy the tracing and stream-detection change to a controlled worker. Keep the existing REST safety poll and durable reservation. Watch the worker for errors, WebSocket discovery rate, duplicate-link conflicts, account reconnection, and broker request failures. If stream load increases, revert the code change rather than silently disabling the safety net.
2. Confirm the actual Supabase project region in the Supabase dashboard and the worker's AWS region in EC2. Measure database RTT on the London worker and establish a second, authorized London-project benchmark before choosing a migration. DNS geolocation alone is an inference, not region proof.
3. For each approved demo master/follower pair, record master broker time, source detection, event store, follower preflight, reservation, provider response, and follower broker-open time. Report p50, p95, p99, worst, coverage, failures, and safety-poll discovery rate. Compare the same account pair before/after each change. No live-money tests.
4. Test duplicate/out-of-order stream frames, stream loss, process restart, risk blocks, all lot-scaling modes, OPEN/MODIFY/CLOSE, and account disconnect. Require zero duplicate orders and no weakened gates.

The API2Trade v2 WebSocket is a separate, **shadow-only demo pilot** if API2Trade confirms entitlement and provides a v2 API key plus account mapping. The current production connection uses a v1 Pro dedicated host with Basic authentication, not a v2 API key. A v2 connection must not replace execution or disable the v1/REST source until completeness and latency have been measured. [API2Trade authentication](https://docs.api2trade.com/docs/authentication) and [v2 WebSocket topics](https://docs.api2trade.com/docs/api-v2/websocket) describe the differing credentials and `positions`/`trades` topics.

## Region move — separate approval required

A London project would be a new Supabase project and logical migration; a project's region cannot be changed in place, and a project clone retains its original region. Before creating a paid project or changing production: inventory extensions, schema/migrations, auth users and identities, storage buckets/objects, RLS, Realtime, secrets, integrations, and backup/restore. Test the complete copy path against a non-production London project and demonstrate a material gain before asking for a production cutover.

For an approved cutover: pause master trading, drain and reconcile outstanding copied orders, migrate and verify row counts/permissions/storage/auth, switch web and all workers together, run read-only reconciliation, then resume master trading. Keep the old project available for rollback until reconciliation is complete. [Supabase region guidance](https://supabase.com/kb/troubleshooting/change-project-region-eWJo5Z) and [migration guidance](https://supabase.com/docs/guides/platform/migrating-within-supabase) apply.

No paid project, production migration, or test order is performed by the instrumentation change. Manual Terminal-page direct-lane timing is a separate path and does not measure master-to-follower copying.
