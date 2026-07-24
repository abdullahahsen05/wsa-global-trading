"use client";

import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { Sparkles } from "lucide-react";

const ease = [0.22, 1, 0.36, 1] as const;

export const controlClassName =
  "h-12 w-full rounded-[5px] border border-line bg-panel-strong px-4 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/10 disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-panel";

export const textareaClassName =
  "min-h-28 w-full rounded-[5px] border border-line bg-panel-strong px-4 py-3 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/10 disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-panel";

export const selectClassName =
  "h-12 w-full rounded-[5px] border border-line bg-panel-strong px-4 text-sm text-foreground outline-none transition-colors duration-150 focus:border-accent focus:ring-2 focus:ring-accent/10 disabled:cursor-not-allowed disabled:opacity-50";

export const pageMotion = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0,
      delayChildren: 0,
    },
  },
};

export const itemMotion = {
  hidden: { opacity: 0, y: 4 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease },
  },
};

export function WorkspacePage({
  title,
  description,
  eyebrow,
  action,
  children,
}: {
  title: string;
  description: string;
  eyebrow: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <motion.section
      variants={pageMotion}
      initial="hidden"
      animate="show"
      className="w-full"
    >
      <motion.div variants={itemMotion} className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">{eyebrow}</p>
          <h1 className="mt-2 text-[30px] font-semibold leading-tight text-foreground">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm font-medium leading-6 text-muted">{description}</p>
        </div>
        {action}
      </motion.div>
      {children}
    </motion.section>
  );
}

export function PageActionGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-3">{children}</div>;
}

export function FilterChipRow({
  chips,
}: {
  chips: Array<{
    label: string;
    active: boolean;
    onClick: () => void;
  }>;
}) {
  return (
    <div className="invisible-scrollbar flex max-w-full flex-wrap gap-2 overflow-x-auto rounded-[4px] border border-line bg-background p-2 sm:inline-flex">
      {chips.map((chip) => (
        <button
          key={chip.label}
          type="button"
          onClick={chip.onClick}
          aria-pressed={chip.active}
          className={`btn-dark ${chip.active ? "btn-active" : ""}`}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={itemMotion}
      className={`card-surface p-5 ${className}`}
    >
      {children}
    </motion.div>
  );
}

export function StatTile({
  label,
  value,
  helper,
  tone = "default",
}: {
  label: string;
  value: string | number;
  helper?: string;
  tone?: "default" | "accent" | "lime" | "danger";
}) {
  const toneClass =
    tone === "accent"
      ? "text-accent"
      : tone === "lime"
        ? "text-accent-2"
        : tone === "danger"
          ? "text-danger"
          : "text-foreground";

  return (
    <motion.div
      variants={itemMotion}
      className="bg-panel p-5"
    >
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className={`mt-3 text-2xl font-semibold ${toneClass}`}>{value}</p>
      {helper ? <p className="mt-2 text-xs font-medium text-muted">{helper}</p> : null}
    </motion.div>
  );
}

export function InlineStatusStrip({
  items,
}: {
  items: Array<{
    label: string;
    value: ReactNode;
    helper?: ReactNode;
    tone?: "default" | "accent" | "lime" | "danger";
  }>;
  }) {
  return (
    <div className="invisible-scrollbar overflow-x-auto border border-line bg-panel">
      <div className="flex min-w-max">
        {items.map((item) => {
          const toneClass =
            item.tone === "accent"
              ? "text-accent"
              : item.tone === "lime"
                ? "text-accent-2"
                : item.tone === "danger"
                  ? "text-danger"
                  : "text-foreground";

          return (
            <div
              key={item.label}
              className="flex min-w-[220px] flex-1 items-center justify-between gap-4 border-r border-line px-4 py-3 last:border-r-0"
            >
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  {item.label}
                </p>
                {item.helper ? (
                  <p className="mt-1 truncate text-xs font-medium text-muted">{item.helper}</p>
                ) : null}
              </div>
              <p className={`shrink-0 text-base font-semibold ${toneClass}`}>{item.value}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function StatusPill({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "lime" | "muted" | "danger";
}) {
  const toneClass =
    tone === "lime"
      ? "status-pill status-pill-green"
      : tone === "danger"
        ? "status-pill border-danger/20 bg-danger/10 text-danger"
        : tone === "muted"
          ? "status-pill border-line bg-panel-strong text-muted"
          : "status-pill";

  return (
    <span className={toneClass}>{children}</span>
  );
}

export function DataTable({
  headers,
  rows,
  paginated = true,
  initialPageSize = 10,
  pageSizeOptions = [10, 20, 50],
  maxBodyHeight,
}: {
  headers: string[];
  rows: Array<Array<ReactNode>>;
  paginated?: boolean;
  initialPageSize?: number;
  pageSizeOptions?: number[];
  maxBodyHeight?: string;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const showPagination = paginated && rows.length > Math.min(...pageSizeOptions);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = useMemo(
    () => showPagination ? rows.slice((currentPage - 1) * pageSize, currentPage * pageSize) : rows,
    [currentPage, pageSize, rows, showPagination],
  );
  const start = rows.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(rows.length, currentPage * pageSize);

  return (
    <div className="overflow-hidden border border-line bg-panel">
      <div className="invisible-scrollbar overflow-x-auto" style={maxBodyHeight ? { maxHeight: maxBodyHeight } : undefined}>
        <table className="w-full min-w-[780px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-panel-strong text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
            <tr>
              {headers.map((header, index) => (
                <th
                  key={header}
                  className={`h-10 whitespace-nowrap border-b border-line px-4 py-2 ${index > 0 ? "text-right" : ""}`}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className="min-h-12 border-t border-line/80 transition-colors hover:bg-white/[0.025]"
              >
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className={`h-12 px-4 py-2.5 align-middle text-foreground/80 ${cellIndex === 0 ? "font-medium text-foreground" : "text-right tabular-nums"}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showPagination ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-panel-strong px-4 py-3 text-xs text-muted">
          <span>
            Showing {start}-{end} of {rows.length}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              Rows
              <select
                value={pageSize}
                onChange={(event) => {
                  setPage(1);
                  setPageSize(Number(event.target.value));
                }}
                className="h-8 rounded-[4px] border border-line bg-background px-2 text-xs font-semibold text-foreground outline-none focus:border-accent"
              >
                {pageSizeOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className="btn-dark h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <span className="min-w-14 text-center font-semibold text-foreground">{currentPage} / {totalPages}</span>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              className="btn-dark h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PaginationControls({
  currentPage,
  totalItems,
  pageSize,
  pageSizeOptions = [6, 9, 12],
  onPageChange,
  onPageSizeChange,
}: {
  currentPage: number;
  totalItems: number;
  pageSize: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const start = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(totalItems, safePage * pageSize);

  if (totalItems <= pageSizeOptions[0]) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-xs text-muted">
      <span>Showing {start}-{end} of {totalItems}</span>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          Rows
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="h-8 rounded-[4px] border border-line bg-background px-2 text-xs font-semibold text-foreground outline-none focus:border-accent"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() => onPageChange(Math.max(1, safePage - 1))}
          className="btn-dark h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          Previous
        </button>
        <span className="min-w-14 text-center font-semibold text-foreground">{safePage} / {totalPages}</span>
        <button
          type="button"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
          className="btn-dark h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function PrimaryButton({
  children,
  className = "",
  ...props
}: HTMLMotionProps<"button"> & { children: ReactNode }) {
  return (
    <motion.button
      {...props}
      className={`btn-dark btn-active disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {children}
    </motion.button>
  );
}

export function GhostButton({
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      {...props}
      className={`btn-dark disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {children}
    </button>
  );
}

export function FieldShell({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold text-muted">
      <span className="label-text">{label}</span>
      {children}
      {hint ? <span className="text-xs font-medium leading-5 text-muted">{hint}</span> : null}
      {error ? <span className="text-xs font-semibold text-danger">{error}</span> : null}
    </label>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = Sparkles,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: typeof Sparkles;
}) {
  const Icon = icon;

  return (
    <div className="py-4 text-left">
      <div className="grid h-9 w-9 place-items-center rounded-[4px] bg-accent/10 text-accent">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{description}</p>
      {action ? <div className="mt-5 flex">{action}</div> : null}
    </div>
  );
}
