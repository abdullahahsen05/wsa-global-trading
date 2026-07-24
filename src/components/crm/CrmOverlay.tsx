"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import { Plus, Search, X } from "lucide-react";
import {
  EmptyState,
  FilterChipRow,
  GhostButton,
  Panel,
  PrimaryButton,
  StatusPill,
  itemMotion,
  pageMotion,
} from "@/components/app/WorkspaceUI";
import { SearchField, SelectField } from "@/components/app/FormFields";
import type {
  CrmContact,
  CrmNoteItem,
  CrmRoleFilter,
  CrmSegmentFilter,
  CrmTab,
} from "@/components/crm/crmTypes";

type TimelineEntryType = "note" | "status" | "risk" | "subscription";

type TimelineEntry = {
  id: string;
  type: TimelineEntryType;
  title: string;
  description: string;
  at: string;
};

type CrmOverlayProps = {
  open: boolean;
  activeTab: CrmTab | null;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: CrmTab) => void;
  contacts: CrmContact[];
  selectedContact: CrmContact | null;
  selectedId: string;
  onSelectContact: (id: string) => void;
  query: string;
  onQueryChange: (value: string) => void;
  roleFilter: CrmRoleFilter;
  onRoleFilterChange: (value: CrmRoleFilter) => void;
  segmentFilter: CrmSegmentFilter;
  onSegmentFilterChange: (value: CrmSegmentFilter) => void;
  currentPage: number;
  pageSize: number;
  totalContacts: number;
  visibleContacts: CrmContact[];
  onCurrentPageChange: (page: number) => void;
  selectedNotes: CrmNoteItem[];
  onOpenNoteEditor: () => void;
  onFeedbackMessage: (message: string) => void;
};

const tabOptions: Array<{ key: CrmTab; label: string }> = [
  { key: "CONTACT_DIRECTORY", label: "Contacts" },
  { key: "PROFILE_DETAIL", label: "Profile" },
  { key: "BILLING", label: "Billing" },
  { key: "ACTIVITY", label: "Activity" },
];

function tabButtonClass(active: boolean) {
  return `btn-dark h-9 px-4 text-xs transition ${
    active
      ? "btn-active"
      : ""
  }`;
}

function DotTone({ type }: { type: TimelineEntryType }) {
  const className =
    type === "note"
      ? "bg-accent"
      : type === "status"
        ? "bg-accent-2"
        : type === "risk"
          ? "bg-danger"
          : "bg-muted";

  return <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${className}`} />;
}

function buildTimeline(selectedContact: CrmContact, selectedNotes: CrmNoteItem[]): TimelineEntry[] {
  const statusBase = new Date(selectedContact.lastActivityAt);
  const subscriptionBase = new Date(selectedContact.lastActivityAt);
  subscriptionBase.setHours(subscriptionBase.getHours() - 8);
  const riskBase = new Date(selectedContact.lastActivityAt);
  riskBase.setHours(riskBase.getHours() - 18);

  const noteEntries = selectedNotes.map((note) => ({
    id: note.id,
    type: "note" as const,
    title: note.authorName,
    description: note.note,
    at: new Date(note.createdAt).toLocaleString(),
  }));

  const statusEntries: TimelineEntry[] = [
    {
      id: `status-${selectedContact.id}`,
      type: "status",
      title: "Status change",
      description: `Profile is currently ${selectedContact.status.toLowerCase().replaceAll("_", " ")}.`,
      at: statusBase.toLocaleString(),
    },
    {
      id: `risk-${selectedContact.id}`,
      type: "risk",
      title: "Risk review",
      description:
        selectedContact.status === "AT_RISK"
          ? "Risk desk review remains active for this contact."
          : "Risk posture remains stable in the current supervision snapshot.",
      at: riskBase.toLocaleString(),
    },
    {
      id: `subscription-${selectedContact.id}`,
      type: "subscription",
      title: "Subscription",
      description: `Current plan set to ${selectedContact.subscription}.`,
      at: subscriptionBase.toLocaleString(),
    },
  ];

  return [...noteEntries, ...statusEntries];
}

export function CrmOverlay({
  open,
  activeTab,
  onOpenChange,
  onTabChange,
  contacts,
  selectedContact,
  selectedId,
  onSelectContact,
  query,
  onQueryChange,
  roleFilter,
  onRoleFilterChange,
  segmentFilter,
  onSegmentFilterChange,
  currentPage,
  pageSize,
  totalContacts,
  visibleContacts,
  onCurrentPageChange,
  selectedNotes,
  onOpenNoteEditor,
  onFeedbackMessage,
}: CrmOverlayProps) {
  const totalPages = Math.max(1, Math.ceil(totalContacts / pageSize));
  const currentPageSafe = Math.min(currentPage, totalPages);
  const startIndex = totalContacts === 0 ? 0 : (currentPageSafe - 1) * pageSize;
  const selectedTitle = selectedContact ? selectedContact.name : "No contact selected";
  const selectedSegment = selectedContact?.segment ?? "";
  const timelineEntries = selectedContact ? buildTimeline(selectedContact, selectedNotes) : [];

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/82" />
        <Dialog.Content className="fixed inset-0 z-50 overflow-hidden bg-panel focus:outline-none">
          <motion.div
            initial={{ opacity: 0, y: 36 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 36 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="flex h-full w-full flex-col"
          >
            <Dialog.Title className="sr-only">CRM overlay</Dialog.Title>
            <Dialog.Description className="sr-only">
              CRM overlay for contacts, profile detail, billing, and activity review.
            </Dialog.Description>

            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                {tabOptions.map((tab) => {
                  const active = activeTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => onTabChange(tab.key)}
                      className={tabButtonClass(active)}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-start gap-3">
                <div className="text-right">
                  <p className="text-sm font-semibold text-foreground">{selectedTitle}</p>
                  {selectedContact ? (
                    <p className="mt-1 text-xs text-muted">{selectedContact.email}</p>
                  ) : (
                    <p className="mt-1 text-xs text-muted">No contact selected</p>
                  )}
                </div>
                {selectedContact ? (
                  <StatusPill tone={selectedContact.status === "AT_RISK" ? "accent" : "lime"}>{selectedSegment}</StatusPill>
                ) : (
                  <StatusPill tone="muted">No contact selected</StatusPill>
                )}
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close CRM overlay"
                    className="grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted transition hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </div>
            </div>

            <motion.div variants={pageMotion} initial="hidden" animate="show" className="min-h-0 flex-1 invisible-scrollbar overflow-y-auto p-5">
              {activeTab === "CONTACT_DIRECTORY" ? (
                <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
                  <Panel>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Directory</p>
                        <h3 className="mt-2 text-lg font-semibold text-foreground">Search contacts</h3>
                        <p className="mt-1 text-sm leading-6 text-muted">Keep search and filters in the overlay.</p>
                      </div>
                      <Search className="h-5 w-5 text-accent" />
                    </div>

                    <div className="mt-4 grid gap-3">
                      <SearchField
                        label="Search contacts"
                        placeholder="Name, email, or team"
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                      />
                      <div className="grid gap-3">
                        <div className="grid gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Quick scope</p>
                          <FilterChipRow
                            chips={[
                              {
                                label: "All profiles",
                                active: roleFilter === "ALL",
                                onClick: () => onRoleFilterChange("ALL"),
                              },
                              {
                                label: "Traders",
                                active: roleFilter === "TRADER",
                                onClick: () => onRoleFilterChange("TRADER"),
                              },
                              {
                                label: "Platform users",
                                active: roleFilter === "PLATFORM_USER",
                                onClick: () => onRoleFilterChange("PLATFORM_USER"),
                              },
                            ]}
                          />
                        </div>
                        <SelectField
                          label="Role"
                          value={roleFilter}
                          onChange={(event) => onRoleFilterChange(event.target.value as CrmRoleFilter)}
                        >
                          <option value="ALL">All roles</option>
                          <option value="TRADER">Trader</option>
                          <option value="PLATFORM_USER">Platform user</option>
                        </SelectField>
                        <SelectField
                          label="Segment"
                          value={segmentFilter}
                          onChange={(event) => onSegmentFilterChange(event.target.value as CrmSegmentFilter)}
                        >
                          <option value="ALL">All segments</option>
                          <option value="FUNDED">Funded</option>
                          <option value="EVALUATION">Evaluation</option>
                          <option value="AT_RISK">At risk</option>
                          <option value="OPERATIONS">Operations</option>
                          <option value="RISK">Risk</option>
                        </SelectField>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-between gap-3 border-b border-line pb-4">
                      <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted">
                        {totalContacts === 0
                          ? "No matches"
                          : `${startIndex + 1}-${Math.min(startIndex + pageSize, totalContacts)} of ${totalContacts}`}
                      </p>
                      <div className="flex gap-2">
                        <GhostButton
                          type="button"
                          disabled={currentPageSafe <= 1}
                          onClick={() => onCurrentPageChange(Math.max(1, currentPageSafe - 1))}
                        >
                          Prev
                        </GhostButton>
                        <GhostButton
                          type="button"
                          disabled={currentPageSafe >= totalPages}
                          onClick={() => onCurrentPageChange(Math.min(totalPages, currentPageSafe + 1))}
                        >
                          Next
                        </GhostButton>
                      </div>
                    </div>
                  </Panel>

                  <Panel className="min-h-0">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Results</p>
                        <h3 className="mt-2 text-lg font-semibold text-foreground">Paginated contact list</h3>
                        <p className="mt-1 text-sm leading-6 text-muted">Select a profile to jump straight to details.</p>
                      </div>
                      <StatusPill tone="muted">{contacts.length} contacts</StatusPill>
                    </div>
                    <div className="mt-4 max-h-[calc(100vh-260px)] space-y-2 invisible-scrollbar overflow-y-auto pr-1">
                      {totalContacts === 0 ? (
                        <EmptyState
                          title="No profiles match"
                          description="Refine the search or filter values."
                        />
                      ) : (
                        visibleContacts.map((contact) => {
                          const active = contact.id === selectedId;
                          return (
                            <button
                              key={contact.id}
                              type="button"
                              onClick={() => {
                                onSelectContact(contact.id);
                                onTabChange("PROFILE_DETAIL");
                              }}
                              className={`w-full rounded-[4px] border p-3 text-left transition ${
                                active ? "border-accent/40 bg-accent/10" : "border-line bg-background hover:border-accent/30"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-foreground">{contact.name}</p>
                                  <p className="mt-1 truncate text-xs text-muted">{contact.email}</p>
                                </div>
                                <StatusPill tone={contact.role === "TRADER" ? "lime" : "accent"}>{contact.role}</StatusPill>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                                  {contact.role === "TRADER" ? contact.segment : contact.team}
                                </span>
                                <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                                  {new Date(contact.lastActivityAt).toLocaleDateString()}
                                </span>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </Panel>
                </div>
              ) : null}

              {activeTab === "PROFILE_DETAIL" ? (
                <Panel>
                  {selectedContact ? (
                    <motion.div variants={itemMotion}>
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Selected profile</p>
                          <h3 className="mt-2 text-lg font-semibold text-foreground">{selectedContact.name}</h3>
                          <p className="mt-1 text-sm text-muted">{selectedContact.email}</p>
                        </div>
                        <StatusPill tone={selectedContact.status === "AT_RISK" ? "accent" : "lime"}>
                          {selectedContact.status}
                        </StatusPill>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Role</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">
                            {selectedContact.role === "TRADER" ? "Trader" : "Platform user"}
                          </p>
                        </div>
                        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Subscription</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">{selectedContact.subscription}</p>
                        </div>
                        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Segment</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">{selectedContact.segment}</p>
                        </div>
                        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Last activity</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">
                            {new Date(selectedContact.lastActivityAt).toLocaleString()}
                          </p>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        {selectedContact.tags.map((tag) => (
                          <span key={tag} className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                            {tag}
                          </span>
                        ))}
                      </div>

                      <div className="mt-5 border-t border-line pt-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h4 className="text-sm font-semibold text-foreground">Latest notes</h4>
                            <p className="mt-1 text-xs text-muted">Communication and notes history for this profile.</p>
                          </div>
                          <div className="flex flex-wrap gap-3">
                            <PrimaryButton type="button" onClick={onOpenNoteEditor}>
                              <Plus className="mr-2 inline-block h-4 w-4" />
                              New note
                            </PrimaryButton>
                            <GhostButton type="button" onClick={() => onTabChange("BILLING")}>
                              Open billing
                            </GhostButton>
                          </div>
                        </div>
                        <div className="mt-4 space-y-3">
                          {selectedNotes.length === 0 ? (
                            <EmptyState title="No notes yet" description="This profile has no CRM notes yet." />
                          ) : (
                            selectedNotes.slice(0, 2).map((note) => (
                              <div key={note.id} className="rounded-[4px] border border-line bg-background p-4">
                                <p className="text-sm leading-6 text-foreground">{note.note}</p>
                                <p className="mt-2 text-xs text-muted">
                                  {note.authorName} - {new Date(note.createdAt).toLocaleString()}
                                </p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </motion.div>
                  ) : (
                    <EmptyState
                      title="Select a contact from the directory"
                      description="Open the directory tab and choose a profile to continue."
                      action={
                        <GhostButton type="button" onClick={() => onTabChange("CONTACT_DIRECTORY")}>
                          Open Directory
                        </GhostButton>
                      }
                    />
                  )}
                </Panel>
              ) : null}

              {activeTab === "BILLING" ? (
                <Panel>
                  {selectedContact ? (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Billing</p>
                          <h3 className="mt-2 text-lg font-semibold text-foreground">{selectedContact.subscription}</h3>
                          <p className="mt-1 text-sm text-muted">Subscription management and renewal readiness.</p>
                        </div>
                        <StatusPill tone={selectedContact.status === "AT_RISK" ? "accent" : "lime"}>Active</StatusPill>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Started</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">
                            {new Date(selectedContact.lastActivityAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Ends</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">
                            {selectedContact.role === "TRADER" ? "In 12 days" : "Managed internally"}
                          </p>
                        </div>
                        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Linked accounts</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">{selectedContact.accountIds.length}</p>
                        </div>
                        <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">State</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">Managed in mock billing</p>
                        </div>
                      </div>

                      <div className="mt-5 flex flex-wrap gap-3">
                        <GhostButton
                          type="button"
                          onClick={() => onFeedbackMessage(`Cancellation queued for ${selectedContact.name}.`)}
                        >
                          Cancel plan
                        </GhostButton>
                        <PrimaryButton
                          type="button"
                          onClick={() => onFeedbackMessage(`Upgrade queued for ${selectedContact.name}.`)}
                        >
                          Upgrade plan
                        </PrimaryButton>
                      </div>
                    </>
                  ) : (
                    <EmptyState
                      title="Select a contact from the directory"
                      description="Billing details appear once a profile is selected."
                      action={
                        <GhostButton type="button" onClick={() => onTabChange("CONTACT_DIRECTORY")}>
                          Open Directory
                        </GhostButton>
                      }
                    />
                  )}
                </Panel>
              ) : null}

              {activeTab === "ACTIVITY" ? (
                <Panel>
                  {selectedContact ? (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Activity</p>
                          <h3 className="mt-2 text-lg font-semibold text-foreground">{selectedContact.name}</h3>
                          <p className="mt-1 text-sm text-muted">CRM notes and history timeline for this profile.</p>
                        </div>
                        <StatusPill tone={selectedContact.status === "AT_RISK" ? "accent" : "lime"}>
                          {selectedContact.segment}
                        </StatusPill>
                      </div>

                      <div className="mt-5 space-y-3">
                        {timelineEntries.map((entry) => (
                          <div key={entry.id} className="rounded-[4px] border border-line bg-background p-4">
                            <div className="flex items-start gap-3">
                              <DotTone type={entry.type} />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <p className="text-sm font-semibold text-foreground">{entry.title}</p>
                                  <StatusPill
                                    tone={
                                      entry.type === "risk"
                                        ? "danger"
                                        : entry.type === "subscription"
                                          ? "muted"
                                          : entry.type === "status"
                                            ? "lime"
                                            : "accent"
                                    }
                                  >
                                    {entry.type}
                                  </StatusPill>
                                </div>
                                <p className="mt-2 text-sm leading-6 text-muted">{entry.description}</p>
                                <p className="mt-2 text-xs text-muted">{entry.at}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <EmptyState
                      title="Select a contact from the directory"
                      description="Activity history appears after a profile is selected."
                      action={
                        <GhostButton type="button" onClick={() => onTabChange("CONTACT_DIRECTORY")}>
                          Open Directory
                        </GhostButton>
                      }
                    />
                  )}
                </Panel>
              ) : null}
            </motion.div>
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
