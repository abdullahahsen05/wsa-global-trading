import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { createBrokerAdapter, getBrokerProviderLabel } from "@/lib/broker/provider";
import { logBrokerOperation } from "@/lib/services/brokerOperationLog";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ ok: false, error: { message: err.message } }, { status: err.statusCode });
    throw err;
  }

  const { accountId } = await params;
  const supabase = createAdminClient();

  const { data: account, error: fetchErr } = await supabase
    .from("trading_accounts")
    .select("id, user_id, status, provider_account_id")
    .eq("id", accountId)
    .single();

  if (fetchErr || !account) {
    return NextResponse.json({ ok: false, error: { message: "Account not found" } }, { status: 404 });
  }
  if (account.status === "INACTIVE") {
    return NextResponse.json({ ok: false, error: { message: "Account is already inactive" } }, { status: 409 });
  }

  const now = new Date().toISOString();
  await supabase
    .from("trading_accounts")
    .update({ status: "INACTIVE", deactivated_at: now, updated_at: now })
    .eq("id", accountId);

  let providerResult: "undeployed" | "no_provider" | "skipped" | "error" = "no_provider";
  let providerError: string | null = null;

  if (account.provider_account_id) {
    const adapter = createBrokerAdapter();
    if (adapter.executionAvailable()) {
      try {
        if ("deactivateAccount" in adapter && typeof adapter.deactivateAccount === "function") {
          await adapter.deactivateAccount(account.provider_account_id);
        }
        providerResult = "undeployed";
      } catch (err) {
        providerError = err instanceof Error ? err.message.slice(0, 300) : "Unknown error";
        providerResult = "error";
      }
    } else {
      providerResult = "skipped";
      providerError = "BROKER_EXECUTION_ENABLED is false — MetaAPI undeploy skipped.";
    }
  }

  await logBrokerOperation({
    accountId,
    userId: account.user_id,
    operation: "DEACTIVATE_ACCOUNT",
    status: providerResult === "error" ? "FAILED" : "SUCCESS",
    safeMetadata: { providerResult, providerError, providerAccountId: account.provider_account_id },
  });

  return NextResponse.json({
    ok: true,
    data: { accountId, status: "INACTIVE", providerResult, providerError },
  });
}
