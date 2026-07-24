import { requireAuth } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/rbac";
import { getCertificateForDownload } from "@/lib/services/certificateService";
import { generateEvaluationCertificatePdf } from "@/lib/pdf/evaluationCertificatePdf";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireAuth();
  const { id } = await context.params;
  const certificate = await getCertificateForDownload(id, user.id, isAdmin(user.role));
  if (!certificate) return new Response("Certificate not found.", { status: 404 });
  const origin = new URL(request.url).origin;
  const pdf = await generateEvaluationCertificatePdf(certificate, origin);
  const safeName = certificate.holderName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "trader";
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="WSA-Global-Certificate-${safeName}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
