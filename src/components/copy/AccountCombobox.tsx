"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TraderAccountSummary } from "@/lib/domain/types";

export function AccountCombobox({
  accounts,
  value,
  onChange,
  label,
  placeholder = "Select connected account",
  excludeAccountId,
  disabled = false,
}: {
  accounts: TraderAccountSummary[];
  value: string;
  onChange: (accountId: string) => void;
  label: string;
  placeholder?: string;
  excludeAccountId?: string;
  disabled?: boolean;
}) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const availableAccounts = useMemo(
    () => accounts
      .filter((account) => account.accountId !== excludeAccountId)
      .sort((left, right) => left.accountName.localeCompare(right.accountName)),
    [accounts, excludeAccountId],
  );
  const selected = accounts.find((account) => account.accountId === value);
  const normalizedSearch = search.trim().toLowerCase();
  const matches = useMemo(
    () => availableAccounts.filter((account) => {
      if (!normalizedSearch) return true;
      return [
        account.accountName,
        account.brokerName,
        account.serverName ?? "",
        account.platform ?? "",
      ].some((entry) => entry.toLowerCase().includes(normalizedSearch));
    }),
    [availableAccounts, normalizedSearch],
  );
  const visibleMatches = matches.slice(0, 80);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <p className="mb-2 text-sm font-semibold text-foreground">{label}</p>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
        className="flex h-12 w-full items-center justify-between gap-3 rounded-[5px] border border-line bg-panel-strong px-4 text-left text-sm text-foreground outline-none transition-colors hover:border-foreground/20 focus:border-accent focus:ring-2 focus:ring-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0">
          <span className={`block truncate font-semibold ${selected ? "text-foreground" : "text-muted"}`}>
            {selected?.accountName ?? placeholder}
          </span>
          {selected ? (
            <span className="mt-0.5 block truncate text-[11px] text-muted">
              {selected.brokerName}{selected.serverName ? ` · ${selected.serverName}` : ""}
            </span>
          ) : null}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div className="absolute z-50 mt-2 w-full min-w-[280px] overflow-hidden rounded-[5px] border border-line bg-panel shadow-2xl shadow-black/40">
          <div className="relative border-b border-line p-3">
            <Search className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              ref={inputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              placeholder="Search account, broker, or server"
              className="h-10 w-full rounded-[4px] border border-line bg-background pl-10 pr-3 text-sm text-foreground outline-none placeholder:text-muted focus:border-accent"
            />
          </div>
          <div id={listboxId} role="listbox" className="invisible-scrollbar max-h-72 overflow-y-auto p-2">
            {visibleMatches.length ? visibleMatches.map((account) => {
              const active = account.accountId === value;
              return (
                <button
                  key={account.accountId}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(account.accountId);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-[4px] px-3 py-2.5 text-left transition-colors ${
                    active ? "bg-accent/10" : "hover:bg-white/[0.04]"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-foreground">{account.accountName}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted">
                      {account.brokerName}{account.serverName ? ` · ${account.serverName}` : ""} · {account.platform ?? "MetaTrader"}
                    </span>
                  </span>
                  {active ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
                </button>
              );
            }) : (
              <div className="px-3 py-6 text-center">
                <p className="text-sm font-semibold text-foreground">No account found</p>
                <p className="mt-1 text-xs text-muted">Try another account name, broker, or server.</p>
              </div>
            )}
            {matches.length > visibleMatches.length ? (
              <p className="border-t border-line px-3 py-2 text-xs text-muted">
                Showing the first {visibleMatches.length} matches. Refine the search to narrow the list.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
