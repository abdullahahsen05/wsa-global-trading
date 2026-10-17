import { NextRequest } from "next/server";
import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requirePartner } from "@/lib/auth/session";
import {
  getPartnerRebateTotals,
  listPartnerTradeRebateLogs,
  refreshPartnerRebatesIfStale,
  type RebateView,
} from "@/lib/services/partnerRebateCalculationService";

/** Newest rebate rows sent to the browser; the totals always cover every row. */
const RECORD_LIMIT = 500;

function parseView(value: string | null): RebateView {
  return value === "REBATE" || value === "CPA" || value === "HYBRID" ? value : "ALL";
}

export async function GET(request: NextRequest) {
  try {
    const partner = await requirePartner();
    const view = parseView(new URL(request.url).searchParams.get("view"));

    await refreshPartnerRebatesIfStale(partner.id);

    const [records, totals] = await Promise.all([
      listPartnerTradeRebateLogs(partner.id, RECORD_LIMIT, view),
      getPartnerRebateTotals(partner.id, view),
    ]);
    return jsonOk({ records, totals, truncated: totals.records > records.length });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("PARTNER_REBATES_LOAD_FAILED", "Partner trade rebates could not be loaded.", 500);
  }
}
