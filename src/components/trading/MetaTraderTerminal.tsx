"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Info, Loader2, Maximize2, Minimize2, Plus, Power, RotateCw, Trash2 } from "lucide-react";
import {
  fetchMetaTraderLaunch,
  useBrokerWebTerminal,
  useMetaTraderAccounts,
  type BrokerTerminalQuery,
} from "@/hooks/useMetaTraderAccounts";
import { brokerTerminalKey } from "@/lib/terminal/brokerTerminal";
import {
  MAX_MANUAL_ACCOUNTS,
  META_TRADER_SOURCES,
  buildMetaTraderUrl,
  createManualAccountId,
  isMetaQuotesServer,
  isMetaTraderSource,
  maskLogin,
  parseManualAccountInput,
  validateCustomTerminalUrl,
  type ManualMetaTraderAccount,
  type MetaTraderLaunchTarget,
  type MetaTraderPlatform,
  type MetaTraderTerminalAccount,
  type TerminalAccountUnavailableReason,
} from "@/lib/terminal/metatrader";
import type { MetaTraderPatch, MetaTraderSelection, MetaTraderWorkspace } from "@/lib/terminal/workspace";

/**
 * MetaTrader web terminal next to the TradingView chart.
 *
 *  - The accounts are the trader's own platform accounts (the ones the broker
 *    bridge syncs). Choosing one opens the terminal for THAT account: its platform
 *    (MT4 / MT5), its own broker server and its login number are put in the
 *    address, and the terminal is told not to reconnect to the account it used last
 *    (that is how MetaQuotes' demo server used to come up). Accounts can also be
 *    added by hand.
 *  - MetaTrader 5 web terminals run on the BROKER's own domain (MetaQuotes closed
 *    the shared one), so the default source "Automatic" asks the server for the
 *    address of the terminal of the account's broker (found from the account's
 *    server, see brokerWebTerminalService) - nobody has to look for a link. Only
 *    when nothing is found is an address asked for, once per broker.
 *  - There is no way to hand a password to a web terminal, and this component
 *    never asks for one: it is typed once inside the terminal (whose "Save
 *    password" box then remembers it in the browser).
 *  - Once opened, the terminal stays mounted when the user switches to another
 *    tab, so the session and the live connection keep running.
 */

const EMPTY_ACCOUNTS: MetaTraderTerminalAccount[] = [];
const ADD_MANUALLY = "__add_manually__";

const IFRAME_SANDBOX = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-modals",
  "allow-downloads",
  "allow-storage-access-by-user-activation",
].join(" ");

const UNAVAILABLE_TEXT: Record<TerminalAccountUnavailableReason, string> = {
  NO_CREDENTIALS: "No broker login is saved for this account yet.",
  UNREADABLE: "The saved login could not be read. Save it again under Accounts.",
  ENCRYPTION_UNAVAILABLE: "Saved logins are not available on this deployment.",
  INCOMPLETE: "The saved login is incomplete (login number or platform is missing).",
};

type LaunchRequest =
  | { kind: "platform"; accountId: string; n: number }
  | { kind: "manual"; id: string; n: number };

interface ResolvedTarget {
  label: string;
  /** the broker named on the account (platform accounts only) */
  brokerName: string | null;
  detail: string;
  platform: MetaTraderPlatform;
  login: string;
  server: string | null;
}

export interface MetaTraderTerminalProps {
  settings: MetaTraderWorkspace;
  onSettingsChange: (patch: MetaTraderPatch) => void;
  /** the pane is on screen (a hidden pane keeps its session but never starts one) */
  active: boolean;
  /** the stored workspace has been read, so the account used last can be opened */
  workspaceLoaded: boolean;
  /** the account selected elsewhere on the platform: listed first */
  suggestedAccountId?: string | null;
  /** height of the terminal area */
  height: string;
}

function requestFromSelection(selection: MetaTraderSelection): LaunchRequest {
  return selection.kind === "platform"
    ? { kind: "platform", accountId: selection.accountId, n: 0 }
    : { kind: "manual", id: selection.id, n: 0 };
}

function describeTarget(platform: MetaTraderPlatform, login: string, server: string | null): string {
  return [platform, maskLogin(login), server].filter(Boolean).join(" · ");
}

function platformOptionLabel(account: MetaTraderTerminalAccount): string {
  const parts = [account.accountName];
  if (account.platform) parts.push(account.platform);
  if (account.loginMasked) parts.push(account.loginMasked);
  const label = parts.join(" · ");
  return account.canLaunch ? label : `${label} (login missing)`;
}

const FIELD_CLASS =
  "h-9 w-full rounded-[4px] border border-line bg-background px-3 text-xs font-semibold text-foreground outline-none transition focus:border-accent";

export function MetaTraderTerminal({
  settings,
  onSettingsChange,
  active,
  workspaceLoaded,
  suggestedAccountId,
  height,
}: MetaTraderTerminalProps) {
  const accountsQuery = useMetaTraderAccounts(true);
  const accounts = accountsQuery.data ?? EMPTY_ACCOUNTS;

  const [request, setRequest] = useState<LaunchRequest | null>(null);
  const [closed, setClosed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [serverCopied, setServerCopied] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [terminalDraft, setTerminalDraft] = useState("");
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const launchCounter = useRef(0);
  const paneRef = useRef<HTMLElement | null>(null);

  // The account used last is opened again the first time this pane is on screen.
  const remembered = settings.selection;
  if (request === null && !closed && active && workspaceLoaded && remembered !== null) {
    setRequest(requestFromSelection(remembered));
  }

  const platformRequest = request?.kind === "platform" ? request : null;
  // One request per explicit choice (`n`), so every opening is recorded once on the server.
  const launchQuery = useQuery<MetaTraderLaunchTarget>({
    queryKey: ["terminal-metatrader-launch", platformRequest?.accountId ?? null, platformRequest?.n ?? 0],
    queryFn: () => fetchMetaTraderLaunch(platformRequest?.accountId ?? ""),
    enabled: platformRequest !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 10_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const target = useMemo<ResolvedTarget | null>(() => {
    if (!request) return null;
    if (request.kind === "manual") {
      const account = settings.manualAccounts.find((entry) => entry.id === request.id);
      if (!account) return null;
      return {
        label: account.label,
        brokerName: null,
        detail: describeTarget(account.platform, account.login, account.server),
        platform: account.platform,
        login: account.login,
        server: account.server,
      };
    }
    const data = launchQuery.data;
    if (!data) return null;
    return {
      label: data.accountName,
      brokerName: data.brokerName?.trim() || null,
      detail: describeTarget(data.platform, data.login, data.server),
      platform: data.platform,
      login: data.login,
      server: data.server,
    };
  }, [request, settings.manualAccounts, launchQuery.data]);

  const ownOrigin = typeof window === "undefined" ? null : window.location.origin;

  // The broker's own web terminal: an address this user saved for the broker, else
  // the one the server finds from the account's server (asked once, remembered there).
  const brokerKey = target?.server ? brokerTerminalKey(target.server, target.platform) : null;
  const savedTerminalUrl = brokerKey ? (settings.brokerTerminals[brokerKey] ?? null) : null;
  const lookupWanted =
    settings.source === "auto" &&
    target !== null &&
    target.server !== null &&
    !isMetaQuotesServer(target.server) &&
    savedTerminalUrl === null;
  const lookupQuery: BrokerTerminalQuery | null =
    !request || !target
      ? null
      : request.kind === "platform"
        ? { kind: "platform", accountId: request.accountId }
        : target.server
          ? { kind: "manual", server: target.server, platform: target.platform }
          : null;
  const brokerLookup = useBrokerWebTerminal(lookupQuery, searchAttempt, lookupWanted);
  const foundTerminal = brokerLookup.data && brokerLookup.data.status === "FOUND" ? brokerLookup.data : null;
  const brokerTerminalUrl = savedTerminalUrl ?? foundTerminal?.url ?? null;
  const lookingUp = lookupWanted && brokerLookup.isPending && !brokerLookup.isError;
  // a broker page that forbids being framed is opened in its own tab
  const mayEmbed = savedTerminalUrl !== null ? true : foundTerminal ? foundTerminal.embeddable : true;

  const launch = target
    ? buildMetaTraderUrl({
        source: settings.source,
        customUrl: settings.customUrl,
        brokerTerminalUrl,
        platform: target.platform,
        login: target.login,
        server: target.server,
        lang: "en",
        dark: true,
        ownOrigin,
        autoLogin: settings.autoLogin,
      })
    : null;
  // nothing is shown before the search for the broker's terminal is over
  const openUrl = launch && launch.ok && !lookingUp ? launch.url : null;
  const frameUrl = openUrl && mayEmbed ? openUrl : null;
  const newTabOnly = openUrl !== null && !mayEmbed;
  const frameKey = frameUrl ? `${reloads}|${frameUrl}` : null;
  const host = launch && launch.ok ? launch.host : "MetaQuotes";

  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled === true;
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === paneRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const orderedAccounts = useMemo(() => {
    if (!suggestedAccountId) return accounts;
    return [...accounts].sort(
      (a, b) => Number(b.accountId === suggestedAccountId) - Number(a.accountId === suggestedAccountId),
    );
  }, [accounts, suggestedAccountId]);

  const serverSuggestions = useMemo(() => {
    const names = new Set<string>();
    for (const account of accounts) if (account.server) names.add(account.server);
    for (const account of settings.manualAccounts) names.add(account.server);
    return [...names];
  }, [accounts, settings.manualAccounts]);

  function resetPaneState() {
    setSearchAttempt(0);
    // an address typed for one broker must not be saved for the next one
    setTerminalDraft("");
    setTerminalError(null);
    setNotice(null);
    setClosed(false);
    setReloads(0);
    setConfirmRemove(false);
    setAddOpen(false);
  }

  function openPlatform(accountId: string) {
    const account = accounts.find((entry) => entry.accountId === accountId);
    if (account && !account.canLaunch) {
      const why = account.unavailableReason ? UNAVAILABLE_TEXT[account.unavailableReason] : "It cannot be opened here.";
      setNotice(`${account.accountName}: ${why}`);
      return;
    }
    launchCounter.current += 1;
    resetPaneState();
    setRequest({ kind: "platform", accountId, n: launchCounter.current });
    onSettingsChange({ selection: { kind: "platform", accountId } });
  }

  function openManual(id: string) {
    launchCounter.current += 1;
    resetPaneState();
    setRequest({ kind: "manual", id, n: launchCounter.current });
    onSettingsChange({ selection: { kind: "manual", id } });
  }

  function closeTerminal() {
    setRequest(null);
    setClosed(true);
    setReloads(0);
    setNotice(null);
    setConfirmRemove(false);
  }

  function removeManual(id: string) {
    const rest = settings.manualAccounts.filter((entry) => entry.id !== id);
    const selectedHere = settings.selection?.kind === "manual" && settings.selection.id === id;
    onSettingsChange({ manualAccounts: rest, ...(selectedHere ? { selection: null } : {}) });
    if (request?.kind === "manual" && request.id === id) closeTerminal();
    setConfirmRemove(false);
  }

  function addManual(value: Omit<ManualMetaTraderAccount, "id">): string | null {
    const same = settings.manualAccounts.find(
      (entry) =>
        entry.platform === value.platform &&
        entry.login === value.login &&
        entry.server.toLowerCase() === value.server.toLowerCase(),
    );
    if (same) {
      openManual(same.id);
      return null;
    }
    if (settings.manualAccounts.length >= MAX_MANUAL_ACCOUNTS) {
      return `You can keep up to ${MAX_MANUAL_ACCOUNTS} accounts added by hand. Remove one first.`;
    }
    const id = createManualAccountId();
    launchCounter.current += 1;
    resetPaneState();
    setRequest({ kind: "manual", id, n: launchCounter.current });
    onSettingsChange({
      manualAccounts: [...settings.manualAccounts, { id, ...value }],
      selection: { kind: "manual", id },
    });
    return null;
  }

  function onPick(value: string) {
    if (value === ADD_MANUALLY) {
      setAddOpen(true);
      setNotice(null);
      return;
    }
    if (value.startsWith("platform:")) openPlatform(value.slice("platform:".length));
    else if (value.startsWith("manual:")) openManual(value.slice("manual:".length));
  }

  function saveCustomUrl() {
    const checked = validateCustomTerminalUrl(customDraft ?? settings.customUrl ?? "", ownOrigin);
    if (!checked.ok) {
      setCustomError(checked.reason);
      return;
    }
    setCustomError(null);
    setCustomDraft(null);
    onSettingsChange({ customUrl: checked.url });
  }

  function saveBrokerTerminal() {
    if (!brokerKey) return;
    const checked = validateCustomTerminalUrl(terminalDraft, ownOrigin);
    if (!checked.ok) {
      setTerminalError(checked.reason);
      return;
    }
    setTerminalError(null);
    setTerminalDraft("");
    onSettingsChange({ brokerTerminals: { [brokerKey]: checked.url } });
  }

  function forgetBrokerTerminal() {
    if (!brokerKey) return;
    onSettingsChange({ brokerTerminals: { [brokerKey]: null } });
  }

  function copyServer(name: string) {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      setNotice(`The server name is ${name}.`);
      return;
    }
    clipboard.writeText(name).then(
      () => {
        setServerCopied(true);
        window.setTimeout(() => setServerCopied(false), 2_000);
      },
      () => setNotice(`Could not copy. The server name is ${name}.`),
    );
  }

  function toggleFullscreen() {
    const pane = paneRef.current;
    if (!pane) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    pane.requestFullscreen().catch(() => {
      setNotice("Your browser did not allow full screen. Use “New tab” instead.");
    });
  }

  const selectValue = request
    ? request.kind === "platform"
      ? `platform:${request.accountId}`
      : `manual:${request.id}`
    : "";
  const hasAnyAccount = accounts.length > 0 || settings.manualAccounts.length > 0;
  const sourceInfo = META_TRADER_SOURCES.find((entry) => entry.id === settings.source);

  // What fills the terminal area.
  let body: ReactNode;
  if (frameUrl && frameKey && target && launch && launch.ok) {
    const accountServer = target.server;
    const platformName = target.platform === "MT4" ? "MetaTrader 4" : "MetaTrader 5";
    const serverHint = accountServer === null
      ? "Choose your broker's server in the sign-in form. "
      : launch.serverNotPreselected
        ? `Choose the server “${accountServer}” in the sign-in form. `
        : "";
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="space-y-1 border-b border-line px-4 py-2 text-xs leading-5 text-muted sm:px-5">
          <p>
            <span className="font-semibold text-foreground">{target.label}</span> · {target.detail} · {host}.{" "}
            {launch.kind === "broker"
              ? `Opens ${target.brokerName ? `${target.brokerName}'s` : "your broker's"} own ${platformName} web terminal (${
                  savedTerminalUrl ? "the address you saved" : "found automatically"
                }). `
              : accountServer
                ? `Opens ${platformName} on the server “${accountServer}”. `
                : `Opens ${platformName}. `}
            {launch.prefilled ? "Your login number is filled in. " : ""}
            {serverHint}
            Type your trading password in the terminal; if you tick “Save password” there, the terminal remembers it in
            this browser. WSA never receives it.
            {settings.autoLogin
              ? " Automatic reconnection is on: the terminal may open the account it used last - check the account name inside it."
              : ""}
          </p>
          {accountServer ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 font-semibold text-foreground/80 hover:text-foreground"
                onClick={() => copyServer(accountServer)}
              >
                {serverCopied ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {serverCopied ? "Server name copied" : "Copy server name"}
              </button>
              {settings.source === "classic" && !isMetaQuotesServer(accountServer) ? (
                <span>
                  Does the form show MetaQuotes-Demo or not list this server? Your broker is not on MetaQuotes&apos; list
                  -{" "}
                  <button
                    type="button"
                    className="font-semibold text-foreground underline"
                    onClick={() => onSettingsChange({ source: "auto" })}
                  >
                    use Automatic
                  </button>
                  : the platform opens your broker&apos;s own web terminal.
                </span>
              ) : null}
              {launch.kind === "broker" && savedTerminalUrl ? (
                <button
                  type="button"
                  className="font-semibold text-foreground/80 hover:text-foreground"
                  onClick={forgetBrokerTerminal}
                >
                  Forget the address I saved
                </button>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="relative min-h-0 flex-1 bg-[#0a0a0a]">
          <iframe
            key={frameKey}
            src={frameUrl}
            title={`MetaTrader web terminal - ${target.label}`}
            sandbox={IFRAME_SANDBOX}
            allow="fullscreen; clipboard-write"
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={() => setLoadedKey(frameKey)}
            className="absolute inset-0 h-full w-full border-0 bg-[#0a0a0a]"
          />
          {loadedKey !== frameKey ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background/80 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Connecting to {host}…
            </div>
          ) : null}
        </div>
      </div>
    );
  } else {
    let status: ReactNode = null;
    if (lookingUp && target) {
      status = (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Looking for {target.brokerName ? `${target.brokerName}'s` : "your broker's"} web terminal… This is done once
          per broker; the address is remembered.
        </p>
      );
    } else if (newTabOnly && openUrl && launch && launch.ok && target) {
      status = (
        <div className="rounded-[4px] border border-line bg-background px-4 py-3 text-sm text-muted" role="status">
          <p>
            <span className="font-semibold text-foreground">{launch.host}</span> does not allow its web terminal to be
            shown inside another page. Open it in its own tab - your login number{target.server ? " and server" : ""}{" "}
            {target.server ? "are" : "is"} already in the address; you only type the password there.
          </p>
          <a href={openUrl} target="_blank" rel="noopener noreferrer" className="btn-dark mt-3 inline-flex text-xs">
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open {launch.host}
          </a>
        </div>
      );
    } else if (launch && !launch.ok && launch.needsBrokerTerminal && target) {
      const unavailable = brokerLookup.data?.status === "UNAVAILABLE" || brokerLookup.isError;
      status = (
        <div className="space-y-3 rounded-[4px] border border-line bg-background px-4 py-3 text-sm text-muted" role="status">
          <p>
            {!brokerKey
              ? "This account has no server name the platform can recognise, so your broker's web terminal can not be found automatically."
              : unavailable
                ? "The search for your broker's web terminal could not finish just now."
                : `We could not find ${target.brokerName ? `${target.brokerName}'s` : "your broker's"} MetaTrader 5 web terminal automatically.`}{" "}
            MetaTrader 5 web terminals run on the broker&apos;s own website, so it is the broker that publishes the link
            (look for “WebTrader” or “Web Terminal” in your broker&apos;s client area).{" "}
            {!brokerKey
              ? "Enter the address yourself."
              : unavailable
                ? "Search again in a moment, or paste the address once."
                : "Paste it once - it is remembered for this broker and you will not be asked again."}
          </p>
          {brokerKey ? (
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-start"
              onSubmit={(event) => {
                event.preventDefault();
                saveBrokerTerminal();
              }}
            >
              <div className="min-w-0 flex-1">
                <label className="sr-only" htmlFor="mt-terminal-broker-url">
                  Your broker&apos;s web terminal address
                </label>
                <input
                  id="mt-terminal-broker-url"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={500}
                  placeholder="https://webtrader.your-broker.com/"
                  value={terminalDraft}
                  onChange={(event) => {
                    setTerminalDraft(event.target.value);
                    if (terminalError) setTerminalError(null);
                  }}
                  aria-invalid={terminalError ? true : undefined}
                  className={FIELD_CLASS}
                />
              </div>
              <button type="submit" className="btn-dark text-xs">
                Save address
              </button>
              <button
                type="button"
                className="btn-dark text-xs"
                onClick={() => {
                  setSearchAttempt((count) => count + 1);
                }}
              >
                <RotateCw className="h-4 w-4" aria-hidden="true" />
                Search again
              </button>
            </form>
          ) : (
            <button type="button" className="btn-dark text-xs" onClick={() => onSettingsChange({ source: "custom" })}>
              Enter an address myself
            </button>
          )}
          {terminalError ? (
            <p role="alert" className="text-xs text-danger">
              {terminalError}
            </p>
          ) : null}
        </div>
      );
    } else if (platformRequest && launchQuery.isPending && !launchQuery.isError) {
      status = (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Preparing your account…
        </p>
      );
    } else if (platformRequest && launchQuery.isError) {
      status = (
        <p className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
          {launchQuery.error instanceof Error ? launchQuery.error.message : "Could not open this account."} Choose
          another account below, or add one manually.
        </p>
      );
    } else if (launch && !launch.ok) {
      status = (
        <div className="rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
          <p>{launch.reason}</p>
          {launch.switchTo === "classic" ? (
            <button
              type="button"
              className="btn-dark mt-3 text-xs"
              onClick={() => onSettingsChange({ source: "classic" })}
            >
              Use MetaTrader Web
            </button>
          ) : null}
          {launch.switchTo === "auto" ? (
            <button
              type="button"
              className="btn-dark mt-3 text-xs"
              onClick={() => onSettingsChange({ source: "auto" })}
            >
              Use Automatic
            </button>
          ) : null}
        </div>
      );
    }
    body = (
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
        {status}
        {!(platformRequest && launchQuery.isPending && !launchQuery.isError) ? (
          <AccountLauncher
            accounts={orderedAccounts}
            manualAccounts={settings.manualAccounts}
            suggestedAccountId={suggestedAccountId ?? null}
            loading={accountsQuery.isPending}
            loadError={accountsQuery.isError ? accountsQuery.error.message : null}
            onRetry={() => void accountsQuery.refetch()}
            onOpenPlatform={openPlatform}
            onOpenManual={openManual}
            onAdd={() => setAddOpen(true)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <section
      ref={paneRef}
      aria-label="MetaTrader web terminal"
      className={`section-surface flex flex-col overflow-hidden ${fullscreen ? "h-dvh rounded-none" : ""}`}
    >
      <div className="flex flex-col gap-4 border-b border-line px-4 py-4 sm:px-5 sm:py-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="status-pill px-3 py-1 text-xs">{target ? target.platform : "MetaTrader"}</span>
            <span className="text-xs font-medium text-muted">
              {frameUrl ? `Live on ${host}` : "Web terminal"}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
            <h3 className="text-lg font-semibold text-foreground">MetaTrader web terminal</h3>
            <p className="text-sm text-muted">Trade your MetaTrader accounts here, next to the chart.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="mt-terminal-account">
            Account to open in the MetaTrader terminal
          </label>
          <select
            id="mt-terminal-account"
            value={selectValue}
            onChange={(event) => onPick(event.target.value)}
            className={`${FIELD_CLASS} min-w-56 flex-1 sm:max-w-sm`}
          >
            <option value="">{hasAnyAccount ? "Choose an account…" : "No account yet"}</option>
            {orderedAccounts.length > 0 ? (
              <optgroup label="Platform accounts">
                {orderedAccounts.map((account) => (
                  <option key={account.accountId} value={`platform:${account.accountId}`}>
                    {platformOptionLabel(account)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {settings.manualAccounts.length > 0 ? (
              <optgroup label="Saved manually">
                {settings.manualAccounts.map((account) => (
                  <option key={account.id} value={`manual:${account.id}`}>
                    {`${account.label} · ${account.platform} · ${maskLogin(account.login)}`}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <option value={ADD_MANUALLY}>+ Add manually…</option>
          </select>

          <label className="sr-only" htmlFor="mt-terminal-source">
            Web terminal to use
          </label>
          <select
            id="mt-terminal-source"
            value={settings.source}
            title={sourceInfo?.description}
            onChange={(event) => {
              if (isMetaTraderSource(event.target.value)) onSettingsChange({ source: event.target.value });
            }}
            className={`${FIELD_CLASS} w-auto min-w-48`}
          >
            {META_TRADER_SOURCES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>

          <label
            className="flex items-center gap-2 text-xs font-medium text-muted"
            title="Off (recommended): the sign-in form of the account chosen here always comes up. On: the terminal reconnects by itself to the account it used last, which can be another account."
          >
            <input
              type="checkbox"
              checked={settings.autoLogin}
              onChange={(event) => onSettingsChange({ autoLogin: event.target.checked })}
            />
            Reconnect automatically
          </label>

          {frameUrl ? (
            <>
              <button type="button" className="btn-dark text-xs" onClick={() => setReloads((count) => count + 1)}>
                <RotateCw className="h-4 w-4" aria-hidden="true" />
                Reload
              </button>
              <a href={frameUrl} target="_blank" rel="noopener noreferrer" className="btn-dark text-xs">
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                New tab
              </a>
            </>
          ) : null}
          {canFullscreen && frameUrl ? (
            <button type="button" className="btn-dark text-xs" onClick={toggleFullscreen}>
              {fullscreen ? (
                <Minimize2 className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-4 w-4" aria-hidden="true" />
              )}
              {fullscreen ? "Exit full screen" : "Full screen"}
            </button>
          ) : null}
          {request ? (
            <button type="button" className="btn-dark text-xs" onClick={closeTerminal}>
              <Power className="h-4 w-4" aria-hidden="true" />
              Close
            </button>
          ) : null}
          {request?.kind === "manual" && target ? (
            confirmRemove ? (
              <span className="flex items-center gap-2 text-xs text-muted">
                Remove this account from your list?
                <button type="button" className="btn-dark text-xs" onClick={() => removeManual(request.id)}>
                  Yes
                </button>
                <button type="button" className="btn-dark text-xs" onClick={() => setConfirmRemove(false)}>
                  No
                </button>
              </span>
            ) : (
              <button type="button" className="btn-dark text-xs" onClick={() => setConfirmRemove(true)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Remove
              </button>
            )
          ) : null}
        </div>

        {settings.source === "custom" ? (
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-start"
            onSubmit={(event) => {
              event.preventDefault();
              saveCustomUrl();
            }}
          >
            <div className="min-w-0 flex-1">
              <label className="sr-only" htmlFor="mt-terminal-custom-url">
                Your broker&apos;s web terminal address
              </label>
              <input
                id="mt-terminal-custom-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={500}
                placeholder="https://webtrader.your-broker.com/"
                value={customDraft ?? settings.customUrl ?? ""}
                onChange={(event) => {
                  setCustomDraft(event.target.value);
                  if (customError) setCustomError(null);
                }}
                aria-invalid={customError ? true : undefined}
                className={FIELD_CLASS}
              />
            </div>
            <button type="submit" className="btn-dark text-xs">
              Save address
            </button>
          </form>
        ) : null}
        {customError ? (
          <p role="alert" className="text-xs text-danger">
            {customError}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="rounded-[4px] border border-line bg-background px-3 py-2 text-xs text-muted">
            {notice}
          </p>
        ) : null}
      </div>

      {addOpen ? (
        <ManualAccountForm
          serverSuggestions={serverSuggestions}
          onSubmit={addManual}
          onCancel={() => setAddOpen(false)}
        />
      ) : null}

      <div className={`flex flex-col ${fullscreen ? "min-h-0 flex-1" : "flex-none"}`} style={fullscreen ? undefined : { height }}>
        {body}
      </div>

      <details className="border-t border-line px-4 py-3 text-xs leading-5 text-muted sm:px-5">
        <summary className="flex cursor-pointer items-center gap-2 font-semibold text-foreground/80 hover:text-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          How sign-in works, and what to know
        </summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>
            <strong>Login:</strong> the account&apos;s platform (MT4 or MT5), its own broker server and its account
            number are passed to the terminal, which opens the sign-in form of that account instead of MetaQuotes&apos;
            demo server. The password is typed once inside the terminal - tick “Save password” there to keep it in this
            browser. WSA never receives or stores it.
          </li>
          <li>
            <strong>Which terminal opens:</strong> MetaTrader 5 web terminals run on the broker&apos;s own website
            (MetaQuotes closed its shared MT5 terminal in 2023). With “Automatic” the platform works out your broker&apos;s
            terminal from the account&apos;s server - it checks the broker&apos;s website for the WebTrader link and
            remembers what it finds. If it finds none, you paste the address once per broker. “Automatic” opens MetaQuotes&apos;
            shared MT4 terminal for an MT4 account whose broker has no terminal of its own.
          </li>
          <li>
            <strong>Reconnect automatically:</strong> leave it off unless you always use the same account. When it is on,
            the terminal signs in by itself with the password saved in it - to the account it used last, which is not
            necessarily the one chosen here.
          </li>
          <li>
            <strong>Orders:</strong> trades sent from this terminal go straight to your broker. WSA&apos;s risk limits,
            copy-trading rules and evaluation checks are not applied before they are sent; the trades show up on the
            platform after the next sync.
          </li>
          <li>
            <strong>Limits:</strong> web terminals do not run Expert Advisors or custom indicators.
          </li>
          <li>
            <strong>Privacy:</strong> your login number and server name are sent to {host} in the address of the
            terminal.
          </li>
          <li>
            <strong>Blank or blocked?</strong> Some browsers block third-party storage in embedded frames, and some
            brokers do not allow web trading. Use “New tab” if the terminal stays empty.
          </li>
        </ul>
      </details>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Account list shown while no terminal is open
// ─────────────────────────────────────────────────────────────────────────────

function AccountLauncher({
  accounts,
  manualAccounts,
  suggestedAccountId,
  loading,
  loadError,
  onRetry,
  onOpenPlatform,
  onOpenManual,
  onAdd,
}: {
  accounts: MetaTraderTerminalAccount[];
  manualAccounts: ManualMetaTraderAccount[];
  suggestedAccountId: string | null;
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  onOpenPlatform: (accountId: string) => void;
  onOpenManual: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-foreground">Open an account in the terminal</h4>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
          Pick one of your MetaTrader accounts. The terminal opens with the login number and the server already filled
          in - you only type the password.
        </p>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading your accounts…
        </p>
      ) : null}

      {loadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
          <span>{loadError}</span>
          <button type="button" className="btn-dark text-xs" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}

      {accounts.length > 0 ? (
        <ul className="space-y-2" aria-label="Platform accounts">
          {accounts.map((account) => (
            <li
              key={account.accountId}
              className="inner-surface flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">{account.accountName}</span>
                  {account.platform ? <span className="status-pill">{account.platform}</span> : null}
                  {account.accountId === suggestedAccountId ? (
                    <span className="status-pill status-pill-green">Selected in WSA</span>
                  ) : null}
                </div>
                <p className="mt-1 truncate text-xs text-muted">
                  {[account.brokerName, account.server, account.loginMasked].filter(Boolean).join(" · ")}
                </p>
                {!account.canLaunch && account.unavailableReason ? (
                  <p className="mt-1 text-xs text-danger">{UNAVAILABLE_TEXT[account.unavailableReason]}</p>
                ) : null}
              </div>
              {account.canLaunch ? (
                <button type="button" className="btn-dark text-xs" onClick={() => onOpenPlatform(account.accountId)}>
                  Open
                </button>
              ) : (
                <Link href="/accounts" className="btn-dark text-xs">
                  Manage accounts
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : !loading && !loadError ? (
        <p className="text-sm text-muted">
          No MetaTrader account is connected to your WSA profile yet. Connect one under{" "}
          <Link href="/accounts" className="font-semibold text-accent hover:underline">
            Accounts
          </Link>
          , or add the login by hand.
        </p>
      ) : null}

      {manualAccounts.length > 0 ? (
        <ul className="space-y-2" aria-label="Accounts added manually">
          {manualAccounts.map((account) => (
            <li
              key={account.id}
              className="inner-surface flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">{account.label}</span>
                  <span className="status-pill">{account.platform}</span>
                  <span className="status-pill">Added manually</span>
                </div>
                <p className="mt-1 truncate text-xs text-muted">
                  {maskLogin(account.login)} · {account.server}
                </p>
              </div>
              <button type="button" className="btn-dark text-xs" onClick={() => onOpenManual(account.id)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <button type="button" className="btn-dark text-xs" onClick={onAdd}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add an account manually
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// "Add manually" form (login number + server; never a password)
// ─────────────────────────────────────────────────────────────────────────────

function ManualAccountForm({
  serverSuggestions,
  onSubmit,
  onCancel,
}: {
  serverSuggestions: string[];
  onSubmit: (value: Omit<ManualMetaTraderAccount, "id">) => string | null;
  onCancel: () => void;
}) {
  const baseId = useId();
  const suggestionsId = `${baseId}-servers`;
  const [label, setLabel] = useState("");
  const [platform, setPlatform] = useState<MetaTraderPlatform>("MT5");
  const [login, setLogin] = useState("");
  const [server, setServer] = useState("");
  const [error, setError] = useState<{ field: "platform" | "login" | "server" | "form"; reason: string } | null>(null);

  function submit() {
    const parsed = parseManualAccountInput({ label, platform, login, server });
    if (!parsed.ok) {
      setError({ field: parsed.field, reason: parsed.reason });
      return;
    }
    const problem = onSubmit(parsed.value);
    if (problem) setError({ field: "form", reason: problem });
  }

  const errorFor = (field: "platform" | "login" | "server") => (error?.field === field ? error.reason : null);

  return (
    <form
      className="border-b border-line px-4 py-4 sm:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h4 className="text-sm font-semibold text-foreground">Add a MetaTrader account manually</h4>
      <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
        Only the login number and the server are saved, in your WSA profile. Your password is never asked for here - you
        type it in the terminal.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor={`${baseId}-label`} className="mb-1 block text-xs font-semibold text-muted">
            Name (optional)
          </label>
          <input
            id={`${baseId}-label`}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={40}
            autoComplete="off"
            placeholder="e.g. Challenge 100k"
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label htmlFor={`${baseId}-platform`} className="mb-1 block text-xs font-semibold text-muted">
            Platform
          </label>
          <select
            id={`${baseId}-platform`}
            value={platform}
            onChange={(event) => setPlatform(event.target.value === "MT4" ? "MT4" : "MT5")}
            aria-invalid={errorFor("platform") ? true : undefined}
            className={FIELD_CLASS}
          >
            <option value="MT5">MetaTrader 5</option>
            <option value="MT4">MetaTrader 4</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${baseId}-login`} className="mb-1 block text-xs font-semibold text-muted">
            Login (account number)
          </label>
          <input
            id={`${baseId}-login`}
            value={login}
            onChange={(event) => {
              setLogin(event.target.value);
              if (error) setError(null);
            }}
            inputMode="numeric"
            autoComplete="off"
            maxLength={12}
            placeholder="e.g. 12345678"
            aria-invalid={errorFor("login") ? true : undefined}
            aria-describedby={errorFor("login") ? `${baseId}-login-error` : undefined}
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label htmlFor={`${baseId}-server`} className="mb-1 block text-xs font-semibold text-muted">
            Server
          </label>
          <input
            id={`${baseId}-server`}
            value={server}
            onChange={(event) => {
              setServer(event.target.value);
              if (error) setError(null);
            }}
            list={suggestionsId}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. ICMarketsSC-Demo"
            aria-invalid={errorFor("server") ? true : undefined}
            aria-describedby={errorFor("server") ? `${baseId}-server-error` : undefined}
            className={FIELD_CLASS}
          />
          <datalist id={suggestionsId}>
            {serverSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      </div>

      {errorFor("login") ? (
        <p id={`${baseId}-login-error`} role="alert" className="mt-2 text-xs text-danger">
          {errorFor("login")}
        </p>
      ) : null}
      {errorFor("server") ? (
        <p id={`${baseId}-server-error`} role="alert" className="mt-2 text-xs text-danger">
          {errorFor("server")}
        </p>
      ) : null}
      {error?.field === "form" || error?.field === "platform" ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error.reason}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" className="btn-active text-xs">
          Save and open
        </button>
        <button type="button" className="btn-dark text-xs" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
