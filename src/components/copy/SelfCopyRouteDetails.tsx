"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, Info, ListChecks, Loader2, X } from "lucide-react";
import { GhostButton } from "@/components/app/WorkspaceUI";
import { formatAgo, formatLatency } from "@/lib/copy/selfCopyView";
import {
  selfCopyApi,
  type SelfCopyActivityItem,
  type SelfCopyActivityResponse,
  type SelfCopyCheckItem,
  type SelfCopyCheckResult,
} from "@/components/copy/selfCopyClient";

const SAMPLE_ORIGIN: Record<SelfCopyCheckResult["sample"]["origin"], string> = {
  "open-position": "your latest open trade on the source account",
  "last-trade": "the latest trade on the source account",
  example: "an example trade (the source account has no trades yet)",
};

function CheckIcon({ status }: { status: SelfCopyCheckItem["status"] }) {
  if (status === "pass") return <CheckCircle2 className="h-4 w-4 shrink-0 text-lime" aria-label="passed" />;
  if (status === "fail") return <X className="h-4 w-4 shrink-0 text-danger" aria-label="failed" />;
  if (status === "warn") return <AlertTriangle className="h-4 w-4 shrink-0 text-accent" aria-label="warning" />;
  return <Info className="h-4 w-4 shrink-0 text-muted" aria-label="information" />;
}

function CheckResult({ result }: { result: SelfCopyCheckResult }) {
  const { plan, sample } = result;
  return (
    <div className="space-y-3 rounded-[4px] border border-line bg-background p-4">
      <p className={`text-sm font-semibold ${result.wouldCopy ? "text-lime" : "text-danger"}`}>
        {result.wouldCopy
          ? "A trade like this would be copied now."
          : `A trade like this would NOT be copied: ${result.message}`}
      </p>
      <p className="text-xs leading-5 text-muted">
        Tried with {SAMPLE_ORIGIN[sample.origin]}: {sample.side} {sample.volume} {sample.symbol}
        {sample.entryPrice ? ` at ${sample.entryPrice}` : ""}. Nothing was sent to any broker.
      </p>
      {plan ? (
        <p className="text-sm text-foreground">
          Follower order: {plan.followerSide} {plan.lot} lot {plan.followerSymbol}
          {plan.stopLoss ? ` · stop loss ${plan.stopLoss}` : " · no stop loss"}
          {plan.takeProfit ? ` · take profit ${plan.takeProfit}` : " · no take profit"}
          <span className="text-muted"> (symbol: {plan.symbolMatchedBy.replace("-", " ")})</span>
        </p>
      ) : null}
      <ul className="space-y-2">
        {result.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5">
              <CheckIcon status={check.status} />
            </span>
            <span className="min-w-0">
              <span className="font-medium text-foreground">{check.label}</span>
              <span className="block text-xs leading-5 text-muted">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {plan?.notes.length ? (
        <ul className="space-y-1 border-t border-line pt-3 text-xs leading-5 text-muted">
          {plan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function OutcomeIcon({ outcome }: { outcome: SelfCopyActivityItem["outcome"] }) {
  if (outcome === "COPIED") return <CheckCircle2 className="h-4 w-4 shrink-0 text-lime" aria-label="copied" />;
  if (outcome === "FAILED") return <X className="h-4 w-4 shrink-0 text-danger" aria-label="failed" />;
  return <AlertTriangle className="h-4 w-4 shrink-0 text-accent" aria-label="skipped" />;
}

function ActivityLine({ item }: { item: SelfCopyActivityItem }) {
  const symbolText =
    item.symbol && item.followerSymbol && item.followerSymbol !== item.symbol
      ? `${item.symbol} → ${item.followerSymbol}`
      : (item.symbol ?? item.followerSymbol ?? "");
  const lots = item.copiedVolume ?? item.sourceVolume;
  const latency = formatLatency(item.latencyMs);
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5">
        <OutcomeIcon outcome={item.outcome} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          <span className="font-semibold">{item.eventType}</span> {symbolText}
          {item.side ? ` ${item.side}` : ""}
          {lots ? ` ${Math.round(lots * 1000) / 1000} lot` : ""}
          <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-muted">{item.outcome.toLowerCase()}</span>
        </p>
        {item.message ? <p className="mt-0.5 break-words text-xs leading-5 text-muted">{item.message}</p> : null}
      </div>
      <div className="shrink-0 text-right text-xs text-muted">
        {latency ? <p className="font-medium text-foreground">{latency}</p> : null}
        <p>{formatAgo(item.createdAt)}</p>
      </div>
    </li>
  );
}

/**
 * Inside one route: "Check route" (what would happen to a trade like the source's latest one, decided by the
 * same code that copies) and the latest copied / skipped / failed trades with the reason for each.
 */
export function SelfCopyRouteDetails({ routeId }: { routeId: string }) {
  const activity = useQuery<SelfCopyActivityResponse>({
    queryKey: ["self-copy-activity", routeId],
    queryFn: () => selfCopyApi<SelfCopyActivityResponse>(`/api/copy-trading/self-copy/${routeId}/activity?limit=30`),
    refetchInterval: 4_000,
  });
  const check = useMutation<SelfCopyCheckResult, Error>({
    mutationFn: () => selfCopyApi<SelfCopyCheckResult>(`/api/copy-trading/self-copy/${routeId}/check`, { method: "POST" }),
  });
  const items = activity.data?.items ?? [];

  return (
    <div className="space-y-5 border-t border-line bg-panel/40 px-5 py-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <GhostButton type="button" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? (
              <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
            ) : (
              <ListChecks className="mr-2 inline-block h-4 w-4" />
            )}
            Check route
          </GhostButton>
          <p className="max-w-2xl text-xs leading-5 text-muted">
            Runs the real copy decision for a trade like the source&apos;s latest one and shows what stops it. It does not trade.
          </p>
        </div>
        {check.isError ? <p className="text-sm text-danger">{check.error.message}</p> : null}
        {check.data ? <CheckResult result={check.data} /> : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold text-foreground">Latest activity</h3>
          <span className="text-xs text-muted">updates every few seconds</span>
        </div>
        {activity.isLoading ? (
          <p className="text-sm text-muted">Loading activity...</p>
        ) : activity.isError ? (
          <p className="text-sm text-danger">The activity could not be loaded: {activity.error.message}</p>
        ) : items.length === 0 ? (
          <p className="rounded-[4px] border border-line bg-background px-4 py-3 text-sm text-muted">
            Nothing yet. Every trade of the source account that reaches this route shows up here - copied, or skipped with the
            reason.
          </p>
        ) : (
          <>
            {activity.data?.source === "links" ? (
              <p className="text-xs leading-5 text-muted">
                Skipped trades and timings are recorded after migration 061 is applied; until then only the copies themselves are
                listed.
              </p>
            ) : null}
            <ul className="divide-y divide-line rounded-[4px] border border-line bg-background">
              {items.map((item) => (
                <ActivityLine key={item.id} item={item} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
