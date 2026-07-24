import { BrandLogo } from "@/components/app/BrandLogo";
import type { PublicCertificateDto } from "@/lib/services/certificateService";
import { verifyCertificateByVerificationId } from "@/lib/services/certificateService";

// Server component — no auth required. Only safe fields exposed.
export default async function PublicCertificateVerifyPage({
  params,
}: {
  params: Promise<{ verificationId: string }>;
}) {
  const { verificationId } = await params;

  let cert: PublicCertificateDto | null = null;
  let loadError: string | null = null;

  try {
    cert = await verifyCertificateByVerificationId(verificationId);
  } catch {
    loadError = "Unable to verify certificate at this time.";
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandLogo className="h-14 w-auto max-w-[190px]" priority />
          <p className="mt-1 text-xs text-muted-foreground">Certificate Verification</p>
        </div>

        {loadError && (
          <div className="rounded-[4px] border border-destructive/30 bg-destructive/10 p-6 text-center">
            <p className="text-sm text-destructive">{loadError}</p>
          </div>
        )}

        {!loadError && !cert && (
          <div className="rounded-[4px] border border-border p-8 text-center">
            <div className="mb-3 text-3xl">&#x26D4;</div>
            <h1 className="mb-2 text-lg font-semibold text-foreground">Certificate Not Found</h1>
            <p className="text-sm text-muted-foreground">
              No certificate exists with verification ID{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">{verificationId}</code>.
            </p>
          </div>
        )}

        {cert && (
          <div
            className={`rounded-[4px] border p-8 ${
              cert.status === "VALID"
                ? "border-lime-400/30 bg-lime-950/10"
                : "border-destructive/30 bg-destructive/10"
            }`}
          >
            {/* Status badge */}
            <div className="mb-6 flex items-center justify-between">
              <span
                className={`rounded-[4px] px-3 py-1 text-xs font-semibold ${
                  cert.status === "VALID"
                    ? "bg-lime-400/20 text-lime-400"
                    : "bg-destructive/20 text-destructive"
                }`}
              >
                {cert.status === "VALID" ? "VERIFIED" : "REVOKED"}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{cert.verificationId}</span>
            </div>

            {cert.status === "VALID" ? (
              <>
                <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Certificate of Achievement
                </div>
                <div className="mb-4 text-2xl font-bold text-foreground">{cert.holderDisplayName}</div>
                <p className="mb-1 text-sm text-muted-foreground">
                  has successfully completed the evaluation:
                </p>
                <div className="mb-6 text-lg font-semibold text-foreground">{cert.programName}</div>
                <div className="border-t border-border pt-4">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Issued by WSA Global Trading Platform</span>
                    <span>{new Date(cert.issuedAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <h1 className="mb-2 text-lg font-semibold text-destructive">Certificate Revoked</h1>
                <p className="mb-4 text-sm text-muted-foreground">
                  This certificate for <strong>{cert.holderDisplayName}</strong> ({cert.programName}) has been revoked.
                </p>
                <div className="text-xs text-muted-foreground">
                  <span>Originally issued: {new Date(cert.issuedAt).toLocaleDateString()}</span>
                  {cert.revokedAt && (
                    <span className="ml-4">Revoked: {new Date(cert.revokedAt).toLocaleDateString()}</span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          WSA Global Trading Platform &mdash; {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}
