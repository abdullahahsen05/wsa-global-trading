"use client";

import { TextAreaField, TextField } from "@/components/app/FormFields";
import type { CalibrationForm } from "@/lib/copy/selfCopyView";

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm text-foreground">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {hint ? <span className="mt-0.5 block text-xs leading-5 text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * How a copied trade is shaped before it goes to the follower - the same fields for a self-copy
 * route and for a strategy follower. Every field is optional: an empty field keeps what the
 * platform always did (the source's levels, the platform's slippage limit, no age limit).
 */
export function CopyCalibrationFields({
  value,
  onChange,
  showExisting = true,
  divider = true,
}: {
  value: CalibrationForm;
  onChange: (next: CalibrationForm) => void;
  /** "Also copy trades that are already open" - a self-copy option; a strategy follower copies new trades only */
  showExisting?: boolean;
  /** a line above the block, for a form where it follows other fields (off inside a box of its own) */
  divider?: boolean;
}) {
  const set = <K extends keyof CalibrationForm>(key: K, next: CalibrationForm[K]) => onChange({ ...value, [key]: next });
  return (
    <div className={divider ? "space-y-4 border-t border-line pt-5" : "space-y-4"}>
      <div>
        <h3 className="text-sm font-semibold text-foreground">Calibration</h3>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted">
          Shapes every copied trade before it is sent. Leave a field empty to keep the default: the source&apos;s stop loss and take
          profit, the platform&apos;s slippage limit and no age limit.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <TextField
          label="Fixed stop loss (points)"
          hint="Replaces the source's stop loss"
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          placeholder="Follow the source"
          value={value.stopLossPoints}
          onChange={(event) => set("stopLossPoints", event.target.value)}
        />
        <TextField
          label="Fixed take profit (points)"
          hint="Replaces the source's take profit"
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          placeholder="Follow the source"
          value={value.takeProfitPoints}
          onChange={(event) => set("takeProfitPoints", event.target.value)}
        />
        <TextField
          label="Maximum slippage (points)"
          hint="Stricter than the platform's limit only"
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          placeholder="Platform limit"
          value={value.maxSlippagePoints}
          onChange={(event) => set("maxSlippagePoints", event.target.value)}
        />
        <TextField
          label="Maximum signal age (seconds)"
          hint="Older signals are skipped"
          type="number"
          min="0.1"
          step="any"
          inputMode="decimal"
          placeholder="No limit"
          value={value.maxSignalAgeSeconds}
          onChange={(event) => set("maxSignalAgeSeconds", event.target.value)}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Toggle
          checked={value.copyStopLoss}
          onChange={(next) => set("copyStopLoss", next)}
          label="Copy the source's stop loss"
          hint="Off: the follower trade has no stop loss unless a fixed one is set above."
        />
        <Toggle
          checked={value.copyTakeProfit}
          onChange={(next) => set("copyTakeProfit", next)}
          label="Copy the source's take profit"
          hint="Off: the follower trade has no take profit unless a fixed one is set above."
        />
        <Toggle
          checked={value.autoSymbolMatch}
          onChange={(next) => set("autoSymbolMatch", next)}
          label="Find the follower broker's own symbol name"
          hint="XAUUSD on one broker, XAUUSDm or GOLD on the other: the name is read from the follower's broker list."
        />
        {showExisting ? (
          <Toggle
            checked={value.copyExisting}
            onChange={(next) => set("copyExisting", next)}
            label="Also copy trades that are already open"
            hint="Off (recommended): only trades opened after the route went live are copied."
          />
        ) : null}
      </div>

      <TextAreaField
        label="Symbol mapping (optional)"
        hint="One pair per line, source name = follower name, for example XAUUSD=GOLD.pro. A mapping wins over the automatic match."
        placeholder={"XAUUSD=GOLD.pro\nUS30=DJ30.cash"}
        className="min-h-20 font-mono"
        spellCheck={false}
        value={value.symbolMapping}
        onChange={(event) => set("symbolMapping", event.target.value)}
      />
    </div>
  );
}
