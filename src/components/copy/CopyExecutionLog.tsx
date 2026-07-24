"use client";

import { Activity, Search, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import { SearchField } from "@/components/app/FormFields";
import { DataTable, Panel, StatusPill } from "@/components/app/WorkspaceUI";
import type { CopyLogDto } from "@/lib/copy/types";

function statusTone(status: CopyLogDto["status"]): "lime" | "danger" | "accent" {
  if (status === "SUCCESS") return "lime";
  if (status === "FAILED") return "danger";
  return "accent";
}

function displayLot(log: CopyLogDto) {
  const lot = log.executedLot ?? log.calculatedLot;
  return lot === null ? "—" : lot.toFixed(2);
}

export function CopyExecutionLog({ logs, loading }: { logs: CopyLogDto[]; loading: boolean }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"ALL" | CopyLogDto["status"]>("ALL");
  const successful = logs.filter((log) => log.status === "SUCCESS").length;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredLogs = useMemo(
    () => logs.filter((log) => {
      if (status !== "ALL" && log.status !== status) return false;
      if (!normalizedSearch) return true;
      return [
        log.strategyName,
        log.symbol ?? "",
        log.side ?? "",
        log.action,
        log.status,
        log.errorCode ?? "",
        log.errorMessage ?? "",
        log.brokerOrderId ?? "",
      ].some((entry) => entry.toLowerCase().includes(normalizedSearch));
    }),
    [logs, normalizedSearch, status],
  );

  return (
    <Panel className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-5 py-5">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[4px] border border-lime/25 bg-lime/10 text-lime">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Copy execution log</h2>
            <p className="mt-1 text-sm text-muted">Search up to 300 recent strategy-copy attempts for your follower accounts.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted">
          <span>{logs.length} events</span>
          <span className="h-1 w-1 rounded-full bg-line" />
          <span className="text-lime">{successful} executed</span>
        </div>
      </div>

      {!loading && logs.length ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-background/40 px-5 py-3">
          <div className="flex max-w-full flex-wrap gap-2">
            {(["ALL", "SUCCESS", "SKIPPED", "FAILED", "PENDING", "RETRYING"] as const).map((option) => {
              const count = option === "ALL" ? logs.length : logs.filter((log) => log.status === option).length;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={status === option}
                  onClick={() => setStatus(option)}
                  className={`btn-dark h-9 px-3 text-xs ${status === option ? "btn-active" : ""}`}
                >
                  {option === "ALL" ? "All" : option.charAt(0) + option.slice(1).toLowerCase()} ({count})
                </button>
              );
            })}
          </div>
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <SearchField
              aria-label="Search copy execution log"
              placeholder="Search strategy, symbol, result"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 pl-9"
            />
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="px-5 py-8 text-sm text-muted">Loading copy activity...</p>
      ) : filteredLogs.length ? (
        <DataTable
          headers={["Strategy", "Trade", "Action", "Lot", "Result", "Time"]}
          paginated
          initialPageSize={20}
          pageSizeOptions={[20, 50, 100]}
          maxBodyHeight="560px"
          rows={filteredLogs.map((log) => [
            <div key="strategy">
              <p className="font-semibold text-foreground">{log.strategyName}</p>
              <p className="mt-1 text-xs text-muted">WSA live strategy</p>
            </div>,
            <div key="trade" className="flex items-center justify-end gap-2">
              {log.side === "SELL" ? <TrendingDown className="h-4 w-4 text-danger" /> : <TrendingUp className="h-4 w-4 text-lime" />}
              <span className="font-mono font-semibold text-foreground">{log.symbol ?? "—"}</span>
              <span className={log.side === "SELL" ? "text-danger" : "text-lime"}>{log.side ?? "—"}</span>
            </div>,
            <span key="action" className="font-semibold text-foreground">{log.action}</span>,
            <span key="lot" className="font-mono text-foreground">{displayLot(log)}</span>,
            <div key="result" className="ml-auto max-w-xs">
              <StatusPill tone={statusTone(log.status)}>{log.status}</StatusPill>
              {log.errorMessage ? <p className="mt-2 text-xs leading-5 text-danger">{log.errorMessage}</p> : null}
            </div>,
            <span key="time" className="text-xs text-muted">{new Date(log.createdAt).toLocaleString()}</span>,
          ])}
        />
      ) : (
        <div className="px-5 py-9">
          <p className="font-semibold text-foreground">{logs.length ? "No matching copy events" : "No copied trades yet"}</p>
          <p className="mt-1 text-sm text-muted">
            {logs.length
              ? "Adjust the search or result filter."
              : "When an active strategy places, changes, or closes a follower trade, the result will appear here."}
          </p>
        </div>
      )}
    </Panel>
  );
}
