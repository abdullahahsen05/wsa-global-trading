"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { GhostButton, PrimaryButton } from "@/components/app/WorkspaceUI";
import { SelectField, TextAreaField, TextField } from "@/components/app/FormFields";
import type { CopyFollowerDto, FollowerCopyMode } from "@/lib/copy/types";

function optionalNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

function symbolList(value: string): string[] | null {
  const values = value
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : null;
}

function parseMapping(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [source, target, ...extra] = line.split(":");
    if (!source?.trim() || !target?.trim() || extra.length > 0) {
      throw new Error(`Invalid mapping "${line}". Use SOURCE:TARGET, one per line.`);
    }
    result[source.trim().toUpperCase()] = target.trim().toUpperCase();
  }
  return result;
}

export function FollowerSettingsDialog(props: {
  subscription: CopyFollowerDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const sub = props.subscription;
  const [copyEnabled, setCopyEnabled] = useState(sub?.copyEnabled ?? true);
  const [copyMode, setCopyMode] = useState<FollowerCopyMode>(sub?.copyMode ?? "BALANCE_RATIO");
  const [fixedLot, setFixedLot] = useState(sub?.fixedLot?.toString() ?? "");
  const [lotMultiplier, setLotMultiplier] = useState(sub?.lotMultiplier?.toString() ?? "");
  const [minLot, setMinLot] = useState(sub?.minLot?.toString() ?? "");
  const [maxLot, setMaxLot] = useState(sub?.maxLot?.toString() ?? "");
  const [maxOpenTrades, setMaxOpenTrades] = useState(sub?.maxOpenTrades?.toString() ?? "");
  const [maxDailyLoss, setMaxDailyLoss] = useState(sub?.maxDailyLossPercent?.toString() ?? "");
  const [maxDrawdown, setMaxDrawdown] = useState(sub?.maxDrawdownPercent?.toString() ?? "");
  const [allowedSymbols, setAllowedSymbols] = useState(sub?.allowedSymbols?.join(", ") ?? "");
  const [blockedSymbols, setBlockedSymbols] = useState(sub?.blockedSymbols?.join(", ") ?? "");
  const [mapping, setMapping] = useState(
    Object.entries(sub?.symbolMapping ?? {}).map(([source, target]) => `${source}:${target}`).join("\n"),
  );
  const [reverseCopy, setReverseCopy] = useState(sub?.reverseCopy ?? false);
  const [pauseOnDisconnect, setPauseOnDisconnect] = useState(sub?.pauseOnDisconnect ?? true);
  const [emergencyStop, setEmergencyStop] = useState(sub?.emergencyStop ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!sub || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/copy/subscriptions/${sub.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          copyEnabled,
          copyMode,
          fixedLot: optionalNumber(fixedLot),
          lotMultiplier: optionalNumber(lotMultiplier),
          minLot: optionalNumber(minLot),
          maxLot: optionalNumber(maxLot),
          maxOpenTrades: optionalNumber(maxOpenTrades),
          maxDailyLossPercent: optionalNumber(maxDailyLoss),
          maxDrawdownPercent: optionalNumber(maxDrawdown),
          allowedSymbols: symbolList(allowedSymbols),
          blockedSymbols: symbolList(blockedSymbols),
          symbolMapping: parseMapping(mapping),
          copyNewTradesOnly: true,
          reverseCopy,
          pauseOnDisconnect,
          emergencyStop,
        }),
      });
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error?.message ?? "Settings could not be saved.");
      props.onSaved();
      props.onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={Boolean(sub)} onOpenChange={(open) => !open && !saving && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[94vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 invisible-scrollbar overflow-y-auto rounded-[6px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
          <Dialog.Title className="text-xl font-semibold text-foreground">Follower copy settings</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
            {sub?.followerAccountName ?? "Follower account"} · supported settings are enforced by both simulation and the guarded live path.
          </Dialog.Description>

          <div className="mt-5 grid gap-5">
            <div className="rounded-[4px] border border-line bg-background p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-foreground">Copy control</h3>
                  <p className="mt-1 text-xs text-muted">Emergency stop overrides the normal enabled setting.</p>
                </div>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={copyEnabled} onChange={(event) => setCopyEnabled(event.target.checked)} />
                  Copy enabled
                </label>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <SelectField label="Copy mode" value={copyMode} onChange={(event) => setCopyMode(event.target.value as FollowerCopyMode)}>
                  <option value="BALANCE_RATIO">Balance ratio</option>
                  <option value="LOT_MULTIPLIER">Lot multiplier</option>
                  <option value="FIXED_LOT">Fixed lot</option>
                  <option value="RISK_PERCENT" disabled>Risk percent · coming soon</option>
                </SelectField>
                <TextField
                  label="Fixed lot"
                  type="number"
                  min="0.01"
                  step="0.01"
                  disabled={copyMode !== "FIXED_LOT"}
                  value={fixedLot}
                  onChange={(event) => setFixedLot(event.target.value)}
                />
                <TextField
                  label="Lot multiplier"
                  type="number"
                  min="0.01"
                  step="0.01"
                  disabled={copyMode !== "LOT_MULTIPLIER"}
                  value={lotMultiplier}
                  onChange={(event) => setLotMultiplier(event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-4 rounded-[4px] border border-line bg-background p-4 sm:grid-cols-2 lg:grid-cols-3">
              <TextField label="Minimum lot" type="number" min="0.01" step="0.01" value={minLot} onChange={(event) => setMinLot(event.target.value)} />
              <TextField label="Maximum lot" type="number" min="0.01" step="0.01" value={maxLot} onChange={(event) => setMaxLot(event.target.value)} />
              <TextField label="Maximum open trades" type="number" min="1" step="1" value={maxOpenTrades} onChange={(event) => setMaxOpenTrades(event.target.value)} />
              <TextField label="Maximum daily loss %" type="number" min="0.01" max="100" step="0.1" value={maxDailyLoss} onChange={(event) => setMaxDailyLoss(event.target.value)} />
              <TextField label="Maximum drawdown %" type="number" min="0.01" max="100" step="0.1" value={maxDrawdown} onChange={(event) => setMaxDrawdown(event.target.value)} />
              <label className="flex items-center gap-2 self-end rounded-[4px] border border-line px-3 py-3 text-sm text-foreground">
                <input type="checkbox" checked={reverseCopy} onChange={(event) => setReverseCopy(event.target.checked)} />
                Reverse BUY / SELL
              </label>
            </div>

            <div className="grid gap-4 rounded-[4px] border border-line bg-background p-4 sm:grid-cols-2">
              <TextAreaField
                label="Allowed symbols"
                rows={2}
                value={allowedSymbols}
                onChange={(event) => setAllowedSymbols(event.target.value)}
                placeholder="XAUUSD, EURUSD"
                hint="Comma separated. Leave blank to allow all symbols not blocked."
              />
              <TextAreaField
                label="Blocked symbols"
                rows={2}
                value={blockedSymbols}
                onChange={(event) => setBlockedSymbols(event.target.value)}
                placeholder="BTCUSD, US30"
                hint="Comma separated."
              />
              <div className="sm:col-span-2">
                <TextAreaField
                  label="Symbol mapping"
                  rows={3}
                  value={mapping}
                  onChange={(event) => setMapping(event.target.value)}
                  placeholder={"XAUUSD:GOLD\nUS30:DJ30"}
                  hint="One SOURCE:FOLLOWER pair per line."
                />
              </div>
            </div>

            <div className="grid gap-3 rounded-[4px] border border-line bg-background p-4 sm:grid-cols-3">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked readOnly />
                New trades only
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={pauseOnDisconnect} onChange={(event) => setPauseOnDisconnect(event.target.checked)} />
                Pause on disconnect
              </label>
              <label className="flex items-center gap-2 text-sm font-semibold text-danger">
                <input type="checkbox" checked={emergencyStop} onChange={(event) => setEmergencyStop(event.target.checked)} />
                Emergency stop
              </label>
            </div>

            <div className="rounded-[4px] border border-line bg-background p-4">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-muted" />
                <h3 className="font-semibold text-foreground">Coming soon</h3>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted">
                Risk-percent sizing, equity-peak drawdown, live spread/slippage checks, copying historical
                positions, and copying source stop-loss/take-profit are disabled because the current engine
                cannot guarantee those behaviors yet.
              </p>
            </div>

            {error ? <p className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p> : null}
          </div>

          <div className="mt-5 flex justify-end gap-3 border-t border-line pt-4">
            <GhostButton type="button" disabled={saving} onClick={props.onClose}>Cancel</GhostButton>
            <PrimaryButton type="button" disabled={saving} onClick={() => void save()}>
              {saving ? <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" /> : null}
              {saving ? "Saving…" : "Save enforced settings"}
            </PrimaryButton>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={saving}
            onClick={props.onClose}
            className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
