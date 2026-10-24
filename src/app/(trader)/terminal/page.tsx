"use client";

import { Panel, WorkspacePage } from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { TerminalWorkspaceLazy } from "@/components/trading/TerminalWorkspaceLazy";
import { usePlatformGate } from "@/hooks/useTraderAccessSummary";

export default function TerminalPage() {
  const { access, checking } = usePlatformGate();

  if (checking) {
    return (
      <WorkspacePage eyebrow="Terminal" title="Trading Terminal" description="Loading your platform access status.">
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (access.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Terminal"
        title="Trading Terminal"
        description="Activate your platform subscription to unlock the trading terminal workspace."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock the trading terminal: the TradingView chart, the MetaTrader 4 web terminal, and WSA Assistant chart review."
        />
      </WorkspacePage>
    );
  }

  return <TerminalContent />;
}

function TerminalContent() {
  return (
    <WorkspacePage
      eyebrow="Terminal"
      title="Trading Terminal"
      description="Chart with TradingView, sign in to your MetaTrader 4 account in the web terminal, place orders from WSA Trade, or keep them open side by side. Ask WSA Assistant for chart review from the same workspace."
    >
      <TerminalWorkspaceLazy />
    </WorkspacePage>
  );
}
