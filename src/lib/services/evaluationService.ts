if (typeof window !== "undefined") {
  throw new Error("[aurix] evaluationService is server-only.");
}

import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";
import { createNotification } from "@/lib/services/notificationService";
import { issueCertificateForPassedAttempt } from "@/lib/services/certificateService";
import {
  evaluateAttempt,
  calculateAcademyCompletion,
  type CheckResult,
} from "@/lib/services/evaluationRulesEngine";

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluationProgramDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  requiredCourseId: string | null;
  requiredCourseName: string | null;
  startingBalance: number;
  profitTargetPercent: number;
  maxDailyDrawdownPercent: number;
  maxOverallDrawdownPercent: number;
  minimumTradingDays: number;
  durationDays: number;
  demoServerName: string | null;
  demoAccountType: string | null;
  demoLeverage: number;
  demoBrokerKeywords: string[];
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  rules: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationAttemptDto {
  id: string;
  programId: string;
  programName: string;
  programSlug: string;
  userId: string;
  traderName: string | null;
  traderEmail: string | null;
  tradingAccountId: string | null;
  tradingAccountName: string | null;
  status: string;
  startingBalance: number | null;
  startedAt: string | null;
  endsAt: string | null;
  passedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  passReason: string | null;
  failReason: string | null;
  latestMetrics: Record<string, unknown>;
  lastCheckedAt: string | null;
  adminOverrideBy: string | null;
  adminOverrideReason: string | null;
  fundingStatus: "NOT_ELIGIBLE" | "PENDING_REVIEW" | "FUNDED" | "DECLINED";
  fundingNote: string | null;
  provisioningStatus: "NOT_STARTED" | "PROVISIONING" | "CONNECTED" | "ACTION_REQUIRED" | "FAILED";
  provisioningError: string | null;
  programRules: {
    profitTargetPercent: number;
    maxDailyDrawdownPercent: number;
    maxOverallDrawdownPercent: number;
    minimumTradingDays: number;
    durationDays: number;
  } | null;
  createdAt: string;
}

export interface ProgramWithStatusDto extends EvaluationProgramDto {
  attemptStatus: string | null;
  attemptId: string | null;
  isUnlocked: boolean;
  academyProgressPercent: number | null;
}

export interface CreateProgramInput {
  slug: string;
  name: string;
  description?: string;
  requiredCourseId?: string;
  startingBalance: number;
  profitTargetPercent: number;
  maxDailyDrawdownPercent: number;
  maxOverallDrawdownPercent: number;
  minimumTradingDays: number;
  durationDays: number;
  demoServerName?: string;
  demoAccountType?: string;
  demoLeverage?: number;
  demoBrokerKeywords?: string[];
}

export interface UpdateProgramInput {
  name?: string;
  description?: string;
  requiredCourseId?: string | null;
  startingBalance?: number;
  profitTargetPercent?: number;
  maxDailyDrawdownPercent?: number;
  maxOverallDrawdownPercent?: number;
  minimumTradingDays?: number;
  durationDays?: number;
  demoServerName?: string | null;
  demoAccountType?: string | null;
  demoLeverage?: number;
  demoBrokerKeywords?: string[];
  status?: "DRAFT" | "PUBLISHED" | "ARCHIVED";
}

export interface OverrideAttemptInput {
  newStatus: "PASSED" | "FAILED" | "CANCELLED";
  reason: string;
  adminUserId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin — Programs
// ─────────────────────────────────────────────────────────────────────────────

export async function adminListEvaluationPrograms(): Promise<EvaluationProgramDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("evaluation_programs")
    .select("*, academy_courses(title)")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapProgram);
}

export async function adminCreateEvaluationProgram(
  input: CreateProgramInput,
  actorUserId: string
): Promise<EvaluationProgramDto> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("evaluation_programs")
    .insert({
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      required_course_id: input.requiredCourseId ?? null,
      starting_balance: input.startingBalance,
      profit_target_percent: input.profitTargetPercent,
      max_daily_drawdown_percent: input.maxDailyDrawdownPercent,
      max_overall_drawdown_percent: input.maxOverallDrawdownPercent,
      minimum_trading_days: input.minimumTradingDays,
      duration_days: input.durationDays,
      demo_server_name: input.demoServerName?.trim() || null,
      demo_account_type: input.demoAccountType?.trim() || null,
      demo_leverage: input.demoLeverage ?? 100,
      demo_broker_keywords: input.demoBrokerKeywords ?? [],
      created_by: actorUserId,
    })
    .select("*, academy_courses(title)")
    .single();
  if (error) throw new Error(error.message);
  await writeAuditLog({
    actorUserId,
    action: "EVAL_PROGRAM_CREATED",
    entityType: "evaluation_program",
    entityId: (data as Record<string, unknown>).id as string,
    metadata: { slug: input.slug, name: input.name },
  });
  return mapProgram(data as Record<string, unknown>);
}

export async function adminUpdateEvaluationProgram(
  programId: string,
  input: UpdateProgramInput,
  actorUserId: string
): Promise<EvaluationProgramDto> {
  const supabase = createAdminClient();
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if ("requiredCourseId" in input) patch.required_course_id = input.requiredCourseId ?? null;
  if (input.startingBalance !== undefined) patch.starting_balance = input.startingBalance;
  if (input.profitTargetPercent !== undefined) patch.profit_target_percent = input.profitTargetPercent;
  if (input.maxDailyDrawdownPercent !== undefined) patch.max_daily_drawdown_percent = input.maxDailyDrawdownPercent;
  if (input.maxOverallDrawdownPercent !== undefined) patch.max_overall_drawdown_percent = input.maxOverallDrawdownPercent;
  if (input.minimumTradingDays !== undefined) patch.minimum_trading_days = input.minimumTradingDays;
  if (input.durationDays !== undefined) patch.duration_days = input.durationDays;
  if ("demoServerName" in input) patch.demo_server_name = input.demoServerName?.trim() || null;
  if ("demoAccountType" in input) patch.demo_account_type = input.demoAccountType?.trim() || null;
  if (input.demoLeverage !== undefined) patch.demo_leverage = input.demoLeverage;
  if (input.demoBrokerKeywords !== undefined) patch.demo_broker_keywords = input.demoBrokerKeywords;
  if (input.status !== undefined) patch.status = input.status;

  const { data, error } = await supabase
    .from("evaluation_programs")
    .update(patch)
    .eq("id", programId)
    .select("*, academy_courses(title)")
    .single();
  if (error) throw new Error(error.message);
  await writeAuditLog({
    actorUserId,
    action: "EVAL_PROGRAM_UPDATED",
    entityType: "evaluation_program",
    entityId: programId,
    metadata: patch,
  });
  return mapProgram(data as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin — Attempts
// ─────────────────────────────────────────────────────────────────────────────

export async function adminListEvaluationAttempts(
  filters: { programId?: string; status?: string } = {}
): Promise<EvaluationAttemptDto[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from("evaluation_attempts")
    .select(
      "*, evaluation_programs(name, slug, profit_target_percent, max_daily_drawdown_percent, max_overall_drawdown_percent, minimum_trading_days, duration_days), trading_accounts(account_name), profiles!evaluation_attempts_user_id_fkey(full_name, email)"
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (filters.programId) query = query.eq("program_id", filters.programId);
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapAttempt);
}

export async function adminLinkEvaluationAccount(
  attemptId: string,
  tradingAccountId: string,
  actorUserId: string
): Promise<EvaluationAttemptDto> {
  return linkEvaluationAccount({
    attemptId,
    tradingAccountId,
    actorUserId,
  });
}

export async function traderLinkEvaluationAccount(
  attemptId: string,
  tradingAccountId: string,
  traderUserId: string,
): Promise<EvaluationAttemptDto> {
  return linkEvaluationAccount({
    attemptId,
    tradingAccountId,
    actorUserId: traderUserId,
    requiredTraderUserId: traderUserId,
  });
}

async function linkEvaluationAccount(params: {
  attemptId: string;
  tradingAccountId: string;
  actorUserId: string;
  requiredTraderUserId?: string;
}): Promise<EvaluationAttemptDto> {
  const supabase = createAdminClient();

  const [{ data: attempt, error: aErr }, { data: account, error: accErr }] = await Promise.all([
    supabase
      .from("evaluation_attempts")
      .select("id, status, program_id, user_id, trading_account_id")
      .eq("id", params.attemptId)
      .maybeSingle(),
    supabase
      .from("trading_accounts")
      .select("id, user_id, initial_balance, account_name, account_usage, status")
      .eq("id", params.tradingAccountId)
      .maybeSingle(),
  ]);
  if (aErr) throw new Error(aErr.message);
  if (!attempt) throw new Error("Attempt not found");
  if (accErr) throw new Error(accErr.message);
  if (!account) throw new Error("Trading account not found");
  if (params.requiredTraderUserId && attempt.user_id !== params.requiredTraderUserId) {
    throw new Error("Attempt not found");
  }
  if (account.user_id !== attempt.user_id) throw new Error("Evaluation account must belong to this trader.");
  if (!["PENDING", "NEEDS_REVIEW"].includes(attempt.status)) {
    throw new Error("This evaluation has already started or finished.");
  }
  if (account.status !== "CONNECTED") {
    throw new Error("Connect and synchronize the demo account before starting the evaluation.");
  }

  const [
    { data: program },
    { data: otherAttempt },
    { data: snapshot },
    { count: tradeCount },
    { data: publicCopyFollower },
    { data: selfCopyRelationship },
    { data: masterStrategy },
  ] = await Promise.all([
    supabase
      .from("evaluation_programs")
      .select("starting_balance, duration_days")
      .eq("id", attempt.program_id)
      .maybeSingle(),
    supabase
      .from("evaluation_attempts")
      .select("id")
      .eq("trading_account_id", params.tradingAccountId)
      .neq("id", params.attemptId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("account_snapshots")
      .select("balance, equity, captured_at")
      .eq("trading_account_id", params.tradingAccountId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("trading_account_id", params.tradingAccountId),
    supabase
      .from("copy_strategy_followers")
      .select("id")
      .eq("follower_account_id", params.tradingAccountId)
      .in("status", ["PENDING", "ACTIVE", "PAUSED"])
      .limit(1)
      .maybeSingle(),
    supabase
      .from("self_copy_relationships")
      .select("id")
      .or(`source_account_id.eq.${params.tradingAccountId},follower_account_id.eq.${params.tradingAccountId}`)
      .in("status", ["LIVE", "PAUSED"])
      .limit(1)
      .maybeSingle(),
    supabase
      .from("copy_strategies")
      .select("id")
      .eq("master_account_id", params.tradingAccountId)
      .neq("status", "ARCHIVED")
      .limit(1)
      .maybeSingle(),
  ]);
  if (!program) throw new Error("Evaluation program not found.");
  if (otherAttempt) throw new Error("This demo account is already assigned to another evaluation.");
  if (publicCopyFollower || selfCopyRelationship || masterStrategy) {
    throw new Error("Evaluation accounts cannot participate in copy trading.");
  }
  if (!snapshot) {
    throw new Error("Sync the demo account once before starting so its balance can be verified.");
  }
  if ((tradeCount ?? 0) > 0) {
    throw new Error("Use a fresh demo account with no previous trades for this evaluation.");
  }

  const startingBalance = Number(program.starting_balance);
  const syncedBalance = Number(snapshot.balance);
  const balanceTolerance = Math.max(1, startingBalance * 0.001);
  if (!Number.isFinite(syncedBalance) || Math.abs(syncedBalance - startingBalance) > balanceTolerance) {
    throw new Error(
      `Demo balance must be ${startingBalance.toLocaleString()} before the evaluation starts. Synced balance is ${Number.isFinite(syncedBalance) ? syncedBalance.toLocaleString() : "unavailable"}.`,
    );
  }

  const now = new Date();
  const { error: accountUpdateError } = await supabase
    .from("trading_accounts")
    .update({
      account_usage: "EVALUATION",
      initial_balance: startingBalance,
    })
    .eq("id", params.tradingAccountId);
  if (accountUpdateError) throw new Error(accountUpdateError.message);

  const { data, error } = await supabase
    .from("evaluation_attempts")
    .update({
      trading_account_id: params.tradingAccountId,
      starting_balance: startingBalance,
      status: "ACTIVE",
      provisioning_status: "CONNECTED",
      provisioning_error: null,
      started_at: now.toISOString(),
      ends_at: new Date(now.getTime() + Number(program.duration_days ?? 14) * 86_400_000).toISOString(),
    })
    .eq("id", params.attemptId)
    .select("*, evaluation_programs(name, slug), trading_accounts(account_name), profiles!evaluation_attempts_user_id_fkey(full_name, email)")
    .single();
  if (error) throw new Error(error.message);
  await createNotification({
    userId: attempt.user_id,
    accountId: params.tradingAccountId,
    type: "EVAL_REVIEW",
    title: "Evaluation tracking started",
    message: "Your demo account passed the pre-checks. The evaluation timer and automated tracking are now active.",
  });
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "EVAL_ACCOUNT_LINKED",
    entityType: "evaluation_attempt",
    entityId: params.attemptId,
    metadata: {
      tradingAccountId: params.tradingAccountId,
      verifiedStartingBalance: startingBalance,
      accountWasMarkedForEvaluation: account.account_usage !== "EVALUATION",
    },
  });
  return mapAttempt(data as Record<string, unknown>);
}

export async function adminRunEvaluationCheck(
  attemptId: string,
  actorUserId: string | null
): Promise<{ result: CheckResult; attempt: EvaluationAttemptDto }> {
  const checkResult = await evaluateAttempt(attemptId);
  const supabase = createAdminClient();

  const { data: current } = await supabase
    .from("evaluation_attempts")
    .select("status, user_id")
    .eq("id", attemptId)
    .maybeSingle();

  const statusBefore = (current as Record<string, unknown> | null)?.status as string | null;
  const userId = (current as Record<string, unknown> | null)?.user_id as string | null;

  const patch: Record<string, unknown> = { last_checked_at: new Date().toISOString() };
  if (checkResult.metrics) {
    patch.latest_metrics = checkResult.metrics;
  }

  let statusAfter = statusBefore;
  if (checkResult.result === "PASSED") {
    patch.status = "PASSED";
    patch.passed_at = new Date().toISOString();
    patch.pass_reason = checkResult.reason;
    patch.funding_status = "PENDING_REVIEW";
    statusAfter = "PASSED";
  } else if (checkResult.result === "FAILED") {
    patch.status = "FAILED";
    patch.failed_at = new Date().toISOString();
    patch.fail_reason = checkResult.reason;
    statusAfter = "FAILED";
  } else if (checkResult.result === "EXPIRED") {
    patch.status = "EXPIRED";
    patch.failed_at = new Date().toISOString();
    patch.fail_reason = checkResult.reason;
    statusAfter = "EXPIRED";
  } else if (checkResult.result === "NEEDS_REVIEW") {
    patch.status = "NEEDS_REVIEW";
    statusAfter = "NEEDS_REVIEW";
  }

  const [{ data: updated, error: uErr }] = await Promise.all([
    supabase
      .from("evaluation_attempts")
      .update(patch)
      .eq("id", attemptId)
      .select("*, evaluation_programs(name, slug), trading_accounts(account_name), profiles!evaluation_attempts_user_id_fkey(full_name, email)")
      .single(),
    supabase.from("evaluation_checks").insert({
      attempt_id: attemptId,
      status_before: statusBefore,
      status_after: statusAfter,
      metrics: checkResult.metrics ?? {},
      result: checkResult.result,
      reason: checkResult.reason,
      checked_by: actorUserId,
      source: actorUserId ? "ADMIN" : "WORKER",
    }),
  ]);
  if (uErr) throw new Error(uErr.message);

  // Notify trader
  if (userId && (checkResult.result === "PASSED" || checkResult.result === "FAILED")) {
    await createNotification({
      userId,
      type: checkResult.result === "PASSED" ? "EVAL_PASSED" : "EVAL_FAILED",
      title: checkResult.result === "PASSED" ? "Evaluation Passed!" : "Evaluation Failed",
      message: checkResult.reason ?? (checkResult.result === "PASSED" ? "Congratulations on passing your evaluation!" : "Your evaluation did not meet the required conditions."),
    });
  }
  if (checkResult.result === "PASSED" && userId) {
    await issueCertificateForPassedAttempt(attemptId, actorUserId).catch((error) => {
      if (!(error instanceof Error) || error.message !== "CERTIFICATE_ALREADY_EXISTS") throw error;
    });
    const { data: admins } = await supabase
      .from("profiles")
      .select("id")
      .in("role", ["ADMIN", "SUPER_ADMIN"])
      .eq("status", "ACTIVE");
    await Promise.all((admins ?? []).map((admin) => createNotification({
      userId: admin.id,
      type: "EVAL_REVIEW",
      title: "Evaluation passed — funding review",
      message: "A trader passed an evaluation and is ready for a funding decision.",
    })));
  }

  await writeAuditLog({
    actorUserId,
    action: "EVAL_ATTEMPT_CHECKED",
    entityType: "evaluation_attempt",
    entityId: attemptId,
    metadata: { result: checkResult.result, reason: checkResult.reason },
  });

  return { result: checkResult, attempt: mapAttempt(updated as Record<string, unknown>) };
}

export async function adminOverrideEvaluationAttempt(
  attemptId: string,
  input: OverrideAttemptInput
): Promise<EvaluationAttemptDto> {
  if (!input.reason || input.reason.trim().length < 5) {
    throw new Error("Override reason is required (min 5 characters)");
  }
  const supabase = createAdminClient();

  const { data: current } = await supabase
    .from("evaluation_attempts")
    .select("status, user_id")
    .eq("id", attemptId)
    .maybeSingle();

  const statusBefore = (current as Record<string, unknown> | null)?.status as string | null;
  const userId = (current as Record<string, unknown> | null)?.user_id as string | null;

  const patch: Record<string, unknown> = {
    status: input.newStatus,
    admin_override_by: input.adminUserId,
    admin_override_reason: input.reason,
  };
  const now = new Date().toISOString();
  if (input.newStatus === "PASSED") {
    patch.passed_at = now;
    patch.pass_reason = input.reason;
    patch.funding_status = "PENDING_REVIEW";
  }
  if (input.newStatus === "FAILED") { patch.failed_at = now; patch.fail_reason = input.reason; }
  if (input.newStatus === "CANCELLED") { patch.cancelled_at = now; }

  const [{ data, error }, { error: cErr }] = await Promise.all([
    supabase
      .from("evaluation_attempts")
      .update(patch)
      .eq("id", attemptId)
      .select("*, evaluation_programs(name, slug), trading_accounts(account_name), profiles!evaluation_attempts_user_id_fkey(full_name, email)")
      .single(),
    supabase.from("evaluation_checks").insert({
      attempt_id: attemptId,
      status_before: statusBefore,
      status_after: input.newStatus,
      metrics: {},
      result: input.newStatus === "PASSED" ? "PASSED" : "FAILED",
      reason: input.reason,
      checked_by: input.adminUserId,
      source: "ADMIN",
    }),
  ]);
  if (error) throw new Error(error.message);
  if (cErr) throw new Error(cErr.message);

  if (userId && input.newStatus !== "CANCELLED") {
    await createNotification({
      userId,
      type: input.newStatus === "PASSED" ? "EVAL_PASSED" : "EVAL_FAILED",
      title: input.newStatus === "PASSED" ? "Evaluation Passed (Admin Review)" : "Evaluation Failed (Admin Review)",
      message: input.reason,
    });
  }
  if (userId && input.newStatus === "PASSED") {
    await issueCertificateForPassedAttempt(attemptId, input.adminUserId).catch((error) => {
      if (!(error instanceof Error) || error.message !== "CERTIFICATE_ALREADY_EXISTS") throw error;
    });
  }

  await writeAuditLog({
    actorUserId: input.adminUserId,
    action: "EVAL_ATTEMPT_OVERRIDDEN",
    entityType: "evaluation_attempt",
    entityId: attemptId,
    metadata: { newStatus: input.newStatus, reason: input.reason },
  });

  return mapAttempt(data as Record<string, unknown>);
}

export async function adminUpdateEvaluationFunding(
  attemptId: string,
  input: { status: "PENDING_REVIEW" | "FUNDED" | "DECLINED"; note?: string | null },
  actorUserId: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { data: attempt } = await supabase
    .from("evaluation_attempts")
    .select("id, user_id, status")
    .eq("id", attemptId)
    .maybeSingle();
  if (!attempt) throw new Error("Attempt not found.");
  if (attempt.status !== "PASSED") throw new Error("Only a passed evaluation can receive a funding decision.");

  const { error } = await supabase.from("evaluation_attempts").update({
    funding_status: input.status,
    funding_note: input.note?.trim() || null,
    funding_reviewed_at: new Date().toISOString(),
    funding_reviewed_by: actorUserId,
  }).eq("id", attemptId);
  if (error) throw new Error(error.message);

  if (input.status === "FUNDED") {
    await supabase.from("trader_profiles").upsert({
      user_id: attempt.user_id,
      segment: "FUNDED",
    }, { onConflict: "user_id" });
  }
  await createNotification({
    userId: attempt.user_id,
    type: "EVAL_REVIEW",
    title: input.status === "FUNDED" ? "Funded status approved" : input.status === "DECLINED" ? "Funding review completed" : "Funding review pending",
    message: input.note?.trim() || (
      input.status === "FUNDED"
        ? "Your passed evaluation has been approved for funded status."
        : input.status === "DECLINED"
          ? "Your funding review was not approved. Contact support for details."
          : "Your passed evaluation is queued for funding review."
    ),
  });
  await writeAuditLog({
    actorUserId,
    action: "EVAL_ATTEMPT_OVERRIDDEN",
    entityType: "evaluation_attempt",
    entityId: attemptId,
    metadata: { fundingStatus: input.status, note: input.note ?? null },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Trader
// ─────────────────────────────────────────────────────────────────────────────

export async function listAvailableEvaluationPrograms(
  userId: string
): Promise<ProgramWithStatusDto[]> {
  const supabase = createAdminClient();
  const [programsRes, attemptsRes] = await Promise.all([
    supabase
      .from("evaluation_programs")
      .select("*, academy_courses(title)")
      .eq("status", "PUBLISHED")
      .order("created_at", { ascending: false }),
    supabase
      .from("evaluation_attempts")
      .select("id, program_id, status")
      .eq("user_id", userId),
  ]);
  if (programsRes.error) throw new Error(programsRes.error.message);

  const attemptMap = new Map<string, { id: string; status: string }>();
  for (const a of attemptsRes.data ?? []) {
    const r = a as Record<string, unknown>;
    attemptMap.set(r.program_id as string, { id: r.id as string, status: r.status as string });
  }

  const results: ProgramWithStatusDto[] = [];
  for (const raw of programsRes.data ?? []) {
    const prog = mapProgram(raw as Record<string, unknown>);
    const attempt = attemptMap.get(prog.id) ?? null;

    let academyProgressPercent: number | null = null;
    let isUnlocked = true;

    if (prog.requiredCourseId) {
      const progress = await calculateAcademyCompletion(userId, prog.requiredCourseId);
      academyProgressPercent = progress.progressPercent;
      isUnlocked = progress.progressPercent >= 100;
    }

    results.push({
      ...prog,
      attemptStatus: attempt?.status ?? null,
      attemptId: attempt?.id ?? null,
      isUnlocked,
      academyProgressPercent,
    });
  }
  return results;
}

export async function canStartEvaluation(
  userId: string,
  programId: string
): Promise<{ canStart: boolean; reason?: string }> {
  const supabase = createAdminClient();

  const { data: program } = await supabase
    .from("evaluation_programs")
    .select("id, status, required_course_id")
    .eq("id", programId)
    .maybeSingle();

  if (!program) return { canStart: false, reason: "PROGRAM_NOT_FOUND" };
  const p = program as Record<string, unknown>;
  if (p.status !== "PUBLISHED") return { canStart: false, reason: "PROGRAM_NOT_PUBLISHED" };

  // Check for existing attempt
  const { data: existing } = await supabase
    .from("evaluation_attempts")
    .select("id, status")
    .eq("program_id", programId)
    .eq("user_id", userId)
    .maybeSingle();

  if (existing) return { canStart: false, reason: "ATTEMPT_ALREADY_EXISTS" };

  // Check academy unlock
  if (p.required_course_id) {
    const progress = await calculateAcademyCompletion(userId, p.required_course_id as string);
    if (progress.progressPercent < 100) {
      return { canStart: false, reason: "ACADEMY_NOT_COMPLETED" };
    }
  }

  return { canStart: true };
}

export async function startEvaluationAttempt(
  userId: string,
  programId: string
): Promise<EvaluationAttemptDto> {
  const { canStart, reason } = await canStartEvaluation(userId, programId);
  if (!canStart) throw new Error(reason ?? "Cannot start evaluation");

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("evaluation_attempts")
    .insert({
      program_id: programId,
      user_id: userId,
      status: "PENDING",
      provisioning_status: "ACTION_REQUIRED",
      provisioning_error: "Create a fresh demo account, connect it under Accounts, then select it here to start tracking.",
    })
    .select("*, evaluation_programs(name, slug, starting_balance, demo_server_name, demo_account_type, demo_leverage, demo_broker_keywords), trading_accounts(account_name), profiles!evaluation_attempts_user_id_fkey(full_name, email)")
    .single();
  if (error) throw new Error(error.message);

  await writeAuditLog({
    actorUserId: userId,
    action: "EVAL_ATTEMPT_STARTED",
    entityType: "evaluation_attempt",
    entityId: (data as Record<string, unknown>).id as string,
    metadata: { programId },
  });

  const row = data as Record<string, unknown>;
  const program = row.evaluation_programs as Record<string, unknown>;
  await createNotification({
    userId,
    type: "EVAL_REVIEW",
    title: "Evaluation unlocked — connect your demo account",
    message: `${String(program.name)} is ready. Create a fresh demo account with a ${Number(program.starting_balance).toLocaleString()} starting balance, connect it under Accounts, then attach it to your evaluation.`,
  });
  return mapAttempt(data as Record<string, unknown>);
}

export async function autoStartEligibleEvaluationsForCourse(
  userId: string,
  courseId: string,
): Promise<number> {
  const completion = await calculateAcademyCompletion(userId, courseId);
  if (completion.progressPercent < 100) return 0;
  const supabase = createAdminClient();
  const { data: programs } = await supabase
    .from("evaluation_programs")
    .select("id")
    .eq("required_course_id", courseId)
    .eq("status", "PUBLISHED");
  let started = 0;
  for (const program of programs ?? []) {
    const eligibility = await canStartEvaluation(userId, program.id);
    if (!eligibility.canStart) continue;
    await startEvaluationAttempt(userId, program.id);
    started++;
  }
  return started;
}

export async function getMyEvaluationAttempts(userId: string): Promise<EvaluationAttemptDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("evaluation_attempts")
    .select("*, evaluation_programs(name, slug), trading_accounts(account_name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapAttempt(r as Record<string, unknown>));
}

export async function getMyEvaluationAttemptDetail(
  userId: string,
  attemptId: string
): Promise<EvaluationAttemptDto | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("evaluation_attempts")
    .select("*, evaluation_programs(name, slug, profit_target_percent, max_daily_drawdown_percent, max_overall_drawdown_percent, minimum_trading_days, duration_days, starting_balance), trading_accounts(account_name)")
    .eq("id", attemptId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return mapAttempt(data as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin — analytics
// ─────────────────────────────────────────────────────────────────────────────

export async function adminGetEvaluationAnalytics(): Promise<Record<string, unknown>> {
  const supabase = createAdminClient();
  const [programs, attempts, certs] = await Promise.all([
    supabase.from("evaluation_programs").select("id, status", { count: "exact" }),
    supabase.from("evaluation_attempts").select("id, status", { count: "exact" }),
    supabase.from("evaluation_certificates").select("id, status", { count: "exact" }),
  ]);

  const attemptsByStatus: Record<string, number> = {};
  for (const a of attempts.data ?? []) {
    const s = (a as Record<string, unknown>).status as string;
    attemptsByStatus[s] = (attemptsByStatus[s] ?? 0) + 1;
  }

  return {
    totalPrograms: programs.count ?? 0,
    publishedPrograms: (programs.data ?? []).filter((p) => (p as Record<string, unknown>).status === "PUBLISHED").length,
    totalAttempts: attempts.count ?? 0,
    attemptsByStatus,
    totalCertificates: certs.count ?? 0,
    validCertificates: (certs.data ?? []).filter((c) => (c as Record<string, unknown>).status === "VALID").length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────────────────────────────────────

function mapProgram(r: Record<string, unknown>): EvaluationProgramDto {
  const course = r.academy_courses as Record<string, unknown> | null;
  return {
    id: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    requiredCourseId: (r.required_course_id as string | null) ?? null,
    requiredCourseName: course ? (course.title as string) : null,
    startingBalance: Number(r.starting_balance),
    profitTargetPercent: Number(r.profit_target_percent),
    maxDailyDrawdownPercent: Number(r.max_daily_drawdown_percent),
    maxOverallDrawdownPercent: Number(r.max_overall_drawdown_percent),
    minimumTradingDays: Number(r.minimum_trading_days),
    durationDays: Number(r.duration_days),
    demoServerName: (r.demo_server_name as string | null) ?? null,
    demoAccountType: (r.demo_account_type as string | null) ?? null,
    demoLeverage: Number(r.demo_leverage ?? 100),
    demoBrokerKeywords: (r.demo_broker_keywords as string[] | null) ?? [],
    status: r.status as EvaluationProgramDto["status"],
    rules: (r.rules as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapAttempt(r: Record<string, unknown>): EvaluationAttemptDto {
  const prog = r.evaluation_programs as Record<string, unknown> | null;
  const acct = r.trading_accounts as Record<string, unknown> | null;
  const profile = r.profiles as Record<string, unknown> | null;
  return {
    id: r.id as string,
    programId: r.program_id as string,
    programName: prog ? (prog.name as string) : "",
    programSlug: prog ? (prog.slug as string) : "",
    userId: r.user_id as string,
    traderName: (profile?.full_name as string | null) ?? null,
    traderEmail: (profile?.email as string | null) ?? null,
    tradingAccountId: (r.trading_account_id as string | null) ?? null,
    tradingAccountName: acct ? (acct.account_name as string) : null,
    status: r.status as string,
    startingBalance: r.starting_balance != null
      ? Number(r.starting_balance)
      : prog?.starting_balance != null
        ? Number(prog.starting_balance)
        : null,
    startedAt: (r.started_at as string | null) ?? null,
    endsAt: (r.ends_at as string | null) ?? null,
    passedAt: (r.passed_at as string | null) ?? null,
    failedAt: (r.failed_at as string | null) ?? null,
    cancelledAt: (r.cancelled_at as string | null) ?? null,
    passReason: (r.pass_reason as string | null) ?? null,
    failReason: (r.fail_reason as string | null) ?? null,
    latestMetrics: (r.latest_metrics as Record<string, unknown>) ?? {},
    lastCheckedAt: (r.last_checked_at as string | null) ?? null,
    adminOverrideBy: (r.admin_override_by as string | null) ?? null,
    adminOverrideReason: (r.admin_override_reason as string | null) ?? null,
    fundingStatus: (r.funding_status as EvaluationAttemptDto["fundingStatus"]) ?? "NOT_ELIGIBLE",
    fundingNote: (r.funding_note as string | null) ?? null,
    provisioningStatus: (r.provisioning_status as EvaluationAttemptDto["provisioningStatus"]) ?? "NOT_STARTED",
    provisioningError: (r.provisioning_error as string | null) ?? null,
    programRules: prog && prog.profit_target_percent !== undefined ? {
      profitTargetPercent: Number(prog.profit_target_percent),
      maxDailyDrawdownPercent: Number(prog.max_daily_drawdown_percent),
      maxOverallDrawdownPercent: Number(prog.max_overall_drawdown_percent),
      minimumTradingDays: Number(prog.minimum_trading_days),
      durationDays: Number(prog.duration_days),
    } : null,
    createdAt: r.created_at as string,
  };
}
