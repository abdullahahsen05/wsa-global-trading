import { createAdminClient } from "@/lib/supabase/admin";
import { createNotification } from "@/lib/services/notificationService";
import { writeAuditLog } from "@/lib/services/auditService";
import {
  calculateWithdrawalBalance,
  MINIMUM_PARTNER_WITHDRAWAL,
  type PartnerWithdrawalBalanceDto,
  type PartnerWithdrawalDto,
  type PartnerWithdrawalIncludedItemDto,
  type PartnerFinancialLedgerDto,
  type PartnerLedgerItemDto,
  type PartnerWithdrawalStatus,
  validateWithdrawalTransition,
} from "@/lib/partner/withdrawals";

type WithdrawalRow = {
  id: string;
  partner_id: string;
  amount: number | string;
  currency: string;
  status: PartnerWithdrawalStatus;
  payout_method: string;
  payout_reference: string;
  requested_note: string | null;
  admin_note: string | null;
  rejection_reason: string | null;
  reviewed_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
  partner?: { full_name?: string | null; email?: string | null } | null;
};

function mapWithdrawal(
  row: WithdrawalRow,
  includedItems?: PartnerWithdrawalIncludedItemDto[],
): PartnerWithdrawalDto {
  return {
    id: row.id,
    partnerId: row.partner_id,
    partnerName: row.partner?.full_name ?? undefined,
    partnerEmail: row.partner?.email ?? undefined,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    payoutMethod: row.payout_method,
    payoutReference: row.payout_reference,
    requestedNote: row.requested_note,
    adminNote: row.admin_note,
    rejectionReason: row.rejection_reason,
    reviewedAt: row.reviewed_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    includedItems,
  };
}

async function getAllocationUsage(partnerId: string, currency: string): Promise<Map<string, number>> {
  const supabase = createAdminClient();
  const { data: requests, error: requestError } = await supabase
    .from("partner_withdrawal_requests")
    .select("id")
    .eq("partner_id", partnerId)
    .eq("currency", currency)
    .in("status", ["PENDING_REVIEW", "APPROVED", "PAID"]);
  if (requestError) throw new Error(`Failed to load withdrawal reservations: ${requestError.message}`);
  const requestIds = (requests ?? []).map((row) => row.id);
  const used = new Map<string, number>();
  if (requestIds.length === 0) return used;

  const { data: allocations, error } = await supabase
    .from("partner_withdrawal_allocations")
    .select("commission_id, allocated_amount")
    .in("withdrawal_request_id", requestIds);
  if (error) throw new Error(`Failed to load withdrawal allocations: ${error.message}`);
  for (const allocation of allocations ?? []) {
    used.set(
      allocation.commission_id,
      (used.get(allocation.commission_id) ?? 0) + Number(allocation.allocated_amount),
    );
  }
  return used;
}

async function getRebateAllocationUsage(partnerId: string, currency: string): Promise<Map<string, number>> {
  const supabase = createAdminClient();
  const { data: requests, error: requestError } = await supabase
    .from("partner_withdrawal_requests")
    .select("id")
    .eq("partner_id", partnerId)
    .eq("currency", currency)
    .in("status", ["PENDING_REVIEW", "APPROVED", "PAID"]);
  if (requestError) throw new Error(`Failed to load rebate reservations: ${requestError.message}`);
  const requestIds = (requests ?? []).map((row) => row.id);
  const used = new Map<string, number>();
  if (requestIds.length === 0) return used;
  const { data, error } = await supabase
    .from("partner_withdrawal_rebate_allocations")
    .select("rebate_id, allocated_amount")
    .in("withdrawal_request_id", requestIds);
  if (error) throw new Error(`Failed to load rebate allocations: ${error.message}`);
  for (const allocation of data ?? []) {
    used.set(
      allocation.rebate_id,
      (used.get(allocation.rebate_id) ?? 0) + Number(allocation.allocated_amount),
    );
  }
  return used;
}

async function getIncludedItemsByRequestIds(
  requestIds: string[],
): Promise<Map<string, PartnerWithdrawalIncludedItemDto[]>> {
  const result = new Map<string, PartnerWithdrawalIncludedItemDto[]>();
  if (requestIds.length === 0) return result;
  const supabase = createAdminClient();
  const [{ data: commissionAllocations }, { data: rebateAllocations }] = await Promise.all([
    supabase
      .from("partner_withdrawal_allocations")
      .select("id, withdrawal_request_id, commission_id, allocated_amount")
      .in("withdrawal_request_id", requestIds),
    supabase
      .from("partner_withdrawal_rebate_allocations")
      .select("id, withdrawal_request_id, rebate_id, allocated_amount")
      .in("withdrawal_request_id", requestIds),
  ]);
  const commissionIds = [...new Set((commissionAllocations ?? []).map((row) => row.commission_id))];
  const rebateIds = [...new Set((rebateAllocations ?? []).map((row) => row.rebate_id))];
  const [{ data: commissions }, { data: rebates }] = await Promise.all([
    commissionIds.length
      ? supabase.from("partner_commissions").select("id, source_type, purchase_id").in("id", commissionIds)
      : Promise.resolve({ data: [] }),
    rebateIds.length
      ? supabase.from("partner_rebates").select("id, source_type, payment_order_id").in("id", rebateIds)
      : Promise.resolve({ data: [] }),
  ]);
  const commissionMap = new Map((commissions ?? []).map((row) => [row.id, row]));
  const rebateMap = new Map((rebates ?? []).map((row) => [row.id, row]));
  for (const allocation of commissionAllocations ?? []) {
    const item = commissionMap.get(allocation.commission_id);
    result.set(allocation.withdrawal_request_id, [
      ...(result.get(allocation.withdrawal_request_id) ?? []),
      {
        id: allocation.id,
        type: "COMMISSION",
        ledgerItemId: allocation.commission_id,
        allocatedAmount: Number(allocation.allocated_amount),
        sourceType: item?.source_type ?? "COMMISSION",
        paymentOrderId: item?.purchase_id ?? null,
      },
    ]);
  }
  for (const allocation of rebateAllocations ?? []) {
    const item = rebateMap.get(allocation.rebate_id);
    result.set(allocation.withdrawal_request_id, [
      ...(result.get(allocation.withdrawal_request_id) ?? []),
      {
        id: allocation.id,
        type: "REBATE",
        ledgerItemId: allocation.rebate_id,
        allocatedAmount: Number(allocation.allocated_amount),
        sourceType: item?.source_type ?? "REBATE",
        paymentOrderId: item?.payment_order_id ?? null,
      },
    ]);
  }
  return result;
}

export async function getPartnerWithdrawalBalance(
  partnerId: string,
  currency = "USD",
): Promise<PartnerWithdrawalBalanceDto> {
  const supabase = createAdminClient();
  const [{ data: commissions, error }, { data: rebates, error: rebateError }] = await Promise.all([
    supabase
      .from("partner_commissions")
      .select("id, commission_amount")
      .eq("partner_id", partnerId)
      .eq("currency", currency)
      .eq("status", "APPROVED"),
    supabase
      .from("partner_rebates")
      .select("id, amount")
      .eq("partner_id", partnerId)
      .eq("currency", currency)
      .eq("status", "APPROVED"),
  ]);
  if (error) throw new Error(`Failed to load approved commissions: ${error.message}`);
  if (rebateError) throw new Error(`Failed to load approved rebates: ${rebateError.message}`);
  const [commissionUsage, rebateUsage] = await Promise.all([
    getAllocationUsage(partnerId, currency),
    getRebateAllocationUsage(partnerId, currency),
  ]);
  const commissionAmounts = (commissions ?? []).map((commission) => Number(commission.commission_amount));
  const rebateAmounts = (rebates ?? []).map((rebate) => Number(rebate.amount));
  const reserved = [
    ...(commissions ?? []).map((commission) => commissionUsage.get(commission.id) ?? 0),
    ...(rebates ?? []).map((rebate) => rebateUsage.get(rebate.id) ?? 0),
  ];
  return calculateWithdrawalBalance(
    [...commissionAmounts, ...rebateAmounts],
    reserved,
    currency,
    commissionAmounts.reduce((sum, amount) => sum + amount, 0),
    rebateAmounts.reduce((sum, amount) => sum + amount, 0),
  );
}

export async function listPartnerWithdrawals(partnerId: string): Promise<PartnerWithdrawalDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("partner_withdrawal_requests")
    .select("*")
    .eq("partner_id", partnerId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Failed to load withdrawals: ${error.message}`);
  const included = await getIncludedItemsByRequestIds((data ?? []).map((row) => row.id));
  return (data ?? []).map((row) => mapWithdrawal(row as WithdrawalRow, included.get(row.id) ?? []));
}

export async function getPartnerWithdrawal(
  partnerId: string,
  withdrawalId: string,
): Promise<PartnerWithdrawalDto | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("partner_withdrawal_requests")
    .select("*")
    .eq("id", withdrawalId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load withdrawal: ${error.message}`);
  const included = data ? await getIncludedItemsByRequestIds([data.id]) : new Map();
  return data ? mapWithdrawal(data as WithdrawalRow, included.get(data.id) ?? []) : null;
}

export async function createPartnerWithdrawal(params: {
  partnerId: string;
  amount: number;
  currency: string;
  payoutMethod: string;
  payoutReference: string;
  requestedNote?: string | null;
}): Promise<PartnerWithdrawalDto> {
  const supabase = createAdminClient();
  const currency = params.currency.trim().toUpperCase();
  const amount = Number(params.amount.toFixed(2));
  if (!Number.isFinite(amount) || amount < MINIMUM_PARTNER_WITHDRAWAL) {
    throw new Error(`Minimum withdrawal is ${MINIMUM_PARTNER_WITHDRAWAL} ${currency}.`);
  }

  const { data: profile } = await supabase
    .from("partner_profiles")
    .select("status")
    .eq("user_id", params.partnerId)
    .maybeSingle();
  if (profile?.status !== "ACTIVE") throw new Error("Only active partners can request withdrawals.");

  const { data: active } = await supabase
    .from("partner_withdrawal_requests")
    .select("id")
    .eq("partner_id", params.partnerId)
    .eq("currency", currency)
    .in("status", ["PENDING_REVIEW", "APPROVED"])
    .limit(1);
  if (active?.length) throw new Error("You already have an active withdrawal request in this currency.");

  const { data: commissions, error: commissionError } = await supabase
    .from("partner_commissions")
    .select("id, commission_amount, created_at")
    .eq("partner_id", params.partnerId)
    .eq("currency", currency)
    .eq("status", "APPROVED")
    .order("created_at", { ascending: true });
  if (commissionError) throw new Error(`Failed to load approved commissions: ${commissionError.message}`);
  const { data: rebates, error: rebateError } = await supabase
    .from("partner_rebates")
    .select("id, amount, created_at")
    .eq("partner_id", params.partnerId)
    .eq("currency", currency)
    .eq("status", "APPROVED")
    .order("created_at", { ascending: true });
  if (rebateError) throw new Error(`Failed to load approved rebates: ${rebateError.message}`);
  const [used, usedRebates] = await Promise.all([
    getAllocationUsage(params.partnerId, currency),
    getRebateAllocationUsage(params.partnerId, currency),
  ]);
  const availableCommissions = (commissions ?? []).reduce(
    (sum, commission) => sum + Math.max(0, Number(commission.commission_amount) - (used.get(commission.id) ?? 0)),
    0,
  );
  const availableRebates = (rebates ?? []).reduce(
    (sum, rebate) => sum + Math.max(0, Number(rebate.amount) - (usedRebates.get(rebate.id) ?? 0)),
    0,
  );
  const available = availableCommissions + availableRebates;
  if (amount > available + 0.001) throw new Error("Withdrawal amount exceeds your available approved balance.");

  const { data: request, error: insertError } = await supabase
    .from("partner_withdrawal_requests")
    .insert({
      partner_id: params.partnerId,
      amount,
      currency,
      payout_method: params.payoutMethod.trim(),
      payout_reference: params.payoutReference.trim(),
      requested_note: params.requestedNote?.trim() || null,
    })
    .select("*")
    .single();
  if (insertError || !request) {
    if (insertError?.code === "23505") throw new Error("You already have an active withdrawal request.");
    throw new Error(`Failed to create withdrawal request: ${insertError?.message}`);
  }

  let remaining = amount;
  const allocations: Array<{ withdrawal_request_id: string; commission_id: string; allocated_amount: number }> = [];
  const rebateAllocations: Array<{ withdrawal_request_id: string; rebate_id: string; allocated_amount: number }> = [];
  for (const commission of commissions ?? []) {
    if (remaining <= 0) break;
    const commissionAvailable = Math.max(0, Number(commission.commission_amount) - (used.get(commission.id) ?? 0));
    const allocated = Math.min(remaining, commissionAvailable);
    if (allocated > 0) {
      allocations.push({ withdrawal_request_id: request.id, commission_id: commission.id, allocated_amount: Number(allocated.toFixed(2)) });
      remaining = Number((remaining - allocated).toFixed(2));
    }
  }
  for (const rebate of rebates ?? []) {
    if (remaining <= 0) break;
    const rebateAvailable = Math.max(0, Number(rebate.amount) - (usedRebates.get(rebate.id) ?? 0));
    const allocated = Math.min(remaining, rebateAvailable);
    if (allocated > 0) {
      rebateAllocations.push({
        withdrawal_request_id: request.id,
        rebate_id: rebate.id,
        allocated_amount: Number(allocated.toFixed(2)),
      });
      remaining = Number((remaining - allocated).toFixed(2));
    }
  }
  const [{ error: allocationError }, { error: rebateAllocationError }] = await Promise.all([
    allocations.length
      ? supabase.from("partner_withdrawal_allocations").insert(allocations)
      : Promise.resolve({ error: null }),
    rebateAllocations.length
      ? supabase.from("partner_withdrawal_rebate_allocations").insert(rebateAllocations)
      : Promise.resolve({ error: null }),
  ]);
  if (allocationError || rebateAllocationError || remaining > 0.001) {
    await supabase.from("partner_withdrawal_requests").delete().eq("id", request.id);
    throw new Error("Withdrawal balance changed while the request was being created. Please retry.");
  }

  void createNotification({
    userId: params.partnerId,
    type: "PARTNER_WITHDRAWAL",
    title: "Withdrawal request submitted",
    message: `Your ${amount.toFixed(2)} ${currency} withdrawal is pending admin review.`,
  }).catch(() => { /* notification delivery must not roll back a valid request */ });
  await writeAuditLog({ actorUserId: params.partnerId, action: "PARTNER_WITHDRAWAL_REQUESTED", entityType: "partner_withdrawal", entityId: request.id, metadata: { amount, currency } });
  const included = await getIncludedItemsByRequestIds([request.id]);
  return mapWithdrawal(request as WithdrawalRow, included.get(request.id) ?? []);
}

export async function listAdminWithdrawals(status?: PartnerWithdrawalStatus): Promise<PartnerWithdrawalDto[]> {
  const supabase = createAdminClient();
  let query = supabase
    .from("partner_withdrawal_requests")
    .select("*, partner:profiles!partner_id(full_name, email)")
    .order("created_at", { ascending: false })
    .limit(250);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load withdrawal requests: ${error.message}`);
  const included = await getIncludedItemsByRequestIds((data ?? []).map((row) => row.id));
  return (data ?? []).map((row) =>
    mapWithdrawal(row as unknown as WithdrawalRow, included.get(row.id) ?? []),
  );
}

export async function transitionPartnerWithdrawal(params: {
  withdrawalId: string;
  adminId: string;
  nextStatus: "APPROVED" | "PAID" | "REJECTED";
  adminNote?: string | null;
  rejectionReason?: string | null;
}): Promise<PartnerWithdrawalDto> {
  const supabase = createAdminClient();
  const { data: current, error: loadError } = await supabase
    .from("partner_withdrawal_requests")
    .select("*")
    .eq("id", params.withdrawalId)
    .maybeSingle();
  if (loadError || !current) throw new Error("Withdrawal request not found.");
  if (!validateWithdrawalTransition(current.status as PartnerWithdrawalStatus, params.nextStatus)) {
    throw new Error(`Cannot move a ${current.status} withdrawal to ${params.nextStatus}.`);
  }
  if (params.nextStatus === "REJECTED" && (!params.rejectionReason || params.rejectionReason.trim().length < 3)) {
    throw new Error("A rejection reason is required.");
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: params.nextStatus,
    reviewed_by: params.adminId,
    reviewed_at: now,
    admin_note: params.adminNote?.trim() || null,
    rejection_reason: params.nextStatus === "REJECTED" ? params.rejectionReason?.trim() : null,
  };
  if (params.nextStatus === "PAID") patch.paid_at = now;
  const { data: updated, error } = await supabase
    .from("partner_withdrawal_requests")
    .update(patch)
    .eq("id", params.withdrawalId)
    .eq("status", current.status)
    .select("*")
    .maybeSingle();
  if (error || !updated) throw new Error("Withdrawal status changed before this action completed. Refresh and retry.");

  if (params.nextStatus === "PAID") {
    const { data: allocations } = await supabase
      .from("partner_withdrawal_allocations")
      .select("commission_id")
      .eq("withdrawal_request_id", params.withdrawalId);
    const commissionIds = [...new Set((allocations ?? []).map((allocation) => allocation.commission_id))];
    for (const commissionId of commissionIds) {
      const { data: commission } = await supabase
        .from("partner_commissions")
        .select("commission_amount")
        .eq("id", commissionId)
        .maybeSingle();
      const { data: allAllocations } = await supabase
        .from("partner_withdrawal_allocations")
        .select("allocated_amount, withdrawal_request_id")
        .eq("commission_id", commissionId);
      const requestIds = (allAllocations ?? []).map((allocation) => allocation.withdrawal_request_id);
      const { data: paidRequests } = requestIds.length
        ? await supabase.from("partner_withdrawal_requests").select("id").in("id", requestIds).eq("status", "PAID")
        : { data: [] };
      const paidIds = new Set((paidRequests ?? []).map((request) => request.id));
      const reconciled = (allAllocations ?? []).reduce(
        (sum, allocation) => sum + (paidIds.has(allocation.withdrawal_request_id) ? Number(allocation.allocated_amount) : 0),
        0,
      );
      if (commission && reconciled + 0.001 >= Number(commission.commission_amount)) {
        await supabase.from("partner_commissions").update({ status: "PAID", paid_at: now }).eq("id", commissionId);
      }
    }

    const { data: rebateAllocations } = await supabase
      .from("partner_withdrawal_rebate_allocations")
      .select("rebate_id")
      .eq("withdrawal_request_id", params.withdrawalId);
    const rebateIds = [...new Set((rebateAllocations ?? []).map((allocation) => allocation.rebate_id))];
    for (const rebateId of rebateIds) {
      const { data: rebate } = await supabase
        .from("partner_rebates")
        .select("amount")
        .eq("id", rebateId)
        .maybeSingle();
      const { data: allAllocations } = await supabase
        .from("partner_withdrawal_rebate_allocations")
        .select("allocated_amount, withdrawal_request_id")
        .eq("rebate_id", rebateId);
      const requestIds = (allAllocations ?? []).map((allocation) => allocation.withdrawal_request_id);
      const { data: paidRequests } = requestIds.length
        ? await supabase.from("partner_withdrawal_requests").select("id").in("id", requestIds).eq("status", "PAID")
        : { data: [] };
      const paidIds = new Set((paidRequests ?? []).map((request) => request.id));
      const reconciled = (allAllocations ?? []).reduce(
        (sum, allocation) =>
          sum + (paidIds.has(allocation.withdrawal_request_id) ? Number(allocation.allocated_amount) : 0),
        0,
      );
      if (rebate && reconciled + 0.001 >= Number(rebate.amount)) {
        await supabase.from("partner_rebates").update({ status: "PAID", paid_at: now }).eq("id", rebateId);
      }
    }
  }

  const message = params.nextStatus === "APPROVED"
    ? `Your ${Number(current.amount).toFixed(2)} ${current.currency} withdrawal was approved.`
    : params.nextStatus === "PAID"
      ? `Your ${Number(current.amount).toFixed(2)} ${current.currency} withdrawal was marked paid.`
      : `Your withdrawal was rejected: ${params.rejectionReason?.trim()}`;
  void createNotification({ userId: current.partner_id, type: "PARTNER_WITHDRAWAL", title: `Withdrawal ${params.nextStatus.toLowerCase()}`, message })
    .catch(() => { /* workflow state is authoritative even if notification delivery fails */ });
  await writeAuditLog({ actorUserId: params.adminId, action: `PARTNER_WITHDRAWAL_${params.nextStatus}`, entityType: "partner_withdrawal", entityId: params.withdrawalId, metadata: { partnerId: current.partner_id, amount: current.amount, currency: current.currency } });
  return mapWithdrawal(updated as WithdrawalRow);
}

export async function getPartnerFinancialLedger(
  partnerId: string,
  currency = "USD",
  options?: { includeItems?: boolean },
): Promise<PartnerFinancialLedgerDto> {
  const supabase = createAdminClient();
  const [
    { data: profile },
    { data: partnerProfile },
    { count: referredTraderCount },
    { data: commissions, error: commissionError },
    { data: rebates, error: rebateError },
    { data: withdrawals, error: withdrawalError },
  ] = await Promise.all([
    supabase.from("profiles").select("full_name, email").eq("id", partnerId).maybeSingle(),
    supabase.from("partner_profiles").select("referral_code").eq("user_id", partnerId).maybeSingle(),
    supabase.from("trader_profiles").select("user_id", { count: "exact", head: true }).eq("partner_id", partnerId),
    supabase
      .from("partner_commissions")
      .select("id, trader_id, source_type, source_id, purchase_id, commission_amount, currency, status, created_at, paid_at, metadata")
      .eq("partner_id", partnerId)
      .eq("currency", currency)
      .order("created_at", { ascending: false }),
    supabase
      .from("partner_rebates")
      .select("id, trader_id, source_type, payment_order_id, amount, currency, status, description, created_at, paid_at")
      .eq("partner_id", partnerId)
      .eq("currency", currency)
      .order("created_at", { ascending: false }),
    supabase
      .from("partner_withdrawal_requests")
      .select("id, amount, status")
      .eq("partner_id", partnerId)
      .eq("currency", currency),
  ]);
  if (commissionError) throw new Error(`Failed to load partner commissions: ${commissionError.message}`);
  if (rebateError) throw new Error(`Failed to load partner rebates: ${rebateError.message}`);
  if (withdrawalError) throw new Error(`Failed to load partner withdrawals: ${withdrawalError.message}`);

  const activeWithdrawalIds = (withdrawals ?? [])
    .filter((request) => request.status === "PENDING_REVIEW" || request.status === "APPROVED")
    .map((request) => request.id);
  const paidWithdrawalIds = (withdrawals ?? [])
    .filter((request) => request.status === "PAID")
    .map((request) => request.id);
  const relevantRequestIds = [...activeWithdrawalIds, ...paidWithdrawalIds];
  const [{ data: commissionAllocations }, { data: rebateAllocations }] = relevantRequestIds.length
    ? await Promise.all([
        supabase
          .from("partner_withdrawal_allocations")
          .select("commission_id, allocated_amount, withdrawal_request_id")
          .in("withdrawal_request_id", relevantRequestIds),
        supabase
          .from("partner_withdrawal_rebate_allocations")
          .select("rebate_id, allocated_amount, withdrawal_request_id")
          .in("withdrawal_request_id", relevantRequestIds),
      ])
    : [{ data: [] }, { data: [] }];

  const activeIdSet = new Set(activeWithdrawalIds);
  const paidIdSet = new Set(paidWithdrawalIds);
  const approvedCommissionIds = new Set(
    (commissions ?? []).filter((item) => item.status === "APPROVED").map((item) => item.id),
  );
  const approvedRebateIds = new Set(
    (rebates ?? []).filter((item) => item.status === "APPROVED").map((item) => item.id),
  );
  const paidCommissionAllocations = (commissionAllocations ?? []).reduce(
    (sum, allocation) =>
      sum + (
        paidIdSet.has(allocation.withdrawal_request_id)
        && approvedCommissionIds.has(allocation.commission_id)
          ? Number(allocation.allocated_amount)
          : 0
      ),
    0,
  );
  const paidRebateAllocations = (rebateAllocations ?? []).reduce(
    (sum, allocation) =>
      sum + (
        paidIdSet.has(allocation.withdrawal_request_id)
        && approvedRebateIds.has(allocation.rebate_id)
          ? Number(allocation.allocated_amount)
          : 0
      ),
    0,
  );
  const lockedWithdrawalAmount = [
    ...(commissionAllocations ?? []).map((allocation) =>
      activeIdSet.has(allocation.withdrawal_request_id) ? Number(allocation.allocated_amount) : 0,
    ),
    ...(rebateAllocations ?? []).map((allocation) =>
      activeIdSet.has(allocation.withdrawal_request_id) ? Number(allocation.allocated_amount) : 0,
    ),
  ].reduce((sum, amount) => sum + amount, 0);

  const amountByStatus = (
    rows: Array<{ status: string; amount: number }>,
    statuses: string[],
  ) => rows
    .filter((row) => statuses.includes(row.status))
    .reduce((sum, row) => sum + row.amount, 0);
  const commissionAmounts = (commissions ?? []).map((item) => ({
    status: item.status,
    amount: Number(item.commission_amount),
  }));
  const rebateAmounts = (rebates ?? []).map((item) => ({
    status: item.status,
    amount: Number(item.amount),
  }));
  const approvedCommissionTotal = amountByStatus(commissionAmounts, ["APPROVED"]);
  const approvedRebateTotal = amountByStatus(rebateAmounts, ["APPROVED"]);
  const approvedUnpaidCommissions = Math.max(0, approvedCommissionTotal - paidCommissionAllocations);
  const approvedUnpaidRebates = Math.max(0, approvedRebateTotal - paidRebateAllocations);

  const items: PartnerLedgerItemDto[] = options?.includeItems === false ? [] : [
    ...(commissions ?? []).map((item) => ({
      id: item.id,
      type: "COMMISSION" as const,
      traderId: item.trader_id,
      sourceType: item.source_type,
      paymentOrderId: item.purchase_id,
      amount: Number(item.commission_amount),
      currency: item.currency,
      status: item.status as PartnerLedgerItemDto["status"],
      description: typeof item.metadata?.note === "string" ? item.metadata.note : null,
      createdAt: item.created_at,
      paidAt: item.paid_at,
    })),
    ...(rebates ?? []).map((item) => ({
      id: item.id,
      type: "REBATE" as const,
      traderId: item.trader_id,
      sourceType: item.source_type,
      paymentOrderId: item.payment_order_id,
      amount: Number(item.amount),
      currency: item.currency,
      status: item.status as PartnerLedgerItemDto["status"],
      description: item.description,
      createdAt: item.created_at,
      paidAt: item.paid_at,
    })),
  ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  return {
    partnerId,
    partnerName: profile?.full_name ?? "Partner",
    partnerEmail: profile?.email ?? "",
    referralCode: partnerProfile?.referral_code ?? null,
    referredTraderCount: referredTraderCount ?? 0,
    currency,
    pendingCommissions: Number(amountByStatus(commissionAmounts, ["PENDING"]).toFixed(2)),
    approvedUnpaidCommissions: Number(approvedUnpaidCommissions.toFixed(2)),
    paidCommissions: Number((
      amountByStatus(commissionAmounts, ["PAID"]) + paidCommissionAllocations
    ).toFixed(2)),
    cancelledOrReversedCommissions: Number(
      amountByStatus(commissionAmounts, ["CANCELLED", "REVERSED"]).toFixed(2),
    ),
    pendingRebates: Number(amountByStatus(rebateAmounts, ["PENDING"]).toFixed(2)),
    approvedUnpaidRebates: Number(approvedUnpaidRebates.toFixed(2)),
    paidRebates: Number((
      amountByStatus(rebateAmounts, ["PAID"]) + paidRebateAllocations
    ).toFixed(2)),
    cancelledOrReversedRebates: Number(
      amountByStatus(rebateAmounts, ["CANCELLED", "REVERSED"]).toFixed(2),
    ),
    lockedWithdrawalAmount: Number(lockedWithdrawalAmount.toFixed(2)),
    withdrawableBalance: Number(
      Math.max(0, approvedUnpaidCommissions + approvedUnpaidRebates - lockedWithdrawalAmount).toFixed(2),
    ),
    activeWithdrawalCount: activeWithdrawalIds.length,
    historicalPaidWithdrawals: Number(
      (withdrawals ?? [])
        .filter((request) => request.status === "PAID")
        .reduce((sum, request) => sum + Number(request.amount), 0)
        .toFixed(2),
    ),
    items,
  };
}

export async function createPartnerRebate(params: {
  partnerId: string;
  actorUserId: string;
  traderId?: string | null;
  paymentOrderId?: string | null;
  sourceType: string;
  amount: number;
  currency: string;
  status: "PENDING" | "APPROVED";
  description?: string | null;
}): Promise<PartnerLedgerItemDto> {
  const supabase = createAdminClient();
  const { data: partner } = await supabase
    .from("partner_profiles")
    .select("user_id")
    .eq("user_id", params.partnerId)
    .maybeSingle();
  if (!partner) throw new Error("Partner not found.");
  if (params.traderId) {
    const { data: trader } = await supabase
      .from("trader_profiles")
      .select("user_id")
      .eq("user_id", params.traderId)
      .eq("partner_id", params.partnerId)
      .maybeSingle();
    if (!trader) throw new Error("Trader is not attributed to this partner.");
  }
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("partner_rebates")
    .insert({
      partner_id: params.partnerId,
      trader_id: params.traderId ?? null,
      payment_order_id: params.paymentOrderId ?? null,
      source_type: params.sourceType.trim(),
      calculation_type: params.sourceType === "ADMIN_ADJUSTMENT" ? "ADMIN_ADJUSTMENT" : null,
      amount: Number(params.amount.toFixed(2)),
      currency: params.currency.toUpperCase(),
      status: params.status,
      description: params.description?.trim() || null,
      approved_at: params.status === "APPROVED" ? now : null,
    })
    .select("id, trader_id, payment_order_id, source_type, amount, currency, status, description, created_at, paid_at")
    .single();
  if (error || !data) throw new Error(`Failed to create partner rebate: ${error?.message}`);
  await writeAuditLog({
    actorUserId: params.actorUserId,
    action: "PARTNER_REBATE_CREATED",
    entityType: "partner_rebate",
    entityId: data.id,
    metadata: {
      partnerId: params.partnerId,
      status: params.status,
      amount: Number(data.amount),
      currency: data.currency,
    },
  });
  return {
    id: data.id,
    type: "REBATE",
    traderId: data.trader_id,
    sourceType: data.source_type,
    paymentOrderId: data.payment_order_id,
    amount: Number(data.amount),
    currency: data.currency,
    status: data.status as PartnerLedgerItemDto["status"],
    description: data.description,
    createdAt: data.created_at,
    paidAt: data.paid_at,
  };
}
