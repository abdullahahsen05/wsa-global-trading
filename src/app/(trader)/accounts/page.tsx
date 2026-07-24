"use client";

import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
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

type BrokerProviderOption = {
  id: string;
  displayName: string;
  platformsSupported: BrokerPlatform[];
};

type BrokerServerOption = {
  id: string;
  serverName: string;
  brokerName?: string;
  source: "MANUAL" | "METAAPI";
};

const CUSTOM_BROKER_OPTION = "__custom__";

export default function AccountsPage() {
  const { data: summary, isLoading: accessLoading } = useTraderAccessSummary();
  const access = summary?.platformSubscription ?? EMPTY_PLATFORM_SUBSCRIPTION_ACCESS;

  if (accessLoading && !summary) {
    return (
      <WorkspacePage
        eyebrow="Trading accounts"
        title="Connected broker accounts"
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
        title="Connected broker accounts"
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
  const [pendingBrokerProviderId, setPendingBrokerProviderId] = useState<string | null>(null);
  const [selectedBrokerOption, setSelectedBrokerOption] = useState("");
  const [manualBrokerName, setManualBrokerName] = useState("");
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

  const brokerProvidersQuery = useQuery<{ providers: BrokerProviderOption[] }>({
    queryKey: ["broker-providers", "account-connect", selectedPlatform],
    enabled: connectOpen,
    queryFn: async () => {
      const res = await fetch(`/api/brokers?platform=${selectedPlatform}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load broker providers");
      return json.data;
    },
  });

  const brokerServersQuery = useQuery<{
    servers: BrokerServerOption[];
    discoveryAvailable: boolean;
    discoveryMessage: string | null;
  }>({
    queryKey: ["broker-servers", pendingBrokerProviderId, selectedPlatform, serverSearchQuery],
    enabled: step === "credentials" && Boolean(pendingBrokerProviderId),
    queryFn: async () => {
      const res = await fetch(
        `/api/brokers/${pendingBrokerProviderId}/servers?platform=${selectedPlatform}&query=${encodeURIComponent(serverSearchQuery || pendingBrokerName)}`,
      );
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load broker servers");
      return json.data;
    },
  });

  const filteredAccounts = tradingAccounts.filter((account) => {
    const matchesQuery =
      query.trim().length === 0 ||
      account.accountName.toLowerCase().includes(query.toLowerCase()) ||
      account.brokerName.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = statusFilter === "ALL" || account.status === statusFilter;
    return matchesQuery && matchesStatus;
  });

  const resetDialog = () => {
    setStep("setup");
    setPendingAccountId(null);
    setPendingBrokerName("");
    setPendingBrokerProviderId(null);
    setSelectedBrokerOption("");
    setManualBrokerName("");
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
    const brokerProviderId = formData.get("brokerProviderId") as string;
    const provider = brokerProvidersQuery.data?.providers.find(
      (item) => item.id === brokerProviderId,
    );
    const brokerName = brokerProviderId === CUSTOM_BROKER_OPTION
      ? manualBrokerName.trim()
      : provider?.displayName ?? "";

    if (!accountName || !brokerName) {
      setErrorMessage("Account label and broker are required.");
      setIsSubmitting(false);
      return;
    }

    try {
      const res = await fetch("/api/trading-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountName, brokerName }),
      });
      const json = await res.json();
      if (json.ok) {
        setPendingAccountId(json.data.accountId);
        setPendingBrokerName(brokerName);
        setPendingBrokerProviderId(provider?.id ?? null);
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
    const selectedServer = brokerServersQuery.data?.servers.find(
      (option) => option.serverName === serverSelection,
    );
    const usesCustomServer =
      !pendingBrokerProviderId ||
      serverSelection === CUSTOM_BROKER_OPTION ||
      selectedServer?.source === "METAAPI";
    const server = usesCustomServer ? customServer : serverSelection;
    const platform = selectedPlatform;

    if (!login || !password || !server || !platform) {
      setErrorMessage("MT5 login, trading password, server, and platform are all required.");
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
            brokerProviderId: pendingBrokerProviderId ?? undefined,
            brokerName: pendingBrokerName || undefined,
            useCustomBrokerServer: usesCustomServer,
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

  const connectedCount = tradingAccounts.filter((a) => a.status === "CONNECTED").length;
  const syncingCount = tradingAccounts.filter((a) => a.status === "SYNCING").length;
  const pendingCount = tradingAccounts.filter((a) => a.status === "PENDING").length;
  const totalPnl = tradingAccounts.reduce((sum, a) => sum + a.floatingPnl.amount, 0);

  return (
    <WorkspacePage
      eyebrow="Trading accounts"
      title="Connected broker accounts"
      description="Track broker status, equity, drawdown, and connection health across your accounts."
      action={
        <PageActionGroup>
          <Dialog.Root
            open={connectOpen}
            onOpenChange={(open) => {
              setConnectOpen(open);
              if (!open) resetDialog();
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
              <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">

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
                      Name your account and select an admin-configured broker, or enter your own.
                      Credentials are entered in the next
                      step and stored with AES-256-GCM encryption.
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
                            setSelectedBrokerOption("");
                            setManualBrokerName("");
                          }}
                        >
                          <option value="MT5">MT5 (MetaTrader 5)</option>
                          <option value="MT4">MT4 (MetaTrader 4)</option>
                        </SelectField>
                        <SelectField
                          label="Broker / company"
                          name="brokerProviderId"
                          value={selectedBrokerOption}
                          onChange={(event) => setSelectedBrokerOption(event.target.value)}
                          required
                        >
                          <option value="">
                            {brokerProvidersQuery.isLoading
                              ? "Loading configured brokers…"
                              : "Select a configured broker"}
                          </option>
                          {(brokerProvidersQuery.data?.providers ?? []).map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.displayName}
                            </option>
                          ))}
                          <option value={CUSTOM_BROKER_OPTION}>Enter broker manually</option>
                        </SelectField>
                        <TextField
                          label="Account label"
                          name="accountLabel"
                          placeholder="e.g. Evaluation Phase 1"
                          required
                        />
                        {selectedBrokerOption === CUSTOM_BROKER_OPTION ? (
                          <TextField
                            label="Broker name"
                            value={manualBrokerName}
                            onChange={(event) => setManualBrokerName(event.target.value)}
                            placeholder="Enter your broker company"
                            required
                          />
                        ) : null}
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
                      Enter your MT5 trading account credentials. Investor/read-only passwords
                      cannot be used for trade execution or MetaAPI sync. Use your main trading password.
                    </Dialog.Description>

                    <div className="mt-3 rounded-[4px] border border-accent/20 bg-accent/5 px-4 py-3 text-xs leading-5 text-muted">
                      <span className="font-semibold text-accent-2">Demo testing:</span> Use your MT5 demo account number,
                      main trading password, exact broker server name (e.g. <span className="font-mono">ICMarkets-Demo02</span>),
                      and select platform MT5.
                    </div>

                    {errorMessage ? (
                      <div className="mt-4 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
                        {errorMessage}
                      </div>
                    ) : null}

                    <form className="mt-4 grid gap-4" onSubmit={handleCredentials}>
                      {pendingBrokerProviderId ? (
                        <div className="grid gap-3 rounded-[4px] border border-line bg-background p-4 md:grid-cols-[1fr_auto] md:items-end">
                          <TextField
                            label="Find your MetaTrader server"
                            value={serverSearchDraft}
                            onChange={(event) => setServerSearchDraft(event.target.value)}
                            placeholder="Broker company or exact server name"
                            autoComplete="off"
                          />
                          <GhostButton
                            type="button"
                            onClick={() => {
                              setSelectedServerOption("");
                              setServerSearchQuery(serverSearchDraft.trim());
                            }}
                          >
                            Search MetaApi
                          </GhostButton>
                          <p className="text-xs leading-5 text-muted md:col-span-2">
                            WSA Global is the platform company. MetaApi searches known {selectedPlatform} broker
                            servers and combines them with servers configured by your administrator.
                          </p>
                        </div>
                      ) : null}
                      <div className="grid gap-4 md:grid-cols-2">
                        <TextField
                          label="MT5 login / account number"
                          name="login"
                          placeholder="e.g. 12345678"
                          required
                          autoComplete="off"
                        />
                        <TextField
                          label="MT5 trading password"
                          name="password"
                          type="password"
                          placeholder="Main trading password (not investor)"
                          required
                          autoComplete="new-password"
                        />
                        {pendingBrokerProviderId ? (
                          <SelectField
                            label="Broker server"
                            name="serverSelection"
                            value={selectedServerOption}
                            onChange={(event) => setSelectedServerOption(event.target.value)}
                            required
                          >
                            <option value="">
                              {brokerServersQuery.isLoading
                                ? "Loading configured servers…"
                                : "Select a configured server"}
                            </option>
                            {(brokerServersQuery.data?.servers ?? []).map((server) => (
                              <option key={server.id} value={server.serverName}>
                                {server.serverName}
                                {server.source === "METAAPI"
                                  ? ` — ${server.brokerName ?? "MetaApi"}`
                                  : " — WSA configured"}
                              </option>
                            ))}
                            <option value={CUSTOM_BROKER_OPTION}>Enter server manually</option>
                          </SelectField>
                        ) : null}
                        {!pendingBrokerProviderId || selectedServerOption === CUSTOM_BROKER_OPTION ? (
                          <TextField
                            label="Custom broker server"
                            name="customServer"
                            placeholder="e.g. ICMarkets-Demo02"
                            required
                            autoComplete="off"
                          />
                        ) : null}
                      </div>

                      {pendingBrokerProviderId && brokerServersQuery.isSuccess && brokerServersQuery.data.servers.length === 0 ? (
                        <p className="text-xs text-muted">
                          No admin-configured servers match this platform. Choose “Enter server manually.”
                        </p>
                      ) : null}
                      {pendingBrokerProviderId && brokerServersQuery.data?.discoveryMessage ? (
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
          { label: "Connected", value: connectedCount, helper: "Live adapter", tone: "lime" },
          { label: "Syncing", value: syncingCount, helper: "Active sync", tone: "accent" },
          { label: "Pending", value: pendingCount, helper: "Awaiting verification" },
          {
            label: "Open exposure",
            value: formatMoney({ amount: totalPnl, currency: "USD" }),
            helper: "Net floating PnL",
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
            placeholder="Search by account or broker"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <FilterChipRow
            chips={[
              { label: "All statuses", active: statusFilter === "ALL", onClick: () => setStatusFilter("ALL") },
              { label: "Connected", active: statusFilter === "CONNECTED", onClick: () => setStatusFilter("CONNECTED") },
              { label: "Syncing", active: statusFilter === "SYNCING", onClick: () => setStatusFilter("SYNCING") },
              { label: "Pending", active: statusFilter === "PENDING", onClick: () => setStatusFilter("PENDING") },
              { label: "Disconnected", active: statusFilter === "DISCONNECTED", onClick: () => setStatusFilter("DISCONNECTED") },
              { label: "Restricted", active: statusFilter === "RESTRICTED", onClick: () => setStatusFilter("RESTRICTED") },
            ]}
          />
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        {isLoading ? (
          <div className="xl:col-span-2 space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-56 rounded-[4px] border border-line bg-panel animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          <div className="xl:col-span-2 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            Failed to load accounts. Please refresh the page.
          </div>
        ) : filteredAccounts.length === 0 && tradingAccounts.length === 0 ? (
          <div className="xl:col-span-2">
            <EmptyState
              title="No accounts connected yet"
              description="Connect a broker account to start tracking your performance."
            />
          </div>
        ) : filteredAccounts.length === 0 ? (
          <div className="xl:col-span-2">
            <EmptyState
              title="No accounts match your filters"
              description="Try a different search term or clear the status filter."
              action={
                <GhostButton type="button" onClick={() => { setQuery(""); setStatusFilter("ALL"); }}>
                  Reset filters
                </GhostButton>
              }
            />
          </div>
        ) : (
          filteredAccounts.map((account) => (
            <Panel key={account.accountId} className="min-h-56">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-muted">{account.brokerName}</p>
                  <p className="mt-1 text-xs text-muted">
                    {[account.platform, account.serverName].filter(Boolean).join(" · ") ||
                      "Broker details pending"}
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-foreground">{account.accountName}</h2>
                </div>
                <StatusPill tone={account.status === "CONNECTED" ? "lime" : account.status === "RESTRICTED" ? "danger" : account.status === "PENDING" || account.status === "SYNCING" ? "accent" : "muted"}>
                  {account.status}
                </StatusPill>
              </div>
              <div className="mt-6 grid gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-xs font-semibold text-muted">Balance</p>
                  <p className="mt-2 font-semibold text-foreground">{formatMoney(account.balance)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted">Equity</p>
                  <p className="mt-2 font-semibold text-accent-2">{formatMoney(account.equity)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted">Floating PnL</p>
                  <p className={account.floatingPnl.amount >= 0 ? "mt-2 font-semibold text-accent" : "mt-2 font-semibold text-danger"}>
                    {formatMoney(account.floatingPnl)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted">Drawdown</p>
                  <p className="mt-2 font-semibold text-foreground">{formatPercent(account.drawdownPercent)}</p>
                </div>
              </div>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <p className="text-sm text-muted">Updated {new Date(account.updatedAt).toLocaleString()}</p>
                <Link
                  href={`/accounts/${account.accountId}`}
                  className="rounded-[4px] bg-panel-strong px-5 py-2 text-sm font-semibold text-accent transition"
                >
                  View details
                </Link>
              </div>
            </Panel>
          ))
        )}
      </div>

    </WorkspacePage>
  );
}
