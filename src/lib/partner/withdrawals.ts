export const MINIMUM_PARTNER_WITHDRAWAL = 100;

export type PartnerWithdrawalStatus = "PENDING_REVIEW" | "APPROVED" | "PAID" | "REJECTED";

export interface PartnerWithdrawalDto {
  id: string;
  partnerId: string;
  partnerName?: string;
  partnerEmail?: string;
  amount: number;
  currency: string;
  status: PartnerWithdrawalStatus;
  payoutMethod: string;
  payoutReference: string;
  requestedNote: string | null;
  adminNote: string | null;
  rejectionReason: string | null;
  reviewedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  includedItems?: PartnerWithdrawalIncludedItemDto[];
}

export interface PartnerWithdrawalBalanceDto {
  approved: number;
  approvedCommissions: number;
  approvedRebates: number;
  reserved: number;
  available: number;
  currency: string;
  minimum: number;
}

export interface PartnerWithdrawalIncludedItemDto {
  id: string;
  type: "COMMISSION" | "REBATE";
  ledgerItemId: string;
  allocatedAmount: number;
  sourceType: string;
  paymentOrderId: string | null;
}

export interface PartnerLedgerItemDto {
  id: string;
  type: "COMMISSION" | "REBATE";
  traderId: string | null;
  sourceType: string;
  paymentOrderId: string | null;
  amount: number;
  currency: string;
  status: "PENDING" | "APPROVED" | "PAID" | "CANCELLED" | "REVERSED";
  description: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface PartnerFinancialLedgerDto {
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  referralCode: string | null;
  referredTraderCount: number;
  currency: string;
  pendingCommissions: number;
  approvedUnpaidCommissions: number;
  paidCommissions: number;
  cancelledOrReversedCommissions: number;
  pendingRebates: number;
  approvedUnpaidRebates: number;
  paidRebates: number;
  cancelledOrReversedRebates: number;
  lockedWithdrawalAmount: number;
  withdrawableBalance: number;
  activeWithdrawalCount: number;
  historicalPaidWithdrawals: number;
  /** All rebate rows of the partner (IB per-trade rows, CPA payouts, adjustments). */
  rebateRowCount?: number;
  /** Rebate rows contained in `items` (the newest per-trade IB rows are capped). */
  rebateRowsListed?: number;
  items: PartnerLedgerItemDto[];
}

export function calculateWithdrawalBalance(
  approvedAmounts: number[],
  reservedOrPaidAllocations: number[],
  currency = "USD",
  approvedCommissions = approvedAmounts.reduce((sum, amount) => sum + Number(amount || 0), 0),
  approvedRebates = 0,
): PartnerWithdrawalBalanceDto {
  const approved = approvedAmounts.reduce((sum, amount) => sum + Number(amount || 0), 0);
  const reserved = reservedOrPaidAllocations.reduce((sum, amount) => sum + Number(amount || 0), 0);
  return {
    approved: Number(approved.toFixed(2)),
    approvedCommissions: Number(approvedCommissions.toFixed(2)),
    approvedRebates: Number(approvedRebates.toFixed(2)),
    reserved: Number(reserved.toFixed(2)),
    available: Number(Math.max(0, approved - reserved).toFixed(2)),
    currency,
    minimum: MINIMUM_PARTNER_WITHDRAWAL,
  };
}

export function validateWithdrawalTransition(
  current: PartnerWithdrawalStatus,
  next: PartnerWithdrawalStatus,
): boolean {
  if (current === "PENDING_REVIEW") return next === "APPROVED" || next === "REJECTED";
  if (current === "APPROVED") return next === "PAID" || next === "REJECTED";
  return false;
}
