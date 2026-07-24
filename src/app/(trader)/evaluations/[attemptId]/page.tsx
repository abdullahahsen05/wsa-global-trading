"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import type { EvaluationAttemptDto } from "@/lib/services/evaluationService";
import type { TraderAccountSummary } from "@/lib/domain/types";

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? json.error?.code ?? "Request failed");
  return json.data as T;
}

const STATUS_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  PENDING: "muted",
  ACTIVE: "accent",
  PASSED: "lime",
  FAILED: "danger",
  EXPIRED: "danger",
  CANCELLED: "muted",
  NEEDS_REVIEW: "accent",
};

function MetricRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "pass" | "fail" | null;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border py-2 last:border-0 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          highlight === "pass"
            ? "font-semibold text-lime-400"
            : highlight === "fail"
              ? "font-semibold text-danger"
              : "font-medium text-foreground"
        }
      >
        {value}
      </span>
    </div>
  );
}

interface StoredMetrics {
  profitPercent?: number;
  currentBalance?: number;
  currentEquity?: number;
  maxDrawdownPercent?: number;
  maxDailyDrawdownPercent?: number;
  tradingDays?: number;
  totalTrades?: number;
  daysRemaining?: number;
}

export default function AttemptDetailPage({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  const { attemptId } = use(params);
  const queryClient = useQueryClient();
  const [selectedAccountId, setSelectedAccountId] = useState("");

  const {
    data: attempt,
    isLoading,
    isError,
    error,
  } = useQuery<EvaluationAttemptDto>({
    queryKey: ["evaluation-attempt", attemptId],
    queryFn: () => apiFetch(`/api/evaluations/attempts/${attemptId}`),
  });
  const accountsQuery = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts", "evaluation-link"],
    queryFn: () => apiFetch("/api/trading-accounts"),
  });
  const linkAccount = useMutation({
    mutationFn: (tradingAccountId: string) =>
      apiFetch<EvaluationAttemptDto>(`/api/evaluations/attempts/${attemptId}/link-account`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradingAccountId }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["evaluation-attempt", attemptId] });
      await queryClient.invalidateQueries({ queryKey: ["evaluations-programs"] });
      await queryClient.invalidateQueries({ queryKey: ["trading-accounts"] });
    },
  });

  if (isLoading) {
    return (
      <WorkspacePage eyebrow="Evaluation" title="Attempt Detail" description="Loading your attempt…">
        <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
      </WorkspacePage>
    );
  }

  if (isError || !attempt) {
    return (
      <WorkspacePage eyebrow="Evaluation" title="Attempt Detail" description="Unable to load attempt">
        <div className="py-16 text-center text-sm text-danger">
          {(error as Error | null)?.message ?? "Attempt not found"}
        </div>
      </WorkspacePage>
    );
  }

  const metrics = attempt.latestMetrics as StoredMetrics;
  const hasMetrics = typeof metrics?.profitPercent === "number";
  const connectedAccounts = (accountsQuery.data ?? []).filter(
    (account) => account.status === "CONNECTED",
  );

  return (
    <WorkspacePage
      eyebrow="Evaluation"
      title={attempt.programName}
      description={`Attempt started ${attempt.startedAt ? new Date(attempt.startedAt).toLocaleDateString() : "—"}`}
      action={
        <Link href="/evaluations" className="text-sm text-muted-foreground hover:text-foreground">
          ‹ All Evaluations
        </Link>
      }
    >
      <div className="mb-4 flex items-center gap-3">
        <StatusPill tone={STATUS_TONE[attempt.status] ?? "muted"}>{attempt.status}</StatusPill>
        {attempt.adminOverrideBy && (
          <span className="text-xs text-muted-foreground">(Admin override)</span>
        )}
      </div>

      {attempt.status === "PENDING" && !attempt.startedAt && (
        <Panel className="mb-4 border-accent/30 bg-accent/5">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
                Demo account required
              </p>
              <h2 className="mt-2 text-xl font-semibold text-foreground">
                Connect a fresh demo account to begin
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Create the demo account with a starting balance of{" "}
                <strong className="text-foreground">
                  ${attempt.startingBalance?.toLocaleString() ?? "—"}
                </strong>
                , connect and synchronize it under Accounts, then select it here. The evaluation
                timer does not begin until these checks pass.
              </p>
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                <li>• The account must be connected and have no previous trades.</li>
                <li>• It cannot be used for a public strategy, self-copy, or copy master.</li>
                <li>• Its synchronized balance must match the program balance.</li>
              </ul>
              <Link
                href="/accounts"
                className="mt-4 inline-flex rounded-xl border border-line bg-background px-4 py-2 text-sm font-semibold text-foreground hover:border-accent/50"
              >
                Open Accounts to connect demo
              </Link>
            </div>

            <div className="rounded-2xl border border-line bg-background p-4">
              <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Connected demo account
              </label>
              <select
                value={selectedAccountId}
                onChange={(event) => setSelectedAccountId(event.target.value)}
                className="mt-2 h-12 w-full rounded-xl border border-line bg-surface px-3 text-sm text-foreground outline-none focus:border-accent"
              >
                <option value="">Select an account…</option>
                {connectedAccounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.accountName} · ${account.balance.amount.toLocaleString()} · {account.platform ?? "MT5"}
                  </option>
                ))}
              </select>
              {accountsQuery.isLoading && (
                <p className="mt-2 text-xs text-muted-foreground">Loading your accounts…</p>
              )}
              {!accountsQuery.isLoading && connectedAccounts.length === 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  No connected account is available yet. Connect and sync a fresh demo account first.
                </p>
              )}
              {linkAccount.isError && (
                <p className="mt-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
                  {(linkAccount.error as Error).message}
                </p>
              )}
              <button
                type="button"
                disabled={!selectedAccountId || linkAccount.isPending}
                onClick={() => linkAccount.mutate(selectedAccountId)}
                className="mt-4 h-11 w-full rounded-xl bg-accent px-4 text-sm font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {linkAccount.isPending ? "Verifying account…" : "Verify account and start evaluation"}
              </button>
            </div>
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Account */}
        <Panel>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Account
          </h2>
          <MetricRow
            label="Demo account"
            value={attempt.tradingAccountName ?? "Waiting for trader connection"}
            highlight={attempt.tradingAccountName ? null : "fail"}
          />
          <MetricRow label="Account setup" value={attempt.provisioningStatus.replaceAll("_", " ")} />
          <MetricRow
            label="Starting balance"
            value={attempt.startingBalance != null ? `$${attempt.startingBalance.toLocaleString()}` : "—"}
          />
          <MetricRow
            label="Ends"
            value={attempt.endsAt ? new Date(attempt.endsAt).toLocaleDateString() : "—"}
          />
          {hasMetrics && metrics.daysRemaining !== undefined && (
            <MetricRow label="Days remaining" value={String(metrics.daysRemaining)} />
          )}
          {attempt.lastCheckedAt && (
            <MetricRow label="Last checked" value={new Date(attempt.lastCheckedAt).toLocaleString()} />
          )}
        </Panel>

        {/* Metrics */}
        {hasMetrics ? (
          <Panel>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Performance
            </h2>
            {metrics.currentBalance !== undefined && (
              <MetricRow
                label="Current balance"
                value={`$${metrics.currentBalance.toLocaleString()}`}
              />
            )}
            {metrics.profitPercent !== undefined && (
              <MetricRow
                label={`Profit / target ${attempt.programRules?.profitTargetPercent ?? "—"}%`}
                value={`${metrics.profitPercent >= 0 ? "+" : ""}${metrics.profitPercent.toFixed(2)}%`}
                highlight={metrics.profitPercent >= 0 ? "pass" : null}
              />
            )}
            {metrics.maxDailyDrawdownPercent !== undefined && (
              <MetricRow
                label={`Max daily drawdown / limit ${attempt.programRules?.maxDailyDrawdownPercent ?? "—"}%`}
                value={`${metrics.maxDailyDrawdownPercent.toFixed(2)}%`}
                highlight={metrics.maxDailyDrawdownPercent > 0 ? "fail" : null}
              />
            )}
            {metrics.maxDrawdownPercent !== undefined && (
              <MetricRow
                label={`Max overall drawdown / limit ${attempt.programRules?.maxOverallDrawdownPercent ?? "—"}%`}
                value={`${metrics.maxDrawdownPercent.toFixed(2)}%`}
                highlight={metrics.maxDrawdownPercent > 0 ? "fail" : null}
              />
            )}
            {metrics.tradingDays !== undefined && (
              <MetricRow label={`Trading days / minimum ${attempt.programRules?.minimumTradingDays ?? "—"}`} value={String(metrics.tradingDays)} />
            )}
            {metrics.totalTrades !== undefined && (
              <MetricRow label="Total trades" value={String(metrics.totalTrades)} />
            )}
          </Panel>
        ) : (
          <Panel>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Performance
            </h2>
            <p className="text-sm text-muted-foreground">
              {attempt.tradingAccountName
                ? "No sync data yet — account will be checked by admin or worker."
                : "Link a demo account first, then run an evaluation check."}
            </p>
          </Panel>
        )}
      </div>

      {/* Pass/fail reason */}
      {(attempt.passReason ?? attempt.failReason) && (
        <Panel className="mt-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {attempt.passReason ? "Pass Reason" : "Fail Reason"}
          </h2>
          <p className="text-sm text-foreground">{attempt.passReason ?? attempt.failReason}</p>
          {attempt.adminOverrideReason && (
            <p className="mt-1 text-xs text-muted-foreground">
              Admin note: {attempt.adminOverrideReason}
            </p>
          )}
        </Panel>
      )}

      {/* Certificate */}
      {attempt.status === "PASSED" && (
        <Panel className="mt-4 border-lime-400/30 bg-lime-950/10">
          <h2 className="mb-2 text-sm font-semibold text-lime-400">Evaluation Passed</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Your secured WSA Global certificate is generated automatically and the funding decision is now with the admin team.
          </p>
          <div className="flex gap-3">
            <Link
              href="/evaluations/certificates"
              className="rounded-[4px] bg-lime-500 px-4 py-1.5 text-xs font-semibold text-black hover:bg-lime-400"
            >
              Download certificate
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Funding status: {attempt.fundingStatus.replaceAll("_", " ")}</p>
        </Panel>
      )}
    </WorkspacePage>
  );
}
