"use client";

import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DataTable,
  EmptyState,
  GhostButton,
  FilterChipRow,
  Panel,
  PageActionGroup,
  PrimaryButton,
  InlineStatusStrip,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { PlatformSubscriptionLocked } from "@/components/app/PlatformSubscriptionLocked";
import { SearchField, SelectField, TextField } from "@/components/app/FormFields";
import { formatMoney, formatPercent } from "@/lib/utils/format";
import type { TraderAccountSummary } from "@/lib/domain/types";
import { EMPTY_PLATFORM_SUBSCRIPTION_ACCESS, useTraderAccessSummary } from "@/hooks/useTraderAccessSummary";

// Dialog step state machine
type ConnectStep = "setup" | "credentials";
type BrokerPlatform = "MT4" | "MT5";

type BrokerServerOption = {
  id: string;
  serverName: string;
  brokerName?: string;
  source: "MANUAL" | "METAAPI" | "API2TRADE";
};
const CUSTOM_SERVER_OPTION = "__custom__";

function statusTone(status: TraderAccountSummary["status"]) {
  if (status === "CONNECTED") return "lime" as const;
  if (status === "RESTRICTED" || status === "DISCONNECTED" || status === "INACTIVE") {
    return "danger" as const;
  }
  return "accent" as const;
}

function statusLabel(account: TraderAccountSummary) {
  if (account.status === "PENDING") return "NEEDS SETUP";
  if (account.status === "INACTIVE") return "RECONNECT";
  return account.status;
}

function accountActionLabel(account: TraderAccountSummary) {
  if (account.status === "PENDING") return "Complete setup";
  if (account.status === "INACTIVE" || account.status === "DISCONNECTED") return "Reconnect";
  if (account.status === "SYNCING") return "Check connection";
  if (account.status === "RESTRICTED") return "Review account";
  return "View account";
}

export default function AccountsPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage
        eyebrow="Trading accounts"
        title="Broker accounts"
        description="Loading your platform access status."
      >
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      </WorkspacePage>
    );
  }

  if (access.status !== "ACTIVE") {
    return (
      <WorkspacePage
        eyebrow="Trading accounts"
        title="Broker accounts"
        description="Activate your platform subscription to unlock account connection and supervision."
      >
        <PlatformSubscriptionLocked
          access={access}
          description="Activate the WSA Global platform subscription to unlock MT5 account connection, account detail views, and core broker-account workflow tools."
        />
      </WorkspacePage>
    );
  }

  return <AccountsContent />;
}

function AccountsContent() {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [connectOpen, setConnectOpen] = useState(false);
  const [step, setStep] = useState<ConnectStep>("setup");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  // Holds the accountId created in step 1, used in step 2
  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null);
  const [pendingBrokerName, setPendingBrokerName] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState<BrokerPlatform>("MT5");
  const [selectedServerOption, setSelectedServerOption] = useState("");
  const [serverSearchDraft, setServerSearchDraft] = useState("");
  const [serverSearchQuery, setServerSearchQuery] = useState("");
  const queryClient = useQueryClient();

  const { data: tradingAccounts = [], isLoading, isError } = useQuery<TraderAccountSummary[]>({
    queryKey: ["trading-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/trading-accounts");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load accounts");
      return json.data;
    },
  });

  const brokerServersQuery = useQuery<{
    servers: BrokerServerOption[];
    discoveryAvailable: boolean;
    discoveryMessage: string | null;
  }>({
    queryKey: ["broker-server-search", pendingAccountId, selectedPlatform, serverSearchQuery],
    enabled: step === "credentials" && serverSearchQuery.trim().length >= 2,
    queryFn: async () => {
      const res = await fetch(
        `/api/broker-servers/search?platform=${selectedPlatform}&accountId=${encodeURIComponent(
          pendingAccountId ?? "",
        )}&query=${encodeURIComponent(serverSearchQuery || pendingBrokerName)}`,
      );
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load broker servers");
      return json.data;
    },
  });

  useEffect(() => {
    if (step !== "credentials") return undefined;
    const timer = window.setTimeout(() => {
      const nextQuery = serverSearchDraft.trim();
      setServerSearchQuery(nextQuery);
      if (!nextQuery) setSelectedServerOption("");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [serverSearchDraft, step]);

  const filteredAccounts = tradingAccounts.filter((account) => {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery =
      normalizedQuery.length === 0 ||
      [
        account.accountName,
        account.brokerName,
        account.serverName ?? "",
        account.platform ?? "",
        account.status,
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    const matchesStatus =
      statusFilter === "ALL" ||
      (statusFilter === "RECONNECT"
        ? account.status === "INACTIVE" || account.status === "DISCONNECTED"
        : account.status === statusFilter);
    return matchesQuery && matchesStatus;
  });

  const resetDialog = () => {
    setStep("setup");
    setPendingAccountId(null);
    setPendingBrokerName("");
    setSelectedPlatform("MT5");
    setSelectedServerOption("");
    setServerSearchDraft("");
    setServerSearchQuery("");
    setIsSubmitting(false);
    setErrorMessage("");
  };

  // ── Step 1: create the trading account record ─────────────────────────────
  const handleSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage("");

    const form = event.currentTarget;
    const formData = new FormData(form);
    const accountName = (formData.get("accountLabel") as string)?.trim();
    const brokerName = (formData.get("brokerName") as string)?.trim();

    if (!accountName || !brokerName) {
      setErrorMessage("Account label and broker are required.");
      setIsSubmitting(false);
      return;
    }

    try {
      const res = await fetch(
        pendingAccountId ? `/api/trading-accounts/${pendingAccountId}` : "/api/trading-accounts",
        {
        method: pendingAccountId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountName, brokerName }),
        },
      );
      const json = await res.json();
      if (json.ok) {
        setPendingAccountId(pendingAccountId ?? json.data.accountId);
        setPendingBrokerName(brokerName);
        setSelectedServerOption("");
        setServerSearchDraft(brokerName);
        setServerSearchQuery(brokerName);
        setStep("credentials");
        setErrorMessage("");
      } else {
        setErrorMessage(json.error?.message ?? "Failed to create account.");
      }
    } catch {
      setErrorMessage("Network error. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Step 2: encrypt and submit broker credentials ─────────────────────────
  const handleCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pendingAccountId) return;
    setIsSubmitting(true);
    setErrorMessage("");

    const form = event.currentTarget;
    const formData = new FormData(form);
    const login = (formData.get("login") as string)?.trim();
    const password = formData.get("password") as string;
    const serverSelection = (formData.get("serverSelection") as string)?.trim();
    const customServer = (formData.get("customServer") as string)?.trim();
    const server = serverSelection === CUSTOM_SERVER_OPTION
      ? customServer
      : serverSelection;
    const platform = selectedPlatform;

    if (!login || !password || !server || !platform) {
      setErrorMessage("Account login, trading password, server, and platform are all required.");
      setIsSubmitting(false);
      return;
    }

    try {
      const res = await fetch(
        `/api/trading-accounts/${pendingAccountId}/broker-credentials`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            login,
            password,
            server,
            platform,
            brokerName: pendingBrokerName || undefined,
            useCustomBrokerServer: true,
            connectNow: true,
          }),
        }
      );

      const json = await res.json();

      // Clear the password from the form immediately — do not keep it in DOM
      form.reset();

      if (json.ok && json.data.connected) {
        await queryClient.invalidateQueries({ queryKey: ["trading-accounts"] });
        setConnectOpen(false);
        resetDialog();
        setSuccessMessage(
          `Account connected. Credentials were stored securely and the initial broker sync completed.`,
        );
      } else if (json.ok && json.data.status === "PENDING") {
        await queryClient.invalidateQueries({ queryKey: ["trading-accounts"] });
        setConnectOpen(false);
        resetDialog();
        setSuccessMessage(
          json.data.message ??
            "Credentials were stored securely. The broker connection is still deploying; sync it again shortly.",
        );
      } else if (json.ok) {
        setErrorMessage(
          json.data.message ??
            "Credentials were stored, but the broker connection could not be established. Check the values and try again.",
        );
      } else {
        // If credential storage fails, the account was already created.
        // Show a clear error so the trader knows they need to re-submit credentials.
        setErrorMessage(
          json.error?.message ??
            "Credentials could not be stored. Your account was created (PENDING) " +
              "but needs credentials. Try again from the account detail page."
        );
      }
    } catch {
      form.reset();
      setErrorMessage("Network error while storing credentials. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Skip credentials step ─────────────────────────────────────────────────
  const handleSkipCredentials = async () => {
    await queryClient.invalidateQueries({ queryKey: ["trading-accounts"] });
    setConnectOpen(false);
    resetDialog();
    setSuccessMessage(
      `Account created (PENDING). Add broker credentials later from the account detail page.`
    );
  };

  const connectedCount = tradingAccounts.filter((a) => a.status === "CONNECTED" && a.live !== false).length;
  const syncingCount = tradingAccounts.filter((a) => a.status === "SYNCING").length;
  const pendingCount = tradingAccounts.filter((a) => a.status === "PENDING").length;
  const reconnectCount = tradingAccounts.filter((a) => a.status === "INACTIVE" || a.status === "DISCONNECTED").length;
  const liveAccounts = tradingAccounts.filter((a) => a.status === "CONNECTED" && a.live !== false);
  const totalPnl = liveAccounts.reduce((sum, a) => sum + a.floatingPnl.amount, 0);

  return (
    <WorkspacePage
      eyebrow="Trading accounts"
      title="Broker accounts"
      description="Connect, search, monitor, and reconnect every broker account from one operational directory."
      action={
        <PageActionGroup>
          <Dialog.Root
            open={connectOpen}
            onOpenChange={(open) => {
              setConnectOpen(open);
              if (!open) {
                if (pendingAccountId) {
                  void queryClient.invalidateQueries({ queryKey: ["trading-accounts"] });
                }
                resetDialog();
              }
            }}
          >
            <Dialog.Trigger asChild>
              <PrimaryButton type="button">
                <Plus className="mr-2 inline-block h-4 w-4" />
                Connect account
              </PrimaryButton>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
              <Dialog.Content className="invisible-scrollbar fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[6px] border border-line bg-panel p-4 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none sm:p-6">

                {/* Step indicator */}
                <div className="mb-5 flex items-center gap-3">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                      step === "setup" ? "bg-accent text-background" : "bg-accent-2 text-background"
                    }`}
                  >
                    1
                  </span>
                  <span className="text-xs font-semibold text-muted">Account setup</span>
                  <span className="text-muted">→</span>
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                      step === "credentials" ? "bg-accent text-background" : "bg-line text-muted"
                    }`}
                  >
                    2
                  </span>
                  <span className="text-xs font-semibold text-muted">Broker credentials</span>
                </div>

                {/* ── STEP 1: Account setup ─────────────────────────────── */}
                {step === "setup" && (
                  <>
                    <Dialog.Title className="text-xl font-semibold text-foreground">
                      Connect broker account
                    </Dialog.Title>
                    <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                      Name your account, enter your broker name, and then connect the trading
                      credentials. We will try to load matching servers automatically.
                    </Dialog.Description>

                    {errorMessage ? (
                      <div className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
                        {errorMessage}
                      </div>
                    ) : null}

                    <form className="mt-6 grid gap-4" onSubmit={handleSetup}>
                      <div className="grid gap-4 md:grid-cols-2">
                        <SelectField
                          label="Platform"
                          name="platform"
                          value={selectedPlatform}
                          onChange={(event) => {
                            setSelectedPlatform(event.target.value as BrokerPlatform);
                          }}
                        >
                          <option value="MT5">MT5 (MetaTrader 5)</option>
                          <option value="MT4">MT4 (MetaTrader 4)</option>
                        </SelectField>
                        <TextField
                          label="Account label"
                          name="accountLabel"
                          placeholder="e.g. Evaluation Phase 1"
                          required
                        />
                        <TextField
                          label="Broker name"
                          name="brokerName"
                          placeholder="e.g. IC Markets, Vantage Markets, Exness"
                          required
                        />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                        <p className="text-sm text-muted">
                          Account starts as PENDING until credentials are verified.
                        </p>
                        <div className="flex gap-3">
                          <Dialog.Close asChild>
                            <GhostButton type="button">Cancel</GhostButton>
                          </Dialog.Close>
                          <PrimaryButton type="submit" disabled={isSubmitting}>
                            {isSubmitting ? "Creating…" : "Next — add credentials"}
                          </PrimaryButton>
                        </div>
                      </div>
                    </form>
                  </>
                )}

                {/* ── STEP 2: Broker credentials ───────────────────────── */}
                {step === "credentials" && (
                  <>
                    <Dialog.Title className="text-xl font-semibold text-foreground">
                      Trading account credentials
                    </Dialog.Title>
                    <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                      Enter the exact trading account login and main trading password. Once the
                      broker name is entered, matching servers can be loaded for you.
                    </div>

                    {errorMessage ? (
                      <div className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
                        {errorMessage}
                      </div>
                    ) : null}

                    <form className="mt-4 grid gap-4" onSubmit={handleCredentials}>
                      <div className="grid gap-3 rounded-[4px] border border-line bg-background p-4 md:grid-cols-[1fr_auto] md:items-end">
                        <TextField
                          label="Find broker server"
                          value={serverSearchDraft}
                          onChange={(event) => setServerSearchDraft(event.target.value)}
                          placeholder="Broker name or exact server name"
                          autoComplete="off"
                        />
                        <GhostButton
                          type="button"
                          onClick={() => {
                            setSelectedServerOption("");
                            setServerSearchQuery(serverSearchDraft.trim());
                          }}
                        >
                          Search servers
                        </GhostButton>
                        <p className="text-xs leading-5 text-muted md:col-span-2">
                          Search for your broker server, then select the closest match. If it does
                          not appear, enter the exact server manually.
                        </p>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <TextField
                          label={`${selectedPlatform} login / account number`}
                          name="login"
                          placeholder="e.g. 12345678"
                          required
                          autoComplete="off"
                        />
                        <TextField
                          label={`${selectedPlatform} trading password`}
                          name="password"
                          type="password"
                          placeholder="Main trading password"
                          required
                          autoComplete="new-password"
                        />
                        <SelectField
                          label="Broker server"
                          name="serverSelection"
                          value={selectedServerOption}
                          onChange={(event) => setSelectedServerOption(event.target.value)}
                          required
                        >
                          <option value="">
                            {brokerServersQuery.isLoading
                              ? "Loading matching servers…"
                              : "Select a server"}
                          </option>
                          {(brokerServersQuery.data?.servers ?? []).map((server) => (
                            <option key={server.id} value={server.serverName}>
                              {server.serverName}
                              {server.brokerName ? ` — ${server.brokerName}` : ""}
                            </option>
                          ))}
                          <option value={CUSTOM_SERVER_OPTION}>Enter server manually</option>
                        </SelectField>
                        {selectedServerOption === CUSTOM_SERVER_OPTION ? (
                          <TextField
                            label="Custom broker server"
                            name="customServer"
                            placeholder="Enter the exact server name"
                            required
                            autoComplete="off"
                          />
                        ) : null}
                      </div>

                      {brokerServersQuery.isSuccess && brokerServersQuery.data.servers.length === 0 ? (
                        <p className="text-xs text-muted">
                          No matching servers were found. Choose “Enter server manually.”
                        </p>
                      ) : null}
                      {brokerServersQuery.data?.discoveryMessage ? (
                        <p className="text-xs text-muted">{brokerServersQuery.data.discoveryMessage}</p>
                      ) : null}

                      <div className="rounded-[4px] border border-line bg-background px-4 py-3 text-sm text-muted">
                        <span className="font-semibold text-accent-2">🔒 Secure</span> — Your
                        trading password is encrypted with AES-256-GCM on the server. It is
                        never stored in plaintext and never returned to the browser.
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                        <button
                          type="button"
                          className="text-sm font-semibold text-muted hover:text-foreground"
                          onClick={handleSkipCredentials}
                        >
                          Skip for now
                        </button>
                        <div className="flex gap-3">
                          <GhostButton
                            type="button"
                            onClick={() => {
                              setStep("setup");
                              setErrorMessage("");
                            }}
                          >
                            Back
                          </GhostButton>
                          <PrimaryButton type="submit" disabled={isSubmitting}>
                            {isSubmitting ? "Connecting…" : "Connect and sync"}
                          </PrimaryButton>
                        </div>
                      </div>
                    </form>
                  </>
                )}

                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close dialog"
                    className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          { label: "All accounts", value: tradingAccounts.length, helper: "Your broker directory" },
          { label: "Live", value: connectedCount, helper: "Selectable for live data", tone: "lime" },
          { label: "Setting up", value: syncingCount + pendingCount, helper: `${pendingCount} need information`, tone: "accent" },
          { label: "Reconnect", value: reconnectCount, helper: "Disconnected or inactive", tone: reconnectCount ? "danger" : "default" },
          {
            label: "Open exposure",
            value: formatMoney({ amount: totalPnl, currency: "USD" }),
            helper: "Live accounts only",
            tone: totalPnl < 0 ? "danger" : "default",
          },
        ]}
      />

      {successMessage ? (
        <div className="mt-5 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
          {successMessage}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-end justify-between gap-4 rounded-[4px] border border-line bg-panel p-4">
        <div className="grid flex-1 gap-4">
          <SearchField
            label="Search accounts"
            placeholder="Search account, broker, server, platform, or status"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <FilterChipRow
            chips={[
              { label: `All (${tradingAccounts.length})`, active: statusFilter === "ALL", onClick: () => setStatusFilter("ALL") },
              { label: `Live (${connectedCount})`, active: statusFilter === "CONNECTED", onClick: () => setStatusFilter("CONNECTED") },
              { label: `Syncing (${syncingCount})`, active: statusFilter === "SYNCING", onClick: () => setStatusFilter("SYNCING") },
              { label: `Needs setup (${pendingCount})`, active: statusFilter === "PENDING", onClick: () => setStatusFilter("PENDING") },
              { label: `Reconnect (${reconnectCount})`, active: statusFilter === "RECONNECT", onClick: () => setStatusFilter("RECONNECT") },
              { label: "Restricted", active: statusFilter === "RESTRICTED", onClick: () => setStatusFilter("RESTRICTED") },
            ]}
          />
        </div>
      </div>

      <Panel className="mt-5 overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Account directory</h2>
            <p className="mt-1 text-sm text-muted">
              Live accounts feed the workspace selector. Pending and inactive accounts stay here for setup or reconnection.
            </p>
          </div>
          <StatusPill tone="muted">{filteredAccounts.length} shown</StatusPill>
        </div>

        {isLoading ? (
          <div className="space-y-3 p-5">
            {[...Array(5)].map((_, index) => (
              <div key={index} className="h-14 animate-pulse rounded-[4px] border border-line bg-background" />
            ))}
          </div>
        ) : isError ? (
          <div className="m-5 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Failed to load accounts. Please refresh the page.
          </div>
        ) : filteredAccounts.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={tradingAccounts.length ? "No accounts match your filters" : "No broker accounts yet"}
              description={tradingAccounts.length
                ? "Try another search term or clear the current status filter."
                : "Connect a broker account to begin live synchronization."}
              action={tradingAccounts.length ? (
                <GhostButton type="button" onClick={() => { setQuery(""); setStatusFilter("ALL"); }}>
                  Reset filters
                </GhostButton>
              ) : undefined}
            />
          </div>
        ) : (
          <DataTable
            headers={["Account", "Connection", "Balance", "Equity", "Floating PnL", "Drawdown", "Last live sync", "Action"]}
            initialPageSize={10}
            pageSizeOptions={[10, 25, 50]}
            maxBodyHeight="660px"
            rows={filteredAccounts.map((account) => [
              <div key="account" className="min-w-[210px]">
                <p className="font-semibold text-foreground">{account.accountName}</p>
                <p className="mt-1 text-xs text-muted">
                  {account.brokerName}
                  {account.serverName ? ` · ${account.serverName}` : " · Broker information pending"}
                  {account.platform ? ` · ${account.platform}` : ""}
                </p>
              </div>,
              <div key="connection" className="ml-auto w-fit text-right">
                <StatusPill tone={statusTone(account.status)}>{statusLabel(account)}</StatusPill>
                <p className="mt-1 whitespace-nowrap text-[11px] text-muted">
                  {account.status === "CONNECTED"
                    ? "Live data enabled"
                    : account.status === "PENDING"
                      ? "Information incomplete"
                      : account.status === "SYNCING"
                        ? "Verification in progress"
                        : account.status === "INACTIVE"
                          ? "Inactive for 10 days"
                          : account.status === "DISCONNECTED"
                            ? "Broker connection lost"
                            : "Trading restricted"}
                </p>
              </div>,
              <span key="balance" className="font-semibold text-foreground">{formatMoney(account.balance)}</span>,
              <span key="equity" className="font-semibold text-accent-2">{formatMoney(account.equity)}</span>,
              <span key="pnl" className={account.floatingPnl.amount >= 0 ? "font-semibold text-accent" : "font-semibold text-danger"}>
                {formatMoney(account.floatingPnl)}
              </span>,
              <span key="drawdown" className="font-semibold text-foreground">{formatPercent(account.drawdownPercent)}</span>,
              <span key="sync" className="whitespace-nowrap text-xs text-muted">
                {account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleString() : "Never"}
              </span>,
              <Link
                key="action"
                href={`/accounts/${account.accountId}`}
                className="btn-dark inline-flex h-9 items-center whitespace-nowrap px-3 text-xs font-semibold text-accent"
              >
                {accountActionLabel(account)}
              </Link>,
            ])}
          />
        )}
      </Panel>

    </WorkspacePage>
  );
}
