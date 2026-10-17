import { describe, expect, it } from "vitest";
import {
  brokerGroupKey,
  closedAfterAttribution,
  commissionOnSale,
  cpaPayoutForDeposit,
  cpaTierName,
  cpaTierReached,
  dominantCurrency,
  ibRebateAmount,
  isEligibleLiveAccount,
  pickBrokerConfiguration,
  rebateKind,
  rebateRowInView,
  summarizeRebates,
  symbolClass,
  validateCpaTierOrder,
  type RebateRowLike,
} from "@/lib/partner/rebateRules";
import {
  chunkArray,
  selectAllPages,
  selectAllPagesForIds,
  SUPABASE_IN_CHUNK,
} from "@/lib/supabase/pagedSelect";
import { partnerBrokerConfigurationSchema } from "@/lib/validation/schemas";

const TIERS = [
  { deposit: 300, payout: 350 },
  { deposit: 500, payout: 550 },
  { deposit: 1000, payout: 750 },
];

describe("IB per-lot rebate", () => {
  it("gives gold its own class whatever the broker prefix or suffix", () => {
    expect(symbolClass("XAUUSD")).toBe("XAUUSD");
    expect(symbolClass("XAUUSDm")).toBe("XAUUSD");
    expect(symbolClass("xauusd.r")).toBe("XAUUSD");
    expect(symbolClass("#XAU/USD")).toBe("XAUUSD");
    expect(symbolClass("EURUSD")).toBe("FOREX");
    expect(symbolClass(null)).toBe("FOREX");
  });

  it("multiplies absolute lots by the rate and rounds to cents", () => {
    expect(ibRebateAmount(1.5, 7)).toBe(10.5);
    expect(ibRebateAmount(-2, 5)).toBe(10);
    expect(ibRebateAmount(0.333, 3)).toBe(1);
    expect(ibRebateAmount(Number.NaN, 3)).toBe(0);
  });
});

describe("CPA tiers", () => {
  it("pays the highest tier whose deposit was reached", () => {
    expect(cpaTierReached(TIERS, 299)).toBe(0);
    expect(cpaPayoutForDeposit(TIERS, 299)).toBe(0);
    expect(cpaPayoutForDeposit(TIERS, 300)).toBe(350);
    expect(cpaPayoutForDeposit(TIERS, 499.99)).toBe(350);
    expect(cpaPayoutForDeposit(TIERS, 500)).toBe(550);
    expect(cpaPayoutForDeposit(TIERS, 25_000)).toBe(750);
    expect(cpaTierName(TIERS, 700)).toBe("Tier 2");
    expect(cpaTierName(TIERS, 10)).toBeNull();
  });

  it("requires the tier deposits to ascend", () => {
    expect(validateCpaTierOrder([300, 500, 1000])).toBeNull();
    expect(validateCpaTierOrder([300, 300, 300])).toBeNull();
    expect(validateCpaTierOrder([500, 300, 1000])).toContain("must not decrease");
  });

  it("rejects descending tiers in a CPA or hybrid agreement but not in a pure IB one", () => {
    const base = {
      rebateRatePerLot: 5,
      cpaTier1Deposit: 1000,
      cpaTier2Deposit: 500,
      cpaTier3Deposit: 300,
    };
    expect(partnerBrokerConfigurationSchema.safeParse({ ...base, modelType: "CPA" }).success).toBe(false);
    expect(partnerBrokerConfigurationSchema.safeParse({ ...base, modelType: "HYBRID" }).success).toBe(false);
    expect(partnerBrokerConfigurationSchema.safeParse({ ...base, modelType: "IB" }).success).toBe(true);
    expect(partnerBrokerConfigurationSchema.safeParse({ rebateRatePerLot: 5, modelType: "CPA" }).success).toBe(true);
  });
});

describe("which agreement and which trades count", () => {
  const configs = [
    { id: "all", brokerProviderId: null, brokerNames: [] },
    { id: "ic", brokerProviderId: "p-1", brokerNames: ["IC Markets", "icmarkets"] },
    { id: "xm", brokerProviderId: "p-2", brokerNames: ["XM Global"] },
  ];

  it("prefers the exact broker, then the broker name, then the default agreement", () => {
    expect(pickBrokerConfiguration(configs, "p-2", "whatever")?.id).toBe("xm");
    expect(pickBrokerConfiguration(configs, null, "IC  Markets")?.id).toBe("ic");
    expect(pickBrokerConfiguration(configs, "p-9", "Unknown Broker")?.id).toBe("all");
    expect(pickBrokerConfiguration(configs.slice(1), null, "Unknown Broker")).toBeNull();
  });

  it("groups accounts by broker for the once-per-client CPA check", () => {
    expect(brokerGroupKey({ broker_provider_id: "p-1", broker_name: "IC Markets" })).toBe("id:p-1");
    expect(brokerGroupKey({ broker_provider_id: null, broker_name: "IC  Markets!" })).toBe("name:ic markets");
    expect(brokerGroupKey({})).toBe("none");
  });

  it("only connected live trader or master accounts earn", () => {
    expect(isEligibleLiveAccount({ status: "CONNECTED", account_usage: "TRADER" })).toBe(true);
    expect(isEligibleLiveAccount({ status: "CONNECTED", account_usage: "COPY_MASTER" })).toBe(true);
    expect(isEligibleLiveAccount({ status: "CONNECTED" })).toBe(true);
    expect(isEligibleLiveAccount({ status: "CONNECTED", account_usage: "EVALUATION" })).toBe(false);
    expect(isEligibleLiveAccount({ status: "DISCONNECTED", account_usage: "TRADER" })).toBe(false);
    expect(isEligibleLiveAccount(null)).toBe(false);
  });

  it("only trades closed after the client joined the partner earn", () => {
    expect(closedAfterAttribution("2026-03-02T10:00:00Z", "2026-03-01T00:00:00Z")).toBe(true);
    expect(closedAfterAttribution("2026-02-27T10:00:00Z", "2026-03-01T00:00:00Z")).toBe(false);
    expect(closedAfterAttribution("2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z")).toBe(true);
    expect(closedAfterAttribution("2026-03-02T10:00:00Z", null)).toBe(true);
    expect(closedAfterAttribution(null, "2026-03-01T00:00:00Z")).toBe(false);
    expect(closedAfterAttribution("not a date", "2026-03-01T00:00:00Z")).toBe(false);
  });
});

describe("WSA subscription commission", () => {
  it("is the gross amount times the percentage, rounded to cents", () => {
    expect(commissionOnSale(199, 30)).toBe(59.7);
    expect(commissionOnSale(99.99, 33.33)).toBe(33.33);
    expect(commissionOnSale(100, 0)).toBe(0);
    expect(commissionOnSale(Number.NaN, 30)).toBe(0);
  });
});

describe("rebate totals", () => {
  const rows: RebateRowLike[] = [
    // IB per-lot rows
    { amount: 10, status: "APPROVED", calculation_type: "IB_VOLUME", source_type: "TRADE_VOLUME", model_type: "IB", volume_lots: 2, trader_id: "t1", broker_provider_id: "b1" },
    { amount: 5, status: "PAID", calculation_type: "IB_VOLUME", source_type: "TRADE_VOLUME", model_type: "HYBRID", volume_lots: 1, trader_id: "t2", broker_provider_id: "b1" },
    { amount: 4, status: "PENDING", calculation_type: "IB_VOLUME", source_type: "TRADE_VOLUME", model_type: "IB", volume_lots: 0.8, trader_id: "t1", broker_provider_id: "b1" },
    { amount: 9, status: "CANCELLED", calculation_type: "IB_VOLUME", source_type: "TRADE_VOLUME", model_type: "IB", volume_lots: 1.5, trader_id: "t3", broker_provider_id: "b2" },
    // CPA payouts
    { amount: 350, status: "APPROVED", calculation_type: "CPA_TIER", source_type: "CPA_TIER", model_type: "HYBRID", volume_lots: 3, trader_id: "t2", broker_provider_id: "b1" },
    { amount: 550, status: "PENDING", calculation_type: "CPA_TIER", source_type: "CPA_TIER", model_type: "CPA", volume_lots: 4, trader_id: "t4", broker_provider_id: null },
    // manual adjustment by an admin
    { amount: 20, status: "APPROVED", calculation_type: "ADMIN_ADJUSTMENT", source_type: "ADMIN_ADJUSTMENT", model_type: null, volume_lots: null, trader_id: null, broker_provider_id: null },
  ];

  it("classifies rows", () => {
    expect(rebateKind(rows[0])).toBe("IB");
    expect(rebateKind(rows[4])).toBe("CPA");
    expect(rebateKind(rows[6])).toBe("OTHER");
    expect(rebateRowInView(rows[1], "REBATE")).toBe(true);
    expect(rebateRowInView(rows[4], "REBATE")).toBe(false);
    expect(rebateRowInView(rows[4], "HYBRID")).toBe(true);
    expect(rebateRowInView(rows[5], "HYBRID")).toBe(false);
    expect(rebateRowInView(rows[6], "ALL")).toBe(true);
    expect(rebateRowInView(rows[6], "HYBRID")).toBe(false);
  });

  it("sums only approved and paid rows as earned and counts lots once", () => {
    const rebate = summarizeRebates(rows, "REBATE");
    expect(rebate.records).toBe(4);
    expect(rebate.lots).toBe(5.3);
    expect(rebate.earned).toBe(15);
    expect(rebate.pending).toBe(4);
    expect(rebate.traders).toBe(3);

    const cpa = summarizeRebates(rows, "CPA");
    expect(cpa.records).toBe(2);
    expect(cpa.lots).toBe(7);
    expect(cpa.qualified).toBe(1);
    expect(cpa.earned).toBe(350);
    expect(cpa.pending).toBe(550);
    expect(cpa.brokers).toBe(2);

    const hybrid = summarizeRebates(rows, "HYBRID");
    expect(hybrid.records).toBe(2);
    expect(hybrid.ibEarned).toBe(5);
    expect(hybrid.cpaEarned).toBe(350);
    expect(hybrid.earned).toBe(355);

    const all = summarizeRebates(rows, "ALL");
    expect(all.earned).toBe(385);
    expect(all.ibEarned).toBe(15);
    expect(all.cpaEarned).toBe(350);
    expect(all.otherEarned).toBe(20);
    expect(all.records).toBe(6);
  });

  it("uses the currency most rows are in", () => {
    expect(dominantCurrency([{ currency: "usd" }, { currency: "USD" }, { currency: "EUR" }])).toBe("USD");
    expect(dominantCurrency([])).toBeNull();
  });
});

describe("paged reads", () => {
  it("splits id lists into chunks of at most 100", () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    const chunks = chunkArray(ids);
    expect(SUPABASE_IN_CHUNK).toBe(100);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    expect(chunkArray([])).toEqual([]);
  });

  it("keeps reading until a page is short", async () => {
    const calls: Array<[number, number]> = [];
    const rows = await selectAllPages<number>("test", async (from, to) => {
      calls.push([from, to]);
      const count = from === 0 ? 1000 : from === 1000 ? 1000 : 200;
      return { data: Array.from({ length: count }, (_, index) => from + index), error: null };
    });
    expect(rows).toHaveLength(2200);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("stops at the safety limit and reports database errors with the label", async () => {
    const limited = await selectAllPages<number>(
      "limit",
      async () => ({ data: Array.from({ length: 1000 }, (_, index) => index), error: null }),
      { maxRows: 3000 },
    );
    expect(limited).toHaveLength(3000);
    await expect(
      selectAllPages("broken query", async () => ({ data: null, error: { message: "boom" } })),
    ).rejects.toThrow("broken query: boom");
  });

  it("reads every chunk of an id list", async () => {
    const seen: number[] = [];
    const ids = Array.from({ length: 230 }, (_, index) => `id-${index}`);
    const rows = await selectAllPagesForIds<string>("ids", ids, async (idChunk) => {
      seen.push(idChunk.length);
      return { data: idChunk, error: null };
    });
    expect(seen).toEqual([100, 100, 30]);
    expect(rows).toHaveLength(230);
  });
});
