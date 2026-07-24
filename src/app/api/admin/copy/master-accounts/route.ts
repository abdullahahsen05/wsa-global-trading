import { z } from "zod";
import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireAdmin } from "@/lib/auth/session";
import { createTradingAccount } from "@/lib/services/tradingAccountService";
import { createAdminClient } from "@/lib/supabase/admin";

const createSchema = z.object({
  accountName: z.string().trim().min(2).max(100),
  brokerName: z.string().trim().min(2).max(100),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default("USD"),
});

export async function GET() {
  try {
    const admin = await requireAdmin();
    const { data, error } = await createAdminClient()
      .from("trading_accounts")
      .select("id, account_name, broker_name, broker_server, broker_platform, status, provider_account_id, last_synced_at, currency")
      .eq("user_id", admin.id)
      .eq("account_usage", "COPY_MASTER")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Master accounts could not be loaded: ${error.message}`);
    return jsonOk((data ?? []).map((row) => ({
      accountId: row.id,
      accountName: row.account_name,
      brokerName: row.broker_name,
      serverName: row.broker_server,
      platform: row.broker_platform,
      status: row.status,
      providerAccountId: row.provider_account_id,
      lastSyncedAt: row.last_synced_at,
      currency: row.currency,
    })));
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonFail("VALIDATION_ERROR", parsed.error.issues.map((issue) => issue.message).join(", "), 400);
    const account = await createTradingAccount(admin.id, parsed.data);
    const { error } = await createAdminClient()
      .from("trading_accounts")
      .update({ account_usage: "COPY_MASTER" })
      .eq("id", account.accountId)
      .eq("user_id", admin.id);
    if (error) throw new Error(`Master-account role could not be saved: ${error.message}`);
    return jsonOk(account, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    throw error;
  }
}
