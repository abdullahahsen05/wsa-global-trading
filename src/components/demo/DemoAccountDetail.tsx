"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  DataTable,
  InlineStatusStrip,
  Panel,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { DemoModeBanner } from "@/components/demo/DemoModeBanner";
import {
  demoAccountConnectionNotes,
  demoAccounts,
  demoAccountSnapshots,
  demoTrades,
} from "@/lib/demo/demoData";

export function DemoAccountDetail({ accountId }: { accountId: string }) {
  const account = demoAccounts.find((entry) => entry.id === accountId);

  if (!account) {
    notFound();
  }

  const accountTrades = demoTrades.filter((trade) => trade.account === account.name);
  const snapshots = demoAccountSnapshots[account.id] ?? [];

  return (
    <WorkspacePage
      eyebrow="Account detail"
      title={account.name}
      description="Connection status, latest account state, sync readiness, and recent activity for this trading account."
      action={<Link href="/demo/accounts" className="btn-dark">Back to accounts</Link>}
    >
      <DemoModeBanner />
      <InlineStatusStrip
        items={[
          { label: "Balance", value: account.balance, helper: account.broker },
          { label: "Equity", value: account.equity, helper: "Latest snapshot", tone: "lime" },
          { label: "Floating PnL", value: "$1,640", helper: `${accountTrades.filter((trade) => trade.status === "OPEN").length} open trades`, tone: "accent" },
          { label: "Drawdown", value: account.drawdown, helper: "Current max" },
        ]}
      />

      <div className="mt-5">
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Broker connection</h2>
              <p className="mt-1 text-sm text-muted">
                {demoAccountConnectionNotes[account.id]}
              </p>
            </div>
            <StatusPill tone={account.status === "CONNECTED" ? "lime" : "accent"}>{account.status}</StatusPill>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Account number</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{account.accountNumber}</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Leverage</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{account.leverage}</p>
            </div>
            <div className="rounded-[4px] border border-line bg-background px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Copy tier</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{account.copyTier}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" disabled className="btn-dark cursor-not-allowed opacity-60">
              Connect unavailable in demo
            </button>
            <button type="button" disabled className="btn-dark cursor-not-allowed opacity-60">
              Sync unavailable in demo
            </button>
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[0.62fr_0.38fr]">
        <Panel>
          <h2 className="text-lg font-semibold text-foreground">Recent trades</h2>
          <div className="mt-4">
            <DataTable
              headers={["Symbol", "Side", "Status", "Volume", "Profit", "Opened"]}
              rows={accountTrades.map((trade) => [
                <span key="symbol" className="font-semibold text-foreground">{trade.symbol}</span>,
                trade.side,
                <StatusPill key="status" tone={trade.status === "OPEN" ? "accent" : "muted"}>{trade.status}</StatusPill>,
                trade.size,
                <span key="profit" className={trade.pnl.startsWith("-") ? "font-semibold text-danger" : "font-semibold text-accent-2"}>
                  {trade.pnl}
                </span>,
                trade.openedAt,
              ])}
            />
          </div>
        </Panel>
        <Panel>
          <h2 className="text-lg font-semibold text-foreground">Snapshot feed</h2>
          <div className="mt-4 space-y-3">
            {snapshots.map((snapshot) => (
              <div key={snapshot.capturedAt} className="flex items-center justify-between rounded-[4px] border border-line bg-background p-3 text-sm">
                <span className="text-muted">{snapshot.capturedAt}</span>
                <span className="font-semibold text-accent-2">{snapshot.equity}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
