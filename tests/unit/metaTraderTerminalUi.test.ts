// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://app.wsa.test/terminal"}
import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MetaTraderTerminal } from "@/components/trading/MetaTraderTerminal";
import {
  defaultWorkspace,
  mergeWorkspace,
  type MetaTraderPatch,
  type MetaTraderWorkspace,
} from "@/lib/terminal/workspace";
import type { BrokerTerminalInfo } from "@/lib/terminal/brokerTerminal";
import type { MetaTraderTerminalAccount } from "@/lib/terminal/metatrader";
import { click, control, json, mount, setValue, settle, submit, text, unmountAll } from "./helpers/reactDom";

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: (props: { href: string; className?: string; children?: unknown }) =>
      h("a", { href: props.href, className: props.className }, props.children as never),
  };
});

const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const A3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

function terminalAccount(id: string, overrides: Partial<MetaTraderTerminalAccount>): MetaTraderTerminalAccount {
  return {
    accountId: id,
    accountName: "Account",
    brokerName: "IC Markets",
    platform: "MT5",
    server: "ICMarketsSC-Demo",
    loginMasked: "••••2222",
    currency: "USD",
    status: "CONNECTED",
    canLaunch: true,
    unavailableReason: null,
    ...overrides,
  };
}

const ACCOUNTS: MetaTraderTerminalAccount[] = [
  terminalAccount(A1, { accountName: "Alpha" }),
  terminalAccount(A2, {
    accountName: "Bravo",
    platform: "MT4",
    server: "Pepperstone-Demo",
    loginMasked: "••••4444",
  }),
  terminalAccount(A3, {
    accountName: "Charlie",
    platform: null,
    server: null,
    loginMasked: null,
    canLaunch: false,
    unavailableReason: "NO_CREDENTIALS",
  }),
];

type LaunchAnswer = { target: unknown } | { status: number; error: { code: string; message: string } };

const LAUNCH: Record<string, LaunchAnswer> = {
  [A1]: {
    target: {
      accountId: A1,
      accountName: "Alpha",
      brokerName: "IC Markets",
      platform: "MT5",
      server: "ICMarketsSC-Demo",
      login: "11112222",
    },
  },
  [A2]: {
    target: {
      accountId: A2,
      accountName: "Bravo",
      brokerName: "Pepperstone",
      platform: "MT4",
      server: "Pepperstone-Demo",
      login: "33334444",
    },
  },
};

const calls: Array<{ url: string; method: string; body: unknown }> = [];

/** What the server answers when it was asked for a broker's web terminal. */
type ResolveAnswer = BrokerTerminalInfo | { status: number; error: { code: string; message: string } };

function installFetch(
  options: {
    accounts?: MetaTraderTerminalAccount[];
    launch?: Record<string, LaunchAnswer>;
    resolve?: (body: Record<string, unknown>) => ResolveAnswer | Promise<ResolveAnswer>;
  } = {},
) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.startsWith("/api/terminal/metatrader/accounts")) {
        return json({ ok: true, data: { accounts: options.accounts ?? [] } });
      }
      if (url.startsWith("/api/terminal/metatrader/resolve")) {
        if (!options.resolve) return json({ ok: false, error: { code: "NOT_FOUND", message: url } }, 404);
        const answer = await options.resolve(body as Record<string, unknown>);
        if ("error" in answer) return json({ ok: false, error: answer.error }, answer.status);
        return json({ ok: true, data: answer });
      }
      if (url.startsWith("/api/terminal/metatrader/launch")) {
        const answer = options.launch?.[(body as { accountId: string }).accountId];
        if (!answer) return json({ ok: false, error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found." } }, 404);
        if ("target" in answer) return json({ ok: true, data: answer.target });
        return json({ ok: false, error: answer.error }, answer.status);
      }
      return json({ ok: false, error: { code: "NOT_FOUND", message: url } }, 404);
    }),
  );
}

const launchCalls = () => calls.filter((call) => call.url.startsWith("/api/terminal/metatrader/launch"));
const resolveCalls = () => calls.filter((call) => call.url.startsWith("/api/terminal/metatrader/resolve"));

const FOUND_IC: BrokerTerminalInfo = {
  serverKey: "icmarketssc",
  status: "FOUND",
  url: "https://webtrader.icmarkets.com/",
  host: "webtrader.icmarkets.com",
  source: "DISCOVERED",
  embeddable: true,
  brokerName: "IC Markets",
  checkedAt: "2026-10-12T12:00:00.000Z",
};
const NOT_FOUND_IC: BrokerTerminalInfo = { ...FOUND_IC, status: "NOT_FOUND", url: null, host: null, source: null };

interface HarnessProps {
  initial?: Partial<MetaTraderWorkspace>;
  active?: boolean;
  loaded?: boolean;
  suggested?: string | null;
  onChange?: (patch: MetaTraderPatch) => void;
}

/** Plays the part of the workspace: keeps the settings and applies every patch the pane reports. */
function Harness(props: HarnessProps) {
  // These tests were written for the shared (classic) terminal; the automatic source has its own tests below.
  const [settings, setSettings] = useState<MetaTraderWorkspace>({
    ...defaultWorkspace().metatrader,
    source: "classic",
    ...props.initial,
  });
  return createElement(MetaTraderTerminal, {
    settings,
    active: props.active ?? true,
    workspaceLoaded: props.loaded ?? true,
    suggestedAccountId: props.suggested ?? null,
    height: "600px",
    onSettingsChange: (patch: MetaTraderPatch) => {
      props.onChange?.(patch);
      setSettings(
        (current) => mergeWorkspace({ ...defaultWorkspace(), metatrader: current }, { metatrader: patch }).metatrader,
      );
    },
  });
}

const MANUAL = { id: "manual-0001", label: "Challenge", platform: "MT5" as const, login: "7654321", server: "FTMO-Server" };

function frameOf(container: ParentNode): HTMLIFrameElement | null {
  return container.querySelector("iframe");
}

function rowButton(container: ParentNode, accountName: string): HTMLElement | null {
  const row = Array.from(container.querySelectorAll("li")).find((item) => (item.textContent ?? "").includes(accountName));
  return row?.querySelector("button, a") ?? null;
}

function frameParams(container: ParentNode): Record<string, string> {
  const src = frameOf(container)?.getAttribute("src");
  if (!src) throw new Error("no terminal frame");
  return Object.fromEntries(new URL(src).searchParams);
}

beforeEach(() => {
  installFetch({ accounts: ACCOUNTS, launch: LAUNCH });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("MetaTraderTerminal - choosing an account", () => {
  test("lists the platform accounts and starts nothing until one is chosen", async () => {
    const view = mount(createElement(Harness));
    await settle();

    const copy = text(view.container);
    expect(copy).toContain("Alpha");
    expect(copy).toContain("Bravo");
    expect(copy).toContain("••••2222");
    expect(frameOf(view.container)).toBeNull();
    expect(launchCalls()).toHaveLength(0);
  });

  test("the account selected elsewhere on the platform is listed first", async () => {
    const view = mount(createElement(Harness, { suggested: A2 }));
    await settle();

    const names = Array.from(view.container.querySelectorAll("ul[aria-label='Platform accounts'] > li")).map(
      (item) => item.querySelector("span")?.textContent,
    );
    expect(names).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(text(view.container)).toContain("Selected in WSA");
  });

  test("opening an account fills the login and the server into the web terminal address", async () => {
    const onChange = vi.fn();
    const view = mount(createElement(Harness, { onChange }));
    await settle();

    click(rowButton(view.container, "Alpha"));
    await settle();

    const frame = frameOf(view.container);
    expect(frame).not.toBeNull();
    const url = new URL(frame?.getAttribute("src") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://metatraderweb.app/trade");
    expect(frameParams(view.container)).toEqual({
      servers: "ICMarketsSC-Demo",
      trade_server: "ICMarketsSC-Demo",
      login: "11112222",
      startup_version: "5",
      startup_mode: "no_autologin",
      lang: "en",
    });
    // the frame can not navigate this page away and has its own origin
    const sandbox = frame?.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-top-navigation");

    expect(launchCalls().map((call) => call.body)).toEqual([{ accountId: A1 }]);
    expect(onChange).toHaveBeenCalledWith({ selection: { kind: "platform", accountId: A1 } });

    const copy = text(view.container);
    expect(copy).toContain("Alpha");
    expect(copy).toContain("MT5 · ••••2222 · ICMarketsSC-Demo");
    expect(copy).toContain("Opens MetaTrader 5 on the server “ICMarketsSC-Demo”.");
    expect(copy).toContain("Type your trading password in the terminal");
    // the full login number is in the address only, never printed on the page
    expect(copy).not.toContain("11112222");
  });

  test("the picker switches to another account (MT4 asks for version 4 and its own server)", async () => {
    const view = mount(createElement(Harness));
    await settle();
    click(rowButton(view.container, "Alpha"));
    await settle();

    const picker = view.container.querySelector<HTMLSelectElement>("#mt-terminal-account");
    expect(picker?.value).toBe(`platform:${A1}`);
    setValue(picker, `platform:${A2}`);
    await settle();

    expect(frameParams(view.container)).toEqual({
      servers: "Pepperstone-Demo",
      trade_server: "Pepperstone-Demo",
      login: "33334444",
      startup_version: "4",
      startup_mode: "no_autologin",
      lang: "en",
    });
    expect(text(view.container)).toContain("Opens MetaTrader 4 on the server “Pepperstone-Demo”.");
    expect(launchCalls().map((call) => call.body)).toEqual([{ accountId: A1 }, { accountId: A2 }]);
    expect(view.container.querySelector<HTMLSelectElement>("#mt-terminal-account")?.value).toBe(`platform:${A2}`);
  });

  test("the picker offers platform accounts, manual accounts and 'Add manually'", async () => {
    const view = mount(createElement(Harness, { initial: { manualAccounts: [MANUAL] }, loaded: false }));
    await settle();

    const picker = view.container.querySelector("#mt-terminal-account");
    const groups = Array.from(picker?.querySelectorAll("optgroup") ?? []).map((group) => group.label);
    expect(groups).toEqual(["Platform accounts", "Saved manually"]);
    const options = Array.from(picker?.querySelectorAll("option") ?? []).map((option) => option.textContent);
    expect(options[0]).toBe("Choose an account…");
    expect(options[options.length - 1]).toBe("+ Add manually…");
    expect(options).toContain("Charlie (login missing)");
    expect(options).toContain("Alpha · MT5 · ••••2222");
    expect(options).toContain("Challenge · MT5 · ••••321");
  });

  test("an account without a saved login can not be opened and says why", async () => {
    const view = mount(createElement(Harness));
    await settle();

    const copy = text(view.container);
    expect(copy).toContain("No broker login is saved for this account yet.");
    const row = rowButton(view.container, "Charlie");
    expect(row?.tagName).toBe("A");
    expect(row?.getAttribute("href")).toBe("/accounts");

    // picking it in the dropdown does not start anything either
    setValue(view.container.querySelector("#mt-terminal-account"), `platform:${A3}`);
    await settle();
    expect(frameOf(view.container)).toBeNull();
    expect(launchCalls()).toHaveLength(0);
    expect(text(view.container)).toContain("Charlie: No broker login is saved for this account yet.");
  });

  test("a refused launch shows the server's message and keeps the list", async () => {
    installFetch({
      accounts: ACCOUNTS,
      launch: {
        [A1]: { status: 409, error: { code: "CREDENTIALS_MISSING", message: "No MetaTrader login is stored for this account yet." } },
      },
    });
    const view = mount(createElement(Harness));
    await settle();
    click(rowButton(view.container, "Alpha"));
    await settle();

    expect(frameOf(view.container)).toBeNull();
    const alert = view.container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("No MetaTrader login is stored for this account yet.");
    expect(text(view.container)).toContain("Bravo");
  });

  test("no accounts at all: explains how to connect one", async () => {
    installFetch({ accounts: [] });
    const view = mount(createElement(Harness));
    await settle();

    expect(text(view.container)).toContain("No MetaTrader account is connected to your WSA profile yet.");
    expect(view.container.querySelector("a[href='/accounts']")).not.toBeNull();
    expect(control(view.container, "Add an account manually")).not.toBeNull();
  });

  test("a failing account list can be retried", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Backend down" } }, 500)));
    const view = mount(createElement(Harness));
    await settle();

    expect(view.container.querySelector("[role='alert']")?.textContent).toContain("Backend down");
    expect(control(view.container, "Try again")).not.toBeNull();
    expect(control(view.container, "Add an account manually")).not.toBeNull();
  });
});

describe("MetaTraderTerminal - remembered account and keep-alive", () => {
  const remembered = { selection: { kind: "platform", accountId: A1 } } as const;

  test("opens the account used last, but only once the pane is visible and the workspace is loaded", async () => {
    const view = mount(createElement(Harness, { initial: remembered, active: false, loaded: true }));
    await settle();
    expect(frameOf(view.container)).toBeNull();
    expect(launchCalls()).toHaveLength(0);

    view.rerender(createElement(Harness, { initial: remembered, active: true, loaded: false }));
    await settle();
    expect(frameOf(view.container)).toBeNull();
    expect(launchCalls()).toHaveLength(0);

    view.rerender(createElement(Harness, { initial: remembered, active: true, loaded: true }));
    await settle();
    expect(frameOf(view.container)).not.toBeNull();
    expect(launchCalls()).toHaveLength(1);
  });

  test("a hidden pane keeps its terminal (same frame, no reload)", async () => {
    const view = mount(createElement(Harness, { initial: remembered }));
    await settle();
    const frame = frameOf(view.container);
    expect(frame).not.toBeNull();

    view.rerender(createElement(Harness, { initial: remembered, active: false }));
    await settle();
    expect(frameOf(view.container)).toBe(frame);

    view.rerender(createElement(Harness, { initial: remembered, active: true }));
    await settle();
    expect(frameOf(view.container)).toBe(frame);
    expect(launchCalls()).toHaveLength(1);
  });

  test("a remembered account that no longer exists shows the error and the list", async () => {
    const gone = { selection: { kind: "platform", accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaff" } } as const;
    const view = mount(createElement(Harness, { initial: gone }));
    await settle();

    expect(frameOf(view.container)).toBeNull();
    expect(view.container.querySelector("[role='alert']")?.textContent).toContain("Account not found.");
    expect(text(view.container)).toContain("Alpha");
  });

  test("Close removes the terminal and it does not come back by itself", async () => {
    const view = mount(createElement(Harness, { initial: remembered }));
    await settle();
    expect(frameOf(view.container)).not.toBeNull();

    click(control(view.container, "Close"));
    await settle();
    expect(frameOf(view.container)).toBeNull();
    expect(text(view.container)).toContain("Open an account in the terminal");

    view.rerender(createElement(Harness, { initial: remembered }));
    await settle();
    expect(frameOf(view.container)).toBeNull();
    expect(launchCalls()).toHaveLength(1);
  });

  test("Reload gives a fresh frame with the same address", async () => {
    const view = mount(createElement(Harness, { initial: remembered }));
    await settle();
    const before = frameOf(view.container);
    const src = before?.getAttribute("src");

    click(control(view.container, "Reload"));
    await settle();

    const after = frameOf(view.container);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(after?.getAttribute("src")).toBe(src);
    expect(launchCalls()).toHaveLength(1);
  });

  test("New tab opens the same address without giving the terminal access to this page", async () => {
    const view = mount(createElement(Harness, { initial: remembered }));
    await settle();

    const link = control(view.container, "New tab");
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe(frameOf(view.container)?.getAttribute("src"));
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });
});

describe("MetaTraderTerminal - accounts added by hand", () => {
  test("validates the form, then opens the account and reports it for saving", async () => {
    const onChange = vi.fn();
    const view = mount(createElement(Harness, { onChange }));
    await settle();

    click(control(view.container, "Add an account manually"));
    const form = view.container.querySelector("form");
    expect(form).not.toBeNull();
    const login = form?.querySelector<HTMLInputElement>("input[placeholder='e.g. 12345678']") ?? null;
    const server = form?.querySelector<HTMLInputElement>("input[placeholder='e.g. ICMarketsSC-Demo']") ?? null;
    const label = form?.querySelector<HTMLInputElement>("input[placeholder='e.g. Challenge 100k']") ?? null;
    const platform = form?.querySelector<HTMLSelectElement>("select") ?? null;
    expect(form?.querySelector("input[type='password']")).toBeNull();

    setValue(login, "12ab");
    setValue(server, "FTMO-Server");
    submit(form);
    expect(text(view.container)).toContain("The login is the account number (digits only).");
    expect(frameOf(view.container)).toBeNull();

    setValue(login, "7654321");
    setValue(server, "<bad>");
    submit(form);
    expect(text(view.container)).toContain("Enter the server exactly as your broker shows it");

    setValue(server, "FTMO-Server");
    setValue(label, "Challenge 100k");
    setValue(platform, "MT4");
    submit(form);
    await settle();

    expect(view.container.querySelector("form")).toBeNull();
    expect(frameParams(view.container)).toEqual({
      servers: "FTMO-Server",
      trade_server: "FTMO-Server",
      login: "7654321",
      startup_version: "4",
      startup_mode: "no_autologin",
      lang: "en",
    });
    expect(launchCalls()).toHaveLength(0);

    const patch = onChange.mock.calls[0][0] as MetaTraderPatch;
    expect(patch.manualAccounts).toEqual([
      { id: expect.stringMatching(/^m[0-9a-f]{18}$/), label: "Challenge 100k", platform: "MT4", login: "7654321", server: "FTMO-Server" },
    ]);
    expect(patch.selection).toEqual({ kind: "manual", id: patch.manualAccounts?.[0].id });
    expect(JSON.stringify(onChange.mock.calls)).not.toMatch(/password/i);
    expect(JSON.stringify(calls)).not.toMatch(/password/i);
    expect(text(view.container)).toContain("Challenge 100k");
  });

  test("choosing '+ Add manually…' in the picker opens the same form; Cancel closes it", async () => {
    const view = mount(createElement(Harness));
    await settle();

    setValue(view.container.querySelector("#mt-terminal-account"), "__add_manually__");
    expect(view.container.querySelector("form")).not.toBeNull();
    click(control(view.container, "Cancel"));
    expect(view.container.querySelector("form")).toBeNull();
  });

  test("adding an account that is already saved opens it instead of duplicating it", async () => {
    const onChange = vi.fn();
    const view = mount(createElement(Harness, { initial: { manualAccounts: [MANUAL] }, onChange }));
    await settle();

    click(control(view.container, "Add an account manually"));
    const form = view.container.querySelector("form");
    setValue(form?.querySelector("input[placeholder='e.g. 12345678']") ?? null, MANUAL.login);
    setValue(form?.querySelector("input[placeholder='e.g. ICMarketsSC-Demo']") ?? null, MANUAL.server.toLowerCase());
    submit(form);
    await settle();

    expect(frameOf(view.container)).not.toBeNull();
    const patches = onChange.mock.calls.map((call) => call[0] as MetaTraderPatch);
    expect(patches.every((patch) => patch.manualAccounts === undefined)).toBe(true);
    expect(patches[0].selection).toEqual({ kind: "manual", id: MANUAL.id });
  });

  test("a saved manual account can be removed after a confirmation", async () => {
    const onChange = vi.fn();
    const view = mount(
      createElement(Harness, {
        initial: { manualAccounts: [MANUAL], selection: { kind: "manual", id: MANUAL.id } },
        onChange,
      }),
    );
    await settle();
    expect(frameOf(view.container)).not.toBeNull();

    click(control(view.container, "Remove"));
    expect(text(view.container)).toContain("Remove this account from your list?");
    expect(onChange).not.toHaveBeenCalled();

    click(control(view.container, "Yes"));
    await settle();

    expect(onChange).toHaveBeenCalledWith({ manualAccounts: [], selection: null });
    expect(frameOf(view.container)).toBeNull();
  });

  test("only manual accounts get a Remove button", async () => {
    const view = mount(createElement(Harness, { initial: { selection: { kind: "platform", accountId: A1 } } }));
    await settle();
    expect(frameOf(view.container)).not.toBeNull();
    expect(control(view.container, "Remove")).toBeNull();
  });
});

describe("MetaTraderTerminal - terminal source", () => {
  test("the new terminal only knows MT5: an MT4 account gets a clear message and a way out", async () => {
    const onChange = vi.fn();
    const view = mount(createElement(Harness, { initial: { source: "modern" }, onChange }));
    await settle();

    click(rowButton(view.container, "Bravo"));
    await settle();
    expect(frameOf(view.container)).toBeNull();
    expect(view.container.querySelector("[role='alert']")?.textContent).toContain("supports MetaTrader 5 only");

    click(control(view.container, "Use MetaTrader Web"));
    await settle();
    expect(onChange).toHaveBeenCalledWith({ source: "classic" });
    expect(frameParams(view.container).startup_version).toBe("4");
  });

  test("the new terminal gets the login and the dark theme (MetaQuotes' own server is all it offers)", async () => {
    const demo = { ...MANUAL, id: "manual-0002", label: "Demo", server: "MetaQuotes-Demo" };
    const view = mount(
      createElement(Harness, {
        initial: { source: "modern", manualAccounts: [demo], selection: { kind: "manual", id: demo.id } },
      }),
    );
    await settle();

    const url = new URL(frameOf(view.container)?.getAttribute("src") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://web.metatrader.app/terminal");
    expect(frameParams(view.container)).toEqual({ login: "7654321", lang: "en", "theme-mode": "1" });
    expect(text(view.container)).not.toContain("Choose the server");
  });

  test("the new terminal does not open a broker's server: the message names it and offers MetaTrader Web", async () => {
    const onChange = vi.fn();
    const view = mount(createElement(Harness, { initial: { source: "modern" }, onChange }));
    await settle();

    click(rowButton(view.container, "Alpha"));
    await settle();
    expect(frameOf(view.container)).toBeNull();
    expect(view.container.querySelector("[role='alert']")?.textContent).toContain("ICMarketsSC-Demo");

    click(control(view.container, "Use MetaTrader Web"));
    await settle();
    expect(onChange).toHaveBeenCalledWith({ source: "classic" });
    expect(frameParams(view.container)).toMatchObject({ trade_server: "ICMarketsSC-Demo", startup_version: "5" });
  });

  test("the source can be changed from the toolbar", async () => {
    const onChange = vi.fn();
    const view = mount(createElement(Harness, { onChange, initial: { selection: { kind: "platform", accountId: A1 } } }));
    await settle();

    setValue(view.container.querySelector("#mt-terminal-source"), "modern");
    await settle();

    expect(onChange).toHaveBeenCalledWith({ source: "modern" });
    // The new terminal only knows MetaQuotes' own servers, so a broker account
    // gets the explanation instead of a terminal logged in on the wrong server.
    expect(frameOf(view.container)).toBeNull();
    expect(view.container.querySelector("[role='alert']")?.textContent).toContain("ICMarketsSC-Demo");
  });

  test("a broker's own terminal needs a safe https address", async () => {
    const onChange = vi.fn();
    const view = mount(
      createElement(Harness, {
        onChange,
        initial: {
          source: "custom",
          manualAccounts: [MANUAL],
          selection: { kind: "manual", id: MANUAL.id },
        },
      }),
    );
    await settle();

    // no address yet: nothing is shown in a frame, the reason is
    expect(frameOf(view.container)).toBeNull();
    expect(view.container.querySelector("[role='alert']")?.textContent).toContain("Enter the address of your broker's web terminal.");

    const input = view.container.querySelector<HTMLInputElement>("#mt-terminal-custom-url");
    const form = input?.closest("form") ?? null;
    expect(input).not.toBeNull();

    setValue(input, "http://webtrader.example-broker.com/");
    submit(form);
    expect(text(view.container)).toContain("Only https:// addresses can be opened here.");
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ customUrl: expect.anything() }));

    setValue(input, "https://webtrader.example-broker.com/web");
    submit(form);
    await settle();

    expect(onChange).toHaveBeenCalledWith({ customUrl: "https://webtrader.example-broker.com/web" });
    const url = new URL(frameOf(view.container)?.getAttribute("src") ?? "");
    expect(url.host).toBe("webtrader.example-broker.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      login: "7654321",
      trade_server: "FTMO-Server",
      startup_version: "5",
      startup_mode: "no_autologin",
    });
  });

  test("an address that points back to this site is refused", async () => {
    const view = mount(createElement(Harness, { initial: { source: "custom" } }));
    await settle();

    const input = view.container.querySelector<HTMLInputElement>("#mt-terminal-custom-url");
    setValue(input, `${window.location.origin}/terminal`);
    submit(input?.closest("form") ?? null);

    expect(text(view.container)).toContain("That address points back to this platform.");
  });
});

describe("MetaTraderTerminal - signing in to the chosen account", () => {
  test("reconnecting to the account used last is off by default and can be switched on", async () => {
    const onChange = vi.fn();
    const view = mount(createElement(Harness, { onChange, initial: { selection: { kind: "platform", accountId: A1 } } }));
    await settle();

    const box = view.container.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(false);
    expect(frameParams(view.container).startup_mode).toBe("no_autologin");

    click(box);
    await settle();

    expect(onChange).toHaveBeenCalledWith({ autoLogin: true });
    expect(frameParams(view.container)).not.toHaveProperty("startup_mode");
    expect(text(view.container)).toContain("Automatic reconnection is on");
  });

  test("the server name can be copied, and a failing clipboard is reported instead of ignored", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const view = mount(createElement(Harness, { initial: { selection: { kind: "platform", accountId: A1 } } }));
      await settle();

      click(control(view.container, "Copy server name"));
      await settle();
      expect(writeText).toHaveBeenCalledWith("ICMarketsSC-Demo");
      expect(text(view.container)).toContain("Server name copied");

      writeText.mockRejectedValueOnce(new Error("denied"));
      click(control(view.container, "Server name copied"));
      await settle();
      expect(text(view.container)).toContain("Could not copy. The server name is ICMarketsSC-Demo.");
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test("a broker that is not on MetaQuotes' list is pointed to its own web terminal", async () => {
    const view = mount(createElement(Harness, { initial: { selection: { kind: "platform", accountId: A1 } } }));
    await settle();
    expect(text(view.container)).toContain("Your broker is not on MetaQuotes' list");

    const metaQuotes = { ...MANUAL, id: "manual-0003", label: "Demo", server: "MetaQuotes-Demo" };
    const other = mount(
      createElement(Harness, {
        initial: { manualAccounts: [metaQuotes], selection: { kind: "manual", id: metaQuotes.id } },
      }),
    );
    await settle();
    expect(text(other.container)).not.toContain("Your broker is not on MetaQuotes' list");
  });

  test("the classic terminal offers to switch to Automatic, which then opens the broker's own terminal", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => FOUND_IC });
    const onChange = vi.fn();
    const view = mount(createElement(Harness, { onChange, initial: { selection: { kind: "platform", accountId: A1 } } }));
    await settle();

    click(control(view.container, "use Automatic"));
    await settle(8);

    expect(onChange).toHaveBeenCalledWith({ source: "auto" });
    expect(new URL(frameOf(view.container)?.getAttribute("src") ?? "").host).toBe("webtrader.icmarkets.com");
  });
});

describe("MetaTraderTerminal - automatic source (the broker's own web terminal, found by the platform)", () => {
  const auto = { source: "auto" } as const;
  const SAVED_KEY = "icmarketssc:mt5";
  const SAVED_URL = "https://webtrader.icmarkets-clients.com/mt5";

  function mountAuto(initial: Partial<MetaTraderWorkspace> = {}, onChange?: (patch: MetaTraderPatch) => void) {
    return mount(createElement(Harness, { initial: { ...auto, ...initial }, onChange }));
  }

  test("Automatic is the first choice of the toolbar, then MetaTrader Web, the new terminal and the own address", async () => {
    const view = mountAuto();
    await settle();
    const picker = view.container.querySelector<HTMLSelectElement>("#mt-terminal-source");
    expect(picker?.value).toBe("auto");
    expect(Array.from(picker?.options ?? []).map((option) => option.value)).toEqual(["auto", "classic", "modern", "custom"]);
  });

  test("nothing is searched until an account is opened; then the broker's own terminal opens with the login and server", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => FOUND_IC });
    const view = mountAuto();
    await settle();
    expect(resolveCalls()).toHaveLength(0);

    click(rowButton(view.container, "Alpha"));
    await settle(8);

    const url = new URL(frameOf(view.container)?.getAttribute("src") ?? "");
    expect(url.host).toBe("webtrader.icmarkets.com");
    expect(frameParams(view.container)).toEqual({
      login: "11112222",
      trade_server: "ICMarketsSC-Demo",
      startup_version: "5",
      startup_mode: "no_autologin",
    });
    expect(resolveCalls().map((call) => call.body)).toEqual([{ accountId: A1, refresh: false }]);

    const copy = text(view.container);
    expect(copy).toContain("Opens IC Markets's own MetaTrader 5 web terminal (found automatically).");
    expect(copy).toContain("webtrader.icmarkets.com");
    expect(copy).not.toContain("11112222");
    expect(copy).not.toContain("use Automatic");
    // never a password in anything that was sent
    expect(JSON.stringify(calls)).not.toMatch(/password/i);
    expect(url.search.toLowerCase()).not.toMatch(/pass|pwd/);
  });

  test("while the search runs it says so and shows no terminal - then the terminal appears", async () => {
    let release!: (info: BrokerTerminalInfo) => void;
    const pending = new Promise<BrokerTerminalInfo>((resolve) => {
      release = resolve;
    });
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => pending });
    const view = mountAuto();
    await settle();

    click(rowButton(view.container, "Alpha"));
    await settle(6);
    expect(frameOf(view.container)).toBeNull();
    expect(text(view.container)).toContain("Looking for IC Markets's web terminal");
    expect(view.container.querySelector("[role='status']")).not.toBeNull();

    release(FOUND_IC);
    await settle(6);
    expect(frameOf(view.container)).not.toBeNull();
    expect(text(view.container)).not.toContain("Looking for IC Markets's web terminal");
  });

  test("a terminal that forbids being framed is offered as a link to its own tab, with the login in the address", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => ({ ...FOUND_IC, embeddable: false }) });
    const view = mountAuto();
    await settle();

    click(rowButton(view.container, "Alpha"));
    await settle(8);

    expect(frameOf(view.container)).toBeNull();
    expect(text(view.container)).toContain("does not allow its web terminal to be shown inside another page");
    const link = control(view.container, "Open webtrader.icmarkets.com");
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
    const href = new URL(link?.getAttribute("href") ?? "");
    expect(href.host).toBe("webtrader.icmarkets.com");
    expect(Object.fromEntries(href.searchParams)).toMatchObject({ login: "11112222", trade_server: "ICMarketsSC-Demo" });
  });

  test("MT5 whose broker's terminal is not found: paste it once, it is saved per broker and opened", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => NOT_FOUND_IC });
    const onChange = vi.fn();
    const view = mountAuto({}, onChange);
    await settle();

    click(rowButton(view.container, "Alpha"));
    await settle(8);

    expect(frameOf(view.container)).toBeNull();
    expect(text(view.container)).toContain("We could not find IC Markets's MetaTrader 5 web terminal automatically.");
    const input = view.container.querySelector<HTMLInputElement>("#mt-terminal-broker-url");
    const form = input?.closest("form") ?? null;
    expect(input).not.toBeNull();

    // an unsafe address is refused with the reason, and nothing is saved
    setValue(input, "http://webtrader.example-broker.com/");
    submit(form);
    expect(text(view.container)).toContain("Only https:// addresses can be opened here.");
    setValue(input, `${window.location.origin}/terminal`);
    submit(form);
    expect(text(view.container)).toContain("That address points back to this platform.");
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ brokerTerminals: expect.anything() }));

    setValue(input, SAVED_URL);
    submit(form);
    await settle();

    expect(onChange).toHaveBeenCalledWith({ brokerTerminals: { [SAVED_KEY]: SAVED_URL } });
    expect(new URL(frameOf(view.container)?.getAttribute("src") ?? "").host).toBe("webtrader.icmarkets-clients.com");
    expect(frameParams(view.container)).toMatchObject({ login: "11112222", trade_server: "ICMarketsSC-Demo", startup_version: "5" });
    expect(text(view.container)).toContain("the address you saved");
  });

  test("an address saved earlier is used at once, without asking the server", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => FOUND_IC });
    const view = mountAuto({ brokerTerminals: { [SAVED_KEY]: SAVED_URL } });
    await settle();

    click(rowButton(view.container, "Alpha"));
    await settle(8);

    expect(new URL(frameOf(view.container)?.getAttribute("src") ?? "").host).toBe("webtrader.icmarkets-clients.com");
    expect(resolveCalls()).toHaveLength(0);
  });

  test("'Forget the address I saved' goes back to the search", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => NOT_FOUND_IC });
    const onChange = vi.fn();
    const view = mountAuto({ brokerTerminals: { [SAVED_KEY]: SAVED_URL } }, onChange);
    await settle();
    click(rowButton(view.container, "Alpha"));
    await settle(8);
    expect(frameOf(view.container)).not.toBeNull();

    click(control(view.container, "Forget the address I saved"));
    await settle(8);

    expect(onChange).toHaveBeenCalledWith({ brokerTerminals: { [SAVED_KEY]: null } });
    expect(frameOf(view.container)).toBeNull();
    expect(view.container.querySelector("#mt-terminal-broker-url")).not.toBeNull();
  });

  test("an address typed for one broker is not carried over to the next", async () => {
    installFetch({
      accounts: ACCOUNTS,
      launch: LAUNCH,
      resolve: (body) => (body.accountId === A1 ? NOT_FOUND_IC : { ...NOT_FOUND_IC, serverKey: "other" }),
    });
    const other = { ...MANUAL, id: "manual-0009", label: "Other", server: "Other-Live" };
    const view = mountAuto({ manualAccounts: [other] });
    await settle();
    click(rowButton(view.container, "Alpha"));
    await settle(8);
    const typed = view.container.querySelector<HTMLInputElement>("#mt-terminal-broker-url");
    setValue(typed, "https://webtrader.half-typed.example.com/");
    expect(view.container.querySelector<HTMLInputElement>("#mt-terminal-broker-url")?.value).toBe(
      "https://webtrader.half-typed.example.com/",
    );

    // an MT5 account of another broker is opened from the picker
    setValue(view.container.querySelector("#mt-terminal-account"), `manual:${other.id}`);
    await settle(8);

    const input = view.container.querySelector<HTMLInputElement>("#mt-terminal-broker-url");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("");
  });

  test("MT4 without a terminal of its own opens MetaQuotes' shared MT4 terminal on the account's server", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => ({ ...NOT_FOUND_IC, serverKey: "pepperstone" }) });
    const view = mountAuto();
    await settle();

    click(rowButton(view.container, "Bravo"));
    await settle(8);

    const url = new URL(frameOf(view.container)?.getAttribute("src") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://metatraderweb.app/trade");
    expect(frameParams(view.container)).toEqual({
      servers: "Pepperstone-Demo",
      trade_server: "Pepperstone-Demo",
      login: "33334444",
      startup_version: "4",
      startup_mode: "no_autologin",
      lang: "en",
    });
    expect(text(view.container)).toContain("Opens MetaTrader 4 on the server “Pepperstone-Demo”.");
  });

  test("MetaQuotes' own servers need no search", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => FOUND_IC });
    const demo = { ...MANUAL, id: "manual-0002", label: "Demo", server: "MetaQuotes-Demo" };
    const view = mountAuto({ manualAccounts: [demo], selection: { kind: "manual", id: demo.id } });
    await settle(8);

    expect(new URL(frameOf(view.container)?.getAttribute("src") ?? "").host).toBe("web.metatrader.app");
    expect(resolveCalls()).toHaveLength(0);
  });

  test("an account added by hand is searched by its server name and platform only", async () => {
    installFetch({
      accounts: ACCOUNTS,
      launch: LAUNCH,
      resolve: () => ({ ...FOUND_IC, serverKey: "ftmo", url: "https://mt5.ftmo.com/", host: "mt5.ftmo.com", brokerName: null }),
    });
    const view = mountAuto({ manualAccounts: [MANUAL], selection: { kind: "manual", id: MANUAL.id } });
    await settle(8);

    expect(resolveCalls().map((call) => call.body)).toEqual([{ server: "FTMO-Server", platform: "MT5", refresh: false }]);
    expect(new URL(frameOf(view.container)?.getAttribute("src") ?? "").host).toBe("mt5.ftmo.com");
    expect(frameParams(view.container)).toMatchObject({ login: "7654321", trade_server: "FTMO-Server" });
    expect(text(view.container)).toContain("Opens your broker's own MetaTrader 5 web terminal (found automatically).");
  });

  test("'Search again' asks the server to look again and opens what it finds", async () => {
    const answers: BrokerTerminalInfo[] = [NOT_FOUND_IC, FOUND_IC];
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => answers.shift() ?? FOUND_IC });
    const view = mountAuto();
    await settle();
    click(rowButton(view.container, "Alpha"));
    await settle(8);
    expect(frameOf(view.container)).toBeNull();

    click(control(view.container, "Search again"));
    await settle(8);

    expect(resolveCalls().map((call) => call.body)).toEqual([
      { accountId: A1, refresh: false },
      { accountId: A1, refresh: true },
    ]);
    expect(new URL(frameOf(view.container)?.getAttribute("src") ?? "").host).toBe("webtrader.icmarkets.com");
  });

  test("a search that could not finish says so - also when the server itself failed", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => ({ ...NOT_FOUND_IC, status: "UNAVAILABLE" }) });
    const first = mountAuto();
    await settle();
    click(rowButton(first.container, "Alpha"));
    await settle(8);
    expect(frameOf(first.container)).toBeNull();
    expect(text(first.container)).toContain("The search for your broker's web terminal could not finish just now.");
    expect(control(first.container, "Search again")).not.toBeNull();
    first.unmount();

    installFetch({
      accounts: ACCOUNTS,
      launch: LAUNCH,
      resolve: () => ({ status: 500, error: { code: "INTERNAL_ERROR", message: "boom" } }),
    });
    const second = mountAuto();
    await settle();
    click(rowButton(second.container, "Alpha"));
    await settle(8);
    expect(frameOf(second.container)).toBeNull();
    expect(text(second.container)).toContain("The search for your broker's web terminal could not finish just now.");
    expect(control(second.container, "Search again")).not.toBeNull();
  });

  test("a broker an administrator switched off is treated like one that was not found", async () => {
    installFetch({ accounts: ACCOUNTS, launch: LAUNCH, resolve: () => ({ ...NOT_FOUND_IC, status: "BLOCKED" }) });
    const view = mountAuto();
    await settle();
    click(rowButton(view.container, "Alpha"));
    await settle(8);

    expect(frameOf(view.container)).toBeNull();
    expect(text(view.container)).toContain("We could not find IC Markets's MetaTrader 5 web terminal automatically.");
    expect(view.container.querySelector("#mt-terminal-broker-url")).not.toBeNull();
  });

  test("an account whose server name is unusable can only be opened through an address entered by hand", async () => {
    const onChange = vi.fn();
    installFetch({
      accounts: ACCOUNTS,
      launch: { [A1]: { target: { ...(LAUNCH[A1] as { target: object }).target, server: null } } },
      resolve: () => FOUND_IC,
    });
    const view = mountAuto({}, onChange);
    await settle();
    click(rowButton(view.container, "Alpha"));
    await settle(8);

    expect(resolveCalls()).toHaveLength(0);
    expect(frameOf(view.container)).toBeNull();
    expect(text(view.container)).toContain("This account has no server name the platform can recognise");
    expect(view.container.querySelector("#mt-terminal-broker-url")).toBeNull();

    click(control(view.container, "Enter an address myself"));
    expect(onChange).toHaveBeenCalledWith({ source: "custom" });
  });
});
