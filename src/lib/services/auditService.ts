import { createAdminClient } from "@/lib/supabase/admin";

// ─────────────────────────────────────────────────────────────────────────────
// Audit Service
//
// All writes go through the service-role admin client, which bypasses RLS.
// This is intentional: the audit_logs table has NO client-facing INSERT policy
// (dropped in migration 003). Only this server-side function — or other
// service-role code — can insert audit records.
//
// Never pass secrets, passwords, or encrypted_reference values in metadata.
// ─────────────────────────────────────────────────────────────────────────────

export type AuditAction =
  | "USER_STATUS_CHANGED"
  | "USER_ROLE_CHANGED"
  | "ACCOUNT_CONNECTED"
  | "ACCOUNT_DISCONNECTED"
  | "ACCOUNT_RESTRICTED"
  | "ACCOUNT_VERIFIED"
  | "RISK_RULE_CREATED"
  | "RISK_RULE_UPDATED"
  | "RISK_EVENT_CREATED"
  | "RISK_EVENT_ACKNOWLEDGED"
  | "CRM_NOTE_CREATED"
  | "SUBSCRIPTION_UPDATED"
  | "BROKER_CREDENTIALS_STORED"
  | "BROKER_CONNECTION_VERIFIED"
  | "BROKER_PROVIDER_CREATED"
  | "BROKER_PROVIDER_UPDATED"
  | "BROKER_SERVER_CREATED"
  | "BROKER_SERVER_UPDATED"
  | "ACCOUNT_SYNC_TRIGGERED"
  | "ACCOUNT_SYNC_COMPLETED"
  | "ACCOUNT_SYNC_FAILED"
  | "ECONOMIC_EVENT_CREATED"
  | "ECONOMIC_EVENT_UPDATED"
  | "ECONOMIC_EVENT_DELETED"
  | "CONTACT_REQUEST_CREATED"
  | "CONTACT_REQUEST_UPDATED"
  | "PASSKEY_REGISTERED"
  | "PASSKEY_REVOKED"
  | "PASSKEY_LOGIN"
  | "AI_LIMITS_UPDATED"
  | "AI_ACCESS_CHANGED"
  | "AI_PROVIDER_KEY_UPDATED"
  | "AI_PROVIDER_VALIDATED"
  | "AI_PROVIDER_ACTIVATED"
  | "AI_PROVIDER_KEY_DELETED"
  | "PARTNER_ASSIGNED"
  | "PARTNER_UNASSIGNED"
  | "PARTNER_APPROVED"
  | "PARTNER_REJECTED"
  | "PARTNER_COMMISSION_CREATED"
  | "PARTNER_COMMISSION_STATUS_CHANGED"
  | "PARTNER_REBATE_CREATED"
  | "PARTNER_REBATE_STATUS_CHANGED"
  | "COPY_STRATEGY_CREATED"
  | "COPY_STRATEGY_UPDATED"
  | "COPY_SETTINGS_CHANGED"
  | "COPY_ACCOUNT_RULES_CHANGED"
  | "COPY_MASTER_MONITORED"
  | "COPY_SIMULATED"
  | "COPY_LIVE_ATTEMPTED"
  | "COPY_FOLLOWER_CHANGED"
  | "SELF_COPY_CREATED"
  | "SELF_COPY_UPDATED"
  | "SELF_COPY_SIMULATED"
  | "JOB_ENQUEUED"
  | "JOB_CANCELLED"
  | "JOB_RETRIED"
  | "WORKER_RUN"
  | "BOT_ACCESS_REQUESTED"
  | "BOT_ACCESS_GRANTED"
  | "BOT_ACCESS_REVOKED"
  | "BOT_ACCESS_SUSPENDED"
  | "BOT_LICENSE_ISSUED"
  | "BOT_LICENSE_REVOKED"
  | "BOT_LICENSE_REISSUED"
  | "BOT_PRODUCT_CREATED"
  | "BOT_PRODUCT_UPDATED"
  | "BOT_RELEASE_UPLOADED"
  | "BOT_FILE_DOWNLOADED"
  | "ACADEMY_COURSE_CREATED"
  | "ACADEMY_COURSE_UPDATED"
  | "ACADEMY_MODULE_CREATED"
  | "ACADEMY_MODULE_UPDATED"
  | "ACADEMY_LESSON_CREATED"
  | "ACADEMY_LESSON_UPDATED"
  | "ACADEMY_REMARK_ADDED"
  | "ACADEMY_MATERIAL_ADDED"
  | "ACADEMY_QUESTION_ANSWERED"
  | "ACADEMY_WEBINAR_CREATED"
  | "ACADEMY_WEBINAR_UPDATED"
  | "EVAL_PROGRAM_CREATED"
  | "EVAL_PROGRAM_UPDATED"
  | "EVAL_ATTEMPT_STARTED"
  | "EVAL_ACCOUNT_LINKED"
  | "EVAL_ATTEMPT_CHECKED"
  | "EVAL_ATTEMPT_OVERRIDDEN"
  | "EVAL_CERTIFICATE_ISSUED"
  | "EVAL_CERTIFICATE_REVOKED"
  | "TERMINAL_SETTINGS_UPDATED"
  | "PAYMENT_ACCESS_APPROVED"
  | "SUBSCRIPTION_CANCELLED"
  | "PARTNER_COMMISSION_APPROVED"
  | "PARTNER_PAYOUT_MARKED_PAID"
  | "PARTNER_WITHDRAWAL_REQUESTED"
  | "PARTNER_WITHDRAWAL_APPROVED"
  | "PARTNER_WITHDRAWAL_REJECTED"
  | "PARTNER_WITHDRAWAL_PAID"
  | "ACCOUNT_DEACTIVATED"
  | "ACCOUNT_REACTIVATED";

export interface WriteAuditLogParams {
  /** UUID of the admin or service performing the action. Null for system jobs. */
  actorUserId: string | null;
  action: AuditAction;
  /** The type of entity being acted on, e.g. "profile", "trading_account" */
  entityType: string;
  /** UUID of the entity being acted on */
  entityId: string | null;
  /**
   * Additional context. Keep this minimal and NEVER include secrets,
   * passwords, or full credential objects.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Write a single audit log entry.
 * Silently swallows errors so that a logging failure never breaks the
 * primary business operation. Errors are console-logged for observability.
 */
export async function writeAuditLog(params: WriteAuditLogParams): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("audit_logs").insert({
      actor_user_id: params.actorUserId,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId,
      metadata: params.metadata ?? null,
    });

    if (error) {
      console.error("[auditService] Failed to write audit log:", error.message, params);
    }
  } catch (err) {
    console.error("[auditService] Unexpected error writing audit log:", err, params);
  }
}
