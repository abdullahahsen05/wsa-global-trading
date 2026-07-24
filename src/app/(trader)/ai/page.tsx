"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Send, Sparkles, Trash2 } from "lucide-react";
import {
  EmptyState,
  GhostButton,
  InlineStatusStrip,
  Panel,
  PageActionGroup,
  PrimaryButton,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { SelectField } from "@/components/app/FormFields";
import { queryKeys } from "@/lib/data/queryKeys";
import type { TraderAccountSummary } from "@/lib/domain/types";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";
import { formatMoney, formatPercent } from "@/lib/utils/format";

const SUGGESTED_PROMPTS = [
  "Analyze my current account risk.",
  "Summarize my trading performance.",
  "What pairs am I overexposed on?",
  "Explain my recent drawdown.",
  "What should I watch before today's session?",
];

// Persist chat in the browser, keyed by user id, so it survives refresh and
// navigation without leaking to a different user on a shared browser.
const CHAT_STORAGE_PREFIX = "aurix-ai-chat:";
const MAX_PERSISTED_MESSAGES = 50;

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };

function uid() {
  return Math.random().toString(36).slice(2);
}

export default function AiAssistantPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage eyebrow="Assistant" title="WSA Assistant" description="Loading your platform access status.">
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (access.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Assistant"
        title="WSA Assistant"
        description="Activate your platform subscription to unlock the AI trading assistant."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock the AI trading assistant, account-aware prompts, and chart analysis workflows."
        />
      </WorkspacePage>
    );
  }

  return <AiAssistantContent />;
}

function AiAssistantContent() {
  // ── Account context (for the selector + context cards) ─────────────────────
  const { data: accounts = [] } = useQuery<TraderAccountSummary[]>({
    queryKey: queryKeys.accounts,
    queryFn: async () => {
      const res = await fetch("/api/trading-accounts");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load accounts");
      return json.data;
    },
  });

  const [accountId, setAccountId] = useState<string>("");
  const selectedAccount = useMemo(
    () => accounts.find((a) => a.accountId === accountId) ?? null,
    [accounts, accountId],
  );

  // ── Chat state ─────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  // ── Persisted chat (per-user, browser localStorage) ─────────────────────────
  const [userId, setUserId] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  // Resolve the logged-in user, then restore their saved conversation.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/session");
        const json = await res.json();
        const id: string | null = json?.ok ? json.data.id : null;
        if (!active) return;
        setUserId(id);
        if (id) {
          const raw = localStorage.getItem(CHAT_STORAGE_PREFIX + id);
          if (raw) {
            const saved = JSON.parse(raw) as { messages?: ChatMessage[]; accountId?: string };
            if (Array.isArray(saved.messages)) setMessages(saved.messages);
            if (typeof saved.accountId === "string") setAccountId(saved.accountId);
          }
        }
      } catch {
        // ignore — fall back to an empty session
      } finally {
        if (active) hydratedRef.current = true;
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Persist on change (only after the initial restore, so we don't clobber it).
  useEffect(() => {
    if (!hydratedRef.current || !userId) return;
    try {
      localStorage.setItem(
        CHAT_STORAGE_PREFIX + userId,
        JSON.stringify({ messages: messages.slice(-MAX_PERSISTED_MESSAGES), accountId }),
      );
    } catch {
      // storage full / unavailable — non-fatal
    }
  }, [messages, accountId, userId]);

  function clearChat() {
    setMessages([]);
    setChatError(null);
    if (userId) {
      try {
        localStorage.removeItem(CHAT_STORAGE_PREFIX + userId);
      } catch {
        // ignore
      }
    }
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    setChatError(null);
    setInput("");
    const userMsg: ChatMessage = { id: uid(), role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setIsSending(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          pageContext: "ai-assistant",
          accountId: accountId || undefined,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setChatError(json.error?.message ?? "We couldn't get a response. Try again later.");
        return;
      }
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: json.data.message }]);
      if (typeof json.data.usage?.requestsRemainingToday === "number") {
        setRemaining(json.data.usage.requestsRemainingToday);
      }
    } catch {
      setChatError("Network error. Please check your connection and try again.");
    } finally {
      setIsSending(false);
    }
  }

  const { data: creditsData } = useQuery<{ credits: number }>({
    queryKey: ["ai-credits"],
    queryFn: async () => {
      const res = await fetch("/api/ai/credits");
      const json = await res.json();
      if (!json.ok) throw new Error("credits unavailable");
      return json.data;
    },
    staleTime: 60_000,
  });

  return (
    <WorkspacePage
      eyebrow="Assistant"
      title="WSA Assistant"
      description="Your built-in trading copilot. Ask about your account risk, performance, exposure, and upcoming news — grounded in your live WSA Global data."
      action={
        <PageActionGroup>
          <div className="min-w-[220px]">
            <SelectField
              label="Account context"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">All my accounts</option>
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.accountName} — {a.brokerName}
                </option>
              ))}
            </SelectField>
          </div>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          {
            label: "Account in context",
            value: selectedAccount ? selectedAccount.accountName : "All accounts",
            tone: "accent",
          },
          {
            label: "Account status",
            value: selectedAccount ? selectedAccount.status : `${accounts.length} connected`,
          },
          {
            label: "Chats left today",
            value: remaining === null ? "—" : remaining,
            tone: "lime",
          },
          {
            label: "Token credits",
            value: creditsData ? creditsData.credits.toLocaleString() : "—",
            tone: creditsData && creditsData.credits < 5000 ? "danger" : "lime",
          },
        ]}
      />

      <div className="mt-5 grid items-stretch gap-4 xl:h-[min(720px,calc(100vh-250px))] xl:min-h-[560px] xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.7fr)]">
        <Panel className="flex min-h-[520px] min-w-0 flex-col xl:h-full xl:min-h-0">
          <div className="flex items-center justify-between gap-2 border-b border-line pb-4">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-[4px] bg-accent/10 text-accent">
                <Sparkles className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">WSA Assistant</p>
                <p className="text-xs text-muted">Professional Forex &amp; prop-risk copilot</p>
              </div>
            </div>
            {messages.length > 0 ? (
              <GhostButton type="button" onClick={clearChat} disabled={isSending}>
                <Trash2 className="mr-2 inline-block h-4 w-4" />
                Clear
              </GhostButton>
            ) : null}
          </div>

          <div className="invisible-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
            {messages.length === 0 ? (
              <div className="py-2">
                <EmptyState
                  title="Ask your first question"
                  description="The assistant reads your live WSA Global account data to answer. Try one of these:"
                />
                <div className="mt-5 grid gap-2 md:grid-cols-2">
                  {SUGGESTED_PROMPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => sendMessage(p)}
                      className="btn-dark justify-start text-left"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
                >
                  <div
                    className={
                      m.role === "user"
                        ? "max-w-[85%] rounded-[4px] rounded-br-sm border border-accent/30 bg-accent/10 px-4 py-3 text-sm leading-6 text-foreground"
                        : "max-w-[85%] whitespace-pre-wrap rounded-[4px] rounded-bl-sm border border-line bg-background px-4 py-3 text-sm leading-6 text-foreground/90"
                    }
                  >
                    {m.content}
                  </div>
                </div>
              ))
            )}
            {isSending ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Thinking…
              </div>
            ) : null}
          </div>

          {chatError ? (
            <div className="mb-3 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
              {chatError}
            </div>
          ) : null}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
            className="flex items-end gap-2 border-t border-line pt-4"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage(input);
                }
              }}
              placeholder="Ask about your risk, performance, exposure, or upcoming news…"
              rows={2}
              maxLength={4000}
              className="min-h-[52px] w-full resize-none rounded-[4px] border border-line bg-background px-4 py-3 text-sm text-foreground outline-none transition placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/10"
            />
            <PrimaryButton type="submit" disabled={isSending || input.trim().length === 0}>
              <Send className="mr-2 inline-block h-4 w-4" />
              Send
            </PrimaryButton>
          </form>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            Educational analysis only — not financial advice. The assistant never guarantees profits.
          </p>
        </Panel>
        <Panel className="flex min-h-0 flex-col xl:h-full">
          <div className="shrink-0 border-b border-line pb-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Analysis context</p>
            <h2 className="mt-2 text-lg font-semibold text-foreground">Grounding and limits</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              The assistant uses this account scope and current platform allowance for every response.
            </p>
          </div>
          <div className="invisible-scrollbar min-h-0 flex-1 overflow-y-auto py-4">
            <dl className="overflow-hidden rounded-[4px] border border-line bg-background">
              {[
                ["Scope", selectedAccount?.accountName ?? "All connected accounts"],
                ["Broker", selectedAccount?.brokerName ?? `${accounts.length} accounts available`],
                ["Connection", selectedAccount?.status ?? "Mixed account scope"],
                ["Platform", selectedAccount?.platform ?? "MT4 / MT5"],
                ["Open trades", selectedAccount ? selectedAccount.openTradeCount.toString() : "Across all accounts"],
                ["Drawdown", selectedAccount ? formatPercent(selectedAccount.drawdownPercent) : "Account dependent"],
                ["Equity", selectedAccount ? formatMoney(selectedAccount.equity) : "Combined context"],
              ].map(([label, value]) => (
                <div key={label} className="grid grid-cols-[108px_minmax(0,1fr)] border-b border-line px-4 py-3 last:border-b-0">
                  <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">{label}</dt>
                  <dd className="min-w-0 text-right text-sm font-medium text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 border-t border-line pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Response boundaries</p>
              <ul className="mt-3 space-y-3 text-sm leading-5 text-muted">
                <li className="border-l-2 border-accent/50 pl-3">Account data is used only for the selected context.</li>
                <li className="border-l-2 border-line-strong pl-3">Analysis is educational and does not execute trades.</li>
                <li className="border-l-2 border-line-strong pl-3">Usage and token allowances remain visible in the summary rail.</li>
              </ul>
            </div>
          </div>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
