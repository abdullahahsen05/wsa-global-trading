"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DirectorySearchOverlay } from "@/components/app/DirectorySearchOverlay";
import {
  GhostButton,
  InlineStatusStrip,
  Panel,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";

type ApiAuditRecord = {
  id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type AuditRecord = {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
};

function toAuditRecord(raw: ApiAuditRecord): AuditRecord {
  return {
    id: raw.id,
    actor: raw.actor_user_id ?? "System",
    action: raw.action,
    entity: raw.entity_type,
    entityId: raw.entity_id ?? "—",
    createdAt: raw.created_at,
  };
}

export default function AdminAuditPage() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");

  const { data: rawLogs = [], isLoading } = useQuery<ApiAuditRecord[]>({
    queryKey: ["admin-audit"],
    queryFn: async () => {
      const res = await fetch("/api/admin/audit");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load audit logs");
      return json.data;
    },
  });

  const logs = useMemo<AuditRecord[]>(() => rawLogs.map(toAuditRecord), [rawLogs]);
  const effectiveSelectedId = selectedId || logs[0]?.id || "";
  const selectedLog = logs.find((log) => log.id === effectiveSelectedId) ?? logs[0];

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Audit log"
      description="A quiet audit shell with search and paging moved into an overlay for high-volume review."
      action={
        <GhostButton type="button" onClick={() => setSearchOpen(true)}>
          <Search className="mr-2 inline-block h-4 w-4" />
          Search audit
        </GhostButton>
      }
    >
      <InlineStatusStrip
        items={[
          { label: "Events today", value: isLoading ? "..." : logs.length },
          { label: "Retention", value: "365 days", helper: "Production policy target" },
        ]}
      />

      {selectedLog ? (
        <div className="mt-5">
          <Panel className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Selected event</p>
            <h2 className="mt-2 text-lg font-semibold text-foreground">{selectedLog.action}</h2>
            <p className="mt-1 text-sm text-muted">
              {selectedLog.actor} - {selectedLog.entity}
            </p>

            <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Actor</p>
                <p className="mt-1 text-sm font-semibold text-foreground truncate">{selectedLog.actor}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Entity</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{selectedLog.entity}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Entity ID</p>
                <p className="mt-1 text-sm font-semibold text-foreground truncate">{selectedLog.entityId}</p>
              </div>
            </div>
          </Panel>
        </div>
      ) : isLoading ? (
        <div className="mt-5 rounded-[4px] border border-line bg-panel p-8 text-center text-sm text-muted">
          Loading audit logs...
        </div>
      ) : (
        <div className="mt-5 rounded-[4px] border border-line bg-panel p-8 text-center text-sm text-muted">
          No audit events found.
        </div>
      )}

      <DirectorySearchOverlay<AuditRecord>
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search audit"
        description="Audit search and paging stay inside the overlay to keep the page sparse."
        items={logs}
        selectedId={selectedLog?.id ?? ""}
        onSelect={(id) => {
          setSelectedId(id);
          setSearchOpen(false);
        }}
        searchLabel="Search audit entries"
        searchPlaceholder="Search actor, action, or entity"
        emptyTitle="No audit entries match"
        emptyDescription="Use a different search term to reveal the matching actions."
        getId={(log) => log.id}
        matches={(log, state) => {
          const search = state.query.trim().toLowerCase();
          return (
            search.length === 0 ||
            log.actor.toLowerCase().includes(search) ||
            log.action.toLowerCase().includes(search) ||
            log.entity.toLowerCase().includes(search) ||
            log.entityId.toLowerCase().includes(search)
          );
        }}
        renderRow={(log) => (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{log.actor}</p>
                <p className="mt-1 truncate text-xs text-muted">{log.action}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {log.entity}
              </span>
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {new Date(log.createdAt).toLocaleDateString()}
              </span>
            </div>
          </>
        )}
        renderPreview={(log) => (
          <Panel className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Audit preview</p>
                <h3 className="mt-2 text-lg font-semibold text-foreground">{log.action}</h3>
                <p className="mt-1 text-sm text-muted">
                  {log.actor} - {log.entity}
                </p>
              </div>
            </div>
            <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-2">
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Actor</p>
                <p className="mt-1 text-sm font-semibold text-foreground truncate">{log.actor}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Entity</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{log.entity}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Entity ID</p>
                <p className="mt-1 text-sm font-semibold text-foreground truncate">{log.entityId}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Timestamp</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{new Date(log.createdAt).toLocaleString()}</p>
              </div>
            </div>
          </Panel>
        )}
      />
    </WorkspacePage>
  );
}
