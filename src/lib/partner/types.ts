import type { MoneyValue } from "@/lib/domain/types";

// ─────────────────────────────────────────────────────────────────────────────
// Partner module — shared types + typed errors
// ─────────────────────────────────────────────────────────────────────────────

export const PARTNER_ERROR = {
  FORBIDDEN: "FORBIDDEN",
  PARTNER_NOT_FOUND: "PARTNER_NOT_FOUND",
  TRADER_NOT_FOUND: "TRADER_NOT_FOUND",
  TRADER_NOT_ASSIGNED: "TRADER_NOT_ASSIGNED",
  INVALID_PARTNER_ROLE: "INVALID_PARTNER_ROLE",
  INVALID_REFERRAL_CODE: "INVALID_REFERRAL_CODE",
  COMMISSION_NOT_FOUND: "COMMISSION_NOT_FOUND",
  INVALID_STATUS: "INVALID_STATUS",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

export type PartnerErrorCode = (typeof PARTNER_ERROR)[keyof typeof PARTNER_ERROR];

/** Typed partner error. Routes map this to jsonFail(code, message, status), like AuthError. */
export class PartnerError extends Error {
  constructor(
    public readonly code: PartnerErrorCode,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "PartnerError";
  }
}

export type TraderRiskStatus = "OK" | "AT_RISK" | "RESTRICTED";

export interface PartnerAccountStatusSummary {
  accountId: string;
  accountName: string | null;
  status: string;
  currency: string;
  equity: number;
}

export interface PartnerTraderDto {
  traderId: string; // profiles.id (the trader's user id) — used for scoping/assignment
  traderProfileId: string; // trader_profiles.id — used for CRM notes
  name: string;
  email: string;
  status: string; // profile status: ACTIVE | SUSPENDED | PENDING
  segment: string;
  accountCount: number;
  connectedAccounts: number;
  totalEquity: MoneyValue;
  floatingPnl: MoneyValue;
  maxDrawdownPercent: number;
  openRiskEvents: number;
  riskStatus: TraderRiskStatus;
  assignedAt: string | null;
  registeredAt: string | null;
  totalLotsTraded: number;
  accounts?: PartnerAccountStatusSummary[];
}

export interface PartnerSummaryDto {
  assignedTraders: number;
  activeTraders: number;
  connectedAccounts: number;
  totalEquity: MoneyValue;
  aggregateFloatingPnl: MoneyValue;
  openRiskEvents: number;
  pendingCommission: MoneyValue;
  earnedCommission: MoneyValue;
  totalTeamLots: number;
  totalRebatesEarned: MoneyValue;
  ibEarnings: MoneyValue;
  cpaEarnings: MoneyValue;
  commissionPercent: number;
  referralCode: string | null;
}

export interface PartnerCommissionDto {
  id: string;
  traderId: string | null;
  traderName: string | null;
  sourceType: string;
  grossAmount: number;
  commissionPercent: number;
  commissionAmount: number;
  currency: string;
  status: "PENDING" | "APPROVED" | "PAID" | "CANCELLED";
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  paidAt: string | null;
}

export type CommissionType = "CPA" | "REBATE" | "PROFIT_SHARE";

export interface PartnerCommissionSummaryDto {
  pending: MoneyValue;
  approved: MoneyValue;
  paid: MoneyValue;
  commissionPercent: number;
  commissionType: CommissionType;
  cpaAmount: number | null;
  currency: string;
}

export interface PartnerListItemDto {
  userId: string;
  name: string;
  email: string;
  status: string;
  partnerStatus: "PENDING_REVIEW" | "ACTIVE" | "SUSPENDED";
  referralCode: string;
  commissionPercent: number;
  assignedTraders: number;
}
