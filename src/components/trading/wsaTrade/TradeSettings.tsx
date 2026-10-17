"use client";

import { useId } from "react";
import {
  MAX_WSA_TRADE_LEVEL_POINTS,
  WSA_TRADE_LEVEL_MODES,
  type WsaTradeLevelMode,
  type WsaTradePatch,
  type WsaTradeWorkspace,
} from "@/lib/terminal/workspace";
import { isValidLots } from "@/lib/trade/webTrade";
import { formatLots, parseDecimal } from "@/lib/trade/webTradeFormat";
import { CommitField, LABEL_CLASS, ToggleRow } from "./ui";

/**
 * The person's own trade rules. They are checked in the panel before an order is sent and are
 * saved with the terminal layout (per user, not per account). The platform's own gates
 * (subscription, execution switch, risk rules) are enforced by the server whatever is set here.
 */

const MODE_LABEL: Record<WsaTradeLevelMode, string> = { price: "Prices", points: "Points" };

export interface TradeSettingsProps {
  settings: WsaTradeWorkspace;
  onChange: (patch: WsaTradePatch) => void;
}

/** "" -> null (switched off), a whole number of points -> that number, anything else -> false (refused). */
function parsePointsSetting(text: string): number | null | false {
  if (text.trim() === "") return null;
  const parsed = parseDecimal(text);
  if (parsed === null || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WSA_TRADE_LEVEL_POINTS) return false;
  return parsed;
}

export function TradeSettings({ settings, onChange }: TradeSettingsProps) {
  const id = useId();
  return (
    <div className="space-y-4 rounded-[4px] border border-line bg-background p-3" aria-label="Trade settings">
      <ToggleRow
        id={`${id}-confirm`}
        label="Ask before an order is sent"
        hint="Off: one click on Buy / Sell, Close or Delete acts at once."
        checked={settings.confirm}
        onChange={(confirm) => onChange({ confirm })}
      />

      <div>
        <span className={LABEL_CLASS} id={`${id}-mode`}>
          Stop loss and take profit are typed as
        </span>
        <div role="group" aria-labelledby={`${id}-mode`} className="flex gap-2">
          {WSA_TRADE_LEVEL_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={settings.levelMode === mode}
              onClick={() => onChange({ levelMode: mode })}
              className={`btn-dark text-xs ${settings.levelMode === mode ? "btn-active" : ""}`}
            >
              {MODE_LABEL[mode]}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] leading-snug text-muted">
          Points are the smallest price step of the symbol (for a 5-digit pair, 10 points = 1 pip) counted from the entry price.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <CommitField
          id={`${id}-dsl`}
          label="Default stop loss (points)"
          inputMode="numeric"
          placeholder="none"
          value={settings.stopLossPoints === null ? "" : String(settings.stopLossPoints)}
          onCommit={(text) => {
            const parsed = parsePointsSetting(text);
            if (parsed === false) return false;
            if (parsed !== settings.stopLossPoints) onChange({ stopLossPoints: parsed });
          }}
        />
        <CommitField
          id={`${id}-dtp`}
          label="Default take profit (points)"
          inputMode="numeric"
          placeholder="none"
          value={settings.takeProfitPoints === null ? "" : String(settings.takeProfitPoints)}
          onCommit={(text) => {
            const parsed = parsePointsSetting(text);
            if (parsed === false) return false;
            if (parsed !== settings.takeProfitPoints) onChange({ takeProfitPoints: parsed });
          }}
        />
      </div>
      <p className="-mt-2 text-[11px] leading-snug text-muted">
        A default is used for an order whose stop loss / take profit box is left empty.
      </p>

      <ToggleRow
        id={`${id}-require-sl`}
        label="Every new order needs a stop loss"
        hint="An order without one is refused here, before it is sent."
        checked={settings.requireStopLoss}
        onChange={(requireStopLoss) => onChange({ requireStopLoss })}
      />

      <CommitField
        id={`${id}-max`}
        label="Largest volume per order (lots)"
        placeholder="no limit"
        value={settings.maxVolume === null ? "" : formatLots(settings.maxVolume)}
        onCommit={(text) => {
          if (text.trim() === "") {
            if (settings.maxVolume !== null) onChange({ maxVolume: null });
            return;
          }
          const parsed = parseDecimal(text);
          if (parsed === null || !isValidLots(parsed)) return false;
          if (parsed !== settings.maxVolume) onChange({ maxVolume: parsed });
        }}
      />

      <p className="text-[11px] leading-relaxed text-muted">
        These rules are yours: they stop a hasty order in this panel. The platform&apos;s subscription, execution and risk
        checks apply on top, and the broker&apos;s own limits (minimum distance, volume step) have the last word.
      </p>
    </div>
  );
}
