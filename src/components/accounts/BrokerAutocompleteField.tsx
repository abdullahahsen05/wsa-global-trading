"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
  const blurTimer = useRef<number | null>(null);

  function clearBlurTimer() {
    if (blurTimer.current) {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(value.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [value]);

  useEffect(() => () => clearBlurTimer(), []);

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
      <div className="relative">
        <input
          name={name}
          required={required}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => {
            clearBlurTimer();
            setOpen(true);
          }}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 160);
          }}
          placeholder={placeholder}
          autoComplete="off"
          className={controlClassName}
        />
        {open ? (
          <div
            role="listbox"
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={clearBlurTimer}
            className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-[80] max-h-[min(20rem,46vh)] overflow-y-auto overscroll-contain rounded-[6px] border border-line bg-panel shadow-[0_18px_45px_rgba(0,0,0,0.42)] [scrollbar-color:rgba(250,204,21,0.65)_rgba(255,255,255,0.08)] [scrollbar-width:thin]"
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
                className="flex w-full items-center gap-3 border-b border-line/60 px-3 py-3 text-left last:border-b-0 hover:bg-accent/10 focus:bg-accent/10 focus:outline-none"
              >
                {broker.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={broker.logoUrl} alt="" className="h-9 w-9 rounded-full border border-line bg-background object-contain" />
                ) : (
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/25 bg-accent/10 text-xs font-bold text-accent">
                    {initials(broker.name)}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">{broker.name}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {broker.serverCount ? `${broker.serverCount} server${broker.serverCount === 1 ? "" : "s"}` : "Server can be entered manually"}
                    {" · "}
                    {broker.source === "API2TRADE" ? "API2Trade" : "Workspace"}
                  </span>
                </span>
              </button>
            ))}
            {helperText ? (
              <div className="px-3 py-3 text-xs leading-5 text-muted">
                {helperText}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </FieldShell>
  );
}
