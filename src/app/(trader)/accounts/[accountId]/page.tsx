import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { InlineStatusStrip, WorkspacePage } from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { AccountConnectionActions } from "@/components/accounts/AccountConnectionActions";
import { BrokerConnectPanel } from "@/components/accounts/BrokerConnectPanel";
import { LiveAccountTradesTable } from "@/components/accounts/LiveAccountTradesTable";
import { requireAuth } from "@/lib/auth/session";
import { getPlatformSubscriptionAccess } from "@/lib/services/billingService";
import { formatMoney, formatPercent } from "@/lib/utils/format";
import type { TraderAccountSummary } from "@/lib/domain/types";

async function fetchAccount(accountId: string): Promise<TraderAccountSummary | null> {
  try {
    const cookieStore = await cookies();
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/api/trading-accounts/${accountId}`,
      {
        headers: { Cookie: cookieStore.toString() },
        cache: "no-store",
      },
    );
    const json = await res.json();
    return json.ok ? json.data : null;
  } catch {
    return null;
  }
}

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const user = await requireAuth();
  const platformAccess = await getPlatformSubscriptionAccess(user.id);

  if (platformAccess.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Account detail"
        title="Account detail"
        description="Activate your platform subscription to unlock broker account details and analytics."
      >
        <PlatformSubscriptionLocked
          access={platformAccess}
          description="Activate the WSA Global platform subscription to unlock account detail views, broker status, and account performance history."
        />
      </WorkspacePage>
    );
  }

  const { accountId } = await params;
  const account = await fetchAccount(accountId);

  if (!account) notFound();

  return (
    <WorkspacePage
      eyebrow="Account detail"
      title={account.accountName}
      description="Connection status, latest account state, sync readiness, and recent activity for this trading account."
      action={<AccountConnectionActions accountName={account.accountName} status={account.status} compact />}
    >
      <InlineStatusStrip
        items={[
          {
            label: "Balance",
            value: formatMoney(account.balance),
            helper:
              [account.brokerName, account.platform, account.serverName].filter(Boolean).join(" · ") ||
              "Broker details pending",
          },
          { label: "Equity", value: formatMoney(account.equity), helper: "Latest snapshot", tone: "lime" },
          {
            label: "Floating PnL",
            value: formatMoney(account.floatingPnl),
            helper: `${account.openTradeCount} open trades`,
            tone: account.floatingPnl.amount >= 0 ? "accent" : "danger",
          },
          { label: "Drawdown", value: formatPercent(account.drawdownPercent), helper: "Current max" },
        ]}
      />

      <div className="mt-5">
        <BrokerConnectPanel accountId={accountId} />
      </div>

      <div className="mt-5">
        <LiveAccountTradesTable accountId={accountId} />
      </div>
    </WorkspacePage>
  );
}
