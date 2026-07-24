"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, Panel, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import type { CertificateDto } from "@/lib/services/certificateService";

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

export default function MyCertificatesPage() {
  const {
    data: certs = [],
    isLoading,
    isError,
    error,
  } = useQuery<CertificateDto[]>({
    queryKey: ["my-certificates"],
    queryFn: () => apiFetch("/api/evaluations/certificates"),
  });

  return (
    <WorkspacePage
      eyebrow="Certification"
      title="My Certificates"
      description="Verified certificates earned from passed evaluations"
      action={
        <Link href="/evaluations" className="text-sm text-muted-foreground hover:text-foreground">
          ‹ All Evaluations
        </Link>
      }
    >
      {isLoading && (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      )}
      {isError && (
        <div className="py-16 text-center text-sm text-danger">{(error as Error).message}</div>
      )}
      {!isLoading && !isError && certs.length === 0 && (
        <EmptyState
          icon={undefined}
          title="No certificates yet"
          description="Complete and pass an evaluation program to earn a verified certificate."
        />
      )}

      <div className="space-y-4">
        {certs.map((cert) => (
          <Panel key={cert.id}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{cert.programName}</span>
                  <StatusPill tone={cert.status === "VALID" ? "lime" : "danger"}>
                    {cert.status}
                  </StatusPill>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Issued: {new Date(cert.issuedAt).toLocaleDateString()}
                </p>
                <p className="font-mono text-xs text-muted-foreground">ID: {cert.verificationId}</p>
                {cert.status === "REVOKED" && cert.revocationReason && (
                  <p className="mt-1 text-xs text-danger">Revoked: {cert.revocationReason}</p>
                )}
              </div>
              <div className="flex gap-2">
                {cert.status === "VALID" && (
                  <a
                    href={`/api/evaluations/certificates/${cert.id}/download`}
                    className="rounded-[4px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:opacity-90"
                  >
                    Download PDF
                  </a>
                )}
                <Link
                  href={`/certificates/verify/${cert.verificationId}`}
                  target="_blank"
                  className="rounded-[4px] border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  Verify
                </Link>
              </div>
            </div>
          </Panel>
        ))}
      </div>
    </WorkspacePage>
  );
}
