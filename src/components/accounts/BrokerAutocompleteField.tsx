"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { controlClassName, FieldShell } from "@/components/app/WorkspaceUI";

type BrokerPlatform = "MT4" | "MT5";

export type BrokerSearchOption = {
  id: string;
  name: string;
  logoUrl: string | null;
  website: string | null;
  platforms: BrokerPlatform[];
  serverCount: number;
  servers: Array<{ name: string; access: string[] }>;
  source: "API2TRADE" | "WORKSPACE";
};

async function loadBrokerOptions(params: {
  query: string;
  platform: BrokerPlatform;
}): Promise<{
  brokers: BrokerSearchOption[];
  available: boolean;
  message: string | null;
}> {
  const response = await fetch(
    `/api/brokers/search?platform=${params.platform}&query=${encodeURIComponent(params.query)}`,
  );
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "Broker search failed.");
  return payload.data;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "BR";
}

export function BrokerAutocompleteField({
  label = "Broker name",
  name,
  value,
  onChange,
  onSelectBroker,
  platform,
  placeholder = "Search broker name",
  required,
  disabled,
}: {
  label?: string;
  name?: string;
  value: string;
  onChange(value: string): void;
  onSelectBroker?(broker: BrokerSearchOption): void;
  platform: BrokerPlatform;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(value.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [value]);

  const brokersQuery = useQuery({
    queryKey: ["api2trade-broker-search", platform, query],
    queryFn: () => loadBrokerOptions({ query, platform }),
    enabled: !disabled && open,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const brokers = brokersQuery.data?.brokers ?? [];
  const message = brokersQuery.error instanceof Error
    ? brokersQuery.error.message
    : brokersQuery.data?.message;

  const helperText = useMemo(() => {
    if (!open) return null;
    if (brokersQuery.isFetching) return "Loading brokers from API2Trade…";
    if (message) return message;
    if (!brokers.length) return "No broker results yet.";
    return null;
  }, [brokers.length, brokersQuery.isFetching, message, open]);

  return (
    <FieldShell label={label}>
      <>
        <input
          name={name}
          required={required}
          disabled={disabled}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            if (!disabled) setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          placeholder={placeholder}
          autoComplete="off"
          className={controlClassName}
        />
        {open ? (
          <div className="fixed inset-0 z-[120] grid place-items-center bg-black/60 p-3 sm:p-6">
            <div
              className="w-full max-w-2xl overflow-hidden rounded-[8px] border border-line bg-panel shadow-[0_28px_90px_rgba(0,0,0,0.62)]"
            >
              <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
                    Broker search
                  </p>
                  <h3 className="mt-1 text-lg font-semibold text-foreground">
                    Select your broker
                  </h3>
                  <p className="mt-1 text-sm text-muted">
                    {query ? `Showing API2Trade matches for “${query}”.` : "Showing recommended brokers. Start typing to search live broker data."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line bg-background text-muted hover:text-foreground"
                  aria-label="Close broker search"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="border-b border-line bg-background/70 px-4 py-3 sm:px-5">
                <input
                  value={value}
                  onChange={(event) => onChange(event.target.value)}
                  autoFocus
                  autoComplete="off"
                  placeholder={placeholder}
                  className={controlClassName}
                />
              </div>

              <div
                role="listbox"
                tabIndex={-1}
                className="max-h-[min(26rem,58vh)] overflow-y-auto overscroll-contain [scrollbar-color:rgba(250,204,21,0.65)_rgba(255,255,255,0.08)] [scrollbar-width:thin]"
              >
                {brokers.map((broker) => (
                  <button
                    key={broker.id}
                    type="button"
                    onClick={() => {
                      onChange(broker.name);
                      onSelectBroker?.(broker);
                      setOpen(false);
                    }}
                    role="option"
                    aria-selected={broker.name === value}
                    className="flex w-full items-center gap-3 border-b border-line/60 px-4 py-4 text-left last:border-b-0 hover:bg-accent/10 focus:bg-accent/10 focus:outline-none sm:px-5"
                  >
                    {broker.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={broker.logoUrl} alt="" className="h-11 w-11 rounded-full border border-line bg-background object-contain" />
                    ) : (
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-accent/25 bg-accent/10 text-sm font-bold text-accent">
                        {initials(broker.name)}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-semibold text-foreground">{broker.name}</span>
                      <span className="mt-1 block text-sm text-muted">
                        {broker.serverCount ? `${broker.serverCount} server${broker.serverCount === 1 ? "" : "s"} available` : "Server can be entered manually"}
                        {" · "}
                        {broker.source === "API2TRADE" ? "API2Trade data" : "Workspace recommendation"}
                      </span>
                    </span>
                    <span className="hidden rounded-full border border-line px-3 py-1 text-xs font-semibold text-muted sm:inline-flex">
                      Select
                    </span>
                  </button>
                ))}
                {helperText ? (
                  <div className="px-4 py-5 text-sm leading-6 text-muted sm:px-5">
                    {helperText}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-background/60 px-4 py-3 text-xs text-muted sm:px-5">
                <span>
                  After selecting a broker, choose the exact server from the server dropdown.
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="font-semibold text-accent hover:text-accent-2"
                >
                  Continue manually
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </>
    </FieldShell>
  );
}
