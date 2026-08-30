import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireAdmin } from "@/lib/auth/session";
import { listPartnerTradersForAdmin } from "@/lib/services/partnerService";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await params;
    const url = new URL(request.url);
    const status = (url.searchParams.get("status") ?? "ALL") as "ALL" | "ACTIVE" | "AT_RISK" | "RESTRICTED";
    const search = url.searchParams.get("search") ?? "";
    return jsonOk(await listPartnerTradersForAdmin(id, { status, search }));
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    return jsonFail("PARTNER_TRADERS_UNAVAILABLE", "Partner trader pipeline is unavailable.", 500);
  }
}
