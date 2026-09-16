/**
 * seed-client-demo.ts
 *
 * Full client demo seed — covers all platform modules including all partner pages.
 * Idempotent: safe to re-run.
 *
 * Demo credentials:
 *   Admin:   admin@aurix.local   / Password123!
 *   Trader:  trader@aurix.local  / Password123!
 *   Partner: partner@aurix.local / Password123!
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// ── env loader ───────────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > -1) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = loadEnv();
const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── helpers ───────────────────────────────────────────────────────────────────
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genVerificationId(): string {
  const chars = Array.from({ length: 8 }, () =>
    CHARSET[Math.floor(Math.random() * CHARSET.length)]
  ).join("");
  return `AX-${chars}`;
}

function hashLicenseKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// ── user management ───────────────────────────────────────────────────────────
async function findUserIdByEmail(email: string): Promise<string | null> {
  // Look up via profiles table (created by auth trigger)
  const { data } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();
  return data?.id ?? null;
}

async function ensureUser(email: string, password: string, fullName: string): Promise<string> {
  // Check if user already exists
  const existingId = await findUserIdByEmail(email);
  if (existingId) {
    // Update password + metadata so credentials are always Password123!
    await supabase.auth.admin.updateUserById(existingId, {
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    return existingId;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) throw error;
  return data!.user!.id;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   AURIX Client Demo Seed                        ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── 1. Auth users ───────────────────────────────────────────────────────────
  console.log("[1/20] Creating auth users...");
  const adminId   = await ensureUser("admin@aurix.local",   "Password123!", "Aurix Admin");
  const traderId  = await ensureUser("trader@aurix.local",  "Password123!", "Alex Thornton");
  const partnerId = await ensureUser("partner@aurix.local", "Password123!", "Demo Partner");
  // Extra traders assigned to the partner (for partner/traders page)
  const trader2Id = await ensureUser("demo.trader2@aurix.local", "Password123!", "Sofia Reyes");
  const trader3Id = await ensureUser("demo.trader3@aurix.local", "Password123!", "Marcus Webb");
  const trader4Id = await ensureUser("demo.trader4@aurix.local", "Password123!", "Priya Nair");
  console.log(`  admin: ${adminId}`);
  console.log(`  trader (primary): ${traderId}`);
  console.log(`  partner: ${partnerId}`);
  console.log(`  demo traders 2-4 created`);

  // ── 2. Roles & profiles ─────────────────────────────────────────────────────
  console.log("\n[2/20] Setting roles & partner profile...");
  await supabase.from("profiles").update({ role: "SUPER_ADMIN" }).eq("id", adminId);
  await supabase.from("trader_profiles").delete().eq("user_id", adminId);

  await supabase.from("profiles").update({ role: "PARTNER" }).eq("id", partnerId);
  await supabase.from("trader_profiles").delete().eq("user_id", partnerId);

  const referralCode = `DEMO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await supabase
    .from("partner_profiles")
    .upsert(
      { user_id: partnerId, referral_code: referralCode, commission_percent: 30 },
      { onConflict: "user_id" }
    );

  // Primary trader
  await supabase.from("trader_profiles")
    .update({ segment: "FUNDED" })
    .eq("user_id", traderId);

  // Extra demo traders — roles default to TRADER, just ensure trader_profiles exist
  for (const uid of [trader2Id, trader3Id, trader4Id]) {
    // profiles are auto-created by trigger; just ensure role
    await supabase.from("profiles").update({ role: "TRADER" }).eq("id", uid);
  }

  console.log("  Roles set. Referral code:", referralCode);

  // ── 3. Assign partner traders (uses partner_id column) ──────────────────────
  console.log("\n[3/20] Assigning traders to partner...");

  // Primary trader
  await supabase.from("trader_profiles")
    .update({ partner_id: partnerId, partner_assigned_at: daysAgo(20), segment: "FUNDED" })
    .eq("user_id", traderId);

  // Extra traders
  const extraSegments = ["EVALUATION", "EVALUATION", "CHALLENGE"];
  for (const [i, uid] of [trader2Id, trader3Id, trader4Id].entries()) {
    await supabase.from("trader_profiles")
      .update({
        partner_id: partnerId,
        partner_assigned_at: daysAgo(14 - i * 3),
        segment: extraSegments[i],
      })
      .eq("user_id", uid);
  }
  console.log("  4 traders assigned to partner");

  // ── 4. Trading accounts ─────────────────────────────────────────────────────
  console.log("\n[4/20] Creating trading accounts...");
  await supabase.from("trading_accounts").delete().eq("user_id", traderId);
  await supabase.from("trading_accounts").delete().eq("user_id", trader2Id);
  await supabase.from("trading_accounts").delete().eq("user_id", trader3Id);
  await supabase.from("trading_accounts").delete().eq("user_id", trader4Id);

  const { data: apexAcct, error: apexErr } = await supabase
    .from("trading_accounts")
    .insert({ user_id: traderId, account_name: "Apex Funded 100K", broker_name: "MetaTrader 5 Demo", broker_account_id: "MT5-APEX-001", status: "CONNECTED", currency: "USD", initial_balance: 100000 })
    .select("id").single();
  if (apexErr) throw apexErr;
  const apexId = apexAcct!.id as string;

  const { data: evalAcct, error: evalErr } = await supabase
    .from("trading_accounts")
    .insert({ user_id: traderId, account_name: "Evaluation Demo 50K", broker_name: "MetaTrader 5 Demo", broker_account_id: "MT5-EVAL-002", status: "CONNECTED", currency: "USD", initial_balance: 50000 })
    .select("id").single();
  if (evalErr) throw evalErr;
  const evalAcctId = evalAcct!.id as string;

  // Extra trader accounts
  const { data: acct2 } = await supabase
    .from("trading_accounts")
    .insert({ user_id: trader2Id, account_name: "Evaluation 25K", broker_name: "MetaTrader 5 Demo", broker_account_id: "MT5-SR-001", status: "CONNECTED", currency: "USD", initial_balance: 25000 })
    .select("id").single();
  const acct2Id = acct2!.id as string;

  const { data: acct3 } = await supabase
    .from("trading_accounts")
    .insert({ user_id: trader3Id, account_name: "Challenge 50K", broker_name: "MetaTrader 5 Demo", broker_account_id: "MT5-MW-001", status: "CONNECTED", currency: "USD", initial_balance: 50000 })
    .select("id").single();
  const acct3Id = acct3!.id as string;

  const { data: acct4 } = await supabase
    .from("trading_accounts")
    .insert({ user_id: trader4Id, account_name: "Challenge 10K", broker_name: "MetaTrader 5 Demo", broker_account_id: "MT5-PN-001", status: "RESTRICTED", currency: "USD", initial_balance: 10000 })
    .select("id").single();
  const acct4Id = acct4!.id as string;

  console.log(`  Accounts: apex=${apexId}, eval=${evalAcctId}, +3 extra`);

  // ── 5. Account snapshots ────────────────────────────────────────────────────
  console.log("\n[5/20] Seeding account snapshots...");

  const apexSnapshots = Array.from({ length: 28 }, (_, i) => {
    const drift = i * 95;
    const pulse = Math.sin(i / 2.3) * 640 - (i > 20 ? (i - 20) * 180 : 0);
    const balance = 100000 + drift;
    const equity = balance + pulse;
    return { trading_account_id: apexId, balance: Number(balance.toFixed(2)), equity: Number(equity.toFixed(2)), floating_pnl: Number(pulse.toFixed(2)), drawdown_percent: pulse < 0 ? Number(Math.abs((pulse / balance) * 100).toFixed(2)) : 0, captured_at: hoursAgo((27 - i) * 6) };
  });
  await supabase.from("account_snapshots").insert(apexSnapshots);

  const evalSnapshots = Array.from({ length: 30 }, (_, i) => {
    const balance = 50000 + i * 180;
    const equity = balance + Math.sin(i * 0.8) * 300;
    return { trading_account_id: evalAcctId, balance: Number(balance.toFixed(2)), equity: Number(equity.toFixed(2)), floating_pnl: Number((equity - balance).toFixed(2)), drawdown_percent: 0, captured_at: daysAgo(30 - i) };
  });
  await supabase.from("account_snapshots").insert(evalSnapshots);

  // Extra trader snapshots (recent only — enough for the overview card)
  for (const [acctId, base, direction] of [[acct2Id, 25000, 1], [acct3Id, 50000, 1], [acct4Id, 10000, -1]] as [string, number, number][]) {
    const snaps = Array.from({ length: 14 }, (_, i) => {
      const balance = base + i * 40 * direction;
      const equity = balance + Math.sin(i * 0.9) * 200 * direction;
      return { trading_account_id: acctId, balance: Number(balance.toFixed(2)), equity: Number(equity.toFixed(2)), floating_pnl: Number((equity - balance).toFixed(2)), drawdown_percent: direction < 0 ? Number((Math.abs((equity - base) / base) * 100).toFixed(2)) : 0, captured_at: hoursAgo((13 - i) * 12) };
    });
    await supabase.from("account_snapshots").insert(snaps);
  }
  console.log("  Snapshots seeded for all accounts");

  // ── 6. Trades ───────────────────────────────────────────────────────────────
  console.log("\n[6/20] Seeding trades...");
  const symbols = ["EURUSD", "XAUUSD", "GBPJPY", "NAS100"];
  const closedTrades = Array.from({ length: 16 }, (_, i) => {
    const profit = i % 3 === 0 ? -(180 + i * 14) : 260 + i * 19;
    return { trading_account_id: apexId, symbol: symbols[i % 4], side: i % 2 === 0 ? "BUY" : "SELL", status: "CLOSED", volume: Number((0.4 + i * 0.05).toFixed(2)), open_price: Number((1.08 + i * 0.004).toFixed(5)), close_price: Number((1.082 + i * 0.004).toFixed(5)), profit: Number(profit.toFixed(2)), currency: "USD", opened_at: hoursAgo(120 - i * 6), closed_at: hoursAgo(116 - i * 6) };
  });
  await supabase.from("trades").insert(closedTrades);
  await supabase.from("trades").insert([
    { trading_account_id: apexId, symbol: "EURUSD", side: "SELL", status: "OPEN", volume: 1.2, open_price: 1.0872, close_price: null, profit: -312, currency: "USD", opened_at: hoursAgo(5) },
    { trading_account_id: apexId, symbol: "XAUUSD", side: "BUY", status: "OPEN", volume: 0.8, open_price: 2341.4, close_price: null, profit: 486, currency: "USD", opened_at: hoursAgo(3) },
  ]);

  const evalTrades = Array.from({ length: 12 }, (_, i) => ({
    trading_account_id: evalAcctId, symbol: ["EURUSD", "XAUUSD", "USDJPY"][i % 3], side: i % 2 === 0 ? "BUY" : "SELL", status: "CLOSED", volume: Number((0.3 + i * 0.03).toFixed(2)), open_price: Number((1.08 + i * 0.003).toFixed(5)), close_price: Number((1.083 + i * 0.003).toFixed(5)), profit: Number((220 + i * 30).toFixed(2)), currency: "USD", opened_at: daysAgo(25 - i * 2), closed_at: daysAgo(24 - i * 2),
  }));
  await supabase.from("trades").insert(evalTrades);

  // Trades for extra partner traders
  for (const [acctId, base, mult] of [[acct2Id, 1.082, 1], [acct3Id, 1.091, 1], [acct4Id, 1.075, -1]] as [string, number, number][]) {
    await supabase.from("trades").insert(Array.from({ length: 8 }, (_, i) => ({
      trading_account_id: acctId, symbol: symbols[i % 4], side: mult > 0 ? "BUY" : "SELL", status: "CLOSED",
      volume: Number((0.2 + i * 0.04).toFixed(2)), open_price: Number((base + i * 0.002).toFixed(5)), close_price: Number((base + i * 0.002 + 0.003 * mult).toFixed(5)),
      profit: Number(((80 + i * 20) * mult).toFixed(2)), currency: "USD", opened_at: daysAgo(10 - i), closed_at: daysAgo(9 - i),
    })));
  }
  console.log("  Trades seeded");

  // ── 7. Risk events + notifications ─────────────────────────────────────────
  console.log("\n[7/20] Seeding risk events and notifications...");
  await supabase.from("risk_events").insert([
    { trading_account_id: apexId, rule_name: "Maximum drawdown", severity: "WARNING", message: "Apex Funded 100K approached the 5% drawdown warning threshold." },
    { trading_account_id: acct4Id, rule_name: "Daily Loss Limit", severity: "CRITICAL", message: "Challenge 10K breached the daily loss limit. Account restricted." },
  ]);
  await supabase.from("notifications").insert([
    { user_id: traderId, title: "Drawdown Warning", message: "Your Apex account approached the 5% drawdown threshold." },
    { user_id: traderId, title: "Evaluation Passed!", message: "Congratulations — you have passed the Funded Trader Challenge." },
  ]);
  console.log("  Risk events and notifications seeded");

  // ── 8. Economic calendar ────────────────────────────────────────────────────
  console.log("\n[8/20] Seeding economic calendar events...");
  await supabase.from("economic_calendar_events").delete().gte("event_time", daysAgo(1));
  await supabase.from("economic_calendar_events").insert([
    { title: "US Non-Farm Payrolls", country_code: "US", currency: "USD", impact: "HIGH", event_time: hoursFromNow(3), forecast: "182K", previous: "175K", source: "BLS" },
    { title: "ECB Interest Rate Decision", country_code: "EU", currency: "EUR", impact: "HIGH", event_time: hoursFromNow(6), forecast: "4.25%", previous: "4.25%", source: "ECB" },
    { title: "UK CPI (YoY)", country_code: "GB", currency: "GBP", impact: "MEDIUM", event_time: hoursFromNow(24), forecast: "2.1%", previous: "2.3%", source: "ONS" },
    { title: "US Initial Jobless Claims", country_code: "US", currency: "USD", impact: "MEDIUM", event_time: daysFromNow(2), forecast: "215K", previous: "218K", source: "DOL" },
    { title: "FOMC Meeting Minutes", country_code: "US", currency: "USD", impact: "HIGH", event_time: daysFromNow(3), forecast: null, previous: null, source: "FED" },
  ]);
  console.log("  Economic calendar seeded");

  // ── 9. Copy Trading ─────────────────────────────────────────────────────────
  console.log("\n[9/20] Seeding copy trading...");
  await supabase.from("copy_global_settings").upsert({ id: true, live_copy_enabled: false, emergency_stop_enabled: false }, { onConflict: "id" });
  await supabase.from("copy_strategies").delete().eq("master_account_id", apexId);
  const { data: strategy } = await supabase
    .from("copy_strategies")
    .insert({ name: "Apex Momentum Strategy", description: "EURUSD/XAUUSD momentum strategy on the 100K funded account. Simulation mode.", master_account_id: apexId, status: "ACTIVE", mode: "SIMULATION", live_enabled: false, max_follower_lot: 2.0, symbol_allowlist: ["EURUSD", "XAUUSD", "NAS100"], created_by: adminId })
    .select("id").single();
  const strategyId = strategy!.id as string;
  await supabase.from("copy_strategy_followers").upsert({
    strategy_id: strategyId,
    follower_account_id: evalAcctId,
    trader_id: traderId,
    status: "ACTIVE",
    copy_enabled: false,
    copy_mode: null,
    scaling_mode: null,
    fixed_lot: null,
    lot_multiplier: null,
    risk_multiplier: null,
    risk_percent: null,
    max_daily_loss_percent: 3,
    engine_status: "PAUSED",
    engine_error: "Copy settings must be saved before demo copying starts.",
    consent_accepted_at: daysAgo(7),
  }, { onConflict: "strategy_id,follower_account_id" });
  console.log(`  Strategy: ${strategyId}`);

  // ── 10. Bot Marketplace ─────────────────────────────────────────────────────
  console.log("\n[10/20] Seeding bot marketplace...");
  await supabase.from("bot_products").delete().in("slug", ["apex-trend-ea", "volatility-scalper-pro", "grid-recovery-bot"]);
  const { data: products } = await supabase
    .from("bot_products")
    .insert([
      { slug: "apex-trend-ea", name: "Apex Trend EA", short_description: "Multi-timeframe trend following EA for EURUSD and XAUUSD.", description: "Fully automated Expert Advisor for institutional-grade trend capture. 3-timeframe confluence with dynamic lot sizing.", features: ["Multi-timeframe analysis", "Dynamic lot sizing", "Integrated drawdown guard", "News filter"], platform: "MT5", status: "PUBLISHED", pricing_label: "Included with Professional plan", difficulty: "INTERMEDIATE", risk_level: "MEDIUM", version: "2.4.1", created_by: adminId },
      { slug: "volatility-scalper-pro", name: "Volatility Scalper Pro", short_description: "High-frequency scalper optimised for volatile sessions.", description: "Capitalises on short-term price inefficiencies during London/New York overlap. Max 0.5% risk per trade.", features: ["Session-aware trading", "Spread filter", "Max 0.5% risk per trade", "Auto break-even"], platform: "MT5", status: "PUBLISHED", pricing_label: "Advanced plan exclusive", difficulty: "ADVANCED", risk_level: "HIGH", version: "1.8.0", created_by: adminId },
      { slug: "grid-recovery-bot", name: "Grid Recovery Bot", short_description: "Grid strategy with intelligent recovery mechanism.", description: "Range-bound strategy for low-volatility periods with smart grid and partial close recovery logic.", features: ["Grid trading", "Partial close recovery", "Range detection", "Capital preservation mode"], platform: "MT5", status: "PUBLISHED", pricing_label: "All plans", difficulty: "BEGINNER", risk_level: "LOW", version: "3.1.0", created_by: adminId },
    ])
    .select("id, slug");

  const apexEA = products!.find((p) => p.slug === "apex-trend-ea")!;
  await supabase.from("bot_access_records").upsert({ product_id: products!.find((p) => p.slug === "volatility-scalper-pro")!.id, user_id: traderId, status: "REQUESTED", source: "REQUEST" }, { onConflict: "product_id,user_id" });
  const { data: activeAccess } = await supabase.from("bot_access_records").upsert({ product_id: apexEA.id, user_id: traderId, status: "ACTIVE", source: "MANUAL", granted_by: adminId, granted_at: daysAgo(10) }, { onConflict: "product_id,user_id" }).select("id").single();
  const licenseKey = `AURIX-APEX-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  await supabase.from("bot_licenses").insert({ product_id: apexEA.id, access_record_id: activeAccess!.id, user_id: traderId, license_key_hash: hashLicenseKey(licenseKey), license_key_last4: licenseKey.slice(-4), mt5_account_number: "MT5-APEX-001", platform: "MT5", status: "ACTIVE", issued_by: adminId });
  console.log("  Marketplace: 3 products, 1 active license, 1 pending request");

  // ── 11. Academy ─────────────────────────────────────────────────────────────
  console.log("\n[11/20] Seeding academy...");
  await supabase.from("academy_courses").delete().in("slug", ["funded-trader-fundamentals"]);
  const { data: course1 } = await supabase
    .from("academy_courses")
    .insert({ slug: "funded-trader-fundamentals", title: "Funded Trader Fundamentals", short_description: "Master the core rules, mindset, and risk protocols required to pass a funded trader evaluation.", description: "A structured 6-lesson programme covering evaluation rules, risk management, trade journaling, and psychological discipline.", difficulty: "BEGINNER", estimated_minutes: 120, status: "PUBLISHED", created_by: adminId })
    .select("id").single();
  const courseId = course1!.id as string;

  const { data: modules } = await supabase.from("academy_modules").insert([
    { course_id: courseId, title: "The Evaluation Rules", description: "Drawdown limits, profit targets, and time requirements.", sort_order: 1, status: "PUBLISHED" },
    { course_id: courseId, title: "Risk Management in Practice", description: "Position sizing, daily risk caps, and trade management.", sort_order: 2, status: "PUBLISHED" },
  ]).select("id, sort_order");

  const mod1 = modules!.find((m) => m.sort_order === 1)!;
  const mod2 = modules!.find((m) => m.sort_order === 2)!;

  const { data: lessons } = await supabase.from("academy_lessons").insert([
    { course_id: courseId, module_id: mod1.id, slug: "understanding-profit-targets", title: "Understanding Profit Targets", summary: "How profit targets are calculated and what counts as a trading day.", lesson_type: "VIDEO", video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", duration_minutes: 18, sort_order: 1, status: "PUBLISHED" },
    { course_id: courseId, module_id: mod1.id, slug: "daily-drawdown-explained", title: "Daily Drawdown Explained", summary: "The difference between balance and equity drawdown — and why it matters.", lesson_type: "VIDEO", video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", duration_minutes: 22, sort_order: 2, status: "PUBLISHED" },
    { course_id: courseId, module_id: mod1.id, slug: "evaluation-faq", title: "Evaluation FAQ & Common Mistakes", summary: "Top reasons traders fail evaluations and how to avoid them.", lesson_type: "TEXT", duration_minutes: 12, sort_order: 3, status: "PUBLISHED", content: "## Common Mistakes\n\n1. Over-trading on day 1\n2. Ignoring daily drawdown\n3. Revenge trading after a loss\n\n## FAQ\n\n**Q: Does holding overnight count?**\nA: Yes — floating losses count toward your daily cap." },
    { course_id: courseId, module_id: mod2.id, slug: "position-sizing-calculator", title: "Position Sizing: The 1% Rule", summary: "How to calculate lot size so you never risk more than 1% per trade.", lesson_type: "VIDEO", video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", duration_minutes: 25, sort_order: 1, status: "PUBLISHED" },
    { course_id: courseId, module_id: mod2.id, slug: "trade-journaling", title: "Trade Journaling for Funded Traders", summary: "Why journaling accelerates your edge and what to track.", lesson_type: "TEXT", duration_minutes: 15, sort_order: 2, status: "PUBLISHED", content: "## What to journal\n\n- Entry reason\n- Risk:reward planned vs actual\n- Emotions before, during, and after\n\nReview weekly." },
    { course_id: courseId, module_id: mod2.id, slug: "psychology-of-funded-trading", title: "The Psychology of Funded Trading", summary: "Managing pressure, avoiding emotional trades, building confidence.", lesson_type: "VIDEO", video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", duration_minutes: 30, sort_order: 3, status: "PUBLISHED" },
  ]).select("id");

  await supabase.from("academy_lesson_progress").insert(
    lessons!.map((l) => ({ user_id: traderId, course_id: courseId, lesson_id: l.id, status: "COMPLETED", watched_seconds: 900, completed_at: daysAgo(5) }))
  );
  await supabase.from("academy_webinars").insert({ course_id: courseId, title: "Live Q&A: Passing Your First Funded Evaluation", description: "Live walkthrough of evaluation rules, common mistakes, and real trade examples.", start_time: daysFromNow(3), end_time: new Date(Date.now() + 3 * 86_400_000 + 60 * 60_000).toISOString(), join_url: "https://meet.example.com/aurix-webinar", status: "SCHEDULED" });
  console.log(`  Academy: course ${courseId}, 6 lessons completed for trader, webinar scheduled`);

  // ── 12. Evaluations ─────────────────────────────────────────────────────────
  console.log("\n[12/20] Seeding evaluation program + PASSED attempt + certificate...");
  await supabase.from("evaluation_programs").delete().in("slug", ["funded-trader-challenge-50k"]);
  const { data: evalProg } = await supabase
    .from("evaluation_programs")
    .insert({ slug: "funded-trader-challenge-50k", name: "Funded Trader Challenge — 50K", description: "Prove your edge on a $50,000 demo account. Hit the profit target within drawdown limits.", required_course_id: courseId, starting_balance: 50000, profit_target_percent: 8, max_daily_drawdown_percent: 5, max_overall_drawdown_percent: 10, minimum_trading_days: 7, duration_days: 30, status: "PUBLISHED", rules: { noteForTrader: "All trades must be closed before midnight server time on the last day." }, created_by: adminId })
    .select("id").single();
  const evalProgId = evalProg!.id as string;

  const passedMetrics = { startingBalance: 50000, currentBalance: 54320, currentEquity: 54320, profitAmount: 4320, profitPercent: 8.64, maxDrawdownPercent: 2.1, maxDailyDrawdownPercent: 1.8, tradingDays: 12, totalTrades: 12, elapsedDays: 12, daysRemaining: 18, snapshotAt: daysAgo(0) };
  const { data: evalAttempt } = await supabase
    .from("evaluation_attempts")
    .upsert({ program_id: evalProgId, user_id: traderId, trading_account_id: evalAcctId, status: "PASSED", starting_balance: 50000, started_at: daysAgo(14), ends_at: daysFromNow(16), passed_at: daysAgo(1), pass_reason: "Profit target met (8.64%) with 12 trading days.", latest_metrics: passedMetrics, last_checked_at: daysAgo(1) }, { onConflict: "program_id,user_id" })
    .select("id").single();
  const attemptId = evalAttempt!.id as string;
  await supabase.from("evaluation_checks").insert({ attempt_id: attemptId, status_before: "ACTIVE", status_after: "PASSED", metrics: passedMetrics, result: "PASSED", reason: "Profit target met (8.64%) with 12 trading days.", source: "SYSTEM" });
  const verificationId = genVerificationId();
  await supabase.from("evaluation_certificates").upsert({ attempt_id: attemptId, user_id: traderId, program_id: evalProgId, verification_id: verificationId, status: "VALID", issued_at: daysAgo(1), metadata: { programName: "Funded Trader Challenge — 50K", startingBalance: 50000, profitPercent: 8.64, tradingDays: 12 } }, { onConflict: "attempt_id" });
  console.log(`  Certificate: ${verificationId}`);

  // ── 13. CRM notes + activities (admin + partner) ────────────────────────────
  console.log("\n[13/20] Seeding CRM notes and activities...");
  const { data: traderTp } = await supabase.from("trader_profiles").select("id").eq("user_id", traderId).maybeSingle();
  const { data: trader2Tp } = await supabase.from("trader_profiles").select("id").eq("user_id", trader2Id).maybeSingle();
  const { data: trader3Tp } = await supabase.from("trader_profiles").select("id").eq("user_id", trader3Id).maybeSingle();
  const { data: trader4Tp } = await supabase.from("trader_profiles").select("id").eq("user_id", trader4Id).maybeSingle();

  if (traderTp) {
    await supabase.from("crm_notes").delete().eq("trader_profile_id", traderTp.id);
    await supabase.from("crm_activities").delete().eq("trader_profile_id", traderTp.id);

    // Admin notes (note_source defaults to 'ADMIN')
    await supabase.from("crm_notes").insert([
      { trader_profile_id: traderTp.id, author_user_id: adminId, author_name: "Aurix Admin", note: "Trader passed 50K evaluation with 8.64% profit and 12 trading days. Exceptional drawdown discipline — never exceeded 2.1%. Recommended for 100K allocation.", created_at: daysAgo(1) },
      { trader_profile_id: traderTp.id, author_user_id: adminId, author_name: "Aurix Admin", note: "Onboarding call completed. Experienced with EURUSD and XAUUSD. Running Apex Trend EA on funded account. Agreed to simulation mode for copy trading.", created_at: daysAgo(10) },
      { trader_profile_id: traderTp.id, author_user_id: adminId, author_name: "Aurix Admin", note: "Risk warning acknowledged — approached 5% drawdown during NFP volatility. Trader self-reported. No breach.", created_at: daysAgo(18) },
    ]);

    // Partner notes (note_source = 'PARTNER')
    await supabase.from("crm_notes").insert([
      { trader_profile_id: traderTp.id, author_user_id: partnerId, author_name: "Demo Partner", note: "Alex is progressing well — passed his first evaluation. Following up to make sure he knows about the 100K allocation process.", note_source: "PARTNER", created_at: daysAgo(1) },
      { trader_profile_id: traderTp.id, author_user_id: partnerId, author_name: "Demo Partner", note: "Introduced Alex to the Apex Trend EA. He activated it on the funded account and is running it in simulation alongside manual trades.", note_source: "PARTNER", created_at: daysAgo(9) },
      { trader_profile_id: traderTp.id, author_user_id: partnerId, author_name: "Demo Partner", note: "Initial onboarding call — Alex came through the referral link from our Discord community. Background in forex for 3 years, mainly swing trading.", note_source: "PARTNER", created_at: daysAgo(20) },
    ]);

    await supabase.from("crm_activities").insert([
      { trader_profile_id: traderTp.id, type: "ONBOARDING", description: "Trader completed platform onboarding and KYC verification.", created_at: daysAgo(20) },
      { trader_profile_id: traderTp.id, type: "EVALUATION_PASSED", description: "Passed Funded Trader Challenge 50K with 8.64% profit over 12 days.", created_at: daysAgo(1) },
      { trader_profile_id: traderTp.id, type: "BOT_ACCESS_GRANTED", description: "Apex Trend EA license issued for MT5-APEX-001.", created_at: daysAgo(10) },
      { trader_profile_id: traderTp.id, type: "COPY_STRATEGY_ENROLLED", description: "Enrolled in Apex Momentum Strategy (simulation mode).", created_at: daysAgo(7) },
      { trader_profile_id: traderTp.id, type: "SUPPORT_CONTACT", description: "Trader contacted support about drawdown calculation — resolved.", created_at: daysAgo(15) },
    ]);
  }

  // Notes + activities for extra partner traders
  const extraTraderData = [
    { tp: trader2Tp, uid: trader2Id, name: "Sofia Reyes", partnerNote: "Sofia joined through the Instagram campaign. She is progressing well on her 25K evaluation. Second week in.", activities: ["ONBOARDING", "Evaluation account funded and connected."] },
    { tp: trader3Tp, uid: trader3Id, name: "Marcus Webb", partnerNote: "Marcus is an experienced trader. He started the 50K challenge last week. Strong risk management so far.", activities: ["ONBOARDING", "Started 50K challenge evaluation."] },
    { tp: trader4Tp, uid: trader4Id, name: "Priya Nair", partnerNote: "Priya hit the daily loss limit on day 3. Spoke to her about position sizing — she is recalibrating. Account is restricted pending admin review.", activities: ["ONBOARDING", "Account restricted — daily loss limit breached on day 3."] },
  ];

  for (const { tp, partnerNote, activities } of extraTraderData) {
    if (!tp) continue;
    await supabase.from("crm_notes").insert([
      { trader_profile_id: tp.id, author_user_id: partnerId, author_name: "Demo Partner", note: partnerNote, note_source: "PARTNER", created_at: daysAgo(2) },
    ]);
    await supabase.from("crm_activities").insert(
      activities.map((desc, i) => ({ trader_profile_id: tp.id, type: i === 0 ? "ONBOARDING" : "NOTE_ADDED", description: desc, created_at: daysAgo(14 - i * 3) }))
    );
  }
  console.log("  CRM notes (admin + partner) and activities seeded for all traders");

  // ── 14. Subscriptions ───────────────────────────────────────────────────────
  console.log("\n[14/20] Seeding subscriptions...");
  if (traderTp) {
    await supabase.from("subscriptions").delete().eq("trader_profile_id", traderTp.id);
    await supabase.from("subscriptions").insert({ trader_profile_id: traderTp.id, plan_name: "Professional", status: "ACTIVE", started_at: daysAgo(30), ends_at: daysFromNow(335) });
  }
  for (const [tp, plan] of [[trader2Tp, "Starter"], [trader3Tp, "Professional"], [trader4Tp, "Starter"]] as [typeof traderTp, string][]) {
    if (tp) {
      await supabase.from("subscriptions").delete().eq("trader_profile_id", tp.id);
      await supabase.from("subscriptions").insert({ trader_profile_id: tp.id, plan_name: plan, status: "ACTIVE", started_at: daysAgo(14), ends_at: daysFromNow(351) });
    }
  }
  console.log("  Subscriptions seeded");

  // ── 15. Risk rules ───────────────────────────────────────────────────────────
  console.log("\n[15/20] Seeding risk rules...");
  await supabase.from("risk_rules").delete().eq("trading_account_id", apexId);
  await supabase.from("risk_rules").insert([
    { trading_account_id: apexId, name: "Daily Loss Limit", severity: "CRITICAL", metric: "DAILY_LOSS", threshold: 5000, enabled: true },
    { trading_account_id: apexId, name: "Daily Drawdown Warning", severity: "WARNING", metric: "DAILY_LOSS", threshold: 3000, enabled: true },
    { trading_account_id: apexId, name: "Max Overall Drawdown", severity: "CRITICAL", metric: "MAX_DRAWDOWN", threshold: 10000, enabled: true },
    { trading_account_id: apexId, name: "Open Trade Limit", severity: "WARNING", metric: "OPEN_TRADES", threshold: 8, enabled: true },
  ]);
  console.log("  Risk rules seeded");

  // ── 16. Daily account metrics ────────────────────────────────────────────────
  console.log("\n[16/20] Seeding daily account metrics...");
  await supabase.from("daily_account_metrics").delete().eq("trading_account_id", apexId);
  const dailyMetrics = Array.from({ length: 30 }, (_, i) => {
    const grossProfit = 400 + Math.sin(i * 0.7) * 280 + i * 8;
    const grossLoss = -(80 + Math.sin(i * 1.1) * 60 + i * 3);
    const netPnl = grossProfit + grossLoss;
    return { trading_account_id: apexId, date: new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10), starting_balance: 100000 + i * 85, ending_balance: 100000 + i * 85 + netPnl, gross_profit: Number(grossProfit.toFixed(2)), gross_loss: Number(grossLoss.toFixed(2)), net_pnl: Number(netPnl.toFixed(2)), trade_count: Math.floor(3 + Math.abs(Math.sin(i)) * 5), winning_trades: Math.floor(2 + Math.abs(Math.sin(i)) * 3), losing_trades: Math.floor(1 + Math.abs(Math.sin(i * 1.3))), max_drawdown: Number((Math.random() * 1.2).toFixed(2)), commission: Number((netPnl * 0.02).toFixed(2)) };
  });
  await supabase.from("daily_account_metrics").insert(dailyMetrics);
  console.log("  30 days of daily account metrics seeded");

  // ── 17. Audit logs ───────────────────────────────────────────────────────────
  console.log("\n[17/20] Seeding audit logs...");
  await supabase.from("audit_logs").insert([
    { actor_user_id: adminId, action: "USER_CREATED", entity_type: "profiles", metadata: { email: "trader@aurix.local", role: "TRADER" }, created_at: daysAgo(20) },
    { actor_user_id: adminId, action: "BOT_ACCESS_GRANTED", entity_type: "bot_access_records", metadata: { product: "Apex Trend EA", trader: "trader@aurix.local" }, created_at: daysAgo(10) },
    { actor_user_id: adminId, action: "EVALUATION_REVIEWED", entity_type: "evaluation_attempts", metadata: { result: "PASSED", trader: "trader@aurix.local" }, created_at: daysAgo(1) },
    { actor_user_id: adminId, action: "TERMINAL_SETTINGS_UPDATED", entity_type: "terminal_provider_settings", metadata: { changes: { provider: "mock", demo_mode: true } }, created_at: daysAgo(5) },
    { actor_user_id: traderId, action: "COPY_STRATEGY_JOINED", entity_type: "copy_strategy_followers", metadata: { strategy: "Apex Momentum Strategy", mode: "SIMULATION" }, created_at: daysAgo(7) },
    { actor_user_id: adminId, action: "RISK_RULE_CREATED", entity_type: "risk_rules", metadata: { rule: "Daily Loss Limit", threshold: 5000 }, created_at: daysAgo(20) },
    { actor_user_id: adminId, action: "SUBSCRIPTION_CREATED", entity_type: "subscriptions", metadata: { plan: "Professional", trader: "trader@aurix.local" }, created_at: daysAgo(30) },
    { actor_user_id: traderId, action: "LESSON_COMPLETED", entity_type: "academy_lesson_progress", metadata: { course: "Funded Trader Fundamentals", lessonsCompleted: 6 }, created_at: daysAgo(5) },
  ]);
  console.log("  Audit logs seeded");

  // ── 18. Partner commissions (rich history) ───────────────────────────────────
  console.log("\n[18/20] Seeding partner commission history...");
  await supabase.from("partner_commissions").delete().eq("partner_id", partnerId);

  // 6 months of PAID history + current PENDING for each trader
  const partnerTraders = [
    { id: traderId, plan: "Professional", gross: 150, pct: 30 },
    { id: trader2Id, plan: "Starter",      gross: 79,  pct: 30 },
    { id: trader3Id, plan: "Professional", gross: 150, pct: 30 },
    { id: trader4Id, plan: "Starter",      gross: 79,  pct: 30 },
  ];

  const commRows = [];
  for (const t of partnerTraders) {
    const commission = Number(((t.gross * t.pct) / 100).toFixed(2));
    // 3 months PAID history
    for (let m = 3; m >= 1; m--) {
      commRows.push({
        partner_id: partnerId, trader_id: t.id, source_type: "SUBSCRIPTION",
        gross_amount: t.gross, commission_percent: t.pct, commission_amount: commission,
        currency: "USD", status: "PAID",
        period_start: new Date(Date.now() - m * 30 * 86_400_000).toISOString().slice(0, 10),
        period_end: new Date(Date.now() - (m - 1) * 30 * 86_400_000).toISOString().slice(0, 10),
        paid_at: new Date(Date.now() - (m - 1) * 30 * 86_400_000 + 5 * 86_400_000).toISOString(),
      });
    }
    // Current PENDING
    commRows.push({
      partner_id: partnerId, trader_id: t.id, source_type: "SUBSCRIPTION",
      gross_amount: t.gross, commission_percent: t.pct, commission_amount: commission,
      currency: "USD", status: "PENDING",
      period_start: daysAgo(1).slice(0, 10),
      period_end: daysFromNow(29).slice(0, 10),
    });
  }
  await supabase.from("partner_commissions").insert(commRows);
  console.log(`  ${commRows.length} commission records seeded for ${partnerTraders.length} traders`);

  // ── 19. Terminal provider settings ──────────────────────────────────────────
  console.log("\n[19/20] Terminal provider settings...");
  const { count } = await supabase.from("terminal_provider_settings").select("id", { count: "exact", head: true });
  if ((count ?? 0) === 0) {
    await supabase.from("terminal_provider_settings").insert({ provider: "mock", is_enabled: true, demo_mode: true, notes: "Demo seed default — set MARKET_DATA_PROVIDER=dxfeed and credentials to enable live data" });
  }
  console.log("  Terminal settings verified");

  // ── 20. User settings ────────────────────────────────────────────────────────
  console.log("\n[20/20] Seeding user settings...");
  for (const uid of [traderId, trader2Id, trader3Id, trader4Id]) {
    await supabase.from("user_settings").upsert({ user_id: uid, notifications_enabled: true, timezone: "UTC" }, { onConflict: "user_id" });
  }
  console.log("  User settings seeded");

  // ── Done ────────────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║   Seed complete!                                                 ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log("║  Admin:   admin@aurix.local          / Password123!             ║");
  console.log("║  Trader:  trader@aurix.local         / Password123!             ║");
  console.log("║  Partner: partner@aurix.local        / Password123!             ║");
  console.log("║  Extras:  demo.trader2-4@aurix.local / Password123!             ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  Referral code:  ${referralCode.padEnd(46)}║`);
  console.log(`║  Certificate:    ${verificationId.padEnd(46)}║`);
  console.log(`║  Verify at:      /certificates/verify/${verificationId.padEnd(27)}║`);
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log("║  Partner pages data:                                             ║");
  console.log("║    /partner          — 4 assigned traders, equity + risk cards   ║");
  console.log("║    /partner/traders  — Alex, Sofia, Marcus, Priya w/ metrics     ║");
  console.log("║    /partner/crm      — 3 partner notes per assigned trader       ║");
  console.log("║    /partner/commissions — 16 records, 3mo history + pending      ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
}

run().catch((err) => {
  console.error("\nSeed failed:", err?.message ?? err);
  process.exit(1);
});
