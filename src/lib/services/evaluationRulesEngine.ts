if (typeof window !== "undefined") {
  throw new Error("[aurix] evaluationRulesEngine is server-only.");
}

import { createAdminClient } from "@/lib/supabase/admin";

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Rules Engine
// Reads real synced trading data — never fakes pass/fail.
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluationMetrics {
  startingBalance: number;
  currentBalance: number;
  currentEquity: number;
  profitAmount: number;
  profitPercent: number;
  maxDrawdownPercent: number;
  maxDailyDrawdownPercent: number;
  tradingDays: number;
  totalTrades: number;
  elapsedDays: number;
  daysRemaining: number;
  snapshotAt: string | null;
}

export interface RulesSnapshot {
  profitTargetPercent: number;
  maxDailyDrawdownPercent: number;
  maxOverallDrawdownPercent: number;
  minimumTradingDays: number;
  durationDays: number;
  startingBalance: number;
}

export interface CheckResult {
  result: "NO_CHANGE" | "PASSED" | "FAILED" | "EXPIRED" | "NEEDS_REVIEW";
  reason: string | null;
  metrics: EvaluationMetrics | null;
  rulesSnapshot: RulesSnapshot;
}

export async function calculateAcademyCompletion(
  userId: string,
  courseId: string
): Promise<{ progressPercent: number; totalLessons: number; completedLessons: number }> {
  const supabase = createAdminClient();
  const [{ data: published }, { data: completed }] = await Promise.all([
    supabase
      .from("academy_lessons")
      .select("id")
      .eq("course_id", courseId)
      .eq("status", "PUBLISHED"),
    supabase
      .from("academy_lesson_progress")
      .select("lesson_id")
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .eq("status", "COMPLETED"),
  ]);
  const total = (published ?? []).length;
  const done = (completed ?? []).length;
  return {
    progressPercent: total > 0 ? Math.round((done / total) * 100) : 0,
    totalLessons: total,
    completedLessons: done,
  };
}

export async function calculateEvaluationMetrics(
  attemptId: string
): Promise<EvaluationMetrics | null> {
  const supabase = createAdminClient();

  const { data: attempt } = await supabase
    .from("evaluation_attempts")
    .select("trading_account_id, starting_balance, started_at, ends_at")
    .eq("id", attemptId)
    .maybeSingle();

  if (!attempt || !attempt.trading_account_id || !attempt.starting_balance) return null;

  const accountId = attempt.trading_account_id as string;
  const startingBalance = Number(attempt.starting_balance);
  const startedAt = attempt.started_at as string | null;
  const endsAt = attempt.ends_at as string | null;

  const [snapshotRes, historyRes, tradesRes] = await Promise.all([
    supabase
      .from("account_snapshots")
      .select("balance, equity, drawdown_percent, captured_at")
      .eq("trading_account_id", accountId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("account_snapshots")
      .select("balance, equity, captured_at")
      .eq("trading_account_id", accountId)
      .gte("captured_at", startedAt ?? new Date(0).toISOString())
      .order("captured_at", { ascending: true })
      .limit(20_000),
    supabase
      .from("trades")
      .select("opened_at, closed_at, status")
      .eq("trading_account_id", accountId)
      .eq("status", "CLOSED"),
  ]);

  const snap = snapshotRes.data;
  const currentBalance = snap ? Number(snap.balance) : startingBalance;
  const currentEquity = snap ? Number(snap.equity) : startingBalance;
  let overallPeakEquity = startingBalance;
  let maxOverallDrawdown = 0;
  let maxDailyDrawdown = 0;
  const dailyPeaks = new Map<string, number>();
  for (const row of historyRes.data ?? []) {
    const equity = Number(row.equity);
    if (!Number.isFinite(equity)) continue;
    overallPeakEquity = Math.max(overallPeakEquity, equity);
    if (overallPeakEquity > 0) {
      maxOverallDrawdown = Math.max(maxOverallDrawdown, ((overallPeakEquity - equity) / overallPeakEquity) * 100);
    }
    const day = String(row.captured_at).slice(0, 10);
    const balance = Number(row.balance);
    const initialPeak = Number.isFinite(balance) ? balance : equity;
    const dailyPeak = Math.max(dailyPeaks.get(day) ?? initialPeak, equity);
    dailyPeaks.set(day, dailyPeak);
    if (dailyPeak > 0) {
      maxDailyDrawdown = Math.max(maxDailyDrawdown, ((dailyPeak - equity) / dailyPeak) * 100);
    }
  }

  // Count distinct calendar days with at least one closed trade since attempt started
  const trades = tradesRes.data ?? [];
  const tradingDays = countTradingDays(trades, startedAt);

  const profitAmount = currentBalance - startingBalance;
  const profitPercent = startingBalance > 0 ? (profitAmount / startingBalance) * 100 : 0;

  const now = new Date();
  const startDate = startedAt ? new Date(startedAt) : now;
  const endDate = endsAt ? new Date(endsAt) : null;
  const elapsedDays = Math.floor((now.getTime() - startDate.getTime()) / 86_400_000);
  const daysRemaining = endDate
    ? Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / 86_400_000))
    : 0;

  return {
    startingBalance,
    currentBalance,
    currentEquity,
    profitAmount,
    profitPercent: Math.round(profitPercent * 100) / 100,
    maxDrawdownPercent: Math.round(maxOverallDrawdown * 100) / 100,
    maxDailyDrawdownPercent: Math.round(maxDailyDrawdown * 100) / 100,
    tradingDays,
    totalTrades: trades.length,
    elapsedDays,
    daysRemaining,
    snapshotAt: snap ? (snap.captured_at as string) : null,
  };
}

function countTradingDays(
  trades: Array<{ opened_at: string; closed_at: string | null; status: string }>,
  startedAt: string | null
): number {
  const startMs = startedAt ? new Date(startedAt).getTime() : 0;
  const days = new Set<string>();
  for (const t of trades) {
    if (t.status !== "CLOSED") continue;
    const closedAt = t.closed_at ? new Date(t.closed_at) : null;
    if (!closedAt) continue;
    if (closedAt.getTime() < startMs) continue;
    days.add(closedAt.toISOString().slice(0, 10));
  }
  return days.size;
}

export async function evaluateAttempt(attemptId: string): Promise<CheckResult> {
  const supabase = createAdminClient();

  const { data: attempt } = await supabase
    .from("evaluation_attempts")
    .select(
      "status, started_at, ends_at, starting_balance, trading_account_id, program_id"
    )
    .eq("id", attemptId)
    .maybeSingle();

  if (!attempt) {
    return {
      result: "NO_CHANGE",
      reason: "Attempt not found",
      metrics: null,
      rulesSnapshot: emptyRules(),
    };
  }

  const { data: program } = await supabase
    .from("evaluation_programs")
    .select(
      "profit_target_percent, max_daily_drawdown_percent, max_overall_drawdown_percent, minimum_trading_days, duration_days, starting_balance"
    )
    .eq("id", attempt.program_id as string)
    .maybeSingle();

  if (!program) {
    return {
      result: "NO_CHANGE",
      reason: "Program not found",
      metrics: null,
      rulesSnapshot: emptyRules(),
    };
  }

  const rules: RulesSnapshot = {
    profitTargetPercent: Number(program.profit_target_percent),
    maxDailyDrawdownPercent: Number(program.max_daily_drawdown_percent),
    maxOverallDrawdownPercent: Number(program.max_overall_drawdown_percent),
    minimumTradingDays: Number(program.minimum_trading_days),
    durationDays: Number(program.duration_days),
    startingBalance: Number(program.starting_balance),
  };

  // NEEDS_REVIEW remains checkable so a delayed provider sync can recover.
  if (!["ACTIVE", "NEEDS_REVIEW"].includes(attempt.status as string)) {
    return { result: "NO_CHANGE", reason: null, metrics: null, rulesSnapshot: rules };
  }

  if (!attempt.trading_account_id) {
    return {
      result: "NEEDS_REVIEW",
      reason: "No demo trading account linked yet",
      metrics: null,
      rulesSnapshot: rules,
    };
  }

  const metrics = await calculateEvaluationMetrics(attemptId);
  if (!metrics) {
    return {
      result: "NEEDS_REVIEW",
      reason: "Unable to calculate metrics — account may not have synced data yet",
      metrics: null,
      rulesSnapshot: rules,
    };
  }

  // Fail conditions (checked first — breach = immediate fail)
  if (metrics.maxDailyDrawdownPercent > rules.maxDailyDrawdownPercent) {
    return {
      result: "FAILED",
      reason: `Daily drawdown limit breached: ${metrics.maxDailyDrawdownPercent.toFixed(2)}% exceeds ${rules.maxDailyDrawdownPercent}%`,
      metrics,
      rulesSnapshot: rules,
    };
  }

  if (metrics.maxDrawdownPercent > rules.maxOverallDrawdownPercent) {
    return {
      result: "FAILED",
      reason: `Overall drawdown limit breached: ${metrics.maxDrawdownPercent.toFixed(2)}% exceeds ${rules.maxOverallDrawdownPercent}%`,
      metrics,
      rulesSnapshot: rules,
    };
  }

  // Pass conditions (all must be met simultaneously)
  const profitMet = metrics.profitPercent >= rules.profitTargetPercent;
  const tradingDaysMet = metrics.tradingDays >= rules.minimumTradingDays;

  if (profitMet && tradingDaysMet) {
    return {
      result: "PASSED",
      reason: `Profit target of ${rules.profitTargetPercent}% reached with ${metrics.tradingDays} trading days`,
      metrics,
      rulesSnapshot: rules,
    };
  }

  const endsAt = attempt.ends_at ? new Date(attempt.ends_at as string) : null;
  if (endsAt && endsAt < new Date()) {
    return {
      result: "EXPIRED",
      reason: "Evaluation period ended before all pass conditions were met",
      metrics,
      rulesSnapshot: rules,
    };
  }

  return { result: "NO_CHANGE", reason: null, metrics, rulesSnapshot: rules };
}

function emptyRules(): RulesSnapshot {
  return {
    profitTargetPercent: 0,
    maxDailyDrawdownPercent: 0,
    maxOverallDrawdownPercent: 0,
    minimumTradingDays: 0,
    durationDays: 0,
    startingBalance: 0,
  };
}
