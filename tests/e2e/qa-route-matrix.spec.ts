import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

type Role = "admin" | "trader" | "partner";
type RouteSpec = {
  path: string;
  expectedText: RegExp;
};

type Fixtures = {
  traderAccountId: string | null;
  evaluationAttemptId: string | null;
  certificateVerificationId: string | null;
};

type UnpaidFixture = {
  userId: string;
  email: string;
  password: string;
  accountId: string;
};

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const authState = (role: Role) => path.join(process.cwd(), "tests", "e2e", ".auth", `${role}.json`);
const bannedText = [
  /Application error/i,
  /Something went wrong/i,
  /Unhandled Runtime Error/i,
  /^404$/m,
  /^500$/m,
] as const;

let fixturePromise: Promise<Fixtures> | null = null;

function trackedPage(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "unknown";
    if (errorText.includes("net::ERR_ABORTED")) return;
    failedRequests.push(`${request.method()} ${request.url()} :: ${errorText}`);
  });

  page.on("response", async (response) => {
    if (response.status() >= 400) {
      const url = response.url();
      if (!url.includes("/api/auth/session")) {
        failedRequests.push(`${response.request().method()} ${url} :: HTTP ${response.status()}`);
      }
    }
  });

  return { consoleErrors, failedRequests };
}

async function getFixtures(): Promise<Fixtures> {
  if (!fixturePromise) {
    fixturePromise = (async () => {
      const { data: trader } = await supabase.from("profiles").select("id").eq("email", "trader@aurix.local").single();
      const [account, attempt, cert] = await Promise.all([
        trader
          ? supabase.from("trading_accounts").select("id").eq("user_id", trader.id).limit(1).maybeSingle()
          : Promise.resolve({ data: null }),
        trader
          ? supabase.from("evaluation_attempts").select("id").eq("user_id", trader.id).limit(1).maybeSingle()
          : Promise.resolve({ data: null }),
        supabase.from("evaluation_certificates").select("verification_id").limit(1).maybeSingle(),
      ]);

      return {
        traderAccountId: account.data?.id ?? null,
        evaluationAttemptId: attempt.data?.id ?? null,
        certificateVerificationId: cert.data?.verification_id ?? null,
      };
    })();
  }

  return fixturePromise;
}

async function createUnpaidTraderFixture(): Promise<UnpaidFixture> {
  const stamp = Date.now();
  const email = `qa-unpaid-${stamp}@aurix.local`;
  const password = "Password123!";
  const fullName = `QA Unpaid ${stamp}`;

  const { data: createdUser, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createError || !createdUser.user) {
    throw new Error(`Failed to create unpaid QA user: ${createError?.message ?? "missing user"}`);
  }

  const userId = createdUser.user.id;

  const { error: profileError } = await supabase.from("profiles").upsert(
    {
      id: userId,
      email,
      full_name: fullName,
      role: "TRADER",
      status: "ACTIVE",
    },
    { onConflict: "id" },
  );
  if (profileError) throw new Error(`Failed to create unpaid profile: ${profileError.message}`);

  const { error: traderProfileError } = await supabase.from("trader_profiles").upsert(
    { user_id: userId },
    { onConflict: "user_id" },
  );
  if (traderProfileError) throw new Error(`Failed to create unpaid trader profile: ${traderProfileError.message}`);

  const { data: account, error: accountError } = await supabase
    .from("trading_accounts")
    .insert({
      user_id: userId,
      account_name: `QA Locked ${stamp}`,
      broker_name: "MetaTrader 5 Demo",
      broker_account_id: `QA-LOCKED-${stamp}`,
      status: "CONNECTED",
      currency: "USD",
      initial_balance: 5000,
    })
    .select("id")
    .single();

  if (accountError || !account) {
    throw new Error(`Failed to create unpaid account: ${accountError?.message ?? "missing account"}`);
  }

  return { userId, email, password, accountId: account.id };
}

async function createApprovedTraderFixture(): Promise<UnpaidFixture> {
  const fixture = await createUnpaidTraderFixture();
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: product, error: productError }, { data: traderProfile, error: traderProfileError }] = await Promise.all([
    supabase.from("billing_products").select("id, code").eq("code", "PLATFORM_MONTHLY").single(),
    supabase.from("trader_profiles").select("id").eq("user_id", fixture.userId).single(),
  ]);

  if (productError || !product) throw new Error(`Failed to load platform billing product: ${productError?.message ?? "missing product"}`);
  if (traderProfileError || !traderProfile) throw new Error(`Failed to load trader profile: ${traderProfileError?.message ?? "missing trader profile"}`);

  const { data: order, error: orderError } = await supabase
    .from("payment_orders")
    .insert({
      user_id: fixture.userId,
      product_id: product.id,
      amount: 50,
      currency: "USD",
      status: "PAID",
      provider: "MOCK",
      metadata: { checkoutMode: "mock" },
      paid_at: now.toISOString(),
    })
    .select("id")
    .single();

  if (orderError || !order) throw new Error(`Failed to create approved payment order: ${orderError?.message ?? "missing order"}`);

  const { error: subscriptionError } = await supabase.from("subscriptions").insert({
    trader_profile_id: traderProfile.id,
    plan_name: "Platform Subscription",
    started_at: now.toISOString(),
    ends_at: periodEnd,
    user_id: fixture.userId,
    product_id: product.id,
    payment_order_id: order.id,
    status: "ACTIVE",
    current_period_end: periodEnd,
    approved_at: now.toISOString(),
  });

  if (subscriptionError) throw new Error(`Failed to create active subscription: ${subscriptionError.message}`);

  return fixture;
}

async function loginAs(page: Page, email: string, password: string, expectedPath: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`**${expectedPath}`);
}

async function expectHealthyRoute(page: Page, route: RouteSpec) {
  const telemetry = trackedPage(page);

  await page.goto(route.path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.locator("body")).toContainText(route.expectedText);

  for (const pattern of bannedText) {
    await expect(page.locator("body")).not.toContainText(pattern);
  }

  expect.soft(telemetry.consoleErrors, `${route.path} console errors`).toEqual([]);
  expect.soft(telemetry.failedRequests, `${route.path} failed requests`).toEqual([]);
}

async function assertSubscriptionLock(page: Page, pathName: string) {
  await page.goto(pathName);
  await expect(page.locator("body")).toContainText(/Platform subscription required/i);
  await expect(page.locator("body")).toContainText(/\$50\/month/i);
  await expect(page.locator("body")).toContainText(/Activate subscription/i);
  await expect(page.locator("body")).toContainText(/Preview what you unlock/i);
}

async function expectResponsivePage(context: BrowserContext, route: string, expected: RegExp, width: number, height: number) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await expectHealthyRoute(page, { path: route, expectedText: expected });
  await page.close();
}

test.describe("literal QA route matrix", () => {
  test.setTimeout(240_000);

  test("public and auth routes stay public and validate cleanly", async ({ page }) => {
    const fixtures = await getFixtures();
    const publicRoutes: RouteSpec[] = [
      { path: "/", expectedText: /AURIX|Welcome/i },
      { path: "/login", expectedText: /Welcome back/i },
      { path: "/register", expectedText: /How will you use Aurix\?/i },
      { path: "/forgot-password", expectedText: /Forgot password/i },
      { path: "/reset-password", expectedText: /Create a new password/i },
      { path: `/certificates/verify/${fixtures.certificateVerificationId ?? "missing-certificate"}`, expectedText: /Certificate|Verified|Revoked|Not Found/i },
      { path: "/certificates/verify/invalid-qa-certificate-id", expectedText: /Certificate Not Found|Unable to verify/i },
    ];

    for (const route of publicRoutes) {
      await expectHealthyRoute(page, route);
    }

    await page.goto("/register");
    await page.getByRole("button", { name: /I am a Trader/i }).click();
    await page.getByLabel("Full name").fill("QA Visitor");
    await page.getByLabel("Email").fill("qa-visitor@example.com");
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Confirm password").fill("Mismatch123!");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page.locator("body")).toContainText(/Passwords do not match/i);

    await page.goto("/reset-password");
    await page.getByLabel("New password").fill("Password123!");
    await page.getByLabel("Confirm password").fill("Mismatch123!");
    await page.getByRole("button", { name: /update password/i }).click();
    await expect(page.locator("body")).toContainText(/Passwords do not match/i);

    for (const protectedPath of ["/dashboard", "/admin", "/partner"]) {
      await page.goto(protectedPath);
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
    }
  });

  test("demo workspace covers every route without login or live mutations", async ({ page }) => {
    const externalCalls: string[] = [];
    const mutationCalls: string[] = [];

    page.on("request", (request) => {
      const url = request.url();
      const method = request.method();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && url.startsWith("http://127.0.0.1:4321")) {
        mutationCalls.push(`${method} ${url}`);
      }
      if (/stripe|metaapi|dxfeed|googleapis|generativelanguage/i.test(url)) {
        externalCalls.push(url);
      }
    });

    await page.goto("/login");
    await page.getByRole("link", { name: /view demo/i }).click();
    await expect(page).toHaveURL(/\/demo(?:\/dashboard)?$/);

    const demoRoutes: RouteSpec[] = [
      { path: "/demo/dashboard", expectedText: /Demo Mode|Trading overview/i },
      { path: "/demo/accounts", expectedText: /Demo Mode|Connected broker accounts/i },
      { path: "/demo/accounts/acc-growth-50k", expectedText: /Demo Mode|Broker connection/i },
      { path: "/demo/copy-trading", expectedText: /Demo Mode|Copy Trading/i },
      { path: "/demo/marketplace", expectedText: /Demo Mode|Marketplace|Bot Marketplace/i },
      { path: "/demo/my-bots", expectedText: /Demo Mode|My Bots/i },
      { path: "/demo/academy", expectedText: /Demo Mode|Trading Academy/i },
      { path: "/demo/evaluations", expectedText: /Demo Mode|Evaluation Programs/i },
      { path: "/demo/terminal", expectedText: /Demo Mode|Terminal/i },
      { path: "/demo/ai", expectedText: /Demo Mode|AI/i },
    ];

    for (const route of demoRoutes) {
      await expectHealthyRoute(page, route);
      await expect(page.locator("body")).toContainText(/Demo Mode/i);
    }

    expect(mutationCalls).toEqual([]);
    expect(externalCalls).toEqual([]);
  });

  test("unpaid trader route matrix shows allowed pages and locks premium routes", async ({ page }) => {
    const unpaid = await createUnpaidTraderFixture();
    await loginAs(page, unpaid.email, unpaid.password, "/dashboard");

    const allowedRoutes: RouteSpec[] = [
      { path: "/billing", expectedText: /Billing & Access/i },
      { path: "/platform-preview", expectedText: /Platform|Workspace|Preview/i },
      { path: "/marketplace", expectedText: /Marketplace|Bot/i },
      { path: "/my-bots", expectedText: /Bot|License/i },
      { path: "/academy", expectedText: /Academy/i },
      { path: "/evaluations", expectedText: /Evaluation/i },
    ];

    for (const route of allowedRoutes) {
      await expectHealthyRoute(page, route);
    }

    for (const route of [
      "/dashboard",
      "/accounts",
      `/accounts/${unpaid.accountId}`,
      "/copy-trading",
      "/ai",
      "/terminal",
      "/trades",
      "/analytics",
      "/risk",
      "/reports",
    ]) {
      await assertSubscriptionLock(page, route);
    }
  });

  test.describe("paid trader workspace", () => {
    test("paid trader routes load with unlocked content", async ({ page }) => {
      const fixtures = await getFixtures();
      const approved = await createApprovedTraderFixture();
      await loginAs(page, approved.email, approved.password, "/dashboard");
      const routes: RouteSpec[] = [
        { path: "/dashboard", expectedText: /Trader workspace|Welcome,/i },
        { path: "/accounts", expectedText: /Accounts/i },
        { path: "/copy-trading", expectedText: /Copy Trading|Per-account copy access/i },
        { path: "/marketplace", expectedText: /Marketplace|Bot/i },
        { path: "/my-bots", expectedText: /Bot|License/i },
        { path: "/academy", expectedText: /Academy/i },
        { path: "/evaluations", expectedText: /Evaluation/i },
        { path: "/terminal", expectedText: /Terminal/i },
        { path: "/ai", expectedText: /AI/i },
        { path: "/trades", expectedText: /Trades/i },
        { path: "/analytics", expectedText: /Analytics/i },
        { path: "/risk", expectedText: /Risk/i },
        { path: "/reports", expectedText: /Reports/i },
        { path: "/billing", expectedText: /Billing & Access/i },
        { path: "/platform-preview", expectedText: /Platform|Preview/i },
      ];

      if (fixtures.traderAccountId) {
        routes.push({ path: `/accounts/${fixtures.traderAccountId}`, expectedText: /Account|Overview|Equity/i });
      }
      if (fixtures.evaluationAttemptId) {
        routes.push({ path: `/evaluations/${fixtures.evaluationAttemptId}`, expectedText: /Evaluation|Attempt/i });
      }

      for (const route of routes) {
        await expectHealthyRoute(page, route);
      }
    });
  });

  test.describe("admin and partner workspaces", () => {
    test.use({ storageState: authState("admin") });

    test("admin routes load safely", async ({ page, browser }) => {
      const routes: RouteSpec[] = [
        { path: "/admin", expectedText: /Admin/i },
        { path: "/admin/accounts", expectedText: /Account supervision|Accounts/i },
        { path: "/admin/copy", expectedText: /Copy Trading Control Center|Copy/i },
        { path: "/admin/jobs", expectedText: /Jobs/i },
        { path: "/admin/users", expectedText: /Users/i },
        { path: "/admin/marketplace", expectedText: /Marketplace/i },
        { path: "/admin/academy", expectedText: /Academy/i },
        { path: "/admin/evaluations", expectedText: /Evaluations/i },
        { path: "/admin/terminal", expectedText: /Terminal/i },
        { path: "/admin/ai", expectedText: /AI/i },
        { path: "/admin/subscriptions", expectedText: /Subscription|Billing/i },
        { path: "/admin/risk", expectedText: /Risk/i },
        { path: "/admin/audit", expectedText: /Audit/i },
        { path: "/admin/crm", expectedText: /CRM/i },
      ];

      for (const route of routes) {
        await expectHealthyRoute(page, route);
      }

      await page.goto("/admin/accounts");
      await expect(page.locator("body")).toContainText(/Inactive/i);
      await page.goto("/admin/copy");
      await expect(page.locator("body")).toContainText(/BROKER_EXECUTION_ENABLED=false|SIMULATION/i);
      const executeButton = page.getByRole("button", { name: /^Execute$/ }).first();
      if (await executeButton.isVisible().catch(() => false)) {
        await executeButton.click();
        await expect(page.locator("body")).toContainText(/Execute live copy/i);
        await page.getByRole("button", { name: /Cancel/i }).last().click();
      }
      await page.goto("/admin/terminal/provider");
      await expect(page.locator("body")).toContainText(/dxFeed|locked|unavailable/i);

      const partnerContext = await browser.newContext({ storageState: authState("partner") });
      const partnerPage = await partnerContext.newPage();
      await partnerPage.goto("/admin");
      await expect(partnerPage).toHaveURL(/\/partner$/);
      await partnerContext.close();
    });
  });

  test.describe("partner workspace", () => {
    test.use({ storageState: authState("partner") });

    test("partner routes and scoped tools load", async ({ page, browser }) => {
      const routes: RouteSpec[] = [
        { path: "/partner", expectedText: /Partner Overview|Partner/i },
        { path: "/partner/traders", expectedText: /Traders|Assigned traders/i },
        { path: "/partner/commissions", expectedText: /Commissions|Commission/i },
        { path: "/partner/crm", expectedText: /CRM|Notes/i },
        { path: "/partner/payouts", expectedText: /Payouts|Commission ledger/i },
      ];

      for (const route of routes) {
        await expectHealthyRoute(page, route);
      }

      await page.goto("/partner");
      await expect(page.locator("body")).toContainText(/referral code/i);
      await page.goto("/partner/commissions");
      await expect(page.locator("body")).toContainText(/Export CSV|No commission/i);
      await page.goto("/partner/crm");
      await expect(page.locator("body")).toContainText(/Add note|No traders assigned/i);

      const traderContext = await browser.newContext({ storageState: authState("trader") });
      const traderPage = await traderContext.newPage();
      await traderPage.goto("/admin");
      await expect(traderPage).toHaveURL(/\/dashboard$/);
      await traderContext.close();
    });
  });

  test("priority pages survive desktop, tablet, and mobile-ish widths", async ({ browser }) => {
    const approved = await createApprovedTraderFixture();
    const adminContext = await browser.newContext({ storageState: authState("admin") });
    const traderContext = await browser.newContext();
    const partnerContext = await browser.newContext({ storageState: authState("partner") });
    const publicContext = await browser.newContext();

    try {
      const traderPage = await traderContext.newPage();
      await loginAs(traderPage, approved.email, approved.password, "/dashboard");
      await traderPage.close();

      for (const size of [
        { width: 1440, height: 900 },
        { width: 1024, height: 768 },
        { width: 390, height: 844 },
      ]) {
        await expectResponsivePage(traderContext, "/dashboard", /Trader workspace|Welcome,/i, size.width, size.height);
        await expectResponsivePage(adminContext, "/admin/copy", /Copy Trading Control Center|Copy/i, size.width, size.height);
        await expectResponsivePage(adminContext, "/admin/accounts", /Account supervision|Accounts/i, size.width, size.height);
        await expectResponsivePage(traderContext, "/copy-trading", /Copy Trading|Per-account copy access/i, size.width, size.height);
        await expectResponsivePage(partnerContext, "/partner/commissions", /Commissions|Commission/i, size.width, size.height);
        await expectResponsivePage(publicContext, "/demo/dashboard", /Demo Mode|Trading overview/i, size.width, size.height);
      }
    } finally {
      await Promise.all([
        adminContext.close(),
        traderContext.close(),
        partnerContext.close(),
        publicContext.close(),
      ]);
    }
  });
});
