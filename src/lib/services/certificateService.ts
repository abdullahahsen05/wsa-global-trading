if (typeof window !== "undefined") {
  throw new Error("[aurix] certificateService is server-only.");
}

import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/services/auditService";

// ─────────────────────────────────────────────────────────────────────────────
// Certificate Service
// Only issues certificates for PASSED attempts. Never fakes a pass.
// ─────────────────────────────────────────────────────────────────────────────

export interface CertificateDto {
  id: string;
  attemptId: string;
  programId: string;
  userId: string;
  verificationId: string;
  status: "VALID" | "REVOKED";
  issuedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
  pdfUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  // Joined
  programName: string;
  holderName: string;
}

export interface PublicCertificateDto {
  verificationId: string;
  status: "VALID" | "REVOKED";
  holderDisplayName: string;
  programName: string;
  issuedAt: string;
  revokedAt: string | null;
}

function generateVerificationId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "WSA-";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export async function getCertificateForDownload(
  certificateId: string,
  requesterId: string,
  requesterIsAdmin: boolean,
): Promise<CertificateDto | null> {
  const supabase = createAdminClient();
  let query = supabase
    .from("evaluation_certificates")
    .select("*, evaluation_programs(name), profiles(full_name, email)")
    .eq("id", certificateId);
  if (!requesterIsAdmin) query = query.eq("user_id", requesterId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const program = row.evaluation_programs as Record<string, unknown> | null;
  const profile = row.profiles as Record<string, unknown> | null;
  const holderName = (profile?.full_name as string | null) ?? (profile?.email as string | null) ?? "Trader";
  return mapCertificate(row, holderName, (program?.name as string | null) ?? "Evaluation Program");
}

export async function issueCertificateForPassedAttempt(
  attemptId: string,
  actorUserId: string | null
): Promise<CertificateDto> {
  const supabase = createAdminClient();

  const { data: attempt } = await supabase
    .from("evaluation_attempts")
    .select("id, status, user_id, program_id, passed_at")
    .eq("id", attemptId)
    .maybeSingle();

  if (!attempt) throw new Error("ATTEMPT_NOT_FOUND");
  const a = attempt as Record<string, unknown>;
  if (a.status !== "PASSED") throw new Error("EVALUATION_NOT_PASSED");

  // Check for existing certificate
  const { data: existing } = await supabase
    .from("evaluation_certificates")
    .select("id")
    .eq("attempt_id", attemptId)
    .maybeSingle();
  if (existing) throw new Error("CERTIFICATE_ALREADY_EXISTS");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email")
    .eq("id", a.user_id as string)
    .maybeSingle();

  const { data: program } = await supabase
    .from("evaluation_programs")
    .select("name")
    .eq("id", a.program_id as string)
    .maybeSingle();

  const verificationId = generateVerificationId();
  const holderName = (profile as Record<string, unknown> | null)?.full_name as string | null
    ?? (profile as Record<string, unknown> | null)?.email as string | null
    ?? "Trader";
  const programName = (program as Record<string, unknown> | null)?.name as string ?? "Evaluation Program";

  const { data: cert, error } = await supabase
    .from("evaluation_certificates")
    .insert({
      attempt_id: attemptId,
      program_id: a.program_id as string,
      user_id: a.user_id as string,
      verification_id: verificationId,
      status: "VALID",
      metadata: {
        holderName,
        programName,
        passedAt: a.passed_at,
      },
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await writeAuditLog({
    actorUserId,
    action: "EVAL_CERTIFICATE_ISSUED",
    entityType: "evaluation_certificate",
    entityId: (cert as Record<string, unknown>).id as string,
    metadata: { verificationId, attemptId, userId: a.user_id },
  });

  return mapCertificate(cert as Record<string, unknown>, holderName, programName);
}

export async function getMyCertificates(userId: string): Promise<CertificateDto[]> {
  const supabase = createAdminClient();
  const [certsRes, profileRes] = await Promise.all([
    supabase
      .from("evaluation_certificates")
      .select("*, evaluation_programs(name)")
      .eq("user_id", userId)
      .order("issued_at", { ascending: false }),
    supabase.from("profiles").select("full_name, email").eq("id", userId).maybeSingle(),
  ]);
  if (certsRes.error) throw new Error(certsRes.error.message);
  const prof = profileRes.data as Record<string, unknown> | null;
  const holderName = (prof?.full_name as string | null) ?? (prof?.email as string | null) ?? "Trader";
  return (certsRes.data ?? []).map((c) => {
    const r = c as Record<string, unknown>;
    const prog = r.evaluation_programs as Record<string, unknown> | null;
    return mapCertificate(r, holderName, prog?.name as string ?? "");
  });
}

export async function adminListCertificates(): Promise<CertificateDto[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("evaluation_certificates")
    .select("*, evaluation_programs(name), profiles(full_name, email)")
    .order("issued_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((c) => {
    const r = c as Record<string, unknown>;
    const prog = r.evaluation_programs as Record<string, unknown> | null;
    const prof = r.profiles as Record<string, unknown> | null;
    const holderName = (prof?.full_name as string | null) ?? (prof?.email as string | null) ?? "Trader";
    return mapCertificate(r, holderName, prog?.name as string ?? "");
  });
}

export async function revokeCertificate(
  certificateId: string,
  reason: string,
  adminUserId: string
): Promise<CertificateDto> {
  if (!reason || reason.trim().length < 5) {
    throw new Error("Revocation reason is required (min 5 characters)");
  }
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("evaluation_certificates")
    .update({
      status: "REVOKED",
      revoked_at: new Date().toISOString(),
      revoked_by: adminUserId,
      revocation_reason: reason,
    })
    .eq("id", certificateId)
    .select("*, evaluation_programs(name), profiles(full_name, email)")
    .single();
  if (error) throw new Error(error.message);
  const r = data as Record<string, unknown>;
  const prog = r.evaluation_programs as Record<string, unknown> | null;
  const prof = r.profiles as Record<string, unknown> | null;
  const holderName = (prof?.full_name as string | null) ?? (prof?.email as string | null) ?? "Trader";

  await writeAuditLog({
    actorUserId: adminUserId,
    action: "EVAL_CERTIFICATE_REVOKED",
    entityType: "evaluation_certificate",
    entityId: certificateId,
    metadata: { reason, verificationId: r.verification_id },
  });

  return mapCertificate(r, holderName, prog?.name as string ?? "");
}

export async function verifyCertificateByVerificationId(
  verificationId: string
): Promise<PublicCertificateDto | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("evaluation_certificates")
    .select("verification_id, status, issued_at, revoked_at, metadata, evaluation_programs(name)")
    .eq("verification_id", verificationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const prog = r.evaluation_programs as Record<string, unknown> | null;
  const meta = (r.metadata as Record<string, unknown>) ?? {};
  // Expose only safe fields — no email, no account details
  const holderName = (meta.holderName as string | null) ?? "Trader";
  return {
    verificationId: r.verification_id as string,
    status: r.status as "VALID" | "REVOKED",
    holderDisplayName: holderName,
    programName: prog?.name as string ?? (meta.programName as string ?? ""),
    issuedAt: r.issued_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

function mapCertificate(
  r: Record<string, unknown>,
  holderName: string,
  programName: string
): CertificateDto {
  return {
    id: r.id as string,
    attemptId: r.attempt_id as string,
    programId: r.program_id as string,
    userId: r.user_id as string,
    verificationId: r.verification_id as string,
    status: r.status as "VALID" | "REVOKED",
    issuedAt: r.issued_at as string,
    revokedAt: (r.revoked_at as string | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
    revocationReason: (r.revocation_reason as string | null) ?? null,
    pdfUrl: (r.pdf_url as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
    holderName,
    programName,
  };
}
