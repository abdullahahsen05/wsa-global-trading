"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Import, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DirectorySearchOverlay } from "@/components/app/DirectorySearchOverlay";
import {
  EmptyState,
  GhostButton,
  FilterChipRow,
  InlineStatusStrip,
  Panel,
  PageActionGroup,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SelectField } from "@/components/app/FormFields";

type PartnerRel = { partner_id: string | null };

type ApiUserRecord = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  status: string;
  created_at: string;
  trader_profiles?: PartnerRel | PartnerRel[] | null;
};

type UserRole = "TRADER" | "ADMIN" | "PARTNER";

type UserRecord = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: "ACTIVE" | "SUSPENDED" | "PENDING";
  segment: string;
  partnerId: string | null;
  lastActiveAt: string;
};

function extractPartnerId(tp: ApiUserRecord["trader_profiles"]): string | null {
  if (!tp) return null;
  if (Array.isArray(tp)) return tp[0]?.partner_id ?? null;
  return tp.partner_id ?? null;
}

function toUserRecord(raw: ApiUserRecord): UserRecord {
  const role: UserRole = raw.role === "ADMIN" ? "ADMIN" : raw.role === "PARTNER" ? "PARTNER" : "TRADER";
  return {
    id: raw.id,
    name: raw.full_name ?? raw.email,
    email: raw.email,
    role,
    // Preserve all three statuses — do not collapse PENDING → ACTIVE
    status: (["ACTIVE", "SUSPENDED", "PENDING"] as const).includes(raw.status as "ACTIVE" | "SUSPENDED" | "PENDING")
      ? (raw.status as "ACTIVE" | "SUSPENDED" | "PENDING")
      : "ACTIVE",
    segment: role === "ADMIN" ? "OPERATIONS" : role === "PARTNER" ? "PARTNER" : "EVALUATION",
    partnerId: extractPartnerId(raw.trader_profiles),
    lastActiveAt: raw.created_at,
  };
}

const STATUS_TONE: Record<string, "lime" | "accent" | "danger" | "muted"> = {
  ACTIVE: "lime",
  PENDING: "accent",
  SUSPENDED: "danger",
};

const ROLE_TONE: Record<UserRole, "lime" | "accent" | "danger" | "muted"> = {
  ADMIN: "accent",
  PARTNER: "accent",
  TRADER: "lime",
};

type PartnerOption = { userId: string; name: string; email: string; partnerStatus: string; referralCode: string };

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const [searchOpen, setSearchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [profileFilter, setProfileFilter] = useState<"ALL" | "TRADER" | "ADMIN" | "PARTNER" | "SUSPENDED" | "PENDING">("ALL");
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 20;

  const { data: rawUsers = [], isLoading, isError } = useQuery<ApiUserRecord[]>({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load users");
      return json.data;
    },
  });

  const users: UserRecord[] = useMemo(() => rawUsers.map(toUserRecord), [rawUsers]);

  const filteredUsers = users.filter((user) => {
    if (profileFilter === "ALL") return true;
    if (profileFilter === "SUSPENDED") return user.status === "SUSPENDED";
    if (profileFilter === "PENDING") return user.status === "PENDING";
    return user.role === profileFilter;
  });

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const currentPageSafe = Math.min(currentPage, totalPages);
  const pagedUsers = filteredUsers.slice((currentPageSafe - 1) * PAGE_SIZE, currentPageSafe * PAGE_SIZE);

  const effectiveSelectedId = selectedId || pagedUsers[0]?.id || "";
  const selectedUser =
    pagedUsers.find((u) => u.id === effectiveSelectedId) ??
    pagedUsers[0];

  // ── Real status change mutation ─────────────────────────────────────────────
  const statusMutation = useMutation({
    mutationFn: async ({
      userId,
      status,
    }: {
      userId: string;
      status: "ACTIVE" | "SUSPENDED" | "PENDING";
    }) => {
      const res = await fetch(`/api/admin/users/${userId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to update status");
      return json.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setNotice({
        type: "success",
        text: `User status updated to ${variables.status}.`,
      });
    },
    onError: (err: Error) => {
      setNotice({ type: "error", text: err.message });
    },
  });

  const handleStatusChange = (
    userId: string,
    newStatus: "ACTIVE" | "SUSPENDED" | "PENDING"
  ) => {
    setNotice(null);
    statusMutation.mutate({ userId, status: newStatus });
  };

  // ── Partner options for assignment dropdown ─────────────────────────────────
  const { data: partners = [], refetch: refetchPartners } = useQuery<PartnerOption[]>({
    queryKey: ["admin-partner-options"],
    queryFn: async () => {
      const res = await fetch("/api/admin/partners");
      const json = await res.json();
      if (!json.ok) return [];
      return (json.data as Array<{ userId: string; name: string; email: string; partnerStatus: string; referralCode: string }>).map((p) => ({
        userId: p.userId,
        name: p.name,
        email: p.email,
        partnerStatus: p.partnerStatus,
        referralCode: p.referralCode,
      }));
    },
  });

  const pendingPartners = partners.filter((p) => p.partnerStatus === "PENDING_REVIEW");

  // ── Partner application approve / reject ────────────────────────────────────
  const partnerAppMutation = useMutation({
    mutationFn: async ({ partnerId, action }: { partnerId: string; action: "approve" | "reject" }) => {
      const res = await fetch(`/api/admin/partners/${partnerId}/${action}`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? `Failed to ${action} partner`);
      return json.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      refetchPartners();
      setNotice({
        type: "success",
        text: variables.action === "approve"
          ? "Partner approved — their portal is now active."
          : "Partner application rejected.",
      });
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  // ── Role change ─────────────────────────────────────────────────────────────
  const roleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: UserRole }) => {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to update role");
      return json.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-partner-options"] });
      setNotice({ type: "success", text: `Role updated to ${variables.role}.` });
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  // ── Partner assignment (trader → partner) ───────────────────────────────────
  const partnerMutation = useMutation({
    mutationFn: async ({ traderId, partnerId }: { traderId: string; partnerId: string | null }) => {
      const res = await fetch(`/api/admin/traders/${traderId}/partner`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerId }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to assign partner");
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setNotice({ type: "success", text: "Partner assignment updated." });
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  const pendingCount = users.filter((u) => u.status === "PENDING").length;
  const suspendedCount = users.filter((u) => u.status === "SUSPENDED").length;
  const partnerCount = users.filter((u) => u.role === "PARTNER").length;

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="User management"
      description="Manage trader and admin accounts, statuses, and access levels."
      action={
        <PageActionGroup>
          <GhostButton type="button" onClick={() => setSearchOpen(true)}>
            <Search className="mr-2 inline-block h-4 w-4" />
            Search
          </GhostButton>

          {/* Import users dialog */}
          <Dialog.Root open={importOpen} onOpenChange={setImportOpen}>
            <Dialog.Trigger asChild>
              <GhostButton type="button">
                <Import className="mr-2 inline-block h-4 w-4" />
                Import
              </GhostButton>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
              <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[7px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
                <Dialog.Title className="text-xl font-semibold text-foreground">
                  Bulk user import
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                  CSV bulk import is not yet available. This feature requires additional backend configuration.
                </Dialog.Description>
                <div className="mt-5 rounded-[4px] border border-line bg-background px-4 py-4 text-sm text-muted">
                  To onboard multiple users, have them register individually. Use the status management below to activate accounts.
                </div>
                <div className="mt-5 flex justify-end border-t border-line pt-4">
                  <Dialog.Close asChild>
                    <GhostButton type="button">Close</GhostButton>
                  </Dialog.Close>
                </div>
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

          {/* Add user dialog */}
          <Dialog.Root open={addOpen} onOpenChange={setAddOpen}>
            <Dialog.Trigger asChild>
              <PrimaryButton type="button">
                <Plus className="mr-2 inline-block h-4 w-4" />
                Add user
              </PrimaryButton>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
              <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-[7px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
                <Dialog.Title className="text-xl font-semibold text-foreground">
                  User invite
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                  Inviting users directly from the platform requires email provider configuration. This feature will be available in a future release.
                </Dialog.Description>
                <div className="mt-5 rounded-[4px] border border-line bg-background px-4 py-4 text-sm text-muted">
                  To add a user, have them register at the sign-up page. An admin can then update their status and role from this page.
                </div>
                <div className="mt-5 flex justify-end border-t border-line pt-4">
                  <Dialog.Close asChild>
                    <GhostButton type="button">Close</GhostButton>
                  </Dialog.Close>
                </div>
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
          { label: "Total users", value: isLoading ? "…" : users.length },
          { label: "Admins", value: users.filter((u) => u.role === "ADMIN").length, tone: "accent" },
          { label: "Traders", value: users.filter((u) => u.role === "TRADER").length, tone: "lime" },
          { label: "Partners", value: partnerCount, tone: "accent" },
          { label: "Pending", value: pendingCount, tone: pendingCount > 0 ? "accent" : undefined },
          { label: "Suspended", value: suspendedCount, tone: suspendedCount > 0 ? "danger" : undefined },
        ]}
      />

      {/* Pending partner applications */}
      {pendingPartners.length > 0 ? (
        <div className="mt-5 rounded-[4px] border border-accent/20 bg-accent/5 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Partner applications pending review ({pendingPartners.length})
          </p>
          <div className="space-y-2">
            {pendingPartners.map((p) => (
              <div
                key={p.userId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-line bg-panel px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{p.name}</p>
                  <p className="truncate text-xs text-muted">{p.email}</p>
                  {p.referralCode ? (
                    <p className="mt-0.5 font-mono text-xs text-muted">
                      Referral code: {p.referralCode}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill tone="accent">Pending review</StatusPill>
                  <PrimaryButton
                    type="button"
                    disabled={partnerAppMutation.isPending}
                    onClick={() => {
                      setNotice(null);
                      partnerAppMutation.mutate({ partnerId: p.userId, action: "approve" });
                    }}
                  >
                    Approve
                  </PrimaryButton>
                  <GhostButton
                    type="button"
                    disabled={partnerAppMutation.isPending}
                    onClick={() => {
                      setNotice(null);
                      partnerAppMutation.mutate({ partnerId: p.userId, action: "reject" });
                    }}
                  >
                    Reject
                  </GhostButton>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Filter chips */}
      <div className="mt-5 invisible-scrollbar overflow-x-auto border-b border-line pb-3">
        <FilterChipRow
          chips={[
            {
              label: `All (${users.length})`,
              active: profileFilter === "ALL",
              onClick: () => { setProfileFilter("ALL"); setCurrentPage(1); },
            },
            {
              label: `Traders (${users.filter((u) => u.role === "TRADER").length})`,
              active: profileFilter === "TRADER",
              onClick: () => { setProfileFilter("TRADER"); setCurrentPage(1); },
            },
            {
              label: `Admins (${users.filter((u) => u.role === "ADMIN").length})`,
              active: profileFilter === "ADMIN",
              onClick: () => { setProfileFilter("ADMIN"); setCurrentPage(1); },
            },
            {
              label: `Partners (${partnerCount})`,
              active: profileFilter === "PARTNER",
              onClick: () => { setProfileFilter("PARTNER"); setCurrentPage(1); },
            },
            {
              label: `Pending (${pendingCount})`,
              active: profileFilter === "PENDING",
              onClick: () => { setProfileFilter("PENDING"); setCurrentPage(1); },
            },
            {
              label: `Suspended (${suspendedCount})`,
              active: profileFilter === "SUSPENDED",
              onClick: () => { setProfileFilter("SUSPENDED"); setCurrentPage(1); },
            },
          ]}
        />
      </div>

      {/* Notice banner */}
      {notice ? (
        <div
          className={`mt-5 rounded-[4px] border px-4 py-3 text-sm font-medium ${
            notice.type === "success"
              ? "border-accent/20 bg-accent/10 text-accent"
              : "border-danger/20 bg-danger/10 text-danger"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {/* Loading skeleton */}
      {isLoading ? (
        <div className="mt-5 space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 rounded-[4px] border border-line bg-panel animate-pulse" />
          ))}
        </div>
      ) : isError ? (
        <div className="mt-5 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
          Failed to load users. Please refresh the page.
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title="No users found"
            description={profileFilter !== "ALL" ? "No users match the current filter." : "No users in the system yet."}
          />
        </div>
      ) : selectedUser ? (
        <div className="mt-5">
          <Panel className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
                  Selected profile
                </p>
                <h2 className="mt-2 text-lg font-semibold text-foreground">
                  {selectedUser.name}
                </h2>
                <p className="mt-1 text-sm text-muted">{selectedUser.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill tone={STATUS_TONE[selectedUser.status] ?? "muted"}>
                  {selectedUser.status}
                </StatusPill>
                <StatusPill tone={ROLE_TONE[selectedUser.role]}>
                  {selectedUser.role}
                </StatusPill>
              </div>
            </div>

            <div className="mt-4 grid gap-0 overflow-hidden rounded-[4px] border-l border-t border-line sm:grid-cols-2 xl:grid-cols-4">
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  Status
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {selectedUser.status}
                </p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  Segment
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {selectedUser.segment}
                </p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  Joined
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {new Date(selectedUser.lastActiveAt).toLocaleDateString()}
                </p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  Role
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {selectedUser.role}
                </p>
              </div>
            </div>

            {/* ── Real status action buttons ─────────────────────────────── */}
            <div className="mt-5 flex flex-wrap gap-3 border-t border-line pt-4">
              {selectedUser.status !== "ACTIVE" && (
                <PrimaryButton
                  type="button"
                  disabled={statusMutation.isPending}
                  onClick={() => handleStatusChange(selectedUser.id, "ACTIVE")}
                >
                  {statusMutation.isPending ? "Updating…" : "Activate"}
                </PrimaryButton>
              )}
              {selectedUser.status !== "PENDING" && (
                <GhostButton
                  type="button"
                  disabled={statusMutation.isPending}
                  onClick={() => handleStatusChange(selectedUser.id, "PENDING")}
                >
                  Set pending
                </GhostButton>
              )}
              {selectedUser.status !== "SUSPENDED" && (
                <GhostButton
                  type="button"
                  disabled={statusMutation.isPending}
                  onClick={() => handleStatusChange(selectedUser.id, "SUSPENDED")}
                >
                  Suspend
                </GhostButton>
              )}
              <p className="self-center text-xs text-muted">
                All status changes are logged to the audit trail.
              </p>
            </div>

            {/* ── Role management ───────────────────────────────────────── */}
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                Role
              </span>
              {(["TRADER", "PARTNER", "ADMIN"] as UserRole[]).map((r) => (
                <GhostButton
                  key={r}
                  type="button"
                  disabled={roleMutation.isPending || selectedUser.role === r}
                  onClick={() => {
                    setNotice(null);
                    roleMutation.mutate({ userId: selectedUser.id, role: r });
                  }}
                >
                  {selectedUser.role === r ? `${r} ✓` : `Make ${r}`}
                </GhostButton>
              ))}
            </div>

            {/* ── Partner assignment (traders only) ─────────────────────── */}
            {selectedUser.role === "TRADER" ? (
              <div className="mt-4 grid gap-2 border-t border-line pt-4 sm:max-w-sm">
                <SelectField
                  label="Assigned partner"
                  value={selectedUser.partnerId ?? ""}
                  disabled={partnerMutation.isPending}
                  onChange={(e) => {
                    setNotice(null);
                    partnerMutation.mutate({
                      traderId: selectedUser.id,
                      partnerId: e.target.value || null,
                    });
                  }}
                >
                  <option value="">Unassigned</option>
                  {partners.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.name}
                    </option>
                  ))}
                </SelectField>
              </div>
            ) : null}
          </Panel>
        </div>
      ) : null}

      {/* Pagination */}
      {filteredUsers.length > PAGE_SIZE && (
        <div className="mt-5 flex items-center justify-between rounded-[4px] border border-line bg-panel px-4 py-3">
          <p className="text-sm text-muted">
            Showing {(currentPageSafe - 1) * PAGE_SIZE + 1}–{Math.min(currentPageSafe * PAGE_SIZE, filteredUsers.length)} of {filteredUsers.length} users
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={currentPageSafe <= 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              className="rounded-[4px] border border-line bg-panel px-4 py-1.5 text-sm font-semibold text-muted disabled:opacity-40 hover:text-foreground"
            >
              Previous
            </button>
            <span className="text-sm font-semibold text-foreground">
              {currentPageSafe} / {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPageSafe >= totalPages}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              className="rounded-[4px] border border-line bg-panel px-4 py-1.5 text-sm font-semibold text-muted disabled:opacity-40 hover:text-foreground"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Directory search overlay */}
      <DirectorySearchOverlay<UserRecord>
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Find users"
        description="Search by name, email, or segment."
        items={users}
        selectedId={effectiveSelectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setSearchOpen(false);
        }}
        searchLabel="Search users"
        searchPlaceholder="Name, email, or segment"
        filters={[
          {
            key: "role",
            label: "Role",
            options: [
              { value: "ALL", label: "All roles" },
              { value: "TRADER", label: "Trader" },
              { value: "PARTNER", label: "Partner" },
              { value: "ADMIN", label: "Admin" },
            ],
          },
          {
            key: "status",
            label: "Status",
            options: [
              { value: "ALL", label: "All statuses" },
              { value: "ACTIVE", label: "Active" },
              { value: "PENDING", label: "Pending" },
              { value: "SUSPENDED", label: "Suspended" },
            ],
          },
        ]}
        emptyTitle="No users match"
        emptyDescription="Adjust the search term or filter values."
        getId={(user) => user.id}
        matches={(user, state) => {
          const search = state.query.trim().toLowerCase();
          const matchesQuery =
            search.length === 0 ||
            user.name.toLowerCase().includes(search) ||
            user.email.toLowerCase().includes(search) ||
            user.segment.toLowerCase().includes(search);
          const matchesRole =
            state.filters.role === "ALL" || user.role === state.filters.role;
          const matchesStatus =
            state.filters.status === "ALL" || user.status === state.filters.status;
          return matchesQuery && matchesRole && matchesStatus;
        }}
        renderRow={(user) => (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{user.name}</p>
                <p className="mt-1 truncate text-xs text-muted">{user.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <StatusPill tone={STATUS_TONE[user.status] ?? "muted"}>{user.status}</StatusPill>
                <StatusPill tone={ROLE_TONE[user.role]}>{user.role}</StatusPill>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {user.segment}
              </span>
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {new Date(user.lastActiveAt).toLocaleDateString()}
              </span>
            </div>
          </>
        )}
        renderPreview={(user) => (
          <Panel className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
                  Profile preview
                </p>
                <h3 className="mt-2 text-lg font-semibold text-foreground">{user.name}</h3>
                <p className="mt-1 text-sm text-muted">{user.email}</p>
              </div>
              <div className="flex items-center gap-1">
                <StatusPill tone={STATUS_TONE[user.status] ?? "muted"}>{user.status}</StatusPill>
                <StatusPill tone={ROLE_TONE[user.role]}>{user.role}</StatusPill>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Segment</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{user.segment}</p>
              </div>
              <div className="border-b border-r border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Joined</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {new Date(user.lastActiveAt).toLocaleString()}
                </p>
              </div>
            </div>
          </Panel>
        )}
      />
    </WorkspacePage>
  );
}
