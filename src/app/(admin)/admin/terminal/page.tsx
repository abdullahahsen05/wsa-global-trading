"use client";

import Link from "next/link";
import { WorkspacePage } from "@/components/app/WorkspaceUI";
import { TerminalWorkspaceLazy } from "@/components/trading/TerminalWorkspaceLazy";

/**
 * The admin terminal is the SAME workspace the traders get on `/terminal`
 * (TradingView, MetaTrader web terminal, WSA Trade; tabs or split view): same
 * component, same options, same saved layout mechanism. Admins have no platform
 * subscription to activate, so there is no paywall in front of it. The market-data
 * provider settings that used to be this page live on `/admin/terminal/provider`.
 */
export default function AdminTerminalPage() {
  return (
    <WorkspacePage
      eyebrow="Terminal"
      title="Trading Terminal"
      description="The same terminal your traders use: chart with TradingView, trade your MetaTrader accounts in the web terminal, place orders from WSA Trade, or keep them open side by side."
      action={
        <Link href="/admin/terminal/provider" className="btn-dark text-xs">
          Market data provider settings
        </Link>
      }
    >
      <TerminalWorkspaceLazy />
    </WorkspacePage>
  );
}
