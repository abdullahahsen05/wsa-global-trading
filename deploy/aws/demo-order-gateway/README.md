# Demo-only browser → AWS order pilot

This is a temporary, restricted experiment for measuring a broker-confirmed WSA Terminal order without the Vercel function hop. The AWS HTTP API is `10ceux5ih0` in `eu-west-2`, with only `POST /demo/open`. It is **not** a general trading API. The Lambda `wsa-demo-order-gateway` starts with `WSA_DEMO_ORDER_ENABLED=false` and is limited to the `test1` MetaQuotes-Demo account owned by the test trader, 0.01-lot **market opens only**. All other accounts and order types keep the existing Vercel path. The user closes the test position through the existing terminal route.

The browser's last state poll must have issued a signed WSA order pass for the same access token and account. The Lambda checks that pass, its 3-second risk clearance, the trader allowlist, and the request schema. It signs the existing direct-lane request to the AWS worker, which checks account ownership again and durably reserves `(user, clientRequestId)` before broker execution. A possibly delivered request is never retried on another route. A provably unsent request can fall back to the existing Vercel route with the same request ID. A confirmed new order gets an `audit_logs` entry. No broker password or worker signing secret reaches the browser.

The account and user IDs are set in Lambda environment, not trusted from the browser. The Lambda also holds the London Supabase service key to validate the existing pass and write the audit; it must remain a restricted AWS resource. This matches the current Vercel pass key fallback, which uses `SUPABASE_SERVICE_ROLE_KEY` when `WSA_ORDER_PASS_SECRET` is absent. If a dedicated pass key is configured on Vercel later, the Lambda must receive the same key or the pilot will fail closed.

The live site's `NEXT_PUBLIC_WSA_DEMO_ORDER_URL` and `NEXT_PUBLIC_WSA_DEMO_ACCOUNT_ID` only select this one experiment; they are public routing values, not secrets. The AWS HTTP API CORS allows only the WSA Vercel origin, and its stage is throttled. A safe invalid POST from the panel warms the browser preflight cache; it cannot reach the worker. A successful time report says `Route: browser → AWS demo pilot.` Compare several opens with earlier Vercel-route demo orders from the same device. The first request may include a cold start or uncached preflight.

Build the AWS Lambda package from the repo root:

```powershell
npx esbuild deploy/aws/demo-order-gateway/index.ts --bundle --platform=node --target=node22 --format=esm --tsconfig=tsconfig.json --outfile=output/demo-order-gateway/index.mjs
Compress-Archive -Path output/demo-order-gateway/index.mjs -DestinationPath output/demo-order-gateway-package.zip -Force
```

Disable the pilot without redeploying the site by setting `WSA_DEMO_ORDER_ENABLED=false` in the Lambda environment. The site will then receive an explicit `notSent` response and use its established Vercel route. Remove the two public Vercel environment variables and redeploy to remove the client-side pilot selection entirely.
