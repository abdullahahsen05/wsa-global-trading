"use client";

import Link from "next/link";
import { useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  ImagePlus,
  Plus,
  Send,
  Sparkles,
  Users,
} from "lucide-react";
import {
  DataTable,
  EmptyState,
  FilterChipRow,
  GhostButton,
  InlineStatusStrip,
  Panel,
  PageActionGroup,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SearchField, SelectField, TextAreaField } from "@/components/app/FormFields";
import { DemoModeBanner } from "@/components/demo/DemoModeBanner";
import { DashboardKpiStrip, MarketSentimentStrip } from "@/components/dashboard/DashboardKpiStrip";
import { PerformanceRings } from "@/components/dashboard/PerformanceRings";
import {
  getDemoSectionConfig,
  type DemoSectionConfig,
  type DemoSectionSlug,
} from "@/lib/demo/config";
import {
  demoAccounts,
  demoAiCards,
  demoAiConversation,
  demoAiPrompts,
  demoBotLicenses,
  demoBots,
  demoCopyLogs,
  demoCopyStrategies,
  demoCopySubscriptions,
  demoCourses,
  demoDashboardKpis,
  demoDashboardRings,
  demoDashboardSentiment,
  demoEvaluationPrograms,
  demoMarketPlaceFilters,
  demoTerminalWidgets,
} from "@/lib/demo/demoData";

function DemoPrimaryActions() {
  return (
    <div className="flex flex-wrap gap-2">
      <Link href="/register" className="btn-dark btn-active">
        Create account
      </Link>
      <Link href="/login" className="btn-dark">
        Back to login
      </Link>
    </div>
  );
}

function DemoDisabledButton({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      className={`btn-dark cursor-not-allowed opacity-60 ${className}`}
      title="Demo mode uses sample data. Create an account to use this feature."
    >
      {children}
    </button>
  );
}

function DemoOnlyHint({ text = "Demo mode uses sample data. Create an account to use this feature." }: { text?: string }) {
  return <p className="mt-2 text-xs text-muted">{text}</p>;
}

function DemoTradingChartSection() {
  const [timeframe, setTimeframe] = useState<"1m" | "5m" | "15m" | "1H" | "4H" | "1D">("15m");
  const bars = [42, 48, 44, 57, 54, 66, 62, 73, 70, 81, 88, 84];

  return (
    <section className="section-surface overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="status-pill px-3 py-1 text-xs">XAUUSD</span>
            <span className="text-xs font-medium text-muted">Demo chart preview</span>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
            <h3 className="text-lg font-semibold text-foreground">Advanced chart</h3>
            <p className="text-sm text-muted">Read-only market structure preview using sample data.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["1m", "5m", "15m", "1H", "4H", "1D"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTimeframe(item)}
              className={`btn-dark h-9 px-4 text-xs ${timeframe === item ? "btn-active" : ""}`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_240px]">
        <div className="inner-surface flex h-[520px] items-end gap-2 overflow-hidden p-5">
          {bars.map((bar, index) => (
            <div key={index} className="flex flex-1 items-end gap-1">
              <div
                className={`w-full rounded-t-[4px] ${index % 3 === 0 ? "bg-danger/70" : "bg-accent/80"}`}
                style={{ height: `${bar}%` }}
              />
            </div>
          ))}
        </div>
        <div className="grid gap-3">
          <div className="inner-surface p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted">Data source</p>
            <div className="mt-3 flex items-center gap-3">
              <span className="inline-flex h-3 w-3 rounded-full bg-accent" />
              <div>
                <p className="text-sm font-semibold text-foreground">Demo market data</p>
                <p className="text-xs text-muted">No live feed, dxFeed, or broker API is used.</p>
              </div>
            </div>
          </div>
          <div className="inner-surface p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted">Trend</p>
            <div className="mt-3 flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-[4px] bg-accent/10 text-accent">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Bias is constructive</p>
                <p className="text-xs leading-5 text-muted">Price is holding above the sample session midline.</p>
              </div>
            </div>
          </div>
          <div className="inner-surface p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted">Chart controls</p>
            <p className="mt-3 text-sm leading-6 text-muted">
              Create an account to unlock live chart tools, broker-linked workflows, and professional data modules.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function DemoDashboardPage() {
  return (
    <WorkspacePage
      eyebrow="Trader workspace"
      title="Trading overview"
      description="Equity, risk, and performance across your connected accounts."
      action={
        <PageActionGroup>
          <select
            aria-label="Demo account selector"
            className="h-9 rounded-[4px] border border-line bg-background px-3 text-xs font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
            defaultValue={demoAccounts[0]?.id}
          >
            {demoAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          {["Current Equity", "Check Limits", "Profit Summary", "Calendar Tracker"].map((tab, index) => (
            <button key={tab} type="button" className={`btn-dark h-9 px-4 text-xs ${index === 0 ? "btn-active" : ""}`}>
              {tab}
            </button>
          ))}
        </PageActionGroup>
      }
    >
      <DemoModeBanner />
      <DashboardKpiStrip items={demoDashboardKpis} />
      <div className="mt-4">
        <MarketSentimentStrip items={demoDashboardSentiment} />
      </div>
      <Panel className="mt-4">
        <PerformanceRings items={demoDashboardRings} />
      </Panel>
      <div className="mt-4">
        <DemoTradingChartSection />
      </div>
    </WorkspacePage>
  );
}

function DemoAccountsPage() {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const filteredAccounts = demoAccounts.filter((account) => {
    const matchesQuery =
      query.trim().length === 0 ||
      account.name.toLowerCase().includes(query.toLowerCase()) ||
      account.broker.toLowerCase().includes(query.toLowerCase()) ||
      account.accountNumber.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = statusFilter === "ALL" || account.status === statusFilter;
    return matchesQuery && matchesStatus;
  });

  const connectedCount = demoAccounts.filter((account) => account.status === "CONNECTED").length;
  const pendingCount = demoAccounts.filter((account) => account.status === "PENDING").length;

  return (
    <WorkspacePage
      eyebrow="Trading accounts"
      title="Connected broker accounts"
      description="Track broker status, equity, drawdown, and connection health across your accounts."
      action={
        <PageActionGroup>
          <DemoDisabledButton>
            <Plus className="mr-2 inline-block h-4 w-4" />
            Connect account
          </DemoDisabledButton>
        </PageActionGroup>
      }
    >
      <DemoModeBanner />
      <InlineStatusStrip
        items={[
          { label: "Connected", value: connectedCount, helper: "Live adapter", tone: "lime" },
          { label: "Syncing", value: 0, helper: "Active sync", tone: "accent" },
          { label: "Pending", value: pendingCount, helper: "Awaiting verification" },
          { label: "Open exposure", value: "$1,640", helper: "Net floating PnL" },
        ]}
      />

      <div className="mt-5 flex flex-wrap items-end justify-between gap-4 rounded-[4px] border border-line bg-panel p-4">
        <div className="grid flex-1 gap-4">
          <SearchField
            label="Search accounts"
            placeholder="Search by account or broker"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <FilterChipRow
            chips={[
              { label: "All statuses", active: statusFilter === "ALL", onClick: () => setStatusFilter("ALL") },
              { label: "Connected", active: statusFilter === "CONNECTED", onClick: () => setStatusFilter("CONNECTED") },
              { label: "Pending", active: statusFilter === "PENDING", onClick: () => setStatusFilter("PENDING") },
            ]}
          />
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        {filteredAccounts.length === 0 ? (
          <div className="xl:col-span-2">
            <EmptyState
              title="No accounts match your filters"
              description="Try a different search term or reset the account filters."
              action={
                <GhostButton type="button" onClick={() => { setQuery(""); setStatusFilter("ALL"); }}>
                  Reset filters
                </GhostButton>
              }
            />
          </div>
        ) : (
          filteredAccounts.map((account) => (
            <Panel key={account.id} className="min-h-56">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-muted">{account.broker}</p>
                  <h2 className="mt-2 text-xl font-semibold text-foreground">{account.name}</h2>
                </div>
                <StatusPill tone={account.status === "CONNECTED" ? "lime" : "accent"}>
                  {account.status}
                </StatusPill>
              </div>
              <div className="mt-6 grid gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-xs font-semibold text-muted">Balance</p>
                  <p className="mt-2 font-semibold text-foreground">{account.balance}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted">Equity</p>
                  <p className="mt-2 font-semibold text-accent-2">{account.equity}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted">Floating PnL</p>
                  <p className="mt-2 font-semibold text-accent">{account.equity}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted">Drawdown</p>
                  <p className="mt-2 font-semibold text-foreground">{account.drawdown}</p>
                </div>
              </div>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <p className="text-sm text-muted">{account.accountNumber} · {account.sync}</p>
                <Link
                  href={`/demo/accounts/${account.id}`}
                  className="rounded-[4px] bg-panel-strong px-5 py-2 text-sm font-semibold text-accent transition "
                >
                  View details
                </Link>
              </div>
            </Panel>
          ))
        )}
      </div>
    </WorkspacePage>
  );
}

function DemoCopyTradingPage() {
  const [logStatusFilter, setLogStatusFilter] = useState<"ALL" | "SUCCESS" | "SKIPPED">("ALL");
  const filteredLogs =
    logStatusFilter === "ALL" ? demoCopyLogs : demoCopyLogs.filter((log) => log.status === logStatusFilter);

  return (
    <WorkspacePage
      eyebrow="Copy Trading"
      title="Copy Trading"
      description="Follow a master strategy on one of your connected accounts. You control pause and stop at any time."
    >
      <DemoModeBanner />
      <div className="mb-5 flex items-start gap-3 rounded-[4px] border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Trading involves substantial risk of loss. Copy trading is <strong>not a guarantee of profit</strong>. Demo mode never executes trades and only shows sample strategy activity.
        </p>
      </div>

      <Panel className="mb-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
              Per-account copy access
            </div>
            <p className="text-xs text-muted">
              Copy trading is billed per connected account after your platform subscription is active.
              Normal is $10/month per account and Ultra Fast is $15/month per account.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {demoAccounts.slice(0, 2).map((account, index) => (
              <span
                key={account.id}
                className="rounded-[4px] border border-lime/30 bg-lime/10 px-3 py-1 text-xs font-semibold text-lime"
              >
                {account.name}: {index === 0 ? "Ultra Fast" : "Normal"}
              </span>
            ))}
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {demoAccounts.map((account, index) => (
            <div key={account.id} className="rounded-[4px] border border-line bg-background p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">{account.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{account.broker} · {account.status}</p>
                </div>
                <StatusPill tone={index < 2 ? "lime" : "accent"}>
                  ACTIVE
                </StatusPill>
              </div>
              <p className="mt-3 text-xs text-muted">
                Copy access is active after verified payment.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <DemoDisabledButton className="justify-start rounded-[4px] p-4 text-left">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Normal</p>
                    <p className="mt-0.5 text-xs text-muted">Standard copy speed</p>
                    <p className="mt-2 text-sm font-semibold text-accent">$10 / month</p>
                  </div>
                </DemoDisabledButton>
                <DemoDisabledButton className="justify-start rounded-[4px] p-4 text-left">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Ultra Fast</p>
                    <p className="mt-0.5 text-xs text-muted">Lowest latency execution</p>
                    <p className="mt-2 text-sm font-semibold text-accent">$15 / month</p>
                  </div>
                </DemoDisabledButton>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel>
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-foreground">Available strategies</h2>
            <p className="mt-1 text-xs text-muted">Activate copy access on at least one account to start following strategies.</p>
          </div>
          <div className="space-y-3">
            {demoCopyStrategies.map((strategy) => (
              <div key={strategy.name} className="rounded-[4px] border border-line bg-background px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">{strategy.name}</p>
                  <StatusPill tone={strategy.mode === "SIMULATION" ? "muted" : "danger"}>{strategy.mode}</StatusPill>
                </div>
                <p className="mt-1 text-xs text-muted">{strategy.tier} · {strategy.followers} followers · ROI {strategy.roi}</p>
                <p className="mt-1 text-xs text-muted">Simulation mode - no real trades are placed.</p>
                <div className="mt-3">
                  <DemoDisabledButton>
                    Follow
                  </DemoDisabledButton>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className="min-w-0">
          <h2 className="mb-4 text-lg font-semibold text-foreground">My following</h2>
          <div className="space-y-3">
            {demoCopySubscriptions.map((sub) => (
              <div key={sub.id} className="rounded-[4px] border border-line bg-background px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{sub.strategyName}</p>
                    <p className="truncate text-xs text-muted">{sub.followerAccountName}</p>
                  </div>
                  <StatusPill tone={sub.status === "ACTIVE" ? "lime" : "accent"}>{sub.status}</StatusPill>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <StatusPill tone={sub.tier === "PREMIUM" ? "accent" : "muted"}>{sub.tier}</StatusPill>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <DemoDisabledButton>{sub.status === "ACTIVE" ? "Pause" : "Resume"}</DemoDisabledButton>
                  <DemoDisabledButton>Stop following</DemoDisabledButton>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel className="mt-5 min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">My copy logs</h2>
          <FilterChipRow
            chips={[
              { label: `All (${demoCopyLogs.length})`, active: logStatusFilter === "ALL", onClick: () => setLogStatusFilter("ALL") },
              { label: "SUCCESS", active: logStatusFilter === "SUCCESS", onClick: () => setLogStatusFilter("SUCCESS") },
              { label: "SKIPPED", active: logStatusFilter === "SKIPPED", onClick: () => setLogStatusFilter("SKIPPED") },
            ]}
          />
        </div>
        <DataTable
          headers={["Date", "Symbol", "Action", "Mode", "Lot", "Status"]}
          rows={filteredLogs.map((log) => [
            <span key="d">{log.date}</span>,
            <span key="s">{log.symbol}</span>,
            <span key="a">{log.action}</span>,
            <span key="m">{log.mode}</span>,
            <span key="l">{log.lot}</span>,
            <StatusPill key="st" tone={log.status === "SUCCESS" ? "lime" : "muted"}>
              {log.status}
            </StatusPill>,
          ])}
        />
      </Panel>
    </WorkspacePage>
  );
}

function DemoAiPage() {
  const [accountId, setAccountId] = useState<string>("");
  const selectedAccount = demoAccounts.find((account) => account.id === accountId) ?? null;

  return (
    <WorkspacePage
      eyebrow="Assistant"
      title="WSA Assistant"
      description="Your built-in trading copilot. Ask about account risk, performance, exposure, and upcoming news."
      action={
        <PageActionGroup>
          <div className="min-w-[220px]">
            <SelectField label="Account context" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">All my accounts</option>
              {demoAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} — {account.broker}
                </option>
              ))}
            </SelectField>
          </div>
        </PageActionGroup>
      }
    >
      <DemoModeBanner />
      <InlineStatusStrip
        items={[
          { label: "Account in context", value: selectedAccount ? selectedAccount.name : "All accounts", tone: "accent" },
          { label: "Account status", value: selectedAccount ? selectedAccount.status : `${demoAccounts.length} connected` },
          { label: "Chats left today", value: "12", tone: "lime" },
          { label: "Chart analyses left", value: "5", tone: "lime" },
          { label: "Token credits", value: "9,400", tone: "lime" },
        ]}
      />

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Panel className="flex min-h-[520px] flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-line pb-4">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-[4px] bg-accent/10 text-accent">
                <Sparkles className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">WSA Assistant</p>
                <p className="text-xs text-muted">Professional Forex and prop-risk copilot</p>
              </div>
            </div>
            <DemoDisabledButton>Clear</DemoDisabledButton>
          </div>

          <div className="flex-1 space-y-4 invisible-scrollbar overflow-y-auto py-4">
            <div className="grid gap-4 lg:grid-cols-3">
              {demoAiCards.map((card) => (
                <div key={card.title} className="rounded-[4px] border border-line bg-background px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">{card.title}</p>
                  <p className="mt-2 text-lg font-semibold text-foreground">{card.value}</p>
                  <p className="mt-1 text-xs text-muted">{card.detail}</p>
                </div>
              ))}
            </div>

            {demoAiConversation.map((message) => (
              <div key={message.id} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    message.role === "user"
                      ? "max-w-[85%] rounded-[4px] rounded-br-sm border border-accent/30 bg-accent/10 px-4 py-3 text-sm leading-6 text-foreground"
                      : "max-w-[85%] whitespace-pre-wrap rounded-[4px] rounded-bl-sm border border-line bg-background px-4 py-3 text-sm leading-6 text-foreground/90"
                  }
                >
                  {message.content}
                </div>
              </div>
            ))}
          </div>

          <form className="flex items-end gap-2 border-t border-line pt-4">
            <textarea
              disabled
              placeholder="Create an account to use AI prompts and live account-aware analysis."
              rows={2}
              className="min-h-[52px] w-full resize-none rounded-[4px] border border-line bg-background px-4 py-3 text-sm text-muted outline-none"
            />
            <PrimaryButton type="submit" disabled>
              <Send className="mr-2 inline-block h-4 w-4" />
              Send
            </PrimaryButton>
          </form>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            Educational analysis only — not financial advice. Demo mode never calls Gemini or saves chat data.
          </p>
        </Panel>

        <Panel className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-line pb-4">
            <span className="grid h-9 w-9 place-items-center rounded-[4px] bg-accent-2/10 text-accent-2">
              <ImagePlus className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">Advanced Chart Analysis</p>
              <p className="text-xs text-muted">Upload a TradingView screenshot</p>
            </div>
          </div>

          <div className="space-y-4 py-4">
            <DemoDisabledButton className="inline-flex">
              <ImagePlus className="mr-2 inline-block h-4 w-4" />
              Choose image
            </DemoDisabledButton>
            <p className="text-xs text-muted">PNG, JPG, or WebP · max 5MB</p>
            <TextAreaField
              label="Focus (optional)"
              placeholder="Create an account to describe the chart focus."
              disabled
              value=""
              onChange={() => undefined}
            />
            <PrimaryButton type="button" disabled>
              Analyze chart
            </PrimaryButton>
            <div className="rounded-[4px] border border-line bg-background px-4 py-4">
              <div className="mb-2 flex items-center gap-2">
                <StatusPill tone="lime">Sample analysis</StatusPill>
              </div>
              <p className="text-sm leading-6 text-foreground/90">
                Sample chart commentary appears here after signup. Demo mode keeps this panel read-only and never uploads files or calls external AI services.
              </p>
            </div>
            <div className="space-y-3">
              {demoAiPrompts.map((prompt) => (
                <div key={prompt.title} className="rounded-[4px] border border-line bg-background p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground">{prompt.title}</p>
                    <StatusPill tone={prompt.status === "Ready" ? "lime" : "muted"}>{prompt.status}</StatusPill>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted">{prompt.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </WorkspacePage>
  );
}

function DemoTerminalPage() {
  return (
    <WorkspacePage
      eyebrow="Terminal"
      title="Professional Terminal"
      description="A read-only replica of the trader terminal layout using sample market data only."
    >
      <DemoModeBanner />
      <div className="overflow-hidden rounded-[6px] border border-line bg-panel">
        <header className="flex shrink-0 items-center gap-4 border-b border-line bg-panel px-4 py-2">
          <span className="rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-zinc-800 text-muted">
            Demo Market Data
          </span>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400"
            disabled
          >
            Professional Data
          </button>
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-bold">EURUSD</span>
            <span className="text-lg font-mono font-semibold tabular-nums">1.09452</span>
            <span className="text-xs font-mono text-green-400">+0.00084 (+0.08%)</span>
            <span className="text-[10px] text-muted">H: 1.09588 L: 1.09170</span>
          </div>
          <div className="ml-auto text-[10px] text-muted">Euro / US Dollar</div>
        </header>

        <div className="flex min-h-[640px]">
          <aside className="hidden w-36 shrink-0 invisible-scrollbar overflow-y-auto border-r border-line bg-panel lg:block">
            {["forex", "commodities", "indices", "crypto"].map((cat) => (
              <div key={cat} className="border-b border-line">
                <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-widest text-muted">{cat}</div>
                {["EURUSD", "GBPUSD", "XAUUSD", "NAS100"].map((symbol) => (
                  <button
                    key={`${cat}-${symbol}`}
                    type="button"
                    className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-xs ${
                      symbol === "EURUSD" ? "bg-accent/10 text-foreground" : "text-muted hover:bg-panel-strong"
                    }`}
                  >
                    <span className="font-medium">{symbol}</span>
                  </button>
                ))}
              </div>
            ))}
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1">
              {["1m", "5m", "15m", "1h", "4h", "1d"].map((tf, index) => (
                <button
                  key={tf}
                  type="button"
                  className={`rounded px-2 py-0.5 text-xs font-medium ${index === 2 ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}
                >
                  {tf}
                </button>
              ))}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_220px]">
              <div className="border-r border-line bg-background p-4">
                <div className="grid h-full gap-3">
                  <div className="grid h-full items-end gap-2 rounded-[4px] border border-line bg-panel-strong p-4">
                    <div className="flex h-full items-end gap-2">
                      {[40, 52, 46, 61, 58, 70, 63, 76, 72, 84, 79, 91].map((bar, index) => (
                        <div key={index} className="flex flex-1 items-end">
                          <div
                            className={`w-full rounded-t-[4px] ${index % 4 === 0 ? "bg-danger/70" : "bg-accent/80"}`}
                            style={{ height: `${bar}%` }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {demoTerminalWidgets.slice(0, 3).map((widget) => (
                      <div key={widget.label} className="rounded-[4px] border border-line bg-panel p-4">
                        <p className="text-xs text-muted">{widget.label}</p>
                        <p className="mt-2 text-sm font-semibold text-foreground">{widget.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <aside className="border-l border-line bg-panel p-3">
                <div className="grid gap-3">
                  <div className="rounded-[4px] border border-line bg-background p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Order ticket</p>
                    <div className="mt-3 grid gap-2">
                      {[1, 2, 3, 4].map((item) => (
                        <div key={item} className="h-10 rounded-[4px] border border-line bg-panel" />
                      ))}
                    </div>
                    <DemoOnlyHint />
                  </div>
                  <div className="rounded-[4px] border border-line bg-background p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">DOM</p>
                    <div className="mt-3 space-y-2 text-xs font-mono">
                      {["1.09480 · 420K", "1.09474 · 390K", "1.09465 · 520K", "1.09451 · 610K"].map((row) => (
                        <div key={row} className="flex items-center justify-between text-muted">
                          <span>{row.split(" · ")[0]}</span>
                          <span>{row.split(" · ")[1]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
    </WorkspacePage>
  );
}

function DemoMarketplacePage() {
  const [platformFilter, setPlatformFilter] = useState<"ALL" | "MT5" | "MT4">("ALL");
  const [riskFilter, setRiskFilter] = useState<"ALL" | "LOW" | "MEDIUM" | "HIGH">("ALL");

  const filtered = demoBots.filter((bot) => {
    const matchesPlatform = platformFilter === "ALL" || bot.platform === platformFilter || bot.platform === "BOTH";
    const riskLevel = demoMarketPlaceFilters[bot.name] ?? "MEDIUM";
    const matchesRisk = riskFilter === "ALL" || riskLevel === riskFilter;
    return matchesPlatform && matchesRisk;
  });

  return (
    <WorkspacePage
      eyebrow="Trading Tools"
      title="Bot Marketplace"
      description="Explore and purchase trading bots and expert advisors"
    >
      <DemoModeBanner />
      <div className="space-y-3">
        <FilterChipRow
          chips={[
            { label: "All platforms", active: platformFilter === "ALL", onClick: () => setPlatformFilter("ALL") },
            { label: "MT5", active: platformFilter === "MT5", onClick: () => setPlatformFilter("MT5") },
            { label: "MT4", active: platformFilter === "MT4", onClick: () => setPlatformFilter("MT4") },
          ]}
        />
        <FilterChipRow
          chips={[
            { label: "All risk levels", active: riskFilter === "ALL", onClick: () => setRiskFilter("ALL") },
            { label: "Low risk", active: riskFilter === "LOW", onClick: () => setRiskFilter("LOW") },
            { label: "Medium risk", active: riskFilter === "MEDIUM", onClick: () => setRiskFilter("MEDIUM") },
            { label: "High risk", active: riskFilter === "HIGH", onClick: () => setRiskFilter("HIGH") },
          ]}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((product) => {
          const riskLevel = demoMarketPlaceFilters[product.name] ?? "MEDIUM";
          const accessState = product.state.includes("Owned")
            ? "ACTIVE"
            : product.state.includes("Pending")
              ? "PROCESSING"
              : "NONE";

          return (
            <div key={product.name} className="flex flex-col gap-3 rounded-[6px] border border-line bg-panel p-5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-base font-semibold text-foreground">{product.name}</p>
                <StatusPill tone="muted">{product.platform}</StatusPill>
              </div>
              <p className="text-sm text-muted">{product.price} one-time access after verified payment.</p>
              <div className="mt-auto space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={riskLevel === "LOW" ? "lime" : riskLevel === "HIGH" ? "danger" : "accent"}>
                    {riskLevel} Risk
                  </StatusPill>
                  <span className="ml-auto text-sm font-semibold text-accent">{product.price} — one-time</span>
                </div>
                {accessState === "ACTIVE" ? (
                  <StatusPill tone="lime">Access granted</StatusPill>
                ) : accessState === "PROCESSING" ? (
                  <StatusPill tone="accent">Activating access</StatusPill>
                ) : (
                  <DemoDisabledButton>Buy Bot</DemoDisabledButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </WorkspacePage>
  );
}

function DemoMyBotsPage() {
  return (
    <WorkspacePage
      eyebrow="Trading Tools"
      title="My Bots"
      description="View owned bot licenses and deployment states. Demo mode keeps all bot actions read-only."
    >
      <DemoModeBanner />
      <div className="grid gap-5 xl:grid-cols-[0.58fr_0.42fr]">
        <Panel>
          <h2 className="text-lg font-semibold text-foreground">Owned bot licenses</h2>
          <div className="mt-4">
            <DataTable
              headers={["Bot", "Version", "License", "Linked account"]}
              rows={demoBotLicenses.map((license) => [
                <span key="bot" className="font-semibold text-foreground">{license.name}</span>,
                license.version,
                <StatusPill key="license" tone={license.license === "Active" ? "lime" : "accent"}>
                  {license.license}
                </StatusPill>,
                license.account,
              ])}
            />
          </div>
        </Panel>
        <Panel>
          <h2 className="text-lg font-semibold text-foreground">Deployment notes</h2>
          <div className="mt-4 space-y-3">
            {[
              "Bots remain accessible even if the platform subscription expires.",
              "Live deployment and broker actions stay disabled in the public demo.",
              "License updates and approvals are shown as read-only states here.",
            ].map((note) => (
              <div key={note} className="rounded-[4px] border border-line bg-background p-4">
                <p className="text-sm leading-6 text-muted">{note}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </WorkspacePage>
  );
}

function DemoAcademyPage() {
  const [filter, setFilter] = useState<"ALL" | "BEGINNER" | "INTERMEDIATE" | "ADVANCED">("ALL");
  const filtered = filter === "ALL" ? demoCourses : demoCourses.filter((course) => course.difficulty === filter);
  const resumeCourse = demoCourses.find((course) => course.progress !== "0%" && course.progress !== "100%");

  return (
    <WorkspacePage
      eyebrow="Learning Center"
      title="Trading Academy"
      description="Master trading with structured courses, live webinars, and expert guidance"
      action={
        <Link href="/register" className="btn-dark">
          <BookOpenCheck className="mr-2 inline-block h-4 w-4" />
          Live Webinars
        </Link>
      }
    >
      <DemoModeBanner />
      {resumeCourse ? (
        <Panel className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Continue learning</p>
            <p className="mt-1 text-base font-semibold text-foreground">{resumeCourse.title}</p>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-panel-strong">
                <div className="h-full rounded-full bg-accent" style={{ width: resumeCourse.progress }} />
              </div>
              <span className="text-xs text-muted">{resumeCourse.progress}</span>
            </div>
          </div>
          <DemoDisabledButton>Resume</DemoDisabledButton>
        </Panel>
      ) : null}

      <FilterChipRow
        chips={[
          { label: "All", active: filter === "ALL", onClick: () => setFilter("ALL") },
          { label: "Beginner", active: filter === "BEGINNER", onClick: () => setFilter("BEGINNER") },
          { label: "Intermediate", active: filter === "INTERMEDIATE", onClick: () => setFilter("INTERMEDIATE") },
          { label: "Advanced", active: filter === "ADVANCED", onClick: () => setFilter("ADVANCED") },
        ]}
      />

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((course) => (
          <div key={course.title} className="group flex flex-col gap-3 rounded-[6px] border border-line bg-panel p-5 transition-colors hover:border-accent/40 hover:bg-panel/80">
            <div className="flex h-32 w-full items-center justify-center rounded-[4px] bg-panel-strong">
              <BookOpenCheck className="h-10 w-10 text-muted/40" />
            </div>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-base font-semibold leading-snug text-foreground group-hover:text-accent">{course.title}</h3>
              <StatusPill tone={course.difficulty === "BEGINNER" ? "lime" : course.difficulty === "ADVANCED" ? "danger" : "accent"}>
                {course.difficulty}
              </StatusPill>
            </div>
            <p className="text-sm text-muted line-clamp-2 leading-5">Mock academy progress and lesson structure shown for demo mode.</p>
            <div className="mt-auto space-y-2">
              <div className="flex items-center gap-2">
                {course.progress === "100%" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent-2" /> : null}
                <div className="flex-1 h-1 overflow-hidden rounded-full bg-panel-strong">
                  <div className="h-full rounded-full bg-accent" style={{ width: course.progress }} />
                </div>
                <span className="text-[11px] text-muted shrink-0">{course.progress}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                <span>3 modules</span>
                <span>·</span>
                <span>12 lessons</span>
                <span>·</span>
                <span>2h 40m</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-[6px] border border-accent/30 bg-accent/5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[4px] bg-accent/15">
              <Users className="h-6 w-6 text-accent" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">1-to-1 Professional Mentorship</h3>
              <p className="mt-1 max-w-lg text-sm text-muted">
                Get mentored directly by a professional trader in a private one-on-one programme. This one-time purchase stays separate from copy trading access.
              </p>
              <p className="mt-2 text-sm font-semibold text-accent">€2,500 — one-time</p>
            </div>
          </div>
          <div className="shrink-0">
            <DemoDisabledButton>Pay €2,500</DemoDisabledButton>
          </div>
        </div>
      </div>
    </WorkspacePage>
  );
}

function DemoEvaluationsPage() {
  return (
    <WorkspacePage
      eyebrow="Certification"
      title="Evaluation Programs"
      description="Complete academy requirements and challenge yourself with a funded trader evaluation"
    >
      <DemoModeBanner />
      <div className="space-y-4">
        {demoEvaluationPrograms.map((program) => (
          <Panel key={program.id}>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{program.name}</h3>
                  {!program.unlocked ? (
                    <span className="rounded-[4px] bg-panel-strong px-2 py-0.5 text-xs text-muted">Locked</span>
                  ) : null}
                  <StatusPill tone={program.status === "PASSED" ? "lime" : program.status === "ACTIVE" ? "accent" : "muted"}>
                    {program.status}
                  </StatusPill>
                </div>
                <p className="mt-1 text-xs text-muted">{program.description}</p>
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-3 lg:grid-cols-5">
                  <span>Balance: <strong className="text-foreground">{program.startingBalance}</strong></span>
                  <span>Target: <strong className="text-foreground">{program.target}</strong></span>
                  <span>Max daily DD: <strong className="text-foreground">{program.maxDailyDrawdown}</strong></span>
                  <span>Max DD: <strong className="text-foreground">{program.maxDrawdown}</strong></span>
                  <span>Min days: <strong className="text-foreground">{program.minDays}</strong></span>
                  <span>Duration: <strong className="text-foreground">{program.duration}</strong></span>
                </div>
                <div className="mt-2 text-xs text-muted">
                  Requires: <Link href="/demo/academy" className="underline hover:text-foreground">Academy progression</Link>
                  <span className="ml-2">({program.academyProgress} complete)</span>
                </div>
              </div>
              <div className="flex shrink-0 items-start gap-2">
                {!program.unlocked ? (
                  <DemoDisabledButton>Complete Academy First</DemoDisabledButton>
                ) : (
                  <DemoDisabledButton>{program.status === "PASSED" ? "View Attempt" : "Start Evaluation"}</DemoDisabledButton>
                )}
              </div>
            </div>
          </Panel>
        ))}
      </div>

      <div className="mt-6 flex justify-end">
        <Link href="/register" className="text-xs text-muted underline hover:text-foreground">My Certificates</Link>
      </div>
    </WorkspacePage>
  );
}

function renderSection(slug: DemoSectionSlug) {
  switch (slug) {
    case "dashboard":
      return <DemoDashboardPage />;
    case "accounts":
      return <DemoAccountsPage />;
    case "copy-trading":
      return <DemoCopyTradingPage />;
    case "ai":
      return <DemoAiPage />;
    case "terminal":
      return <DemoTerminalPage />;
    case "marketplace":
      return <DemoMarketplacePage />;
    case "my-bots":
      return <DemoMyBotsPage />;
    case "academy":
      return <DemoAcademyPage />;
    case "evaluations":
      return <DemoEvaluationsPage />;
    default:
      return (
        <WorkspacePage
          eyebrow="Public trader demo"
          title="Demo unavailable"
          description="This demo workspace section is not configured."
          action={<DemoPrimaryActions />}
        >
          <DemoModeBanner />
          <EmptyState
            title="Demo section unavailable"
            description="This section is not configured in demo mode."
          />
        </WorkspacePage>
      );
  }
}

export function DemoWorkspace({ sectionSlug }: { sectionSlug: DemoSectionSlug }) {
  const section = getDemoSectionConfig(sectionSlug) as DemoSectionConfig | null;
  if (!section) {
    return renderSection("dashboard");
  }
  return renderSection(section.slug);
}
