"use client";

export function DemoModeBanner() {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-x-5 gap-y-2 rounded-[4px] border border-accent/30 bg-accent/5 px-4 py-3">
      <div className="flex items-center gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Demo mode</p>
        <span className="hidden h-4 w-px bg-line sm:block" />
        <p className="text-sm font-semibold text-foreground">Sample data only</p>
      </div>
      <p className="text-xs leading-5 text-muted">
        No real trades, payments, broker actions, AI calls, or external market feeds.
      </p>
    </div>
  );
}
