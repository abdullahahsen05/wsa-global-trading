type RingTone = "yellow" | "lime";
type RingStatusTone = "accent" | "lime" | "muted" | "danger";

export type PerformanceRingItem = {
  label: string;
  value: string;
  status: string;
  statusTone: RingStatusTone;
  progress: number;
  tone?: RingTone;
};

const ringColors: Record<RingTone, string> = {
  yellow: "#ffcf00",
  lime: "#d7ff32",
};

export function PerformanceRings({ items }: { items: PerformanceRingItem[] }) {
  return (
    <div className="overflow-hidden rounded-[4px] border border-line bg-panel">
      <div className="grid sm:grid-cols-2 xl:grid-cols-5">
        {items.map((item) => (
        <div
          key={item.label}
          className="min-w-0 border-b border-line px-5 py-4 sm:border-r xl:border-b-0 last:border-b-0 sm:[&:nth-child(even)]:border-r-0 xl:[&:nth-child(even)]:border-r xl:last:border-r-0"
        >
          <p className="min-h-8 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            {item.label}
          </p>
          <p className="mt-1 text-[26px] font-semibold leading-none tabular-nums text-foreground">
            {item.value}
          </p>
          <div className="mt-3 flex items-center gap-2 text-xs font-medium">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: ringColors[item.tone ?? "yellow"] }}
              aria-hidden="true"
            />
            <span
              className={
                item.statusTone === "danger"
                  ? "text-danger"
                  : item.statusTone === "lime"
                    ? "text-accent-2"
                    : item.statusTone === "muted"
                      ? "text-muted"
                      : "text-accent"
              }
            >
              {item.status}
            </span>
          </div>
          <div className="mt-5 h-px bg-line">
            <div
              className="h-px transition-[width] duration-200"
              style={{
                width: `${Math.max(4, Math.min(item.progress, 1) * 100)}%`,
                backgroundColor: ringColors[item.tone ?? "yellow"],
              }}
            />
          </div>
        </div>
        ))}
      </div>
    </div>
  );
}
