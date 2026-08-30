"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EmptyState,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SelectField, TextAreaField } from "@/components/app/FormFields";
import type { PartnerTraderDto } from "@/lib/partner/types";
import type { CrmNoteDto } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data;
}

export default function PartnerCrmPage() {
  const queryClient = useQueryClient();
  const [selectedTraderId, setSelectedTraderId] = useState("");
  const [noteText, setNoteText] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const { data: traders = [], isLoading } = useQuery<PartnerTraderDto[]>({
    queryKey: ["partner", "traders", "all"],
    queryFn: () => getJson("/api/partner/traders"),
  });

  const traderId = selectedTraderId || traders[0]?.traderId || "";
  const selectedTrader = useMemo(
    () => traders.find((t) => t.traderId === traderId) ?? traders[0] ?? null,
    [traders, traderId],
  );

  const { data: notes = [] } = useQuery<CrmNoteDto[]>({
    queryKey: ["partner", "notes", traderId],
    queryFn: () => getJson(`/api/partner/crm/notes?traderId=${traderId}`),
    enabled: Boolean(traderId),
  });

  const addNote = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/partner/crm/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traderId, note: noteText.trim() }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to add note");
      return json.data;
    },
    onSuccess: () => {
      setNoteText("");
      setNotice({ type: "success", text: "Note added." });
      queryClient.invalidateQueries({ queryKey: ["partner", "notes", traderId] });
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  return (
    <WorkspacePage
      eyebrow="Partner"
      title="CRM"
      description="Track each assigned trader through the referral, live-trading, earnings, and payout pipeline."
    >
      {!isLoading && traders.length === 0 ? (
        <EmptyState
          title="No traders assigned yet"
          description="Once traders are assigned to you, you can keep notes about them here."
        />
      ) : (
        <div className="grid items-stretch gap-5 xl:grid-cols-[1fr_1.4fr]">
          <Panel className="flex min-h-0 flex-col">
            <SelectField
              label="Trader"
              value={traderId}
              onChange={(e) => {
                setSelectedTraderId(e.target.value);
                setNotice(null);
              }}
            >
              {traders.map((t) => (
                <option key={t.traderId} value={t.traderId}>
                  {t.name}
                </option>
              ))}
            </SelectField>

            {selectedTrader ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-[4px] border border-line bg-background px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Pipeline</p>
                      <h2 className="mt-2 text-base font-semibold text-foreground">{selectedTrader.name}</h2>
                      <p className="text-sm text-muted">{selectedTrader.email}</p>
                    </div>
                    <StatusPill tone={selectedTrader.cpaQualified ? "lime" : "accent"}>
                      {selectedTrader.cpaQualified ? "Qualified" : selectedTrader.pipelineStage.replace("_", " ")}
                    </StatusPill>
                  </div>

                  <div className="mt-4 space-y-2">
                    {buildPipelineSteps(selectedTrader).map((step) => (
                      <div key={step.label} className="flex items-start gap-3 border-b border-line/70 py-2 last:border-b-0">
                        <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                          step.done ? "bg-accent/20 text-accent" : "bg-panel text-muted"
                        }`}>
                          {step.done ? "✓" : "•"}
                        </span>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{step.label}</p>
                          <p className="text-xs text-muted">{step.helper}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <MetricCard label="Rebate model" value={labelModel(selectedTrader.commissionModel)} helper={selectedTrader.brokerNames[0] ?? "No broker yet"} />
                  <MetricCard label="Last live sync" value={selectedTrader.latestSyncAt ? new Date(selectedTrader.latestSyncAt).toLocaleString() : "Not synced"} helper="Latest broker refresh visible to partner" />
                  <MetricCard label="Wallet-ready" value={formatMoney(selectedTrader.approvedWalletContribution)} helper="Approved earnings available for payout flow" />
                  <MetricCard label="Pending wallet" value={formatMoney(selectedTrader.pendingWalletContribution)} helper="Pending earnings not yet cleared" />
                  <MetricCard label="IB earned" value={formatMoney(selectedTrader.ibRebateEarned)} helper="Closed-lot rebate earnings" />
                  <MetricCard label="CPA earned" value={formatMoney(selectedTrader.cpaEarned)} helper={selectedTrader.cpaTierLabel ? `Current ${selectedTrader.cpaTierLabel}` : "Tier not reached yet"} />
                </div>
              </div>
            ) : null}

            <div className="mt-4">
              <TextAreaField
                label="New note"
                placeholder="Add a private note about this trader..."
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                maxLength={2000}
              />
            </div>
            {notice ? (
              <div
                className={`mt-3 rounded-[4px] border px-3 py-2 text-sm ${
                  notice.type === "success"
                    ? "border-accent/20 bg-accent/10 text-accent"
                    : "border-danger/20 bg-danger/10 text-danger"
                }`}
              >
                {notice.text}
              </div>
            ) : null}
            <div className="mt-4">
              <PrimaryButton
                type="button"
                disabled={addNote.isPending || !traderId || noteText.trim().length === 0}
                onClick={() => addNote.mutate()}
              >
                {addNote.isPending ? "Saving..." : "Add note"}
              </PrimaryButton>
            </div>
          </Panel>

          <Panel className="flex min-h-0 flex-col overflow-hidden xl:h-[760px]">
            <h2 className="mb-4 shrink-0 text-lg font-semibold text-foreground">
              Notes {selectedTrader ? `- ${selectedTrader.name}` : ""}
            </h2>
            {notes.length === 0 ? (
              <p className="text-sm text-muted">No notes yet for this trader.</p>
            ) : (
              <div className="invisible-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
                {notes.map((n) => (
                  <div key={n.id} className="border-b border-line bg-background px-4 py-3 last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-accent">{n.authorName}</p>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                        {new Date(n.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-foreground/90">{n.note}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
    </WorkspacePage>
  );
}

function labelModel(model: PartnerTraderDto["commissionModel"]): string {
  if (model === "IB") return "Rebate";
  if (model === "UNCONFIGURED") return "Not configured";
  return model;
}

function buildPipelineSteps(trader: PartnerTraderDto): Array<{ label: string; helper: string; done: boolean }> {
  return [
    {
      label: "Trader registered",
      helper: trader.registeredAt ? `Joined ${new Date(trader.registeredAt).toLocaleDateString()}` : "Trader profile exists in WSA.",
      done: true,
    },
    {
      label: "Broker account connected",
      helper: trader.accountCount > 0 ? `${trader.connectedAccounts}/${trader.accountCount} account(s) connected` : "Waiting for MT4 / MT5 account connection.",
      done: trader.accountCount > 0,
    },
    {
      label: "Live sync received",
      helper: trader.latestSyncAt ? `Last sync ${new Date(trader.latestSyncAt).toLocaleString()}` : "No live broker sync yet.",
      done: Boolean(trader.latestSyncAt),
    },
    {
      label: "Trading activity recorded",
      helper: `${trader.totalLotsTraded.toFixed(2)} lot(s) tracked for partner calculations.`,
      done: trader.totalLotsTraded > 0,
    },
    {
      label: "WSA earnings calculated",
      helper: `${formatMoney(trader.wsaCommissionEarned)} commission · ${formatMoney(trader.ibRebateEarned)} rebate · ${formatMoney(trader.cpaEarned)} CPA`,
      done: trader.wsaCommissionEarned.amount > 0 || trader.ibRebateEarned.amount > 0 || trader.cpaEarned.amount > 0,
    },
    {
      label: "Wallet / payout ready",
      helper: `${formatMoney(trader.approvedWalletContribution)} approved for the payout flow.`,
      done: trader.approvedWalletContribution.amount > 0,
    },
  ];
}

function MetricCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded-[4px] border border-line bg-background px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">{label}</p>
      <p className="mt-2 text-sm font-semibold text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted">{helper}</p>
    </div>
  );
}
