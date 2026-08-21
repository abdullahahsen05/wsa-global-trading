import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requirePartner, AuthError } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateReferralCode } from "@/lib/partner/referral";
import type { PartnerProfileStatus } from "@/lib/partner/profile";

export async function GET() {
  try {
    const user = await requirePartner();
    const supabase = createAdminClient();

    let { data, error } = await supabase
      .from("partner_profiles")
      .select("status, referral_code, commission_percent")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("email, full_name")
        .eq("id", user.id)
        .maybeSingle();
      for (let attempt = 0; attempt < 5 && !data; attempt++) {
        const referralCode = generateReferralCode(
          (profile?.full_name as string | null) || (profile?.email as string | null) || user.email,
        );
        const inserted = await supabase
          .from("partner_profiles")
          .insert({ user_id: user.id, referral_code: referralCode, status: "PENDING_REVIEW" })
          .select("status, referral_code, commission_percent")
          .single();
        if (!inserted.error) data = inserted.data;
        else if ((inserted.error as { code?: string }).code !== "23505") throw new Error(inserted.error.message);
      }
    }

    return jsonOk({
      status: (data?.status ?? "PENDING_REVIEW") as PartnerProfileStatus,
      setupComplete: Boolean(data),
      referralCode: (data?.referral_code ?? null) as string | null,
      commissionPercent: data ? Number(data.commission_percent) : 0,
    });
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
