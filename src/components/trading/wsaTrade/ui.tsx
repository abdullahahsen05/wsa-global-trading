"use client";

import { useState, type KeyboardEvent } from "react";

/** Small building blocks shared by the parts of the WSA Trade panel. */

export const FIELD_CLASS =
  "h-9 w-full rounded-[4px] border border-line bg-background px-3 text-xs font-semibold text-foreground outline-none transition focus:border-accent disabled:opacity-60";
export const LABEL_CLASS = "mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted";
export const CHIP_CLASS =
  "rounded-[4px] border border-line bg-background px-2 py-1 text-[11px] font-semibold text-muted transition hover:border-line-strong hover:text-foreground disabled:opacity-50";
export const BANNER_CLASS = "flex gap-2 rounded-[4px] border border-line bg-background px-3 py-2 text-xs";

export type Tone = "gain" | "loss" | "flat";

export function toneClass(tone: Tone): string {
  if (tone === "gain") return "text-accent-2";
  return tone === "loss" ? "text-danger" : "text-foreground";
}

export function Figure({ label, value, tone = "flat" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-0.5 truncate text-sm font-semibold ${toneClass(tone)}`}>{value}</p>
    </div>
  );
}

interface CommitFieldProps {
  id: string;
  label: string;
  /** the saved value as text */
  value: string;
  /** called when the person leaves the box or presses Enter; return false to refuse the text (the box goes back to the saved value) */
  onCommit: (text: string) => boolean | void;
  placeholder?: string;
  inputMode?: "decimal" | "numeric" | "text";
  disabled?: boolean;
  hint?: string;
}

/**
 * A text box that keeps what is being typed to itself and hands it over when the person is
 * done. When the saved value changes from outside, the box shows the new value.
 */
export function CommitField({ id, label, value, onCommit, placeholder, inputMode = "decimal", disabled, hint }: CommitFieldProps) {
  const [syncedValue, setSyncedValue] = useState(value);
  const [draft, setDraft] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value);
  }

  function commit() {
    if (onCommit(draft) === false) setDraft(value);
  }

  return (
    <div>
      <label className={LABEL_CLASS} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        inputMode={inputMode}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        className={FIELD_CLASS}
      />
      {hint ? <p className="mt-1 text-[11px] leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}

/** A switch with a text, for the trade rules. */
export function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
      />
      <label htmlFor={id} className="min-w-0 text-xs text-foreground">
        <span className="font-semibold">{label}</span>
        {hint ? <span className="mt-0.5 block text-[11px] leading-snug text-muted">{hint}</span> : null}
      </label>
    </div>
  );
}
