"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { TradeDto } from "@/lib/domain/types";
import { formatMoney } from "@/lib/utils/format";
import { Panel, StatusPill } from "@/components/app/WorkspaceUI";

type CalendarMode = "MONTH" | "YEAR";

type DaySummary = {
  profit: number;
  tradeCount: number;
  wins: number;
  losses: number;
};

type CalendarCell = {
  key: string;
  date: Date;
  day: number;
  inMonth: boolean;
  summary?: DaySummary;
};

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function compactMoney(amount: number) {
  const absolute = Math.abs(amount);
  const formatted =
    absolute >= 1000
      ? `${(absolute / 1000).toFixed(absolute >= 10000 ? 1 : 2)}k`
      : formatMoney({ amount: absolute, currency: "USD" });

  return amount < 0 ? `-${formatted}` : formatted;
}

function buildDaySummaryMap(trades: TradeDto[]) {
  const summaries = new Map<string, DaySummary>();

  for (const trade of trades) {
    if (trade.status !== "CLOSED") continue;
    const tradeDate = new Date(trade.closedAt ?? trade.openedAt);
    const key = dateKey(tradeDate);
    const current = summaries.get(key) ?? {
      profit: 0,
      tradeCount: 0,
      wins: 0,
      losses: 0,
    };

    current.profit += trade.profit.amount;
    current.tradeCount += 1;
    if (trade.profit.amount > 0) current.wins += 1;
    if (trade.profit.amount < 0) current.losses += 1;

    summaries.set(key, current);
  }

  return summaries;
}

function buildMonthCells(year: number, month: number, daySummaryMap: Map<string, DaySummary>) {
  const firstOfMonth = new Date(year, month, 1);
  const leadingDays = (firstOfMonth.getDay() + 6) % 7;
  const totalDays = new Date(year, month + 1, 0).getDate();
  const cells: CalendarCell[] = [];

  for (let index = 0; index < 42; index += 1) {
    const dayOffset = index - leadingDays + 1;
    const date = new Date(year, month, dayOffset);
    const inMonth = date.getMonth() === month;
    const summary = inMonth ? daySummaryMap.get(dateKey(date)) : undefined;

    cells.push({
      key: dateKey(date),
      date,
      day: date.getDate(),
      inMonth: inMonth && dayOffset >= 1 && dayOffset <= totalDays,
      summary,
    });
  }

  return cells;
}

function aggregateByMonth(trades: TradeDto[], year: number) {
  const summaries = new Map<number, DaySummary>();

  for (const trade of trades) {
    if (trade.status !== "CLOSED") continue;
    const tradeDate = new Date(trade.closedAt ?? trade.openedAt);
    if (tradeDate.getFullYear() !== year) continue;

    const month = tradeDate.getMonth();
    const current = summaries.get(month) ?? {
      profit: 0,
      tradeCount: 0,
      wins: 0,
      losses: 0,
    };

    current.profit += trade.profit.amount;
    current.tradeCount += 1;
    if (trade.profit.amount > 0) current.wins += 1;
    if (trade.profit.amount < 0) current.losses += 1;

    summaries.set(month, current);
  }

  return summaries;
}

function percent(value: number) {
  return `${value.toFixed(1)}%`;
}

export function CalendarTracker({ trades }: { trades: TradeDto[] }) {
  const closedTrades = useMemo(
    () => trades.filter((trade) => trade.status === "CLOSED"),
    [trades],
  );

  const defaultFocusDate = useMemo(() => {
    const latestTrade = closedTrades
      .map((trade) => new Date(trade.closedAt ?? trade.openedAt))
      .sort((left, right) => right.getTime() - left.getTime())[0];
    return latestTrade ?? new Date();
  }, [closedTrades]);

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    for (const trade of closedTrades) {
      const date = new Date(trade.closedAt ?? trade.openedAt);
      years.add(date.getFullYear());
    }
    years.add(defaultFocusDate.getFullYear() - 1);
    years.add(defaultFocusDate.getFullYear());
    years.add(defaultFocusDate.getFullYear() + 1);
    return Array.from(years).sort((left, right) => left - right);
  }, [closedTrades, defaultFocusDate]);

  const [mode, setMode] = useState<CalendarMode>("MONTH");
  const [selectedMonth, setSelectedMonth] = useState(defaultFocusDate.getMonth());
  const [selectedYear, setSelectedYear] = useState(defaultFocusDate.getFullYear());
  const [shareStatus, setShareStatus] = useState<"idle" | "copied">("idle");

  const daySummaryMap = useMemo(() => buildDaySummaryMap(closedTrades), [closedTrades]);
  const initialSelectedDayKey = useMemo(() => {
    const initialCells = buildMonthCells(
      defaultFocusDate.getFullYear(),
      defaultFocusDate.getMonth(),
      daySummaryMap,
    );

    return (
      initialCells.find((cell) => cell.summary)?.key ??
      initialCells.find((cell) => cell.inMonth)?.key ??
      initialCells[0]?.key ??
      null
    );
  }, [daySummaryMap, defaultFocusDate]);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(initialSelectedDayKey);
  const monthCells = useMemo(
    () => buildMonthCells(selectedYear, selectedMonth, daySummaryMap),
    [daySummaryMap, selectedMonth, selectedYear],
  );
  const yearSummaryMap = useMemo(
    () => aggregateByMonth(closedTrades, selectedYear),
    [closedTrades, selectedYear],
  );

  const selectedDay = useMemo(
    () => monthCells.find((cell) => cell.key === selectedDayKey) ?? null,
    [monthCells, selectedDayKey],
  );

  const monthSummary = useMemo(() => {
    const monthTrades = closedTrades.filter((trade) => {
      const tradeDate = new Date(trade.closedAt ?? trade.openedAt);
      return (
        tradeDate.getFullYear() === selectedYear && tradeDate.getMonth() === selectedMonth
      );
    });

    const winners = monthTrades.filter((trade) => trade.profit.amount > 0).length;
    const totalProfit = monthTrades.reduce((total, trade) => total + trade.profit.amount, 0);

    return {
      tradeCount: monthTrades.length,
      totalProfit,
      winRate: monthTrades.length === 0 ? 0 : (winners / monthTrades.length) * 100,
    };
  }, [closedTrades, selectedMonth, selectedYear]);

  useEffect(() => {
    if (shareStatus !== "copied") return undefined;
    const timer = window.setTimeout(() => setShareStatus("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [shareStatus]);

  async function handleShare() {
    const focusLabel =
      mode === "MONTH"
        ? `${monthNames[selectedMonth]} ${selectedYear}`
        : `${selectedYear}`;
    const text =
      mode === "MONTH"
        ? `${focusLabel}: ${compactMoney(monthSummary.totalProfit)} profit, ${monthSummary.tradeCount} trades, ${percent(
            monthSummary.winRate,
          )} win rate`
        : `${focusLabel} overview: ${closedTrades.length} closed trades across ${monthSummaryMapSize(
            yearSummaryMap,
          )} active months`;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setShareStatus("copied");
    } catch {
      setShareStatus("copied");
    }
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
            Calendar tracker
          </p>
          <h2 className="mt-2 text-lg font-semibold text-foreground">Trade calendar</h2>
          <p className="mt-1 text-sm text-muted">
            Month and year review for closed trades, daily profit, and selected period summaries.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone="muted">{shareStatus === "copied" ? "Copied" : "Mock data"}</StatusPill>
          <StatusPill tone="lime">{mode === "MONTH" ? "Month view" : "Year view"}</StatusPill>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-[4px] border border-line bg-background p-1">
          {(["MONTH", "YEAR"] as CalendarMode[]).map((value) => {
            const active = mode === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`rounded-[4px] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] transition ${
                  active
                    ? "bg-panel-strong text-accent"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {value === "MONTH" ? "Month" : "Year"}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleShare}
            className="h-11 rounded-[4px] border border-line bg-panel px-4 text-sm font-semibold text-foreground transition hover:border-accent/40 hover:text-accent"
          >
            Share
          </button>
          <select
            value={selectedMonth}
            onChange={(event) => {
              const nextMonth = Number(event.target.value);
              setSelectedMonth(nextMonth);
              setMode("MONTH");
              const nextCells = buildMonthCells(selectedYear, nextMonth, daySummaryMap);
              setSelectedDayKey(
                nextCells.find((cell) => cell.summary)?.key ??
                  nextCells.find((cell) => cell.inMonth)?.key ??
                  nextCells[0]?.key ??
                  null,
              );
            }}
            className="h-11 rounded-[4px] border border-line bg-background px-4 text-sm font-semibold text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
          >
            {monthNames.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={selectedYear}
            onChange={(event) => {
              const nextYear = Number(event.target.value);
              setSelectedYear(nextYear);
              setMode("MONTH");
              const nextCells = buildMonthCells(nextYear, selectedMonth, daySummaryMap);
              setSelectedDayKey(
                nextCells.find((cell) => cell.summary)?.key ??
                  nextCells.find((cell) => cell.inMonth)?.key ??
                  nextCells[0]?.key ??
                  null,
              );
            }}
            className="h-11 rounded-[4px] border border-line bg-background px-4 text-sm font-semibold text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"
          >
            {availableYears.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </div>
      </div>

      {mode === "MONTH" ? (
        <>
          <div className="mt-5 grid grid-cols-7 gap-2">
            {weekdayLabels.map((label) => (
              <div
                key={label}
                className="rounded-[4px] border border-line bg-background py-2 text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-muted"
              >
                {label}
              </div>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-7 gap-2">
            {monthCells.map((cell) => {
              const summary = cell.summary;
              const selected = cell.key === selectedDayKey;
              const hasProfit = summary ? summary.profit >= 0 : false;
              const amountClass = summary
                ? hasProfit
                  ? "text-accent"
                  : "text-danger"
                : "text-foreground";

              return (
                <motion.button
                  key={cell.key}
                  type="button"
                  onClick={() => {
                    if (!cell.inMonth) {
                      setSelectedMonth(cell.date.getMonth());
                      setSelectedYear(cell.date.getFullYear());
                    }
                    setSelectedDayKey(cell.key);
                  }}
                  className={`relative flex min-h-[122px] flex-col rounded-[4px] border p-3 text-left transition ${
                    cell.inMonth
                      ? "border-line bg-background"
                      : "border-line/70 bg-panel/70 text-muted/70"
                  } ${
                    summary
                      ? hasProfit
                        ? "border-[#2e2817] bg-[#151106]"
                        : "border-[#2a1f1a] bg-[#17110f]"
                      : ""
                  } ${selected ? "ring-1 ring-accent/40" : ""}`}
                >
                  <span
                    className={`self-end text-[11px] font-semibold ${
                      cell.inMonth ? "text-muted" : "text-muted/50"
                    }`}
                  >
                    {cell.day}
                  </span>
                  <div className="mt-auto grid gap-1">
                    {summary ? (
                      <>
                        <p className={`text-lg font-semibold ${amountClass}`}>
                          {compactMoney(summary.profit)}
                        </p>
                        <p className="text-xs font-medium text-muted">
                          {summary.tradeCount} trade{summary.tradeCount === 1 ? "" : "s"}
                        </p>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                          {percent((summary.wins / Math.max(summary.tradeCount, 1)) * 100)} win rate
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-muted/60">No closed trades</p>
                    )}
                  </div>
                </motion.button>
              );
            })}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[0.58fr_0.42fr]">
            <div className="rounded-[4px] border border-line bg-background p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
                Selected day
              </p>
              <p className="mt-2 text-lg font-semibold text-foreground">
                {selectedDay ? selectedDay.date.toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                }) : "No day selected"}
              </p>
              {selectedDay?.summary ? (
                <p className="mt-2 text-sm text-muted">
                  {selectedDay.summary.tradeCount} trades, {compactMoney(selectedDay.summary.profit)} net,
                  {` `}{percent((selectedDay.summary.wins / Math.max(selectedDay.summary.tradeCount, 1)) * 100)} win rate
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted">Pick a highlighted day to inspect the closed trades.</p>
              )}
            </div>
            <div className="rounded-[4px] border border-line bg-background p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
                Month summary
              </p>
              <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-muted">Closed trades</p>
                  <p className="mt-1 text-lg font-semibold text-foreground">{monthSummary.tradeCount}</p>
                </div>
                <div>
                  <p className="text-muted">Profit</p>
                  <p
                    className={`mt-1 text-lg font-semibold ${
                      monthSummary.totalProfit >= 0 ? "text-accent" : "text-danger"
                    }`}
                  >
                    {compactMoney(monthSummary.totalProfit)}
                  </p>
                </div>
                <div>
                  <p className="text-muted">Win rate</p>
                  <p className="mt-1 text-lg font-semibold text-foreground">
                    {percent(monthSummary.winRate)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {monthNames.map((monthName, monthIndex) => {
              const summary = yearSummaryMap.get(monthIndex);
              const selected = monthIndex === selectedMonth;
              const profit = summary?.profit ?? 0;
              const tradeCount = summary?.tradeCount ?? 0;
              const winRate = tradeCount === 0 ? 0 : ((summary?.wins ?? 0) / tradeCount) * 100;

              return (
                <motion.button
                  key={monthName}
                  type="button"
                  onClick={() => {
                    const nextCells = buildMonthCells(selectedYear, monthIndex, daySummaryMap);
                    setSelectedMonth(monthIndex);
                    setMode("MONTH");
                    setSelectedDayKey(
                      nextCells.find((cell) => cell.summary)?.key ??
                        nextCells.find((cell) => cell.inMonth)?.key ??
                        nextCells[0]?.key ??
                        null,
                    );
                  }}
                  className={`rounded-[4px] border p-4 text-left transition ${
                    selected
                      ? "border-accent/40 bg-[#141106]"
                      : "border-line bg-background hover:border-accent/25"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground">{monthName}</p>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                      {tradeCount} trade{tradeCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className={`mt-4 text-2xl font-semibold ${profit >= 0 ? "text-accent" : "text-danger"}`}>
                    {compactMoney(profit)}
                  </p>
                  <div className="mt-3 flex items-center justify-between text-xs font-medium text-muted">
                    <span>{percent(winRate)} win rate</span>
                    <span>{selected ? "Selected" : "Browse"}</span>
                  </div>
                </motion.button>
              );
            })}
          </div>

          <div className="mt-4 rounded-[4px] border border-line bg-background p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
                  Year summary
                </p>
                <p className="mt-2 text-lg font-semibold text-foreground">{selectedYear}</p>
              </div>
              <StatusPill tone="accent">Tap a month to open it</StatusPill>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

function monthSummaryMapSize(map: Map<number, DaySummary>) {
  return Array.from(map.values()).filter((summary) => summary.tradeCount > 0).length;
}
