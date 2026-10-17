"use client";

import Link from "next/link";
import { WorkspacePage } from "@/components/app/WorkspaceUI";
import { MarketDataProviderSettings } from "@/components/admin/MarketDataProviderSettings";

export default function AdminMarketDataProviderPage() {
  return (
    <WorkspacePage
      eyebrow="Terminal"
      title="Market Data Provider"
      description="Provider configuration, environment readiness, and integration notes for the institutional data terminal"
      action={
        <Link href="/admin/terminal" className="btn-dark text-xs">
          Back to the trading terminal
        </Link>
      }
    >
      <MarketDataProviderSettings />
    </WorkspacePage>
  );
}
