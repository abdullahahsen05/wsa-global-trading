// ─────────────────────────────────────────────────────────────────────────────
// Partner broker-earning rules (pure — no database, no framework).
//
// The commercial model, as the owner described it:
//   • IB     — the partner earns a fixed amount per traded lot (one rate for
//              Forex, one for XAUUSD) on every closed trade of an attributed
//              trader.
//   • CPA    — one payout per qualified client: the client must trade at least
//              `qualificationLots` and the payout depends on the deposit tier.
//   • HYBRID — both at once.
// An admin enters these terms per partner and per broker (and one default for
// "all brokers"). Broker rebate / CPA figures are *reporting* — only the WSA
// subscription commission is paid out through WSA withdrawals.
//
// Everything here is deterministic and unit-tested; the services only add the
// database around it. Shared with the AWS workers (broker sync) — keep it free
// of React / Next / "server-only" imports.
// ─────────────────────────────────────────────────────────────────────────────

export type PartnerModelType = "IB" | "CPA" | "HYBRID";

/** Rebate rows that count as "earned" (statuses PENDING / CANCELLED / REVERSED do not). */
export const EARNED_REBATE_STATUSES: readonly string[] = ["APPROVED", "PAID"];

export function normalizeBrokerName(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// ── IB: per-lot rebate ──────────────────────────────────────────────────────

export type SymbolClass = "XAUUSD" | "FOREX";

/** Gold (XAUUSD, with any broker prefix/suffix such as XAUUSDm or XAUUSD.r) has its own rate. */
export function symbolClass(symbol: string | null | undefined): SymbolClass {
  const letters = (symbol ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return letters.includes("XAUUSD") ? "XAUUSD" : "FOREX";
}

export function ibRebateAmount(lots: number, ratePerLot: number): number {
  return roundMoney(Math.abs(Number(lots) || 0) * (Number(ratePerLot) || 0));
}

// ── CPA: qualification + deposit tiers ──────────────────────────────────────

export interface CpaTier {
  deposit: number;
  payout: number;
}

/**
 * Highest tier reached by a deposit: 0 = none, 1..3 = tier number. Tiers are
 * checked from the top, so the admin form keeps the deposits ascending
 * (tier 1 ≤ tier 2 ≤ tier 3) — see `validateCpaTierOrder`.
 */
export function cpaTierReached(tiers: readonly CpaTier[], deposit: number): number {
  for (let index = tiers.length - 1; index >= 0; index -= 1) {
    if (deposit >= tiers[index].deposit) return index + 1;
  }
  return 0;
}

export function cpaPayoutForDeposit(tiers: readonly CpaTier[], deposit: number): number {
  const reached = cpaTierReached(tiers, deposit);
  return reached > 0 ? Number(tiers[reached - 1].payout) : 0;
}

export function cpaTierName(tiers: readonly CpaTier[], deposit: number): string | null {
  const reached = cpaTierReached(tiers, deposit);
  return reached > 0 ? `Tier ${reached}` : null;
}

/** Null when the tier deposits ascend, otherwise a message for the admin form. */
export function validateCpaTierOrder(
  deposits: readonly [number, number, number],
): string | null {
  if (deposits[0] <= deposits[1] && deposits[1] <= deposits[2]) return null;
  return "CPA tier deposits must not decrease: tier 1 ≤ tier 2 ≤ tier 3.";
}

// ── Which agreement applies to an account ───────────────────────────────────

export interface BrokerConfigCandidate {
  /** Null = the partner's default agreement for "all brokers". */
  brokerProviderId: string | null;
  /** Display name and name of the broker the agreement is for. */
  brokerNames: ReadonlyArray<string | null | undefined>;
}

/**
 * The partner's agreement for an account: the one for exactly that broker
 * (provider id), else the one whose broker name matches, else the default one.
 * `configs` must already be limited to active agreements of that partner.
 */
export function pickBrokerConfiguration<T extends BrokerConfigCandidate>(
  configs: readonly T[],
  brokerProviderId: string | null | undefined,
  brokerName: string | null | undefined,
): T | null {
  if (brokerProviderId) {
    const byId = configs.find((config) => config.brokerProviderId === brokerProviderId);
    if (byId) return byId;
  }
  const wanted = normalizeBrokerName(brokerName);
  if (wanted) {
    const byName = configs.find(
      (config) =>
        Boolean(config.brokerProviderId)
        && config.brokerNames.some((name) => normalizeBrokerName(name) === wanted),
    );
    if (byName) return byName;
  }
  return configs.find((config) => !config.brokerProviderId) ?? null;
}

/** Accounts of one broker share a CPA qualification (provider id, else the normalised name). */
export function brokerGroupKey(account: {
  broker_provider_id?: string | null;
  broker_name?: string | null;
}): string {
  if (account.broker_provider_id) return `id:${account.broker_provider_id}`;
  const name = normalizeBrokerName(account.broker_name);
  return name ? `name:${name}` : "none";
}

// ── Which trades count ──────────────────────────────────────────────────────

/** Only connected live accounts earn; evaluation (prop challenge) accounts do not. */
export function isEligibleLiveAccount(
  account: { status?: string | null; account_usage?: string | null } | null | undefined,
): boolean {
  if (!account) return false;
  if ((account.status ?? "").toUpperCase() !== "CONNECTED") return false;
  const usage = (account.account_usage ?? "TRADER").toUpperCase();
  return usage === "TRADER" || usage === "COPY_MASTER";
}

/**
 * A trade earns the partner something only when it closed after the trader was
 * attributed to the partner. A client who joins with a long trading history
 * must not hand the partner rebates for the lots traded before joining.
 */
export function closedAfterAttribution(
  closedAt: string | null | undefined,
  assignedAt: string | null | undefined,
): boolean {
  if (!closedAt) return false;
  const closed = Date.parse(closedAt);
  if (!Number.isFinite(closed)) return false;
  if (!assignedAt) return true;
  const assigned = Date.parse(assignedAt);
  return Number.isFinite(assigned) ? closed >= assigned : true;
}

// ── WSA subscription commission ─────────────────────────────────────────────

/** Commission on a paid order: gross × percent, rounded to cents. */
export function commissionOnSale(grossAmount: number, percent: number): number {
  return roundMoney((Number(grossAmount) || 0) * ((Number(percent) || 0) / 100));
}

// ── Totals over rebate rows ─────────────────────────────────────────────────

export interface RebateRowLike {
  amount: number | string | null;
  status: string;
  calculation_type?: string | null;
  source_type?: string | null;
  model_type?: string | null;
  volume_lots?: number | string | null;
  trader_id?: string | null;
  broker_provider_id?: string | null;
}

/** IB per-lot rows, CPA payouts, or something else (manual admin adjustment). */
export type RebateKind = "IB" | "CPA" | "OTHER";

export function rebateKind(row: Pick<RebateRowLike, "calculation_type" | "source_type">): RebateKind {
  if (row.calculation_type === "CPA_TIER" || row.source_type === "CPA_TIER") return "CPA";
  if (row.calculation_type === "IB_VOLUME" || row.source_type === "TRADE_VOLUME") return "IB";
  return "OTHER";
}

/** Which rows a partner page shows: Rebate = IB rows, CPA = CPA rows, Hybrid = rows of Hybrid agreements. */
export type RebateView = "ALL" | "REBATE" | "CPA" | "HYBRID";

export function rebateRowInView(row: RebateRowLike, view: RebateView): boolean {
  const kind = rebateKind(row);
  switch (view) {
    case "REBATE":
      return kind === "IB";
    case "CPA":
      return kind === "CPA";
    case "HYBRID":
      return row.model_type === "HYBRID" && kind !== "OTHER";
    default:
      return true;
  }
}

export interface RebateTotals {
  /** Trade-linked rows in the view (IB per-lot rows and CPA payouts, any status). */
  records: number;
  /** Lots behind the view: IB rows' lots, or the qualifying lots of CPA rows in the CPA view. */
  lots: number;
  /** APPROVED + PAID, every kind in the view. */
  earned: number;
  /** PENDING. */
  pending: number;
  ibEarned: number;
  cpaEarned: number;
  /** Manual admin adjustments inside `earned`. */
  otherEarned: number;
  /** CPA payouts APPROVED or PAID. */
  qualified: number;
  traders: number;
  brokers: number;
}

export function summarizeRebates(rows: readonly RebateRowLike[], view: RebateView = "ALL"): RebateTotals {
  const totals: RebateTotals = {
    records: 0,
    lots: 0,
    earned: 0,
    pending: 0,
    ibEarned: 0,
    cpaEarned: 0,
    otherEarned: 0,
    qualified: 0,
    traders: 0,
    brokers: 0,
  };
  const traders = new Set<string>();
  const brokers = new Set<string>();
  let ibLots = 0;
  let cpaLots = 0;

  for (const row of rows) {
    if (!rebateRowInView(row, view)) continue;
    const kind = rebateKind(row);
    const amount = Number(row.amount ?? 0) || 0;
    const earned = EARNED_REBATE_STATUSES.includes(row.status);

    if (kind !== "OTHER") {
      totals.records += 1;
      if (row.trader_id) traders.add(row.trader_id);
      brokers.add(row.broker_provider_id ?? "all");
    }
    if (kind === "IB") ibLots += Number(row.volume_lots ?? 0) || 0;
    if (kind === "CPA") {
      cpaLots += Number(row.volume_lots ?? 0) || 0;
      if (earned) totals.qualified += 1;
    }
    if (earned) {
      totals.earned += amount;
      if (kind === "IB") totals.ibEarned += amount;
      else if (kind === "CPA") totals.cpaEarned += amount;
      else totals.otherEarned += amount;
    } else if (row.status === "PENDING") {
      totals.pending += amount;
    }
  }

  totals.lots = view === "CPA" ? cpaLots : ibLots;
  totals.traders = traders.size;
  totals.brokers = brokers.size;
  for (const key of ["lots", "earned", "pending", "ibEarned", "cpaEarned", "otherEarned"] as const) {
    totals[key] = roundMoney(totals[key]);
  }
  return totals;
}

/** The currency most rows are in (amounts of different currencies are never added together). */
export function dominantCurrency(rows: ReadonlyArray<{ currency?: string | null }>): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const currency = (row.currency ?? "").toUpperCase();
    if (currency) counts.set(currency, (counts.get(currency) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [currency, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = currency;
  }
  return best;
}
