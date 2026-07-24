"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  DataTable,
  EmptyState,
  FilterChipRow,
  GhostButton,
  InlineStatusStrip,
  Panel,
  PageActionGroup,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { formatMoney } from "@/lib/utils/format";
import type { CommissionType, PartnerCommissionDto, PartnerCommissionSummaryDto } from "@/lib/partner/types";

const STATUS_TONE: Record<PartnerCommissionDto["status"], "lime" | "accent" | "danger" | "muted"> = {
  PENDING: "accent",
  APPROVED: "lime",
  PAID: "lime",
  CANCELLED: "muted",
};

interface CommissionsResponse {
  summary: PartnerCommissionSummaryDto;
  records: PartnerCommissionDto[];
}

const RULE_LABELS: Record<CommissionType, string> = {
  CPA: "CPA (Cost Per Acquisition)",
  REBATE: "Rebate",
  PROFIT_SHARE: "Profit Share",
};

function CommissionRulePanel({ summary }: { summary: PartnerCommissionSummaryDto }) {
  return (
    <div className="mt-4 rounded-[4px] border border-line bg-panel p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Your commission rule</p>
      <div className="definition-grid mt-3 grid grid-cols-2 gap-0 sm:grid-cols-3">
        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Type</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{RULE_LABELS[summary.commissionType]}</p>
        </div>
        {summary.commissionType === "CPA" ? (
          <div className="rounded-[4px] border border-line bg-background px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">CPA amount</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {summary.cpaAmount != null ? formatMoney({ amount: summary.cpaAmount, currency: summary.currency }) : "-"}
            </p>
          </div>
        ) : (
          <div className="rounded-[4px] border border-line bg-background px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Rate</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{summary.commissionPercent}%</p>
          </div>
        )}
        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Currency</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{summary.currency}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">Commission rules are configured by your account manager. Contact support to request changes.</p>
    </div>
  );
}

export default function PartnerCommissionsPage() {
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PENDING" | "APPROVED" | "PAID" | "CANCELLED">("ALL");

  const { data, isLoading, isError } = useQuery<CommissionsResponse>({
    queryKey: ["partner", "commissions"],
    queryFn: async () => {
      const res = await fetch("/api/partner/commissions");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load commissions");
      return json.data;
    },
  });

  const summary = data?.summary;
  const allRecords = data?.records ?? [];
  const records = statusFilter === "ALL" ? allRecords : allRecords.filter((r) => r.status === statusFilter);

  return (
    <WorkspacePage
      eyebrow="Partner"
      title="Commissions"
      description="Your attributed commission ledger. Reporting only - payouts are handled separately."
      action={
        <PageActionGroup>
          <a href="/api/partner/commissions/export" download>
            <GhostButton type="button" disabled={records.length === 0}>
              <Download className="mr-2 inline-block h-4 w-4" />
              Export CSV
            </GhostButton>
          </a>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          { label: "Pending", value: summary ? formatMoney(summary.pending) : "-", tone: "accent" },
          { label: "Approved", value: summary ? formatMoney(summary.approved) : "-", tone: "lime" },
          { label: "Paid", value: summary ? formatMoney(summary.paid) : "-", tone: "lime" },
          {
            label: "Commission rate",
            value: summary ? `${summary.commissionPercent}%` : "-",
          },
        ]}
      />

      {summary ? <CommissionRulePanel summary={summary} /> : null}

      <div className="mt-5 rounded-[4px] border border-line bg-panel p-4">
        <FilterChipRow
          chips={(["ALL", "PENDING", "APPROVED", "PAID", "CANCELLED"] as const).map((s) => ({
            label: s === "ALL" ? `All (${allRecords.length})` : `${s} (${allRecords.filter((r) => r.status === s).length})`,
            active: statusFilter === s,
            onClick: () => setStatusFilter(s),
          }))}
        />
      </div>

      <div className="mt-5">
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-[4px] border border-line bg-panel" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Failed to load commissions.
          </div>
        ) : records.length === 0 ? (
          <EmptyState
            title="No commission records yet"
            description="When commission records are created for your attributed traders, they will appear here with their status."
          />
        ) : (
          <Panel className="min-w-0">
            <DataTable
              headers={["Date", "Trader", "Source", "Gross", "Rate", "Commission", "Status"]}
              rows={records.map((r) => [
                <span key="d">{new Date(r.createdAt).toLocaleDateString()}</span>,
                <span key="t">{r.traderName ?? "-"}</span>,
                <span key="s">{r.sourceType}</span>,
                <span key="g">{formatMoney({ amount: r.grossAmount, currency: r.currency })}</span>,
                <span key="r">{r.commissionPercent}%</span>,
                <span key="c" className="font-semibold text-foreground">
                  {formatMoney({ amount: r.commissionAmount, currency: r.currency })}
                </span>,
                <StatusPill key="st" tone={STATUS_TONE[r.status]}>
                  {r.status}
                </StatusPill>,
              ])}
            />
          </Panel>
        )}
      </div>
    </WorkspacePage>
  );
}
