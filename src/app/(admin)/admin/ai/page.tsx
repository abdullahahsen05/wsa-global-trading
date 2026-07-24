"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ImagePlus, Loader2, Send, X } from "lucide-react";
import {
  EmptyState,
  GhostButton,
  Panel,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { TextField } from "@/components/app/FormFields";
import { queryKeys } from "@/lib/data/queryKeys";
import { AiProviderSettingsPanel } from "@/components/admin/AiProviderSettingsPanel";

interface UsageSummary {
  today: { total: number; chat: number; chartAnalysis: number; failed: number };
  byUserToday: Array<{ userId: string; userName: string; chat: number; chartAnalysis: number }>;
  recent: Array<{
    id: string;
    userName: string;
    route: "chat" | "chart-analysis";
    feature: "ADMIN_ASSISTANT" | "ADMIN_IMAGE_ANALYSIS" | "TRADER_ASSISTANT" | "TRADER_CHART_ASSISTANT";
    model: string;
    status: "SUCCESS" | "FAILED";
    totalTokens: number | null;
    createdAt: string;
  }>;
}

interface AiUser {
  userId: string;
  name: string;
  email: string;
  role: string;
  aiEnabled: boolean;
  chatDailyLimit: number | null;
  chartDailyLimit: number | null;
  effectiveChatLimit: number;
  effectiveChartLimit: number;
  chatUsedToday: number;
  chartUsedToday: number;
  aiTokenCredits: number;
}

export default function AdminAiPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [disableAiUser, setDisableAiUser] = useState<AiUser | null>(null);

  useEffect(() => {
    if (!notice || notice.type !== "success") return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  const [chatLimitInput, setChatLimitInput] = useState("");
  const [chartLimitInput, setChartLimitInput] = useState("");
  const [creditInput, setCreditInput] = useState("");
  const [creditMode, setCreditMode] = useState<"add" | "set">("add");
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [assistantResult, setAssistantResult] = useState("");
  const [assistantError, setAssistantError] = useState("");
  const [assistantLoading, setAssistantLoading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageFocus, setImageFocus] = useState("");
  const [imageResult, setImageResult] = useState("");
  const [imageError, setImageError] = useState("");
  const [imageLoading, setImageLoading] = useState(false);

  const { data: usage, isLoading: usageLoading } = useQuery<UsageSummary>({
    queryKey: queryKeys.adminAiUsage,
    queryFn: async () => {
      const res = await fetch("/api/admin/ai/usage");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load usage");
      return json.data;
    },
  });

  const { data: users = [], isLoading: usersLoading, isError } = useQuery<AiUser[]>({
    queryKey: queryKeys.adminAiUsers,
    queryFn: async () => {
      const res = await fetch("/api/admin/ai/users");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load users");
      return json.data;
    },
  });

  const effectiveSelectedId = selectedId || users[0]?.userId || "";
  const selected = useMemo(
    () => users.find((u) => u.userId === effectiveSelectedId) ?? users[0] ?? null,
    [users, effectiveSelectedId],
  );

  const mutation = useMutation({
    mutationFn: async (payload: {
      userId: string;
      body: { chatDailyLimit?: number | null; chartDailyLimit?: number | null; aiEnabled?: boolean };
    }) => {
      const res = await fetch(`/api/admin/ai/users/${payload.userId}/limits`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload.body),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to update");
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.adminAiUsers });
      queryClient.invalidateQueries({ queryKey: queryKeys.adminAiUsage });
      setNotice({ type: "success", text: "AI settings updated." });
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  function toggleEnabled(u: AiUser) {
    setNotice(null);
    if (u.aiEnabled) {
      setDisableAiUser(u);
    } else {
      mutation.mutate({ userId: u.userId, body: { aiEnabled: true } });
    }
  }

  function saveLimits(u: AiUser) {
    setNotice(null);
    const body: { chatDailyLimit?: number | null; chartDailyLimit?: number | null } = {};
    body.chatDailyLimit = chatLimitInput.trim() === "" ? null : Math.max(0, Number.parseInt(chatLimitInput, 10) || 0);
    body.chartDailyLimit = chartLimitInput.trim() === "" ? null : Math.max(0, Number.parseInt(chartLimitInput, 10) || 0);
    mutation.mutate({ userId: u.userId, body });
  }

  const creditMutation = useMutation({
    mutationFn: async (payload: { userId: string; amount: number; mode: "add" | "set" }) => {
      const res = await fetch(`/api/admin/ai/users/${payload.userId}/credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: payload.amount, mode: payload.mode }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to update credits");
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.adminAiUsers });
      setCreditInput("");
      setNotice({ type: "success", text: "Token credits updated." });
    },
    onError: (err: Error) => setNotice({ type: "error", text: err.message }),
  });

  function saveCredits(u: AiUser) {
    setNotice(null);
    const amount = Math.max(0, Number.parseInt(creditInput, 10) || 0);
    creditMutation.mutate({ userId: u.userId, amount, mode: creditMode });
  }

  function selectUser(u: AiUser) {
    setSelectedId(u.userId);
    setChatLimitInput(u.chatDailyLimit === null ? "" : String(u.chatDailyLimit));
    setChartLimitInput(u.chartDailyLimit === null ? "" : String(u.chartDailyLimit));
    setCreditInput("");
  }

  async function runAdminAssistant() {
    const message = assistantPrompt.trim();
    if (!message || assistantLoading) return;
    setAssistantLoading(true);
    setAssistantError("");
    setAssistantResult("");
    try {
      const response = await fetch("/api/ai/admin-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, pageContext: "admin-ai-controls" }),
      });
      const json = await response.json();
      if (!json.ok) {
        setAssistantError(json.error?.message ?? "Admin assistant is unavailable.");
        return;
      }
      setAssistantResult(json.data.message);
      queryClient.invalidateQueries({ queryKey: queryKeys.adminAiUsage });
    } catch {
      setAssistantError("Network error while contacting the admin assistant.");
    } finally {
      setAssistantLoading(false);
    }
  }

  async function runImageAnalysis() {
    if (!imageFile || imageLoading) return;
    setImageLoading(true);
    setImageError("");
    setImageResult("");
    try {
      const form = new FormData();
      form.append("image", imageFile);
      if (imageFocus.trim()) form.append("prompt", imageFocus.trim());
      const response = await fetch("/api/ai/chart-analysis", { method: "POST", body: form });
      const json = await response.json();
      if (!json.ok) {
        setImageError(json.error?.message ?? "Image analysis is unavailable.");
        return;
      }
      setImageResult(json.data.message);
      queryClient.invalidateQueries({ queryKey: queryKeys.adminAiUsage });
    } catch {
      setImageError("Network error while analyzing the image.");
    } finally {
      setImageLoading(false);
    }
  }


  return (
    <WorkspacePage
      eyebrow="Admin"
      title="AI Controls"
      description="Use admin-only AI tools, monitor metadata-only usage, and manage per-user limits."
    >
      <div className="grid gap-5">
        <AiProviderSettingsPanel />

        <section className="grid items-stretch gap-5 xl:grid-cols-2">
          <Panel className="flex min-h-[380px] min-w-0 flex-col !rounded-[4px] !p-0">
            <header className="shrink-0 border-b border-line px-5 py-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
                Operations assistant
              </p>
              <h2 className="mt-2 text-base font-semibold text-foreground">
                Admin assistant
              </h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted">
                Draft operational guidance without automatically accessing
                platform-wide user data.
              </p>
            </header>

            <div className="flex min-h-0 flex-1 flex-col px-5 py-5">
              <label className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                Request
              </label>
              <textarea
                value={assistantPrompt}
                onChange={(event) => setAssistantPrompt(event.target.value)}
                rows={4}
                maxLength={4000}
                placeholder="Draft a risk-review checklist for a disconnected trader account."
                className="mt-2 min-h-[112px] w-full resize-none rounded-[4px] border border-line bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted/55 focus:border-accent"
              />

              {assistantError ? (
                <div className="mt-3 border-l-2 border-danger bg-danger/5 px-3 py-2 text-sm text-danger">
                  {assistantError}
                </div>
              ) : null}

              {assistantResult ? (
                <div className="invisible-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto border border-line bg-background px-4 py-4 text-sm leading-6 text-foreground/90">
                  <div className="whitespace-pre-wrap">{assistantResult}</div>
                </div>
              ) : (
                <div className="mt-4 flex min-h-[88px] flex-1 items-start border-t border-line pt-4">
                  <p className="max-w-lg text-sm leading-6 text-muted">
                    The response will appear here after the assistant completes
                    the request.
                  </p>
                </div>
              )}
            </div>

            <footer className="shrink-0 border-t border-line px-5 py-4">
              <PrimaryButton
                type="button"
                disabled={
                  assistantLoading || assistantPrompt.trim().length === 0
                }
                onClick={() => void runAdminAssistant()}
                className="!h-10 !min-w-[190px] !rounded-[4px]"
              >
                {assistantLoading ? (
                  <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 inline-block h-4 w-4" />
                )}
                {assistantLoading ? "Thinking…" : "Ask WSA Assistant"}
              </PrimaryButton>
            </footer>
          </Panel>

          <Panel className="flex min-h-[380px] min-w-0 flex-col !rounded-[4px] !p-0">
            <header className="shrink-0 border-b border-line px-5 py-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
                Visual analysis
              </p>
              <h2 className="mt-2 text-base font-semibold text-foreground">
                Admin image analysis
              </h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted">
                Analyze an uploaded image without writing its contents to usage
                logs.
              </p>
            </header>

            <div className="flex min-h-0 flex-1 flex-col px-5 py-5">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => {
                  setImageFile(event.target.files?.[0] ?? null);
                  setImageError("");
                  setImageResult("");
                }}
              />

              <div className="flex min-h-11 flex-wrap items-center gap-3 border border-line bg-background px-3 py-2">
                <GhostButton
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  className="!h-9 !rounded-[4px]"
                >
                  <ImagePlus className="mr-2 inline-block h-4 w-4" />
                  {imageFile ? "Change image" : "Choose image"}
                </GhostButton>
                <span className="min-w-0 flex-1 truncate text-xs text-muted">
                  {imageFile
                    ? imageFile.name
                    : "PNG, JPG, or WebP · max 5MB"}
                </span>
              </div>

              <label className="mt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                Analysis focus
              </label>
              <textarea
                value={imageFocus}
                onChange={(event) => setImageFocus(event.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Optional analysis focus"
                className="mt-2 min-h-[88px] w-full resize-none rounded-[4px] border border-line bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted/55 focus:border-accent"
              />

              {imageError ? (
                <div className="mt-3 border-l-2 border-danger bg-danger/5 px-3 py-2 text-sm text-danger">
                  {imageError}
                </div>
              ) : null}

              {imageResult ? (
                <div className="invisible-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto border border-line bg-background px-4 py-4 text-sm leading-6 text-foreground/90">
                  <div className="whitespace-pre-wrap">{imageResult}</div>
                </div>
              ) : (
                <div className="mt-4 flex min-h-[64px] flex-1 items-start border-t border-line pt-4">
                  <p className="text-sm leading-6 text-muted">
                    Select an image and optionally describe what the analysis
                    should focus on.
                  </p>
                </div>
              )}
            </div>

            <footer className="shrink-0 border-t border-line px-5 py-4">
              <PrimaryButton
                type="button"
                disabled={!imageFile || imageLoading}
                onClick={() => void runImageAnalysis()}
                className="!h-10 !min-w-[170px] !rounded-[4px]"
              >
                {imageLoading ? (
                  <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
                ) : (
                  <ImagePlus className="mr-2 inline-block h-4 w-4" />
                )}
                {imageLoading ? "Analyzing…" : "Analyze image"}
              </PrimaryButton>
            </footer>
          </Panel>
        </section>

        <section className="overflow-hidden rounded-[4px] border border-line bg-panel/55">
          <div className="grid sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                label: "Requests today",
                value: usageLoading ? "…" : usage?.today.total ?? 0,
                tone: "text-accent",
              },
              {
                label: "Chat",
                value: usageLoading ? "…" : usage?.today.chat ?? 0,
                tone: "text-accent-2",
              },
              {
                label: "Chart analyses",
                value: usageLoading
                  ? "…"
                  : usage?.today.chartAnalysis ?? 0,
                tone: "text-accent-2",
              },
              {
                label: "Failed",
                value: usageLoading ? "…" : usage?.today.failed ?? 0,
                tone:
                  (usage?.today.failed ?? 0) > 0
                    ? "text-danger"
                    : "text-foreground",
              },
            ].map((item, index) => (
              <div
                key={item.label}
                className={[
                  "flex min-h-[68px] items-center justify-between gap-4 px-5 py-4",
                  index > 0 ? "border-t border-line sm:border-t-0" : "",
                  index % 2 === 1 ? "sm:border-l sm:border-line" : "",
                  index >= 2 ? "sm:border-t sm:border-line xl:border-t-0" : "",
                  index > 0 ? "xl:border-l xl:border-line" : "",
                ].join(" ")}
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                  {item.label}
                </p>
                <p
                  className={`text-lg font-semibold tabular-nums ${item.tone}`}
                >
                  {item.value}
                </p>
              </div>
            ))}
          </div>
        </section>

        {notice ? (
          <div
            className={`border-l-2 px-4 py-3 text-sm font-medium ${
              notice.type === "success"
                ? "border-accent bg-accent/5 text-accent"
                : "border-danger bg-danger/5 text-danger"
            }`}
          >
            {notice.text}
          </div>
        ) : null}

        <section className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.85fr)]">
          <Panel className="flex min-h-[620px] min-w-0 flex-col !rounded-[4px] !p-0">
            <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
                  Access and allowances
                </p>
                <h2 className="mt-2 text-base font-semibold text-foreground">
                  Trader AI limits
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted">
                  Select a user to manage AI access, daily limits, and token
                  credits.
                </p>
              </div>
              <StatusPill tone="muted">
                {usersLoading ? "Loading" : `${users.length} users`}
              </StatusPill>
            </header>

            <div className="invisible-scrollbar min-h-0 flex-1 overflow-auto">
              {usersLoading ? (
                <div className="space-y-px p-4">
                  {[...Array(5)].map((_, i) => (
                    <div
                      key={i}
                      className="h-14 animate-pulse border border-line bg-background"
                    />
                  ))}
                </div>
              ) : isError ? (
                <div className="m-5 border-l-2 border-danger bg-danger/5 px-4 py-3 text-sm text-danger">
                  Failed to load users.
                </div>
              ) : users.length === 0 ? (
                <div className="px-5 py-8">
                  <EmptyState
                    title="No users"
                    description="No users are available to manage yet."
                  />
                </div>
              ) : (
                <table className="w-full min-w-[760px] table-fixed text-left text-sm">
                  <colgroup>
                    <col className="w-[29%]" />
                    <col className="w-[15%]" />
                    <col className="w-[17%]" />
                    <col className="w-[17%]" />
                    <col className="w-[12%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                  <thead className="sticky top-0 z-10 border-b border-line bg-panel">
                    <tr className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted">
                      <th className="px-5 py-3">User</th>
                      <th className="px-4 py-3">Access</th>
                      <th className="px-4 py-3 text-right">
                        Chat used / limit
                      </th>
                      <th className="px-4 py-3 text-right">
                        Chart used / limit
                      </th>
                      <th className="px-4 py-3 text-right">Credits</th>
                      <th className="px-5 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {users.map((u) => {
                      const active = u.userId === selected?.userId;

                      return (
                        <tr
                          key={u.userId}
                          className={`transition-colors ${
                            active
                              ? "bg-accent/[0.045]"
                              : "hover:bg-background/35"
                          }`}
                        >
                          <td className="relative px-5 py-4">
                            {active ? (
                              <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
                            ) : null}
                            <p className="truncate font-semibold text-foreground">
                              {u.name}
                            </p>
                            <p className="mt-1 truncate text-xs text-muted">
                              {u.email}
                            </p>
                          </td>
                          <td className="px-4 py-4">
                            <StatusPill
                              tone={u.aiEnabled ? "lime" : "danger"}
                            >
                              {u.aiEnabled ? "ENABLED" : "DISABLED"}
                            </StatusPill>
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums text-foreground">
                            {u.chatUsedToday}/{u.effectiveChatLimit}
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums text-foreground">
                            {u.chartUsedToday}/{u.effectiveChartLimit}
                          </td>
                          <td
                            className={`px-4 py-4 text-right font-semibold tabular-nums ${
                              u.aiTokenCredits === 0
                                ? "text-danger"
                                : u.aiTokenCredits < 5000
                                  ? "text-amber-400"
                                  : "text-foreground"
                            }`}
                          >
                            {u.aiTokenCredits.toLocaleString()}
                          </td>
                          <td className="px-5 py-4 text-right">
                            <GhostButton
                              type="button"
                              onClick={() => selectUser(u)}
                              className="!h-9 !rounded-[4px] !px-3"
                            >
                              Manage
                            </GhostButton>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>

          <div className="grid min-h-[620px] min-w-0 grid-rows-[minmax(0,1.35fr)_minmax(180px,0.65fr)] gap-5">
            {selected ? (
              <Panel className="invisible-scrollbar flex min-h-0 flex-col overflow-y-auto !rounded-[4px] !p-0">
                <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
                      Manage user
                    </p>
                    <h3 className="mt-2 truncate text-base font-semibold text-foreground">
                      {selected.name}
                    </h3>
                    <p className="mt-1 truncate text-sm text-muted">
                      {selected.email}
                    </p>
                  </div>
                  <StatusPill
                    tone={selected.aiEnabled ? "lime" : "danger"}
                  >
                    {selected.aiEnabled ? "ENABLED" : "DISABLED"}
                  </StatusPill>
                </header>

                <div className="grid gap-5 px-5 py-5">
                  <section>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                          Access
                        </p>
                        <p className="mt-1 text-sm text-foreground">
                          AI access is currently{" "}
                          {selected.aiEnabled ? "enabled" : "disabled"}.
                        </p>
                      </div>
                      {selected.aiEnabled ? (
                        <GhostButton
                          type="button"
                          disabled={mutation.isPending}
                          onClick={() => toggleEnabled(selected)}
                          className="!h-9 !rounded-[4px]"
                        >
                          Disable AI
                        </GhostButton>
                      ) : (
                        <PrimaryButton
                          type="button"
                          disabled={mutation.isPending}
                          onClick={() => toggleEnabled(selected)}
                          className="!h-9 !rounded-[4px]"
                        >
                          Enable AI
                        </PrimaryButton>
                      )}
                    </div>
                  </section>

                  <section className="border-t border-line pt-5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
                      Daily limits
                    </p>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <TextField
                        label="Chat daily limit"
                        type="number"
                        min={0}
                        placeholder={`Default (${selected.effectiveChatLimit})`}
                        value={chatLimitInput}
                        onChange={(e) => setChatLimitInput(e.target.value)}
                        hint="Blank uses platform default"
                      />
                      <TextField
                        label="Chart daily limit"
                        type="number"
                        min={0}
                        placeholder={`Default (${selected.effectiveChartLimit})`}
                        value={chartLimitInput}
                        onChange={(e) => setChartLimitInput(e.target.value)}
                        hint="Blank uses platform default"
                      />
                    </div>
                    <PrimaryButton
                      type="button"
                      disabled={mutation.isPending}
                      onClick={() => saveLimits(selected)}
                      className="mt-4 !h-9 !rounded-[4px]"
                    >
                      {mutation.isPending ? "Saving…" : "Save limits"}
                    </PrimaryButton>
                  </section>

                  <section className="border-t border-line pt-5">
                    <div className="flex items-end justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
                          Token credits
                        </p>
                        <p className="mt-1 text-sm text-muted">
                          Current balance
                        </p>
                      </div>
                      <p
                        className={`text-lg font-semibold tabular-nums ${
                          selected.aiTokenCredits === 0
                            ? "text-danger"
                            : selected.aiTokenCredits < 5000
                              ? "text-amber-400"
                              : "text-foreground"
                        }`}
                      >
                        {selected.aiTokenCredits.toLocaleString()}
                      </p>
                    </div>

                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <TextField
                        label="Amount"
                        type="number"
                        min={0}
                        placeholder="e.g. 50000"
                        value={creditInput}
                        onChange={(e) => setCreditInput(e.target.value)}
                      />
                      <label className="grid gap-2 text-sm font-semibold text-muted">
                        <span className="text-[10px] uppercase tracking-[0.18em]">
                          Mode
                        </span>
                        <select
                          value={creditMode}
                          onChange={(e) =>
                            setCreditMode(e.target.value as "add" | "set")
                          }
                          className="h-12 w-full rounded-[4px] border border-line bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-accent"
                        >
                          <option value="add">Add</option>
                          <option value="set">Set exact</option>
                        </select>
                      </label>
                    </div>

                    <GhostButton
                      type="button"
                      disabled={
                        creditMutation.isPending || !creditInput.trim()
                      }
                      onClick={() => saveCredits(selected)}
                      className="mt-4 !h-9 !rounded-[4px]"
                    >
                      {creditMutation.isPending
                        ? "Updating…"
                        : "Update credits"}
                    </GhostButton>
                  </section>
                </div>
              </Panel>
            ) : (
              <Panel className="!rounded-[4px]">
                <EmptyState
                  title="Select a user"
                  description="Choose a user from the table to manage AI access and allowances."
                />
              </Panel>
            )}

            <Panel className="flex min-h-0 flex-col !rounded-[4px] !p-0">
              <header className="shrink-0 border-b border-line px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-foreground">
                    Recent activity
                  </h3>
                  <span className="text-xs text-muted">
                    {(usage?.recent ?? []).length} records
                  </span>
                </div>
              </header>
              <div className="invisible-scrollbar min-h-0 flex-1 overflow-y-auto">
                {(usage?.recent ?? []).slice(0, 12).map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-3 border-b border-line px-5 py-3 text-xs last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">
                        {r.userName}
                      </p>
                      <p className="mt-1 truncate text-muted">
                        {r.feature.replaceAll("_", " ")} · {r.model}
                      </p>
                    </div>
                    <StatusPill
                      tone={r.status === "SUCCESS" ? "lime" : "danger"}
                    >
                      {r.status}
                    </StatusPill>
                  </div>
                ))}
                {(usage?.recent ?? []).length === 0 ? (
                  <p className="px-5 py-6 text-sm text-muted">
                    No AI activity recorded yet.
                  </p>
                ) : null}
              </div>
            </Panel>
          </div>
        </section>
      </div>

      <Dialog.Root
        open={Boolean(disableAiUser)}
        onOpenChange={(open) => !open && setDisableAiUser(null)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
          <Dialog.Content className="invisible-scrollbar fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[6px] border border-danger/30 bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
            <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-foreground">
                  <AlertTriangle className="h-5 w-5 text-danger" />
                  Disable AI for {disableAiUser?.name}?
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                  This immediately blocks{" "}
                  <strong className="text-foreground">
                    {disableAiUser?.name}
                  </strong>{" "}
                  from using the AI assistant. Chat history is preserved and
                  access can be restored later.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-[4px] border border-line bg-background text-muted transition-colors hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </header>

            <footer className="flex justify-end gap-3 px-5 py-4">
              <Dialog.Close asChild>
                <GhostButton type="button" className="!h-10 !rounded-[4px]">
                  Cancel
                </GhostButton>
              </Dialog.Close>
              <GhostButton
                type="button"
                disabled={mutation.isPending}
                onClick={() => {
                  if (disableAiUser) {
                    mutation.mutate({
                      userId: disableAiUser.userId,
                      body: { aiEnabled: false },
                    });
                    setDisableAiUser(null);
                  }
                }}
                className="!h-10 !rounded-[4px] !border-danger/40 !text-danger"
              >
                {mutation.isPending ? "Disabling…" : "Yes, disable AI"}
              </GhostButton>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </WorkspacePage>
  );
}
