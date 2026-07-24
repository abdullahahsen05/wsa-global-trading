import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { DataTable, InlineStatusStrip, Panel, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { AccountConnectionActions } from "@/components/accounts/AccountConnectionActions";
import { BrokerConnectPanel } from "@/components/accounts/BrokerConnectPanel";
import { requireAuth } from "@/lib/auth/session";
import { getPlatformSubscriptionAccess } from "@/lib/services/billingService";
import { formatMoney, formatPercent } from "@/lib/utils/format";
import type { TraderAccountSummary, TradeDto, EquityPoint } from "@/lib/domain/types";

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

async function fetchTrades(accountId: string): Promise<TradeDto[]> {
  try {
    const cookieStore = await cookies();
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/api/trades?accountId=${accountId}`,
      {
        headers: { Cookie: cookieStore.toString() },
        cache: "no-store",
      },
    );
    const json = await res.json();
    return json.ok ? json.data : [];
  } catch {
    return [];
  }
}

async function fetchEquityCurve(accountId: string): Promise<EquityPoint[]> {
  try {
    const cookieStore = await cookies();
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/api/analytics/equity-curve?accountId=${accountId}`,
      {
        headers: { Cookie: cookieStore.toString() },
        cache: "no-store",
      },
    );
    const json = await res.json();
    return json.ok ? json.data : [];
  } catch {
    return [];
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
  const [account, accountTrades, equityCurveData] = await Promise.all([
    fetchAccount(accountId),
    fetchTrades(accountId),
    fetchEquityCurve(accountId),
  ]);

  if (!account) notFound();

  const latestSnapshots = equityCurveData.slice(-7).reverse();

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

      <div className="mt-5 grid gap-4 xl:grid-cols-[0.62fr_0.38fr]">
        <Panel>
          <h2 className="text-lg font-semibold text-foreground">Recent trades</h2>
          <div className="mt-4">
            <DataTable
              headers={["Trade ID", "Symbol", "Side", "Status", "Profit", "Close price", "Closed"]}
              paginated
              initialPageSize={10}
              rows={accountTrades.map((trade) => [
                <span key="trade-id" className="font-mono text-xs text-muted">{trade.shortTradeId}</span>,
                <span key="symbol" className="font-semibold text-foreground">{trade.symbol}</span>,
                trade.side,
                <StatusPill key="status" tone={trade.status === "OPEN" ? "accent" : "muted"}>{trade.status}</StatusPill>,
                <span key="profit" className={trade.profit.amount >= 0 ? "font-semibold text-accent-2" : "font-semibold text-danger"}>{formatMoney(trade.profit)}</span>,
                trade.closePrice ?? "—",
                trade.closedAt ? new Date(trade.closedAt).toLocaleString() : "—",
              ])}
            />
          </div>
        </Panel>
        <Panel>
          <h2 className="text-lg font-semibold text-foreground">Snapshot feed</h2>
          <div className="mt-4 space-y-3">
            {latestSnapshots.length > 0 ? (
              latestSnapshots.map((snapshot) => (
                <div key={snapshot.capturedAt} className="flex items-center justify-between rounded-[4px] border border-line bg-background p-3 text-sm">
                  <span className="text-muted">{new Date(snapshot.capturedAt).toLocaleString()}</span>
                  <span className="font-semibold text-accent-2">${snapshot.equity.toLocaleString()}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted">No snapshots available yet.</p>
            )}
          </div>
        </Panel>
      </div>

    </WorkspacePage>
  );
}
