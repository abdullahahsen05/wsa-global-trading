# AWS London latency probe (staging, no orders)

This Lambda is deliberately **not** a trading gateway. The only routes are `GET /probe` and `GET /probe/worker`; neither accepts an order, a user session, or a broker credential. Both require `x-wsa-probe-key`. The second route makes one signed, TLS-pinned health request to the existing AWS copy worker and verifies its signed answer.

The AWS HTTP API is `bhe6dp0gl6` in `eu-west-2`, with the AWS-managed endpoint `https://bhe6dp0gl6.execute-api.eu-west-2.amazonaws.com`. Its `$default` stage is throttled to 2 requests/s (burst 3). CORS permits only `https://wsa-global-trading-platform.vercel.app`. The probe key is stored as SecureString at `/wsa/test/WSA_LATENCY_PROBE_KEY`; the worker signing secret remains in `/wsa/test/WSA_TRADE_DIRECT_SECRET`. Do not expose either to the browser, commit them, or paste them into a report.

Build the Lambda package from the repo root:

```powershell
npx esbuild deploy/aws/latency-probe/index.ts --bundle --platform=node --target=node22 --format=esm --outfile=output/latency-probe/index.mjs
Compress-Archive -Path output/latency-probe/index.mjs -DestinationPath output/latency-probe-package.zip -Force
```

For a read-only local comparison, with the `wsa-client` AWS profile signed in, run `node deploy/aws/latency-probe/compare.mjs`. This script fetches the key privately from SSM and does not print it. The Vercel comparison URL is a harmless `GET` on the order route; it cannot place an order. The AWS probe adds no broker execution, risk check, database reservation, or audit write, so these numbers are **not** an order execution benchmark. A browser cross-origin request also incurs a CORS preflight when uncached.

On 2026-10-28 from the local test machine, two warm batches (excluding the first two of each route) measured 332.5/369.5 ms via Vercel and 216/235 ms via AWS plus signed worker health. That suggests a possible warm network/hosting saving of about 117–135 ms, **not yet an achieved trading improvement**. An uncached browser-style CORS preflight to AWS took another 410 ms in the second batch, and individual requests varied widely. An actual order lane must retain subscription, ownership, risk, validation, durable idempotency, uncertain-result handling, and audit behavior before it can be enabled for a demo trial. No live order routing or API2Trade version was changed.
