import { readFileSync } from "fs";
import { join } from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateReferralCode } from "../src/lib/partner/referral";

/* ─────────────────────────────────────────────────────────────────────────────
 * Comprehensive demo seed — populates trader, admin, and partner workspaces.
 * Idempotent: re-running refreshes demo data without duplicating it.
 * Run: npx tsx scripts/seed-demo-all.ts
 * ───────────────────────────────────────────────────────────────────────────── */

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
const supabase: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const PASSWORD = "Password123!";

// ── User helpers ─────────────────────────────────────────────────────────────
async function findUserIdByEmail(email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    const match = users.find((u) => u.email === email);
    if (match) return match.id;
    if (users.length < 200) break;
  }
  return null;
}

/** Ensure a TRADER user exists (create if missing). Returns its profile id. */
async function ensureTrader(email: string, fullName: string): Promise<string> {
  let id = await findUserIdByEmail(email);
  if (!id) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw error;
    id = data!.user!.id;
  }
  // Ensure profile is an ACTIVE trader with the right name; ensure trader_profile exists.
  await supabase.from("profiles").update({ role: "TRADER", status: "ACTIVE", full_name: fullName }).eq("id", id);
  await supabase.from("trader_profiles").upsert({ user_id: id }, { onConflict: "user_id" });
  return id;
}

async function traderProfileId(userId: string): Promise<string> {
  const { data } = await supabase.from("trader_profiles").select("id").eq("user_id", userId).single();
  return data!.id as string;
}

// ── Account + market data ────────────────────────────────────────────────────
const SYMBOLS = ["EURUSD", "XAUUSD", "GBPJPY", "NAS100", "USDJPY"];

async function seedAccount(
  userId: string,
  opts: { name: string; broker: string; initial: number; status: string; drawdownBias?: number },
): Promise<{ accountId: string; symbols: string[] }> {
  // Fresh: remove the user's existing accounts (cascades snapshots/trades).
  await supabase.from("trading_accounts").delete().eq("user_id", userId);

  const { data: acct, error } = await supabase
    .from("trading_accounts")
    .insert({
      user_id: userId,
      account_name: opts.name,
      broker_name: opts.broker,
      broker_account_id: `MT5-${opts.name.replace(/\s+/g, "").slice(0, 8).toUpperCase()}`,
      status: opts.status,
      currency: "USD",
      initial_balance: opts.initial,
    })
    .select("id")
    .single();
  if (error || !acct) throw error;
  const accountId = acct.id as string;

  // 28 snapshots over 7 days — growth then optional drawdown bias.
  const bias = opts.drawdownBias ?? 0;
  const snapshots = Array.from({ length: 28 }, (_, i) => {
    const drift = i * (opts.initial * 0.001);
    const pulse = Math.sin(i / 2.3) * (opts.initial * 0.006) - (i > 20 ? (i - 20) * bias : 0);
    const balance = opts.initial + drift;
    const equity = balance + pulse;
    return {
      trading_account_id: accountId,
      balance: Number(balance.toFixed(2)),
      equity: Number(equity.toFixed(2)),
      floating_pnl: Number(pulse.toFixed(2)),
      drawdown_percent: pulse < 0 ? Number(Math.abs((pulse / balance) * 100).toFixed(2)) : 0,
      captured_at: hoursAgo((27 - i) * 6),
    };
  });
  await supabase.from("account_snapshots").insert(snapshots);

  // Closed + open trades.
  const closed = Array.from({ length: 10 }, (_, i) => {
    const profit = i % 3 === 0 ? -(140 + i * 12) : 220 + i * 16;
    return {
      trading_account_id: accountId,
      symbol: SYMBOLS[i % SYMBOLS.length],
      side: i % 2 === 0 ? "BUY" : "SELL",
      status: "CLOSED",
      volume: Number((0.4 + i * 0.05).toFixed(2)),
      open_price: Number((1.08 + i * 0.004).toFixed(5)),
      close_price: Number((1.082 + i * 0.004).toFixed(5)),
      profit: Number(profit.toFixed(2)),
      currency: "USD",
      opened_at: hoursAgo(120 - i * 6),
      closed_at: hoursAgo(116 - i * 6),
    };
  });
  const open = [
    { sym: "EURUSD", side: "SELL", vol: 1.2, price: 1.0872, profit: -260 },
    { sym: "XAUUSD", side: "BUY", vol: 0.8, price: 2341.4, profit: 412 },
  ].map((o, i) => ({
    trading_account_id: accountId,
    symbol: o.sym,
    side: o.side,
    status: "OPEN",
    volume: o.vol,
    open_price: o.price,
    close_price: null,
    profit: o.profit,
    currency: "USD",
    opened_at: hoursAgo(5 - i),
    closed_at: null,
  }));
  if (opts.status === "CONNECTED") await supabase.from("trades").insert([...closed, ...open]);

  const usedSymbols = [...new Set([...closed.map((c) => c.symbol), ...open.map((o) => o.symbol)])];
  return { accountId, symbols: usedSymbols };
}

async function run() {
  console.log("Seeding demo data for all workspaces…\n");

  // 1. Core users.
  const adminId = await findUserIdByEmail("admin@aurix.local");
  if (!adminId) throw new Error("admin@aurix.local not found — run scripts/reset-users.ts first.");
  await supabase.from("profiles").update({ role: "SUPER_ADMIN" }).eq("id", adminId);

  const partnerId = await findUserIdByEmail("partner@aurix.local");
  if (!partnerId) throw new Error("partner@aurix.local not found — run scripts/seed-partner-demo.ts first.");
  await supabase.from("profiles").update({ role: "PARTNER", status: "ACTIVE" }).eq("id", partnerId);
  await supabase.from("trader_profiles").delete().eq("user_id", partnerId);
  const referral = generateReferralCode("Demo Partner");
  await supabase.from("partner_profiles").upsert(
    { user_id: partnerId, referral_code: referral, commission_percent: 30 },
    { onConflict: "user_id" },
  );

  // 2. Traders (primary + extras for fuller admin/partner lists).
  const t1 = await ensureTrader("trader@aurix.local", "Demo Trader");
  const t2 = await ensureTrader("layla@aurix.local", "Layla Ahmed");
  const t3 = await ensureTrader("marcus@aurix.local", "Marcus Chen");
  console.log("Users ready: admin, partner, 3 traders");

  const a1 = await seedAccount(t1, { name: "Apex Funded 100K", broker: "MetaTrader 5 Demo", initial: 100000, status: "CONNECTED", drawdownBias: 160 });
  const a2 = await seedAccount(t2, { name: "Nova Evaluation 50K", broker: "MetaApi Sandbox", initial: 50000, status: "CONNECTED", drawdownBias: 80 });
  const a3 = await seedAccount(t3, { name: "Helios 25K", broker: "MetaTrader 5 Demo", initial: 25000, status: "CONNECTED" });
  console.log("Accounts + snapshots + trades seeded for 3 traders");

  const tp1 = await traderProfileId(t1);
  const tp2 = await traderProfileId(t2);
  const tp3 = await traderProfileId(t3);

  // 3. Segments.
  await supabase.from("trader_profiles").update({ segment: "FUNDED" }).eq("id", tp1);
  await supabase.from("trader_profiles").update({ segment: "EVALUATION" }).eq("id", tp2);
  await supabase.from("trader_profiles").update({ segment: "AT_RISK" }).eq("id", tp3);

  // 4. Partner attribution — assign two traders to the partner.
  await supabase.from("trader_profiles").update({ partner_id: partnerId, partner_assigned_at: daysAgo(20) }).in("id", [tp1, tp2]);
  console.log("Assigned 2 traders to partner");

  // 5. Platform risk rules (ensure present) + a few events.
  const { count: ruleCount } = await supabase.from("risk_rules").select("id", { count: "exact", head: true }).is("trading_account_id", null);
  if (!ruleCount) {
    await supabase.from("risk_rules").insert([
      { trading_account_id: null, name: "Daily loss limit", severity: "CRITICAL", metric: "DAILY_LOSS", threshold: 2500, enabled: true },
      { trading_account_id: null, name: "Maximum drawdown", severity: "WARNING", metric: "MAX_DRAWDOWN", threshold: 5, enabled: true },
      { trading_account_id: null, name: "Open trade concentration", severity: "INFO", metric: "OPEN_TRADES", threshold: 5, enabled: true },
    ]);
  }
  // Clear demo risk events for these accounts, then insert fresh.
  await supabase.from("risk_events").delete().in("trading_account_id", [a1.accountId, a2.accountId, a3.accountId]);
  await supabase.from("risk_events").insert([
    { trading_account_id: a2.accountId, rule_name: "Maximum drawdown", severity: "WARNING", message: "Nova Evaluation 50K approached the 5% drawdown warning threshold." },
    { trading_account_id: a3.accountId, rule_name: "Daily loss limit", severity: "CRITICAL", message: "Helios 25K breached the daily loss limit." },
  ]);
  console.log("Risk rules + events seeded");

  // 6. Subscriptions (powers /admin/subscriptions + MRR).
  for (const tp of [tp1, tp2, tp3]) await supabase.from("subscriptions").delete().eq("trader_profile_id", tp);
  await supabase.from("subscriptions").insert([
    { trader_profile_id: tp1, plan_name: "Professional", status: "active", started_at: daysAgo(30) },
    { trader_profile_id: tp2, plan_name: "Evaluation", status: "active", started_at: daysAgo(14) },
    { trader_profile_id: tp3, plan_name: "Starter", status: "active", started_at: daysAgo(7) },
  ]);

  // 7. CRM notes (admin) + activities (powers /admin/crm, /admin/traders, partner activity).
  for (const tp of [tp1, tp2, tp3]) {
    await supabase.from("crm_notes").delete().eq("trader_profile_id", tp);
    await supabase.from("crm_activities").delete().eq("trader_profile_id", tp);
  }
  await supabase.from("crm_notes").insert([
    { trader_profile_id: tp1, author_user_id: adminId, author_name: "Admin", note: "Confirmed MT5 broker server and investor password.", note_source: "ADMIN" },
    { trader_profile_id: tp2, author_user_id: adminId, author_name: "Risk Desk", note: "Warned trader about drawdown proximity; advised reduced sizing.", note_source: "ADMIN" },
    { trader_profile_id: tp1, author_user_id: partnerId, author_name: "Demo Partner", note: "Strong consistency this month — candidate for scale-up.", note_source: "PARTNER" },
  ]);
  await supabase.from("crm_activities").insert([
    { trader_profile_id: tp1, type: "ACCOUNT_CONNECTED", description: "Connected Apex Funded 100K account" },
    { trader_profile_id: tp2, type: "RISK_WARNING", description: "Risk warning issued for drawdown proximity" },
    { trader_profile_id: tp3, type: "RISK_BREACH", description: "Daily loss limit breached" },
  ]);
  console.log("CRM notes + activities + subscriptions seeded");

  // 8. Partner commissions (a few across statuses).
  await supabase.from("partner_commissions").delete().eq("partner_id", partnerId);
  await supabase.from("partner_commissions").insert([
    { partner_id: partnerId, trader_id: t1, source_type: "SUBSCRIPTION", gross_amount: 199, commission_percent: 30, commission_amount: 59.7, currency: "USD", status: "PENDING", period_start: daysAgo(30).slice(0, 10), period_end: daysAgo(0).slice(0, 10) },
    { partner_id: partnerId, trader_id: t1, source_type: "SUBSCRIPTION", gross_amount: 199, commission_percent: 30, commission_amount: 59.7, currency: "USD", status: "APPROVED" },
    { partner_id: partnerId, trader_id: t2, source_type: "SUBSCRIPTION", gross_amount: 99, commission_percent: 30, commission_amount: 29.7, currency: "USD", status: "PAID", paid_at: daysAgo(2) },
  ]);
  console.log("Partner commissions seeded");

  // 9. Copy trading: strategy on trader1's account as master, trader3 as follower.
  await supabase.from("copy_strategies").delete().eq("name", "Aurix Momentum (Demo)");
  const { data: strat } = await supabase
    .from("copy_strategies")
    .insert({
      name: "Aurix Momentum (Demo)",
      description: "Demo scalping strategy mirrored from the Apex master account.",
      master_account_id: a1.accountId,
      status: "ACTIVE",
      mode: "SIMULATION",
      live_enabled: false,
      created_by: adminId,
    })
    .select("id")
    .single();
  const strategyId = strat!.id as string;

  await supabase.from("copy_strategy_followers").insert({
    strategy_id: strategyId,
    follower_account_id: a3.accountId,
    trader_id: t3,
    status: "ACTIVE",
    copy_enabled: false,
    copy_mode: null,
    scaling_mode: null,
    fixed_lot: null,
    lot_multiplier: null,
    risk_multiplier: null,
    risk_percent: null,
    engine_status: "PAUSED",
    engine_error: "Copy settings must be saved before demo copying starts.",
    consent_accepted_at: daysAgo(5),
  });

  const eventRows = [
    { type: "OPEN", sym: "EURUSD", side: "BUY", vol: 1.0, price: 1.0855, h: 8 },
    { type: "OPEN", sym: "XAUUSD", side: "BUY", vol: 0.8, price: 2339.2, h: 5 },
    { type: "CLOSE", sym: "EURUSD", side: "BUY", vol: 1.0, price: 1.0871, h: 2 },
  ].map((e, i) => ({
    strategy_id: strategyId,
    master_account_id: a1.accountId,
    event_type: e.type,
    master_trade_id: `demo-${i}`,
    symbol: e.sym,
    side: e.side,
    volume: e.vol,
    open_price: e.price,
    event_time: hoursAgo(e.h),
    dedupe_key: `${strategyId}:demo-${i}:${e.type}`,
    raw_payload: { source: "demo-seed" },
  }));
  const { data: events } = await supabase.from("copy_master_events").insert(eventRows).select("id, event_type, symbol, side");

  // Simulation logs for the follower.
  const logs = (events ?? []).map((ev, i) => ({
    strategy_id: strategyId,
    master_event_id: ev.id,
    follower_account_id: a3.accountId,
    trader_id: t3,
    mode: "SIMULATION",
    action: i === 1 ? "SKIPPED" : ev.event_type,
    status: i === 1 ? "SKIPPED" : "SUCCESS",
    calculated_lot: i === 1 ? 0 : 0.25,
    symbol: ev.symbol,
    side: ev.side,
    error_code: i === 1 ? "COPY_INVALID_LOT" : null,
    error_message: i === 1 ? "Calculated lot below minimum" : null,
  }));
  if (logs.length) await supabase.from("copy_execution_logs").insert(logs);
  console.log("Copy strategy + follower + master events + simulation logs seeded");

  // 10. AI usage logs (powers /admin/ai analytics).
  await supabase.from("ai_usage_logs").delete().eq("user_id", t1);
  await supabase.from("ai_usage_logs").insert(
    Array.from({ length: 8 }, (_, i) => ({
      user_id: t1,
      route: i % 4 === 0 ? "chart-analysis" : "chat",
      model: "gemini-2.5-flash",
      request_type: i % 4 === 0 ? "vision" : "text",
      status: "SUCCESS",
      total_tokens: 400 + i * 35,
      created_at: hoursAgo(i * 2),
    })),
  );
  console.log("AI usage logs seeded");

  // 11. Economic calendar events (powers AI news context + admin calendar).
  await supabase.from("economic_calendar_events").delete().eq("source", "demo-seed");
  await supabase.from("economic_calendar_events").insert([
    { title: "US Non-Farm Payrolls", country_code: "US", currency: "USD", impact: "HIGH", event_time: hoursFromNow(3), forecast: "180K", previous: "175K", source: "demo-seed" },
    { title: "ECB Rate Decision", country_code: "EU", currency: "EUR", impact: "HIGH", event_time: hoursFromNow(26), forecast: "4.25%", previous: "4.25%", source: "demo-seed" },
    { title: "UK CPI y/y", country_code: "GB", currency: "GBP", impact: "MEDIUM", event_time: hoursFromNow(10), forecast: "2.1%", previous: "2.3%", source: "demo-seed" },
    { title: "BoJ Press Conference", country_code: "JP", currency: "JPY", impact: "MEDIUM", event_time: hoursFromNow(40), source: "demo-seed" },
  ]);
  console.log("Economic calendar events seeded");

  // 12. Background jobs history (powers /admin/jobs).
  await supabase.from("background_jobs").delete().eq("locked_by", "demo-seed");
  await supabase.from("background_jobs").insert([
    { type: "SYNC_ACCOUNT", status: "SUCCESS", payload: { accountId: a1.accountId }, result: { status: "CONNECTED", tradesUpserted: 12 }, attempts: 1, locked_by: "demo-seed", started_at: hoursAgo(1), completed_at: hoursAgo(1), created_by: adminId, created_at: hoursAgo(1) },
    { type: "MONITOR_COPY_STRATEGY", status: "SUCCESS", payload: { strategyId }, result: { detected: 3 }, attempts: 1, locked_by: "demo-seed", started_at: hoursAgo(2), completed_at: hoursAgo(2), created_by: adminId, created_at: hoursAgo(2) },
    { type: "SIMULATE_COPY_STRATEGY", status: "SUCCESS", payload: { strategyId }, result: { simulated: 3, success: 2, skipped: 1 }, attempts: 1, locked_by: "demo-seed", started_at: hoursAgo(2), completed_at: hoursAgo(2), created_by: adminId, created_at: hoursAgo(2) },
    { type: "EXECUTE_COPY_EVENT", status: "SKIPPED", payload: { masterEventId: events?.[0]?.id }, last_error_code: "COPY_EXECUTION_NOT_CONFIGURED", last_error_message: "Live copy execution is not enabled.", attempts: 1, locked_by: "demo-seed", completed_at: hoursAgo(3), created_by: adminId, created_at: hoursAgo(3) },
    { type: "SYNC_ALL_CONNECTED_ACCOUNTS", status: "PENDING", payload: {}, attempts: 0, created_by: adminId, created_at: hoursAgo(0) },
  ]);
  console.log("Background jobs seeded");

  // 13. Notifications for the primary trader.
  await supabase.from("notifications").delete().eq("user_id", t1);
  await supabase.from("notifications").insert([
    { user_id: t1, trading_account_id: a1.accountId, type: "SYNC_SUCCESS", title: "Account connected", message: "Apex Funded 100K synced successfully." },
    { user_id: t1, trading_account_id: a1.accountId, type: "RISK_EVENT", title: "Drawdown warning", message: "Account approached the drawdown warning threshold." },
  ]);
  console.log("Notifications seeded");

  console.log("\n✅ Demo seed complete.");
  console.log("Logins (all password " + PASSWORD + "):");
  console.log("  admin@aurix.local · trader@aurix.local · layla@aurix.local · marcus@aurix.local · partner@aurix.local");
}

run().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
