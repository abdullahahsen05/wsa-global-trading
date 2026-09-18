import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex min-w-0 flex-col justify-between gap-4 border-b border-line pb-5 lg:flex-row lg:items-end">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">{eyebrow}</p>
        <h2 className="mt-2 break-words text-[30px] font-semibold leading-tight text-foreground">{title}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{description}</p>
      </div>
      {action ? <div className="min-w-0 lg:w-auto">{action}</div> : null}
    </div>
  );
}
