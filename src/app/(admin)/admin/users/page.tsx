"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Search, ShieldCheck, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
  controlClassName,
  selectClassName,
} from "@/components/app/WorkspaceUI";
import { SelectField } from "@/components/app/FormFields";
import type {
  AdminUserDirectoryDto,
  AdminUserDirectoryItemDto,
  UserRole,
} from "@/lib/domain/types";

type UserStatus = "ACTIVE" | "SUSPENDED" | "PENDING";
type RoleFilter = "ALL" | UserRole;
type StatusFilter = "ALL" | UserStatus;
type SortOption = "NEWEST" | "OLDEST" | "NAME";
type PartnerOption = {
  userId: string;
  name: string;
  email: string;
  partnerStatus: string;
  referralCode: string;
};

const STATUS_TONE: Record<UserStatus, "lime" | "accent" | "danger"> = {
  ACTIVE: "lime",
  PENDING: "accent",
  SUSPENDED: "danger",
};

function roleTone(role: UserRole): "lime" | "accent" | "muted" {
  if (role === "TRADER") return "lime";
  if (role === "SUPER_ADMIN") return "accent";
  return "muted";
}

function roleLabel(role: UserRole): string {
  return role === "SUPER_ADMIN" ? "Super admin" : role.charAt(0) + role.slice(1).toLowerCase();
}

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

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<RoleFilter>("ALL");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [sort, setSort] = useState<SortOption>("NEWEST");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const debouncedSearch = useDebouncedValue(search);

  const directoryQuery = useQuery<AdminUserDirectoryDto>({
    queryKey: ["admin-users", page, pageSize, debouncedSearch, role, status, sort],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        search: debouncedSearch,
        role,
        status,
        sort,
      });
      return readApi<AdminUserDirectoryDto>(await fetch(`/api/admin/users?${params}`));
    },
  });

  const partnersQuery = useQuery<PartnerOption[]>({
    queryKey: ["admin-partner-options"],
    queryFn: async () => readApi<PartnerOption[]>(await fetch("/api/admin/partners")),
  });

  const directory = directoryQuery.data;
  const users = directory?.items ?? [];
  const partnerById = useMemo(
    () => new Map((partnersQuery.data ?? []).map((partner) => [partner.userId, partner])),
    [partnersQuery.data],
  );
  const partners = partnersQuery.data ?? [];
  const selectedUser =
    users.find((user) => user.id === selectedId) ??
    users[0] ??
    null;

  const invalidateDirectory = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-users"] });

  const statusMutation = useMutation({
    mutationFn: async ({ userId, nextStatus }: { userId: string; nextStatus: UserStatus }) =>
      readApi(await fetch(`/api/admin/users/${userId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      })),
    onSuccess: (_data, variables) => {
      void invalidateDirectory();
      setNotice({ type: "success", text: `Access status changed to ${variables.nextStatus.toLowerCase()}.` });
    },
    onError: (error: Error) => setNotice({ type: "error", text: error.message }),
  });

  const roleMutation = useMutation({
    mutationFn: async ({ userId, nextRole }: { userId: string; nextRole: "TRADER" | "PARTNER" | "ADMIN" }) =>
      readApi(await fetch(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      })),
    onSuccess: (_data, variables) => {
      void invalidateDirectory();
      void queryClient.invalidateQueries({ queryKey: ["admin-partner-options"] });
      setNotice({ type: "success", text: `Role changed to ${roleLabel(variables.nextRole)}.` });
    },
    onError: (error: Error) => setNotice({ type: "error", text: error.message }),
  });

  const partnerMutation = useMutation({
    mutationFn: async ({ userId, partnerId }: { userId: string; partnerId: string | null }) =>
      readApi(await fetch(`/api/admin/traders/${userId}/partner`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerId }),
      })),
    onSuccess: () => {
      void invalidateDirectory();
      setNotice({ type: "success", text: "Partner assignment updated." });
    },
    onError: (error: Error) => setNotice({ type: "error", text: error.message }),
  });

  const partnerReviewMutation = useMutation({
    mutationFn: async ({ partnerId, action }: { partnerId: string; action: "approve" | "reject" }) =>
      readApi(await fetch(`/api/admin/partners/${partnerId}/${action}`, { method: "POST" })),
    onSuccess: (_data, variables) => {
      void invalidateDirectory();
      void queryClient.invalidateQueries({ queryKey: ["admin-partner-options"] });
      setNotice({
        type: "success",
        text: variables.action === "approve" ? "Partner application approved." : "Partner application rejected.",
      });
    },
    onError: (error: Error) => setNotice({ type: "error", text: error.message }),
  });

  const requestStatusChange = (user: AdminUserDirectoryItemDto, nextStatus: UserStatus) => {
    if (
      nextStatus === "SUSPENDED" &&
      !window.confirm(`Suspend ${user.name}? They will lose platform access until reactivated.`)
    ) return;
    setNotice(null);
    statusMutation.mutate({ userId: user.id, nextStatus });
  };

  const requestRoleChange = (
    user: AdminUserDirectoryItemDto,
    nextRole: "TRADER" | "PARTNER" | "ADMIN",
  ) => {
    if (!window.confirm(`Change ${user.name}'s role to ${roleLabel(nextRole)}?`)) return;
    setNotice(null);
    roleMutation.mutate({ userId: user.id, nextRole });
  };

  const pendingPartners = partners.filter((partner) => partner.partnerStatus === "PENDING_REVIEW");
  const pagination = directory?.pagination;
  const counts = directory?.counts;

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Users & access"
      description="Search every platform identity and control roles, access status, and partner assignment."
    >
      <div className="grid grid-cols-2 border-l border-t border-line bg-panel md:grid-cols-3 2xl:grid-cols-6">
        {[
          { label: "Total users", value: counts?.total ?? "—", tone: "text-foreground" },
          { label: "Traders", value: counts?.traders ?? "—", tone: "text-accent-2" },
          { label: "Admins", value: counts?.admins ?? "—", tone: "text-accent" },
          { label: "Partners", value: counts?.partners ?? "—", tone: "text-foreground" },
          { label: "Pending", value: counts?.pending ?? "—", tone: counts?.pending ? "text-accent" : "text-foreground" },
          { label: "Suspended", value: counts?.suspended ?? "—", tone: counts?.suspended ? "text-danger" : "text-foreground" },
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

      {pendingPartners.length > 0 ? (
        <Panel className="mt-5 border-accent/30">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Action required</p>
              <h2 className="mt-2 text-lg font-semibold text-foreground">Partner applications</h2>
            </div>
            <StatusPill tone="accent">{pendingPartners.length} pending</StatusPill>
          </div>
          <div className="mt-4 divide-y divide-line border-y border-line">
            {pendingPartners.map((partner) => (
              <div key={partner.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{partner.name}</p>
                  <p className="truncate text-xs text-muted">{partner.email}</p>
                </div>
                <div className="flex gap-2">
                  <PrimaryButton
                    type="button"
                    disabled={partnerReviewMutation.isPending}
                    onClick={() => partnerReviewMutation.mutate({ partnerId: partner.userId, action: "approve" })}
                  >
                    Approve
                  </PrimaryButton>
                  <GhostButton
                    type="button"
                    disabled={partnerReviewMutation.isPending}
                    onClick={() => partnerReviewMutation.mutate({ partnerId: partner.userId, action: "reject" })}
                  >
                    Reject
                  </GhostButton>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

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
        <div className="grid gap-3 xl:grid-cols-[minmax(260px,1fr)_repeat(4,minmax(150px,auto))]">
          <label className="relative block">
            <span className="sr-only">Search users</span>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search name or email"
              className={`${controlClassName} pl-11`}
            />
          </label>
          <label>
            <span className="sr-only">Filter by role</span>
            <select value={role} onChange={(event) => {
              setRole(event.target.value as RoleFilter);
              setPage(1);
            }} className={selectClassName}>
              <option value="ALL">All roles</option>
              <option value="TRADER">Traders</option>
              <option value="PARTNER">Partners</option>
              <option value="ADMIN">Admins</option>
              <option value="SUPER_ADMIN">Super admins</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Filter by status</span>
            <select value={status} onChange={(event) => {
              setStatus(event.target.value as StatusFilter);
              setPage(1);
            }} className={selectClassName}>
              <option value="ALL">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="PENDING">Pending</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Sort users</span>
            <select value={sort} onChange={(event) => {
              setSort(event.target.value as SortOption);
              setPage(1);
            }} className={selectClassName}>
              <option value="NEWEST">Newest first</option>
              <option value="OLDEST">Oldest first</option>
              <option value="NAME">Name A–Z</option>
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

      <div className="mt-5 grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,0.75fr)]">
        <Panel className="min-w-0 p-0">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h2 className="font-semibold text-foreground">User directory</h2>
              <p className="mt-1 text-xs text-muted">
                {pagination ? `${pagination.total} matching users` : "Loading directory…"}
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
              {directoryQuery.error instanceof Error ? directoryQuery.error.message : "Users could not be loaded."}
            </div>
          ) : users.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={Users}
                title="No matching users"
                description="Adjust the search or access filters to widen the directory."
              />
            </div>
          ) : (
            <div className="invisible-scrollbar overflow-x-auto">
              <table className="w-full min-w-[850px] text-left text-sm">
                <thead className="bg-panel-strong text-[11px] uppercase tracking-[0.12em] text-muted">
                  <tr>
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Partner</th>
                    <th className="px-4 py-3">Joined</th>
                    <th className="w-12 px-4 py-3"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {users.map((user) => {
                    const active = user.id === selectedUser?.id;
                    const partner = user.partnerId ? partnerById.get(user.partnerId) : null;
                    return (
                      <tr
                        key={user.id}
                        className={active ? "bg-accent/[0.07]" : "transition-colors hover:bg-white/[0.025]"}
                      >
                        <td className="px-4 py-3">
                          <button type="button" className="max-w-[300px] text-left" onClick={() => setSelectedId(user.id)}>
                            <span className="block truncate font-semibold text-foreground">{user.name}</span>
                            <span className="mt-0.5 block truncate text-xs text-muted">{user.email}</span>
                          </button>
                        </td>
                        <td className="px-4 py-3"><StatusPill tone={roleTone(user.role)}>{roleLabel(user.role)}</StatusPill></td>
                        <td className="px-4 py-3"><StatusPill tone={STATUS_TONE[user.status]}>{user.status}</StatusPill></td>
                        <td className="px-4 py-3 text-muted">{partner?.name ?? "—"}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted">{new Date(user.joinedAt).toLocaleDateString()}</td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            aria-label={`Open ${user.name}`}
                            onClick={() => setSelectedId(user.id)}
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
          )}

          {pagination && pagination.totalPages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-xs text-muted">
              <span>
                Showing {(pagination.page - 1) * pagination.pageSize + 1}–
                {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total}
              </span>
              <div className="flex items-center gap-2">
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

        <Panel className="min-w-0 2xl:sticky 2xl:top-5 2xl:self-start">
          {selectedUser ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Access profile</p>
                  <h2 className="mt-2 truncate text-xl font-semibold text-foreground">{selectedUser.name}</h2>
                  <p className="mt-1 truncate text-sm text-muted">{selectedUser.email}</p>
                </div>
                <ShieldCheck className="h-5 w-5 shrink-0 text-accent" />
              </div>

              <dl className="mt-5 grid grid-cols-2 overflow-hidden border-l border-t border-line">
                <div className="border-b border-r border-line bg-background p-3">
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-muted">Role</dt>
                  <dd className="mt-1 font-semibold text-foreground">{roleLabel(selectedUser.role)}</dd>
                </div>
                <div className="border-b border-r border-line bg-background p-3">
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-muted">Status</dt>
                  <dd className="mt-1 font-semibold text-foreground">{selectedUser.status}</dd>
                </div>
                <div className="col-span-2 border-b border-r border-line bg-background p-3">
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-muted">Joined</dt>
                  <dd className="mt-1 font-semibold text-foreground">{new Date(selectedUser.joinedAt).toLocaleString()}</dd>
                </div>
              </dl>

              {selectedUser.role === "SUPER_ADMIN" ? (
                <p className="mt-5 border border-accent/25 bg-accent/10 p-3 text-sm leading-6 text-muted">
                  Super admin access is protected and cannot be changed from this screen.
                </p>
              ) : (
                <>
                  <div className="mt-5 border-t border-line pt-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Access status</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selectedUser.status !== "ACTIVE" ? (
                        <PrimaryButton
                          type="button"
                          disabled={statusMutation.isPending}
                          onClick={() => requestStatusChange(selectedUser, "ACTIVE")}
                        >
                          Activate
                        </PrimaryButton>
                      ) : null}
                      {selectedUser.status !== "PENDING" ? (
                        <GhostButton
                          type="button"
                          disabled={statusMutation.isPending}
                          onClick={() => requestStatusChange(selectedUser, "PENDING")}
                        >
                          Set pending
                        </GhostButton>
                      ) : null}
                      {selectedUser.status !== "SUSPENDED" ? (
                        <GhostButton
                          type="button"
                          disabled={statusMutation.isPending}
                          onClick={() => requestStatusChange(selectedUser, "SUSPENDED")}
                        >
                          Suspend
                        </GhostButton>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-5 border-t border-line pt-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Role</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(["TRADER", "PARTNER", "ADMIN"] as const).map((nextRole) => (
                        <GhostButton
                          key={nextRole}
                          type="button"
                          disabled={roleMutation.isPending || selectedUser.role === nextRole}
                          onClick={() => requestRoleChange(selectedUser, nextRole)}
                        >
                          {selectedUser.role === nextRole ? `${roleLabel(nextRole)} ✓` : `Make ${roleLabel(nextRole)}`}
                        </GhostButton>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {selectedUser.role === "TRADER" ? (
                <div className="mt-5 border-t border-line pt-4">
                  <SelectField
                    label="Assigned partner"
                    value={selectedUser.partnerId ?? ""}
                    disabled={partnerMutation.isPending || partnersQuery.isLoading}
                    onChange={(event) => partnerMutation.mutate({
                      userId: selectedUser.id,
                      partnerId: event.target.value || null,
                    })}
                  >
                    <option value="">Unassigned</option>
                    {partners
                      .filter((partner) => partner.partnerStatus === "ACTIVE")
                      .map((partner) => (
                        <option key={partner.userId} value={partner.userId}>{partner.name}</option>
                      ))}
                  </SelectField>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState
              icon={Users}
              title="Select a user"
              description="Choose a directory row to review and manage access."
            />
          )}
        </Panel>
      </div>
    </WorkspacePage>
  );
}
