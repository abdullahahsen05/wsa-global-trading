"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, GhostButton, InlineStatusStrip, Panel, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import { CrmOverlay } from "@/components/crm/CrmOverlay";
import { NoteEditorDialog } from "@/components/crm/NoteEditorDialog";
import type { CrmContact, CrmNoteItem, CrmRoleFilter, CrmSegmentFilter, CrmTab } from "@/components/crm/crmTypes";
import type { TraderProfileDto, CrmNoteDto } from "@/lib/domain/types";

const crmTabs: Array<{ key: CrmTab; label: string }> = [
  { key: "CONTACT_DIRECTORY", label: "Contacts" },
  { key: "PROFILE_DETAIL", label: "Profile" },
  { key: "BILLING", label: "Billing" },
  { key: "ACTIVITY", label: "Activity" },
];

function tabButtonClass(active: boolean) {
  return `h-10 shrink-0 border-b-2 px-1 text-sm font-medium transition-colors ${
    active ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
  }`;
}

function traderToContact(trader: TraderProfileDto): CrmContact {
  return {
    id: trader.traderId,
    name: trader.name,
    email: trader.email,
    role: "TRADER",
    segment: trader.segment,
    status: trader.segment === "AT_RISK" ? "AT_RISK" : "ACTIVE",
    team: "Funding desk",
    accountIds: [],
    assignedTraders: [],
    subscription: trader.segment === "FUNDED" ? "Funded Pro" : "Evaluation",
    lastActivityAt: trader.lastActivityAt,
    tags: trader.segment === "AT_RISK" ? ["Monitoring", "Needs review"] : ["Top performer"],
  };
}

function noteToItem(note: CrmNoteDto): CrmNoteItem {
  return {
    id: note.id,
    authorName: note.authorName,
    note: note.note,
    createdAt: note.createdAt,
  };
}

export default function AdminCrmPage() {
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<CrmRoleFilter>("ALL");
  const [segmentFilter, setSegmentFilter] = useState<CrmSegmentFilter>("ALL");
  const [currentPage, setCurrentPage] = useState(1);
  const [activeOverlay, setActiveOverlay] = useState<CrmTab | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const pageSize = 10;

  const { data: traders = [] } = useQuery<TraderProfileDto[]>({
    queryKey: ["crm-traders"],
    queryFn: async () => {
      const res = await fetch("/api/crm/traders");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load traders");
      return json.data;
    },
  });

  const { data: crmNotesRaw = [] } = useQuery<CrmNoteDto[]>({
    queryKey: ["crm-notes"],
    queryFn: async () => {
      const res = await fetch("/api/crm/notes");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load CRM notes");
      return json.data;
    },
  });

  const crmContacts: CrmContact[] = useMemo(() => traders.map(traderToContact), [traders]);
  const crmNotes: CrmNoteItem[] = useMemo(() => crmNotesRaw.map(noteToItem), [crmNotesRaw]);

  const effectiveSelectedId = selectedId || crmContacts[0]?.id || "";

  const filteredContacts = useMemo(() => {
    const search = query.trim().toLowerCase();
    return crmContacts.filter((contact) => {
      const matchesQuery =
        search.length === 0 ||
        contact.name.toLowerCase().includes(search) ||
        contact.email.toLowerCase().includes(search) ||
        contact.team.toLowerCase().includes(search);
      const matchesRole = roleFilter === "ALL" || contact.role === roleFilter;
      const matchesSegment = segmentFilter === "ALL" || contact.segment === segmentFilter;
      return matchesQuery && matchesRole && matchesSegment;
    });
  }, [query, roleFilter, segmentFilter, crmContacts]);

  const totalContacts = filteredContacts.length;
  const totalPages = Math.max(1, Math.ceil(totalContacts / pageSize));
  const currentPageSafe = Math.min(currentPage, totalPages);
  const startIndex = (currentPageSafe - 1) * pageSize;
  const visibleContacts = filteredContacts.slice(startIndex, startIndex + pageSize);

  const selectedContact = filteredContacts.find((contact) => contact.id === effectiveSelectedId) ?? null;
  const selectedNotes: CrmNoteItem[] = selectedContact
    ? crmNotes.filter((note) => {
        // CrmNoteDto has traderId, CrmNoteItem we mapped doesn't carry it
        // We need to find from raw notes
        const rawNote = crmNotesRaw.find((n) => n.id === note.id);
        return rawNote?.traderId === selectedContact.id;
      })
    : [];
  const recentNotes = selectedNotes.slice(0, 3);

  return (
    <WorkspacePage
      eyebrow="Admin console"
      title="CRM"
      description="Centralized management system for all traders and platform users."
    >
      <div className="invisible-scrollbar overflow-x-auto border-b border-line">
        <div className="flex min-w-max gap-7">
          {crmTabs.map((tab) => {
            const active = activeOverlay === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveOverlay(tab.key)}
                className={tabButtonClass(active)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <InlineStatusStrip
        items={[
          { label: "Profiles", value: crmContacts.length },
          {
            label: "Traders",
            value: crmContacts.filter((contact) => contact.role === "TRADER").length,
            tone: "lime",
          },
          {
            label: "Platform users",
            value: crmContacts.filter((contact) => contact.role === "PLATFORM_USER").length,
            tone: "accent",
          },
          { label: "Active subscriptions", value: crmContacts.filter((c) => c.segment === "FUNDED").length, tone: "lime" },
        ]}
      />

      {feedbackMessage ? (
        <div className="mt-5 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
          {feedbackMessage}
        </div>
      ) : null}

      <div className="mt-5 grid items-stretch gap-4 lg:h-[420px] lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <Panel className="invisible-scrollbar min-h-0 overflow-y-auto lg:h-full">
          {selectedContact ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Selected profile</p>
                  <h3 className="mt-2 text-xl font-semibold text-foreground">{selectedContact.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted">{selectedContact.email}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={selectedContact.status === "AT_RISK" ? "danger" : "lime"}>
                    {selectedContact.status === "AT_RISK" ? "At risk" : "Active"}
                  </StatusPill>
                  <StatusPill tone={selectedContact.role === "TRADER" ? "lime" : "accent"}>
                    {selectedContact.role === "TRADER" ? "Trader" : "Platform user"}
                  </StatusPill>
                </div>
              </div>

              <div className="mt-4 grid gap-0 overflow-hidden rounded-[4px] border-l border-t border-line sm:grid-cols-2 xl:grid-cols-4">
                <div className="border-b border-r border-line bg-background px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Segment</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{selectedContact.segment}</p>
                </div>
                <div className="border-b border-r border-line bg-background px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Team</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{selectedContact.team}</p>
                </div>
                <div className="border-b border-r border-line bg-background px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Linked accounts</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{selectedContact.accountIds.length}</p>
                </div>
                <div className="border-b border-r border-line bg-background px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Subscription</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{selectedContact.subscription}</p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {selectedContact.tags.map((tag) => (
                  <span key={tag} className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                    {tag}
                  </span>
                ))}
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
                  Last active - {new Date(selectedContact.lastActivityAt).toLocaleString()}
                </p>
                <GhostButton type="button" onClick={() => setActiveOverlay("PROFILE_DETAIL")}>
                  Open full profile
                </GhostButton>
              </div>
            </>
          ) : (
            <EmptyState
              title="Select a profile"
              description="Choose a contact from the directory to show the CRM preview."
              action={
                <GhostButton type="button" onClick={() => setActiveOverlay("CONTACT_DIRECTORY")}>
                  Open directory
                </GhostButton>
              }
            />
          )}
        </Panel>

        <Panel className="flex min-h-0 flex-col overflow-hidden lg:h-full">
          {selectedContact ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Recent activity</p>
                  <h3 className="mt-2 text-xl font-semibold text-foreground">{selectedContact.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted">Latest notes and CRM updates.</p>
                </div>
                <GhostButton type="button" onClick={() => setActiveOverlay("ACTIVITY")}>
                  Open activity
                </GhostButton>
              </div>

              <div className="invisible-scrollbar mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto">
                {recentNotes.length === 0 ? (
                  <div className="border-t border-line py-4">
                    <p className="text-sm font-semibold text-foreground">No notes yet</p>
                    <p className="mt-1 text-sm text-muted">This profile does not have any CRM notes.</p>
                  </div>
                ) : (
                  recentNotes.map((note) => (
                    <div key={note.id} className="border-t border-line py-4">
                      <p className="text-sm leading-6 text-foreground">{note.note}</p>
                      <p className="mt-2 text-xs text-muted">
                        {note.authorName} - {new Date(note.createdAt).toLocaleString()}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <EmptyState
              title="No activity to show"
              description="Pick a contact to surface notes and activity history."
              action={
                <GhostButton type="button" onClick={() => setActiveOverlay("CONTACT_DIRECTORY")}>
                  Open directory
                </GhostButton>
              }
            />
          )}
        </Panel>
      </div>

      <CrmOverlay
        open={activeOverlay !== null}
        activeTab={activeOverlay}
        onOpenChange={(open) => {
          if (!open) {
            setActiveOverlay(null);
          }
        }}
        onTabChange={setActiveOverlay}
        contacts={crmContacts}
        selectedContact={selectedContact}
        selectedId={effectiveSelectedId}
        onSelectContact={(id) => setSelectedId(id)}
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setCurrentPage(1);
        }}
        roleFilter={roleFilter}
        onRoleFilterChange={(value) => {
          setRoleFilter(value);
          setCurrentPage(1);
        }}
        segmentFilter={segmentFilter}
        onSegmentFilterChange={(value) => {
          setSegmentFilter(value);
          setCurrentPage(1);
        }}
        currentPage={currentPageSafe}
        pageSize={pageSize}
        totalContacts={totalContacts}
        visibleContacts={visibleContacts}
        onCurrentPageChange={setCurrentPage}
        selectedNotes={selectedNotes}
        onOpenNoteEditor={() => setNoteOpen(true)}
        onFeedbackMessage={setFeedbackMessage}
      />

      <NoteEditorDialog
        open={noteOpen}
        onOpenChange={setNoteOpen}
        selectedName={selectedContact?.name ?? ""}
        onSave={setFeedbackMessage}
      />
    </WorkspacePage>
  );
}
