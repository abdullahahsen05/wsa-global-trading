# WSA Global Trading — Architecture Analysis

> **What this is:** a senior-developer style static analysis of the whole code base, written *before* any change request, so that future changes do not break things that are connected in non-obvious ways.
> **Prepared:** 2026-10-10 from `wsa-global-trading-main_1.zip` (Next.js 16.2.6).
> **Method:** careful reading of `src/`, `scripts/`, `supabase/`, `deploy/`, `docs/`, `tests/`. **Nothing in the project was executed or tested, and no `.env*` file was opened on purpose** — one accidental search match on `.env.example` (7 example lines, no secrets) is disclosed in §16.7.
> **Updated 2026-10-11:** the account-performance chart / history API was rebuilt — see §6.8 and the change log in §20. Everything else is still the 2026-10-10 static analysis. Static checks (`tsc`, `eslint`, `vitest`) were run on the changed code; **nothing was run in a browser or against Supabase**.
> **Updated 2026-10-12:** the performance chart is now calibrated to each account's real dates (§6.8) and the Trading Terminal was rebuilt: a TradingView tab with a personal watchlist plus a new MetaTrader web-terminal tab, open at the same time (§6.9, risk R16, change log §20). Static checks only (`tsc`, `eslint`, `vitest` incl. jsdom component tests); **nothing was opened in a real browser and no MetaQuotes / TradingView page was loaded.**
> **Updated 2026-10-12 (later):** broker order times are normalised to UTC so the account curve matches its dates (§6.8), the MetaTrader pane detects MT4 vs MT5 and opens the account's own broker server instead of MetaQuotes' default one, TradingView opens with MA 50 + MA 200 and no volume plus an options panel (§6.9), and the Partner / IB module was audited and rebuilt (§12, R8, change log §20). Static checks only (`tsc`, `eslint` on the touched files, a focused `vitest` run); **nothing was opened in a real browser, nothing ran against a real database.**
> **Updated 2026-10-12 (fifth pass):** everything that reads or executes on a MetaTrader account is documented as ONE system on AWS (the web app on Vercel only holds the customer database): the **WSA Trade** order panel now goes through a **trade gateway** (the web app writes commands, the AWS copy worker executes them and publishes the live account picture - migration 060, §6.9), the terminal opens as a trade section (TradingView next to WSA Trade; open / modify / close / cancel / close-all; symbols in the broker's own spelling), self-copy was rebuilt with an activity log and an engine status (§9.8, migration 061), copy calibration (SL / TP / slippage / signal age / symbol matching) exists for self-copy and for strategy followers (§9.8, §9.10) and the copy path got another speed pass (§9.10). Static checks only (`tsc`, `eslint` on the touched files, a focused `vitest` run); **nothing ran against a real API2Trade, a real broker account, AWS or a browser.**
> **Updated 2026-10-19 (sixth pass):** WSA Trade lost its Confirm step (one click is the command), the order path from the browser to the broker and back was tuned end to end and now reports **where the time went** on every order (§6.9, change log §20), and the panel fits its room (in-panel zoom, auto-fit, draggable divider). No migration. Static checks only (`tsc`, `eslint` on the touched files, a focused `vitest` run); **nothing was measured live, nothing ran against a real API2Trade, AWS or a browser.**
> **Legend:** `[code]` verified in source · `[docs]` taken from repo docs (some are stale) · `[infer]` reasoned, not directly proven · `[verify]` must be checked on the live system (Supabase / Vercel / AWS), because the repo cannot prove it.
> **Truth order:** source code > migrations > `deploy/` > `docs/*.md` (docs describe Prisma, "no worker", `middleware.ts`, MetaApi — all outdated).

---

## 0. Përmbledhje në shqip (short summary)

**Çfarë është:** një platformë multi-rol për menaxhim të llogarive të tregtimit (MT4/MT5), copy trading, partnerë (IB), admin dhe klientë (tradera).

**4 pjesët që punojnë së bashku në prodhim**
1. **Vercel** — aplikacioni Next.js (faqet + 241 API route). Pa gjendje (stateless).
2. **Supabase** — Postgres (me RLS), Auth (cookie), Realtime, Storage (bucket privat `bot-files`). Është "e vetmja burim i së vërtetës".
3. **AWS EC2 (eu-west-2)** — 3 shërbime systemd (`wsa-copy-worker`, `wsa-risk-worker`, `wsa-background-worker`) që ekzekutojnë **të njëjtin repo (`main`)**. Ky është "sistemi i copytrading i hostuar diku tjetër". Ai hap urat me brokerin, kopjon tregtitë, llogarit rrezikun dhe procesion punët e sfondit.
4. **API2Trade (mt4api.dev)** — ura REST/WebSocket drejt brokerave MT4/MT5. Plus: **Stripe** (pagesa), **Gemini/OpenAI** (asistenti AI), **dxFeed** (terminal tregu).

**Rregulla të arta**
- Çdo ndryshim në `src/lib/**` ndikon **edhe workerët LIVE në AWS** sapo ata të bëjnë pull nga `main` → trajtoje si ndryshim në prodhim.
- Faqja lokale përdor **Supabase-in që i jep ti në `.env.local`** — nëse është ai i prodhimit, çdo veprim lokal ndryshon të dhëna reale. Workerët **nuk niset kurrë** nga `.bat` (rrezik ekzekutimi të dyfishtë të tregtive).
- `ENCRYPTION_KEY` lokal duhet të jetë **i njëjtë** me atë të Vercel/AWS (kredencialet e brokerit dhe çelësat AI janë të enkriptuar me të).
- Mos ekzekuto asnjëherë: `npm run migrate`, `seed:*`, `scripts/reset-users.ts`, `npm start`, `npm run test:e2e` kundër bazës së prodhimit.

**Rreziqet kryesore (detaje në §17):** (1) politika RLS e `profiles` nuk e mbron `role` nga vetë-ngritja — **verifiko menjëherë në Supabase-in live**; (2) fjalëkalimi i DB shkruar hapur në `BACKEND_SETUP.md` (rrënja e projektit, rreshti 29) — **rotoje**; (3) `BILLING_PROVIDER` bie në `mock` nëse mungon dhe `/api/billing/mock-confirm` nuk ka mbrojtje; (4) cache 5-minutëshe në motorin e copy trading → "emergency stop" mund të vonojë; (5) webhook-u i Stripe i gëlltit gabimet dhe nuk riprovohet.

**Ndryshime pas analizës (2026-10-11/12):** grafiku i performancës u ndërtua nga e para (§6.8) dhe Terminali tani ka dy skeda që hapen njëkohësisht — TradingView dhe MetaTrader web (§6.9). Kufijtë e vërtetë: TradingView nuk lejon login brenda faqes tonë (`frame-ancestors 'none'`, plus kushtet e përdorimit), ndaj ofrojmë watchlist personale në WSA dhe butonin "Open on TradingView"; MetaTrader pranon në adresë vetëm numrin e llogarisë dhe serverin, jo fjalëkalimin — fjalëkalimi shkruhet një herë në terminal. Porositë e dhëna nga terminali MetaTrader anashkalojnë rregullat e rrezikut të WSA deri në sinkronizimin tjetër (R16).

**Faza e pestë (2026-10-12, mbrëma):** gjithçka që lidhet me MetaTrader (leximi i të dhënave, hyrja e llogarive, copy trading, self-copy, ekzekutimet) jeton në AWS; Vercel mban vetëm faqen dhe Supabase vetëm bazën e klientëve. Prandaj paneli **WSA Trade** nuk flet më me urën e brokerit nga Vercel: faqja shkruan një *komandë* në Supabase (`trade_commands`, migrimi 060), punëtori i copy-trading në AWS e merr brenda ~100 ms, e ekzekuton përmes sesionit që e ka tashmë me API2Trade dhe shkruan përgjigjen; i njëjti punëtor publikon gjendjen e llogarisë (bilanci, pozicionet, urdhrat në pritje, çmimi) për llogaritë që po shihen. Terminali hapet si seksion tregtimi (grafiku TradingView majtas, WSA Trade djathtas: hap, modifiko, mbyll, anulo, mbyll të gjitha; simbolet vijnë nga API2Trade me emrin e brokerit). Self-copy u rindërtua (log aktiviteti për çdo pozicion, statusi i motorit, "Check route") dhe kalibrimi (SL/TP, slippage, mosha e sinjalit, përputhja e simboleve) vlen tani edhe për ndjekësit e strategjive (migrimi 061). Shpejtësia: lidhjet me Supabase mbahen hapur dhe ngrohen paraprakisht, paralelizmi i porosive 24→48, gateway-i pyet çdo 100 ms. **Kujdes:** një porosi e dhënë nga një faqe lokale kalon përmes Supabase-it të përbashkët te punëtori i AWS dhe është REALE. Skriptet Pine të TradingView nuk mund të ngarkohen në embed-in e tyre (kufizim i TradingView). Asgjë nuk u provua kundër API2Trade-it real, AWS-së ose shfletuesit (§20, "fifth pass").

**Faza e gjashtë (2026-10-19):** në WSA Trade u hoq hapi "Confirm" (Buy, Sell, Close, Delete dhe "mbyll disa" janë një klik), rruga e porosisë nga shfletuesi te brokeri dhe mbrapsht u përshpejtua (AWS: zinxhirë të ndarë leximi/porosie, MODIFY përdor pamjen e freskët, rilexim i menjëhershëm + çdo 350 ms pas porosisë; web: kontrollet paralele, auditi pas përgjigjes, "ngrohja" e route-ve, pyetje çdo 400 ms pas porosisë, listat përditësohen menjëherë nga përgjigja) dhe çdo porosi tani tregon **ku shkoi koha** (rrjeti · serveri web · radha · brokeri · transmetimi). Paneli përshtatet me hapësirën (zoom brenda panelit −/Auto/+, ndarësi i tërhiqshëm midis grafikut dhe panelit). Pa migrim. Asgjë nuk u matën live (§20, "sixth pass").

---

## 1. System at a glance

```
                       Browser  (Trader / Partner / Admin)
          React 19 client pages + react-query  ──  Supabase Realtime (WebSocket, user JWT, RLS)
                              │  fetch /api/*  (+ Supabase auth cookies)
                              ▼
┌──────────────── Vercel ────────────────┐   anon+cookie (RLS)        ┌──────────── Supabase ─────────────┐
│ Next.js 16 App Router                  │   service-role (bypass)    │ Postgres + RLS · Auth · Realtime  │
│  • 65 pages (almost all client comps)  │ ─────────────────────────▶ │ Storage (private bucket bot-files)│
│  • 241 route handlers  /api/*          │ ◀───────────────────────── │ RPCs: claim_background_jobs,      │
│  • src/proxy.ts  (per-IP rate limit)   │                            │ record_account_snapshot, op. locks│
└───┬──────────┬──────────┬──────────────┘                            └──────▲───────────────▲────────────┘
    │          │          └─ Stripe  (Checkout + signed webhook)             │               │ service-role
    │          └─ AI providers  (Gemini / OpenAI, server-side only)          │        ┌──────┴──────────────────────┐
    └─ API2Trade REST (connect / sync / orders) · dxFeed (terminal proxy)    │        │ AWS EC2 eu-west-2 (systemd) │
                                                                             │        │  wsa-copy-worker            │
              API2Trade  (mt4api.dev, REST + OnOrderUpdate WebSocket)  ◀─────┼────────│  wsa-risk-worker            │
              ──▶ MT4 / MT5 broker servers                                   │        │  wsa-background-worker      │
                                                                                      │  same repo `main`, SSM secrets
                                                                                      └─────────────────────────────┘
```

**One sentence per arrow**
- *Browser → Vercel:* all UI data comes from `/api/*` JSON (`{ok:true,data}` / `{ok:false,error:{code,message}}`); the browser also talks **directly to Supabase** for login (`signInWithPassword`), reading its own `profiles.role`, and Realtime change notifications.
- *Vercel → Supabase:* route handlers authenticate with the cookie client (`@supabase/ssr`) and then do almost all data work through the **service-role admin client** (bypasses RLS) after a role guard.
- *Vercel → API2Trade:* user-triggered actions only (connect account, verify, sync, discover brokers/servers). **Manual orders are no longer sent from Vercel (fifth pass, 2026-10-12):** the WSA Trade panel writes a command row to Supabase and the AWS copy worker executes it (the "trade gateway", §6.9); the web tier only keeps a `direct` fallback for a single-box install that has the bridge and the execution switch itself.
- *AWS workers → API2Trade / Supabase:* continuous streams and polling loops (copy, risk, jobs). **They are the only place that runs copy trading, self-copy and the WSA Trade gateway continuously** - i.e. everything that reads or executes on a MetaTrader account lives on AWS; the web app and the customer database (Supabase) are the other half.
- *Stripe → Vercel:* `POST /api/webhooks/stripe` (signature-verified) provisions paid access.

---

## 2. Runtime topology — who owns what

| Component | Hosting | Entry point | State it owns | Secrets it holds |
|---|---|---|---|---|
| Web app (UI + API) | **Vercel** (prod URL `wsa-global-trading-platform.vercel.app`) [docs] | `next build` / route handlers | none (stateless, per-instance in-memory rate-limit only) | Supabase service-role, `ENCRYPTION_KEY`, Stripe keys, API2Trade creds, AI keys, `WORKER_SECRET` (Vercel env) |
| Database / Auth / Realtime / Storage | **Supabase** (project ref in `docs`, not repeated here) | SQL migrations `supabase/migrations/*` | all business data | service-role key, JWT secret, DB password |
| Copy / Risk / Jobs workers | **AWS EC2 eu-west-2**, systemd units `deploy/aws/*.service`, user `wsa`, dir `/opt/wsa/app` [code]. The **copy worker also hosts the WSA Trade gateway** (executes the web app's order commands, publishes the live account picture; `src/lib/gateway/*`, migration 060) **and the self-copy engine** (`src/lib/copy/selfCopy*.ts`, migration 061) | `scripts/wsa-copy-worker.ts`, `wsa-risk-worker.ts`, `wsa-background-worker.ts` via `deploy/aws/wsa-worker-start.sh copy|risk|jobs` | in-memory caches + stream sessions; all durable state in Supabase | read from **AWS SSM** `/wsa/test/*` at start (Supabase URL+service role, `ENCRYPTION_KEY`, `API2TRADE_*`, optional `METAAPI_TOKEN`) |
| Broker bridge | **API2Trade** (mt4api.dev; default base `https://mt5.mt4api.dev`) | `src/lib/broker/api2TradeClient.ts` | broker sessions/tokens | one platform-level username/password (`API2TRADE_USERNAME/PASSWORD`) + per-account broker login stored encrypted in `broker_credentials` |
| Payments | **Stripe** | `src/lib/stripe/*`, `billingService.ts`, webhook route | customers, subscriptions, sessions | secret key, webhook secret, price ids |
| AI | **Gemini / OpenAI** | `src/lib/ai/*`, `aiProviderService.ts` | none | key in DB (AES-GCM) or env |
| Market data terminal | **dxFeed** (optional) | `src/lib/terminal/*`, `/api/dxfeed/*` proxy | none | `DXFEED_*` |

Key facts [code]:
- `deploy/aws/wsa-worker-start.sh` runs the workers with `NODE_ENV=production`, `BROKER_EXECUTION_ENABLED=true`, `WSA_COPY_ENGINE_ENABLED=true`, `WSA_RISK_ENGINE_ENABLED=true`, `WSA_COPY_WARMUP_MS=5000`, `WSA_COPY_POLL_MS=100`, `WSA_BACKGROUND_ACCOUNT_SYNC_ENABLED=false`. It exports `BROKER_PROVIDER` but **the code ignores it** (`getBrokerProviderId()` is hard-coded to `"api2trade"`).
- The worker unit files `Restart=always`, so a crashing worker restarts after 10 s; the copy worker re-discovers strategies every 2 s.
- The deploy path is "git pull `main` on the EC2 box" [docs: `deployment.md`, `BACKGROUND_WORKER.md`] → **web and workers always share `src/lib/**`**. There is no staging environment in the repo.

---

## 3. Repository map

```
src/
  app/                    Next.js App Router
    layout.tsx            root: Manrope font → QueryProvider → AppShell
    page.tsx              redirect → /login
    (auth)/               login, register, forgot-password, reset-password
    (trader)/             16 sidebar modules + accounts/[accountId], billing/return, platform-preview (NO layout.tsx)
    (partner)/partner/    layout wraps <PartnerWorkspaceGate/> (client-side status gate)
    (admin)/admin/        layout = server guard requireAdmin() → redirect /dashboard
    (public)/certificates/verify/[verificationId]
    demo/                 public sample-data workspace (DemoAppShell), no API calls
    api/                  241 route handlers (see §7 and Appendix A)
  components/             49 files / ~11.6k lines  (app shell, copy, partner, charts, accounts, admin, demo, terminal…)
  hooks/                  useRealtimeUpdates, useTraderAccessSummary, usePerformanceSeries, useElementWidth
  providers/              QueryProvider, TradingAccountSelectionProvider
  lib/
    auth/                 session.ts (guards), rbac.ts, routeAccess.ts, passkeyConfig.ts, redirectOrigin.ts
    api/envelope.ts       jsonOk / jsonFail / handleAuthError
    supabase/             server.ts (anon+cookies), admin.ts (service role), client.ts (browser)
    broker/               BrokerAdapter, Api2TradeBrokerAdapter, api2TradeClient, api2TradeLiveSource, provider.ts, (MetaApi legacy) · api2TradeTransport (keep-alive pool for the bridge AND for the database client, workers only), orderUpdateMessage, openPositions, quote, symbolList (the broker's symbol list in whatever shape the bridge answers), tradeRetcodes (a trade server's refusal as a sentence a trader can act on)
    copy/                 lotScaling, eligibility, settings, executionPriority, types · engine pieces shared with the AWS copy worker: pool, keyedChains, streamPump, masterEvents (§9.9) · calibration, strategyCalibration, followerSymbols (§9.10) · the self-copy engine: selfCopyEngine, selfCopyDecision, selfCopyEvents, selfCopySources, selfCopyStore, selfCopyEngineStatus, selfCopyView, activityLog (§9.8)
    gateway/              WSA Trade gateway (fifth pass, §6.9) - shared with the AWS copy worker: tradeCommands (command kinds + validation), tradeExecutor (runs one command through the broker adapter), gatewayWorker (poll / state loops), gatewayQueue (web side: enqueue, wait, watch), gatewayStore + gatewayDb (Supabase access, "migration 060 missing" detection)
    trade/                pure rules of the WSA Trade panel: webTrade (types, symbol / lots / level rules), webTradeFormat, webTradeGuard, webTradeSchemas (zod), symbolMatch (chart symbol <-> broker symbol), ticketMath
    services/             ~45 service modules = all business logic (19k lines)
    charts/               performanceSeries, performanceChartSpec, svgCurve - PURE chart maths shared by server and browser (§6.8)
    workers/jobProcessor.ts   job-type dispatcher (used by web admin "run now" AND background worker)
    jobs/                 types, workerAuth (x-worker-secret)
    ai/                   providerTransport/Client, contextBuilder, rateLimit, systemPrompt, access
    terminal/             market-data provider selection + dxFeed proxy/config · TradingView widget config · MetaTrader web-terminal URLs / accounts · per-user workspace document (2026-10-12, §6.9)
    stripe/, payments/, crypto/brokerCrypto.ts, pdf/, partner/, accounts/, domain/, validation/schemas.ts, demo/, mappers/, data/
  proxy.ts                Next 16 "proxy" (ex-middleware): ONLY in-memory per-IP rate limiting for /api/*
scripts/                  dev.ts (npm run dev), 3 workers, run-migrations, seeds, reset-users, setup-stripe-products, verify-metaapi-runtime
deploy/aws/               systemd units + wsa-worker-start.sh + bootstrap-worker.sh
supabase/migrations/      001…061 (003/004 missing; 057 = optional margin columns, 058 = optional chart sampling functions, 059 = optional cash flows + broker web-terminal directory, 060 = optional trade gateway, 061 = optional self-copy activity + strategy-follower calibration) + 2 timestamped files
tests/                    unit (59 vitest files, incl. jsdom component tests) · e2e (5 playwright specs, port 4321)
docs/                     older docs (partly stale) + this analysis
```

Other root files worth knowing: `AGENTS.md` (“This is NOT the Next.js you know — read `node_modules/next/dist/docs/` before coding”), `CLAUDE.md` (imports AGENTS.md), `next.config.ts` (only `serverExternalPackages` for the legacy MetaApi SDK), `sync-direct.mjs` / `sync-new-master.mjs` (legacy ad-hoc MetaApi scripts with a hard-coded Windows path — **do not run**), `AURIX_*.txt` (old context dumps from the former “Aurix” name of the project).

---

## 4. Authentication & authorization

### 4.1 Roles and statuses [code: `lib/auth/rbac.ts`, `session.ts`]
- `profiles.role` ∈ `TRADER | PARTNER | ADMIN | SUPER_ADMIN`; `profiles.status` ∈ `ACTIVE | SUSPENDED | PENDING`.
- `isAdmin(role)` = ADMIN or SUPER_ADMIN. Only `SUPER_ADMIN` may manage AI provider keys (`requireSuperAdmin`, 4 routes under `/api/admin/ai/providers`).
- SQL helper `is_admin()` = role ADMIN/SUPER_ADMIN **and** status ACTIVE (migration 025). `is_active_user()`, `is_partner()` also exist.
- Sign-up trigger `handle_new_user` (migration 034): metadata `role = 'PARTNER'` → creates `partner_profiles` with `PENDING_REVIEW`; anything else → `TRADER` + `trader_profiles`. A `referral_code` in the metadata assigns `trader_profiles.partner_id` if that partner is ACTIVE. A user can **not** sign up as ADMIN through metadata.

### 4.2 The five enforcement layers
| # | Layer | What it really does |
|---|---|---|
| 1 | `src/proxy.ts` | In-memory sliding window **per IP per serverless instance** for `/api/*` (stripe-webhook 240/min, worker 90, ai 30, auth 45, billing mutations 20, broker-sync 18, admin read 240 / write 90, other write 75, other read 360). Weak by design (not shared between instances). **No auth logic.** |
| 2 | `AppShell` (client, root layout) | Calls `/api/auth/session` (react-query key `auth-session-shell`); no session ⇒ redirect `/login?next=…`; wrong workspace ⇒ `workspaceRedirect()` (admin→/admin, partner→/partner, else /dashboard). Shell-free routes: `/login /register /forgot-password /reset-password /certificates/verify/* /demo*`. |
| 3 | Server layouts | **Only** `(admin)/admin/layout.tsx` is a real server guard (`requireAdmin()` → redirect `/dashboard`). Partner layout is a *client* gate (`PartnerWorkspaceGate` → `/api/partner/profile`). Trader pages have **no** server guard, except `accounts/[accountId]/page.tsx`. |
| 4 | Route handlers | `requireAuth` (blocks SUSPENDED only — PENDING passes), `requireTrader` (admins allowed too), `requireAdmin`, `requireSuperAdmin`, `requirePartner`, `assertCanAccessAccount(accountId)` (admin = any; trader = own), `authorizeWorker(request)` (see §14). Distribution over the 227 routes: 112 requireAdmin · 67 requireAuth · 17 requireTrader · 12 requirePartner · 5 requireAuth+assertCanAccessAccount · 3+1 requireSuperAdmin · 1 mixed requireAdmin/requireAuth (`risk/rules`: GET any user, POST admin) · 2 authorizeWorker · 1 Stripe signature · 1 getCurrentUser · **5 intentionally public** (passkey login options/verify, referral validate, certificate verify, license verify). |
| 5 | Database | RLS on all tables for anon-key/JWT access (Realtime, direct PostgREST, login/profile reads). Services use the **service-role client**, which bypasses RLS — so the correctness of those services’ own `user_id`/`partner_id` filters is what protects data. |

> Consequence: **UI gating is not security.** Trader/partner pages are client components; real protection is layer 4 (+5). The “platform subscription” paywall is also mostly UI-level (§11).

### 4.3 Login flows [code]
- **Password:** `LoginPage` (client) → `supabase.auth.signInWithPassword` (browser client; cookies via custom `browserCookies()` that supports “remember me” through `localStorage['wsa-remember-session']`) → reads own `profiles.role` through RLS → `router.replace(roleHome(role))`.
- **Passkeys (WebAuthn):** only `TRADER` + `ACTIVE`. `/api/auth/passkeys/login/options|verify` → challenge rows in `user_passkey_challenges` (one-time, replay-blocked) → on success the server calls `admin.auth.admin.generateLink({type:'magiclink'})` and `verifyOtp` on the cookie client to mint the Supabase session. Config: `NEXT_PUBLIC_APP_URL` (default `http://localhost:3000` outside production), `WEBAUTHN_RP_ID` (must equal/parent the hostname), `NEXT_PUBLIC_WEBAUTHN_RP_NAME`.
- **Email links** (reset password / confirmation): `getAuthRedirectOrigin()` **ignores localhost** and falls back to `NEXT_PUBLIC_SITE_URL` → `NEXT_PUBLIC_APP_URL` → hard-coded production origin. So password-reset/confirmation emails triggered from a local run point to **production**.
- **Roles → home:** admin `/admin`, partner `/partner`, trader `/dashboard`.

### 4.4 Supabase clients [code: `lib/supabase/*`]
| File | Key | Used for |
|---|---|---|
| `client.ts` | anon, browser | login, own-profile read, Realtime subscriptions |
| `server.ts` | anon + request cookies (RLS) | `getCurrentUser()`, `assertCanAccessAccount`, a few user-scoped writes (`/api/auth/profile`) |
| `admin.ts` | **service role** | all services/workers; throws `Missing Supabase admin environment variables` if URL/key are absent |

---

## 5. Data model (Supabase / Postgres)

`supabase/migrations/` holds 001…061 (**003 and 004 are missing**; `057` is the optional margin migration, `058` the optional chart-sampling functions, `059` the optional cash flows + broker web-terminal directory, `060` the optional trade gateway and `061` the optional self-copy activity + strategy-follower calibration - all of 2026-10-11/12 and applied by hand) plus two timestamped files (`20260914173557_platform_equity_timeline.sql`, `20260923070000_allow_risk_percent_scaling_mode.sql`). `scripts/run-migrations.ts` only matches `/^\d{3}_.+\.sql$/`, so **the two timestamped files are never applied by it**, it has a hard-coded production host, and the chain cannot rebuild a fresh database (006 uses a column created in 010; 022 re-creates `subscriptions` that already exists from 001). **The live database was evolved by hand — treat the live schema, not the repo, as the truth, and never use `npm run migrate` to bootstrap anything.** [code] `[verify]` live schema drift.

### 5.1 Tables by domain
| Domain | Tables (key facts) |
|---|---|
| Identity | `profiles` (id = `auth.users.id`; email, full_name, role, status, `stripe_customer_id`) · `trader_profiles` (user_id, **`partner_id`**, `partner_assigned_at`, segment e.g. FUNDED) · `partner_profiles` (user_id, `referral_code`, status `PENDING_REVIEW/ACTIVE/…`, commission %) · `user_settings` (timezone…) · `user_passkeys`, `user_passkey_challenges` |
| Trading | `trading_accounts` (provider, `provider_account_id`, broker_name/server/platform, `broker_provider_id`, `account_usage` TRADER·COPY_MASTER·EVALUATION, status PENDING·CONNECTED·SYNCING·DISCONNECTED·RESTRICTED·INACTIVE, `last_synced_at`, `sync_error`, `equity_peak`, `risk_restricted_at`, `deactivated_at`) · `broker_credentials` (AES-GCM payload, 1 row per account) · `account_snapshots` (balance, equity, floating_pnl, drawdown_percent, captured_at - **one row every ~5 s per connected account**, written by the risk worker; optional `margin`, `free_margin`, `margin_level` after migration 057) · `trades` (**unique `(trading_account_id, external_trade_id)`**, short id) · `daily_account_metrics` · `broker_providers`, `broker_servers` (catalog) · `broker_operation_logs` · views `latest_account_snapshots`, `account_open_trade_counts` |
| Risk | `risk_rules` (action WARN·LIMIT·RESTRICT; platform and per-account) · `risk_events` · `account_risk_states` (blocked_new_trades, restricted) · `notifications` |
| Copy trading | `copy_strategies` (status, mode, `live_enabled`, `engine_status`, `engine_heartbeat_at`, master account) · `copy_master_events` (**unique `dedupe_key`**) · `copy_strategy_followers` (settings, `copy_enabled`, status, consent; **`calibration jsonb default '{}'`** after migration 061 - `{}` = the platform defaults = the behaviour followers always had) · `copy_execution_logs` · `copy_global_settings` (single row: copyEnabled, liveCopyEnabled, emergencyStop…) · `copy_account_rules`, `copy_rule_events` · `copy_trade_links` (**unique `(source_event_id, follower_account_id)`** → idempotent execution) · `self_copy_relationships` (LIVE·PAUSED·ARCHIVED; **`engine_status` STARTING·LIVE·ERROR, `engine_error`, `engine_heartbeat_at`** after 061 - written by the copy worker while it listens to the route's source account), `self_copy_trade_links` · **`self_copy_events`** (061: one row per decision of the self-copy engine - COPIED·SKIPPED·FAILED with a code, a message, the symbol pair, volumes and a `timings` breakdown; written in batches by the worker, owner or admin may read, pruned after 14 days) |
| Trade gateway (060) | **`trade_commands`** (what the web asks the AWS system to do on a trading account: kind OPEN·CLOSE·MODIFY·CANCEL·CLOSE_BULK·STATE·SYMBOLS, `payload`, **unique `(user_id, client_request_id)`**, status PENDING→RUNNING→DONE·FAILED·EXPIRED, `result`, `expires_at` = +90 s; RPC `claim_trade_commands` with `FOR UPDATE SKIP LOCKED`) · **`terminal_account_state`** (the live picture of an account the AWS worker publishes while somebody watches it: `watch_until` +45 s, `watch_symbols`, `state` jsonb, `state_at`, `error`) · **`terminal_account_symbols`** (every symbol an account can trade in the broker's own spelling) · **`gateway_heartbeat`** (one row per AWS worker that runs the gateway). RLS is on and there are **no policies**: service role only; every web query filters by `user_id` explicitly |
| Queue / locks | `background_jobs` (**`unique_key`**, RPC `claim_background_jobs` with `FOR UPDATE SKIP LOCKED`) · `operational_locks` (RPC `try_acquire_operational_lock` / `release_operational_lock`) · `_migrations` |
| Billing | `billing_products` · `payment_orders` (+ Stripe ids) · `subscriptions` · `copy_account_entitlements` · `stripe_webhook_events` (idempotency log) |
| Partner finance | `partner_commissions` (**unique `purchase_id`** where not null) · `partner_payouts` · `partner_withdrawal_requests` (**one PENDING_REVIEW/APPROVED per partner+currency**) · `partner_withdrawal_allocations` · `partner_rebates` (**unique `(trade_id, calculation_type)`** + CPA partial unique, migration 054) · `partner_withdrawal_rebate_allocations` · `partner_broker_configurations` |
| Marketplace | `bot_products` · `bot_access_records` · `bot_licenses` (hash of key) · `bot_license_verification_logs` · `bot_file_releases` + Storage bucket `bot-files` (private) |
| Academy | `academy_courses/modules/lessons/lesson_progress/lesson_notes/instructor_remarks/lesson_materials/lesson_questions/webinars/webinar_attendance` |
| Evaluations | `evaluation_programs` · `evaluation_attempts` · `evaluation_checks` · `evaluation_certificates` (public `verification_id`) |
| AI | `ai_usage_logs` · `ai_user_limits` (limits + `ai_token_credits`) · `ai_provider_settings` (encrypted provider key) |
| Misc | `economic_calendar_events` · `terminal_provider_settings` (deny-all RLS) · `terminal_user_preferences` · `contact_requests` · `crm_notes`, `crm_activities` · `audit_logs` |

### 5.2 RPCs / functions
`set_updated_at`, `is_admin`, `is_active_user`, `is_partner`, `handle_new_user` (auth trigger), `deduct_ai_credits`, `topup_ai_credits`, `grant_initial_ai_credits`, `claim_background_jobs`, `record_account_snapshot(uuid,numeric,numeric)`, `record_account_snapshot_v2(uuid,numeric,numeric,numeric,numeric,numeric)` (migration 057, optional) and `platform_equity_timeline(uuid[],timestamptz)` (**execute only for `service_role`**), `try_acquire_operational_lock`, `release_operational_lock` (service_role only), `claim_trade_commands(text, integer)` (migration 060, service_role only, `FOR UPDATE SKIP LOCKED`, claims at most 50), `claim_trade_commands_wait(text, integer, integer)` and `await_trade_command(uuid, text, integer)` (migration 062, optional, service_role only: VOLATILE plpgsql loops that wait up to 5 s inside the database for a command to arrive / for a command to finish - see §6.9, seventh pass).

### 5.3 Realtime publication (migrations 002 · 045 · 050)
`account_snapshots, trades, risk_events, notifications, account_risk_states, trading_accounts, risk_rules, copy_execution_logs, copy_trade_links, copy_master_events, copy_strategy_followers, self_copy_relationships, self_copy_trade_links`. The browser subscribes with the **user’s JWT**, so RLS decides which rows a user is notified about. The client only uses these events to **invalidate react-query caches** (it never trusts the payload as data).

### 5.4 Idempotency / uniqueness that the code *relies on* (do not drop or loosen)
`trades(external_trade_id)` · `copy_master_events.dedupe_key` · `copy_trade_links(source_event_id, follower_account_id)` · `trade_commands(user_id, client_request_id)` (the same click sent twice is one command) · `background_jobs.unique_key` · `partner_commissions.purchase_id` · `partner_rebates` indexes · `idx_partner_withdrawal_one_active` · `stripe_webhook_events` event id · one-time passkey challenges. Code paths treat Postgres error `23505` as “already done”.

### 5.5 RLS summary and its gaps [code: `002_rls.sql` and later]
- **Good:** `broker_credentials` admin-only; billing tables (`payment_orders`, `subscriptions`, `copy_account_entitlements`, `stripe_webhook_events`) admin-write only; copy follower rows read-only for traders; partner finance tables admin-write.
- **Gaps (see §17 R1, R6):** `profiles_update_own_limited` has `WITH CHECK (id = auth.uid())` only — the comment says role/status are protected but nothing enforces it; `trading_accounts_insert_own/update_own` allow any column; `audit_logs_insert_service` is `WITH CHECK (true)` for every role; a few self-service tables (`academy_lesson_progress`, `academy_lesson_notes`, `user_settings`, `notifications`) allow own-row writes of any column.

---

## 6. Frontend architecture

### 6.1 Component tree and providers
```
RootLayout (Manrope) ─ QueryProvider (react-query: staleTime 60 s · gcTime 10 min · retry 1 · no refetchOnWindowFocus)
  └─ AppShell (client)
       ├─ shell-free routes (/login /register /forgot-password /reset-password /certificates/verify/* /demo*) → children only
       └─ authenticated shell:  ToastProvider → TradingAccountSelectionProvider → Sidebar(role) + Topbar + useRealtimeUpdates() + {children}
```
- `ADMIN` and `SUPER_ADMIN` are collapsed to UI role `ADMIN` in the shell; the server still distinguishes them.
- **Navigation** (`components/app/navigation.ts`): TRADER 16 items, ADMIN 17, PARTNER 8. Pages that exist but are *not* in the sidebar: trader `platform-preview`, `billing/return`, `academy/*` sub-pages; admin `/admin/traders`, `/admin/brokers`, `/admin/subscriptions`; partner `/partner/commissions`, `/partner/payouts`.
- **TradingAccountSelectionProvider** keeps the selected trading account **in memory only** (not persisted); `Topbar` auto-corrects it to the first live-connected account.
- **PartnerWorkspaceGate** (client): `/api/partner/profile` → shows notices for *not provisioned / PENDING_REVIEW / SUSPENDED*; the `/partner` overview page is exempt and renders its own states.

### 6.2 Data fetching and freshness
- Every page is a client component that `fetch`es `/api/*` and unwraps `{ok,data}` (exception: `accounts/[accountId]`, §6.4).
- Polling: Topbar `/api/trading-accounts` every 30 s (TRADER only, no background), `/api/notifications` every 60 s; `useTraderAccessSummary` polls `/api/billing/me` **every 5 s until the platform subscription is ACTIVE** (then stops).
- `useRealtimeUpdates()` opens 7 Supabase channels and invalidates these query keys: `trading-accounts`, `equity-curve`, `analytics-summary`, `trades`, `risk-events`, `risk-rules`, `notifications`, `admin-accounts`, `copy-master-accounts`, `copy-logs`, `admin-copy-logs`, `admin-copy-strategies`, `copy-my-subscriptions`, `self-copy-relationships`. **If you rename a query key in a page, update this hook too** or the page silently stops live-updating. Exception by design: `['account-performance', accountId, range]` (§6.8) is *not* invalidated by snapshot events (one every ~5 s would refetch ~120 queries over and over); the hook invalidates it debounced (8 s) on `trades` events and the chart polls every 60 s.

### 6.3 Pages ↔ APIs (main calls only; generated by scanning the source)
| Area | Page | Main API calls |
|---|---|---|
| Auth | `/login` | Supabase Auth (browser) + `/api/auth/passkeys/login/{options,verify}` |
| Auth | `/register` | `/api/auth/referral/validate`, Supabase signUp (metadata: role, referral_code) |
| Trader | `/dashboard` | `trading-accounts`, `trades`, `analytics/{summary,performance}`, `risk/rules`, `billing/me`, `auth/session` |
| Trader | `/accounts`, `/accounts/[id]` | `trading-accounts` (+`/{id}`), `…/broker-credentials`, `…/connection-status`, `…/sync`, `broker-servers/search`, `brokers/search`, `trades`, `analytics/performance` (detail page chart) |
| Trader | `/trades`, `/analytics`, `/reports`, `/risk`, `/calendar` | `trades`, `reports/trades`, `trader/sync-trades`; `analytics/*`; `reports/pdf`; `risk/{rules,events}`, `trader/daily-pnl`; `economic-calendar` |
| Trader | `/copy-trading` | `copy/strategies`, `copy/strategies/{id}/follow`, `copy/my-subscriptions`, `copy/subscriptions/{id}[/settings]`, `copy/logs`, `copy-trading/self-copy[/{id}]`, `billing/me` |
| Trader | `/billing`, `/billing/return` | `billing/me`, `billing/checkout`, `billing/portal`, `billing/return-status`, `billing/mock-confirm` |
| Trader | `/marketplace`, `/my-bots` | `marketplace/products[/{slug}[/request-access]]`, `my-bots[/{id}/download|licenses]`, `my-bots/licenses` |
| Trader | `/academy/**` | `academy/{courses,progress,webinars,lessons/{id}/{start,complete,notes,questions}}`, `contact-requests` |
| Trader | `/evaluations/**` | `evaluations/{programs,attempts,certificates}` (+ link-account, download) |
| Trader | `/ai`, `/terminal`, `/settings` | `ai/{chat,credits,chart-assistant}`; `dxfeed/*`, `terminal/*` (incl. `terminal/workspace`, `terminal/metatrader/{accounts,launch}` - §6.9); `auth/profile`, `auth/passkeys*`, `auth/session` |
| Partner | `/partner/**` | `partner/{profile,summary,traders,activities,risk-events,commissions[/export],rebates,withdrawals,payouts,crm/notes}` |
| Admin | `/admin/**` | 110 admin routes — users/roles/status, accounts (deactivate/reactivate/status), copy (master accounts, strategies publish/archive/simulate, rules, runtime, logs retry, events execute), jobs (list/enqueue/run-now/retry/cancel), billing purchases, partners (approve/reject/commissions/withdrawals/rebates/ledgers), marketplace, academy, evaluations, AI (usage/users/providers), terminal settings, audit, economic calendar, CRM, contact requests |
| Public | `/certificates/verify/{id}`, `/demo/**` | `certificates/verify/{id}` (public) · demo = static sample data |

Appendix A lists every one of the 241 routes with its HTTP methods and the guard detected in the route file.

### 6.4 Server vs client pages (important when adding guards)
All pages are `"use client"` **except** `app/(trader)/accounts/[accountId]/page.tsx`, which is a server component that (1) `requireAuth()`, (2) checks the platform-subscription paywall server-side, then (3) **fetches its own API** at `${NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/api/trading-accounts/<id>` forwarding the cookie. Consequences: on a dev machine the app **must run on port 3000 (or `NEXT_PUBLIC_SITE_URL` must match the real port)**, otherwise that page 404s; in production this is an extra HTTP hop through the public URL.

### 6.5 Paywall behaviour
UI: `PlatformSubscriptionLocked` ($50/month) is rendered by client pages when `useTraderAccessSummary().platformSubscription.status !== "ACTIVE"`.
Server-side enforcement exists **only** in: `POST /api/copy/strategies/{id}/follow`, `POST /api/copy-trading/self-copy`, `createCheckoutSession` for COPY_ACCOUNT products, and the `accounts/[accountId]` page. Every other trader endpoint (trades, analytics, reports, AI chat, `POST /api/trading-accounts`, broker credentials, sync) needs only a logged-in user — i.e. the paywall is cosmetic there and there is **no limit on how many accounts a user can create/connect**. `[infer]` intended by product? Decide before relying on it for revenue.

### 6.6 Demo area
`/demo/**` uses `DemoAppShell` + `lib/demo/*` static data; no broker, billing or API calls. The login page promotes it (“Explore the platform first”).

### 6.7 UI hot spots (by size) and known quirks
Largest components: `demo/DemoWorkspace` 1111 · `copy/SelfCopyPanel` 772 · `partner/PartnerFinanceWorkspace` 651 · `dashboard/CalendarTracker` 544 · `accounts/BrokerConnectPanel` 539 · `app/WorkspaceUI` 488 · `copy/FollowerSettingsDialog` 439 · `charts/TradingChart` 432 · `admin/AdminOverviewOverlay` 409.
Quirks: the login page links to `/security` and `/privacy`, which **do not exist** (404); `AppShell` flashes a loading state until `/api/auth/session` returns because pages are client-only.

### 6.8 Account performance chart and history API (reworked 2026-10-11)

**Where it shows.** Trader `/dashboard` ("Account performance curve" for the account selected in the top bar, plus the KPI sparklines), `/analytics`, `/accounts/[accountId]`, and admin `/admin` ("Platform oversight" = all connected accounts). One shared client component, `components/charts/AccountPerformanceChart.tsx`, with six tabs (**Chart · Growth · Balance · Profit · Drawdown · Margin**) and ranges **1D · 1W · 1M · 3M · 6M · 1Y · All**. `components/charts/TimeSeriesAreaChart.tsx` is the plain "money over time" variant (used by `dashboard/EquityCurve`).

```
account_snapshots  (risk worker, ~1 row / 5 s / connected account)  ┐
trades             (CLOSED, from broker sync)                        ├─▶ lib/services/performanceService.ts   (admin client, scoped by user_id unless ADMIN)
trading_accounts   (initial_balance, currency, equity_peak)          ┘            │
                                                                                  ▼
                       GET /api/analytics/performance?accountId=<uuid|ALL>&range=…      (private, no-store, 15 s server cache)
                                                                                  ▼
          hooks/usePerformanceSeries   key ['account-performance', accountId, range] · stale 20 s · poll 60 s
                                                                                  ▼
 lib/charts/performanceSeries.ts (deriveSeries: growth %, drawdown, closed-P&L steps) → performanceChartSpec.ts (axis / lines / legend / tooltip per tab) → SVG
```

**Why the old chart was flat or empty ("null" / 0) - all fixed**
1. PostgREST (Supabase) never returns more than **1000 rows** per request, so `.limit(10_000)` was really 1000. The risk worker writes a snapshot every ~5 s, so "the latest 1000 snapshots" covered only the last 1-3 hours: a handful of near-identical points, i.e. a flat line. `performanceService` now samples the whole life of the account - 480 evenly spaced samples in one round trip with the optional migration `058`, otherwise 240 indexed `limit 1` look-ups (`captured_at <= probe order by captured_at desc`) - pages closed trades with `.range()` (≤30 pages) and builds the "all accounts" curve in SQL (`platform_equity_samples` from `058`, else the hourly `platform_equity_timeline`).
2. The chart window was tied to the KPI period and growth was computed inside it; the old y-scale used `Math.max(range, 1)`, which flattened any % domain narrower than one point. The window is now its own control and every tab builds a round axis (`niceScale`) around what it really draws.
3. **Fabricated curves are removed** (a bell/sine "display curve" for empty or flat series, in `svgCurve.ts` and the admin page). Only recorded snapshots, closed trades and explicitly flagged estimates (`estimated: true`, drawn dotted) are shown. No snapshot and no trade = an explicit empty state.
4. KPI sparklines were empty; they now carry real balance / equity / floating series.
5. **Margin was never stored.** `Api2TradeBrokerAdapter.fetchSnapshot` now returns `margin / freeMargin / marginLevel` (API2Trade already sent them) and `accountSnapshotService.recordAccountSnapshot` writes them through `record_account_snapshot_v2` once migration `057` is applied; before that it silently uses the original `record_account_snapshot`. The Margin tab explains its empty state.
6. `analyticsService.getAnalyticsSummary` read trades with one capped query; it now pages (`loadScopedClosedTrades`, ≤10 000 rows).

**What the chart can and cannot know**
- It ends at the **last stored snapshot**. If the risk worker is stopped (always the case for the local launcher, `WSA_DEV_WORKERS=false`) or the broker connection is down, the line simply stops and a notice shows how old the last snapshot is. A freshly connected account needs a few minutes of worker time before a line exists.
- Before the first snapshot the balance is rebuilt from closed trades (dotted). Deposits and withdrawals are recorded since the third pass (below) - **but only after migration `059` is applied and the workers run the new code**; until then equity growth still jumps when money is moved.
- "All accounts" is one curve only if every account uses the same currency, and is limited to the last 40 days (the RPC returns hourly points; 40 × 24 stays under the 1000-row cap).
- `analyticsService` still computes its max drawdown from the newest ~1000 snapshots; the Analytics page merges the sampled-history drawdown to compensate.
- `account_snapshots` grows by ~17 000 rows per connected account per day and nothing prunes it. Decide on retention / down-sampling before the table gets large (not done).

**Calibration to each account's real dates (follow-up, 2026-10-12)**
- *Window.* `resolveWindow` gives every account its own window: a **live** account (newest data ≤ 15 min old, `PERFORMANCE_STALE_AFTER_MS`) runs up to "now"; an account whose recording stopped ends at its **last data** (snapshot or closed trade) and the chart says so ("ends at the last recorded data"). A fixed range (1D … 1Y) is counted back from that end and never starts before the first data point; "All" starts at the first data point. The date axis therefore only spans days that have data.
- *Detail.* One round trip returns 480 evenly spaced stored snapshots (migration `058`) plus the instants just before / after every closed trade (`buildTradeProbeTimes`), so a balance step is drawn where it happened; without `058` the same is read with 240 look-ups. Every sample is a stored `account_snapshots` row - nothing is interpolated.
- *Gaps.* Silence between neighbouring samples longer than `gapThresholdMs` (3 × the median spacing, never below 15 min: worker off, broker disconnected) is bridged by `fillSnapshotGaps` with **flagged estimates** rebuilt from the trades that closed inside the gap (`estimated: true`, drawn dotted) instead of one long straight line. An account with closed trades but no snapshots gets a dotted balance curve rebuilt from its trades; no data at all is an explicit empty state.
- *Trade history.* Closed trades are drawn as markers on the Chart tab (at most `MAX_MARKERS` = 150, toggle "Trade markers" in the legend) and as steps on the Profit tab.
- *Interpretation caveat.* The request ("dates too open, no exact curves, accounts with trade history") came without a screenshot; this reading of it was inferred from the code and the earlier screenshot. If the symptom is something else, start from `resolveWindow` / `fillSnapshotGaps`.

**Broker clock vs UTC (fixed 2026-10-12, "the curve does not match the dates")**
- MT4 / MT5 report order times in *broker server time* - wall-clock text without a zone (`2026-10-11T14:35:22`, usually UTC+2 / UTC+3, moving with DST). Read as UTC every trade landed hours away from the equity snapshots (real UTC `captured_at`), so balance steps, trade markers and the window no longer lined up.
- `lib/broker/orderNormalization.ts` (pure, shared with the AWS workers through `Api2TradeBrokerAdapter` / `api2TradeLiveSource`) now decides every order time: real UTC epochs from the bridge (`openTimestampUTC` / `closeTimestampUTC`) win; server-time text is converted with the offset the same payload reveals (learned from an epoch/text pair, quarter-hour grid, ≤ 14 h); placeholders (before 2000-01-01, epoch 0) and times more than 5 min in the future are dropped; zero-volume balance/deposit rows are not trades.
- `performanceService` and the chart sort and place trades by the normalised close time. **Already stored trades keep their old times until the next sync rewrites them** (`trades.external_trade_id` upsert); trades older than the provider's history window keep the old value.
- Rule: never read a broker order time with `new Date(text)`; go through `orderNormalization`.

**Data chain API2Trade → database → chart (third pass, 2026-10-12: "the platform has a problem taking in the account data, the charts look bad - check the chain and the maths")**

```
API2Trade (OpenedOrders · ClosedOrders · AccountSummary)
  → lib/broker/api2TradeClient.ts · Api2TradeBrokerAdapter.ts        typings now include commission / swap / fee
  → lib/broker/orderNormalization.ts                                  UTC times · orderNetProfit · extractCashFlows (deposits / withdrawals)
  → lib/broker/accountFigures.ts   readAccountFigures                 an AccountSummary must be complete and finite
  → lib/services/brokerSyncService.ts                                 trades upsert · snapshot · recordCashFlows      (loaded by the AWS workers!)
  → lib/services/accountSnapshotService.ts · accountCashFlowService.ts    account_snapshots · account_cash_flows (migration 059, optional)
  → lib/services/performanceService.ts → lib/charts/performanceSeries.ts → performanceChartSpec.ts → AccountPerformanceChart.tsx
```

What was wrong, and what each fix is (all covered by `tests/unit/chartDataIntegrity.test.ts`, 42 tests):
1. **The trade sync looked up the stored trades with one unpaged query.** PostgREST stops at 1000 rows, so beyond 1000 trades the rest looked "new", the insert hit `external_trade_id` and the error was swallowed - history silently stopped growing. Lookups are now paged (`selectAllPagesForIds`, id chunks of 100).
2. **Every closed trade was rewritten on every cycle.** Only rows whose values really changed are updated now; new rows are upserted on `external_trade_id`.
3. **Two snapshot writers for one moment.** `refreshAccountTrades(…, { snapshot })` reuses the reading the caller (the risk worker) already stored instead of asking the broker a second time and writing a second row.
4. **Garbage readings reached the curve.** An incomplete / non-numeric `AccountSummary` was stored as zeros. `readAccountFigures` throws `IncompleteAccountSummaryError`, `recordAccountSnapshot` refuses non-finite numbers, and the chart drops an isolated one-sample jump of more than 20 % that returns to within 8 % of the previous level (`dropGlitchSamples`; counted in `coverage.glitchSamplesDropped`, shown as a notice).
5. **Profit was gross.** Commission, swap and fee were ignored, so Profit and the balance steps did not match the broker's balance. `orderNetProfit` = profit + commission + swap (+ fee) is what the sync stores and what the Profit tab sums. **The field names `commission` / `swap` / `fee` are assumed** (the bridge's real payload was never seen); a missing field counts as 0, i.e. the old gross behaviour.
6. **Deposits and withdrawals were not known.** `extractCashFlows` picks the zero-volume balance operations out of the history (the same rows that are no longer counted as trades), `recordCashFlows` stores them idempotently (`account_cash_flows`, unique `(trading_account_id, external_id)`), `loadCashFlows` hands them to `performanceService` (DTO `cashFlows`, `coverage.cashFlowCount`, `cashFlowsSupported`). **The shape of the balance-operation rows is assumed as well.**
7. **Growth maths.** Growth used `value / first value - 1`, so a deposit counted as profit and a withdrawal as a drawdown. `deriveSeries` now chains a **time-weighted return**: from reading to reading `factor = (value - flow) / previous` (flow = money paid in/out in between), growth starts at 0 % at the first reading, drawdown is measured on the same chained index, and the gap-bridging / trade-based reconstruction (`reconstructEstimatedSamples`, `fillSnapshotGaps`) take the flows into account. The legends switch to "… without deposits / withdrawals" and a notice states how much was taken out when flows exist.
- Without migration `059` or before the workers run the new code: no flows are stored, the maths reduces to the old `value / first value - 1`, and the chart says nothing about flows (`cashFlowsSupported:false`).

**Chart periods, time axis and deep history (fourth pass, 2026-10-12: "the chart axes come out too small in data and time and do not follow the period the user / admin chose - check how the dates are processed and fetched")**
- *The axis was cut at the first data point.* A fixed range (1M, 3M, 6M, 1Y) was cut at the first data point of the account, so on a young account all of them drew the same short stretch and the axis did not show the period that was chosen. Now a fixed range (1D … 1Y) is **always counted back from the end of the window** (`resolveRangeStart`); `historyStartFor` marks where the account's data really begins, and the stretch before it stays on the axis - shaded, labelled "No data before …" and explained by a hint line under the chart - with nothing drawn or invented in it. "All" still starts at the first data point. The end of the window is "now" for a live account and the last stored data for a stale one (`resolveWindow`).
- *The history itself was only about 30 days deep.* The closed-orders list the bridge returns by itself is short and the dated fallback asked for 30 days, so an old account had 30 days of trades on the platform and 3M / 6M / 1Y were empty or estimates. `lib/broker/historyBackfill.ts` (pure, no Next / React imports, shared with the AWS workers) walks the dated order history backwards in 90-day windows (2 days of overlap, newest first) from the oldest order in hand until the horizon is reached (`API2TRADE_HISTORY_BACKFILL_DAYS`, default 365, `0` = off, max 3650), three empty windows in a row say there is nothing older, or the time budget of one sync is used up (`API2TRADE_HISTORY_BACKFILL_BUDGET_MS`, default 12 000, range 2 000 - 45 000). The next sync continues where this one stopped; a finished backfill repeats after 7 days, a failed window waits 10 minutes. `Api2TradeBrokerAdapter.fetchTradeHistory` runs it (progress per account in process memory, so a restart only costs one more pass; MT5 answers with positions, MT4 with orders - the endpoint that answered first is reused for the other windows) and merges the result with `mergeBackfilledOrders`. Any problem means "nothing older": the normal sync is never held up by it.
- *Dates on the axis.* `timeTicks` places calendar-aligned ticks (local-time days, month steps for long spans, multi-day steps aligned to local epoch days) and `timeAxisLabels` prints a second line wherever one line is ambiguous: clock times carry their date under the first tick and wherever the day changes, day labels carry the year under the first tick and wherever the year changes, and spans of more than four months put the year in every label ("Oct ’26"). Value axes still come from `niceScale` around what each tab really draws.
- *Live-impact notes.* Backfilled trades are stored as CLOSED rows like any other. **Partner rebates are calculated from stored trades that closed after `partner_assigned_at` (rule 18): for a client who was assigned to a partner long ago, older trades that are found now can create rebate rows retroactively at the next rebate calculation.** The extra requests happen inside the sync (risk worker / web sync) and cost at most the time budget once per account and week. The AWS workers get this only when they pull `main`. Tests: `historyBackfill`, `performanceSeries`, `performanceChartSpec`, `performanceService`, `chartDataIntegrity`.
- *Rule:* the axis is the period the person chose, not the span of the data. Never cut the window to the data (that was the bug).

**Rules for the next change**
- Do not read "all snapshots" with one query; go through `performanceService` or an aggregating RPC.
- `lib/charts/*` is pure and shared by server and browser: no React, Next or Supabase imports there.
- `performanceService`, the route, the hooks and the components are **web-only**. `accountSnapshotService`, `brokerSyncService`, `Api2TradeBrokerAdapter`, `domain/types.ts` and `scripts/wsa-risk-worker.ts` are loaded by the AWS workers: their change is **live when AWS pulls `main`**.
- Deploy order for margin: `057` (optional, manual) → web → workers. Any other order is safe (v2 → v1 fallback; the missing function is remembered for 10 minutes); skipping `057` only leaves the Margin tab empty.
- Migration `058` (optional, read-only, `service_role` only) adds `account_snapshot_samples(...)` and `platform_equity_samples(...)`. The service probes for them (PostgREST `PGRST202` / Postgres `42883` ⇒ fall back to look-ups) and remembers a missing function for 10 minutes (`RPC_CHECK_TTL_MS`). Without `058` the chart is the same, only built from more, smaller queries and with half the samples.
- Unit tests: `tests/unit/performanceSeries`, `performanceChartSpec`, `performanceService` (fake Supabase with the 1000-row cap), `svgCurve`, `accountSnapshotService`.

### 6.9 Trading Terminal - TradingView and the MetaTrader web terminal (added 2026-10-12)

**What it is.** `/terminal` (trader area) and `/admin/terminal` (admin area - since 2026-10-12 the very same `TerminalWorkspace` through the shared loader `TerminalWorkspaceLazy`; the market-data provider settings that used to be the admin page moved to `/admin/terminal/provider`) are one workspace with three panes that can be open **at the same time**: **TradingView** (chart plus optional watchlist / symbol-details / hot-list / economic-calendar side panels), **MetaTrader** (an embedded MT4/MT5 web terminal for the user's own accounts) and **WSA Trade** (a native order panel, below). A tab bar switches the view - *TradingView · MetaTrader · WSA Trade · Split*; the split shows the chart next to MetaTrader or next to WSA Trade, side by side or stacked. **Since the fifth pass the terminal opens as a trade section** - the Split view with the TradingView chart on the left (analysis) and WSA Trade on the right (trade rules and executions); picking a symbol in the panel opens the chart on the matching TradingView symbol and the reverse (`lib/trade/symbolMatch.ts`). A pane is created the first time it is shown and then **kept alive**: switching tabs hides it (inert, not unmounted), so the chart is not rebuilt and the MetaTrader session is not logged out.

```
app/(trader)/terminal/page.tsx            dynamic import, titles
  └─ components/trading/TerminalWorkspace.tsx      tabs · split · keep-alive panes · "Saving… / Layout saved" indicator
       ├─ components/charts/TradingChart.tsx            TradingView toolbar: symbol · timeframe · panel toggles · watchlist editor · "Open on TradingView"
       │    ├─ components/trading/TradingViewAdvancedChart.tsx    free TradingView embed script, config from lib/terminal/tradingview.ts
       │    └─ components/trading/TradingViewWatchlistEditor.tsx  personal watchlist (≤ 30 symbols)
       ├─ components/trading/MetaTraderTerminal.tsx     account picker · "+ Add manually…" · source · "Reconnect automatically" · sandboxed iframe
       └─ components/trading/WsaTradePanel.tsx          WSA Trade: account · figures · symbol picker · order ticket (market / limit / stop) · positions · pending orders · close-several bar · trade rules
            ├─ components/trading/wsaTrade/{Book,SymbolPicker,TradeSettings,ui}.tsx    positions + pending orders + bulk bar · broker symbol list with search · the person's trade rules · shared bits
            └─ hooks/useWebTrade.ts                          accounts / state (2 s poll while open) / symbols queries + the order calls
lib/trade/{webTrade,webTradeFormat,webTradeGuard,webTradeSchemas,symbolMatch,ticketMath}.ts   pure rules of the panel (chart symbol <-> broker symbol, level / lot checks, bulk previews)
lib/services/webTradeService.ts                      server only: gates + route choice (gateway | direct | none) + audit
lib/gateway/*                                        command rows, waiting for the answer, the AWS-side worker and executor (migration 060)
hooks/useTerminalWorkspace.ts    GET / PATCH /api/terminal/workspace - 700 ms debounce, minimal patches, device copy in localStorage `wsa.terminal.workspace.v1`
hooks/useMetaTraderAccounts.ts   GET /api/terminal/metatrader/accounts · POST …/launch · POST …/resolve (useBrokerWebTerminal)
lib/terminal/{workspace,metatrader,tradingview}.ts   pure: document shape + sanitizers, URL builders, widget config (no I/O)
lib/terminal/brokerTerminal.ts                       pure: server name -> broker key, candidate hosts, page scoring, frame check (no I/O)
lib/services/metaTraderTerminalService.ts            server only: reads the caller's accounts, decrypts login / server / platform
lib/services/brokerWebTerminalService.ts             server only: finds + caches the broker's own web-terminal address (table broker_web_terminals, migration 059)
```

**Routes** (all `requireAuth`, all answer `{ok,data}` with `Cache-Control: private, no-store`; none is imported by the AWS workers)

| Route | What it does |
|---|---|
| `GET /api/terminal/workspace` | The caller's workspace document. Always valid: stored data is re-sanitised on read. `persisted:false` when nothing was saved yet, `storage:"unavailable"` when the table is missing. |
| `PATCH /api/terminal/workspace` | Body `{workspace:{…partial…}}` (≤ 32 KB, `MAX_WORKSPACE_BYTES`) is merged into the stored document by `mergeWorkspace` - an invalid value is ignored and the previous value kept - and saved. 503 `TERMINAL_STORAGE_UNAVAILABLE` if the table is missing. |
| `GET /api/terminal/metatrader/accounts` | The caller's **own** trading accounts for the picker: name, broker, platform, server, **masked** login (`••••321`), status, `canLaunch` / `unavailableReason`. Never a password, never the full login. Partners get 403. |
| `POST /api/terminal/metatrader/launch` `{accountId}` | Login number + trade server + platform of ONE of the caller's own accounts, so the terminal's sign-in form can be pre-filled. Audited as `METATRADER_TERMINAL_LAUNCHED` (metadata = platform only). Never the password. |
| `POST /api/terminal/metatrader/resolve` `{accountId, refresh?}` or `{server, platform, refresh?}` | **Automatic web-terminal address** (third pass, 2026-10-12). Returns `BrokerTerminalInfo` = `{serverKey, status, url, host, source, embeddable, brokerName, checkedAt}` for the broker behind the account's trade server - found by the platform, never typed by the user. `status` = `FOUND` · `NOT_FOUND` · `BLOCKED` (an administrator switched the automatic address off for that broker) · `UNAVAILABLE` (could not look right now, try again later) · `NOT_NEEDED` (MetaQuotes' own servers). `source` = `DISCOVERED` · `ADMIN` · `SAVED`. With `accountId` the server is read from the caller's own account (`resolveMetaTraderLaunch`, filtered by `user_id`); a manual entry sends `{server, platform}`. It **never accepts an address**. `refresh:true` ("Search again") is limited to 5 per hour per user. Partners get 403; `maxDuration` 20 s; `no-store`. |
| `PATCH /api/terminal/preferences` (existing) | Now **merges** `layout` instead of replacing it and ignores an incoming `workspace` key, so the older code path can never wipe the workspace. |

**Workspace document** - `terminal_user_preferences.layout.workspace` (JSONB, migration 016; **no new migration**): `{version:3, view, split, splitWith, tradingview:{symbol, timeframe, watchlist[≤30], panels:{watchlist,details,hotlist}, chart:{…options…}}, metatrader:{source, customUrl, brokerTerminals, selection, manualAccounts[≤20], autoLogin}, wsatrade:{accountId, symbol, volume, orderKind, confirm, levelMode, stopLossPoints, takeProfitPoints, requireStopLoss, maxVolume}}`. **Version 3 (fifth pass)** made the terminal a trade section: it opens as the **split view, chart on the left and WSA Trade on the right** (`view:"split"`, `splitWith:"wsatrade"`), and `wsatrade` carries the person's own trade rules (below). A version-2 document that still holds exactly the old starting layout (bare chart tab, MetaTrader as the partner, side by side) never chose it and follows the new default; any other saved layout is kept. `view` = tradingview · metatrader · wsatrade · split; `splitWith` = metatrader · wsatrade; `metatrader.autoLogin` is the "Reconnect automatically" checkbox (default off: the address keeps `startup_mode=no_autologin`, so the sign-in form of the chosen account comes up); `wsatrade` = which of the user's accounts the panel trades (`null` = the first ready one), the symbol in the broker's spelling and the lots the ticket starts with (defaults XAUUSD, 0.01), plus the **trade rules** the panel enforces before an order is sent: `orderKind` the ticket starts with (MARKET · LIMIT · STOP), `confirm` (ask once more before an order leaves; off = one click sends it), `levelMode` (SL / TP typed as prices or as points), `stopLossPoints` / `takeProfitPoints` (a new ticket starts with a stop / target that many points from the entry), `requireStopLoss` (refuse a new order without a stop loss) and `maxVolume` (refuse a new order above this many lots). They are the person's own rules, saved per user with the layout (not per account); the platform's gates (subscription, execution switch, risk rules) are enforced by the server whatever is set here.
- `version` is 2 since the third pass (2026-10-12): `metatrader.source` now defaults to `auto`, and `brokerTerminals` (`{ "<broker>:<mt4|mt5>": "https://…" }`, ≤ 20 entries, newest kept) holds the address a user pasted by hand for one broker so that it is asked for **once per broker**, not once per account. A stored version-1 document with source `classic` is read as `auto`. Every address in it is re-validated (`cleanTerminalUrl`) on read and on write.
- There is **no password anywhere** in it. `manualAccounts` hold label / login number / server / platform only.
- RLS (`own_terminal_preferences`) lets a user write their own row straight through the Supabase API, so the document is treated as untrusted: `sanitizeWorkspace` runs on every read and every write.
- The device copy in `localStorage` (offline / table-missing fallback) leaves out manual accounts and the selection.

**Data flow for a MetaTrader account.** `broker_credentials.encrypted_reference` (AES-256-GCM JSON `{login,password,server,platform}` - the same record the API2Trade sync uses) → `metaTraderTerminalService` decrypts on the server, **drops the password** and returns login (masked in the list), server and platform → picker. Opening an account calls `POST …/launch` for that one account and, for the `auto` source, `POST …/resolve` for the broker's web-terminal address; then `buildMetaTraderUrl` builds the iframe address. Accounts added by hand live only in the workspace document. Owner filter is explicit (`user_id = caller`, admins included): the terminal never shows someone else's account, unlike `assertCanAccessAccount`, which lets admins in.

**TradingView - what is and is not possible (decided 2026-10-12)**
- Used: TradingView's free *Advanced Chart* embed (`https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js`, config JSON from `buildTradingViewWidgetConfig`). The personal watchlist (the widget's `watchlist` key) and the panel toggles are stored **in WSA**, not in the trader's TradingView account.
- **Defaults and options (2026-10-12).** The chart opens dark, UTC, with **two moving averages (MA 50 and MA 200 - TradingView's `STD;MA%1Cross` study with `in_0=50`, `in_1=200`) and no volume pane** (`hide_volume` is sent explicitly). `components/trading/TradingViewOptionsPanel.tsx` exposes what the free widget supports and everything is stored in the workspace document: chart type, theme, time zone, side-panel width, indicators (MA 50 / MA 200, EMA 20, Bollinger Bands, VWAP, Supertrend, Ichimoku, RSI, MACD, Stochastic - at most 5 studies), compared symbols (≤ 3, same % scale / new scale / new pane) and toggles for Volume, Drawing tools, Top toolbar, Legend, Date ranges, Symbol search, Screenshot button, Pop-out button, Extended hours and 'Edit list in chart'. Only keys the widget's loader whitelists are sent; `studies` is an array of objects only (a mix with plain ids makes the widget ignore the objects); `range` is never sent. The earlier **Calendar toggle never did anything** (the widget has no such key) and was removed; the economic calendar stays on the separate `/calendar` page.
- **Not possible inside our page, whatever we build:** signing in to a TradingView account, that account's saved layouts / alerts / drawings / watchlists, trading from the chart. `tradingview.com` answers with `Content-Security-Policy: frame-ancestors 'none'` (it cannot be framed), the free widgets have no login at all, and proxying the site or stripping that header would breach TradingView's terms and route the trader's TradingView password through our server - rejected. The UI explains this ("Why can't I sign in to my TradingView account here?") and offers **Open on TradingView** (new tab).
- The only route to a real in-page TradingView terminal (login, saved layouts, broker trading) is TradingView's licensed *Advanced Charts / Trading Terminal* library (commercial agreement, own data feed and broker adapter) - a business decision, not a code change.
- **Own Pine scripts / indicators (asked 2026-10-12, fifth pass: "let me put my own scripts directly from there").** The free embed cannot load a trader's private or community Pine scripts: it only knows TradingView's built-in studies, it has no sign-in that could unlock private scripts, and no `PUB;<id>` / script-import key could be verified (a guess would only make the widget ignore the `studies` list). So the options panel offers the built-in indicators, the help text under the chart says plainly that Pine scripts cannot run inside an embedded chart, and **Open on TradingView** opens the same symbol and timeframe on tradingview.com, where the trader's own scripts, layouts and alerts work. Real in-page custom indicators need TradingView's licensed *Advanced Charts* library (custom indicators written in JavaScript - not Pine - on our own datafeed) or a future own chart engine on a broker candle endpoint (API2Trade's candle endpoint is not integrated or verified). A business decision again, not something a code change in the embed can fix.

**MetaTrader web terminal - what is and is not possible**
- **Platform and server (2026-10-12, "the terminal always opened MetaQuotes' default server").** Cause: the classic terminal creates a MetaQuotes-Demo account on its first start and, unless told otherwise, reconnects to the account it used last - it never looked at `login` / `trade_server`. The address now always carries the account's own platform and server and switches that reconnection off. The platform comes from the stored account, else from the server name (`Exness-MT5Real10`, `XM.COM-MT4 3` - `inferPlatformFromServer`); a name that says nothing is never guessed.
- Embedded sources (`MetaTraderSource`): `auto` (default since 2026-10-12, third pass) = the broker's own web terminal, found by the platform - see "Automatic web-terminal address" below · `classic` = `https://metatraderweb.app/trade` (**MT4 only**: MetaQuotes closed the shared MT5 web terminal on 1 August 2023 - their pages say "each web terminal is assigned to a specific broker and is located on its domain" - so an MT5 account can only be opened in the terminal its broker hosts; MT4 brokers in MetaQuotes' directory that allow web trading; params `servers=<the account's server>` (the only one offered), `trade_server`, `login`, `startup_version=4|5` (first start only), `startup_mode=no_autologin`, `demo_all_servers=1` only when the server is unknown, `lang`; spaces written `%20`) · `modern` = `https://web.metatrader.app/terminal` (MT5 only; MetaQuotes' public site only knows *MetaQuotes-Demo* - for a broker account the pane shows an explanation naming the server and a one-click "Use MetaTrader Web" instead of logging in on the wrong server; params `login`, `lang`, `theme-mode=1`) · `custom` = the broker's own WebTrader address (https only, never this site's own origin, `validateCustomTerminalUrl`). The iframe is sandboxed (`allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads …`) with `referrerPolicy="strict-origin-when-cross-origin"`.
- **Auto-login is limited to login number + server.** MetaQuotes has no password parameter and WSA never puts a password in an address: the trader types it once in the terminal (its "Save password" box keeps it in that browser). A zero-click login is not possible.
- Limits the UI tells the user (help section under the terminal): no Expert Advisors / custom indicators in a web terminal; orders go straight to the broker and **bypass WSA risk limits, copy-trading rules and evaluation checks until the next sync** (R16); login number and server are sent to MetaQuotes / the broker host in the address; some browsers (Safari, strict third-party-storage settings) partition or block storage inside iframes so "Save password" may not stick - **New tab** is the fallback.

**Automatic web-terminal address (third pass, 2026-10-12).** *Why users were asked for a link:* since 1 August 2023 an MT5 web terminal only exists on the broker's own domain, and API2Trade exposes no terminal link (its `Search` returns `companyName`, `website`, `results[{name, access[]}]`; `AccountDetails` has nothing like it). So nobody - not MetaQuotes, not API2Trade - could hand the platform "the" address; the platform now works it out from the account's trade server:

```
account server "ICMarketsSC-Demo", platform MT5
  └─ serverKeyOf -> "icmarketssc"            storage key "icmarketssc:mt5"   (lib/terminal/brokerTerminal.ts, pure)
       └─ brokerWebTerminalService.resolveBrokerWebTerminal            (server only, route POST …/metatrader/resolve)
            1. row in broker_web_terminals with source ADMIN   -> used as is (url = null blocks the automatic search); never cached in memory, never overwritten
            2. fresh cache: process memory, then the DB row    -> FOUND 14 days · NOT_FOUND 6 h · UNAVAILABLE 2 min · missing table re-checked after 10 min
            3. discovery (8 s budget, ≤ 4 at a time, ≤ 5 forced refreshes per user per hour, concurrent identical lookups share one run)
                 a. broker directory = API2Trade `Search` on the brand: the entry that lists the exact server wins, else the entry whose website matches the brand
                 b. candidate pages on the broker's registrable domain: dedicated hosts (webtrader. / mt5. / trader. …) and links on the home page labelled "WebTrader"
                 c. each candidate is fetched and scored (MT5 / MT4 markers, "WebTrader" wording; wrong platform rejected; needs score >= 3)
                 d. the winner is checked for framing (X-Frame-Options / CSP frame-ancestors) -> `embeddable:false` opens it in a new tab instead
            4. stored in process memory + the DB row (source DISCOVERED)
```

- **Safety (the platform fetches pages on its own, so the rules are strict).** The domain comes only from the broker directory entry or from brand-bound `.com` guesses - **never from anything a user typed** (the route does not accept an address at all). https only, public IPs only (DNS result checked), redirects only inside the broker's registrable domain, 300 kB and 3.5 s per page, no cookies sent, nothing returned to the browser except the chosen URL (no page content). An address a user pasted by hand is only used for that user's own pane; it never reaches the shared cache.
- **What the user sees.** Source *Automatic* (default): found → the broker's terminal opens with login number, server and platform pre-filled (`buildMetaTraderUrl`, kind `broker`); MetaQuotes' own servers → MetaQuotes' demo terminal; **MT4 and nothing found → MetaQuotes' shared MT4 terminal**; **MT5 and nothing found → a panel with *Search again*, a field to paste the broker's address once (kept per broker in `brokerTerminals`, so every other account at that broker works at once) and *Enter an address myself*** (custom source). An account whose server name carries no broker (`serverKeyOf` null) only gets the custom route.
- **Administrator override** (table is service-role only, no policies): `insert into public.broker_web_terminals (server_key, broker_name, url, source) values ('icmarketssc:mt5','IC Markets','https://…','ADMIN') on conflict (server_key) do update set url = excluded.url, source = 'ADMIN', embeddable = true, checked_at = now(), updated_at = now();` - `url = null` with source ADMIN switches the automatic address off for that broker. Documented in migration `059`.
- **Without migration 059** the feature still works: the lookup runs, the answer is kept in process memory only and the missing table is re-checked every 10 minutes; it just is not shared between serverless instances.
- **Still not zero-click:** MetaQuotes' and brokers' terminals have no password parameter, so the password is typed once in the terminal. **Unverified:** the discovery was never run against real broker sites from the build environment (it has no general internet access) - its accuracy is heuristic; brokers whose terminal is not on their own domain, sits behind a login, or forbids framing end in the paste / new-tab fallbacks.

**WSA Trade - the native order panel (fourth pass, 2026-10-12: "is there a way to open the MT5 web terminal without hunting for the broker's web-terminal link - maybe through API2Trade?")**
- *Answer.* **API2Trade has no feature that opens an account in a web terminal or returns a terminal link** (`Search` and `AccountDetails` carry none, see above). What it does have is a trading API on the very session WSA already keeps for every connected account. So the workspace got a third pane, **WSA Trade**, that works for every connected MT4 / MT5 account with no broker link and no second login: balance, equity, floating P&L, margin, free margin and margin level; the open positions (refreshed every 3 s while the panel is open); a market-order ticket (symbol, BUY / SELL, lots, optional SL / TP, bid / ask when the bridge has a price endpoint); SL / TP editing and (partial) close per position. *(Superseded in the fifth pass: pending orders are now listed and managed, there are bulk actions, and the orders no longer leave from the web tier - see "The trade section and the trade gateway" below.)*
- *Files.* Pure: `lib/trade/{webTrade,webTradeFormat,webTradeGuard,webTradeSchemas}.ts` (types, symbol / lots / level rules, formatting, repeat protection + per-user ceiling; only `webTradeSchemas` imports zod, so the panel does not pull it into the browser). Broker side: `BrokerAdapter.fetchTradingState` / `fetchQuote` (`Api2TradeBrokerAdapter`), `lib/broker/openPositions.ts` (maps `OpenedOrders` rows to positions and separates pending orders), `lib/broker/quote.ts` (reads bid / ask from a short list of possible price endpoints - **the real endpoint name is not documented**, so the quote can be missing; the ticket then still works without a price). Server: `lib/services/webTradeService.ts`. UI: `components/trading/WsaTradePanel.tsx`, `hooks/useWebTrade.ts`.
- *Routes* (all `requireTrader`, `{ok,data}` envelope, `Cache-Control: private, no-store`): `GET /api/terminal/trade/accounts` (the caller's own accounts + the platform gate) · `GET /api/terminal/trade/state?accountId&symbol` (figures, positions, pending-order count, quote, `riskBlocked`) · `POST …/open` `{accountId, symbol, side, volume, stopLoss?, takeProfit?, clientRequestId}` · `POST …/modify` `{accountId, ticket, stopLoss?, takeProfit?}` (`null` removes a level) · `POST …/close` `{accountId, ticket, volume?}` (no volume = the whole position).
- *Gates - the reason to build it natively.* Every call is for the caller's **own** account (explicit `user_id` filter, admins included: the admin terminal trades the admin's own accounts, never a client's); partners get 403. Platform gate: `adapter.executionAvailable()` (= `BROKER_EXECUTION_ENABLED`; off ⇒ the panel is read-only, `EXECUTION_DISABLED`; since the fifth pass this switch is the AWS worker's - the web tier only needs it for the `direct` route) and an ACTIVE platform subscription (admins exempt; `SUBSCRIPTION_REQUIRED` 403). **Open** also needs `getRiskEnforcementState(account).blockedNewTrades` to be false (`RISK_BLOCKED` 423); **modify and close are never blocked by the risk rules** (reducing risk is always allowed). Repeat protection: a `clientRequestId` that was handled returns the stored answer (`repeated:true`), the same id still in flight returns 409 `ORDER_IN_PROGRESS`; 30 changes per user per minute (`RATE_LIMITED` 429) - both kept in the memory of the server instance (best effort, not a ledger; on the `gateway` route the unique `(user_id, client_request_id)` of `trade_commands` makes the repeat protection a real guarantee). Every change writes an audit row (`WEB_TRADE_ORDER_OPENED`, `WEB_TRADE_POSITION_MODIFIED`, `WEB_TRADE_POSITION_CLOSED`). The order comment is **`WSA Trade`** and must never start with `wsa:` (that marker belongs to the copy engine). Credentials are never read, returned or logged by this feature.
- *Effect on R16.* Orders placed in WSA Trade pass WSA's gates; orders typed into an embedded broker web terminal still do not.
- *Unverified.* Nothing was run against a real API2Trade (the field names of pending orders in `OpenedOrders`, the quote endpoint and the exact rejection texts are assumed) and nothing was run in a browser. A timed-out order may still have been executed at the broker: the panel reports "no answer", the server never retries an order by itself.
- *Tests:* `webTrade` (pure rules), `webTradeService` (68 cases, fake Supabase + fake adapter), `wsaTradePanel` (47 cases, jsdom), plus the extended `terminalWorkspace`, `terminalWorkspaceUi`, `terminalRoutes`.

**The trade section and the trade gateway (fifth pass, 2026-10-12)**
- *Request (Albanian, summarised).* Everything that touches MetaTrader - the copy-trading system, adding MetaTrader accounts, reading their data, self-copy, every read and every execution - is one system hosted on AWS; the customer database is Supabase and the web app is managed by Vercel. The WSA Terminal must be a **trade section**: analysis in a split view with TradingView on one side and the trade rules and executions on the right. It was done to a degree, but opening an order, closing orders and modifying them did not work. Look at the commands and the possibilities; the symbols must be generated from API2Trade in the broker's own naming.
- *Why the panel could not trade.* The panel's orders left from the **web tier**, which holds neither the broker-bridge credentials nor the execution switch (`BROKER_EXECUTION_ENABLED=true` exists only on the AWS side; the local `.bat` forces it to `false`) - so on Vercel and on a local test machine the panel was read-only or answered `EXECUTION_DISABLED`. In addition there was no list of pending orders, no cancel, no "close several", the symbol was a free text box (each broker spells instruments its own way: `XAUUSD`, `GOLD`, `XAUUSDm`, `EURUSD.r`, `US30.cash`) and every refusal of a trade server surfaced as "The broker rejected the operation".
- *The shape now: the web asks, the AWS system does.*

```
Browser: WsaTradePanel ── /api/terminal/trade/*   (Vercel; requireTrader; zod; the gates are checked HERE, before anything is queued)
                                │ INSERT trade_commands (PENDING, 90 s expiry)         ▲ waitForCommand: looks after 100, 70, 70, 90 … ms, ≤ 24 s
                                ▼                                                      │ reads the finished row, writes the audit row
                           Supabase  trade_commands · terminal_account_state · terminal_account_symbols · gateway_heartbeat
                                ▲ claim_trade_commands (SKIP LOCKED, poll 100 ms)      │ publishes figures / positions / pending / prices (~1 s) while watched
                                │                                                      │
              AWS copy worker: GatewayWorker ── executeTradeCommand ── Api2TradeBrokerAdapter ── API2Trade ── MT4 / MT5 broker
```

- *Route choice* (`webTradeService`). `gateway` = a worker reported in `gateway_heartbeat` within 20 s (the normal way; the heartbeat also says whether the worker's execution switch is on, and the panel then says "execution is switched off" instead of failing); `direct` = this server itself has the bridge **and** the execution switch (a single-box install; the very same executor runs in-process); `none` = read-only, with the reason (`GATEWAY_OFFLINE`, `EXECUTION_DISABLED`). `WSA_TRADE_ROUTE=gateway|direct` pins it. Without migration 060 the missing tables are detected and remembered for 10 minutes (`GatewayNotInstalledError`), and the route falls back to `direct` or `none`. `GET /api/terminal/trade/accounts` returns the chosen route.
- *Commands* (`lib/gateway/tradeCommands.ts`, pure; the worker re-validates every row with `parseTradeCommand` and never trusts what wrote it). **OPEN** at the market or as a pending LIMIT / STOP order with an entry price (levels are checked against the side, `pendingLevelsProblem`); **CLOSE** the whole position or part of it (lots); **MODIFY** the stop loss / take profit of a position (`null` removes a level, a missing key keeps it) or the entry price and levels of a pending order; **CANCEL** deletes a pending order (it reads the account first to be sure the ticket is a pending order - a cancel must never fall through to closing a real position); **CLOSE_BULK** with scope ALL · PROFIT · LOSS · BUY · SELL · SYMBOL · PENDING (at most 200 items, 3 at a time, the answer says how many were closed and lists up to 20 that could not be); **STATE** (refresh the live picture now, up to 5 watched symbols) and **SYMBOLS** (read the broker's symbol list). OPEN and CLOSE read nothing first (the broker answers "no such order" itself); every order carries the comment `WSA Trade`.
- *The worker* (`GatewayWorker`, started by `scripts/wsa-copy-worker.ts` when `WSA_TRADE_GATEWAY_ENABLED` is not `false`). Claims in batches with `claim_trade_commands`; one chain per account (a modify never overtakes the open it belongs to), accounts in parallel (`WSA_TRADE_GATEWAY_CONCURRENCY`, 8); polls every 100 ms while commands arrive or accounts are watched, 750 ms when idle in the fifth pass (`WSA_TRADE_GATEWAY_POLL_MS`, `…_IDLE_POLL_MS`; **400 ms since the sixth pass**). **A command that waited past its expiry is marked EXPIRED and is never sent to the broker** (the person was already told); **a RUNNING command whose worker disappeared becomes FAILED `WORKER_LOST` and is never run again by itself** (the order may exist); the answer of a command that already ran is stored with retries. Execution is gated by `adapter.executionAvailable()` inside the executor (the AWS switch). Without migration 060 the loop sleeps and asks again after a minute - copy trading is not affected.
- *Waiting and the uncertain case.* The route waits up to 24 s (`ORDER_WAIT_MS`, below the 30 s the routes may run). If it stops waiting it calls `abandonCommand`: a command nobody picked up is closed (`CANCELLED`, it can never run later), one a worker already took is reported as uncertain ("RUNNING - check your positions"; a timed-out order may have been executed), one that finished just now is returned as it is. A refusal by the trade server is turned into a sentence a trader can act on by `lib/broker/tradeRetcodes.ts` (MT5 return codes, MT4 error numbers / names) instead of "The broker rejected the operation".
- *The live picture.* Each `GET …/state` poll (the open panel polls every 2 s) says "somebody is looking" (`keepWatching`: `terminal_account_state.watch_until` +45 s, renewed when below 25 s, `watch_symbols` ≤ 5, the symbol on screen first); the worker refreshes every watched account about once a second (`WSA_TRADE_GATEWAY_STATE_MS`, 6 in parallel) and stops when the watch lapses. The route serves a published picture younger than 4 s as it is, otherwise waits up to 6 s for a fresher one, and shows an older one (up to 120 s, flagged `delayed`) rather than nothing; a price older than 10 s is not shown. The first poll of an account the worker has never watched may wait a moment for the first picture.
- *Symbols from the broker.* `GET …/symbols` reads `terminal_account_symbols` (kept 6 h, an empty list 2 min); if there is none the route sends a SYMBOLS command (20 s wait). `lib/broker/symbolList.ts` parses whatever shape the bridge answers (an array of names, of objects, a wrapped array, a map, or comma / line separated text) and keeps the broker's own spelling with description, folder and digits when they are sent. `SymbolPicker` finds "gold" → `XAUUSD` / `GOLD` and "eur usd" → `EURUSD.m`; `lib/trade/symbolMatch.ts` keeps the chart and the panel on the same instrument both ways (a symbol picked on the chart selects the matching broker symbol, and the reverse) and never guesses silently. Without a list the picker is a plain text box for the broker's spelling and the ticket still works.
- *The right-hand side as a trade section.* Account and live figures (balance, equity, floating P&L, margin, free margin, margin level) · symbol picker · ticket (BUY / SELL, market or pending, lots, stop loss and take profit as prices or as points, bid / ask when the bridge sends them) · the person's trade rules (level mode, default stop / target in points, "require a stop loss", maximum lots - `wsatrade` in the workspace document; the "confirm before sending" rule of this pass was **removed in the sixth pass**) · open positions with edit (SL / TP), partial close (25 / 50 / 75 % / all) and close · pending orders with edit (price, SL / TP) and delete · a "close several" bar (all, winners, losers, buys, sells, this symbol, pending orders) with a preview of what it will touch. There is deliberately **no "risk 1 % of the balance" lot calculator**: without the symbol's tick value it would be a guess, and a wrong lot costs money; the checks refuse only what is certainly wrong (a stop on the wrong side of the entry, a volume above the person's own limit) and the broker keeps the last word on stop levels and volume steps.
- *Unchanged and still true.* The gates (execution switch, ACTIVE platform subscription with admins exempt, risk block for NEW orders only - modify / close / cancel / bulk are never blocked by risk), own accounts only (explicit `user_id` filter, admins included, partners 403), the order comment `WSA Trade` (never starting with `wsa:`), the audit actions (`WEB_TRADE_ORDER_OPENED`, `WEB_TRADE_POSITION_MODIFIED`, `WEB_TRADE_POSITION_CLOSED`, plus the new `WEB_TRADE_ORDER_CANCELLED` and `WEB_TRADE_BULK_CLOSED`), no credentials read or logged, the same workspace for `/terminal` and `/admin/terminal`.
- **Operational warning - the gateway is a shared-database mechanism.** A site started locally with the production Supabase keys writes `trade_commands` rows that the **live AWS worker** executes: an order placed in WSA Trade from a local test site is a **real order** on the real broker account, whatever `BROKER_EXECUTION_ENABLED` says locally (the `.bat` forces it to `false`, which only closes the local server's own `direct` route). Test with a demo account, or with the worker's switch off (R17).
- *Routes added or changed in the fifth pass* (all `requireTrader`, `{ok,data}`, `Cache-Control: private, no-store`, `maxDuration` 30): `GET …/accounts` (accounts, platform gate, route) · `GET …/state?accountId&symbol` (figures, positions, **pending orders**, price, `riskBlocked`, `delayed`) · **`GET …/symbols?accountId`** · `POST …/open` (now also LIMIT / STOP with `price`) · `POST …/modify` (positions and pending orders) · `POST …/close` · **`POST …/cancel`** `{accountId, ticket, clientRequestId?}` · **`POST …/close-bulk`** `{accountId, scope, symbol?, clientRequestId?}`.
- *Unverified.* Nothing ran against a real API2Trade (the pending-order fields in `OpenedOrders`, the shape of the `SymbolList` answer, the quote endpoint and the rejection texts are assumed), against the AWS worker or in a browser. The gateway adds one database write and a few reads to an order (about two Supabase round trips plus the 100 ms poll) compared with a direct bridge call - the price of having one execution system; measure the first orders.
- *Files.* New: `src/lib/gateway/*`, `src/lib/trade/{symbolMatch,ticketMath}.ts`, `src/lib/broker/{symbolList,tradeRetcodes}.ts`, `src/components/trading/wsaTrade/{Book,SymbolPicker,TradeSettings,ui}.tsx`, routes `trade/{cancel,close-bulk,symbols}`, migration `060`. Changed: `webTradeService.ts` (rebuilt around the gateway), `WsaTradePanel.tsx`, `hooks/useWebTrade.ts`, `lib/trade/{webTrade,webTradeFormat,webTradeSchemas}.ts`, `lib/terminal/workspace.ts` (version 3), `TerminalWorkspace.tsx`, `lib/broker/{BrokerAdapter,Api2TradeBrokerAdapter,api2TradeClient,openPositions}.ts`, `scripts/wsa-copy-worker.ts`.
- *Tests.* `tradeCommands`, `tradeExecutor`, `gatewayQueue`, `gatewayStore`, `gatewayWorker`, `webTradeGateway` (routes + service + worker over an in-memory database), `webTradeService`, `webTrade`, `ticketMath`, `symbolMatch`, `symbolList`, `tradeRetcodes`, `wsaTradePanel`, `terminalWorkspace`, `terminalWorkspaceUi`.

**WSA Trade, sixth pass (2026-10-19): one click, milliseconds, a time report, a panel that fits**
- *Request (Albanian, summarised).* The order and modify buttons work well. Wanted: (1) when the terminal is in split view the WSA Trade panel should not need browser zoom in / out so the buttons line up the way the user wants (the first word of that sentence could not be decoded; read as "the layout / arrangement of the WSA terminal"); (2) execution and modification are slow - everything takes 2 to 10 seconds; find out how it can be fixed so it is milliseconds, because the execution reports really show high times; (3) remove the confirmation button when making modifications or executing orders - the command is given with one button; deliver the zips, no test agent, no audit.
- *Where the 2 - 10 seconds went (static reading of the whole chain; nothing was measured live).* (a) The AWS worker ran reads of the same account in the **same chain as orders**: a STATE refresh or the read in front of a MODIFY / CANCEL queued in front of - or behind - the order, and each read is a broker round trip. (b) A MODIFY read the account first even when a picture only a moment old existed. (c) After an order the next picture of the account arrived up to a poll later (1 s), so the person watched the old list. (d) The stored answer of a command was written inside the account's chain, holding the next command back for one database round trip. (e) The web route checked the platform subscription with a database query on every order and ran its gates one after the other; the audit row was awaited before the answer left. (f) A cold serverless function of one of the five order routes paid its start-up on the person's order. (g) The panel asked for the state once a second after an order and showed nothing until then. (h) The confirmation step added a second click and a re-render in front of every order.
- *What changed on AWS* (`src/lib/gateway/{gatewayWorker,tradeExecutor,tradeCommands}.ts`, `src/lib/broker/{BrokerAdapter,Api2TradeBrokerAdapter}.ts`, `scripts/wsa-copy-worker.ts`, `deploy/aws/wsa-worker-start.sh`; **shared code, live when AWS pulls `main`**). Order chains and **read chains are separate** (`KeyedChains`, reads `WSA_TRADE_GATEWAY_READ_CONCURRENCY` 6 at a time); OPEN / CLOSE read nothing first; **MODIFY reuses the picture read after the last order if it is ≤ 1.5 s old** (`recentPicture`, `RECENT_PICTURE_MAX_AGE_MS`), else it reads; CANCEL and CLOSE_BULK always read fresh; after an order the account is **re-read at once and then every 350 ms for 4 s** (`hotRefreshMs`, `HOT_WINDOW_MS`); the answer is stored **outside the account chain**; the idle poll is 400 ms; the owner of a watched account is prefetched; the broker session is warmed with a single-flight / sliding warmth. Every command is timed in stages by the adapter (`ExecutionStages`: read · session · send · attempts) and the worker logs `[trade-gateway] <command> done in Xms (queue Yms · read … · session … · send …)`.
- *What changed on the web* (`webTradeService.ts`, `billingService.ts`, `api/terminal/trade/*`, `hooks/useWebTrade.ts`). The ACTIVE platform-subscription check is cached 30 s per user (new `hasActivePlatformProductSubscription`); ownership, subscription, risk and route gates run in parallel; the audit row is written in `after()`; the answer carries `serverMs` (the route's own time) and `waitMs` (from writing the command to seeing its answer); each of the five order routes also answers a plain **GET** (no sign-in, no data) so the panel can keep them warm (`useWarmWebTradeRoutes`: once on open, then every 4 min while visible); after an order the state is polled every **400 ms for 3.5 s** (`requestFastRefresh`, `nextStatePollMs`); what the answer meant is laid over the lists at once (`lib/trade/stateOverlay.ts`, 6 s, only after a successful answer, never touching balance / equity / margin); `sendWebTrade` adds the browser's own `totalMs`.
- *The time report* (`WebTradeTiming`, `timingText`, `timingHeadline` in `lib/trade/webTradeFormat.ts`). Next to every result: the whole wait in the browser ("412 ms"), under it where it went: `N ms in total: network · server · queue · broker (read · session · send · attempts) · relay`. network = total − server, server = serverMs − waitMs, queue = the command waiting for the AWS worker, broker = the worker's work up to the broker's answer, relay = waitMs − queue − broker (the database round trips between web and worker). It is kept in the Activity list as well. A `repeated` answer (the server had it already) shows no timing. **Reading it:** a big *network* = the browser to Vercel (region, cold start); a big *server* = the web function's own work; a big *queue* = the worker was busy or its poll gap; a big *broker* with a big *send* = API2Trade / the broker's trade server (not ours to shorten); a big *session* = a cold broker session; a big *relay* = the database round trips (Vercel's region is not Supabase's).
- *The floor that remains.* About 2 × (web ↔ Supabase round trip) + 2 × (AWS ↔ Supabase round trip) + the poll gaps (100 ms while busy) + the broker's own time. Keep the **Vercel Function Region = the Supabase region** (and the AWS box in that region, `[verify]`); a region mismatch alone can add 100 - 150 ms to each of the four hops. The 41 ms that API2Trade advertises is its own request time, not the whole chain.
- *No Confirm.* Buy · Sell · Close · Delete · the six "close several" chips · Delete all pending are **one click**; the part-close editor, the SL / TP editor and the pending-order editor remain only because they need a number, and their Save / Close button is the command. The chips show how many positions they will touch (`Close winners (2)`). The person's own rules (require a stop loss, largest volume) are still checked before anything is sent; while a request travels all buttons are disabled; the same order sent again after an answer that never came keeps its `clientRequestId` (90 s), so it can never be placed twice. The `confirm` workspace key was removed (a stored one is ignored); `ticketMath.orderSummary` / `bulkQuestion` are no longer used by the screen (still exported and unit-tested).
- *The panel fits its room* (`lib/trade/panelLayout.ts`, `WsaTradePanel.tsx`, `TerminalWorkspace.tsx`, `lib/terminal/workspace.ts`). The panel measures itself with a `ResizeObserver` and picks its own zoom ("Auto": 100 % when there is room, down to 80 % when the pane is narrow or low; the person can choose 60 - 160 % with − / + and click the percentage to go back to Auto); everything under the title bar is zoomed, the title bar with the buttons is not; ticket and lists stand side by side from 720 px of room and stack below that. The split view got a **draggable divider** (pointer-captured, arrow keys ±2 %, 20 - 60 % of the width, stored as `wsatrade.panelShare`) and a taller pane (`clamp(520px, 80dvh, 1100px)`). Both choices are saved in the workspace document (`wsatrade.zoom`, `wsatrade.panelShare`; `null` = automatic) and validated by `sanitizeWorkspace`.
- *Unverified.* The speed: every number above is **expected, not measured** - read the time report on the first live orders (and the `[trade-gateway]` lines in `journalctl -u wsa-copy-worker`). The layout: CSS `zoom`, the ResizeObserver fit and the divider ran only in jsdom, never in a real browser.
- *Tests.* Reworked for one click: `wsaTradePanel` (150 cases: one-click flows, retry ids, overlay, time report, panel size, warm-ups); extended: `gatewayWorker` (62), `tradeExecutor` (43), `webTradeService` (106), `webTradeGateway` (37), `terminalWorkspace`, `terminalWorkspaceUi` (44; divider); new: `panelLayout`, `stateOverlay`, `webTradeTiming`, `useWebTrade`.

**WSA Trade, seventh pass (2026-10-20): no waiting - the wait moved into the database**
- *Request (Albanian, summarised).* After the sixth pass the owner measured an order at **2.32 s** (`network 244 ms · server 876 ms · queue 482 ms · broker 215 ms (send 215 ms) · relay 501 ms`) and wrote that it is still too much and has to go down much further.
- *Where the 2.1 s around the 215 ms broker call went (the report's own numbers + a static reading of the chain).* (a) **queue 482 ms** - the command lay in `trade_commands` until the AWS worker's next "anything for me?" was answered (every 100 ms while busy, 400 ms idle; each question is a database round trip). (b) **relay 501 ms** - after the worker stored the answer the web server found it on its next poll of the table (70 - 300 ms gaps, again a round trip each) plus the worker's own write. (c) **server 876 ms** - the route's work before the command could be written: the sign-in was two sequential round trips (`auth.getUser()`, then the `profiles` read), then ownership of the account, the risk verdict, the platform subscription and the AWS heartbeat - each a Supabase round trip, some of them cold (every Vercel route is its own function instance; keep-alive connections close after 4 s). (d) **network 244 ms** - browser ↔ Vercel; through `next dev` it also contains the PC ↔ Supabase distance and dev-mode compilation. Only the broker part cannot be shortened from here.
- *Migration `062_trade_gateway_long_poll.sql` (optional, forward-only, needs 060).* Two functions that **wait inside the database** and answer the instant the row changes (VOLATILE plpgsql loops, `clock_timestamp()`, `pg_sleep(0.01)` - an indexed look every 10 ms is free at this size; the wait is capped at 5 s in SQL; service role only; same `RETURN QUERY UPDATE …` pattern as 060's claim function): `claim_trade_commands_wait(worker, limit, wait_ms)` (the worker's claim, waiting for a command to arrive: same `FOR UPDATE SKIP LOCKED`, same expiry rule as `claim_trade_commands`) and `await_trade_command(user_id, client_request_id, wait_ms)` (the web's wait: returns the row as soon as it is DONE / FAILED / EXPIRED, else - at the end of the wait - the row as it is, or nothing when it was not written yet).
- *AWS* (`gatewayWorker`, `gatewayStore`, `gatewayDb`, `scripts/wsa-copy-worker.ts`, `deploy/aws/wsa-worker-start.sh`; **shared code - live when AWS pulls `main`**). The command loops claim with `store.claimWait(worker, limit, longPollMs)` (`WSA_TRADE_GATEWAY_LONG_POLL_MS`, default 1000, `0` = off, script max 2000, one call never waits more than 3 s); the two loops are staggered, so one of them is always waiting; a full batch or a wait that returned work loops again at once, an empty wait that returned early sleeps the idle poll (no tight loop). Without 062 (`LongPollUnavailableError`) the same round falls back to the plain claim and the worker asks again after 5 min (one log line: "migration 062 is not applied - commands are picked up by polling (slower). Apply 062 to wake up at once."); other failures count, three in a row log a warning and pause the wait for 20 s. The heartbeat `info` now also carries `longPoll` (it waits), `dbRttMs` (median of the last 7 timed heartbeat writes = this box's round trip to Supabase) and `loopLagMs` (p99 event-loop delay minus the 10 ms resolution).
- *Web* (`gatewayQueue`, `webTradeService`, `lib/auth/session.ts`, `webTradeWarmUp.ts`, the `api/terminal/trade/*` routes, `hooks/useWebTrade.ts`, `WsaTradePanel.tsx`).
  1. **The wait starts together with the write.** `awaitCommand` (chunks of ≤ 2.5 s) finds the command by `(user, clientRequestId)`, not by the id the write will return, so `sendThroughGateway` starts it first and writes the command in parallel; a repeated request finds its first answer the same way. If 062 is missing or the database refuses the long wait (`LongPollUnavailableError`), the old polling (`waitForCommand`) takes over with the time that is left - nothing is lost, the order is never sent twice (the abandon / uncertain logic is unchanged).
  2. **Sign-in** (`requireTrader({ cached: true })`, WSA Trade routes only). A verified sign-in is reused for the SAME session token (sha256 key) for ≤ 10 s and never beyond the token's `exp`; only a "yes" is kept; concurrent requests share one check; the profile is read in parallel with `auth.getUser()` using the token's unverified `sub` as a hint, accepted only if it equals the verified id (the read runs with the person's own token, so a forged token gets nothing). Everything outside WSA Trade keeps the full check.
  3. **Gate caches** (`webTradeService`): owned account 15 s (connected accounts only; the AWS worker re-checks the owner), risk verdict 4 s (only "not blocked" - a block is never kept; close / modify / cancel never ask), platform subscription 30 s (positive only), AWS heartbeat 6 s online / 2 s offline (`gatewayAvailability(…, maxAgeMs)`).
  4. **Keeping them young.** After a state poll's answer has left (`after()`), `warmWebTradeGates` renews what is about half old (heartbeat ≥ 3 s, account ≥ 7 s, risk ≥ 2 s, subscription ≥ 15 s - the subscription only for somebody already seen active). The order routes' GET warm-up takes `?accountId=<uuid>` and runs the same upkeep (answer: only `{ warm: true }`); the panel sends it when it opens, every 4 min, and - `useWarmWebTradeRoutes` returns `warmNow` - when a hand reaches for the panel (pointer move / press, focus, key; at most once per 8 s; open / close / modify only).
- *The time report grew* (`WebTradeTiming`, `timingText`): `server 876 ms (sign-in X · checks Y)` and, after the parts, the facts behind them - `Database round trip: web A · AWS B.`, `The AWS worker is busy: its loop ran N ms late.` (from 20 ms), and `Wake-up: live.` / `Wake-up: the web server still asks the database again and again - apply migration 062.` / `Wake-up: the AWS worker still asks the database again and again - apply migration 062 and update the worker.` (`wake` = `live` · `web-poll` · `aws-poll`; an older worker that does not report `longPoll` counts as polling). **Reading it:** a large `Database round trip: web …` (≥ ~100 ms) is distance - the Vercel Function Region is not the Supabase region (or the order was made through a local `next dev`); a large `AWS …` means the box is far from Supabase; the busy-worker sentence points at the worker; a `Wake-up:` warning means a missing migration or an old worker.
- *Expected, not measured.* The order is now: browser → Vercel, one write (≈ 1 web ↔ Supabase round trip, everything else from memory), the worker woken inside the database (≈ ½ round trip), the broker (the 215 ms), the answer stored and seen by the web's waiting call (≈ ½ + ½ round trips) - about the broker time plus 3 - 4 half round trips; with the regions aligned that is in the order of 0.5 - 0.8 s, from the first order after a quiet spell (cold function) somewhat more. The path from the cold start of a route is shorter too (6 → 3 sequential round trips before the write).
- *Not built, on purpose.* A direct web → AWS push (a signed HTTPS endpoint on the worker, skipping the database for the command): it needs a public endpoint, TLS, a firewall rule and its own security / idempotency design; it is the next step only if `Database round trip` in the report is still large after the regions are aligned.
- *Limits.* Each waiting call holds one PostgREST connection for its wait (worker ≈ 2 permanently, web 1 per order in flight); the sign-in hold delays a suspension / role change on WSA Trade by ≤ 10 s; a "not blocked" risk verdict on the order path may be ≤ ~4 s old (on top of the risk worker's ~5 s cadence); caches are per Vercel function instance (per route) and empty after a cold start; migration 062 and the worker's use of it never ran against a real Postgres / Supabase.
- *Tests.* New: `signInCache`; extended: `gatewayQueue` (`awaitCommand`, availability TTLs and measurements), `gatewayStore` (`claimWait`), `gatewayWorker` (waiting for commands, fallbacks, heartbeat measurements), `webTradeGateway` (live wait, fallbacks, wake values, cancel with a live wait), `webTradeService` (caches, upkeep, cheap sign-in on every route), `useWebTrade`, `wsaTradePanel` (warm-ups with the account, a hand on the panel), `webTradeTiming`.

**Admin terminal (fourth pass).** `/admin/terminal` used to show only the market-data provider settings, so admins did not have the sector the traders have. It is now the same workspace (same component, options and saved layout - stored per user in `terminal_user_preferences.layout.workspace`). There is no paywall in front of it (admins have no platform subscription to activate). Admins see and trade **their own** accounts only. The old page content is on `/admin/terminal/provider` (`MarketDataProviderSettings`, linked from the terminal page).

**Rules for the next change**
- The workspace document may never contain a password, token or anything decrypted. `resolveMetaTraderLaunch` is the only place that returns a full login, one account at a time, and it must stay filtered by `user_id`.
- Keep panes mounted (hidden + inert). Unmounting the MetaTrader iframe logs the user out of the terminal.
- Addresses are built only by `buildMetaTraderUrl` / `tradingViewChartUrl`; do not concatenate user input into a URL.
- `POST /api/terminal/metatrader/resolve` must never take an address, and `brokerWebTerminalService` must never fetch a host that did not come from the broker directory or a brand-bound guess. Keep the limits (https, public IP, same registrable domain, size / time caps, 4 parallel lookups, 5 refreshes per hour) and keep ADMIN rows out of the memory cache and out of every overwrite.
- A worker-shared module must not import `brokerWebTerminalService` or `lib/terminal/*` (web-only); and no page-derived text (titles, errors, HTML) may be returned to the browser.
- `src/types/lucide-react.d.ts` is a hand-written ambient module that replaces the package's types: add every new icon there or `tsc` fails.
- Tests: pure - `metaTraderTerminal`, `brokerTerminal`, `terminalWorkspace`, `tradingViewConfig`; server - `metaTraderTerminalService`, `brokerWebTerminalService` (fake discovery + fake Supabase), `terminalRoutes` (fake Supabase, `tests/unit/helpers/fakeSupabase.ts`); components - `metaTraderTerminalUi`, `terminalWorkspaceUi` (jsdom + react-dom, `tests/unit/helpers/reactDom.ts`). Vitest only collects `tests/unit/**/*.test.ts` and defaults to the node environment, so component tests start with `// @vitest-environment jsdom` and use `createElement` (no JSX). They prove behaviour in a simulated DOM only.

---

## 7. Backend / API architecture

### 7.1 Conventions [code]
- Response envelope (`lib/api/envelope.ts`): `{ ok:true, data }` or `{ ok:false, error:{ code, message } }` via `jsonOk / jsonFail / handleAuthError`.
- Typical route: `requireX()` → zod `safeParse` (`lib/validation/schemas.ts` or inline) → service call (service uses `createAdminClient()`) → `jsonOk`; `AuthError` is mapped to its status; other exceptions bubble to a 500.
- Service functions take explicit `userId`/`role` and filter by `user_id` / `trader_id` / `partner_id` themselves — **that filter is the real authorization for service-role queries**; when you add a service query, add the owner filter.
- Audit trail: `writeAuditLog({actorUserId, action, entityType, entityId, metadata})` for security-relevant actions (never log credentials). Notifications: `createNotification`.
- Long work is delegated to `background_jobs` (see §14), not done inside request handlers.

### 7.2 Services map (`src/lib/services`, lines of code)
| Service | LoC | Responsibility |
|---|---|---|
| `copyTradingService` | 3396 | Strategies, followers, global/account rules, eligibility + lot calc, **execution of master events (open/close/modify)**, logs, runtime caches, monitor/simulate |
| `billingService` | 2268 | Products, checkout (Stripe/mock), orders, subscriptions, entitlements, webhook handling, provisioning, return reconciliation, expiry |
| `brokerSyncService` | 1550 | Account sync + trade persistence through API2Trade (MetaApi branch is dead), snapshot RPC, rebate trigger |
| `evaluationService` + `evaluationRulesEngine` | 926 + 305 | Prop-evaluation programs/attempts/checks, link account, funding, pass/fail rules |
| `performanceService` + `accountSnapshotService` | 612 + 99 | Account performance history for the chart (sampled snapshots, paged trades, aggregate RPC; web-only) · single snapshot writer with optional margin and v2→v1 fallback (**shared with the AWS risk worker**) |
| `selfCopyService` | 789 | Trader’s own account A → B copy |
| `partnerService` / `partnerAdminService` / `partnerWithdrawalService` / `partnerRebateCalculationService` | 769 / 405 / 677 / 491 | Partner dashboards, approvals/role/assignment, withdrawals with allocations, rebate engine (IB volume, CPA tier) |
| `academyService` / `academyAdminService` / `academyProgressService` | 417 / 624 / 299 | Learner + admin academy, progress |
| `crmService` | 496 | Trader directory, CRM notes |
| `botMarketplaceService` / `botLicenseService` / `botReleaseService` | 393 / 297 / 162 | Products, access, license keys (hashed) + public verification, Storage uploads/downloads |
| `riskEvaluationService` / `riskService` | 359 / 220 | Evaluate drawdown/limits, create events, enforcement state, account status flips CONNECTED↔RESTRICTED |
| `backgroundJobService` | 340 | Queue: enqueue/claim/finalize/backoff/stale release |
| `brokerCatalogService`, `api2Trade*DiscoveryService`, `metaApiServerDiscoveryService` (legacy) | 331 / 241 / 80 / 95 | Broker/server catalog and discovery |
| `economicCalendarService`, `fredCalendarService` | 308 / 166 | Shared economic calendar (+ FRED import) |
| `adminService`, `auditService`, `notificationService`, `contactRequestService`, `analyticsService`, `tradeService`, `tradingAccountService`, `tradingAccountLifecycleService`, `brokerCredentialService`, `brokerConnectionService`, `wsaCopyEngineService`, `aiProviderService`, `aiAdminService`, `passkeyService`, `certificateService`, `operationalLockService`, `brokerOperationLog` | 296 / 155 / 91 / 114 / 218 / 184 / 182 / 101 / 169 / 85 / 153 / 264 / 229 / 255 / 264 / 62 / 51 | Supporting modules |

### 7.3 Public / special endpoints (security-relevant)
| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/webhooks/stripe` | Stripe signature (`STRIPE_WEBHOOK_SECRET`) | always replies 200 once verified; idempotency via `stripe_webhook_events` (§11.2) |
| `POST /api/worker/jobs/run`, `/schedule` | header `x-worker-secret` == `WORKER_SECRET`; **in production without the secret → 503**; in dev falls back to an authenticated admin | intended as Vercel-Cron targets; “not auto-enabled” (no `vercel.json` in the repo) |
| `POST /api/licenses/verify` | none (EA/bot clients call it) | per-license rate limit only; unknown keys are not throttled per IP `[infer]` |
| `GET /api/certificates/verify/{id}`, `POST /api/auth/passkeys/login/*`, `GET /api/auth/referral/validate` | none | intended public |
| `POST /api/billing/mock-confirm` | any logged-in user (`requireAuth`) | no route-level guard; `confirmMockPayment` refuses unless the billing mode is mock and the order is the caller’s own PENDING `MOCK` order (see R4) |
| `GET /api/realtime/token` | logged-in | returns userId/role/realtime URL; the browser uses the public anon key directly |

---

## 8. Broker integration (API2Trade)

- **Single provider:** `lib/broker/provider.ts` hard-codes `getBrokerProviderId() = "api2trade"`; `createBrokerAdapter()` always returns `Api2TradeBrokerAdapter`. `MetaApiBrokerAdapter`, `metaApi*` helpers, `METAAPI_TOKEN` and the MetaApi branches in `brokerSyncService`, `wsa-risk-worker`, `wsa-copy-worker` are **legacy/dead** (kept in the bundle; `next.config.ts` marks the SDK as an external package).
- `BrokerAdapter` interface: `verifyConnection`, `fetchSnapshot`, `fetchOpenTrades`, `fetchTradeHistory`, optional `warmAccounts` and `fetchSymbolSpecifications`, `executionAvailable()`, `openTrade`, `closeTrade`, `modifyTrade`. `executionAvailable()` = client configured **and `BROKER_EXECUTION_ENABLED === "true"`** — the live-order kill switch.
- `Api2TradeClient` (`api2TradeClient.ts`, Basic auth with the platform-level `API2TRADE_USERNAME/PASSWORD`; base URL defaults to `https://mt5.mt4api.dev` when only user/pass are set): connect-by-token, subscribe to order updates, connection status, disconnect, broker search, account summary/details, symbol specifications, opened/closed orders, send/close/modify orders.
- **Credentials:** the trader’s broker login/password/server are encrypted with **AES-256-GCM** (`lib/crypto/brokerCrypto.ts`, key = `sha256(ENCRYPTION_KEY)`, payload `iv:tag:ciphertext`) and stored in `broker_credentials`; only the API (service role) decrypts them. `ENCRYPTION_KEY` also encrypts AI provider keys → **it must be identical on Vercel, AWS and any local run that shares the database.**
- **Connect flow (trader or admin):** `POST /api/trading-accounts` (creates PENDING row) → `POST …/broker-credentials` (`connectBrokerAccount`: store credentials → update broker metadata → `syncTradingAccount`) → `runApi2TradeSync` (register account → `verifyConnection` retried `API2TRADE_INITIAL_CONNECT_ATTEMPTS`=5 × `…_DELAY_MS`=2500 → snapshot + open trades + history → `persistBrokerSnapshotAndTrades`: RPC `record_account_snapshot`, upsert `trades`, close stale OPEN rows, then partner-rebate calculation) → account becomes CONNECTED (or `sync_error` is stored).
- `syncTradingAccount` / `refreshAccountTrades` **skip already CONNECTED/RESTRICTED accounts** when `liveRiskProjectionEnabled()` (= provider configured **and** `WSA_RISK_ENGINE_ENABLED === "true"`) unless called with `{force:true}`: in that mode the AWS risk worker owns snapshot projection. `refreshAccountTrades` takes the lock `account-sync:<accountId>` for 90 s.
- Error hygiene: `api2TradeErrors.ts` (`publicApi2TradeError`, `publicBrokerConnectionError`) strips provider names/credentials from messages shown to users — the UI says “broker connection service” (`getBrokerProviderLabel()`).
- Live position stream (`api2TradeLiveSource.ts`, used by AWS workers): position-diff engine (OPEN / MODIFY(volume, SL, TP changed) / CLOSE) fed by an `OnOrderUpdate` WebSocket (`ws`) with REST snapshot polling as the safety net (rebuilt 2026-10-12, see §9.9). A stream frame that carries the full `openedOrders` list is applied at once; any other message about an order wakes the engine and makes the next call read REST immediately (`orderUpdateMessage.ts`); with the socket up the safety poll runs every `API2TRADE_WS_FALLBACK_POLL_MS` (default 1000, min 250), without it every `API2TRADE_REST_POLL_MS` (400), and every `API2TRADE_FAST_POLL_MS` (300) for a while after the poll found a change the stream had missed. A silent socket is pinged and rebuilt after `API2TRADE_WS_SILENCE_MS` (75 s, 0 = off); reconnects back off 250 ms → 5 s. Disable WS with `API2TRADE_WEBSOCKET_ENABLED=false`. Every REST call has a time limit (`API2TRADE_REQUEST_TIMEOUT_MS` 12 s, `API2TRADE_POLL_TIMEOUT_MS` 5 s for `OpenedOrders`, `API2TRADE_ORDER_TIMEOUT_MS` 20 s for orders). The copy worker switches on a keep-alive connection pool (`api2TradeTransport.ts`, package `undici`; `API2TRADE_KEEPALIVE_POOL=false` turns it off); the web app keeps the platform `fetch`.

---

## 9. Copy-trading engine (the heart of the system)

### 9.1 Actors and objects
- **Master account** — a `trading_accounts` row with `account_usage = 'COPY_MASTER'`, owned by an admin, status CONNECTED (connected through the same broker-connect flow as any account).
- **Strategy** — `copy_strategies` row built on a master account. Published/archived through `wsaCopyEngineService`.
- **Follower** — `copy_strategy_followers` row (trader + follower trading account + settings). Created `ACTIVE` with `copy_enabled=false` by paid-order provisioning; the trader then saves settings (`PATCH /api/copy/subscriptions/{id}/settings`) which turns copying on.
- **Event** — `copy_master_events` (OPEN / MODIFY / CLOSE of a master position). **Link** — `copy_trade_links` (one follower position per `(source_event_id, follower_account_id)`). **Log** — `copy_execution_logs`, plus `copy_rule_events` and `broker_operation_logs`.
- **Self-copy** — a trader copying *their own* account A → B (`selfCopyService`), independent of strategies and billing entitlements (but requires the platform subscription).

### 9.2 End-to-end flow
1. **Admin publishes** (`POST /api/admin/copy/strategies/{id}/publish` → `publishWsaStrategy`): master must be CONNECTED, owned by the publishing admin and `COPY_MASTER`; creates billing product `COPY_STRATEGY_<UUID-no-dashes-UPPER>_STANDARD`; sets strategy `ACTIVE / LIVE / live_enabled / engine_status=LIVE`. `archive` → `PAUSED`, `DRAINING`, products deactivated, job `CLOSE_COPY_STRATEGY` (priority 100) queued.
2. **Trader subscribes:** `/api/billing/checkout` (COPY_ACCOUNT product matching a LIVE strategy; needs ACTIVE platform subscription + owned account) → Stripe → webhook → `markOrderPaid` → `ensurePaidOrderProvisioned` → `copy_account_entitlements` + follower `ACTIVE` (copy_enabled=false). The follow route (`POST /api/copy/strategies/{id}/follow`) additionally requires consent, an ACTIVE platform subscription and an ACTIVE entitlement of the matching tier.
3. **AWS copy worker** (`scripts/wsa-copy-worker.ts`: a discovery loop every 2 s and one independent pump per stream, §9.9) discovers: strategies `ACTIVE ∧ live_enabled ∧ engine_status ∈ {LIVE, STARTING, ERROR}` and `self_copy_relationships` `LIVE`. For each strategy it opens a stream: `verifyConnection(master)` → `Api2TradeLiveAccountSource.reconnect()` → `warmCopyStrategyAccounts` (every `WSA_COPY_WARMUP_MS`; code default 10 s, AWS 5 s, min 5 s) → `reconcile({emitExistingAsOpen:true})` and the stream's own pump starts (≥ 100 ms, woken at once by the broker's order stream). Positions that were already open when a stream starts are announced as OPEN with `existing:true` and the broker's real open time.
4. **Master position change** → `persistEvent`: insert `copy_master_events` with `dedupe_key = <strategyId>:<positionId>:<OPEN|CLOSE|MODIFY-fingerprint>` (`23505` ⇒ already handled; the insert is retried at 150 ms / 600 ms / 2 s, and a duplicate that follows a failed attempt is looked up first, `lib/copy/masterEvents.ts`) → run `executeCopyForEvent` directly (unless `WSA_COPY_DIRECT_EXECUTION=false`, then a job is queued). If an OPEN produced zero attempts (e.g. no warm followers yet) a delayed (10 s) `EXECUTE_COPY_EVENT` retry is queued (max 5 attempts); if the direct run throws, an `EXECUTE_COPY_EVENT` job is queued with priority 200.
5. **Heartbeat:** the worker writes `copy_strategies.engine_heartbeat_at` every 5 s; a failed stream sets `engine_status=ERROR` + `engine_error` and is retried with a growing pause (2 s doubling up to 15 s, `WSA_COPY_STREAM_RETRY_MS`). Hourly it runs `expireStaleTradingAccounts()`.
6. **UI:** Realtime on `copy_master_events / copy_execution_logs / copy_trade_links / copy_strategy_followers` invalidates the admin and trader copy pages.

Worker start-up **throws** unless `WSA_COPY_ENGINE_ENABLED=true`, `BROKER_EXECUTION_ENABLED=true`, and `API2TRADE_BASE_URL/USERNAME/PASSWORD` are present. `event_time` of a live OPEN event is the **detection time**; a position that was already open when the stream started carries the broker's open time (that is what `copy_new_trades_only` compares with).

### 9.3 `executeCopyForEvent` — gate order and per-follower pipeline [code: `copyTradingService.ts`]
Global gates (in order): `copyEnabled` → `emergencyStop` → `liveCopyEnabled` → strategy `mode==='LIVE' ∧ live_enabled` → `adapter.executionAvailable()` (→ `COPY_EXECUTION_NOT_CONFIGURED` 501 when `BROKER_EXECUTION_ENABLED≠true`). Non-OPEN events are routed to `executeLinkedCloseOrModify` (uses `copy_trade_links`). **Because the global gates run first, an emergency stop / “copy paused” also blocks CLOSE and MODIFY of already-copied positions.**

Per follower (OPEN): `copy_new_trades_only` → general risk state (`getRiskEnforcementState().blockedNewTrades`) → `evaluateFollowerEligibility` (first failing reason wins: emergency, global pause, account pause, follower status, consent, account status must be CONNECTED, symbol block/allow, max open trades, daily loss, drawdown, consecutive losses) → scaling mode → `calculateFollowerLot` → second eligibility (max lot, slippage) → **reserve** `copy_trade_links` row `PENDING` (unique ⇒ idempotent; `23505` ⇒ skip, unless the existing link is `FAILED`, then retry) → try symbol candidates sequentially (e.g. GOLD↔XAUUSD; next candidate only on `PROVIDER_ERROR`) → `adapter.openTrade` inside `withBrokerExecutionSlot` (concurrency `WSA_COPY_BROKER_CONCURRENCY`, default **48** for API2Trade since the fifth pass - the keep-alive pool holds 64 connections) → link `OPEN` + logs. Failures set link/log `FAILED` — results are never faked. Orders carry the comment `wsa:<strategy-id-first-8>`. **Since the fifth pass the follower's calibration (§9.10) shapes every OPEN / MODIFY** (`lib/copy/strategyCalibration.ts`: copy / fixed distance / no stop loss and take profit, maximum slippage, maximum signal age, the symbol spelled the way the follower's broker spells it); `{}` = the defaults = the behaviour followers always had.
- **CLOSE:** link → `CLOSING` → `closeTrade` → `CLOSED`; on failure the link is restored to `OPEN` (**and no further event will retry it** — a stuck follower position needs manual action or `RETRY_COPY_LOG`). Since 2026-10-12 the claim of the copies (`OPEN` → `CLOSING`) and the read of their rows are **one atomic statement** (`UPDATE … WHERE status='OPEN' RETURNING`): a duplicate CLOSE can never send a second order, and the first follower order starts one database round trip earlier. The claim is given back if something fails before any order is sent.
- **MODIFY:** volume increase = scale-in (extra open), volume decrease = partial close, SL/TP change = modify.

### 9.4 Lot scaling (`lib/copy/lotScaling.ts`)
Modes: `FIXED_LOT`, `FIXED_MULTIPLIER`, `BALANCE_PROPORTIONAL`, `RISK_PERCENT` (needs symbol specifications + SL), `EQUITY_PROPORTIONAL`. `clampLot` **bumps a too-small lot up to `minLot` (default 0.01)** instead of skipping, so the “below minimum lot” skip is effectively unreachable. Follower-side settings also cover reverse copy, symbol mapping/allow/block, max open trades, max lot, slippage.

### 9.5 In-memory caches in the copy engine (**critical for behaviour**)
`copyTradingService` keeps module-level caches with TTL `WSA_COPY_RUNTIME_CACHE_MS` (**default 300000 ms = 5 min**, max 600000) for: global settings, strategy rows, followers, snapshots, account rules/status/risk, plus a per-strategy “hot runtime” built by `warmCopyStrategyAccounts`. Followers are refreshed from the DB at each warm-up, but settings/risk/status/snapshots go through the `…Cached` loaders. `deploy/aws/wsa-worker-start.sh` does **not** override this value. Practical effects:
- An **emergency stop, copy pause, follower-settings change or risk restriction made in the web app can take up to ~5 minutes to reach the worker** (the web process cannot invalidate worker memory).
- New followers appear at the next warm-up (≈5 s) — their first master event may be skipped if it arrives before that (hence the delayed retry in step 4).

### 9.6 Worker/engine knobs (names only; defaults in code)
`WSA_COPY_ENGINE_ENABLED`, `BROKER_EXECUTION_ENABLED`, `WSA_COPY_POLL_MS` (100), `WSA_COPY_STREAM_DISCOVERY_MS` (2000), `WSA_COPY_HEARTBEAT_MS` (5000), `WSA_COPY_WARMUP_MS`, `WSA_COPY_RUNTIME_CACHE_MS`, `WSA_COPY_DIRECT_EXECUTION`, `WSA_COPY_HOT_PATH_WARMUP`, `WSA_COPY_FOLLOWER_BATCH_SIZE` (48, was 24), `WSA_COPY_BROKER_CONCURRENCY` (48 for API2Trade, was 24), `WSA_COPY_EVENT_CONCURRENCY`, `WSA_COPY_BACKGROUND_JOB_POLL_MS` (1000), `WSA_COPY_EXECUTION_PRIORITY_MS` (4000, max 15000; premium “ultra fast” tier is prioritised), `WSA_COPY_TIMING_LOGS`, `API2TRADE_WARM_SESSION_TTL_MS` (300000), `API2TRADE_SYMBOL_SPEC_CACHE_MS`. Added 2026-10-12: `WSA_COPY_OPEN_CONCURRENCY` (4 streams opened at the same time), `WSA_COPY_STREAM_RETRY_MS` (2000 → 15000); `WSA_COPY_EVENT_CONCURRENCY` (8) is now the limit of parallel copy chains **per stream**; `API2TRADE_REQUEST_TIMEOUT_MS` (12000), `API2TRADE_POLL_TIMEOUT_MS` (5000), `API2TRADE_ORDER_TIMEOUT_MS` (20000), `API2TRADE_KEEPALIVE_POOL`, `API2TRADE_KEEPALIVE_MS` (30000), `API2TRADE_POOL_CONNECTIONS` (64), `API2TRADE_WS_FALLBACK_POLL_MS` (1000, min 250), `API2TRADE_REST_POLL_MS` (400), `API2TRADE_FAST_POLL_MS` (300), `API2TRADE_WS_SILENCE_MS` (75000, 0 = off). Added in the fifth pass: `WSA_DB_KEEPALIVE_POOL` (`false` keeps the database on the platform `fetch`), `UV_THREADPOOL_SIZE` (AWS script: 16), the gateway's `WSA_TRADE_GATEWAY_ENABLED` / `_POLL_MS` (100) / `_IDLE_POLL_MS` (750) / `_STATE_MS` (1000) / `_CONCURRENCY` (8) / `_STATE_CONCURRENCY` (6), and the self-copy engine's `WSA_SELF_COPY_ENABLED` / `_REPORT_MS` (45000) / `_WARMUP_MS` (60000) / `_RECOVERY_MS` (300000).

### 9.7 What the web app can still do to the engine
Admin endpoints can call the same functions from Vercel: `POST /api/admin/copy/events/{id}/execute|simulate`, `/api/admin/copy/logs/{id}/retry`, `/api/admin/jobs/run-now|enqueue|retry|cancel`, strategy `publish/archive/simulate/monitor/followers`, `admin/copy/settings` (global switches), `admin/copy/rules`, `admin/copy/runtime` (engine status). Job claiming uses `SKIP LOCKED`, so web-run and worker-run jobs do not collide; **but live execution from a local/other process is real execution** (see §16).

### 9.8 Self-copy (`selfCopyService.ts` + the engine in `lib/copy/selfCopy*.ts`; rebuilt in the fifth pass, 2026-10-12)
**What it is.** A trader copies their *own* account A → B (a "route", `self_copy_relationships`, status LIVE · PAUSED · ARCHIVED), independent of strategies and billing entitlements (but it needs the platform subscription). Own-account pairs only, with cycle detection (`hasPath`), evaluation accounts excluded, both accounts CONNECTED / SYNCING. Like everything on MetaTrader it runs on the **AWS copy worker**; the web app only edits the route and reads what the worker wrote.

**Request (Albanian, summarised): "self-copy does not react at all - review it so it has every function needed to calibrate the trades and work as well as possible".** The old executor could skip a trade at a dozen places **without leaving any trace**: the platform switches (`copyEnabled` / `liveCopyEnabled` / `emergencyStop`), a position that was already open when the stream started, the follower's symbol spelling, a risk block, a lot that came out as zero... and the web screen could not say whether the worker was even listening to the source account. "It does nothing" could not be told apart from "the route is switched off" or "the stream never opened". Events were also strictly serial per source account, and `simulateSelfCopy` was a dead path (it checked a status that does not exist). No single root cause was proven (nothing ran against the live system) - the fix is that **nothing is silent any more**, and each of those gates is now either explained or removed:

| Piece | What it does |
|---|---|
| `selfCopyDecision.ts` (pure) | One decision per (route, position) with a **code and a sentence** for every gate - `PLATFORM_COPY_PAUSED`, `PLATFORM_EMERGENCY_STOP`, `PLATFORM_LIVE_DISABLED`, `EXECUTION_DISABLED`, `ROUTE_NOT_LIVE`, `ROUTE_COPY_OFF`, `ROUTE_EMERGENCY_STOP`, `SOURCE_NOT_READY`, `FOLLOWER_NOT_READY`, `EXISTING_POSITION`, `SIGNAL_TOO_OLD`, `ALREADY_COPIED`, `RISK_BLOCKED`, `SYMBOL_BLOCKED`, `SYMBOL_NOT_ALLOWED`, `MAX_OPEN_TRADES`, `DAILY_LOSS_LIMIT`, `DRAWDOWN_LIMIT`, `LOT_INVALID`, `PLATFORM_MAX_LOT`, `LEVELS_UNAVAILABLE`. The first failing gate wins for a live copy; the same function drives **"Check route"** (all gates shown). Also the route's settings (`readSelfCopySettings`, including `calibration` and `liveSince`) and `isExistingForRoute`. |
| `selfCopyEngine.ts` | Copies one position event (OPEN · MODIFY · CLOSE) onto all routes of its source **in parallel**. The copy link is **reserved before the order is sent** (one order per route and source position; a timed-out order is never sent again by itself); every position of every route ends as an activity row - COPIED · SKIPPED · FAILED - with the milliseconds each stage took. Nothing waits for a convenience: the follower's symbol list gets a few hundred milliseconds, then the order goes out with the names it knows. Shared with the AWS worker (no Next / React / `server-only`). |
| `selfCopyStore.ts`, `activityLog.ts` | Database side with the service role (facts cached 3-10 s, the route's links, the follower's facts). Activity rows go through a **write-behind queue** so a copy never waits for a log line; a missing table or column switches the queue off and is re-checked after 10 minutes. |
| `selfCopySources.ts`, `selfCopyEvents.ts` | Which source accounts the worker listens to (a source with a LIVE route; a source whose routes are all PAUSED is still followed while copies are open - pausing stops NEW copies, it does not abandon the open ones) and the conversion of a broker stream change into an engine event (a time that is not certainly a UTC instant is not used for `isExistingForRoute`). |
| `selfCopyEngineStatus.ts` | Whether the worker listens to the source: it writes `engine_status` (STARTING · LIVE · ERROR), `engine_error` and `engine_heartbeat_at` on the route when it opens / loses / keeps the stream (about every 45 s, `WSA_SELF_COPY_REPORT_MS`); the web treats a report older than 3 minutes as "worker not listening" (state `listening · starting · error · stale · unreported`). |
| `selfCopyView.ts`, `SelfCopyPanel.tsx`, `SelfCopyRouteDetails.tsx`, `SelfCopyPlatformBanner.tsx`, `CopyCalibrationFields.tsx` | The screen: a banner for the copy system as a whole (live copy off, emergency stop, AWS system not answering), a worker badge per route, the **activity list** of the route (last copies, skips and failures with their reason and timing), the **Check route** dry run (`POST …/self-copy/[id]/check` replaces the dead `simulate` route; it takes a real open trade, the last trade or an example as the sample) and the calibration form. |

**Worker shape** (`scripts/wsa-copy-worker.ts`). One stream (pump) per *source account*; the routes come from the discovery loop (every 2 s) and are read by the events as they run, so pausing / resuming / editing a route takes effect within seconds without reopening the stream; one chain per source ticket (OPEN → MODIFY → CLOSE in order, different tickets in parallel - the old queue was one strict line per source); the broker sessions and symbol lists of the follower accounts are warmed (`WSA_SELF_COPY_WARMUP_MS`, 60 s) so the first order of a trade pays for neither; a position seen once by this process is not repeated if the stream is opened anew; a safety net closes copies of source positions that vanished while nobody listened (`WSA_SELF_COPY_RECOVERY_MS`, 5 min - this is the only missed-CLOSE recovery, it works from the *confirmed* open list of the source); activity older than 14 days is pruned. `WSA_SELF_COPY_ENABLED=false` switches the engine off on a worker without touching the strategies.

**Rules that did not change.** OPEN needs `adapter.executionAvailable()`, global `copyEnabled ∧ liveCopyEnabled ∧ ¬emergencyStop`, an eligible follower account, no `blockedNewTrades`, the symbol / max-open / daily-loss / drawdown limits and a lot > 0; links live in `self_copy_trade_links`; CLOSE and MODIFY **ignore** the global emergency stop (unlike the strategy engine); a failed CLOSE restores the link to `OPEN` and is not retried. `copyNewTradesOnly` is literally `true`: a route copies only trades that opened after it went live (`liveSince` is set when the route is created and every time it is resumed, never by the person).

**Calibration of a route** (`lib/copy/calibration.ts`, the same type the strategy followers use, §9.10): copy the source's stop loss / take profit or not, or use a fixed distance in points instead; a maximum slippage in points; a maximum signal age (a copy that would start later is skipped, not sent late); automatic symbol matching to the follower broker's spelling. The lot options are the existing modes (balance ratio, multiplier, fixed lot, risk %), min / max lot, max open trades, daily-loss and drawdown limits, allowed / blocked symbols, a manual symbol mapping and *reverse copy* (a reversed trade swaps the source's stop loss and take profit - copying them as they are made every reversed trade fail at the broker with "invalid stops"; a level on the wrong side of the entry is left out with a note instead of sending an order the broker would refuse as a whole).

**Fixed on the way.** A MODIFY of a stop that had moved past the entry price (break-even, trailing stop) was dropped by the side check; MODIFY now passes `entryPrice: null` (and positions that were already open are not side-checked at all, `checkSides: !existing`), so the broker judges the level - the same in `shapeStrategyModify` for strategy followers. `--color-lime` (used by the new screen) did not exist in the theme and is now an alias of `--accent-2` in `globals.css`.

**Unverified.** The engine and the screen were tested with in-memory fakes and jsdom only. Not seen against a real source stream, a real follower broker or in a browser. The activity log needs migration 061 to reach the screen (without it the lines reach the worker's log and the route shows what the copy links say).

### 9.9 Latency and robustness rework (fourth pass, 2026-10-12)

**Request (Albanian):** review how copy trading is built and whether it is fully functional; it works but there is a delay of 2 seconds or more on executions, modifications or receiving commands; API2Trade has offered 41 ms for a long time, so look for a blockage or slowdown in the data processing and make the system as fast as possible.

**Short answer.** The copy path was functionally complete (detect → store event → gates → follower orders → links → logs, close and modify included), but a set of waits and robustness faults added up to the 2 s or more that was seen. None of them is the bridge itself. All are addressed in code (below). **Nothing was run against a real API2Trade or a real account**, so the gain is expected, not measured: watch the first live trades with `WSA_COPY_TIMING_LOGS=true`.

| # | Cause of the delay | Fix |
|---|---|---|
| 1 | The order stream (WebSocket) was used only for messages shaped `openedOrders` / `update`; every other message was ignored, so the 2 s safety poll found the change | `lib/broker/orderUpdateMessage.ts` sorts a frame into *snapshot* (full list - applied at once), *signal* (anything about an order - wake the engine, read REST immediately) or *ignore* (OK / ping / heartbeat). The safety poll runs every 1 s (0.4 s without a socket) and every 0.3 s for a while after it caught something the stream missed |
| 2 | One worker loop did everything in turn: a slow follower order, opening a stream (database + broker round trips, seconds) or one slow query held up the detection of **every** trade (head-of-line blocking) | `lib/copy/streamPump.ts`: an independent pump per stream. Detected changes go into `lib/copy/keyedChains.ts`, one chain per master position (OPEN → MODIFY → CLOSE of one ticket stay in order; other tickets and strategies never wait for each other, `WSA_COPY_EVENT_CONCURRENCY` limits parallel chains per stream). Finding / opening streams is a separate loop, background jobs have their own timer |
| 3 | No time limit on any bridge call: one hung request froze whatever awaited it | `AbortSignal.timeout` on every request (12 s; 5 s for `OpenedOrders`; 20 s for orders). A timed-out order is reported as "no answer" and never retried by itself |
| 4 | A burst of orders after a quiet period started each with a new TCP + TLS handshake (the default connection pool closes idle sockets after about 4 s) | `lib/broker/api2TradeTransport.ts`: keep-alive pool (`undici`, 30 s keep-alive, 64 connections), switched on by the copy worker only; falls back to the platform `fetch` if it cannot be loaded |
| 5 | `reconcile()` awaited the WebSocket connection and polled REST every 100 ms while the socket was down | The socket is rebuilt in the background (back-off 250 ms → 5 s); a dead or silent socket is detected (ping, 75 s silence limit) |
| 6 | Followers were executed in batches that waited for the slowest order | `lib/copy/pool.ts` (`runPool`): a finished order makes room for the next one at once (`WSA_COPY_FOLLOWER_BATCH_SIZE`); sessions of the follower accounts are already warm (`warmedSessions`, refreshed every `WSA_COPY_WARMUP_MS`); CLOSE reads + claims its copies in one statement |
| 7 | The "broker event age" in the timing log was misleading | the log now states how long the position had been open at the broker when it was detected (`openedBeforeDetectionMs`) and the stages after that |

**Correctness fixes found on the way**
- *Spurious CLOSE.* A stale or reordered snapshot, or a non-array `OpenedOrders` answer, could look like "the master closed everything". Snapshots are ordered and a stale one is ignored; a list in which **every** position vanishes at once is confirmed by a second read before any CLOSE is emitted; rows that cannot be told apart are an error, not "nothing open"; `openedOrdersChecked` turns an unexpected answer into an error (an empty body still means "nothing open").
- *CLOSE racing the OPEN.* A CLOSE that arrived while the follower's OPEN link was still `PENDING` was skipped and the follower trade stayed open. OPEN → MODIFY → CLOSE of one ticket are now serialised, and the CLOSE claim is atomic.
- *Risk gate "max open copied trades".* It was counted from capped, unordered execution logs and the 5-minute cache was never moved. The LIVE count now comes from `copy_trade_links` (exact counts: OPEN + CLOSING + PENDING younger than 2 minutes), and the cached counter is adjusted on every reservation (+1), failed order (−1), close (−1) and scale-in (+1). Concurrent opens for one follower can still marginally exceed the limit in the check → reserve window.
- *Link writes.* Recording the broker ticket on the link after a successful order is retried at 100 / 400 / 1200 ms (an order at the broker without its link would be copied again or never closed); the error text names the broker position.
- *Event store.* `copy_master_events` insert retries (150 / 600 / 2000 ms); a duplicate after a failed attempt is looked up before it counts as "seen before"; `dedupe_key` stays the idempotency key.
- *Stream lifecycle.* A failed first `reconcile()` closes the warm-up ticker and the socket; a failure is handled outside the pump (no deadlock); each stream retries on its own back-off.
- *Admin client.* `createAdminClient()` is memoised per URL + key (one client and one connection pool instead of a new client per call on the hot path). **Never sign users in with that client** (the memoised object is shared).

**Files.** New, shared with the AWS workers (no Next / React / `server-only`): `lib/copy/{pool,keyedChains,streamPump,masterEvents}.ts`, `lib/broker/{api2TradeTransport,orderUpdateMessage}.ts`. Heavily changed: `scripts/wsa-copy-worker.ts` (rewritten), `lib/broker/{api2TradeLiveSource,api2TradeClient}.ts`, `lib/services/copyTradingService.ts`, `lib/supabase/admin.ts`. New dependency `undici` (declared in `package.json`). Tests: `copyPool`, `keyedChains`, `streamPump`, `masterEvents`, `orderUpdateMessage`, `api2TradeLiveSource` (47 cases, fake `ws` + fake timers), `api2TradeClientTimeouts`, `api2TradeTransport`.

**Is copy trading "fully functional"?** Functionally yes for these paths: OPEN / MODIFY (SL, TP, volume increase = scale-in, volume decrease = partial close) / CLOSE of a master position on every eligible follower with its own lot scaling, symbol mapping, risk gates and idempotency; self-copy A → B; admin retry of a failed copy; emergency stop / pause (with the R5 semantics). What is **not** covered or not proven:
- (a) nothing was run against a real bridge: the WebSocket payload shapes and the bridge's behaviour under load are assumed;
- (b) after worker downtime, a master position that was closed while the worker was off is **not** closed on the followers when the worker restarts (only the legacy self-copy path has missed-close recovery; it was deliberately not added for strategies, because a wrong snapshot could mass-close follower trades);
- (c) a follower link stuck in `CLOSING` after a crash is not recovered automatically;
- (d) an order that timed out may still have been executed by the broker;
- (e) follower daily-loss / drawdown caches are still 5 minutes (R5), and the global emergency stop still blocks CLOSE / MODIFY (R5);
- (f) ~~self-copy events stay strictly serial per source account~~ - fixed in the fifth pass: one chain per source ticket, tickets in parallel (§9.8).

**How to measure on the first live run.** Set `WSA_COPY_TIMING_LOGS=true` on the copy worker: per event it prints the time from the broker's open to detection, to the stored event and to each follower order. Compare it with the bridge's 41 ms; if a stage is slow, that stage is where to look.

### 9.10 Fifth pass (2026-10-12, evening): calibration for strategy followers and the last milliseconds

**Request (Albanian, summarised):** copy trading works as a system but the time is still very long (tests are done on the owner's local machine); self-copy does not react at all; give copy and self-copy every function needed to calibrate the trades; look again at how to make copy trading faster - it is the principle of the platform: catch time at super speed, milliseconds on executions, no delays.

**Where the time goes on a strategy OPEN** (the critical path, after the fourth pass): detect the master's change (order-stream push → either the snapshot is applied without a REST call or one `OpenedOrders` read) → **one Supabase write** for the master event (`copy_master_events`, the idempotency key) → for every follower in parallel: **one Supabase write** to reserve the link (`copy_trade_links`, unique per follower) → the broker order (API2Trade; the bridge's own ~41 ms is the floor) → the link update (per follower, in parallel with the other followers). So two database round trips sit in front of every order, and **they were the remaining avoidable cost**:

| # | Cause | Fix |
|---|---|---|
| 1 | The platform `fetch` closes an idle connection after about 4 s. After a quiet moment the first copy started **each** of its database calls with a new TCP + TLS handshake (three extra round trips) right in front of the order - on a distant database several hundred milliseconds per call | `databaseFetch` in `lib/broker/api2TradeTransport.ts`: `createAdminClient()` hands it to supabase-js as `global.fetch`, so the database shares the keep-alive pool the bridge already used (`undici`, 30 s, 64 connections). It is the platform `fetch` whenever the pool is off - the web app on Vercel never turns it on - and when `WSA_DB_KEEPALIVE_POOL=false` |
| 2 | A pool only keeps the connections it used lately: in a quiet minute that is one or two, but a burst needs one per follower | `warmDatabaseConnections(read, count)`, called from `warmCopyStrategyAccounts` (every warm-up, throttled to once per 8 s): `followers + 1` (at most 32) one-row reads of a small table in the background, so that many sockets are open and idle when the master trades. Never throws, never awaited |
| 3 | Parallel orders per stream were limited to 24 (`WSA_COPY_BROKER_CONCURRENCY`, `WSA_COPY_FOLLOWER_BATCH_SIZE`) while the pool holds 64 connections | Both default to **48** |
| 4 | The WSA Trade gateway looked for commands every 150 ms | 100 ms (`WSA_TRADE_GATEWAY_POLL_MS`) |
| 5 | Node resolves host names on a thread pool of 4; a burst that opens many connections at once queues on it | `UV_THREADPOOL_SIZE=16` in `deploy/aws/wsa-worker-start.sh` (connections are kept open afterwards, so this matters at start-up and after long silences) |

**Deliberately not changed - the idempotency stays database-first.** The event row and the link reservation are written *before* an order is sent, because they are what makes a duplicate detection, a restart in the middle of a burst or a retried event unable to open a second position (`copy_master_events.dedupe_key`, `copy_trade_links UNIQUE(source_event_id, follower_account_id)`). Writing them after the order, or fire-and-forget, would shave two round trips and could double-open a follower's trade. With warm connections each of those two round trips is one network round trip to Supabase. **`[verify]`** that the Supabase project is in the same region as the AWS box (eu-west-2, London): a project in another region adds its round-trip time twice to every copy, and no code change can remove that.

**The gain is expected, not measured.** Run the first live trades with `WSA_COPY_TIMING_LOGS=true` on the copy worker and read the stages (broker open → detected → event stored → each follower order). If the owner times copies from a local machine, that machine's own distance to Supabase and API2Trade is part of the number; the AWS worker's numbers will differ.

**Calibration of strategy followers (migration 061, `copy_strategy_followers.calibration jsonb default '{}'`).** The same `CopyCalibration` self-copy uses (`lib/copy/calibration.ts`): `copyStopLoss`, `copyTakeProfit` (default true), `stopLossPoints`, `takeProfitPoints` (a fixed distance from the entry that replaces the master's level), `maxSlippagePoints` (the stricter of this and the platform's limit applies), `maxSignalAgeMs` (an OPEN older than this when it is about to be sent is skipped with the code `SIGNAL_TOO_OLD`, not sent late), `autoSymbolMatch` (default true: find the follower broker's own spelling in its symbol list) and `copyExisting` (self-copy only; strategies keep their own `copy_new_trades_only`). **`{}` = the defaults = what followers always got**, with two fixes nobody wants undone: a reversed trade swaps its stop loss and take profit (the broker refused them as they were) and the follower broker's spelling of a symbol is used when its list is known. Pure shaping lives in `lib/copy/strategyCalibration.ts` (`shapeStrategyOpen`, `shapeStrategyModify`, `followsLevels`, `signalAge`), the loading and the call sites in `copyTradingService` (`readCalibration`, `symbolsWithin` - a cold follower symbol list is waited for at most `SYMBOL_LIST_BUDGET_MS` = 250 ms, then the order goes out with the names it already has, `loadCalibrationsOfTrader`, `withOptionalCalibration`); the settings dialog (`FollowerSettingsDialog` + `CopyCalibrationFields`) edits it and `PATCH /api/copy/subscriptions/[id]/settings` saves it. **Without migration 061** the app works: reads fall back to the defaults, and saving a non-default calibration answers **409 with a clear message** (it is never silently dropped). The strategy "simulation" path (`simulateOneEvent`) does not use the calibration.

**Files.** New (shared with the AWS workers): `lib/copy/{calibration,strategyCalibration,followerSymbols,selfCopy*,activityLog}.ts`. Changed: `lib/broker/api2TradeTransport.ts`, `lib/supabase/admin.ts`, `lib/services/copyTradingService.ts`, `scripts/wsa-copy-worker.ts`, `deploy/aws/wsa-worker-start.sh`. Tests: `copyCalibration`, `strategyCalibration`, `api2TradeTransport` (25 cases incl. `databaseFetch` and `warmDatabaseConnections`), `selfCopyDecision`, `selfCopyEngine`, `selfCopyView`, `selfCopyEvents`, `selfCopySources`, `selfCopyEngineStatus`, `activityLog`.

---

## 10. Risk engine

- **Rules:** `risk_rules` (platform-wide and per account), action `WARN | LIMIT | RESTRICT`. **Events:** `risk_events` (+ `notifications` of type RISK_EVENT). **State:** `account_risk_states` (`blocked_new_trades`, `restricted`).
- `evaluateAndEnforceRiskValues` (`riskEvaluationService.ts`): loads platform + account rules, computes drawdown against `trading_accounts.equity_peak`, creates events/notifications (deduplicated), upserts `account_risk_states`, and flips the account **CONNECTED ↔ RESTRICTED** (`risk_restricted_at`). `evaluateAndPersistRiskEvents` is the older SYNC-source path.
- **Who runs it:** the AWS **risk worker** (`scripts/wsa-risk-worker.ts`): every ~5 s (`WSA_RISK_RECONCILE_MS`) loops batches of 250 CONNECTED/RESTRICTED accounts (`WSA_RISK_ACCOUNT_PAGE_SIZE/BATCH_SIZE`): `adapter.fetchSnapshot` → RPC `record_account_snapshot` (rate-limited by `WSA_RISK_SNAPSHOT_MS`, 30 s on AWS) → `evaluateAndEnforceRiskValues` (source `API2TRADE_POLL`) → `refreshAccountTrades` every ~15 s (`WSA_TRADE_RECONCILE_MS`) → partner-rebate calculation. A MetaApi stream branch exists in the file but is dead.
- **Copy interplay:** `getRiskEnforcementState(accountId).blockedNewTrades` blocks *new* copied trades (read through the 5-minute cache, §9.5). Evaluation accounts have their own rule engine (§13).
- Admin UI: `/admin/risk` (rules/events), trader `/risk` (own rules/events/daily P&L).

---

## 11. Billing, subscriptions and entitlements

### 11.1 Catalogue [code: `billingService.ts`, 2268 lines]
| Code | Price | Type |
|---|---|---|
| `PLATFORM_MONTHLY` | 50 USD / month | subscription (unlocks platform + prerequisite for copy) |
| `COPY_NORMAL` / `COPY_ULTRA_FAST` | 10 / 15 USD / month | copy entitlement tiers |
| `COPY_STRATEGY_<id>_STANDARD` | per strategy | created at publish time (inline `price_data`) |
| `BOT_EA` | 500 USD one-time | marketplace bot |
| `MENTORSHIP_1_1` | 2500 EUR one-time | academy mentorship |
| `EVALUATION_CHALLENGE` | free | evaluation start |

### 11.2 Modes and flow
- `getBillingRuntimeMode()` = `BILLING_PROVIDER === "stripe" ? "stripe" : "mock"` → **anything else (including unset) is MOCK**.
- Checkout (`POST /api/billing/checkout`) → order in `payment_orders` (PENDING) → Stripe Checkout (subscription mode for monthly products; price ids from `STRIPE_PRICE_*`; `success_url = <origin>/billing/return?orderId&session_id`). In mock mode `/billing/return` calls `POST /api/billing/mock-confirm`, which marks **the caller’s own** PENDING MOCK order paid (the route has only `requireAuth`; the service refuses unless the billing mode is mock).
- **Webhook** `POST /api/webhooks/stripe`: verifies the signature, inserts a `stripe_webhook_events` row (idempotency), handles `checkout.session.completed`, `checkout.session.async_payment_succeeded/failed`, `invoice.paid` (extends period), `invoice.payment_failed` (log only), `customer.subscription.updated/deleted` (deleted ⇒ cancel + **revoke** follower), `charge.refunded` (order → REFUNDED, **access not revoked**). Failures are swallowed → status FAILED, always HTTP 200, so Stripe never retries and later deliveries hit the “existing” check.
- **Provisioning:** `markOrderPaid` → `ensurePaidOrderProvisioned` (subscription rows / `copy_account_entitlements` + `ensureActiveCopyFollowerForPaidOrder` / `bot_access_records`) → `maybeCreatePartnerCommission` (partner’s `commission_percent` of gross, status PENDING, unique per `purchase_id`).
- **Return reconciliation:** `getBillingReturnStatus` re-reads the Stripe session on `/billing/return`, which is what makes local development (no webhook) work.
- **Expiry:** `expireStaleEntitlements` (called from the webhook and the worker) → EXPIRED + follower REVOKED; access = `period_end > now` (≈31-day periods for non-Stripe orders).
- `scripts/setup-stripe-products.ts` creates Stripe products/prices — **never run it against the wrong Stripe account**.

---

## 12. Partner (IB) system

- **Onboarding:** register with role PARTNER → `partner_profiles(PENDING_REVIEW)` → admin approves/rejects (`/api/admin/partners/{id}/approve|reject`). Traders join a partner via referral code at sign-up (`handle_new_user`) or admin assignment (`/api/admin/traders/{id}/partner`, `partnerAdminService.assignTraderToPartner`, `claimReferral`).
- **Visibility:** partner queries are scoped by `trader_profiles.partner_id`; partners see traders, activities, risk events, CRM notes, commissions, rebates, payouts/withdrawals.
- **Earning models** (`partner_broker_configurations`, migration 054; pages `rebate`, `cpa`, `hybrid`, `wsa-commission`, `wsa-payout`) - audited and rebuilt 2026-10-12:
  - **Platform (WSA) commission = the only money WSA pays out.** `partner_profiles.commission_percent` × the paid order (`billingService.maybeCreatePartnerCommission`: rounded to cents via `commissionOnSale`, currency upper-cased so the withdrawal queries find it, nothing created for 0 %) → `partner_commissions` PENDING → admin APPROVED → PAID through withdrawal allocations. A **refunded** order (`charge.refunded`) takes the commission back: PENDING or APPROVED-and-unreserved → `REVERSED` (audit `PARTNER_COMMISSION_STATUS_CHANGED`, reason `order_refunded`); PAID commissions and commissions already reserved by a withdrawal request are left for the admin. The "wallet" of the UI = APPROVED WSA commission (minimum 100, one active request per currency).
  - **Broker earnings (IB / CPA / Hybrid) are reporting only** - never withdrawable (`createPartnerWithdrawal` allocates commissions only). The admin enters the terms **per partner and per broker** (plus one default for "all brokers"; `pickBrokerConfiguration`: provider id → broker name → default). **IB** = lots × rate (own rate for XAUUSD), **CPA** = one payout per partner / client / broker once the client's lots since joining reach `cpa_qualification_lots` and the deposit reaches a tier, **HYBRID** = both. Engine: `partnerRebateCalculationService` (rules in `lib/partner/rebateRules.ts`, paged reads in `lib/supabase/pagedSelect.ts`) - **shared with the AWS workers** (called from `brokerSyncService` after each persisted trade batch).
  - What earns: only CONNECTED live accounts (TRADER / COPY_MASTER, never evaluation accounts) and only trades **closed after the trader was attributed to the partner** (`trader_profiles.partner_assigned_at`); zero-volume balance rows never. Rows are created already APPROVED and idempotent: unique `(trade_id, calculation_type)` for IB; **CPA-once is also checked in code** because the DB index does not protect a NULL `broker_provider_id` (cancelled rows count as "done", so an admin cancellation sticks). Trades are read newest first, 1000 per page, until a page needs nothing - a normal sync costs 1-2 pages, a backlog (agreement added later, workers were off) is worked off up to 20 000 trades per call.
  - Totals on partner / admin pages (`getPartnerRebateTotals` → `summarizeRebates`) cover **every** rebate row (paged read, one currency): earned = APPROVED + PAID, pending, IB / CPA split, lots (IB rows' lots, or CPA rows' lots in the CPA view - never both), distinct clients and brokers. `GET /api/partner/rebates?view=REBATE|CPA|HYBRID` returns the newest 500 rows plus those totals: Rebate page = IB rows, CPA page = CPA rows, Hybrid page = rows of Hybrid agreements. The old pages summed only the newest 1000 rows, counted lots twice and mixed WSA commission into the "broker" tiles.
  - Triggers: after each broker trade persistence, and as a safety net `refreshPartnerRebatesIfStale` (once a minute per partner and server instance, errors swallowed) from `GET /api/partner/rebates` and `getPartnerSummary` - **those GETs can write**.
  - Admin form validation: for CPA / Hybrid the three tier deposits must not decrease (`partnerBrokerConfigurationSchema`).
- **CRM:** a partner's clients are the traders attributed to them (referral code at sign-up or admin assignment); the CRM page offers pipeline, notes and per-client earnings. There is **no** manual "add client / prospect" form.
- **Withdrawals** (`partnerWithdrawalService`): minimum 100; one active request per currency (DB-enforced); allocations are drawn **only from APPROVED commissions** (`createPartnerWithdrawal` never creates rebate allocations although the table exists); `PENDING_REVIEW → APPROVED|REJECTED`, `APPROVED → PAID|REJECTED`; marking PAID reconciles commissions/rebates to PAID. Every ledger / balance read is paged (PostgREST 1000-row limit, id lists in chunks of 100); the admin ledger lists every commission, every CPA row / adjustment and the newest 500 per-trade IB rows (`rebateRowCount` / `rebateRowsListed` tell the UI when it is capped) while its totals always cover all rows. Admin UI: `/admin/partners/withdrawals` (ledger chips: All · WSA commission · Rebate · CPA · WSA payout).

---

## 13. Other functional modules

| Module | How it works |
|---|---|
| **Evaluations (prop challenge)** | `evaluation_programs` (starting balance, profit target, daily/overall drawdown, min trading days, duration, required academy course) → trader starts an attempt (free product) → links a **fresh CONNECTED demo account** (no trades, balance == program start within tolerance, not in copy trading, academy 100% complete) → rules engine (`evaluationRulesEngine`) from `account_snapshots`/`trades`: **FAIL** on daily/overall drawdown breach, **PASS** when target met *and* min trading days, **EXPIRED** at `ends_at`. PASS ⇒ `funding_status=PENDING_REVIEW`, certificate (`evaluation_certificates`, PDF via `pdf-lib`, public verification id `/certificates/verify/{id}`), admin notifications. Admin can override, set funding (FUNDED sets trader segment FUNDED), revoke certificates. Jobs: `SYNC_EVALUATION_ACCOUNT`, `CHECK_EVALUATION_ATTEMPT`, `CHECK_ALL_ACTIVE_EVALUATIONS` (every 5 min by the background worker). |
| **Academy** | courses → modules → lessons (+materials, instructor remarks, Q&A), per-user progress/notes, webinars with attendance. Admin CRUD in `/admin/academy`. Completion gates evaluation start. |
| **Marketplace / My Bots** | `bot_products`; trader requests access (`bot_access_records` REQUESTED) or pays (BOT_EA auto-activation, migration 035); admin grants/suspends; license keys are generated, only a **hash** is stored (`hashLicenseKey`), verified by the public `POST /api/licenses/verify` (per-license rate limit, hashed IP/UA in `bot_license_verification_logs`); EA/bot files are uploaded to the **private** Storage bucket `bot-files` (≤ 50 MB) and downloaded through `getProtectedBotDownload`. |
| **AI assistant** | Providers: Gemini (`gemini-2.5-flash` chat, `gemini-2.5-pro` charts) or OpenAI Responses (`gpt-4.1-mini`). Key source: `ai_provider_settings` (AES-GCM, admin saves → **tests** → **activates**, SUPER_ADMIN only) else env `GEMINI_API_KEY` / `OPENAI_API_KEY` (`AI_PROVIDER` preference). Limits: per-user per-UTC-day successful calls (chat 20, chart 3; env `AI_CHAT_DAILY_LIMIT`/`AI_CHART_DAILY_LIMIT`, overrides in `ai_user_limits`) and token credits (50 000 initial, RPC `deduct_ai_credits`). `/api/ai/chat` = TRADER only; context is built server-side and **self-scoped** (accounts, trades, risk events, analytics, upcoming news) — nothing numeric is trusted from the browser. System prompts hard-code the “WSA Assistant” identity and risk disclaimers. |
| **Terminal (dxFeed)** | `MARKET_DATA_PROVIDER` = `mock` (default) or `dxfeed`; `/api/dxfeed/*` are authenticated server proxies that inject dxFeed auth headers; `terminal_provider_settings` is deny-all RLS (service role only). The trader-facing `/terminal` page (TradingView + MetaTrader web terminal, personal watchlist, saved workspace) is described in §6.9. |
| **Economic calendar** | `economic_calendar_events` (impact, status DRAFT/PUBLISHED/CANCELLED, audience ALL/TRADER, type ECONOMIC/WEBINAR/ACADEMY/PLATFORM/OTHER), admin CRUD, optional FRED import (`FRED_API_KEY`); feeds trader `/calendar` and the AI context. |
| **Reports** | `/api/reports/trades` (export), `/api/reports/pdf` (`pdf-lib` trade report). |
| **CRM / notes / contact** | `crm_notes`, `crm_activities` (admin only), partner CRM notes (source-tagged so admin notes stay private), `contact_requests` (trader-created, admin queue, rate-limited). |
| **Notifications & audit** | `notifications` (SYNC_SUCCESS / SYNC_FAILURE / RISK_EVENT / workflow types) shown in the Topbar bell; `audit_logs` written by `writeAuditLog`, read in `/admin/audit`. |
| **Realtime scaffolding** | `lib/realtime/*` (socket.io client/server) and `NEXT_PUBLIC_REALTIME_URL` exist but nothing starts a socket.io server — Supabase Realtime is what is actually used. |

---

## 14. Background jobs and workers

### 14.1 Queue (`background_jobs`, `backgroundJobService`)
`enqueueJob({type, payload, uniqueKey, priority, runAt, maxAttempts})` (unique-key conflict ⇒ reuse existing) · `claim_background_jobs` RPC (limit ≤ 20, `SKIP LOCKED`) · finalize with backoff `[60 s, 300 s, 900 s]` · `releaseStaleJobs(minutes)` (**stale jobs that touch the live broker become FAILED “inspect before retry”**, never auto-retried) · admin list/stats/cancel/retry.
Job types dispatched by `lib/workers/jobProcessor.ts`: `SYNC_ACCOUNT` (forced), `SYNC_ALL_CONNECTED_ACCOUNTS` (skipped when the risk stream owns projection), `MONITOR_*` (skipped when the live copy stream is enabled), `SIMULATE_*`, `EXECUTE_COPY_EVENT`, `CLOSE_COPY_STRATEGY`, `RETRY_COPY_LOG`, `CLEANUP_STALE_JOBS`, `SYNC_EVALUATION_ACCOUNT`, `CHECK_EVALUATION_ATTEMPT`, `CHECK_ALL_ACTIVE_EVALUATIONS`. Gate error codes (`COPY_EXECUTION_NOT_CONFIGURED`, `COPY_LIVE_DISABLED`, `COPY_EMERGENCY_STOP`, `COPY_CONSENT_REQUIRED`, `FOLLOWER_NOT_ELIGIBLE`) end the job as `SKIPPED` with **no retry**; other copy errors are non-retryable FAILED; unexpected errors are retried with backoff.

### 14.2 The three AWS workers
| Worker | Script | Loop | Responsibility |
|---|---|---|---|
| copy | `wsa-copy-worker.ts` (~1000 lines, rewritten 2026-10-12, extended in the fifth pass) | one pump per stream (≥ 100 ms, woken by the broker's order stream) for every strategy master **and every self-copy source account**; discovery every 2 s; jobs every 1 s (limit 25); **the WSA Trade gateway loop** (commands every 100 ms, watched accounts about once a second) | §9 / §9.9 / §9.10 / §9.8 / §6.9 — streams, events, copy execution, self-copy, copy-related jobs, the executor of the web terminal's orders |
| risk | `wsa-risk-worker.ts` (727 lines) | ~5 s | §10 — snapshots, risk enforcement, trade reconcile, rebates |
| background | `wsa-background-worker.ts` (87 lines) | `WSA_JOB_POLL_MS` (2 s) | `runWorkerOnce` for general job types; schedules `SYNC_ALL_CONNECTED_ACCOUNTS` (unless risk stream owns it) and `CHECK_ALL_ACTIVE_EVALUATIONS` every 5 min; releases stale jobs |

### 14.3 HTTP entry points for the queue
`POST /api/worker/jobs/run` (claims/processes a bounded batch: limit ≤ 20, `WORKER_MAX_JOBS_PER_RUN` default 5, stale minutes `WORKER_STALE_JOB_MINUTES` ≥ 5) and `/schedule` (enqueues the two fan-out jobs). Protected by `x-worker-secret`; no cron is configured in the repo (`vercel.json` absent) — the AWS background worker is the real scheduler.

---

## 15. Deployment, environments and configuration

### 15.1 Environments

| Environment | What runs | Database | Evidence |
|---|---|---|---|
| **Production web** | Vercel: UI + 241 route handlers | Supabase (keys come from Vercel env) | `[docs]`; prod origin is also hard-coded as a fallback in `src/lib/auth/redirectOrigin.ts`; no `vercel.json` ⇒ default Git-integration behaviour `[infer]` |
| **Production workers** | AWS EC2 eu-west-2 — 3 systemd units (§14.2) | the Supabase referenced by SSM `/wsa/test/*` | `[code]` `deploy/aws/*`. The SSM prefix says **test** ⇒ `[verify]` that AWS and Vercel point to the *same* Supabase project (§19) |
| **Staging / preview** | none defined in the repo | — | no `.github/`, no CI config, no `vercel.json` |
| **Local** | `START_WSA_LOCAL.bat` → `next dev --webpack`, **workers OFF** | whatever the local env file points to | §16 |
| **Automated tests** | `vitest` (52 unit files) and Playwright (5 specs, port 4321, `webServer: npm run start`) | — | `npm run start` = `tsx scripts/dev.ts --production` ⇒ **starts all workers**; never run e2e against a real DB |

### 15.2 How code reaches each environment

- **Web:** push to `main` of the GitHub repo → Vercel build (`next build`) `[infer]`. Whatever is merged to `main` is production for the web **and** the next code the AWS workers will pull.
- **Workers:** `deploy/aws/bootstrap-worker.sh` (idempotent, Ubuntu) installs Node 22 and the AWS CLI, creates user `wsa`, does `git clone --depth 1 --branch main` (or `fetch` + `reset --hard origin/main`) into `/opt/wsa/app`, runs `npm ci --omit=dev`, adds a 2 GB swapfile, installs the three units and `enable --now`. Nothing in the repo automates *updates*: a worker keeps running the commit it last pulled until someone re-runs the script, or pulls and restarts the units `[infer]`. The units use `Restart=always`, `RestartSec=10`, `StartLimitIntervalSec=0` ⇒ a worker that crashes at start-up loops forever (each restart re-reads SSM and re-opens broker sessions).
- **Secrets on AWS:** `deploy/aws/wsa-worker-start.sh` reads SSM parameters `/wsa/test/…` with the instance role (Supabase URL + service-role key, `ENCRYPTION_KEY`, optional `API2TRADE_*`, optional `METAAPI_TOKEN`), exports a block of flags (§14: `BROKER_EXECUTION_ENABLED=true`, `WSA_COPY_ENGINE_ENABLED=true`, `WSA_RISK_ENGINE_ENABLED=true`, poll/warm-up intervals, `NODE_ENV=production`) and finally `exec npm run copy:worker | risk:worker | jobs:worker`.
- **Database:** schema changes are applied by hand (Supabase SQL editor or `npm run migrate`). The live DB has drifted from the repo (R10). RLS policies, RPCs and the Realtime publication exist only as SQL.

### 15.3 Environment variables (names only, grouped)

*Values are never recorded in this document. The list was built by reading the code (`src/`, `scripts/`, `deploy/`, `tests/`), not any `.env*` file.*

| Group | Names | Read by | Notes |
|---|---|---|---|
| Supabase connection | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web (browser + server) | public by design; inlined at build time |
| | `SUPABASE_SERVICE_ROLE_KEY` | web server, workers, seed/reset scripts | **bypasses RLS** — never expose, never log |
| | `SUPABASE_DB_PASSWORD` | `scripts/run-migrations.ts` only | direct Postgres; **not** needed to run the site (R2) |
| Secrets / crypto | `ENCRYPTION_KEY` | web + workers | AES-256-GCM, key = sha256(value); encrypts broker credentials **and** DB-stored AI keys; must be identical on Vercel, AWS and any local run that shares the DB |
| | `WORKER_SECRET`, `WORKER_MAX_JOBS_PER_RUN`, `WORKER_STALE_JOB_MINUTES` | web `/api/worker/jobs/*` | header `x-worker-secret`; in production an unset secret ⇒ HTTP 503 (safe default); the AWS workers do **not** call these endpoints |
| Public URLs / WebAuthn | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `WEBAUTHN_RP_ID`, `NEXT_PUBLIC_WEBAUTHN_RP_NAME` | web | `SITE_URL`: self-fetch in `accounts/[accountId]/page.tsx` and email links; `APP_URL`: passkey origin; `RP_ID` must equal the hostname |
| | `NEXT_PUBLIC_REALTIME_URL` | web (scaffold) | socket.io scaffold that nothing starts; Supabase Realtime is what runs |
| Billing | `BILLING_PROVIDER` | web | `stripe` ⇒ Stripe, **anything else or unset ⇒ mock** (R4) |
| | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | web, `scripts/setup-stripe-products.ts` | |
| | `STRIPE_PRICE_PLATFORM_MONTHLY`, `STRIPE_PRICE_COPY_NORMAL_MONTHLY`, `STRIPE_PRICE_COPY_ULTRA_FAST_MONTHLY`, `STRIPE_PRICE_BOT_EA_ONE_TIME`, `STRIPE_PRICE_MENTORSHIP_ONE_TIME_EUR` | web | per-strategy copy products use inline `price_data`, no env price id |
| Broker bridge | `API2TRADE_BASE_URL`, `API2TRADE_USERNAME`, `API2TRADE_PASSWORD` | web + workers | platform-level credentials; `scripts/dev.ts` starts the risk worker only if all three are set |
| | `API2TRADE_EVENTS_URL`, `API2TRADE_WEBSOCKET_ENABLED`, `API2TRADE_WS_FALLBACK_POLL_MS`, `API2TRADE_WARM_SESSION_TTL_MS`, `API2TRADE_SYMBOL_SPEC_CACHE_MS`, `API2TRADE_INITIAL_CONNECT_ATTEMPTS`, `API2TRADE_INITIAL_CONNECT_DELAY_MS` | web + workers | tuning |
| | `API2TRADE_REQUEST_TIMEOUT_MS`, `API2TRADE_POLL_TIMEOUT_MS`, `API2TRADE_ORDER_TIMEOUT_MS`, `API2TRADE_KEEPALIVE_POOL`, `API2TRADE_KEEPALIVE_MS`, `API2TRADE_POOL_CONNECTIONS`, `API2TRADE_REST_POLL_MS`, `API2TRADE_FAST_POLL_MS`, `API2TRADE_WS_SILENCE_MS` | web + workers (the pool: copy worker only - since the fifth pass it also carries that worker's database calls, `WSA_DB_KEEPALIVE_POOL`) | added 2026-10-12, defaults in §8 / §9.9 |
| | `API2TRADE_HISTORY_BACKFILL_DAYS`, `API2TRADE_HISTORY_BACKFILL_BUDGET_MS` | web + workers (the sync) | added 2026-10-12: how far back the trade history is walked (default 365, 0 = off) and the time budget of one run (default 12000), §6.8 |
| | `API2TRADE_API_KEY`, `BROKER_PROVIDER` | **AWS start script only** | exported there, but **no source file reads them** (dead/legacy) |
| Execution switches | `BROKER_EXECUTION_ENABLED` | web + workers | master switch behind `adapter.executionAvailable()`: while not `true`, no order is sent to a broker |
| | `WSA_COPY_ENGINE_ENABLED` | copy worker, copy services | must be `true` for the copy worker to start |
| | `WSA_RISK_ENGINE_ENABLED` | risk worker, `brokerSyncService` | `!== "false"` is enough to start the risk worker in `dev.ts`; `=== "true"` (plus API2Trade configured) makes `liveRiskProjectionEnabled()` true ⇒ web syncs of already-connected accounts are skipped (the worker owns snapshots) |
| Copy-worker tuning | `WSA_COPY_POLL_MS`, `WSA_COPY_WARMUP_MS`, `WSA_COPY_RUNTIME_CACHE_MS`, `WSA_COPY_EXECUTION_PRIORITY_MS`, `WSA_COPY_BROKER_CONCURRENCY`, `WSA_COPY_EVENT_CONCURRENCY`, `WSA_COPY_FOLLOWER_BATCH_SIZE`, `WSA_COPY_HEARTBEAT_MS`, `WSA_COPY_HOT_PATH_WARMUP`, `WSA_COPY_STREAM_DISCOVERY_MS`, `WSA_COPY_BACKGROUND_JOB_POLL_MS`, `WSA_COPY_DIRECT_EXECUTION`, `WSA_COPY_TIMING_LOGS`, `WSA_COPY_OPEN_CONCURRENCY`, `WSA_COPY_STREAM_RETRY_MS` | copy worker + `copyTradingService` | defaults in §9.6 (`WSA_COPY_FOLLOWER_BATCH_SIZE` and `WSA_COPY_BROKER_CONCURRENCY` are 48 since the fifth pass); AWS sets poll 100 ms, warm-up 5 000 ms, priority 4 000 ms |
| WSA Trade gateway (fifth pass) | `WSA_TRADE_GATEWAY_ENABLED` (`false` = off), `WSA_TRADE_GATEWAY_POLL_MS` (100), `WSA_TRADE_GATEWAY_LONG_POLL_MS` (**1000**, seventh pass: how long one claim waits INSIDE the database for a command - needs migration 062; `0` = off, max 2000; without 062 the worker polls as before), `WSA_TRADE_GATEWAY_IDLE_POLL_MS` (**400** since the sixth pass, was 750), `WSA_TRADE_GATEWAY_STATE_MS` (1000), `WSA_TRADE_GATEWAY_HOT_STATE_MS` (**350**, sixth pass: the refresh cadence of an account right after an order, for 4 s), `WSA_TRADE_GATEWAY_CONCURRENCY` (8), `WSA_TRADE_GATEWAY_READ_CONCURRENCY` (**6**, sixth pass: reads run on their own chains), `WSA_TRADE_GATEWAY_STATE_CONCURRENCY` (6) | copy worker (`scripts/wsa-copy-worker.ts`) | §6.9; the AWS start script exports `ENABLED`, `POLL_MS`, `LONG_POLL_MS`, `IDLE_POLL_MS`, `HOT_STATE_MS` and `STATE_MS` (the read concurrency uses its code default); needs migration 060 (without it the loop sleeps), `LONG_POLL_MS` needs 062 |
| | `WSA_TRADE_ROUTE` (`gateway` · `direct`; unset = automatic) | web (`webTradeService`) | pins how WSA Trade orders reach the broker (§6.9) |
| Self-copy engine (fifth pass) | `WSA_SELF_COPY_ENABLED` (`false` = off on this worker), `WSA_SELF_COPY_REPORT_MS` (45000), `WSA_SELF_COPY_WARMUP_MS` (60000), `WSA_SELF_COPY_RECOVERY_MS` (300000) | copy worker | §9.8 |
| Connection reuse (fifth pass) | `WSA_DB_KEEPALIVE_POOL` (`false` = the database client keeps the platform `fetch`), `UV_THREADPOOL_SIZE` (AWS script: 16) | workers (the pool is never turned on in the web app) | §9.10 |
| Risk / jobs tuning | `WSA_RISK_RECONCILE_MS`, `WSA_RISK_SNAPSHOT_MS`, `WSA_RISK_ACCOUNT_BATCH_SIZE`, `WSA_RISK_ACCOUNT_PAGE_SIZE`, `WSA_TRADE_RECONCILE_MS`, `WSA_JOB_POLL_MS`, `WSA_ACCOUNT_SYNC_INTERVAL_MS`, `WSA_EVALUATION_INTERVAL_MS`, `WSA_BACKGROUND_WORKER_ENABLED`, `WSA_BACKGROUND_ACCOUNT_SYNC_ENABLED` | risk + background workers | AWS: reconcile 5 s, snapshot 30 s, job poll 2 s, account-sync interval 300 s, evaluation interval 300 s, background account sync **off** |
| Dev-only | `WSA_DEV_WORKERS` | `scripts/dev.ts` | `true` ⇒ `npm run dev` also starts the workers (never locally against a shared DB) |
| AI | `AI_PROVIDER`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `AI_DEFAULT_MODEL`, `AI_CHART_MODEL`, `OPENAI_DEFAULT_MODEL`, `OPENAI_CHART_MODEL`, `AI_CHAT_DAILY_LIMIT`, `AI_CHART_DAILY_LIMIT` | web | a key saved in `ai_provider_settings` (encrypted) wins over the env key |
| Market data | `MARKET_DATA_PROVIDER` (`mock` or `dxfeed`), `FRED_API_KEY`, `DXFEED_ACCOUNT_ID`, `DXFEED_API_BASE_URL`, `DXFEED_API_KEY`, `DXFEED_ENVIRONMENT`, `DXFEED_TOKEN_EXCHANGE_URL`, `DXFEED_WIDGET_CDN_URL`, `DXFEED_FEED_PATH`, `DXFEED_FEED_AUTH_HEADER`, `DXFEED_IPF_PATH`, `DXFEED_IPF_AUTH_HEADER`, `DXFEED_NEWS_PATH`, `DXFEED_NEWS_AUTH_HEADER`, `DXFEED_SCANNER_PATH`, `DXFEED_SCANNER_AUTH_HEADER`, `DXFEED_SCHEDULE_PATH` | web | default provider is `mock` |
| Legacy | `METAAPI_TOKEN`, `METAAPI_RELIABILITY` | AWS script (optional), `scripts/verify-metaapi-runtime.ts`, root `sync-*.mjs` | MetaApi path is legacy; the factory is hard-wired to API2Trade |
| Runtime | `NODE_ENV`, `NEXT_TELEMETRY_DISABLED` | Node / Next | AWS sets `NODE_ENV=production`; the local `.bat` clears `NODE_ENV` and disables telemetry |

### 15.4 Configuration traps

1. **`NEXT_PUBLIC_*` are inlined at build time.** On Vercel a change needs a redeploy; locally it needs a dev-server restart.
2. **Precedence (Next):** variables already in the process environment > `.env.development.local` > `.env.local` > `.env.development` > `.env`. `scripts/dev.ts` calls `loadEnvConfig` first, so the `set` lines in the `.bat` win over any env file. An *empty* value in a higher-priority file shadows a real value in a lower one `[infer]` — which is why the local template keeps every optional name commented out.
3. `BILLING_PROVIDER` unset ⇒ **mock** (R4). `API2TRADE_*` missing ⇒ broker connect/sync fail and the risk worker does not start. `WORKER_SECRET` unset in production ⇒ `/api/worker/*` answers 503.
4. A different `ENCRYPTION_KEY` fails silently: stored broker credentials and AI keys simply stop decrypting, and anything newly stored by the odd-one-out instance cannot be decrypted by the others.
5. The AWS start script exports `BROKER_PROVIDER` and `API2TRADE_API_KEY`, but the provider is hard-coded in `src/lib/broker/provider.ts` (`getBrokerProviderId()` = `api2trade`) `[code]`; do not assume setting them changes anything.

---

## 16. Local development (`START_WSA_LOCAL.bat`)

### 16.1 Si ta nisësh (në shqip)

1. Ekstrakto ZIP-in me **Extract All** në një rrugë të shkurtër (p.sh. `C:\wsa`). Mos e hap `.bat` direkt nga brenda ZIP-it.
2. Instalo **Node.js LTS** (minimumi 20.9) nëse nuk e ke: https://nodejs.org
3. Kopjo `.env.local` nga projekti i vjetër në folderin e projektit. Nëse nuk e ke, `.bat` krijon vetë një model bosh (`WSA_LOCAL_ENV_TEMPLATE.txt` → `.env.local`), e hap në Notepad dhe ndalon që ta plotësosh.
4. Kliko dy herë **`START_WSA_LOCAL.bat`**. Hera e parë instalon varësitë (disa minuta). Shfletuesi hapet vetë te `http://localhost:3000/login` kur serveri është gati; hapja e parë e secilës faqe është e ngadaltë (webpack e ndërton sipas kërkesës).
5. Për ta mbyllur: **Ctrl+C**, pastaj **Y** — ose mbyll dritaren.

Windows mund të shfaqë **SmartScreen** ("More info → Run anyway") sepse `.bat` vjen nga një ZIP, dhe **Firewall** ("Allow access") sepse serveri i zhvillimit hap një port; zgjidh *Private networks* ose *Cancel* (dëgjon në të gjitha ndërfaqet `[infer]`).

### 16.2 What the script does, in order

1. `pushd` to its own folder; refuses to continue if `package.json` / `scripts\dev.ts` are missing (e.g. run from inside the ZIP).
2. Requires `node` ≥ 20.9 (Next 16) and `npm` on PATH; prints the version.
3. Clears `NODE_ENV`; if `node_modules\next`, `node_modules\tsx` or `node_modules\@next\env` is missing it installs: `npm ci --include=dev` → fallback `npm install --include=dev` → fallback `… --legacy-peer-deps`. (`package-lock.json` contains the win32-x64 native packages for Tailwind/lightningcss/Next SWC/esbuild, so the lock file is usable on Windows.)
4. **Env file check — existence by name only.** If none of `.env.local`, `.env.development.local`, `.env.development`, `.env` exists, it copies *its own* `WSA_LOCAL_ENV_TEMPLATE.txt` to `.env.local`, opens Notepad and stops. **It never opens, reads, prints or edits any `.env*` file.**
5. Port `3000` (override with `set WSA_LOCAL_PORT=3100` before launching). If the port is already listening (checked with `netstat`), it opens the browser at that address and exits instead of starting a second server (Next 16 is also expected to refuse two dev servers in the same project folder `[infer]`).
6. **Process-level overrides** (they beat every env file and live only for this run):

   | Variable | Value | Why |
   |---|---|---|
   | `WSA_DEV_WORKERS` | `false` | the copy / risk / jobs workers are **never** started locally — running them against the shared DB would double-execute trades next to AWS |
   | `BROKER_EXECUTION_ENABLED` | `false` (unless `WSA_LOCAL_ALLOW_BROKER_EXECUTION=true` is set before launching) | the local server itself sends no order to a broker; copy jobs end as SKIPPED instead of executing. **Exception since the fifth pass:** WSA Trade orders are written to the shared database and executed by the live AWS worker, so they ARE real (§6.9, R17) |
   | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL` | `http://localhost:<port>` | `accounts/[accountId]/page.tsx` fetches `/api/trading-accounts/<id>` from itself at this URL; passkey origin |
   | `WEBAUTHN_RP_ID` | `localhost` | WebAuthn requires RP ID = hostname |
   | `NEXT_TELEMETRY_DISABLED` | `1` | |

7. Starts a hidden PowerShell that waits (≤ 5 min) until `127.0.0.1:<port>` accepts connections, then opens the default browser at `/login` (TCP check, so system proxies cannot interfere).
8. Runs `npm run dev -- <port>` (= `tsx scripts/dev.ts <port>` → `next dev --webpack -p <port>`) in the same window and `pause`s when it ends.

It never runs `migrate`, `seed:*`, `reset-users`, `setup-stripe-products`, `npm start`, `test:e2e`, the `*:worker` scripts, or the root `sync-*.mjs` files.

### 16.3 What the local `.env.local` must contain

Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` (**same value as Vercel/AWS**). Strongly recommended: `BILLING_PROVIDER` set explicitly. Optional by feature: Stripe test keys; `API2TRADE_*` (broker connect/sync from the local site); `GEMINI_API_KEY` / `OPENAI_API_KEY` (AI); `MARKET_DATA_PROVIDER` + `DXFEED_*`; `FRED_API_KEY`. The best source for the values is the Vercel project's *Environment Variables* page and the Supabase *Project Settings → API* page.

### 16.4 What the local site is — and is not — connected to

```
Browser (http://localhost:3000)
   └─ Next dev server  (UI + all 241 /api routes, one process)
        ├─ Supabase    ← URL/keys from .env.local  (production data if those are the prod keys!)
        ├─ API2Trade   ← only if API2TRADE_* is set; read paths (connect / verify / sync)
        ├─ Stripe      ← only if BILLING_PROVIDER=stripe
        └─ Gemini / OpenAI / dxFeed ← only if keys are set
NOT started locally: copy worker, risk worker, background-jobs worker  (they run on AWS)
```

The AWS workers and the local site meet **only through the database**. With production keys, a local admin action (publish/pause a strategy, change a copy rule, toggle the emergency stop, approve access, edit followers, enqueue a job) is picked up by the *live* workers on AWS within seconds to minutes (§9.5 caches) — local ≠ sandbox. **Since the fifth pass this includes orders:** the WSA Trade panel writes `trade_commands` rows and the live AWS worker executes them (§6.9, R17) - an order, a close, a modification or a "close all" placed from a local site that uses the production Supabase keys is a **real** trade on the real broker account, whatever `BROKER_EXECUTION_ENABLED` says locally. A safe sandbox needs a separate Supabase project, but the migration chain cannot build one from scratch (R10); the realistic route is a schema-only dump of the live DB restored into a new project.

### 16.5 Things that behave differently locally

- **Auth e-mails** (sign-up confirmation, password reset, magic links) are built with `getAuthRedirectOrigin()`, which ignores `localhost` and falls back to the **production origin** ⇒ links in those e-mails open the production site. Log in with existing accounts, or create users from the admin screens.
- **Passkeys** are bound to the RP ID; passkeys registered on the production domain do not work on `localhost` (use password login), and ones registered locally will not work in production.
- **Stripe** (when `BILLING_PROVIDER=stripe`): Checkout works with test keys and `/billing/return` reconciles the session (`getBillingReturnStatus`), but webhooks do not reach `localhost` unless Stripe CLI forwarding is used. With **mock** billing, `/billing/return` calls `POST /api/billing/mock-confirm`, which marks the user's own pending MOCK order PAID and provisions access in whatever DB is connected.
- **Realtime** works (browser → hosted Supabase), but nothing produces live broker data locally because the workers are off; account pages show what the DB already contains.
- **No cron/worker** ⇒ queued `background_jobs` are not processed locally unless an admin presses *Admin → Jobs → run now* (`POST /api/admin/jobs/run-now` → `releaseStaleJobs` + inline `runWorkerOnce`). **Danger when the DB is production:** that call *claims real queued jobs*, and while `BROKER_EXECUTION_ENABLED=false` a claimed copy job ends as `SKIPPED` (`jobProcessor.ts` `GATE_CODES`: `COPY_EXECUTION_NOT_CONFIGURED`, `COPY_LIVE_DISABLED`, `COPY_EMERGENCY_STOP`, `COPY_CONSENT_REQUIRED`, `FOLLOWER_NOT_ELIGIBLE` ⇒ SKIPPED, **no retry**) — the live AWS worker would then never execute it. `releaseStaleJobs` can also flip stale live-broker jobs to FAILED.
- First compile of every route in dev is slow (webpack). While a tab is open the Topbar polls `/api/trading-accounts` every 30 s and `/api/notifications` every 60 s, and `useTraderAccessSummary` polls `/api/billing/me` every 5 s until the platform subscription is ACTIVE.

### 16.6 Never run these (against any DB you care about)

| Command / file | Why |
|---|---|
| `npm start`, `npm run test:e2e` | `scripts/dev.ts --production` starts **all three workers**; Playwright's `webServer` uses it (and `BILLING_PROVIDER=mock`) |
| `npm run migrate` (`scripts/run-migrations.ts`) | hard-coded production host; regex skips the timestamped migrations; chain is incomplete (003/004 missing) |
| `scripts/reset-users.ts` | **deletes all auth users** |
| `npm run seed:*`, `scripts/seed-*.ts` | create demo users such as `admin@aurix.local` with a known password |
| `scripts/setup-stripe-products.ts` | creates/changes Stripe products and prices |
| `npm run copy:worker / risk:worker / jobs:worker`, `WSA_DEV_WORKERS=true` | double execution next to AWS |
| *Admin → Jobs → run now* (and `POST /api/worker/jobs/run`) from a local instance connected to production | claims real queued jobs; gate-blocked copy jobs become SKIPPED without retry (§16.5) |
| root `sync-direct.mjs`, `sync-new-master.mjs` | legacy MetaApi ad-hoc scripts with a hard-coded Windows path |

### 16.7 Disclosure — one accidental `.env.example` match

During the analysis a single repository-wide search (the search tool was called with the project root as its path) **returned 7 lines from `.env.example`** — example values of `WSA_COPY_*` settings only, no keys and no secrets. It was unintentional and was reported to the user immediately. From then on every search was restricted to `src/ scripts/ supabase/ deploy/ docs/ tests/`. Apart from those 7 lines, **no `.env*` file was read, opened or printed**, and `.env.example` / `.env.passkeys.example` are delivered untouched. The env-variable inventory in §15.3 comes from the code, and `START_WSA_LOCAL.bat` and `WSA_LOCAL_ENV_TEMPLATE.txt` were written from that inventory, not from any env file.

---

## 17. Risk register

> **Nothing in this register was fixed.** No source file, migration or setting was changed by this analysis (only new documentation, the local launcher and the local env template were added). Severity = impact × likelihood judged from the code. `[verify]` = cannot be proven from the repo; check the live system first (§19).

| ID | Severity | Area | One-line summary |
|---|---|---|---|
| R1 | **Critical** `[verify]` | Auth / RLS | A logged-in user may be able to change **their own `profiles.role`** (e.g. to `SUPER_ADMIN`) through the public Supabase API |
| R2 | **High** | Secrets | A database password is written in clear text in `BACKEND_SETUP.md`; docs advertise demo admin accounts |
| R3 | **High** | Release process | AWS workers run the same repo `main`; no pinning, staging or CI; local admin actions on the prod DB steer live workers |
| R4 | **High** `[verify]` | Billing | Billing falls back to **mock** unless `BILLING_PROVIDER=stripe`; in mock mode users confirm their own orders |
| R5 | **High** | Copy engine | 5-minute in-memory caches; emergency stop also blocks CLOSE/MODIFY |
| R6 | Medium–High | Data trust | Direct client writes to `trading_accounts`; forgeable `audit_logs`; paywall mostly UI-only; unlimited accounts |
| R7 | Medium–High | Stripe | Webhook swallows errors (never retried); refunds do not revoke access |
| R8 | Medium | Partners | CPA rebate duplicates possible; rebates not withdrawable; a GET that writes |
| R9 | Medium | Execution semantics | Min-lot bump-up, detection-time events, failed CLOSE not retried (the dead self-copy simulate path was replaced by "Check route" in the fifth pass) |
| R10 | Medium | DB / docs drift | Migration chain cannot rebuild the DB; documentation is stale |
| R11 | Medium | Abuse | Per-instance in-memory rate limit; public licence-verify endpoint |
| R12 | Low–Medium | Frontend | Role guards for trader/partner pages are client-side; `/security` and `/privacy` are 404 |
| R13 | Medium | Tooling | Destructive scripts and legacy root scripts; `npm start`/e2e start live workers |
| R14 | Low | E-mail | Auth e-mails always link to the production origin |
| R15 | Low–Medium | Operations | No health endpoint, error tracking or alerting in the repo |
| R16 | Medium | Terminal (added 2026-10-12) | Orders placed in the embedded MetaTrader web terminal bypass WSA's risk, copy-trading and evaluation gates until the next sync |
| R17 | **High** (operational) | WSA Trade gateway (added 2026-10-12, fifth pass) | A site run locally with the production Supabase keys queues WSA Trade orders that the **live AWS worker executes for real** - the local `BROKER_EXECUTION_ENABLED=false` does not stop them |

### R1 — Critical `[verify]` — `profiles.role` is not protected from self-elevation
- **Evidence:** `supabase/migrations/002_rls.sql` lines 27–34. Policy `profiles_update_own_limited` has `USING (id = auth.uid() AND public.is_active_user())` and `WITH CHECK (id = auth.uid())`. The in-file comment says *"Prevent self-elevation: role/status can only be set by admin via service role"*, but nothing enforces it. A search of every migration found no trigger, no column-level `REVOKE`, and no later policy on `profiles.role` / `profiles.status`. `getCurrentUser()` (`src/lib/auth/session.ts`) reads `role` from `profiles` through the RLS client, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` is public by design.
- **Impact:** an ACTIVE user could send `PATCH /rest/v1/profiles?id=eq.<own id>` with `{"role":"SUPER_ADMIN"}` using their own session token ⇒ every `requireAdmin` / `requireSuperAdmin` route (users, partner payouts, AI provider keys, copy engine controls, jobs…).
- **Verify:** §19 queries A1–A3 (read-only). If a protective trigger or grant exists only in the live DB, R1 is already mitigated — but then it is also missing from the repo (R10).
- **Suggested fix (not applied; test on a copy first):** a `BEFORE UPDATE` trigger on `public.profiles` that rejects changes to `role` / `status` unless the caller is the service role or `public.is_admin()`, and/or `REVOKE UPDATE (role, status) ON public.profiles FROM authenticated, anon`. Review the same pattern for `trader_profiles.partner_id`, `profiles.stripe_customer_id` and `user_settings`.

### R2 — High — Secrets and demo credentials in the repository
- **Evidence:** `BACKEND_SETUP.md` (project root) line 29 contains a database password in clear text (15 characters — the value is deliberately **not** repeated anywhere in this analysis). `BACKEND_SETUP.md` and `docs/aurix-new-changes-6-18-26.md` also document demo accounts (`admin@aurix.local` with a known demo password) that `scripts/seed-*.ts` create. The two `AURIX_*.txt` context dumps and several `docs/*.md` are old LLM hand-off files that travel with the repo.
- **Impact:** anyone who ever had the repo/ZIP (or the Git history) can reach the database directly if that password is still valid; demo admin users, if they exist in production, are a known-credential back door.
- **Action:** rotate the Supabase database password (Project Settings → Database) and keep it only where `npm run migrate` is run; delete the line from the file *after* rotating (it also lives in Git history); look for `@aurix.local` users (§19 A5); consider a secret scanner on the repo. **Not applied:** the file is delivered unchanged so that nothing is modified without your say-so.

### R3 — High — One repository, two runtimes (and the local site shares the database with the live workers)
- **Evidence:** `deploy/aws/bootstrap-worker.sh` makes the workers a `git reset --hard origin/main` clone; `scripts/wsa-*-worker.ts` import the same `src/lib/**` code as the Next.js app. No tag/commit pinning, no staging, no CI, no test gate; units restart forever on a crash (§15.2). The SSM prefix is `/wsa/test/…`.
- **Impact:** a change that looks like "just a web fix" in `src/lib/**` changes live trade copying as soon as AWS pulls. A local run connected to the production database can steer the live workers through rows (publish/pause strategy, copy rules, emergency stop, queued jobs — §16.4/§16.5).
- **Action:** classify every change (§18 rule 1), deploy workers deliberately (branch/tag + manual pull), and `[verify]` whether AWS points to the same Supabase project as Vercel (§19 C2). A separate Supabase project for development would remove the local-steers-live problem.

### R4 — High `[verify]` — Billing falls back to mock
- **Evidence:** `src/lib/payments/runtime.ts`: the runtime is `stripe` only when `BILLING_PROVIDER` equals `stripe`; anything else, including unset, is `mock`. `POST /api/billing/mock-confirm` is guarded by `requireAuth` only; the protection is the mode check inside `confirmMockPayment` (`billingService.ts` ~l.1553–1583): when the mode is mock, any user can mark **their own** PENDING `provider='MOCK'` order PAID, which provisions subscription / copy / bot access through `markOrderPaid`.
- **Impact:** if the Vercel project ever loses `BILLING_PROVIDER=stripe` (new project, env mix-up, preview deployment sharing the production DB), paid access becomes free.
- **Action:** confirm the variable on Vercel (all environments that touch the production DB); look for `MOCK` + `PAID` rows (§19 A6). A fail-closed default for production would be a code change (not applied).

### R5 — High — Copy engine: stale caches and "stop" semantics
- **Evidence:** `src/lib/services/copyTradingService.ts` keeps module-level caches (global settings, strategy rows, followers, snapshots, account rules / status / risk) with TTL `WSA_COPY_RUNTIME_CACHE_MS` — default **300 000 ms**, max 600 000, not overridden by the AWS script — plus a "hot runtime" refreshed by `warmCopyStrategyAccounts` every `WSA_COPY_WARMUP_MS` (5 s on AWS). `[verify]` which caches the warm-up really refreshes (≈ lines 1088–1170). When the global emergency stop or *copy paused* is on, `executeCopyForEvent` throws for **every** event type, including CLOSE and MODIFY.
- **Impact:** an emergency stop, a pause, a rule change or a follower change can take effect on the worker only after cache expiry (up to ≈ 5 min) — and follower positions are *not* closed while the stop is on. Self-copy behaves differently (CLOSE/MODIFY ignore the global stop) — the two paths are inconsistent.
- **Action:** before touching this area read §9.3 and §9.5, measure real latency on a test environment, and decide explicitly whether CLOSE must bypass the stop.
- **Update 2026-10-12 (§9.9):** the follower's open-copies counter is now live (links + adjustments on every open / close) and the worker no longer waits on the slowest step; the daily-loss / drawdown caches (5 min) and the emergency-stop semantics for CLOSE / MODIFY are **unchanged**.

### R6 — Medium–High — Trust placed in the client / unrestricted direct writes
- **Evidence:** `002_rls.sql` lines 54–60: `trading_accounts_insert_own` (`WITH CHECK user_id = auth.uid() AND is_active_user()`) and `trading_accounts_update_own` (`USING owner OR admin`, no column restriction). `audit_logs_insert_service` is `FOR INSERT WITH CHECK (true)` with **no `TO` clause** (`002_rls.sql` l.178–180), i.e. it applies to every role including `anon` / `authenticated` wherever they hold the INSERT grant (Supabase grants it by default) `[verify grants]`. The $50/month platform paywall is enforced **server-side** only in the follow-strategy route, the self-copy route, `createCheckoutSession(COPY_ACCOUNT)` and the `accounts/[accountId]` page; elsewhere it is UI-only (`useTraderAccessSummary`). There is no limit on the number of accounts a trader can create.
- **Impact:** via the public API a trader may be able to write `status`, `account_usage` (COPY_MASTER / EVALUATION), `provider_account_id`, `equity_peak`, `risk_restricted_*`, `deactivated_at` on their own account rows, bypassing API validation; audit rows can be forged; paid features can be reached without the subscription.
- **Action:** tighten RLS (`WITH CHECK`, column grants) or move those writes behind API routes; add server guards wherever the business rule requires the subscription.

### R7 — Medium–High — Stripe webhook robustness
- **Evidence:** `src/app/api/webhooks/stripe/route.ts` verifies the signature, then inserts an idempotency row (`PROCESSING`) first — the insert error is not checked. Processing errors are caught, the row becomes `FAILED` and the handler **returns 200**; later deliveries of the same event hit the "already seen" branch. `charge.refunded` only marks the order `REFUNDED` (access stays); `invoice.payment_failed` only logs; `customer.subscription.deleted` cancels and revokes the follower.
- **Impact:** a transient failure leaves a customer who paid without access, and neither Stripe nor the code retries; refunds do not remove access.
- **Action:** watch `stripe_webhook_events` for `FAILED`/`PROCESSING` rows (§19 A7); consider returning 5xx on failure and a replay tool.

### R8 — Medium (reworked 2026-10-12) — Partner earnings
- **Was:** a NULL `broker_provider_id` made the CPA unique index non-unique (repeated CPA payouts), rebate/CPA totals only covered the newest 1000 rows, trades from before the client joined earned rebates, "wallet-ready" mixed WSA commission with broker earnings, refunds kept the commission, and `GET /api/partner/summary` recalculated everything with N+1 queries.
- **Now:** the engine was rebuilt (§12): CPA once per partner / client / broker is enforced in code, only trades closed after attribution earn, every read is paged, the wallet is WSA commission only, refunds reverse unpaid commissions, the page-side refresh is throttled and cannot fail a page. **Check for old duplicates anyway** (§19 A8) - rows written by the old engine stay in the database.
- **Still open (business decisions, not bugs):** the CPA "deposit" is the account's `initial_balance` (the platform has no deposit ledger); there is no demo-account flag, so a CONNECTED demo account earns like a live one; gold is only recognised when the symbol contains XAUUSD (a broker symbol such as `GOLD` is paid at the Forex rate); rebates are reporting-only by design; the legacy `partner_profiles.commission_type / cpa_amount` columns are not read by the engine; the existing Stripe handler treats a partial refund like a full one; a SQL aggregate (RPC) would be faster than paging for partners with hundreds of thousands of rebate rows.

### R9 — Medium — Execution semantics to know before "fixing" them
Lot scaling bumps a tiny lot **up** to the follower's minimum lot (can over-risk small accounts); live events carry the *detection* time as `event_time`; a failed CLOSE is not retried (copy: link `FAILED`; self-copy: link restored to OPEN); ~~`simulateSelfCopy` checked `status === "SIMULATION"`, which is not a valid status, so `/api/copy-trading/self-copy/[id]/simulate` always errored~~ - removed in the fifth pass, replaced by `POST /api/copy-trading/self-copy/[id]/check` (§9.8); `followStrategy` (service) does not check the subscription — the **route** does.

### R10 — Medium — The migration chain cannot rebuild the database; docs are stale
- **Evidence:** numbers 003 and 004 are missing; `006` references `last_synced_at` that is added in `010`; `022` recreates a `subscriptions` table that exists since `001`; `payment_orders.provider` defaults to the legacy `AIRWALLEX` in the repo SQL (`024` only widens the CHECK to `AIRWALLEX/STRIPE/MOCK`); `background_jobs.type` CHECK in `012` lists 9 types while the code dispatches more (extended later or by hand); `scripts/run-migrations.ts` matches only `^\d{3}_.+\.sql$`, so the two timestamped files (`20260914173557_platform_equity_timeline.sql`, `20260923070000_allow_risk_percent_scaling_mode.sql`) are never applied by it although the code needs `platform_equity_timeline` / `record_account_snapshot`; its host is hard-coded.
- **Impact:** a fresh Supabase project cannot be created from the repo; the live schema is the only truth. `README.md`, `docs/*.md` (Prisma, "no worker", `middleware.ts`, MetaApi) and `AURIX_*.txt` describe an older system.
- **Action:** take a schema-only dump of the live DB as the new baseline before any DB work, and keep a single source of truth (this analysis + the dump).

### R11 — Medium — Rate limiting and public endpoints
`src/proxy.ts` limits are in memory **per serverless instance** (reset by cold starts, not shared) and sit only in front of `/api/*`; password sign-in goes browser → Supabase directly and never passes through it (Supabase Auth has its own limits). `POST /api/licenses/verify` is public: a per-licence limit exists but unknown keys are not throttled. `GET /api/auth/referral/validate`, `GET /api/certificates/verify/[id]` and the two passkey-login endpoints are public by design.

### R12 — Low–Medium — Page guards are client-side
Only `src/app/(admin)/admin/layout.tsx` is a server guard (`requireAdmin`). The partner area is a client gate (`PartnerWorkspaceGate`), trader pages have no server guard except `accounts/[accountId]`, and `AppShell` redirects on the client. Data stays protected by the API guards, so this is a flash-of-content / UX issue rather than a leak. The login page links to `/security` and `/privacy`, which do not exist (404).

### R13 — Medium — Destructive and legacy scripts
See §16.6: `scripts/reset-users.ts` (deletes all auth users), `seed-*.ts` (demo users with a known password), `run-migrations.ts` (hard-coded production host), `setup-stripe-products.ts`, `npm start` and the Playwright `webServer` (start live workers), and the root `sync-direct.mjs` / `sync-new-master.mjs` (legacy MetaApi, hard-coded `C:\Users\…` path). None of them asks for confirmation or checks which database it is pointed at.

### R14 — Low — Auth e-mails always point to production
`getAuthRedirectOrigin()` (`src/lib/auth/redirectOrigin.ts`) ignores `localhost` and falls back to `NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_APP_URL` (if not localhost) and finally to the hard-coded production origin. Sign-up confirmation and password-reset links created from a local run open the production site.

### R15 — Low–Medium — Observability
There is no `instrumentation` file, no error-tracking SDK, no health endpoint and no alerting in the repo. Failure signals live in tables (`background_jobs`, `copy_execution_logs`, `broker_operation_logs`, `stripe_webhook_events`, `copy_strategies.engine_heartbeat_at`, `engine_error`) and in `journalctl` on the AWS host. A stalled worker is only noticed if somebody looks (§19 A9, C3).

### R16 - Medium - Orders from the embedded MetaTrader web terminal bypass WSA's gates (added 2026-10-12)
- **Evidence:** the MetaTrader pane (§6.9) is MetaQuotes' own web terminal talking straight to the broker. WSA's order path - `openTrade` / `closeTrade` behind `executionAvailable()`, the copy engine's gates, risk rules, evaluation checks - is not involved. The trades only appear in WSA after the next trade sync, and a copy-trading master's trade opened there is picked up by the engine's normal master-event detection `[infer]`, exactly as if it had been opened in MT4 on a desktop.
- **Impact:** a trader (or an evaluation / challenge participant) can exceed limits the platform would have refused, with the risk engine reacting only afterwards. WSA could never prevent this for an account whose master password the trader holds; the new pane merely puts it one click away inside the platform, which can suggest that WSA protections apply. The pane's help section says so ("Orders: trades sent from this terminal go straight to your broker…").
- **Action (product decision, not done):** keep as is, or hide / read-only the MetaTrader pane for `account_usage` `EVALUATION` and copy-master accounts, or open those with the investor password only.
- **Update 2026-10-12:** the native panel **WSA Trade** (§6.9) places orders through WSA's own gates (execution switch, platform subscription, risk block, audit log, repeat protection), so the risk is now limited to the embedded broker terminal; a product decision could make WSA Trade the only order route for evaluation accounts.

### R17 - High (operational) - WSA Trade orders from a local site are real (added 2026-10-12, fifth pass)
- **Evidence:** the trade gateway (§6.9, migration 060) moves the execution of WSA Trade to the AWS worker: any web server that can write to the shared Supabase - Vercel, but also `START_WSA_LOCAL.bat` with the production keys in `.env.local` - inserts a `trade_commands` row and the **live** copy worker, which holds `BROKER_EXECUTION_ENABLED=true`, carries it out. The `.bat`'s `BROKER_EXECUTION_ENABLED=false` only closes the local server's own `direct` route.
- **Impact:** testing "open / close / modify / close all" from a local machine against the production database trades the real account that is selected in the panel - including *Close several → All*.
- **Action:** test with a demo account; or switch the gateway off on AWS for the test (`WSA_TRADE_GATEWAY_ENABLED=false` and restart the copy unit - copy trading keeps running); or point the local site at a separate Supabase project. The panel shows the account and, with the trade rule `confirm` on (default), asks once more before an order leaves. A command that waited longer than 90 s is never sent (`EXPIRED`), so a stopped worker does not execute old clicks later.


---

## 18. Change-safety rules (read before every change request)

1. **Classify the change first:** *web-only* (UI / route handler), *shared* (anything under `src/lib/**` imported — directly or transitively — by `scripts/wsa-*-worker.ts`: copy / risk / jobs services, `lib/broker/**`, `lib/workers/**`, `lib/copy/**`, `lib/supabase/admin.ts`, `lib/utils/**`), *database*, *env/config*, or *infra*. **Shared = production-live for the AWS workers** as soon as they pull `main`.
2. **Keep the workers' import graph free of Next-only code.** The workers run under `tsx` (plain Node, outside Next). The services they load guard themselves with `if (typeof window !== "undefined") throw new Error("… is server-only")` at the top of the file — **not** with `import "server-only"`, whose default export throws under plain Node (only `wsaCopyEngineService.ts` and `lib/stripe/*` import it; they are web-only, and Vitest aliases the package to `src/lib/__mocks__/server-only.ts`). Do not import `next/headers`, `next/navigation` or React from modules the workers load, and use `createAdminClient` instead of `lib/supabase/server.ts` there `[infer]`.
3. **Idempotency keys are load-bearing (§5.4).** `copy_master_events.dedupe_key`, `copy_trade_links (source_event_id, follower_account_id)`, `trades (trading_account_id, external_trade_id)`, `background_jobs.unique_key`, `stripe_webhook_events.stripe_event_id`, the partner-rebate unique indexes. Never loosen, rename or drop one without a data migration and a worker-side review.
4. **One path to the broker.** Every order goes through the adapter (`openTrade` / `closeTrade` / `modifyTrade`) behind `executionAvailable()` (`BROKER_EXECUTION_ENABLED`), `withBrokerExecutionSlot`, the `copy_trade_links` reservation and `broker_operation_logs`. Do not add a second way to place orders, and never fake a success when a gate blocks (the code returns SKIPPED / FAILED on purpose).
5. **Database changes are forward-only and manual.** Next free number is `062` (`057` = optional margin columns, `058` = optional chart-sampling functions, `059` = optional cash flows + broker web-terminal directory, `060` = optional trade gateway, `061` = optional self-copy activity + strategy-follower calibration; all 2026-10-11/12 and every one of them must keep the app working when it is missing); remember the chain cannot bootstrap a DB (R10). Order: backwards-compatible DB change → web → workers. Never rename/drop a column the workers read in the same release. Take a backup / PITR point first; test on a copy.
6. **Service-role code must scope by owner itself.** `createAdminClient()` bypasses RLS: every route that uses it needs the right `require*` guard **and** an explicit owner/partner filter (`assertCanAccessAccount`, `trader_id`, `partner_id`…). New routes: start with the guard, validate with zod, answer with `jsonOk` / `jsonFail`.
7. **Keep the API envelope** `{ ok:true, data }` / `{ ok:false, error:{ code, message } }` — every client `fetch` assumes it. Renaming a field breaks pages silently (no shared types between client and routes).
8. **Realtime and caching are coupled by names.** `useRealtimeUpdates` invalidates specific react-query keys; renaming a key or moving data to another table/channel stops live updates without any error. Polling: Topbar 30 s / 60 s, billing 5 s while a subscription is pending, `staleTime` 60 s.
9. **Rate-limit buckets are per path prefix** in `src/proxy.ts` — a new route family needs a bucket decision; a chatty page can trip the limits (e.g. admin read 240/min).
10. **Env changes touch three places:** Vercel, AWS SSM + `wsa-worker-start.sh` (if workers read it), and `WSA_LOCAL_ENV_TEMPLATE.txt` / this document. Never put a secret in a `NEXT_PUBLIC_*` variable. `ENCRYPTION_KEY` must never differ between environments that share a database.
11. **Billing changes:** keep webhook idempotency and `markOrderPaid` / `ensurePaidOrderProvisioned` semantics; test with Stripe test keys and the Stripe CLI; never confirm mock orders on the production database.
12. **Money and lots:** use the existing helpers (`lib/copy/lotScaling.ts`, rebate calculators) and read their unit tests under `tests/unit` (52 files) before changing rounding or limits; run `npm test` locally (unit tests only) after touching them `[infer: no network in unit tests]`.
13. **Next.js 16 specifics:** `src/proxy.ts` replaces `middleware.ts`; dev uses webpack (`--webpack`); `cookies()` / `params` are async. `AGENTS.md` requires reading `node_modules/next/dist/docs/` before using a Next API.
14. **Server pages that call their own API** (`accounts/[accountId]/page.tsx`) depend on `NEXT_PUBLIC_SITE_URL` (the launcher sets it) — keep that in mind when adding server guards to other pages.
15. **Never run** the commands in §16.6 against a database you care about, and never start workers locally.
16. **Snapshots and charts (§6.8).** `account_snapshots` gets a row every ~5 s per connected account and PostgREST never returns more than 1000 rows per request: never read “all snapshots” in one query, never rely on `.limit(10_000)`; sample, page with `.range()` or aggregate in SQL (`performanceService`). Charts must never invent data - no generated curves, estimates are flagged `estimated`.
17. **Say what you did not test.** Neither this analysis nor the launcher was executed in the cloud workspace; any change request should list what must be tested locally by the owner.
18. **MetaTrader work belongs on the AWS side (fifth pass).** Anything that reads from or executes on a MetaTrader account - copy trading, self-copy, account reads, WSA Trade orders - is carried out by the AWS copy worker; the web tier asks through the database. For WSA Trade that means: the web routes check the gates (ownership, platform subscription, risk for NEW orders), queue a `trade_commands` row and wait for the answer (`lib/gateway/*`); they never open a bridge session themselves unless the route is `direct` (a single-box install). A command is never run twice by itself (`EXPIRED` after 90 s, `WORKER_LOST` instead of a restart), `(user_id, client_request_id)` is unique, the order comment stays `WSA Trade` (never `wsa:`), and the worker re-validates every payload with `parseTradeCommand`.
19. **Nothing in the copy engines may be silent (fifth pass).** Every skip, failure or copy of a self-copy position ends as an activity row with a code and a sentence (`selfCopyDecision`); a new gate gets a code, a sentence and a line in "Check route". Keep `copyNewTradesOnly` literally `true`, keep `liveSince` set by the service only, and never let an activity write be awaited on the copy path (`ActivityLog` is write-behind).
20. **Calibration `{}` means "as before".** `CopyCalibration` defaults reproduce the old behaviour; a calibration is read with `readCalibration` (never trusted raw), the settings route answers a loud 409 if a non-default calibration is saved while migration 061 is missing, and the strategy follower pipeline must keep working for rows that have no `calibration` column at all.
21. **The database keep-alive pool is for workers only (fifth pass).** `databaseFetch` / `warmDatabaseConnections` do nothing until a worker calls `enableApi2TradeConnectionPool()`; the web app on Vercel must never switch it on. `WSA_DB_KEEPALIVE_POOL=false` is the escape hatch.

---

## 19. Live verification checklist (read-only; nothing here changes data)

### A. Supabase — SQL editor
```sql
-- A1. Policies on the sensitive tables (look at with_check for profiles / trading_accounts / audit_logs)
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('profiles','trading_accounts','audit_logs')
order by tablename, policyname;

-- A2. Triggers on profiles (is there anything that blocks role/status changes?)
select tgname, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.profiles'::regclass and not tgisinternal;

-- A3. Column privileges of the API roles on profiles.role / profiles.status
select grantee, column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'profiles'
  and column_name in ('role','status') and grantee in ('anon','authenticated');

-- A4. Public tables WITHOUT row level security
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
order by 1;

-- A5. Privileged and demo users
select id, email, role, status, created_at
from public.profiles
where role in ('ADMIN','SUPER_ADMIN') or email ilike '%@aurix.local'
order by created_at;

-- A6. Orders by provider / status (any MOCK + PAID in production is a red flag)
select provider, status, count(*) from public.payment_orders group by 1,2 order by 1,2;

-- A7. Stripe webhook health
select event_type, status, count(*), max(created_at) as last_seen
from public.stripe_webhook_events group by 1,2 order by 1,2;
select stripe_event_id, event_type, status, error_message, created_at
from public.stripe_webhook_events where status in ('FAILED','PROCESSING')
order by created_at desc limit 50;

-- A8. Possible duplicate CPA rebates
select partner_id, trader_id, broker_provider_id, calculation_type, count(*) as n, sum(amount) as total
from public.partner_rebates
where calculation_type = 'CPA_TIER'
group by 1,2,3,4 having count(*) > 1;

-- A9. Copy engine and job queue health
select id, status, live_enabled, engine_status, engine_heartbeat_at, engine_error
from public.copy_strategies where status = 'ACTIVE' order by engine_heartbeat_at desc nulls last;
select type, status, count(*) from public.background_jobs
where created_at > now() - interval '7 days' group by 1,2 order by 1,2;

-- A10. WSA Trade: is migration 062 (long-poll) applied, and what does the AWS worker report about itself?
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('claim_trade_commands', 'claim_trade_commands_wait', 'await_trade_command')
order by 1;                      -- all three = 060 and 062 are applied
select worker, updated_at, info->>'longPoll' as long_poll, info->>'dbRttMs' as db_rtt_ms, info->>'loopLagMs' as loop_lag_ms
from public.gateway_heartbeat order by updated_at desc;   -- long_poll = true: the worker waits inside the database
```
Also in the Supabase dashboard: Auth → URL configuration (site URL / redirect URLs), Auth → e-mail confirmation setting, Database → Backups (daily backup / PITR enabled), Database → Replication (the Realtime publication lists the tables in §5.3).

### B. Vercel — Project → Settings → Environment Variables (presence only)
- `BILLING_PROVIDER` = `stripe` in **every** environment that can reach the production DB (Production **and** Preview).
- `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, the five `STRIPE_PRICE_*`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_APP_URL` (production origin), `WEBAUTHN_RP_ID` (production hostname) are set; `WORKER_SECRET` is set if anything external calls `/api/worker/*`.
- Preview deployments: do they point to the production Supabase? (they should not).
- The Stripe webhook endpoint (Stripe dashboard) targets `/api/webhooks/stripe` in the right mode (live vs test).

### C. AWS EC2 (SSH / SSM session)
```bash
# C1. Service state and recent logs
systemctl status wsa-copy-worker wsa-risk-worker wsa-background-worker --no-pager
journalctl -u wsa-copy-worker -n 100 --no-pager
# C2. Which code and which Supabase project do the workers use?
git -C /opt/wsa/app log -1 --format='%h %ad %s' --date=short
aws ssm get-parameter --name /wsa/test/NEXT_PUBLIC_SUPABASE_URL --query Parameter.Value --output text   # compare the project ref with Vercel's value
# C3. Compare ENCRYPTION_KEY between Vercel and SSM WITHOUT printing it: print only a short fingerprint on each side
aws ssm get-parameter --name /wsa/test/ENCRYPTION_KEY --with-decryption --query Parameter.Value --output text | { read -r v; printf 'fp:%s' "$v" | sha256sum | cut -c1-8; }
```
(Use the same one-liner for the Vercel value; the prefix `fp:` makes the fingerprint different from the actual AES key derivation. Do not paste the key anywhere.)

### D. Before the first change request
Take a Supabase backup point; decide how and when AWS pulls `main`; decide which database local runs will use (ideally a separate project built from a schema-only dump); agree which of R1–R15 to handle first. R1, R2 and R4 do not need any code change to verify.

---

## 20. Change log (code changes made after the analysis)

### 2026-10-11 — Account performance charts (Myfxbook-style) and history API
**Request:** the trader dashboard "Account performance curve" showed a flat line and zeros (screenshot: equity $189,477.75, closed P&L $0, growth 0.00 %, win rate 0.0 %). It had to show the real per-account history like Myfxbook, in every place with such a chart, with every line showing what it really is.

**New**
- `src/lib/charts/performanceSeries.ts`, `performanceChartSpec.ts` - pure data model, scales, tab specs, tooltips.
- `src/lib/services/performanceService.ts`, `src/app/api/analytics/performance/route.ts` (+ `performanceQuerySchema` in `lib/validation/schemas.ts`).
- `src/lib/services/accountSnapshotService.ts` - single snapshot writer with optional margin (v2 → v1 fallback).
- `src/hooks/usePerformanceSeries.ts`, `useElementWidth.ts`.
- `src/components/charts/AccountPerformanceChart.tsx`, `TimeSeriesAreaChart.tsx`.
- `supabase/migrations/057_account_snapshot_margin.sql` (optional, apply by hand).
- `supabase/migrations/058_account_performance_samples.sql` (optional, apply by hand; added by the 2026-10-12 follow-up below).
- Tests: `performanceSeries`, `performanceChartSpec`, `performanceService`, `svgCurve`, `accountSnapshotService` (+134 tests).

**Changed**
- Pages: `(trader)/dashboard`, `(trader)/analytics`, `(trader)/accounts/[accountId]`, `(admin)/admin` - old chart code and fabricated curves removed.
- `components/dashboard/EquityCurve.tsx` (rewritten on `TimeSeriesAreaChart`), `lib/charts/svgCurve.ts` (honest linear / step / monotone paths).
- `hooks/useRealtimeUpdates.ts` (debounced `account-performance` invalidation), `lib/services/analyticsService.ts` (paged trades).
- **Shared with the AWS workers:** `lib/domain/types.ts`, `lib/broker/Api2TradeBrokerAdapter.ts` (margin fields), `lib/services/brokerSyncService.ts` and `scripts/wsa-risk-worker.ts` (use the snapshot writer).

**Checks run (static only):** `tsc --noEmit` clean · `eslint` 0 errors on all touched files · `vitest` 545 of 546 pass (the one failure, `brokerCredentialApi.test.ts` "preserves password whitespace exactly" - `brokerConnectionSchema` trims the password - existed before this change and was left alone).
**Not tested:** the pages in a browser, the API against a real Supabase, the AWS workers, migration 057 on a real database.

### 2026-10-12 - Chart calibration (follow-up) and the Trading Terminal (TradingView + MetaTrader web terminal)
**Request (Albanian, 4 points):** (1) the performance chart must follow each account's real dates and draw exact curves, including accounts that have a trade history; (2) the Terminal's TradingView should become "full" - log in, watchlist; (3) add the MetaTrader web terminal in the same section so both can be open at once; (4) the MetaTrader terminal must use the accounts stored on the platform (read through API2Trade), offer a choice and log the chosen account in automatically, plus "add manually". The owner asked for a feasibility verdict on each point first.

| # | Ask | Verdict |
|---|---|---|
| 1 | Chart calibrated to each account's dates, exact curves, trade history | **Done** (§6.8, "Calibration"). No screenshot came with the request, so the symptom was inferred: date axis wider than the data, long straight lines over recording gaps, no trade history. |
| 2 | TradingView login / account watchlist inside the page | **Not possible as asked** (`frame-ancestors 'none'`, free widgets have no login, proxying is against the terms). Built instead: personal watchlist stored in WSA, panel toggles, "Open on TradingView", an explanation in the UI. Real "full" mode = licensed Advanced Charts / Trading Terminal library. |
| 3 | MetaTrader web terminal as a second tab, both live | **Done**: tabs + split view, panes kept alive. |
| 4 | Pick a platform account, auto-login, manual add | **Partly possible**: picker from the platform's accounts, login / server / platform pre-filled, manual accounts (≤ 20) are done; the password is typed once in the terminal because no password parameter exists. |

**New**
- `src/lib/terminal/{metatrader,workspace,tradingview}.ts`, `src/lib/services/metaTraderTerminalService.ts`.
- `src/app/api/terminal/metatrader/{accounts,launch}/route.ts`, `src/app/api/terminal/workspace/route.ts`.
- `src/hooks/useMetaTraderAccounts.ts`, `src/hooks/useTerminalWorkspace.ts`.
- `src/components/trading/{TerminalWorkspace,MetaTraderTerminal,TradingViewWatchlistEditor}.tsx`.
- `supabase/migrations/058_account_performance_samples.sql` (optional; chart sampling in one round trip).
- Tests (+220): `metaTraderTerminal`, `terminalWorkspace`, `tradingViewConfig`, `metaTraderTerminalService`, `terminalRoutes`, `metaTraderTerminalUi`, `terminalWorkspaceUi`; helpers `tests/unit/helpers/{fakeSupabase,reactDom}.ts`.

**Changed**
- `components/trading/TradingViewAdvancedChart.tsx` (watchlist + panels), `components/charts/TradingChart.tsx` (controlled by the workspace, watchlist editor, pop-out, explanation), `app/(trader)/terminal/page.tsx`.
- `app/api/terminal/preferences/route.ts` (merges `layout`, never writes the `workspace` key), `lib/services/auditService.ts` (`METATRADER_TERMINAL_LAUNCHED`), `types/lucide-react.d.ts` (more icons).
- Chart follow-up: `lib/charts/performanceSeries.ts`, `performanceChartSpec.ts`, `lib/services/performanceService.ts`, `components/charts/AccountPerformanceChart.tsx` (window calibration, gap bridging, trade markers, optional `058` RPCs).
- Web-only: nothing in this change is imported by the AWS workers.

**Checks run (static only):** `tsc --noEmit` clean · `eslint` 0 errors / 0 warnings on every touched file and on `tests/unit` · `vitest` 819 of 820 pass (the one failure is the same `brokerCredentialApi.test.ts` "preserves password whitespace exactly" that failed before any of this work).
**Not tested:** the pages in a real browser; the MetaQuotes and TradingView pages (never loaded from this project - their behaviour is taken from their public documentation and response headers as inspected earlier); the API routes against a real Supabase; migration 058 on a real database; Safari / third-party-storage behaviour of the embedded terminal.

### 2026-10-12 (later) - Chart dates from broker time, MetaTrader platform / server, TradingView defaults, Partners audit
**Request (Albanian, 3 points):** (1) the chart's curve does not match the dates / time columns of the MT5 accounts - fix; (2) the MetaTrader terminal must recognise MT4 vs MT5 and open with the account's own broker servers instead of MetaQuotes' default; TradingView must not open with the default Volume indicator but with MA 50 and MA 200, plus any TradingView options that were forgotten; (3) review the Partners section (commissions from WSA sales, CRM client names, IB rebate and CPA, agreements entered by admin and broker) for correct rules and calculations. The owner also asked for **no test agents and only one focused check**.

**What was wrong / what changed**
1. *Chart dates.* Broker server-time text was read as UTC - see §6.8 "Broker clock vs UTC". New `src/lib/broker/orderNormalization.ts`; changed `Api2TradeBrokerAdapter.ts`, `api2TradeLiveSource.ts` (shared with the workers), `performanceService.ts`.
2. *MetaTrader.* The terminal reconnected to its own MetaQuotes-Demo account and ignored `login` / `trade_server`. Address now carries `servers`, `trade_server`, `login`, `startup_version` and `startup_mode=no_autologin`; platform from the account, else from the server name; the MetaQuotes-hosted new terminal refuses broker servers with an explanation. Files: `lib/terminal/metatrader.ts`, `metaTraderTerminalService.ts`, `components/trading/MetaTraderTerminal.tsx`, `workspace.ts`, `useTerminalWorkspace.ts`.
3. *TradingView.* MA 50 + MA 200 instead of Volume by default, `TradingViewOptionsPanel.tsx` with the options the free widget supports, non-functional Calendar toggle removed. Files: `lib/terminal/tradingview.ts`, `TradingViewAdvancedChart.tsx`, `TradingChart.tsx`.
4. *Partners* (§12, R8). New `lib/partner/rebateRules.ts` (pure rules), `lib/supabase/pagedSelect.ts` (paged / chunked reads); rewritten `partnerRebateCalculationService.ts` (shared with the workers), `partnerService.ts`; `partnerWithdrawalService.ts` (paged ledger), `billingService.ts` (rounded commission, upper-case currency, refund reversal), `validation/schemas.ts` (CPA tier order), `api/partner/rebates/route.ts` (`view` + `totals`), `PartnerFinanceWorkspace.tsx`, `admin/partners/withdrawals/page.tsx`, `partner/crm/page.tsx` labels, `lib/partner/types.ts` (`brokerEarningsApproved/Pending`, `REVERSED`), `lib/partner/withdrawals.ts` (`rebateRowCount`, `rebateRowsListed`).
5. Tests: new `orderNormalization`, `partnerRebateRules` (rules, totals, paging helpers, schema); extended `performanceService`, `metaTraderTerminal`, `metaTraderTerminalUi`, `terminalWorkspace`, `terminalWorkspaceUi`, `tradingViewConfig`.

**Live-impact notes.** The chart-time fix and the whole rebate engine are *shared code*: they go live on AWS when the workers pull `main`. Stored trade times correct themselves at the next sync. Behaviour changes owners will notice: only trades closed after a client joined a partner earn rebates; CPA is paid once per client even without a broker provider; "Wallet-ready" is WSA commission only; refunded orders reverse unpaid commissions; Rebate / CPA / Hybrid pages show different row sets.

**Checks run (static, once):** `tsc --noEmit` clean · `eslint` 0 errors on every touched file · `vitest` on the touched test files only (14 files, 363 tests, all pass after one stale terminal-UI expectation was updated). The full regression suite was not re-run (owner's instruction).
**Not tested:** any page in a real browser; MetaQuotes / TradingView behaviour (taken from their public documentation and widget script); the API routes and the rebate engine against a real Supabase; API2Trade payload field names (assumed from the existing typings); the Stripe refund path.

### 2026-10-12 (third pass) - Data chain API2Trade → chart, and the automatic MetaTrader web terminal
**Request (Albanian, 2 points):** (1) the platform seems to have a problem taking in the account data, so the charts come out badly (not scaled, not as they should) - review the whole chain from API2Trade through processing to the charts and check the logic and the maths of every field; (2) the MetaTrader web terminal asks the user for the company's web-terminal link - find a way for the system to produce these automatically (look at what API2Trade and the web offer) so users never look for links. The owner asked to be quick: no long audits, no test agents, no tests run in the cloud.

**What was wrong / what changed**
1. *Data chain* - seven faults, fixed in the pure chart code, the performance service and the sync (details: §6.8 "Data chain API2Trade → database → chart"): unpaged trade lookup (history stopped growing past 1000 trades), every trade rewritten each cycle, duplicate snapshot writes, incomplete `AccountSummary` stored as zeros / chart glitch filter, gross profit without commission / swap / fee, deposits and withdrawals not recorded, growth measured from the first balance instead of a time-weighted return.
2. *MetaTrader web terminal* - MT5 web terminals exist only on each broker's own domain (MetaQuotes closed the shared one on 1 Aug 2023) and API2Trade has no terminal link, so the pane could only ask the user. New source **Automatic** (default): the platform derives the broker from the account's trade server, finds the broker's web terminal through the API2Trade broker directory and the broker's website, checks it, caches it (memory + table `broker_web_terminals`) and opens it with login / server / platform pre-filled. Fallbacks: MetaQuotes' shared terminal for MT4 and for MetaQuotes' own servers; for MT5 a one-time paste per broker ("Search again", "Enter an address myself"); administrators can set or block an address with one SQL statement (§6.9).
3. *Pre-existing failing test fixed:* `brokerConnectionSchema` trimmed the broker password (`brokerCredentialApi.test.ts` "preserves password whitespace exactly" had failed since before 2026-10-11). The password is now kept exactly as typed and a blank password is still rejected ("Password is required").

**New**
- `supabase/migrations/059_cash_flows_and_broker_terminals.sql` (optional, apply by hand, idempotent): `account_cash_flows`, `broker_web_terminals`.
- `src/lib/broker/accountFigures.ts`, `src/lib/services/accountCashFlowService.ts`.
- `src/lib/terminal/brokerTerminal.ts`, `src/lib/services/brokerWebTerminalService.ts`, `src/app/api/terminal/metatrader/resolve/route.ts`.
- Tests: three new files - `chartDataIntegrity` (42 cases), `brokerTerminal` (31), `brokerWebTerminalService` (37) - and extended `metaTraderTerminal`, `metaTraderTerminalUi`, `terminalRoutes`, `terminalWorkspace`, `terminalWorkspaceUi`.

**Changed**
- **Shared with the AWS workers (live when AWS pulls `main`):** `lib/broker/orderNormalization.ts`, `api2TradeClient.ts`, `BrokerAdapter.ts`, `Api2TradeBrokerAdapter.ts`, `lib/services/brokerSyncService.ts`, `accountSnapshotService.ts`, `scripts/wsa-risk-worker.ts`.
- Web-only: `lib/charts/performanceSeries.ts`, `performanceChartSpec.ts`, `lib/services/performanceService.ts`, `components/charts/AccountPerformanceChart.tsx`, `lib/terminal/{metatrader,workspace}.ts` (`WORKSPACE_VERSION` 2, `brokerTerminals`, source `auto`), `hooks/{useMetaTraderAccounts,useTerminalWorkspace}.ts`, `components/trading/MetaTraderTerminal.tsx`, `lib/validation/schemas.ts`.

**Live-impact notes.** Rollout order: migration `059` (optional) → web → workers. Without `059` nothing breaks: no cash flows are stored (growth reduces to the old formula) and the terminal address is only cached in process memory. Stored closed trades keep their old gross profit until they change at the broker; new syncs store net profit. The glitch filter and the time-weighted growth change what existing charts show (growth now starts at 0 % at the first reading).

**Checks run (static, once):** `tsc --noEmit` clean · `eslint` 0 errors on every touched file (one older warning: unused `runMetaApiSync`) · `vitest` full suite 64 files / 1143 tests green after the schema fix (the last full run was before that one-line fix; `brokerCredentialApi.test.ts` was re-run alone and passes, 21 of 21).
**Not tested:** any page in a real browser; the automatic discovery against real broker websites and the real API2Trade `Search` (the build environment has no general internet access - accuracy is heuristic); API2Trade field names for commission / swap / fee and the shape of balance-operation rows (assumed); migration 059 on a real database; the API routes against a real Supabase; the AWS workers.

### 2026-10-12 (fourth pass) - Chart periods, admin terminal, WSA Trade, copy-trading speed
**Request (Albanian, 4 points):** (1) fix the chart axes - they come out too small in data and time and do not follow the period the user / admin chose; check how the dates are processed and fetched, there may be visual mismatches with the chart lines; (2) the terminal sector must be the same in admin (it only appeared for users) - same sector, same visuals and options; (3) check whether the MT5 web terminal can be opened without finding the brokers' web-terminal links (one has to be logged in to the broker to reach them), maybe through API2Trade; (4) review how copy trading is built and whether it is fully functional - it works but has a delay of 2 s or more on executions, modifications or receiving commands, API2Trade offers 41 ms - find blockages and make it as fast as possible. The owner asked to be quick: no audits, no test agents, no tests run in the cloud.

**What was wrong / what changed**
1. *Charts* - fixed ranges were cut at the account's first data point and the trade history was only about 30 days deep. Fixed ranges now always span the chosen period (shaded, labelled stretch before the first data), older history is fetched by a backwards walk (`historyBackfill`), the time axis has calendar ticks with two-line labels (§6.8 "Chart periods, time axis and deep history").
2. *Admin terminal* - `/admin/terminal` is now the same workspace as `/terminal`; the provider settings moved to `/admin/terminal/provider` (§6.9).
3. *MT5 web terminal without a link* - **API2Trade offers no web-terminal link or feature**. The answer is the native **WSA Trade** panel over the trading session WSA already holds: every connected MT4 / MT5 account, no link, no second login, WSA's own gates (§6.9). The embedded broker terminal (automatic address search of the third pass) stays as the second route.
4. *Copy trading* - seven causes of the 2 s or more (ignored stream messages, one blocking loop, no time limits, cold TCP / TLS per burst, blocking reconnects, batch-wait follower execution, a misleading timing log) and six correctness faults (spurious CLOSE, CLOSE racing the OPEN, wrong open-copies counter, link-write and event-store failures, stream lifecycle) were fixed (§9.9). The honest answer to "fully functional": yes for open / modify / close with the gates, no for the limits listed in §9.9.

**New**
- Copy engine: `src/lib/copy/{pool,keyedChains,streamPump,masterEvents}.ts`, `src/lib/broker/{api2TradeTransport,orderUpdateMessage}.ts`; dependency `undici` in `package.json` / `package-lock.json`.
- Charts: `src/lib/broker/historyBackfill.ts`.
- WSA Trade: `src/lib/trade/{webTrade,webTradeFormat,webTradeGuard,webTradeSchemas}.ts`, `src/lib/broker/{openPositions,quote}.ts`, `src/lib/services/webTradeService.ts`, routes `src/app/api/terminal/trade/{accounts,state,open,modify,close}/route.ts`, `src/components/trading/{WsaTradePanel,TerminalWorkspaceLazy}.tsx`, `src/hooks/useWebTrade.ts`.
- Admin: `src/components/admin/MarketDataProviderSettings.tsx`, page `src/app/(admin)/admin/terminal/provider/page.tsx`.
- Tests: `copyPool`, `keyedChains`, `streamPump`, `masterEvents`, `orderUpdateMessage`, `api2TradeLiveSource`, `api2TradeClientTimeouts`, `api2TradeTransport`, `historyBackfill`, `webTrade`, `webTradeService`, `wsaTradePanel`; extended `performance*`, `terminalWorkspace*`, `terminalRoutes`, `chartDataIntegrity`.

**Changed**
- **Shared with the AWS workers (live when AWS pulls `main`):** `scripts/wsa-copy-worker.ts` (rewritten), `lib/broker/{api2TradeLiveSource,api2TradeClient,Api2TradeBrokerAdapter,BrokerAdapter}.ts`, `lib/services/{copyTradingService,accountCashFlowService}.ts`, `lib/supabase/admin.ts`.
- Web-only: `lib/charts/{performanceSeries,performanceChartSpec}.ts`, `lib/services/performanceService.ts`, `components/charts/{AccountPerformanceChart,TimeSeriesAreaChart}.tsx`, `components/trading/{TerminalWorkspace,MetaTraderTerminal}.tsx`, `lib/terminal/{workspace,metatrader}.ts`, `(admin)/admin/terminal/page.tsx`.

**Live-impact notes.** Rollout order: web → workers. **On AWS: pull `main`, run `npm ci` (new dependency `undici`) and restart the three units**; the copy worker is a rewrite, so watch `journalctl -u wsa-copy-worker` for the first trades and run it once with `WSA_COPY_TIMING_LOGS=true`. No new migration (058 and 059 stay optional; 058 only makes long "all accounts" periods cheaper). Backfilled history can create partner rebate rows retroactively for trades that closed after `partner_assigned_at` (§6.8). `createAdminClient()` is now memoised.

**Checks run (static, once):** `tsc --noEmit` clean · `eslint` 0 errors on every touched file (older warning kept: unused `loadActiveFollowersCached`; one pre-existing `prefer-const` error in `copyTradingService.ts` fixed) · `vitest` on the touched and new test files: 38 files / 1233 tests, all green (jsdom component tests included). The full regression suite was not re-run (owner's instruction).
**Not tested:** any page in a real browser; anything against a real API2Trade (WebSocket payload shapes, the quote endpoint, pending-order fields, rejection texts are assumed) or a real broker account; the copy worker's speed on AWS (expected, not measured); the history backfill against real accounts; the API routes against a real Supabase.

### 2026-10-12 (fifth pass) - Trade gateway, trade section, self-copy engine, calibration, copy-trading speed
**Request (Albanian, 7 points):** (1) the structure, if not understood: the web is managed by Vercel; the copy-trading system, adding MetaTrader accounts, reading their data, self-copy and everything else that touches MetaTrader for reading data and executing is one system hosted on AWS; the clients' database is Supabase. (2) A malfunction of the data-reading side from the API2Trade functions is suspected (account data and copy trading come from it) - review how it is connected in the backend and how it shows in the respective data. (3) Copy trading works but the time is still very long (tests are done on the local machine); **self-copy does not react at all**; review it so that both have every function needed to calibrate trades and work as well as possible. (4) The WSA Terminal must be a **trade section** - analysis in split view with TradingView next to it, trade rules and executions on the right; done to a degree, but opening an order, closing orders and modifying them does not work; look at the commands and the possibilities; symbols to be generated from API2Trade in the broker's naming. (5) Make copy trading faster - milliseconds on executions, no delays - it is the principle of the platform. (6) Let him bring his own scripts into TradingView. (7) Review what is possible and start; professionally; no audit, no test agents.

**What was wrong / what changed**
1. *Architecture, stated once* (§1, §2, §6.9): all MetaTrader reading and execution = the AWS system; Vercel = web; Supabase = customer database. The web tier must therefore ask, not do.
2. *WSA Trade did not trade* - its orders left from the web tier, which has neither the bridge credentials nor the execution switch (Vercel, a local test machine). **New trade gateway** (migration 060, `src/lib/gateway/*`): the web routes check the gates, write a `trade_commands` row and wait for the answer; the AWS copy worker executes it through the sessions it already holds and publishes the live picture of watched accounts (figures, positions, **pending orders**, prices) and the broker's symbol list. New commands: pending LIMIT / STOP orders, modify of pending orders, cancel, close several (§6.9).
3. *Terminal = trade section* - default layout is now the split view, TradingView left and WSA Trade right (workspace document version 3); the panel has a broker symbol picker with search (chart and panel follow each other), a market / limit / stop ticket, SL / TP as prices or points, the person's trade rules (confirm, require stop loss, max lots, default distances), position and pending-order lists with edit / partial close / close / delete and a "close several" bar. Refusals of a trade server are shown as readable sentences (`tradeRetcodes.ts`).
4. *Data reading from API2Trade* - the existing sync chain (third pass) was re-traced and left as it is; what was added to the reading side is `OpenedOrders` → pending orders (`openPositions.ts`), the symbol list (`symbolList.ts`; endpoints `SymbolList` · `Symbols` · `GetSymbols` tried in turn, the one that answers is remembered) and the delete call (`OrderDelete` · `OrderDeleteSafe` · `OrderCloseSafe`, only "no such endpoint" moves on). The endpoint names and payload shapes are **assumed** - the bridge's documentation was not available.
5. *Self-copy* - rebuilt (§9.8): a decision with a code and a sentence for every gate, an activity log per route, an engine status written by the worker, "Check route", one chain per source ticket (no more strictly serial queue), warmed follower sessions and symbol lists, a safety net for missed closes, trailing-stop MODIFY fix; `simulate` route replaced.
6. *Calibration* - one `CopyCalibration` for self-copy **and** strategy followers: copy / fixed / no stop loss and take profit, maximum slippage, maximum signal age, automatic symbol matching to the follower broker's spelling (§9.8, §9.10). A reversed trade now swaps SL and TP (the broker refused them as they were).
7. *Speed* (§9.10) - Supabase connections are kept open and pre-warmed on the workers (`databaseFetch`, `warmDatabaseConnections`), parallel orders 24 → 48, gateway poll 150 → 100 ms, `UV_THREADPOOL_SIZE=16`. The database-first idempotency was kept on purpose, so two Supabase round trips remain on the strategy OPEN path - **the gain is expected, not measured**.
8. *TradingView own scripts* - not possible in the free embed (§6.9): the UI says so plainly and **Open on TradingView** carries the symbol and timeframe to tradingview.com; real in-page custom indicators need the licensed Advanced Charts library or an own chart engine.

**New**
- `supabase/migrations/060_trade_gateway.sql` (optional, manual, idempotent): `trade_commands`, `terminal_account_state`, `terminal_account_symbols`, `gateway_heartbeat`, RPC `claim_trade_commands`. `061_self_copy_activity.sql` (optional, manual, idempotent): `self_copy_events`, `self_copy_relationships.engine_*`, `copy_strategy_followers.calibration`.
- Gateway: `src/lib/gateway/{tradeCommands,tradeExecutor,gatewayWorker,gatewayQueue,gatewayStore,gatewayDb}.ts`; routes `src/app/api/terminal/trade/{cancel,close-bulk,symbols}/route.ts`.
- WSA Trade: `src/lib/trade/{symbolMatch,ticketMath}.ts`, `src/lib/broker/{symbolList,tradeRetcodes}.ts`, `src/components/trading/wsaTrade/{Book,SymbolPicker,TradeSettings,ui}.tsx`.
- Copy: `src/lib/copy/{calibration,strategyCalibration,followerSymbols,activityLog,selfCopyDecision,selfCopyEngine,selfCopyEngineStatus,selfCopyEvents,selfCopySources,selfCopyStore,selfCopyView}.ts`; routes `src/app/api/copy-trading/self-copy/[id]/{activity,check}/route.ts`; `src/components/copy/{CopyCalibrationFields,SelfCopyPlatformBanner,SelfCopyRouteDetails,selfCopyClient}.ts(x)`.
- Tests (new): `tradeCommands`, `tradeExecutor`, `gatewayQueue`, `gatewayStore`, `gatewayWorker`, `webTradeGateway`, `symbolMatch`, `symbolList`, `tradeRetcodes`, `ticketMath`, `copyCalibration`, `strategyCalibration`, `activityLog`, `selfCopyDecision`, `selfCopyEngine`, `selfCopyEngineStatus`, `selfCopyEvents`, `selfCopySources`, `selfCopyView`, helpers `memoryDb`, `webTradeFixtures`; extended `api2TradeTransport`, `api2TradeLiveSource`, `api2TradeClientTimeouts`, `webTrade`, `webTradeService`, `wsaTradePanel`, `terminalWorkspace`, `terminalWorkspaceUi`, `terminalRoutes`.

**Changed**
- **Shared with the AWS workers (live when AWS pulls `main`):** `scripts/wsa-copy-worker.ts`, `lib/gateway/*`, `lib/copy/*`, `lib/broker/{api2TradeTransport,api2TradeClient,api2TradeLiveSource,Api2TradeBrokerAdapter,BrokerAdapter,openPositions,symbolList,tradeRetcodes}.ts`, `lib/trade/{webTrade,symbolMatch}.ts` (pulled in by the executor), `lib/services/{copyTradingService,selfCopyService,auditService}.ts`, `lib/supabase/admin.ts` (now hands `databaseFetch` to the client), `deploy/aws/wsa-worker-start.sh` (gateway poll 100 ms, `UV_THREADPOOL_SIZE=16`).
- Web-only: `lib/services/webTradeService.ts` (rebuilt around the gateway), `lib/trade/{webTradeFormat,webTradeSchemas,ticketMath}.ts`, `lib/terminal/workspace.ts` (version 3), `lib/validation/schemas.ts`, `components/trading/{WsaTradePanel,TerminalWorkspace,TradingViewOptionsPanel}.tsx`, `components/charts/TradingChart.tsx`, `components/copy/{SelfCopyPanel,FollowerSettingsDialog}.tsx`, `hooks/useWebTrade.ts`, `app/globals.css` (`--color-lime`), `types/lucide-react.d.ts`, the eight `api/terminal/trade/*` routes and the self-copy routes.

**Live-impact notes.** Rollout order: migrations `060` and `061` (both optional, run by hand in the Supabase SQL editor) → web (Vercel) → workers. **On AWS: pull `main`, `npm ci`, restart the three units** (`wsa-copy-worker` carries the gateway and the self-copy engine). Without 060 the order panel falls back to `direct` / read-only and says so; without 061 the self-copy activity only reaches the worker log, the engine status is not shown, and saving a non-default calibration for a strategy follower answers 409. **A WSA Trade order from a local site with production keys is a real order (R17).** Default layout of the terminal changes for users who never customised it (split view with WSA Trade). `WSA_COPY_BROKER_CONCURRENCY` / `WSA_COPY_FOLLOWER_BATCH_SIZE` default to 48.

**Checks run (static, once):** `tsc --noEmit` clean · `eslint` 0 errors on the 66 touched source files (older warning kept: unused `loadActiveFollowersCached`) · `vitest` on the touched and new test files plus six neighbours that import the touched modules: 33 files / 1239 tests green (one stale expectation - the default terminal view - was updated in `terminalRoutes.test.ts`). The full regression suite was not re-run (owner's instruction).
**Not tested:** any page in a real browser (WSA Trade panel, split terminal, self-copy screen, calibration forms); anything against a real API2Trade (pending-order fields in `OpenedOrders`, the `SymbolList` shape and endpoint names, the delete endpoint, the quote endpoint and the rejection texts are assumed); the gateway and the self-copy engine on a real AWS worker, and migrations 060 / 061 on a real database; supabase-js through the `undici` pool (the escape hatch is `WSA_DB_KEEPALIVE_POOL=false`); the speed gain (expected, not measured - run the first live trades with `WSA_COPY_TIMING_LOGS=true`).

### 2026-10-19 (sixth pass) - WSA Trade: one click, milliseconds, a time report, a panel that fits
**Request (Albanian, 3 points):** the order and modify buttons of the WSA terminal now work well (migrations 060 / 061 applied, AWS updated). (1) In split view the WSA terminal should not appear in a way that needs browser zoom in / out so the buttons line up as the user wants (the first word could not be decoded - read as the layout of the panel). (2) Executions and modifications - everything - take 2 to 10 seconds; review how it can be fixed so it is milliseconds, because the execution reports really show high times. (3) Remove the confirm button when modifying or executing orders: the command is given with one button. Deliver the zips; no test agent, no audit.

**What changed** (details in §6.9, "WSA Trade, sixth pass")
1. *Speed, AWS* - separate read and order chains, MODIFY from a ≤ 1.5 s old picture, an immediate and then a 350 ms refresh after an order, answers stored outside the account chain, idle poll 400 ms, owner prefetch, a single-flight broker-session warm-up, per-stage timing (`queue`, `run`, `read`, `session`, `send`, `attempts`) logged and stored with the answer.
2. *Speed, web* - cached subscription check (30 s), parallel gates, audit in `after()`, route warm-ups (GET), 400 ms burst polling for 3.5 s after an order, an optimistic overlay (6 s), the same-order retry keeps its request id.
3. *Time report* - `WebTradeTiming` end to end; the panel shows the whole wait next to the result and where it went under it; kept in Activity.
4. *No Confirm* - Buy / Sell / Close / Delete / the "close several" chips are one click; the `confirm` setting was removed from the workspace document.
5. *Panel size* - in-panel zoom (− / Auto / +, 60 - 160 %, auto-fit down to 80 %), side-by-side or stacked by the room it has, a draggable divider (20 - 60 %), a taller pane; saved in the workspace document.

**New**
- `src/lib/trade/panelLayout.ts` (pure: zoom, fit, layout, share, grid columns), `src/lib/trade/stateOverlay.ts` (pure: what an answer meant for the lists).
- Tests: `panelLayout`, `stateOverlay`, `webTradeTiming`, `useWebTrade`.

**Changed**
- **Shared with the AWS workers (live when AWS pulls `main`):** `lib/gateway/{gatewayWorker,tradeExecutor,tradeCommands}.ts`, `lib/broker/{BrokerAdapter,Api2TradeBrokerAdapter}.ts`, `scripts/wsa-copy-worker.ts`, `deploy/aws/wsa-worker-start.sh` (`WSA_TRADE_GATEWAY_IDLE_POLL_MS=400`, `WSA_TRADE_GATEWAY_HOT_STATE_MS=350`).
- Web-only: `lib/services/{webTradeService,billingService}.ts`, `lib/trade/{webTrade,webTradeFormat,ticketMath}.ts`, `lib/terminal/workspace.ts`, `hooks/useWebTrade.ts`, `components/trading/{WsaTradePanel,TerminalWorkspace}.tsx`, `components/trading/wsaTrade/{Book,TradeSettings,ui}.tsx`, `types/lucide-react.d.ts` (`ZoomOut`, `GripVertical`), the five `api/terminal/trade/{open,close,modify,cancel,close-bulk}/route.ts` (GET warm-up, `startedAt`).
- Reworked tests: `wsaTradePanel`, `tradeExecutor`, `gatewayWorker`, `webTradeService`, `webTradeGateway`, `terminalWorkspace`, `terminalWorkspaceUi`.

**Live-impact notes.** No migration. Rollout: web (Vercel) and workers in either order - the web understands answers with and without the new timing, the worker's new answers only add fields. **On AWS: pull `main`, `npm ci` (no new dependency, but it is the standing routine), restart the three units** (`wsa-copy-worker` carries the gateway). Set the Vercel **Function Region** to the Supabase region (Project Settings → Functions). A stored `confirm` key in an existing workspace document is ignored. **R17 stands:** a WSA Trade order from a local site with production keys is executed for real by the live AWS worker - and with no Confirm step one click is enough; test with a demo account. Rotate the database password that is written in `BACKEND_SETUP.md` (R2).

**Checks run (static, once):** `tsc --noEmit` clean · `eslint` 0 errors and 0 warnings on the 36 touched source and test files · `vitest` on the touched, new and neighbouring tests: 24 files / 1123 tests green (jsdom component tests included). The full regression suite was not re-run (owner's instruction).
**Not tested:** the order latency anywhere (no live system was reachable - the gain is expected, the time report is how to see it); the panel, the zoom and the divider in a real browser; anything against a real API2Trade, a real broker account, the AWS worker or a real Supabase.

### 2026-10-20 (seventh pass) - WSA Trade: no waiting - the wait moved into the database
**Request (Albanian, summarised):** the order time dropped to 2.32 s in total (`network 244 ms · server 876 ms · queue 482 ms · broker 215 ms (send 215 ms) · relay 501 ms`) but it is still too much; it has to go down much more.

**What changed** (details in §6.9, "WSA Trade, seventh pass")
1. *Migration 062 (optional)* - `claim_trade_commands_wait` and `await_trade_command`: the AWS worker's claim and the web's wait for the answer both wait inside the database and return the moment the row changes; both sides fall back to polling on their own.
2. *Web* - the wait starts together with the write; the sign-in (`requireTrader({ cached: true })`, ≤ 10 s, same token only), the account (15 s), the risk verdict (4 s, "not blocked" only), the platform subscription (30 s) and the AWS heartbeat (6 s) are kept in memory and kept young (upkeep after every state poll, a warm-up GET that names the account, a hand on the panel).
3. *AWS* - the command loops wait inside the database (`WSA_TRADE_GATEWAY_LONG_POLL_MS`, default 1000); the heartbeat reports `longPoll`, `dbRttMs`, `loopLagMs`.
4. *Time report* - sign-in · checks · database round trip web / AWS · AWS loop lag · wake-up (`live` / `web-poll` / `aws-poll`).

**New**
- `supabase/migrations/062_trade_gateway_long_poll.sql`, `src/lib/services/webTradeWarmUp.ts` (shared answer of the five warm-up GETs), test `tests/unit/signInCache.test.ts`.

**Changed**
- **Shared with the AWS workers (live when AWS pulls `main`):** `lib/gateway/{gatewayDb,gatewayStore,gatewayQueue,gatewayWorker}.ts`, `scripts/wsa-copy-worker.ts`, `deploy/aws/wsa-worker-start.sh` (`WSA_TRADE_GATEWAY_LONG_POLL_MS=1000`).
- Web-only: `lib/auth/session.ts` (`SignInOptions`, sign-in hold), `lib/services/webTradeService.ts` (caches, upkeep, parallel wait, timing stages), `lib/trade/{webTrade,webTradeFormat}.ts`, `hooks/useWebTrade.ts`, `components/trading/WsaTradePanel.tsx`, the eight `api/terminal/trade/*/route.ts` (cheap sign-in; the five order routes' GET accepts `?accountId=`).
- Tests extended: `gatewayQueue`, `gatewayStore`, `gatewayWorker`, `webTradeGateway`, `webTradeService`, `useWebTrade`, `wsaTradePanel`, `webTradeTiming`.

**Live-impact notes.** Rollout order: **(1) apply `062` in the Supabase SQL editor** (idempotent; the first thing - it only adds two functions), **(2) deploy the web (Vercel)**, **(3) on AWS `git pull main`, `npm ci`, restart the three units** (`wsa-copy-worker` carries the gateway). Until all three are done the system keeps working by polling (the time report says which side still polls). Set the Vercel **Function Region** to the Supabase region. `WSA_TRADE_GATEWAY_LONG_POLL_MS=0` switches the worker's wait off. **R17 stands** (a local site with production keys trades for real through the live AWS worker; one click is enough - use a demo account). Judge the speed on the deployed site, not through `next dev`. Rotate the database password that is written in `BACKEND_SETUP.md` (R2).

**Checks run (static, once):** `tsc --noEmit` clean · `eslint` 0 errors on the 30 touched source and test files · `vitest` on the touched tests, then the whole unit suite once: 100 files / 2501 tests green (jsdom component tests included).
**Not tested:** the order latency anywhere (the gain is expected, the time report is how to see it); migration 062 on a real Postgres; the worker's long-poll against a real Supabase; the panel in a real browser; anything against a real API2Trade, a real broker account or the AWS worker.

---

## Appendix A — API route index (all 241 route handlers)

*Generated by scanning `src/app/api/**/route.ts`. Path = `/api/<route>`. “Guard(s)” lists the guard helpers that appear in the file (several in one file = different methods or a role split). “LoC” = file length. `NONE` = intentionally public.*

**Guard legend** — `requireAuth`: any signed-in, non-suspended user · `requireTrader`: TRADER (admins pass) · `requirePartner`: PARTNER · `requireAdmin`: ADMIN or SUPER_ADMIN · `requireSuperAdmin`: SUPER_ADMIN only · `assertCanAccessAccount`: extra ownership check on the trading account · `authorizeWorker`: `x-worker-secret` · `constructEvent`: Stripe signature · `getCurrentUser`: soft check.

**Guard usage (route files):** `requireAdmin` 114, `requireAuth` 77, `requireTrader` 26, `requirePartner` 12, `NONE` 5, `assertCanAccessAccount` 5, `requireSuperAdmin` 4, `authorizeWorker` 2, `constructEvent` 1, `getCurrentUser` 1.

**Routes without a session guard (all intentional):** `/api/auth/passkeys/login/options`, `/api/auth/passkeys/login/verify`, `/api/auth/referral/validate`, `/api/certificates/verify/[verificationId]`, `/api/licenses/verify`.

### `/api/academy` — 10 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/academy/courses` | GET | requireAuth | 25 |  |
| `/api/academy/courses/[courseSlug]` | GET | requireAuth | 24 |  |
| `/api/academy/courses/[courseSlug]/lessons/[lessonSlug]` | GET | requireAuth | 22 |  |
| `/api/academy/lessons/[lessonId]/complete` | POST | requireAuth | 20 |  |
| `/api/academy/lessons/[lessonId]/notes` | DELETE, GET, PUT | requireAuth | 74 |  |
| `/api/academy/lessons/[lessonId]/questions` | POST | requireAuth | 31 |  |
| `/api/academy/lessons/[lessonId]/start` | POST | requireAuth | 20 |  |
| `/api/academy/progress` | GET | requireTrader | 13 |  |
| `/api/academy/webinars` | GET | requireAuth | 15 |  |
| `/api/academy/webinars/[id]/join` | POST | requireAuth | 23 |  |

### `/api/admin` — 110 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/admin/academy/analytics` | GET | requireAdmin | 15 |  |
| `/api/admin/academy/courses` | GET, POST | requireAdmin | 47 |  |
| `/api/admin/academy/courses/[id]` | PATCH | requireAdmin | 35 |  |
| `/api/admin/academy/lessons` | GET, POST | requireAdmin | 54 |  |
| `/api/admin/academy/lessons/[id]` | PATCH | requireAdmin | 37 |  |
| `/api/admin/academy/materials` | POST | requireAdmin | 31 |  |
| `/api/admin/academy/materials/[id]` | PATCH | requireAdmin | 29 |  |
| `/api/admin/academy/modules` | GET, POST | requireAdmin | 46 |  |
| `/api/admin/academy/modules/[id]` | PATCH | requireAdmin | 31 |  |
| `/api/admin/academy/progress` | GET | requireAdmin | 13 |  |
| `/api/admin/academy/questions` | GET | requireAdmin | 17 |  |
| `/api/admin/academy/questions/[id]` | PATCH | requireAdmin | 36 |  |
| `/api/admin/academy/remarks` | POST | requireAdmin | 31 |  |
| `/api/admin/academy/remarks/[id]` | PATCH | requireAdmin | 29 |  |
| `/api/admin/academy/webinars` | GET, POST | requireAdmin | 48 |  |
| `/api/admin/academy/webinars/[id]` | PATCH | requireAdmin | 37 |  |
| `/api/admin/accounts` | GET | requireAdmin | 13 |  |
| `/api/admin/accounts/[accountId]/deactivate` | POST | requireAdmin | 73 |  |
| `/api/admin/accounts/[accountId]/reactivate` | POST | requireAdmin | 71 |  |
| `/api/admin/accounts/[accountId]/status` | PATCH | requireAdmin | 47 |  |
| `/api/admin/ai/providers` | GET, POST | requireSuperAdmin, requireAdmin | 43 | GET = `requireAdmin`, POST = `requireSuperAdmin` |
| `/api/admin/ai/providers/[provider]` | DELETE | requireSuperAdmin | 20 |  |
| `/api/admin/ai/providers/[provider]/activate` | POST | requireSuperAdmin | 24 |  |
| `/api/admin/ai/providers/[provider]/test` | POST | requireSuperAdmin | 27 |  |
| `/api/admin/ai/usage` | GET | requireAdmin | 14 |  |
| `/api/admin/ai/users` | GET | requireAdmin | 14 |  |
| `/api/admin/ai/users/[id]/credits` | GET, POST | requireAdmin | 68 |  |
| `/api/admin/ai/users/[id]/limits` | PATCH | requireAdmin | 51 |  |
| `/api/admin/analytics/equity` | GET | requireAdmin | 41 |  |
| `/api/admin/audit` | GET | requireAdmin | 13 |  |
| `/api/admin/billing/purchases` | GET | requireAdmin | 364 |  |
| `/api/admin/billing/purchases/[id]/approve-access` | POST | requireAdmin | 20 |  |
| `/api/admin/billing/subscriptions/[id]/cancel` | POST | requireAdmin | 45 |  |
| `/api/admin/brokers` | GET, POST | requireAdmin | 35 |  |
| `/api/admin/brokers/[id]` | PATCH | requireAdmin | 23 |  |
| `/api/admin/brokers/[id]/servers` | GET, POST | requireAdmin | 47 |  |
| `/api/admin/brokers/servers/[serverId]` | PATCH | requireAdmin | 23 |  |
| `/api/admin/contact-requests` | GET | requireAdmin | 13 |  |
| `/api/admin/contact-requests/[id]` | PATCH | requireAdmin | 17 |  |
| `/api/admin/copy/events/[id]/execute` | POST | requireAdmin | 20 |  |
| `/api/admin/copy/events/[id]/simulate` | POST | requireAdmin | 16 |  |
| `/api/admin/copy/logs` | GET | requireAdmin | 14 |  |
| `/api/admin/copy/logs/[id]/retry` | POST | requireAdmin | 17 |  |
| `/api/admin/copy/master-accounts` | GET, POST | requireAdmin | 57 |  |
| `/api/admin/copy/master-accounts/[accountId]` | DELETE, PATCH | requireAdmin | 122 |  |
| `/api/admin/copy/rules` | GET, PUT | requireAdmin | 38 |  |
| `/api/admin/copy/rules/events` | GET | requireAdmin | 15 |  |
| `/api/admin/copy/runtime` | GET | requireAdmin | 13 |  |
| `/api/admin/copy/settings` | GET, PATCH | requireAdmin | 42 |  |
| `/api/admin/copy/strategies` | GET, POST | requireAdmin | 31 |  |
| `/api/admin/copy/strategies/[id]` | DELETE, PATCH | requireAdmin | 34 |  |
| `/api/admin/copy/strategies/[id]/archive` | POST | requireAdmin | 14 |  |
| `/api/admin/copy/strategies/[id]/events` | GET | requireAdmin | 14 |  |
| `/api/admin/copy/strategies/[id]/followers` | GET, PATCH | requireAdmin | 100 |  |
| `/api/admin/copy/strategies/[id]/monitor` | POST | requireAdmin | 17 |  |
| `/api/admin/copy/strategies/[id]/publish` | POST | requireAdmin | 15 |  |
| `/api/admin/copy/strategies/[id]/simulate` | POST | requireAdmin | 17 |  |
| `/api/admin/economic-calendar` | GET, POST | requireAdmin | 42 |  |
| `/api/admin/economic-calendar/[id]` | DELETE, PATCH | requireAdmin | 61 |  |
| `/api/admin/evaluations/analytics` | GET | requireAdmin | 14 |  |
| `/api/admin/evaluations/attempts` | GET | requireAdmin | 17 |  |
| `/api/admin/evaluations/attempts/[id]/check` | POST | requireAdmin | 18 |  |
| `/api/admin/evaluations/attempts/[id]/funding` | PATCH | requireAdmin | 27 |  |
| `/api/admin/evaluations/attempts/[id]/link-account` | PATCH | requireAdmin | 29 |  |
| `/api/admin/evaluations/attempts/[id]/override` | POST | requireAdmin | 32 |  |
| `/api/admin/evaluations/certificates` | GET | requireAdmin | 14 |  |
| `/api/admin/evaluations/certificates/[id]/revoke` | POST | requireAdmin | 28 |  |
| `/api/admin/evaluations/programs` | GET, POST | requireAdmin | 56 |  |
| `/api/admin/evaluations/programs/[id]` | PATCH | requireAdmin | 41 |  |
| `/api/admin/jobs` | GET | requireAdmin | 18 |  |
| `/api/admin/jobs/[id]` | GET | requireAdmin | 17 |  |
| `/api/admin/jobs/[id]/cancel` | POST | requireAdmin | 27 |  |
| `/api/admin/jobs/[id]/retry` | POST | requireAdmin | 27 |  |
| `/api/admin/jobs/enqueue` | POST | requireAdmin | 42 |  |
| `/api/admin/jobs/run-now` | POST | requireAdmin | 36 |  |
| `/api/admin/marketplace/access` | GET | requireAdmin | 14 |  |
| `/api/admin/marketplace/access/[id]` | PATCH | requireAdmin | 77 |  |
| `/api/admin/marketplace/analytics` | GET | requireAdmin | 14 |  |
| `/api/admin/marketplace/licenses` | GET | requireAdmin | 14 |  |
| `/api/admin/marketplace/licenses/[id]/reissue` | POST | requireAdmin | 29 |  |
| `/api/admin/marketplace/licenses/[id]/revoke` | POST | requireAdmin | 28 |  |
| `/api/admin/marketplace/products` | GET, POST | requireAdmin | 69 |  |
| `/api/admin/marketplace/products/[id]` | PATCH | requireAdmin | 59 |  |
| `/api/admin/marketplace/products/[id]/releases` | POST | requireAdmin | 66 |  |
| `/api/admin/marketplace/verification-logs` | GET | requireAdmin | 25 |  |
| `/api/admin/partner-commissions/[id]/status` | PATCH | requireAdmin | 24 |  |
| `/api/admin/partners` | GET | requireAdmin | 13 |  |
| `/api/admin/partners/[id]/approve` | POST | requireAdmin | 16 |  |
| `/api/admin/partners/[id]/broker-configurations` | GET, POST | requireAdmin | 179 |  |
| `/api/admin/partners/[id]/commissions` | GET, POST | requireAdmin | 50 |  |
| `/api/admin/partners/[id]/rebates` | POST | requireAdmin | 26 |  |
| `/api/admin/partners/[id]/reject` | POST | requireAdmin | 16 |  |
| `/api/admin/partners/[id]/traders` | GET | requireAdmin | 17 |  |
| `/api/admin/partners/commissions` | GET | requireAdmin | 68 |  |
| `/api/admin/partners/commissions/[id]/approve` | POST | requireAdmin | 46 |  |
| `/api/admin/partners/financial-ledgers` | GET | requireAdmin | 43 |  |
| `/api/admin/partners/payouts` | GET | requireAdmin | 56 |  |
| `/api/admin/partners/payouts/[id]/mark-paid` | POST | requireAdmin | 58 |  |
| `/api/admin/partners/withdrawals` | GET | requireAdmin | 19 |  |
| `/api/admin/partners/withdrawals/[id]/approve` | POST | requireAdmin | 16 |  |
| `/api/admin/partners/withdrawals/[id]/mark-paid` | POST | requireAdmin | 16 |  |
| `/api/admin/partners/withdrawals/[id]/reject` | POST | requireAdmin | 17 |  |
| `/api/admin/summary` | GET | requireAdmin | 13 |  |
| `/api/admin/terminal/health-check` | POST | requireAdmin | 14 |  |
| `/api/admin/terminal/settings` | PATCH | requireAdmin | 48 |  |
| `/api/admin/terminal/status` | GET | requireAdmin | 52 |  |
| `/api/admin/traders/[id]/partner` | PATCH | requireAdmin | 24 |  |
| `/api/admin/users` | GET | requireAdmin | 33 |  |
| `/api/admin/users/[id]/role` | PATCH | requireAdmin | 24 |  |
| `/api/admin/users/[id]/status` | PATCH | requireAdmin | 28 |  |

### `/api/ai` — 5 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/ai/admin-assistant` | POST | requireAdmin | 64 |  |
| `/api/ai/chart-analysis` | POST | requireAdmin | 97 |  |
| `/api/ai/chart-assistant` | GET, POST | requireAuth | 199 |  |
| `/api/ai/chat` | POST | requireTrader | 87 | `requireTrader` plus an inline TRADER-only check |
| `/api/ai/credits` | GET | requireAuth | 20 |  |

### `/api/analytics` — 3 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/analytics/equity-curve` | GET | requireAuth | 22 | no page calls it any more (kept for compatibility); returns at most the newest 1000 snapshots |
| `/api/analytics/performance` | GET | requireAuth | 39 | `accountId=<uuid|ALL>&range=1D|1W|1M|3M|6M|1Y|ALL`; scope by `user_id` unless ADMIN; `ALL` = every CONNECTED account in scope (admin: platform-wide) |
| `/api/analytics/summary` | GET | requireAuth | 22 |  |

### `/api/auth` — 9 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/auth/passkeys` | DELETE, GET | requireAuth | 31 |  |
| `/api/auth/passkeys/login/options` | POST | NONE | 13 |  |
| `/api/auth/passkeys/login/verify` | POST | NONE | 35 |  |
| `/api/auth/passkeys/register/options` | POST | requireAuth | 17 |  |
| `/api/auth/passkeys/register/verify` | POST | requireAuth | 32 |  |
| `/api/auth/profile` | PATCH | requireAuth | 45 |  |
| `/api/auth/referral` | POST | requireAuth | 24 |  |
| `/api/auth/referral/validate` | GET | NONE | 17 |  |
| `/api/auth/session` | GET | getCurrentUser | 21 | soft: returns the user or null (used by `AppShell`) |

### `/api/billing` — 6 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/billing/checkout` | POST | requireAuth | 74 |  |
| `/api/billing/me` | GET | requireAuth | 23 |  |
| `/api/billing/mock-confirm` | POST | requireAuth | 26 | R4 — only safe while `BILLING_PROVIDER=stripe` |
| `/api/billing/portal` | POST | requireAuth | 35 |  |
| `/api/billing/products` | GET | requireAuth | 14 |  |
| `/api/billing/return-status` | GET | requireAuth | 21 |  |

### `/api/broker-servers` — 1 route

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/broker-servers/search` | GET | requireAuth, assertCanAccessAccount | 69 |  |

### `/api/brokers` — 3 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/brokers` | GET | requireAuth | 21 |  |
| `/api/brokers/[brokerId]/servers` | GET | requireAuth | 75 |  |
| `/api/brokers/search` | GET | requireAuth | 31 |  |

### `/api/certificates` — 1 route

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/certificates/verify/[verificationId]` | GET | NONE | 17 |  |

### `/api/contact-requests` — 1 route

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/contact-requests` | POST | requireTrader | 17 |  |

### `/api/copy-trading` — 4 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/copy-trading/self-copy` | GET, POST | requireTrader | 54 | the caller's routes (with `engine` status and the copy system's `platform` facts) / create a route |
| `/api/copy-trading/self-copy/[id]` | DELETE, PATCH | requireTrader | 41 | edit (settings incl. `calibration`, pause / resume) / archive a route |
| `/api/copy-trading/self-copy/[id]/activity` | GET | requireTrader | 22 | the route's activity rows (`self_copy_events`, migration 061): copied / skipped / failed with the reason and the stage timings (§9.8) |
| `/api/copy-trading/self-copy/[id]/check` | POST | requireTrader | 20 | "Check route": a dry run of every gate on a sample trade (replaces the dead `…/simulate` route, §9.8) |

### `/api/copy` — 6 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/copy/logs` | GET | requireTrader | 13 |  |
| `/api/copy/my-subscriptions` | GET | requireTrader | 13 |  |
| `/api/copy/strategies` | GET | requireTrader | 14 |  |
| `/api/copy/strategies/[id]/follow` | POST | requireTrader | 68 |  |
| `/api/copy/subscriptions/[id]` | PATCH | requireTrader | 24 |  |
| `/api/copy/subscriptions/[id]/settings` | PATCH | requireTrader | 29 |  |

### `/api/crm` — 2 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/crm/notes` | GET, POST | requireAdmin | 35 |  |
| `/api/crm/traders` | GET | requireAdmin | 36 |  |

### `/api/dxfeed` — 6 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/dxfeed/config` | GET | requireAuth | 57 |  |
| `/api/dxfeed/feed-token` | POST | requireAuth | 68 |  |
| `/api/dxfeed/ipf` | GET | requireAuth | 15 |  |
| `/api/dxfeed/news` | GET | requireAuth | 15 |  |
| `/api/dxfeed/scanner` | GET, POST | requireAuth | 27 |  |
| `/api/dxfeed/schedule` | GET | requireAuth | 16 |  |

### `/api/economic-calendar` — 1 route

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/economic-calendar` | GET | requireTrader | 26 |  |

### `/api/evaluations` — 8 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/evaluations/attempts` | GET | requireAuth | 14 |  |
| `/api/evaluations/attempts/[id]` | GET | requireAuth | 19 |  |
| `/api/evaluations/attempts/[id]/certificate` | POST | requireAuth | 33 |  |
| `/api/evaluations/attempts/[id]/link-account` | PATCH | requireTrader | 43 |  |
| `/api/evaluations/certificates` | GET | requireAuth | 14 |  |
| `/api/evaluations/certificates/[id]/download` | GET | requireAuth | 24 |  |
| `/api/evaluations/programs` | GET | requireAuth | 14 |  |
| `/api/evaluations/programs/[id]` | POST | requireAuth | 29 |  |

### `/api/licenses` — 1 route

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/licenses/verify` | POST | NONE | 104 | public; per-licence rate limit only; hashed IP/UA logged |

### `/api/marketplace` — 3 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/marketplace/products` | GET | requireAuth | 20 |  |
| `/api/marketplace/products/[slug]` | GET | requireAuth | 26 |  |
| `/api/marketplace/products/[slug]/request-access` | POST | requireAuth | 45 |  |

### `/api/my-bots` — 4 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/my-bots` | GET | requireAuth | 18 |  |
| `/api/my-bots/[accessId]/download` | GET | requireAuth | 44 |  |
| `/api/my-bots/[accessId]/licenses` | POST | requireAuth | 97 |  |
| `/api/my-bots/licenses` | GET | requireAuth | 18 |  |

### `/api/notifications` — 3 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/notifications` | GET | requireAuth | 17 |  |
| `/api/notifications/[id]/read` | PATCH | requireAuth | 18 |  |
| `/api/notifications/read-all` | PATCH | requireAuth | 14 |  |

### `/api/partner` — 13 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/partner/activities` | GET | requirePartner | 13 |  |
| `/api/partner/commissions` | GET | requirePartner | 17 |  |
| `/api/partner/commissions/export` | GET | requirePartner | 54 |  |
| `/api/partner/crm/notes` | GET, POST | requirePartner | 42 |  |
| `/api/partner/payouts` | GET | requireAuth | 47 | inline `role === PARTNER` check (stricter than `requireAuth`; admins are refused) |
| `/api/partner/profile` | GET | requirePartner | 51 |  |
| `/api/partner/rebates` | GET | requirePartner | 17 |  |
| `/api/partner/risk-events` | GET | requirePartner | 13 |  |
| `/api/partner/summary` | GET | requirePartner | 13 |  |
| `/api/partner/traders` | GET | requirePartner | 22 |  |
| `/api/partner/traders/[id]` | GET | requirePartner | 16 |  |
| `/api/partner/withdrawals` | GET, POST | requirePartner | 50 |  |
| `/api/partner/withdrawals/[id]` | GET | requirePartner | 16 |  |

### `/api/realtime` — 1 route

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/realtime/token` | GET | requireAuth | 19 |  |

### `/api/reports` — 2 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/reports/pdf` | POST | requireAuth | 64 |  |
| `/api/reports/trades` | GET | requireTrader | 59 |  |

### `/api/risk` — 4 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/risk/events` | GET | requireAuth | 14 |  |
| `/api/risk/events/[id]/acknowledge` | PATCH | requireAdmin | 18 |  |
| `/api/risk/rules` | GET, POST | requireAdmin, requireAuth | 53 | GET = `requireAuth`, POST = `requireAdmin` |
| `/api/risk/rules/[id]` | PATCH | requireAdmin | 32 |  |

### `/api/terminal` — 22 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/terminal/candles` | GET | requireAuth | 27 |  |
| `/api/terminal/dom` | GET | requireAuth | 18 |  |
| `/api/terminal/heatmap` | GET | requireAuth | 18 |  |
| `/api/terminal/macro` | GET | requireAuth | 38 |  |
| `/api/terminal/metatrader/accounts` | GET | requireAuth | 34 | the caller's own accounts, masked login, never a password (§6.9); partners 403 |
| `/api/terminal/metatrader/launch` | POST | requireAuth | 51 | `{accountId}` → login / server / platform of one own account; audited `METATRADER_TERMINAL_LAUNCHED` |
| `/api/terminal/metatrader/resolve` | POST | requireAuth | 85 | `{accountId, refresh?}` or `{server, platform, refresh?}` → the broker's own web-terminal address, found automatically (§6.9); never takes an address; partners 403; refresh ≤ 5/h |
| `/api/terminal/news` | GET | requireAuth | 17 |  |
| `/api/terminal/preferences` | GET, PATCH | requireAuth | 81 | PATCH merges `layout` and ignores a `workspace` key |
| `/api/terminal/provider/status` | GET | requireAuth | 14 |  |
| `/api/terminal/quote` | GET | requireAuth | 18 |  |
| `/api/terminal/symbols` | GET | requireAuth | 14 |  |
| `/api/terminal/trade/accounts` | GET | requireTrader | 23 | WSA Trade (§6.9): the caller's own accounts + the platform gate + the `route` orders take (`gateway` · `direct` · `none`); partners 403 |
| `/api/terminal/trade/cancel` | POST | requireTrader | 28 | `{accountId, ticket, clientRequestId?}` → deletes a PENDING order (never closes a position); executed by the AWS worker (gateway command CANCEL); not blocked by risk; audited `WEB_TRADE_ORDER_CANCELLED` |
| `/api/terminal/trade/close` | POST | requireTrader | 27 | `{accountId, ticket, volume?}` → (partial) close of one own position; gateway command CLOSE; audited `WEB_TRADE_POSITION_CLOSED` |
| `/api/terminal/trade/close-bulk` | POST | requireTrader | 29 | `{accountId, scope: ALL·PROFIT·LOSS·BUY·SELL·SYMBOL·PENDING, symbol?, clientRequestId?}` → closes several positions / deletes pending orders (≤ 200, 3 at a time); the answer counts them and lists the failures; audited `WEB_TRADE_BULK_CLOSED` |
| `/api/terminal/trade/modify` | POST | requireTrader | 29 | `{accountId, ticket, stopLoss?, takeProfit?, price?}` (`null` removes a level; `price` only for a pending order); gateway command MODIFY; audited `WEB_TRADE_POSITION_MODIFIED` |
| `/api/terminal/trade/open` | POST | requireTrader | 31 | `{accountId, symbol, side, volume, orderKind (MARKET·LIMIT·STOP), price?, stopLoss?, takeProfit?, clientRequestId}`; gates on the web: platform subscription (admins exempt), risk block, ownership; execution switch on the AWS worker; repeat-protected (unique `(user_id, client_request_id)`); audited `WEB_TRADE_ORDER_OPENED` |
| `/api/terminal/trade/state` | GET | requireTrader | 33 | figures, open positions, **pending orders**, quote (when the bridge has a price endpoint), `riskBlocked`, `delayed` of one own account; each poll tells the AWS worker "somebody is looking" (`maxDuration` 30) |
| `/api/terminal/trade/symbols` | GET | requireTrader | 30 | `?accountId` → every symbol the account's broker offers, in the broker's own spelling, read by the AWS worker from API2Trade (`SymbolList`) and kept for hours |
| `/api/terminal/volume-profile` | GET | requireAuth | 18 |  |
| `/api/terminal/workspace` | GET, PATCH | requireAuth | 130 | the trader's terminal workspace in `terminal_user_preferences.layout.workspace` (§6.9) |

### `/api/trader` — 2 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/trader/daily-pnl` | GET | requireTrader | 13 |  |
| `/api/trader/sync-trades` | POST | requireTrader | 119 |  |

### `/api/trades` — 1 route

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/trades` | GET | requireAuth | 27 |  |

### `/api/trading-accounts` — 6 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/trading-accounts` | GET, POST | requireAuth | 40 |  |
| `/api/trading-accounts/[accountId]` | DELETE, GET, PATCH | requireAuth | 60 |  |
| `/api/trading-accounts/[accountId]/broker-credentials` | GET, POST | requireAuth, assertCanAccessAccount | 185 |  |
| `/api/trading-accounts/[accountId]/broker-credentials/verify` | POST | requireAuth, assertCanAccessAccount | 142 |  |
| `/api/trading-accounts/[accountId]/connection-status` | GET | requireAuth, assertCanAccessAccount | 21 |  |
| `/api/trading-accounts/[accountId]/sync` | POST | requireAuth, assertCanAccessAccount | 86 |  |

### `/api/webhooks` — 1 route

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/webhooks/stripe` | POST | constructEvent | 150 | Stripe signature (`constructEvent`), not a session |

### `/api/worker` — 2 routes

| Route | Methods | Guard(s) | LoC | Note |
|---|---|---|---|---|
| `/api/worker/jobs/run` | POST | authorizeWorker | 37 | `x-worker-secret` (503 in production if `WORKER_SECRET` unset) |
| `/api/worker/jobs/schedule` | POST | authorizeWorker | 29 | `x-worker-secret` (503 in production if `WORKER_SECRET` unset) |
