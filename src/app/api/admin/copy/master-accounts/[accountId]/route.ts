import { z } from "zod";
import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { AuthError, requireAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";

const updateSchema = z.object({
  accountName: z.string().trim().min(2).max(100),
  brokerName: z.string().trim().min(2).max(100),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { accountId } = await params;
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonFail(
        "VALIDATION_ERROR",
        parsed.error.issues.map((issue) => issue.message).join(", "),
        400,
      );
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("trading_accounts")
      .update({
        account_name: parsed.data.accountName,
        broker_name: parsed.data.brokerName,
        currency: parsed.data.currency,
        updated_at: new Date().toISOString(),
      })
      .eq("id", accountId)
      .eq("user_id", admin.id)
      .eq("account_usage", "COPY_MASTER")
      .select("id, account_name, broker_name, currency")
      .maybeSingle();
    if (error) return jsonFail("MASTER_UPDATE_FAILED", error.message, 500);
    if (!data) return jsonFail("MASTER_NOT_FOUND", "Copy-master account was not found.", 404);

    await writeAuditLog({
      actorUserId: admin.id,
      action: "COPY_MASTER_UPDATED",
      entityType: "trading_account",
      entityId: accountId,
      metadata: {
        accountName: parsed.data.accountName,
        brokerName: parsed.data.brokerName,
        currency: parsed.data.currency,
      },
    });
    return jsonOk(data);
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { accountId } = await params;
    const supabase = createAdminClient();
    const { data: account, error: accountError } = await supabase
      .from("trading_accounts")
      .select("id, account_name, status, provider_account_id")
      .eq("id", accountId)
      .eq("user_id", admin.id)
      .eq("account_usage", "COPY_MASTER")
      .maybeSingle();
    if (accountError) return jsonFail("MASTER_DELETE_FAILED", accountError.message, 500);
    if (!account) return jsonFail("MASTER_NOT_FOUND", "Copy-master account was not found.", 404);
    if (account.provider_account_id) {
      return jsonFail(
        "MASTER_CONNECTED",
        "A provider-linked master account cannot be deleted. Keep it inactive for audit history.",
        409,
      );
    }

    const { count, error: strategyError } = await supabase
      .from("copy_strategies")
      .select("id", { count: "exact", head: true })
      .eq("master_account_id", accountId);
    if (strategyError) return jsonFail("MASTER_DELETE_FAILED", strategyError.message, 500);
    if ((count ?? 0) > 0) {
      return jsonFail(
        "MASTER_IN_USE",
        "Delete or archive this master's strategies before deleting the account.",
        409,
      );
    }

    const { error } = await supabase
      .from("trading_accounts")
      .delete()
      .eq("id", accountId)
      .eq("user_id", admin.id)
      .eq("account_usage", "COPY_MASTER");
    if (error) return jsonFail("MASTER_DELETE_FAILED", error.message, 500);

    await writeAuditLog({
      actorUserId: admin.id,
      action: "COPY_MASTER_DELETED",
      entityType: "trading_account",
      entityId: accountId,
      metadata: { accountName: account.account_name, priorStatus: account.status },
    });
    return jsonOk({ deleted: true });
  } catch (error) {
    if (error instanceof AuthError) return jsonFail(error.code, error.message, error.statusCode);
    throw error;
  }
}
