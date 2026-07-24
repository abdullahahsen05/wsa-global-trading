import { NextRequest } from "next/server";
import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPartnerFinancialLedger } from "@/lib/services/partnerWithdrawalService";
import type { PartnerFinancialLedgerDto } from "@/lib/partner/withdrawals";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
    const partnerId = new URL(request.url).searchParams.get("partnerId");
    if (partnerId) {
      if (!UUID_PATTERN.test(partnerId)) return jsonFail("VALIDATION_ERROR", "Invalid partner ID.", 400);
      return jsonOk({ ledgers: [await getPartnerFinancialLedger(partnerId)] });
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("partner_profiles")
      .select("user_id")
      .order("created_at", { ascending: false })
      .limit(250);
    if (error) throw error;
    const partners = data ?? [];
    const ledgers: PartnerFinancialLedgerDto[] = [];
    // Bound concurrency so an admin opening this page cannot fan out hundreds
    // of simultaneous database reads.
    for (let offset = 0; offset < partners.length; offset += 12) {
      const batch = partners.slice(offset, offset + 12);
      ledgers.push(...await Promise.all(
        batch.map((partner) =>
          getPartnerFinancialLedger(partner.user_id, "USD", { includeItems: false }),
        ),
      ));
    }
    return jsonOk({ ledgers });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("PARTNER_LEDGER_UNAVAILABLE", "Partner financial ledgers are unavailable.", 500);
  }
}
