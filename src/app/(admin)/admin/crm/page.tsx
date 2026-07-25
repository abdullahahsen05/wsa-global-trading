"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MessageSquarePlus, Search, UserRoundSearch, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
  controlClassName,
  selectClassName,
  textareaClassName,
} from "@/components/app/WorkspaceUI";
import type {
  CrmNoteDto,
  RiskSeverity,
  TraderCrmDirectoryDto,
  TraderCrmItemDto,
} from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";

type SegmentFilter = "ALL" | "EVALUATION" | "FUNDED" | "AT_RISK" | "VIP";
type StatusFilter = "ALL" | "ACTIVE" | "SUSPENDED" | "PENDING";
type SortOption = "NEWEST" | "OLDEST";
type PartnerOption = {
  userId: string;
  name: string;
  email: string;
  partnerStatus: string;
};

function useDebouncedValue(value: string, delay = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

async function readApi<T>(response: Response): Promise<T> {
  const json = await response.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
}

function statusTone(status: TraderCrmItemDto["profileStatus"]): "lime" | "accent" | "danger" {
  if (status === "ACTIVE") return "lime";
  if (status === "SUSPENDED") return "danger";
  return "accent";
}

function riskTone(severity: RiskSeverity | null): "lime" | "accent" | "danger" {
  if (severity === "CRITICAL") return "danger";
  if (severity === "WARNING" || severity === "INFO") return "accent";
  return "lime";
}

function equityLabel(trader: TraderCrmItemDto): string {
  if (trader.totalEquity) return formatMoney(trader.totalEquity);
  const accountsWithEquity = trader.accounts.filter((account) => account.equity);
  const currencies = new Set(accountsWithEquity.map((account) => account.currency));
  if (currencies.size > 1) return "Multiple currencies";
  if (accountsWithEquity.length > 0) return "Incomplete sync";
  return "Not synced";
}

function dateLabel(value: string | null, includeTime = false): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return includeTime ? date.toLocaleString() : date.toLocaleDateString();
}

export default function AdminCrmPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("ALL");
  const [profileStatus, setProfileStatus] = useState<StatusFilter>("ALL");
  const [partnerId, setPartnerId] = useState("");
  const [sort, setSort] = useState<SortOption>("NEWEST");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selectedId, setSelectedId] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const debouncedSearch = useDebouncedValue(search);

  const directoryQuery = useQuery<TraderCrmDirectoryDto>({
    queryKey: [
      "crm-traders-directory",
      page,
      pageSize,
      debouncedSearch,
      segment,
      profileStatus,
      partnerId,
      sort,
    ],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({
        view: "directory",
        page: String(page),
        pageSize: String(pageSize),
        search: debouncedSearch,
        segment,
        status: profileStatus,
        partnerId,
        sort,
      });
      return readApi<TraderCrmDirectoryDto>(await fetch(`/api/crm/traders?${params}`));
    },
  });

  const partnersQuery = useQuery<PartnerOption[]>({
    queryKey: ["admin-partner-options"],
    queryFn: async () => readApi<PartnerOption[]>(await fetch("/api/admin/partners")),
  });

  const traders = directoryQuery.data?.items ?? [];
  const selectedTrader =
    traders.find((trader) => trader.traderId === selectedId) ??
    traders[0] ??
    null;

  const notesQuery = useQuery<CrmNoteDto[]>({
    queryKey: ["crm-notes", selectedTrader?.traderId],
    enabled: Boolean(selectedTrader),
    queryFn: async () =>
      readApi<CrmNoteDto[]>(
        await fetch(`/api/crm/notes?traderId=${encodeURIComponent(selectedTrader!.traderId)}`),
      ),
  });

  const noteMutation = useMutation({
    mutationFn: async ({ traderId, note }: { traderId: string; note: string }) =>
      readApi<CrmNoteDto>(await fetch("/api/crm/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traderId, note }),
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["crm-notes", selectedTrader?.traderId] });
      void queryClient.invalidateQueries({ queryKey: ["crm-traders-directory"] });
      setNoteText("");
      setNoteOpen(false);
      setNotice({ type: "success", text: "CRM note saved." });
    },
    onError: (error: Error) => setNotice({ type: "error", text: error.message }),
  });

  const submitNote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const note = noteText.trim();
    if (!selectedTrader || !note) return;
    setNotice(null);
    noteMutation.mutate({ traderId: selectedTrader.traderId, note });
  };

  const directory = directoryQuery.data;
  const counts = directory?.counts;
  const pagination = directory?.pagination;
  const notes = notesQuery.data ?? [];
  const partners = useMemo(
    () => (partnersQuery.data ?? []).filter((partner) => partner.partnerStatus === "ACTIVE"),
    [partnersQuery.data],
  );

  return (
    <WorkspacePage
      eyebrow="Admin console"
      title="Trader CRM"
      description="Search traders, inspect real account and risk data, and maintain a single communication history."
    >
      <div className="grid grid-cols-2 border-l border-t border-line bg-panel md:grid-cols-3 2xl:grid-cols-6">
        {[
          { label: "Trader profiles", value: counts?.total ?? "—", tone: "text-foreground" },
          { label: "Funded", value: counts?.funded ?? "—", tone: "text-accent-2" },
          { label: "Evaluation", value: counts?.evaluation ?? "—", tone: "text-foreground" },
          { label: "At risk", value: counts?.atRisk ?? "—", tone: counts?.atRisk ? "text-danger" : "text-foreground" },
          { label: "Open risk events", value: counts?.openRiskEvents ?? "—", tone: counts?.openRiskEvents ? "text-accent" : "text-foreground" },
          { label: "Active subscriptions", value: counts?.activeSubscriptions ?? "—", tone: "text-accent-2" },
        ].map((item) => (
          <div
            key={item.label}
            className="flex min-w-0 items-center justify-between gap-3 border-b border-r border-line px-4 py-4"
          >
            <p className="min-w-0 text-[11px] font-semibold uppercase leading-5 tracking-[0.15em] text-muted">
              {item.label}
            </p>
            <p className={`shrink-0 text-base font-semibold ${item.tone}`}>{item.value}</p>
          </div>
        ))}
      </div>

      {notice ? (
        <div className={`mt-5 border px-4 py-3 text-sm font-medium ${
          notice.type === "success"
            ? "border-accent/30 bg-accent/10 text-accent"
            : "border-danger/30 bg-danger/10 text-danger"
        }`}>
          {notice.text}
        </div>
      ) : null}

      <Panel className="mt-5">
        <div className="grid gap-3 xl:grid-cols-[minmax(280px,1fr)_repeat(5,minmax(145px,auto))]">
          <label className="relative block">
            <span className="sr-only">Search traders</span>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Name, email, account or broker"
              className={`${controlClassName} pl-11`}
            />
          </label>
          <label>
            <span className="sr-only">Filter by segment</span>
            <select value={segment} onChange={(event) => {
              setSegment(event.target.value as SegmentFilter);
              setPage(1);
            }} className={selectClassName}>
              <option value="ALL">All segments</option>
              <option value="EVALUATION">Evaluation</option>
              <option value="FUNDED">Funded</option>
              <option value="AT_RISK">At risk</option>
              <option value="VIP">VIP</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Filter by access status</span>
            <select
              value={profileStatus}
              onChange={(event) => {
                setProfileStatus(event.target.value as StatusFilter);
                setPage(1);
              }}
              className={selectClassName}
            >
              <option value="ALL">All access states</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING">Pending</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Filter by partner</span>
            <select value={partnerId} onChange={(event) => {
              setPartnerId(event.target.value);
              setPage(1);
            }} className={selectClassName}>
              <option value="">All partners</option>
              {partners.map((partner) => (
                <option key={partner.userId} value={partner.userId}>{partner.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Sort traders</span>
            <select value={sort} onChange={(event) => {
              setSort(event.target.value as SortOption);
              setPage(1);
            }} className={selectClassName}>
              <option value="NEWEST">Newest first</option>
              <option value="OLDEST">Oldest first</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Rows per page</span>
            <select value={pageSize} onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }} className={selectClassName}>
              <option value={25}>25 rows</option>
              <option value={50}>50 rows</option>
              <option value={100}>100 rows</option>
            </select>
          </label>
        </div>
      </Panel>

      <div className="mt-5 grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1.65fr)_minmax(390px,0.75fr)]">
        <Panel className="min-w-0 p-0">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h2 className="font-semibold text-foreground">Trader directory</h2>
              <p className="mt-1 text-xs text-muted">
                {pagination ? `${pagination.total} matching traders` : "Loading directory…"}
              </p>
            </div>
            {directoryQuery.isFetching ? <span className="text-xs text-muted">Refreshing…</span> : null}
          </div>

          {directoryQuery.isLoading ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="h-14 animate-pulse border border-line bg-background" />
              ))}
            </div>
          ) : directoryQuery.isError ? (
            <div className="p-5 text-sm text-danger">
              {directoryQuery.error instanceof Error
                ? directoryQuery.error.message
                : "The trader directory could not be loaded."}
            </div>
          ) : traders.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={UserRoundSearch}
                title="No matching traders"
                description="Adjust the search or CRM filters to widen the directory."
              />
            </div>
          ) : (
            <>
            <div className="hidden invisible-scrollbar overflow-x-auto md:block">
              <table className="w-full min-w-[1180px] text-left text-sm">
                <thead className="bg-panel-strong text-[11px] uppercase tracking-[0.12em] text-muted">
                  <tr>
                    <th className="px-4 py-3">Trader</th>
                    <th className="px-4 py-3">Segment</th>
                    <th className="px-4 py-3">Accounts</th>
                    <th className="px-4 py-3">Equity</th>
                    <th className="px-4 py-3">Risk</th>
                    <th className="px-4 py-3">Evaluation</th>
                    <th className="px-4 py-3">Subscription</th>
                    <th className="px-4 py-3">Last account update</th>
                    <th className="w-12 px-4 py-3"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {traders.map((trader) => {
                    const active = trader.traderId === selectedTrader?.traderId;
                    return (
                      <tr
                        key={trader.traderId}
                        className={active ? "bg-accent/[0.07]" : "transition-colors hover:bg-white/[0.025]"}
                      >
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            className="max-w-[260px] text-left"
                            onClick={() => setSelectedId(trader.traderId)}
                          >
                            <span className="block truncate font-semibold text-foreground">{trader.name}</span>
                            <span className="mt-0.5 block truncate text-xs text-muted">{trader.email}</span>
                          </button>
                        </td>
                        <td className="px-4 py-3"><StatusPill tone={trader.segment === "AT_RISK" ? "danger" : "muted"}>{trader.segment}</StatusPill></td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted">{trader.connectedAccountCount} / {trader.accounts.length} connected</td>
                        <td className="whitespace-nowrap px-4 py-3 font-semibold text-foreground">{equityLabel(trader)}</td>
                        <td className="px-4 py-3">
                          <StatusPill tone={riskTone(trader.highestRiskSeverity)}>
                            {trader.openRiskEventCount ? `${trader.openRiskEventCount} open` : "Clear"}
                          </StatusPill>
                        </td>
                        <td className="px-4 py-3 text-muted">{trader.evaluationStatus ?? "—"}</td>
                        <td className="px-4 py-3">
                          {trader.subscription ? (
                            <div className="max-w-[180px]">
                              <p className="truncate text-foreground">{trader.subscription.name}</p>
                              <p className="mt-0.5 text-xs text-muted">{trader.subscription.status}</p>
                            </div>
                          ) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted">{dateLabel(trader.lastActivityAt, true)}</td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            aria-label={`Open ${trader.name}`}
                            onClick={() => setSelectedId(trader.traderId)}
                            className="grid h-8 w-8 place-items-center border border-line text-muted hover:border-accent/40 hover:text-foreground"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="divide-y divide-line md:hidden">
              {traders.map((trader) => {
                const active = trader.traderId === selectedTrader?.traderId;
                return (
                  <button
                    key={trader.traderId}
                    type="button"
                    onClick={() => setSelectedId(trader.traderId)}
                    className={`grid w-full gap-3 px-4 py-4 text-left ${
                      active ? "bg-accent/[0.07]" : "transition-colors hover:bg-white/[0.025]"
                    }`}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="block truncate font-semibold text-foreground">{trader.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted">{trader.email}</span>
                      </div>
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted" />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <StatusPill tone={trader.segment === "AT_RISK" ? "danger" : "muted"}>{trader.segment}</StatusPill>
                      <StatusPill tone={riskTone(trader.highestRiskSeverity)}>
                        {trader.openRiskEventCount ? `${trader.openRiskEventCount} risk` : "Clear"}
                      </StatusPill>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <dt className="text-muted">Accounts</dt>
                        <dd className="mt-1 font-semibold text-foreground">
                          {trader.connectedAccountCount} / {trader.accounts.length} connected
                        </dd>
                      </div>
                      <div className="text-right">
                        <dt className="text-muted">Equity</dt>
                        <dd className="mt-1 font-semibold text-foreground">{equityLabel(trader)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Evaluation</dt>
                        <dd className="mt-1 font-semibold text-foreground">{trader.evaluationStatus ?? "—"}</dd>
                      </div>
                      <div className="text-right">
                        <dt className="text-muted">Subscription</dt>
                        <dd className="mt-1 truncate font-semibold text-foreground">{trader.subscription?.name ?? "—"}</dd>
                      </div>
                    </dl>
                  </button>
                );
              })}
            </div>
            </>
          )}

          {pagination && pagination.totalPages > 1 ? (
            <div className="flex flex-col gap-3 border-t border-line px-4 py-3 text-xs text-muted sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <span>
                Showing {(pagination.page - 1) * pagination.pageSize + 1}–
                {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total}
              </span>
              <div className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 sm:flex sm:w-auto">
                <GhostButton type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                  Previous
                </GhostButton>
                <span className="px-2 font-semibold text-foreground">{pagination.page} / {pagination.totalPages}</span>
                <GhostButton
                  type="button"
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage((value) => Math.min(pagination.totalPages, value + 1))}
                >
                  Next
                </GhostButton>
              </div>
            </div>
          ) : null}
        </Panel>

        <Panel className="min-w-0 2xl:sticky 2xl:top-5 2xl:max-h-[calc(100vh-120px)] 2xl:overflow-y-auto">
          {selectedTrader ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Trader profile</p>
                  <h2 className="mt-2 truncate text-xl font-semibold text-foreground">{selectedTrader.name}</h2>
                  <p className="mt-1 truncate text-sm text-muted">{selectedTrader.email}</p>
                </div>
                <StatusPill tone={statusTone(selectedTrader.profileStatus)}>{selectedTrader.profileStatus}</StatusPill>
              </div>

              <dl className="mt-5 grid grid-cols-2 overflow-hidden border-l border-t border-line">
                <div className="border-b border-r border-line bg-background p-3">
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-muted">Segment</dt>
                  <dd className="mt-1 font-semibold text-foreground">{selectedTrader.segment}</dd>
                </div>
                <div className="border-b border-r border-line bg-background p-3">
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-muted">Partner</dt>
                  <dd className="mt-1 truncate font-semibold text-foreground">{selectedTrader.partner?.name ?? "Unassigned"}</dd>
                </div>
                <div className="border-b border-r border-line bg-background p-3">
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-muted">Evaluation</dt>
                  <dd className="mt-1 font-semibold text-foreground">{selectedTrader.evaluationStatus ?? "None"}</dd>
                </div>
                <div className="border-b border-r border-line bg-background p-3">
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-muted">Joined</dt>
                  <dd className="mt-1 font-semibold text-foreground">{dateLabel(selectedTrader.joinedAt)}</dd>
                </div>
              </dl>

              <div className="mt-5 border-t border-line pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-foreground">Trading accounts</h3>
                    <p className="mt-1 text-xs text-muted">Latest synchronized account state.</p>
                  </div>
                  <StatusPill tone="muted">{selectedTrader.accounts.length}</StatusPill>
                </div>
                {selectedTrader.accounts.length ? (
                  <div className="mt-3 divide-y divide-line border-y border-line">
                    {selectedTrader.accounts.map((account) => (
                      <div key={account.id} className="py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">{account.name}</p>
                            <p className="mt-0.5 truncate text-xs text-muted">
                              {account.brokerName}
                              {account.brokerAccountId ? ` · …${account.brokerAccountId.slice(-4)}` : ""}
                            </p>
                          </div>
                          <StatusPill tone={account.status === "CONNECTED" ? "lime" : "muted"}>{account.status}</StatusPill>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted">
                          <span>{account.equity ? formatMoney(account.equity) : "Equity not synced"}</span>
                          <span>{dateLabel(account.lastSyncedAt, true)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm leading-6 text-muted">No trading accounts are connected to this trader.</p>
                )}
              </div>

              <div className="mt-5 border-t border-line pt-4">
                <h3 className="font-semibold text-foreground">Billing</h3>
                {selectedTrader.subscription ? (
                  <div className="mt-3 border border-line bg-background p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-semibold text-foreground">{selectedTrader.subscription.name}</p>
                      <StatusPill tone={selectedTrader.subscription.status === "ACTIVE" ? "lime" : "muted"}>
                        {selectedTrader.subscription.status}
                      </StatusPill>
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      Period ends: {dateLabel(selectedTrader.subscription.currentPeriodEnd)}
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted">No subscription record exists for this trader.</p>
                )}
              </div>

              <div className="mt-5 border-t border-line pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-foreground">CRM notes</h3>
                    <p className="mt-1 text-xs text-muted">{selectedTrader.noteCount} saved notes</p>
                  </div>
                  <PrimaryButton type="button" onClick={() => setNoteOpen(true)}>
                    <MessageSquarePlus className="mr-2 inline-block h-4 w-4" />
                    Add note
                  </PrimaryButton>
                </div>
                {notesQuery.isLoading ? (
                  <p className="mt-3 text-sm text-muted">Loading notes…</p>
                ) : notes.length ? (
                  <div className="mt-3 divide-y divide-line border-y border-line">
                    {notes.slice(0, 5).map((note) => (
                      <article key={note.id} className="py-3">
                        <p className="text-sm leading-6 text-foreground">{note.note}</p>
                        <p className="mt-1 text-xs text-muted">{note.authorName} · {dateLabel(note.createdAt, true)}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted">No CRM notes have been recorded.</p>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              icon={UserRoundSearch}
              title="Select a trader"
              description="Choose a directory row to inspect account, risk, billing, and CRM information."
            />
          )}
        </Panel>
      </div>

      <Dialog.Root open={noteOpen} onOpenChange={setNoteOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/80" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 border border-line bg-panel p-5 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
            <Dialog.Title className="text-lg font-semibold text-foreground">Add CRM note</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm leading-6 text-muted">
              Save a real communication note for {selectedTrader?.name ?? "the selected trader"}.
            </Dialog.Description>
            <form className="mt-5" onSubmit={submitNote}>
              <label className="grid gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Note</span>
                <textarea
                  required
                  value={noteText}
                  onChange={(event) => setNoteText(event.target.value)}
                  placeholder="Add follow-up details, account context, or review notes."
                  className={textareaClassName}
                />
              </label>
              <div className="mt-5 flex justify-end gap-3 border-t border-line pt-4">
                <Dialog.Close asChild>
                  <GhostButton type="button">Cancel</GhostButton>
                </Dialog.Close>
                <PrimaryButton type="submit" disabled={noteMutation.isPending || !noteText.trim()}>
                  {noteMutation.isPending ? "Saving…" : "Save note"}
                </PrimaryButton>
              </div>
            </form>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close note dialog"
                className="absolute right-4 top-4 grid h-9 w-9 place-items-center border border-line bg-background text-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </WorkspacePage>
  );
}
