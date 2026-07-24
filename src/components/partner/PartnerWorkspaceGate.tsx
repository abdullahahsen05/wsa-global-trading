"use client";

import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Panel, WorkspacePage } from "@/components/app/WorkspaceUI";
import type { PartnerProfileStatusDto } from "@/lib/partner/profile";

async function loadPartnerProfile(): Promise<PartnerProfileStatusDto> {
  const response = await fetch("/api/partner/profile");
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Partner profile could not be loaded.");
  return payload.data;
}

function AccessNotice({ title, description }: { title: string; description: string }) {
  return (
    <WorkspacePage eyebrow="Partner" title={title} description={description}>
      <Panel>
        <p className="text-sm leading-6 text-muted">
          Return to the partner overview for your current application status and next steps.
        </p>
      </Panel>
    </WorkspacePage>
  );
}

export function PartnerWorkspaceGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isOverview = pathname === "/partner";
  const { data, isLoading, isError } = useQuery<PartnerProfileStatusDto>({
    queryKey: ["partner", "profile"],
    queryFn: loadPartnerProfile,
    retry: false,
  });

  // The overview owns the detailed pending/incomplete/error presentation.
  if (isOverview) return children;

  if (isLoading) {
    return (
      <WorkspacePage eyebrow="Partner" title="Partner workspace" description="Checking your partner access.">
        <div className="h-24 animate-pulse rounded-[4px] border border-line bg-panel" />
      </WorkspacePage>
    );
  }

  if (isError) {
    return (
      <AccessNotice
        title="Partner setup unavailable"
        description="Your partner profile could not be loaded. No trader or commission data was requested."
      />
    );
  }

  if (!data?.setupComplete) {
    return (
      <AccessNotice
        title="Partner setup incomplete"
        description="Your account has the partner role, but its partner profile still needs to be provisioned."
      />
    );
  }

  if (data.status === "PENDING_REVIEW") {
    return (
      <AccessNotice
        title="Partner application under review"
        description="Trader, commission, CRM, and payout tools become available after approval."
      />
    );
  }

  if (data.status === "SUSPENDED") {
    return (
      <AccessNotice
        title="Partner access paused"
        description="This partner profile is suspended. Contact an administrator to review access."
      />
    );
  }

  return children;
}
