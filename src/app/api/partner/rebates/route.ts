import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requirePartner } from "@/lib/auth/session";
import {
  ensurePartnerRebateLedgerCurrent,
  listPartnerTradeRebateLogs,
} from "@/lib/services/partnerRebateCalculationService";

export async function GET() {
  try {
    const partner = await requirePartner();
    await ensurePartnerRebateLedgerCurrent(partner.id);
    return jsonOk({ records: await listPartnerTradeRebateLogs(partner.id, 1000) });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("PARTNER_REBATES_LOAD_FAILED", "Partner trade rebates could not be loaded.", 500);
  }
}
