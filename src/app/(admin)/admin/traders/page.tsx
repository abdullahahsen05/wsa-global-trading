"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Plus, Search, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { DirectorySearchOverlay } from "@/components/app/DirectorySearchOverlay";
import {
  GhostButton,
  FilterChipRow,
  InlineStatusStrip,
  Panel,
  PageActionGroup,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SelectField, TextAreaField } from "@/components/app/FormFields";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatMoney } from "@/lib/utils/format";
import type { TraderProfileDto, CrmNoteDto } from "@/lib/domain/types";

type TraderRecord = TraderProfileDto;

export default function AdminTradersPage() {
  const queryClient = useQueryClient();
  const [searchOpen, setSearchOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [segmentFilter, setSegmentFilter] = useState<"ALL" | "FUNDED" | "EVALUATION" | "AT_RISK" | "VIP">("ALL");

  const { data: traders = [] } = useQuery<TraderProfileDto[]>({
    queryKey: ["crm-traders"],
    queryFn: async () => {
      const res = await fetch("/api/crm/traders");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load traders");
      return json.data;
    },
  });

  const { data: crmNotes = [] } = useQuery<CrmNoteDto[]>({
    queryKey: ["crm-notes"],
    queryFn: async () => {
      const res = await fetch("/api/crm/notes");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load notes");
      return json.data;
    },
  });

  const traderList = useMemo(() => traders, [traders]);
  const filteredTraders = traderList.filter((trader) => segmentFilter === "ALL" || trader.segment === segmentFilter);
  const effectiveSelectedId = selectedId || traderList[0]?.traderId || "";
  const selectedTrader = filteredTraders.find((trader) => trader.traderId === effectiveSelectedId) ?? filteredTraders[0] ?? traderList[0];
  const selectedNotes = selectedTrader ? crmNotes.filter((note) => note.traderId === selectedTrader.traderId) : [];

  const noteMutation = useMutation({
    mutationFn: async (data: { traderId: string; note: string }) => {
      const res = await fetch("/api/crm/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to save note");
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crm-notes"] });
      setNoteOpen(false);
      setSuccessMessage("CRM note saved to trader profile.");
    },
    onError: (err: Error) => {
      setSuccessMessage("");
      alert(err.message);
    },
  });

  const handleAddNote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const traderId = form.get("traderId") as string;
    const note = form.get("note") as string;
    if (!traderId || !note.trim()) return;
    noteMutation.mutate({ traderId, note });
  };

  return (
    <WorkspacePage
      eyebrow="CRM"
      title="Trader profiles"
      description="A sparse, overlay-first trader directory for profile management, note-taking, and support review."
      action={
        <PageActionGroup>
          <GhostButton type="button" onClick={() => setSearchOpen(true)}>
            <Search className="mr-2 inline-block h-4 w-4" />
            Search
          </GhostButton>
          <Dialog.Root open={noteOpen} onOpenChange={setNoteOpen}>
            <Dialog.Trigger asChild>
              <PrimaryButton type="button">
                <Plus className="mr-2 inline-block h-4 w-4" />
                New note
              </PrimaryButton>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
              <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-[7px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
                <Dialog.Title className="text-xl font-semibold text-foreground">Add CRM note</Dialog.Title>
                <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                  Write a relationship note against a trader profile and keep the activity timeline up to date.
                </Dialog.Description>
                <form className="mt-6 grid gap-4" onSubmit={handleAddNote}>
                  <SelectField label="Trader" name="traderId" defaultValue={selectedTrader?.traderId ?? ""}>
                    {traderList.map((trader) => (
                      <option key={trader.traderId} value={trader.traderId}>
                        {trader.name}
                      </option>
                    ))}
                  </SelectField>
                  <TextAreaField label="Note" name="note" defaultValue="" placeholder="Write a relationship note, follow-up, or risk observation..." />
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                    <p className="text-sm text-muted">
                      Notes are saved to the trader profile and visible to all admins.
                    </p>
                    <div className="flex gap-3">
                      <Dialog.Close asChild>
                        <GhostButton type="button">Cancel</GhostButton>
                      </Dialog.Close>
                      <PrimaryButton type="submit" disabled={noteMutation.isPending}>
                        {noteMutation.isPending ? "Saving..." : "Save note"}
                      </PrimaryButton>
                    </div>
                  </div>
                </form>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close dialog"
                    className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-[4px] border border-line bg-background text-muted"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          {
            label: "Funded",
            value: traderList.filter((trader) => trader.segment === "FUNDED").length,
            tone: "lime",
          },
          {
            label: "At risk",
            value: traderList.filter((trader) => trader.segment === "AT_RISK").length,
            tone: "accent",
          },
          { label: "CRM notes", value: crmNotes.length },
        ]}
      />

      <div className="mt-5 invisible-scrollbar overflow-x-auto border-b border-line pb-3">
        <FilterChipRow
          chips={[
            {
              label: `All segments (${traderList.length})`,
              active: segmentFilter === "ALL",
              onClick: () => {
                setSegmentFilter("ALL");
                setSelectedId(traderList[0]?.traderId ?? "");
              },
            },
            {
              label: `Funded (${traderList.filter((trader) => trader.segment === "FUNDED").length})`,
              active: segmentFilter === "FUNDED",
              onClick: () => {
                setSegmentFilter("FUNDED");
                setSelectedId(traderList.find((trader) => trader.segment === "FUNDED")?.traderId ?? traderList[0]?.traderId ?? "");
              },
            },
            {
              label: `Evaluation (${traderList.filter((trader) => trader.segment === "EVALUATION").length})`,
              active: segmentFilter === "EVALUATION",
              onClick: () => {
                setSegmentFilter("EVALUATION");
                setSelectedId(traderList.find((trader) => trader.segment === "EVALUATION")?.traderId ?? traderList[0]?.traderId ?? "");
              },
            },
            {
              label: `At risk (${traderList.filter((trader) => trader.segment === "AT_RISK").length})`,
              active: segmentFilter === "AT_RISK",
              onClick: () => {
                setSegmentFilter("AT_RISK");
                setSelectedId(traderList.find((trader) => trader.segment === "AT_RISK")?.traderId ?? traderList[0]?.traderId ?? "");
              },
            },
            {
              label: `VIP (${traderList.filter((trader) => trader.segment === "VIP").length})`,
              active: segmentFilter === "VIP",
              onClick: () => {
                setSegmentFilter("VIP");
                setSelectedId(traderList.find((trader) => trader.segment === "VIP")?.traderId ?? traderList[0]?.traderId ?? "");
              },
            },
          ]}
        />
      </div>

      {successMessage ? (
        <div className="mt-5 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
          {successMessage}
        </div>
      ) : null}

      <div className="mt-5">
        <Panel className="min-w-0">
          {!selectedTrader ? (
            <p className="text-sm text-muted">Loading traders...</p>
          ) : (
          <><div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Selected trader</p>
              <h2 className="mt-2 text-lg font-semibold text-foreground">{selectedTrader.name}</h2>
              <p className="mt-1 text-sm text-muted">{selectedTrader.email}</p>
            </div>
            <StatusPill tone={selectedTrader.segment === "AT_RISK" ? "accent" : "lime"}>
              {selectedTrader.segment}
            </StatusPill>
          </div>

          <div className="mt-4 grid gap-0 overflow-hidden rounded-[4px] border-l border-t border-line sm:grid-cols-2 xl:grid-cols-4">
            <div className="border-b border-r border-line bg-background px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Accounts</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{selectedTrader.accountCount}</p>
            </div>
            <div className="border-b border-r border-line bg-background px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Equity</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{formatMoney(selectedTrader.totalEquity)}</p>
            </div>
            <div className="border-b border-r border-line bg-background px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Last active</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{new Date(selectedTrader.lastActivityAt).toLocaleString()}</p>
            </div>
            <div className="border-b border-r border-line bg-background px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Profile state</p>
              <p className="mt-1 text-sm font-semibold text-foreground">Under review</p>
            </div>
          </div>

          <div className="mt-5 border-t border-line pt-5">
            <h3 className="text-sm font-semibold text-foreground">Latest notes</h3>
            <div className="mt-4 space-y-3">
              {selectedNotes.length === 0 ? (
                <div className="border-t border-line py-4">
                  <p className="text-sm font-semibold text-foreground">No notes yet</p>
                  <p className="mt-1 text-sm text-muted">This trader has no CRM notes yet.</p>
                </div>
              ) : (
                selectedNotes.map((note) => (
                  <div key={note.id} className="border-t border-line py-4">
                    <p className="text-sm leading-6 text-foreground">{note.note}</p>
                    <p className="mt-2 text-xs text-muted">
                      {note.authorName} - {new Date(note.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
          </>
          )}
        </Panel>
      </div>

      <DirectorySearchOverlay<TraderRecord>
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Find traders"
        description="Search and segment filtering stay in the overlay so the page shell stays minimal."
        items={traderList}
        selectedId={effectiveSelectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setSearchOpen(false);
        }}
        searchLabel="Search traders"
        searchPlaceholder="Search by name or email"
        filters={[
          {
            key: "segment",
            label: "Segment",
            options: [
              { value: "ALL", label: "All segments" },
              { value: "EVALUATION", label: "Evaluation" },
              { value: "FUNDED", label: "Funded" },
              { value: "AT_RISK", label: "At risk" },
              { value: "VIP", label: "VIP" },
            ],
          },
        ]}
        emptyTitle="No traders match"
        emptyDescription="Change the search term or segment filter."
        getId={(trader) => trader.traderId}
        matches={(trader, state) => {
          const search = state.query.trim().toLowerCase();
          const matchesQuery =
            search.length === 0 ||
            trader.name.toLowerCase().includes(search) ||
            trader.email.toLowerCase().includes(search);
          const matchesSegment = state.filters.segment === "ALL" || trader.segment === state.filters.segment;
          return matchesQuery && matchesSegment;
        }}
        renderRow={(trader) => (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{trader.name}</p>
                <p className="mt-1 truncate text-xs text-muted">{trader.email}</p>
              </div>
              <StatusPill tone={trader.segment === "AT_RISK" ? "accent" : "lime"}>{trader.segment}</StatusPill>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {trader.accountCount} accounts
              </span>
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {new Date(trader.lastActivityAt).toLocaleDateString()}
              </span>
            </div>
          </>
        )}
        renderPreview={(trader) => (
          <Panel className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Trader preview</p>
                <h3 className="mt-2 text-lg font-semibold text-foreground">{trader.name}</h3>
                <p className="mt-1 text-sm text-muted">{trader.email}</p>
              </div>
              <StatusPill tone={trader.segment === "AT_RISK" ? "accent" : "lime"}>{trader.segment}</StatusPill>
            </div>
            <div className="mt-4 grid gap-0 overflow-hidden rounded-[4px] border-l border-t border-line sm:grid-cols-2">
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Accounts</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{trader.accountCount}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Equity</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{formatMoney(trader.totalEquity)}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Last active</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{new Date(trader.lastActivityAt).toLocaleString()}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Mode</p>
                <p className="mt-1 text-sm font-semibold text-foreground">Support + risk review</p>
              </div>
            </div>
          </Panel>
        )}
      />
    </WorkspacePage>
  );
}
