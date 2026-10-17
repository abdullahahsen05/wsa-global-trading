// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://app.wsa.test/terminal"}
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TerminalWorkspace } from "@/components/trading/TerminalWorkspace";
import { TradingAccountSelectionProvider } from "@/providers/TradingAccountSelectionProvider";
import { defaultWatchlist, defaultWorkspace, defaultWsaTrade } from "@/lib/terminal/workspace";
import type { MetaTraderTerminalAccount } from "@/lib/terminal/metatrader";
import { click, control, json, keyDown, mount, setValue, settle, submit, text, unmountAll, wait } from "./helpers/reactDom";

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: (props: { href: string; className?: string; children?: unknown }) =>
      h("a", { href: props.href, className: props.className }, props.children as never),
  };
});

vi.mock("framer-motion", async () => {
  const { createElement: h } = await import("react");
  const strip = new Set(["layout", "variants", "initial", "animate", "exit", "transition", "whileHover", "whileTap"]);
  // one stable component per tag, like the real library (a new type on every access would remount the tree)
  const cache = new Map<string, (props: Record<string, unknown>) => unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        let component = cache.get(tag);
        if (!component) {
          component = function MotionStub(props: Record<string, unknown>) {
            return h(tag, Object.fromEntries(Object.entries(props).filter(([key]) => !strip.has(key))));
          };
          cache.set(tag, component);
        }
        return component;
      },
    },
  );
  return { motion };
});

const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const ACCOUNTS: MetaTraderTerminalAccount[] = [
  {
    accountId: A1,
    accountName: "Alpha",
    brokerName: "IC Markets",
    platform: "MT5",
    server: "ICMarketsSC-Demo",
    loginMasked: "••••2222",
    currency: "USD",
    status: "CONNECTED",
    canLaunch: true,
    unavailableReason: null,
  },
];

const LAUNCH_TARGET = {
  accountId: A1,
  accountName: "Alpha",
  brokerName: "IC Markets",
  platform: "MT5",
  server: "ICMarketsSC-Demo",
  login: "11112222",
};

/** What the WSA Trade routes answer: one connected account with a single open position. */
const TRADE_ACCOUNTS = {
  accounts: [
    {
      accountId: A1,
      name: "Alpha",
      broker: "IC Markets",
      platform: "MT5",
      server: "ICMarketsSC-Demo",
      currency: "USD",
      status: "CONNECTED",
      reachable: true,
    },
  ],
  gate: { canOpen: true, canManage: true, reason: null, message: null },
  route: "gateway",
};

const TRADE_STATE = {
  accountId: A1,
  currency: "USD",
  balance: 10000,
  equity: 10050,
  floatingProfit: 50,
  margin: 200,
  freeMargin: 9850,
  marginLevel: 5025,
  positions: [
    {
      ticket: "9001",
      symbol: "XAUUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 2300.5,
      stopLoss: 2290,
      takeProfit: null,
      profit: 50,
      swap: 0,
      commission: 0,
      openedAt: "2026-10-12T09:00:00.000Z",
      comment: null,
    },
  ],
  pending: [],
  pendingOrders: 0,
  quote: { symbol: "XAUUSD", bid: 2301.1, ask: 2301.4 },
  readOnly: false,
  riskBlocked: false,
  riskMessage: null,
  fetchedAt: "2026-10-12T09:30:00.000Z",
  route: "gateway",
  delayed: false,
};

/** The symbols of the account's broker - spelled the way that broker spells them. */
const TRADE_SYMBOLS = {
  symbols: [
    { name: "XAUUSD", description: "Gold vs US Dollar", path: "Metals\\XAUUSD", digits: 2 },
    { name: "EURUSD.m", description: "Euro vs US Dollar", path: "Forex\\EURUSD.m", digits: 5 },
    { name: "GBPUSD.m", description: "Pound vs US Dollar", path: "Forex\\GBPUSD.m", digits: 5 },
    { name: "US30.cash", description: "Wall Street 30", path: "Indices\\US30.cash", digits: 2 },
  ],
  updatedAt: null,
  route: "gateway",
};

const MANUAL = { id: "manual-0001", label: "Challenge", platform: "MT5", login: "7654321", server: "FTMO-Server" };

/** What the platform answers when it has found the broker's own web terminal. */
const FOUND_TERMINAL = {
  serverKey: "icmarketssc",
  status: "FOUND",
  url: "https://webtrader.icmarkets.com/",
  host: "webtrader.icmarkets.com",
  source: "DISCOVERED",
  embeddable: true,
  brokerName: "IC Markets",
  checkedAt: "2026-10-12T00:00:00.000Z",
};

interface FetchOptions {
  workspace?: unknown;
  persisted?: boolean;
  storage?: "ok" | "unavailable";
  patch?: "ok" | "error" | "unavailable";
  terminal?: Record<string, unknown>;
  /** the broker's symbol list is answered (without it the order panel has a plain text box) */
  symbols?: boolean;
}

// request bodies are inspected field by field, so they are deliberately loose
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseBody = any;

const calls: Array<{ url: string; method: string; body: LooseBody }> = [];
const patches = () => calls.filter((call) => call.url === "/api/terminal/workspace" && call.method === "PATCH");

function installFetch(options: FetchOptions = {}) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (url.startsWith("/api/terminal/workspace")) {
        if (method === "PATCH") {
          if (options.patch === "error") return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "boom" } }, 500);
          if (options.patch === "unavailable") {
            return json({ ok: false, error: { code: "TERMINAL_STORAGE_UNAVAILABLE", message: "no table" } }, 503);
          }
          return json({ ok: true, data: { persisted: true, storage: "ok" } });
        }
        return json({
          ok: true,
          data: {
            workspace: options.workspace ?? defaultWorkspace(),
            persisted: options.persisted ?? false,
            storage: options.storage ?? "ok",
          },
        });
      }
      if (url.startsWith("/api/terminal/metatrader/accounts")) return json({ ok: true, data: { accounts: ACCOUNTS } });
      if (url.startsWith("/api/terminal/metatrader/launch")) return json({ ok: true, data: LAUNCH_TARGET });
      if (url.startsWith("/api/terminal/metatrader/resolve")) {
        return json({ ok: true, data: { ...FOUND_TERMINAL, ...options.terminal } });
      }
      if (url.startsWith("/api/terminal/trade/accounts")) return json({ ok: true, data: TRADE_ACCOUNTS });
      if (url.startsWith("/api/terminal/trade/state")) return json({ ok: true, data: TRADE_STATE });
      if (url.startsWith("/api/terminal/trade/symbols") && options.symbols) return json({ ok: true, data: TRADE_SYMBOLS });
      if (url.startsWith("/api/ai/chart-assistant")) return json({ ok: true, data: { screenshotsEnabled: false } });
      return json({ ok: false, error: { code: "NOT_FOUND", message: url } }, 404);
    }),
  );
}

function mountWorkspace() {
  return mount(createElement(TradingAccountSelectionProvider, null, createElement(TerminalWorkspace)));
}

/** The tabs of the terminal itself (the order panel has tab lists of its own: order type, positions). */
const terminalTabs = (container: ParentNode) =>
  Array.from(container.querySelectorAll<HTMLElement>("[role='tablist'][aria-label='Terminal view'] [role='tab']"));

function tab(container: ParentNode, label: string): HTMLElement {
  const found = terminalTabs(container).find((item) => (item.textContent ?? "").includes(label));
  if (!found) throw new Error(`tab not found: ${label}`);
  return found;
}

const selectedTab = (container: ParentNode) =>
  terminalTabs(container)
    .filter((item) => item.getAttribute("aria-selected") === "true")
    .map((item) => item.textContent?.trim());

/** The order panel's symbol box. */
const symbolBox = (container: ParentNode) => container.querySelector<HTMLInputElement>("input[role='combobox']");

const tvPane = (container: ParentNode) => container.querySelector<HTMLElement>("#terminal-pane-tradingview");
const mtPane = (container: ParentNode) => container.querySelector<HTMLElement>("#terminal-pane-metatrader");
const wtPane = (container: ParentNode) => container.querySelector<HTMLElement>("#terminal-pane-wsatrade");

/** The configuration TradingView's embed script was given (it reads it from the script tag). */
function widgetConfig(container: ParentNode): Record<string, LooseBody> {
  const script = container.querySelector("script");
  if (!script) throw new Error("the TradingView widget has not been mounted");
  return JSON.parse(script.innerHTML) as Record<string, LooseBody>;
}

const STORED = {
  ...defaultWorkspace(),
  view: "split",
  split: "rows",
  // chart + MetaTrader, as a person who works with the broker's own terminal would have saved it
  splitWith: "metatrader",
  tradingview: {
    symbol: "NASDAQ:AAPL",
    timeframe: "1H",
    watchlist: ["NASDAQ:AAPL", "OANDA:EURUSD"],
    panels: { watchlist: true, details: true, hotlist: false },
  },
  metatrader: {
    source: "classic",
    customUrl: null,
    selection: { kind: "manual", id: MANUAL.id },
    manualAccounts: [MANUAL],
  },
};

beforeEach(() => {
  window.localStorage.clear();
  installFetch();
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("TerminalWorkspace - tabs", () => {
  test("opens as a trade section: the chart on the left with the saved watchlist, the WSA Trade panel on the right; MetaTrader is not created yet", async () => {
    const view = mountWorkspace();
    await settle();
    await wait(30);

    expect(terminalTabs(view.container).map((item) => item.textContent?.trim())).toEqual([
      "TradingView",
      "MetaTrader",
      "WSA Trade",
      "Split view",
    ]);
    expect(selectedTab(view.container)).toEqual(["Split view"]);
    expect(control(view.container, "Chart + WSA Trade")?.getAttribute("aria-pressed")).toBe("true");
    expect(control(view.container, "Side by side")?.getAttribute("aria-pressed")).toBe("true");
    expect(tvPane(view.container)).not.toBeNull();
    expect(wtPane(view.container)).not.toBeNull();
    expect(tvPane(view.container)?.hasAttribute("inert")).toBe(false);
    expect(wtPane(view.container)?.hasAttribute("inert")).toBe(false);
    expect(mtPane(view.container)).toBeNull();
    expect(view.container.querySelector("iframe")).toBeNull();

    // the chart gets the room, the order panel a column of its own
    const grid = tvPane(view.container)?.parentElement as HTMLElement;
    expect(grid.className).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]");
    expect(grid.className).not.toContain("lg:grid-cols-2");

    const config = widgetConfig(view.container);
    expect(config).toMatchObject({ symbol: "OANDA:XAUUSD", interval: "15", details: false, hotlist: false });
    expect(config.watchlist).toEqual(defaultWatchlist());
    // MA 50 + MA 200 on the price and no volume bars; the old, dead calendar switch is gone
    expect(config.hide_volume).toBe(true);
    expect(config.studies).toEqual([{ id: "STD;MA%1Cross", overlay: true, inputs: { in_0: 50, in_1: 200 } }]);
    expect(config).not.toHaveProperty("calendar");
    // no account is signed in and nothing is claimed about one
    expect(text(view.container)).toContain("Why can't I sign in to my TradingView account here?");
  });

  test("the MetaTrader tab creates its pane and puts the chart and the order panel in the background", async () => {
    const view = mountWorkspace();
    await settle();

    click(tab(view.container, "MetaTrader"));
    await settle();

    expect(selectedTab(view.container)).toEqual(["MetaTrader"]);
    const chart = tvPane(view.container);
    const orders = wtPane(view.container);
    const terminal = mtPane(view.container);
    expect(chart).not.toBeNull();
    expect(orders).not.toBeNull();
    expect(terminal).not.toBeNull();
    expect(chart?.hasAttribute("inert")).toBe(true);
    expect(chart?.getAttribute("aria-hidden")).toBe("true");
    expect(chart?.className).toContain("invisible");
    // the order panel is out of sight but not torn down
    expect(orders?.hasAttribute("inert")).toBe(true);
    expect(orders?.className).toContain("invisible");
    expect(terminal?.hasAttribute("inert")).toBe(false);
    expect(terminal?.getAttribute("aria-hidden")).toBeNull();
    expect(text(terminal as HTMLElement)).toContain("Open an account in the terminal");
    expect(text(terminal as HTMLElement)).toContain("Alpha");
  });

  test("switching tabs never reloads the terminal, the chart or the order panel", async () => {
    const view = mountWorkspace();
    await settle();
    await wait(30);
    const widget = view.container.querySelector("script");
    const orderPanel = wtPane(view.container)?.firstElementChild;
    expect(orderPanel).not.toBeNull();

    click(tab(view.container, "MetaTrader"));
    await settle();
    click(control(mtPane(view.container) as HTMLElement, "Open"));
    await settle();
    const frame = view.container.querySelector("iframe");
    expect(frame).not.toBeNull();

    click(tab(view.container, "TradingView"));
    await settle();
    expect(mtPane(view.container)?.hasAttribute("inert")).toBe(true);
    expect(tvPane(view.container)?.hasAttribute("inert")).toBe(false);
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(view.container.querySelector("script")).toBe(widget);

    click(tab(view.container, "MetaTrader"));
    await settle();
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(wtPane(view.container)?.firstElementChild).toBe(orderPanel);
    expect(calls.filter((call) => call.url.startsWith("/api/terminal/metatrader/launch"))).toHaveLength(1);
  });

  test("the split view shows the chart with one partner at a time, side by side or stacked", async () => {
    const view = mountWorkspace();
    await settle();

    // the trade section is the split view already
    expect(selectedTab(view.container)).toEqual(["Split view"]);
    const grid = tvPane(view.container)?.parentElement as HTMLElement;
    expect(grid.className).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]");

    click(control(view.container, "Stacked"));
    await settle();
    expect(grid.className).not.toContain("lg:grid-cols-");
    expect(grid.className).toContain("grid");
    expect(control(view.container, "Stacked")?.getAttribute("aria-pressed")).toBe("true");

    click(control(view.container, "Side by side"));
    await settle();
    expect(grid.className).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]");

    // the broker's web terminal needs the width: two equal halves
    click(control(view.container, "Chart + MetaTrader"));
    await settle();
    expect(grid.className).toContain("lg:grid-cols-2");
    expect(grid.className).not.toContain("minmax(380px,440px)");
    expect(tvPane(view.container)?.hasAttribute("inert")).toBe(false);
    expect(mtPane(view.container)?.hasAttribute("inert")).toBe(false);

    // the layout controls only exist in the split view
    click(tab(view.container, "TradingView"));
    await settle();
    expect(control(view.container, "Stacked")).toBeNull();
    expect(control(view.container, "Chart + WSA Trade")).toBeNull();
  });

  test("the order panel reads the connected account for the symbol of its ticket", async () => {
    const view = mountWorkspace();
    await settle();
    await wait(30);

    const panel = wtPane(view.container) as HTMLElement;
    expect(panel.hasAttribute("inert")).toBe(false);
    expect(text(panel)).toContain("Alpha");
    expect(text(panel)).toContain("XAUUSD");
    expect(text(panel)).toContain("Positions (1)");
    expect(text(panel)).toContain("Bid 2301.1 · Ask 2301.4");
    expect(text(panel)).toContain("WSA trading system");
    const stateCall = calls.find((call) => call.url.startsWith("/api/terminal/trade/state"));
    expect(stateCall?.url).toContain(`accountId=${A1}`);
    expect(stateCall?.url).toContain("symbol=XAUUSD");
    // the broker's symbols are asked for the same account
    expect(calls.some((call) => call.url === `/api/terminal/trade/symbols?accountId=${A1}`)).toBe(true);
    // the MetaTrader terminal is not created and not asked for anything
    expect(calls.filter((call) => call.url.startsWith("/api/terminal/metatrader"))).toHaveLength(0);
  });

  test("the WSA Trade tab shows the panel alone and puts the chart in the background", async () => {
    const view = mountWorkspace();
    await settle();

    click(tab(view.container, "WSA Trade"));
    await settle();
    await wait(30);

    expect(selectedTab(view.container)).toEqual(["WSA Trade"]);
    const panel = wtPane(view.container) as HTMLElement;
    expect(panel.hasAttribute("inert")).toBe(false);
    expect(text(panel)).toContain("Positions (1)");
    expect(tvPane(view.container)?.hasAttribute("inert")).toBe(true);
    expect(tvPane(view.container)?.className).toContain("invisible");
    expect(mtPane(view.container)).toBeNull();
    // alone it is a pane of its own, not a column next to the chart
    expect(panel.className).toContain("relative");
    // and back to the trade section: the chart is on screen again, nothing was rebuilt
    click(tab(view.container, "Split view"));
    await settle();
    expect(tvPane(view.container)?.hasAttribute("inert")).toBe(false);
    expect(wtPane(view.container)?.hasAttribute("inert")).toBe(false);
  });

  test("in the split view the chart can sit next to WSA Trade or next to MetaTrader; the other pane stays mounted", async () => {
    const view = mountWorkspace();
    await settle();

    expect(control(view.container, "Chart + WSA Trade")?.getAttribute("aria-pressed")).toBe("true");
    expect(wtPane(view.container)?.hasAttribute("inert")).toBe(false);
    expect(mtPane(view.container)).toBeNull();

    click(control(view.container, "Chart + MetaTrader"));
    await settle();
    await wait(30);

    expect(control(view.container, "Chart + MetaTrader")?.getAttribute("aria-pressed")).toBe("true");
    expect(mtPane(view.container)?.hasAttribute("inert")).toBe(false);
    expect(tvPane(view.container)?.hasAttribute("inert")).toBe(false);
    // the order panel is out of sight but not torn down
    const orders = wtPane(view.container) as HTMLElement;
    expect(orders).not.toBeNull();
    expect(orders.hasAttribute("inert")).toBe(true);
    expect(orders.className).toContain("invisible");
    expect(orders.className).toContain("absolute");
    expect((tvPane(view.container)?.parentElement as HTMLElement).className).toContain("relative");

    click(control(view.container, "Chart + WSA Trade"));
    await settle();
    expect(wtPane(view.container)?.hasAttribute("inert")).toBe(false);
    // the MetaTrader terminal is out of sight but not torn down (its session would be lost)
    const terminal = mtPane(view.container) as HTMLElement;
    expect(terminal).not.toBeNull();
    expect(terminal.hasAttribute("inert")).toBe(true);
    expect(terminal.className).toContain("invisible");
    expect(terminal.className).toContain("absolute");
  });

  test("arrow keys move between the tabs", async () => {
    const view = mountWorkspace();
    await settle();

    keyDown(tab(view.container, "TradingView"), "ArrowRight");
    await settle();
    expect(selectedTab(view.container)).toEqual(["MetaTrader"]);
    expect(document.activeElement).toBe(tab(view.container, "MetaTrader"));

    keyDown(tab(view.container, "MetaTrader"), "ArrowRight");
    await settle();
    expect(selectedTab(view.container)).toEqual(["WSA Trade"]);

    keyDown(tab(view.container, "WSA Trade"), "End");
    await settle();
    expect(selectedTab(view.container)).toEqual(["Split view"]);

    keyDown(tab(view.container, "Split view"), "ArrowRight");
    await settle();
    expect(selectedTab(view.container)).toEqual(["TradingView"]);

    keyDown(tab(view.container, "TradingView"), "ArrowLeft");
    await settle();
    expect(selectedTab(view.container)).toEqual(["Split view"]);
  });

  test("only the selected tab is in the tab order", async () => {
    const view = mountWorkspace();
    await settle();
    const tabIndexes = terminalTabs(view.container).map((item) => item.getAttribute("tabindex"));
    expect(tabIndexes).toEqual(["-1", "-1", "-1", "0"]);
  });
});

describe("TerminalWorkspace - chart and order panel on the same instrument", () => {
  async function mountWithSymbols() {
    installFetch({ symbols: true });
    const view = mountWorkspace();
    await settle();
    await wait(30);
    return view;
  }

  /** the broker's symbol list must have arrived before a symbol is searched in it */
  async function listed(view: ReturnType<typeof mountWorkspace>) {
    for (let attempt = 0; attempt < 10 && !calls.some((call) => call.url.startsWith("/api/terminal/trade/symbols")); attempt += 1) {
      await wait(20);
    }
    await settle();
    expect(symbolBox(view.container)?.value).toBe("XAUUSD");
  }

  test("a symbol picked in the order panel opens on the chart, in the broker's spelling on the panel", async () => {
    const view = await mountWithSymbols();
    await listed(view);
    expect(widgetConfig(view.container).symbol).toBe("OANDA:XAUUSD");

    const box = symbolBox(view.container);
    setValue(box, "eurusd");
    keyDown(box, "Enter");
    await settle();
    await wait(30);

    // the panel trades the broker's own name, the chart shows the matching TradingView instrument
    expect(symbolBox(view.container)?.value).toBe("EURUSD.m");
    expect(widgetConfig(view.container).symbol).toBe("OANDA:EURUSD");
    expect(calls.some((call) => call.url.startsWith("/api/terminal/trade/state") && call.url.includes("symbol=EURUSD.m"))).toBe(true);

    await wait(900);
    expect(patches().at(-1)?.body).toEqual({
      workspace: { wsatrade: { symbol: "EURUSD.m" }, tradingview: { symbol: "OANDA:EURUSD" } },
    });
  });

  test("a symbol picked on the chart selects the matching symbol of the broker in the panel", async () => {
    const view = await mountWithSymbols();
    await listed(view);

    const picker = view.container.querySelector<HTMLSelectElement>("#trading-chart-symbol");
    expect(Array.from(picker?.options ?? []).map((option) => option.value)).toContain("OANDA:EURUSD");
    setValue(picker, "OANDA:EURUSD");
    await settle();
    await wait(30);

    expect(widgetConfig(view.container).symbol).toBe("OANDA:EURUSD");
    expect(symbolBox(view.container)?.value).toBe("EURUSD.m");
    expect(calls.some((call) => call.url.startsWith("/api/terminal/trade/state") && call.url.includes("symbol=EURUSD.m"))).toBe(true);

    await wait(900);
    expect(patches().at(-1)?.body).toEqual({
      workspace: { tradingview: { symbol: "OANDA:EURUSD" }, wsatrade: { symbol: "EURUSD.m" } },
    });
  });

  test("the chart's watchlist becomes one-click symbols of the panel, spelled the way the broker spells them", async () => {
    const view = await mountWithSymbols();
    await listed(view);

    const chips = view.container.querySelector("[aria-label='Symbols from your chart watchlist']");
    expect(chips).not.toBeNull();
    const names = Array.from((chips as Element).querySelectorAll("button")).map((item) => item.textContent?.trim());
    // the default watchlist has EURUSD and gold; this broker spells them EURUSD.m and XAUUSD
    expect(names).toContain("EURUSD.m");
    expect(names).toContain("XAUUSD");
    expect(names).not.toContain("EURUSD");

    click(control(chips as Element, "EURUSD.m"));
    await settle();
    await wait(30);
    expect(symbolBox(view.container)?.value).toBe("EURUSD.m");
    expect(widgetConfig(view.container).symbol).toBe("OANDA:EURUSD");
  });

  test("without a symbol list the panel is a plain text box and nothing on the chart changes by itself", async () => {
    const view = mountWorkspace();
    await settle();
    await wait(30);

    expect(text(view.container)).toContain("The broker's symbol list could not be loaded");
    const picker = view.container.querySelector<HTMLSelectElement>("#trading-chart-symbol");
    setValue(picker, "OANDA:EURUSD");
    await settle();
    await wait(30);

    expect(widgetConfig(view.container).symbol).toBe("OANDA:EURUSD");
    // no list to search: the panel keeps its symbol and does not guess
    expect(symbolBox(view.container)?.value).toBe("XAUUSD");
    await wait(900);
    expect(patches().at(-1)?.body).toEqual({ workspace: { tradingview: { symbol: "OANDA:EURUSD" } } });
  });
});

describe("TerminalWorkspace - saved workspace", () => {
  test("restores the stored layout, chart settings and the account used last", async () => {
    installFetch({ workspace: STORED, persisted: true });
    const view = mountWorkspace();
    await settle();
    await wait(30);

    expect(selectedTab(view.container)).toEqual(["Split view"]);
    const config = widgetConfig(view.container);
    expect(config).toMatchObject({ symbol: "NASDAQ:AAPL", interval: "60", details: true });
    expect(config.watchlist).toEqual(["NASDAQ:AAPL", "OANDA:EURUSD"]);

    // the account added by hand opens on its own
    const frame = view.container.querySelector("iframe");
    expect(frame).not.toBeNull();
    const params = Object.fromEntries(new URL(frame?.getAttribute("src") ?? "").searchParams);
    expect(params).toMatchObject({ login: "7654321", trade_server: "FTMO-Server", servers: "FTMO-Server", startup_version: "5" });

    // stacked, as saved
    expect((tvPane(view.container)?.parentElement as HTMLElement).className).not.toContain("lg:grid-cols-2");
  });

  test("the device-local copy leaves accounts out", async () => {
    installFetch({ workspace: STORED, persisted: true });
    mountWorkspace();
    await settle();

    const local = JSON.parse(window.localStorage.getItem("wsa.terminal.workspace.v1") ?? "null");
    expect(local).not.toBeNull();
    expect(local.view).toBe("split");
    expect(local.tradingview.symbol).toBe("NASDAQ:AAPL");
    expect(local.metatrader.manualAccounts).toEqual([]);
    expect(local.metatrader.selection).toBeNull();
    expect(JSON.stringify(local)).not.toContain("7654321");
  });

  test("the device-local copy keeps the WSA Trade ticket settings and trade rules but not the account", async () => {
    installFetch({
      workspace: {
        ...STORED,
        wsatrade: {
          accountId: A1,
          symbol: "EURUSD.m",
          volume: 0.25,
          orderKind: "LIMIT",
          confirm: false,
          levelMode: "points",
          stopLossPoints: 300,
          takeProfitPoints: 600,
          requireStopLoss: true,
          maxVolume: 2,
        },
      },
      persisted: true,
    });
    mountWorkspace();
    await settle();

    const local = JSON.parse(window.localStorage.getItem("wsa.terminal.workspace.v1") ?? "null");
    expect(local.wsatrade).toEqual({
      ...defaultWsaTrade(),
      accountId: null,
      symbol: "EURUSD.m",
      volume: 0.25,
      orderKind: "LIMIT",
      confirm: false,
      levelMode: "points",
      stopLossPoints: 300,
      takeProfitPoints: 600,
      requireStopLoss: true,
      maxVolume: 2,
    });
    expect(JSON.stringify(local)).not.toContain(A1);
  });

  test("a tab change is saved once, after a short pause, as a small patch", async () => {
    const view = mountWorkspace();
    await settle();

    click(tab(view.container, "MetaTrader"));
    click(tab(view.container, "Split view"));
    expect(patches()).toHaveLength(0);

    await wait(900);
    expect(patches().map((call) => call.body)).toEqual([{ workspace: { view: "split" } }]);
    expect(text(view.container)).toContain("Layout saved");
  });

  test("picking an account is saved as a selection - never with a password", async () => {
    const view = mountWorkspace();
    await settle();
    click(tab(view.container, "MetaTrader"));
    await settle();
    click(control(mtPane(view.container) as HTMLElement, "Open"));
    await settle();
    await wait(900);

    const body = patches().map((call) => call.body);
    expect(body).toEqual([
      { workspace: { view: "metatrader", metatrader: { selection: { kind: "platform", accountId: A1 } } } },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/password/i);
  });

  test("when the database can not store it, the layout stays on this device and the user is told", async () => {
    installFetch({ patch: "unavailable" });
    const view = mountWorkspace();
    await settle();

    click(tab(view.container, "MetaTrader"));
    await wait(900);

    expect(patches()).toHaveLength(1);
    expect(text(view.container)).toContain("Saved on this device only");
    expect(JSON.parse(window.localStorage.getItem("wsa.terminal.workspace.v1") ?? "{}").view).toBe("metatrader");
  });

  test("a deployment without storage says so from the start", async () => {
    installFetch({ storage: "unavailable" });
    const view = mountWorkspace();
    await settle();
    expect(text(view.container)).toContain("Saved on this device only");
  });

  test("a failed save is reported, kept, and not retried in a loop", async () => {
    installFetch({ patch: "error" });
    const view = mountWorkspace();
    await settle();

    click(tab(view.container, "MetaTrader"));
    await wait(900);
    await wait(900);

    expect(patches()).toHaveLength(1);
    expect(text(view.container)).toContain("Could not save");
  });

  test("the saved copy of a broken workspace never breaks the page", async () => {
    installFetch({ workspace: { view: 42, tradingview: "oops", metatrader: [], wsatrade: 7 }, persisted: true });
    const view = mountWorkspace();
    await settle();
    // a broken copy opens as the trade section
    expect(selectedTab(view.container)).toEqual(["Split view"]);
    expect(tvPane(view.container)).not.toBeNull();
    expect(wtPane(view.container)).not.toBeNull();
  });

  test("a layout saved before the trade section existed (the bare chart next to MetaTrader) opens as the trade section", async () => {
    installFetch({
      workspace: { version: 2, view: "tradingview", split: "columns", splitWith: "metatrader" },
      persisted: true,
    });
    const view = mountWorkspace();
    await settle();
    expect(selectedTab(view.container)).toEqual(["Split view"]);
    expect(control(view.container, "Chart + WSA Trade")?.getAttribute("aria-pressed")).toBe("true");
    expect(wtPane(view.container)).not.toBeNull();
  });

  test("a layout the person chose is not touched: the bare chart tab stays when it was picked on purpose", async () => {
    installFetch({
      workspace: { version: 3, view: "tradingview", split: "columns", splitWith: "metatrader" },
      persisted: true,
    });
    const view = mountWorkspace();
    await settle();
    expect(selectedTab(view.container)).toEqual(["TradingView"]);
    expect(tvPane(view.container)?.hasAttribute("inert")).toBe(false);
    expect(mtPane(view.container)).toBeNull();
    // the order panel may have been created while the stored layout was still being read; hidden, it asks the broker nothing
    expect(calls.filter((call) => call.url.startsWith("/api/terminal/trade/state"))).toHaveLength(0);
    expect(control(view.container, "Chart + WSA Trade")).toBeNull();
  });
});

describe("TerminalWorkspace - TradingView chart settings", () => {
  async function openChart() {
    const view = mountWorkspace();
    await settle();
    await wait(30);
    return view;
  }

  test("the symbol picker lists the watchlist; choosing one rebuilds the widget and is saved", async () => {
    installFetch({ workspace: STORED, persisted: true });
    const view = mountWorkspace();
    await settle();
    await wait(30);

    const picker = view.container.querySelector<HTMLSelectElement>("#trading-chart-symbol");
    expect(Array.from(picker?.options ?? []).map((option) => option.textContent)).toEqual(["AAPL", "EURUSD"]);

    setValue(picker, "OANDA:EURUSD");
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).symbol).toBe("OANDA:EURUSD");

    await wait(900);
    expect(patches().at(-1)?.body).toEqual({ workspace: { tradingview: { symbol: "OANDA:EURUSD" } } });
  });

  test("panel buttons switch the widget's side panels", async () => {
    const view = await openChart();
    expect(widgetConfig(view.container).details).toBe(false);
    // the economic-calendar switch did nothing in the widget and is gone
    expect(control(view.container, "Calendar")).toBeNull();

    click(control(view.container, "Details"));
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).details).toBe(true);
    expect(control(view.container, "Details")?.getAttribute("aria-pressed")).toBe("true");

    click(control(view.container, "Watchlist"));
    await settle();
    await wait(30);
    expect("watchlist" in widgetConfig(view.container)).toBe(false);

    await wait(900);
    expect(patches().at(-1)?.body).toEqual({
      workspace: { tradingview: { panels: { details: true, watchlist: false } } },
    });
  });

  test("timeframe buttons change the interval", async () => {
    const view = await openChart();
    click(control(view.container, "4H"));
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).interval).toBe("240");

    click(control(view.container, "1W"));
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).interval).toBe("W");
  });

  function option(container: ParentNode, label: string): HTMLInputElement | null {
    const box = Array.from(container.querySelectorAll<HTMLLabelElement>("label")).find(
      (item) => (item.textContent ?? "").trim() === label,
    );
    return box?.querySelector("input") ?? null;
  }

  test("the options panel changes the chart, rebuilds it and saves the choices", async () => {
    const view = await openChart();
    expect(widgetConfig(view.container)).toMatchObject({ hide_volume: true, style: "1" });
    expect(control(view.container, "Chart options")?.getAttribute("aria-expanded")).toBe("false");

    click(control(view.container, "Chart options"));
    expect(control(view.container, "Chart options")?.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector("[aria-label='Chart options']")).not.toBeNull();

    // volume is a choice now, not a default
    click(option(view.container, "Volume"));
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).hide_volume).toBe(false);

    setValue(view.container.querySelector("select[id$='-style']"), "line");
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).style).toBe("2");

    // MA 50 / MA 200 is on; RSI is added next to it, then the pair is switched off
    expect(control(view.container, "MA 50 / MA 200")?.getAttribute("aria-pressed")).toBe("true");
    click(control(view.container, "RSI (14)"));
    await settle();
    await wait(30);
    expect((widgetConfig(view.container).studies as Array<{ id: string }>).map((study) => study.id)).toEqual([
      "STD;MA%1Cross",
      "STD;RSI",
    ]);
    click(control(view.container, "MA 50 / MA 200"));
    await settle();
    await wait(30);
    expect((widgetConfig(view.container).studies as Array<{ id: string }>).map((study) => study.id)).toEqual(["STD;RSI"]);

    await wait(900);
    expect(patches().at(-1)?.body).toEqual({
      workspace: { tradingview: { chart: { volume: true, style: "line", indicators: ["rsi"] } } },
    });
  });

  test("at most five indicators can be chosen", async () => {
    const view = await openChart();
    click(control(view.container, "Chart options"));
    for (const label of ["EMA 20", "Bollinger Bands", "VWAP", "Supertrend"]) {
      click(control(view.container, label));
      await settle();
    }
    // five are on (the default pair counts as one): everything else is locked
    expect(control(view.container, "RSI (14)")?.hasAttribute("disabled")).toBe(true);
    expect(control(view.container, "EMA 20")?.hasAttribute("disabled")).toBe(false);
    expect(text(view.container)).toContain("Indicators (5 / 5)");
  });

  test("symbols can be compared on the chart; bad and extra symbols are refused", async () => {
    const view = await openChart();
    click(control(view.container, "Chart options"));
    const input = view.container.querySelector<HTMLInputElement>("input[placeholder^='Symbol to plot']");
    const form = input?.closest("form") ?? null;

    setValue(input, "bad symbol");
    submit(form);
    expect(text(view.container)).toContain("Use the TradingView symbol");

    setValue(input, "oanda:eurusd");
    submit(form);
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).compareSymbols).toEqual([{ symbol: "OANDA:EURUSD", position: "SameScale" }]);

    setValue(input, "OANDA:EURUSD");
    submit(form);
    expect(text(view.container)).toContain("OANDA:EURUSD is already compared.");

    for (const symbol of ["NASDAQ:AAPL", "NASDAQ:MSFT"]) {
      setValue(input, symbol);
      submit(form);
      await settle();
    }
    setValue(input, "NASDAQ:TSLA");
    submit(form);
    expect(text(view.container)).toContain("You can compare up to 3 symbols");

    click(view.container.querySelector("button[aria-label='Stop comparing EURUSD']"));
    await settle();
    await wait(30);
    expect((widgetConfig(view.container).compareSymbols as Array<{ symbol: string }>).map((entry) => entry.symbol)).toEqual([
      "NASDAQ:AAPL",
      "NASDAQ:MSFT",
    ]);
  });

  test("tools and buttons of the chart can be switched off, and all options reset", async () => {
    const view = await openChart();
    click(control(view.container, "Chart options"));

    click(option(view.container, "Drawing tools"));
    click(option(view.container, "Legend"));
    click(option(view.container, "Screenshot button"));
    await settle();
    await wait(30);
    expect(widgetConfig(view.container)).toMatchObject({ hide_side_toolbar: true, hide_legend: true, save_image: true });

    setValue(view.container.querySelector("select[id$='-timezone']"), "Europe/Berlin");
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).timezone).toBe("Europe/Berlin");

    click(control(view.container, "Reset options"));
    await settle();
    await wait(30);
    expect(widgetConfig(view.container)).toMatchObject({
      hide_side_toolbar: false,
      hide_legend: false,
      save_image: false,
      timezone: "Etc/UTC",
      hide_volume: true,
    });
  });

  test("the watchlist editor adds, rejects and removes symbols", async () => {
    const view = await openChart();

    click(control(view.container, "Edit watchlist"));
    const input = view.container.querySelector<HTMLInputElement>("input[placeholder^='Add a symbol']");
    const form = input?.closest("form") ?? null;
    expect(input).not.toBeNull();

    setValue(input, "bad symbol");
    submit(form);
    expect(text(view.container)).toContain("Use the TradingView symbol");

    setValue(input, "oanda:eurusd");
    submit(form);
    expect(text(view.container)).toContain("OANDA:EURUSD is already in your watchlist.");

    setValue(input, "nasdaq:tsla");
    submit(form);
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).watchlist).toContain("NASDAQ:TSLA");
    expect(text(view.container)).toContain("9 / 30");

    click(view.container.querySelector("button[aria-label='Remove TSLA from the watchlist']"));
    await settle();
    await wait(30);
    expect(widgetConfig(view.container).watchlist).not.toContain("NASDAQ:TSLA");

    await wait(900);
    const saved = patches().at(-1)?.body.workspace.tradingview.watchlist as string[];
    expect(saved).toEqual(defaultWatchlist());
  });

  test("the watchlist can be restored to the defaults after a confirmation", async () => {
    installFetch({ workspace: STORED, persisted: true });
    const view = mountWorkspace();
    await settle();
    await wait(30);

    click(control(view.container, "Edit watchlist"));
    click(control(view.container, "Defaults"));
    expect(text(view.container)).toContain("Replace your list with the defaults?");
    click(control(view.container, "Yes"));
    await settle();
    await wait(30);

    expect(widgetConfig(view.container).watchlist).toEqual(defaultWatchlist());
  });

  test("'Open on TradingView' is a plain new-tab link to the same chart", async () => {
    const view = await openChart();
    const link = control(view.container, "Open on TradingView");
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("https://www.tradingview.com/chart/?symbol=OANDA%3AXAUUSD&interval=15");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  test("the required TradingView attribution link is rebuilt safely for the open symbol", async () => {
    installFetch({ workspace: STORED, persisted: true });
    const view = mountWorkspace();
    await settle();
    await wait(30);

    const attribution = view.container.querySelector<HTMLAnchorElement>(".tradingview-widget-copyright a");
    expect(attribution?.textContent).toBe("Chart by TradingView");
    expect(attribution?.getAttribute("href")).toBe("https://www.tradingview.com/symbols/NASDAQ-AAPL/");
    expect(attribution?.getAttribute("rel")).toContain("noopener");
  });
});
