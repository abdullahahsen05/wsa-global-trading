"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EmptyState,
  Panel,
  PrimaryButton,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SelectField, TextAreaField } from "@/components/app/FormFields";
import type { PartnerTraderDto } from "@/lib/partner/types";
import type { CrmNoteDto } from "@/lib/domain/types";

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
      description="Keep private notes on the traders assigned to you."
    >
      {!isLoading && traders.length === 0 ? (
        <EmptyState
          title="No traders assigned yet"
          description="Once traders are assigned to you, you can keep notes about them here."
        />
      ) : (
        <div className="grid items-stretch gap-5 xl:h-[560px] xl:grid-cols-[1fr_1.4fr]">
          <Panel className="flex min-h-0 flex-col xl:h-full">
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

          <Panel className="flex min-h-0 flex-col overflow-hidden xl:h-full">
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
