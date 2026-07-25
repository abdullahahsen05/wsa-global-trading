import { requireAuth, AuthError } from "@/lib/auth/session";
import { jsonOk, jsonFail, handleAuthError } from "@/lib/api/envelope";
import { getUserBillingSummary } from "@/lib/services/billingService";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function privateNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  response.headers.set("Vary", "Cookie");
  return response;
}

export async function GET() {
  try {
    const user = await requireAuth();
    const summary = await getUserBillingSummary(user.id);
    return privateNoStore(jsonOk(summary));
  } catch (err) {
    if (err instanceof AuthError) return privateNoStore(handleAuthError(err));
    return privateNoStore(jsonFail("BILLING_ERROR", "Failed to load billing summary", 500));
  }
}
