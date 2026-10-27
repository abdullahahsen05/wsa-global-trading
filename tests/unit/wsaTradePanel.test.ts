// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://app.wsa.test/terminal"}
import { act, createElement, useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WsaTradePanel } from "@/components/trading/WsaTradePanel";
import { defaultWsaTrade, type WsaTradePatch, type WsaTradeWorkspace } from "@/lib/terminal/workspace";
import { OVERLAY_TTL_MS } from "@/lib/trade/stateOverlay";
import { click, json, keyDown, mount, setValue, settle, text, unmountAll } from "./helpers/reactDom";

const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

// request bodies and payloads are inspected field by field, so they are deliberately loose
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

// ─────────────────────────────────────────────────────────────────────────────
// What the server answers
// ─────────────────────────────────────────────────────────────────────────────

function tradeAccount(accountId: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    name,
    broker: "IC Markets",
    platform: "MT5",
    server: "ICMarketsSC-Demo",
    currency: "USD",
    status: "CONNECTED",
    reachable: true,
    ...overrides,
  };
}

const OPEN_GATE = { canOpen: true, canManage: true, reason: null, message: null };

function accountsResponse(
  accounts = [tradeAccount(A1, "Alpha")],
  gate: Record<string, unknown> = OPEN_GATE,
  route: string = "gateway",
) {
  return { accounts, gate, route };
}

/** A winning buy of gold with a stop loss under the entry. */
const POSITION = {
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
};
/** A losing sell of the euro. */
const LOSER = { ...POSITION, ticket: "9002", symbol: "EURUSD.m", side: "SELL", volume: 0.2, openPrice: 1.085, stopLoss: null, profit: -20 };
/** A small winning sell of gold. */
const SMALL_WIN = { ...POSITION, ticket: "9003", side: "SELL", volume: 0.05, openPrice: 2305, stopLoss: null, profit: 10 };

const PENDING_LIMIT = {
  ticket: "9101",
  symbol: "EURUSD.m",
  side: "BUY",
  kind: "LIMIT",
  volume: 0.2,
  price: 1.08,
  stopLoss: 1.07,
  takeProfit: null,
  placedAt: "2026-10-12T09:10:00.000Z",
  comment: null,
};
const PENDING_STOP = { ...PENDING_LIMIT, ticket: "9102", symbol: "XAUUSD", side: "SELL", kind: "STOP", volume: 0.1, price: 2280, stopLoss: null };

const QUOTES: Record<string, { bid: number; ask: number }> = {
  XAUUSD: { bid: 2301.1, ask: 2301.4 },
  "EURUSD.m": { bid: 1.085, ask: 1.0852 },
  "GBPUSD.m": { bid: 1.27, ask: 1.2703 },
};

function quoteFor(symbol: string | null) {
  const found = symbol ? QUOTES[symbol] : undefined;
  return found && symbol ? { symbol, ...found } : null;
}

function stateFor(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    currency: "USD",
    balance: 10000,
    equity: 10050,
    floatingProfit: 50,
    margin: 200,
    freeMargin: 9850,
    marginLevel: 5025,
    positions: [POSITION],
    pending: [],
    pendingOrders: 0,
    quote: quoteFor("XAUUSD"),
    readOnly: false,
    riskBlocked: false,
    riskMessage: null,
    fetchedAt: "2026-10-12T09:30:00.000Z",
    route: "gateway",
    delayed: false,
    ...overrides,
  };
}

/** The broker's own spelling: gold is XAUUSD, the euro carries the broker's ".m" mark. */
const SYMBOLS = {
  symbols: [
    { name: "XAUUSD", description: "Gold vs US Dollar", path: "Metals\\XAUUSD", digits: 2 },
    { name: "XAGUSD", description: "Silver vs US Dollar", path: "Metals\\XAGUSD", digits: 3 },
    { name: "EURUSD.m", description: "Euro vs US Dollar", path: "Forex\\EURUSD.m", digits: 5 },
    { name: "GBPUSD.m", description: "Pound vs US Dollar", path: "Forex\\GBPUSD.m", digits: 5 },
    { name: "US30.cash", description: "Wall Street 30", path: "Indices\\US30.cash", digits: 2 },
    { name: "BTCUSD", description: "Bitcoin vs US Dollar", path: "Crypto\\BTCUSD", digits: 2 },
  ],
  updatedAt: null,
  route: "gateway",
};

interface Scenario {
  accounts?: ReturnType<typeof accountsResponse>;
  state?: (accountId: string, symbol: string | null) => Response | Promise<Response>;
  /** the broker's symbol list; null = the request fails */
  symbols?: typeof SYMBOLS | null;
  order?: (action: string, body: Loose) => Response | Promise<Response>;
}

const calls: Array<{ url: string; method: string; body: Loose }> = [];
const orders = () => calls.filter((call) => call.method === "POST");
const stateCalls = () => calls.filter((call) => call.url.startsWith("/api/terminal/trade/state"));
const symbolCalls = () => calls.filter((call) => call.url.startsWith("/api/terminal/trade/symbols"));
const lastStateSymbol = () => new URL(stateCalls()[stateCalls().length - 1].url, "https://app.wsa.test").searchParams.get("symbol");

function installFetch(scenario: Scenario = {}) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (url.startsWith("/api/terminal/trade/accounts")) {
        return json({ ok: true, data: scenario.accounts ?? accountsResponse() });
      }
      if (url.startsWith("/api/terminal/trade/state")) {
        const params = new URL(url, "https://app.wsa.test").searchParams;
        const accountId = params.get("accountId") ?? "";
        const symbol = params.get("symbol");
        if (scenario.state) return scenario.state(accountId, symbol);
        return json({ ok: true, data: stateFor(accountId, { quote: quoteFor(symbol) }) });
      }
      if (url.startsWith("/api/terminal/trade/symbols")) {
        if (scenario.symbols === null) {
          return json({ ok: false, error: { code: "BROKER_ERROR", message: "The broker's symbols could not be read." } }, 502);
        }
        return json({ ok: true, data: scenario.symbols ?? SYMBOLS });
      }
      const action = /\/api\/terminal\/trade\/(open|modify|close|cancel|close-bulk)$/.exec(url)?.[1];
      if (action && method === "POST") {
        if (scenario.order) return scenario.order(action, body);
        return json({ ok: true, data: { ok: true, ticket: "9001" } });
      }
      return json({ ok: false, error: { code: "NOT_FOUND", message: url } }, 404);
    }),
  );
}

/** The state answer of a scenario with these positions and pending orders. */
function stateWith(positions: unknown[], pending: unknown[] = [], extra: Record<string, unknown> = {}) {
  return (accountId: string, symbol: string | null) =>
    json({
      ok: true,
      data: stateFor(accountId, { quote: quoteFor(symbol), positions, pending, pendingOrders: pending.length, ...extra }),
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mounting
// ─────────────────────────────────────────────────────────────────────────────

interface HarnessProps {
  initial?: Partial<WsaTradeWorkspace>;
  active?: boolean;
  workspaceLoaded?: boolean;
  suggested?: string | null;
  onChange?: (patch: WsaTradePatch) => void;
  chartSymbol?: string | null;
  chartWatchlist?: ReadonlyArray<string>;
  onChartSymbol?: (symbol: string) => void;
}

/** The panel with the saved settings held in state, the way the terminal workspace holds them. */
function Harness(props: HarnessProps) {
  const [settings, setSettings] = useState<WsaTradeWorkspace>({ ...defaultWsaTrade(), ...props.initial });
  return createElement(WsaTradePanel, {
    settings,
    onSettingsChange: (patch: WsaTradePatch) => {
      props.onChange?.(patch);
      setSettings((current) => ({ ...current, ...patch }));
    },
    active: props.active ?? true,
    workspaceLoaded: props.workspaceLoaded ?? true,
    suggestedAccountId: props.suggested === undefined ? A1 : props.suggested,
    height: "640px",
    chartSymbol: props.chartSymbol,
    chartWatchlist: props.chartWatchlist,
    onChartSymbol: props.onChartSymbol,
  });
}

const harness = (props: HarnessProps): ReactElement => createElement(Harness, props);

async function mountPanel(props: HarnessProps = {}) {
  const view = mount(harness(props));
  await settle(6);
  return view;
}

type PanelView = Awaited<ReturnType<typeof mountPanel>>;

// ─────────────────────────────────────────────────────────────────────────────
// Finding things
// ─────────────────────────────────────────────────────────────────────────────

/** The text box a label (exact text) belongs to. */
function field(container: ParentNode, label: string): HTMLInputElement {
  const found = Array.from(container.querySelectorAll("label")).find((item) => (item.textContent ?? "").trim() === label);
  if (!found) throw new Error(`label not found: ${label}`);
  const input = document.getElementById(found.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`field not found: ${label}`);
  return input;
}

/** The check box of a switch whose text contains `label`. */
function toggle(container: ParentNode, label: string): HTMLInputElement {
  const found = Array.from(container.querySelectorAll("label")).find((item) => (item.textContent ?? "").includes(label));
  const input = found ? document.getElementById(found.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`switch not found: ${label}`);
  return input;
}

/** A button by its exact visible text. */
function button(container: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (item) => (item.textContent ?? "").replace(/\s+/g, " ").trim() === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

const byLabel = (container: ParentNode, label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

function sureButton(container: ParentNode, label: string): HTMLButtonElement {
  const found = byLabel(container, label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function tabIn(container: ParentNode, list: string, name: string): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>(`[role='tablist'][aria-label='${list}'] [role='tab']`)).find((item) =>
    (item.textContent ?? "").trim().startsWith(name),
  );
  if (!found) throw new Error(`tab not found: ${list} / ${name}`);
  return found;
}

/** Positions / Pending / Activity */
const bookTab = (container: ParentNode, name: string) => tabIn(container, "Positions and orders", name);
/** Market / Limit / Stop */
const kindTab = (container: ParentNode, name: string) => tabIn(container, "Order type", name);

const alerts = (container: ParentNode) =>
  Array.from(container.querySelectorAll("[role='alert']"))
    .map((item) => text(item))
    .join(" | ");

/** A button is the command: nothing on screen asks the person to confirm, keep or cancel an order. */
function expectNoConfirmation(container: ParentNode) {
  expect(container.querySelector("[aria-label='Confirm order']")).toBeNull();
  const content = text(container);
  expect(content).not.toMatch(/confirm/i);
  expect(content).not.toContain("Keep it");
  expect(content).not.toMatch(/Yes, (close|delete)/);
  expect(content).not.toMatch(/(Close|Delete) \d+ [a-z ]*\?/);
}

/** The result line of the last command (the green status box), found by its sentence. */
function resultNotice(container: ParentNode, sentence: string): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>("[role='status']")).find((item) =>
    (item.textContent ?? "").includes(sentence),
  );
  if (!found) throw new Error(`no result line: ${sentence}`);
  return found;
}

const symbolBox = (container: ParentNode) => field(container, "Symbol");
const options = (container: ParentNode) => Array.from(container.querySelectorAll<HTMLElement>("[role='option']"));

/** Leaving a text box (React listens to `focusout`). */
function blur(element: Element) {
  act(() => {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

/** One click on Buy: that is the whole order. */
async function buyAtMarket(view: PanelView) {
  click(sureButton(view.container, "Buy XAUUSD at market"));
  await settle();
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// What is shown
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - what is shown", () => {
  test("shows the account figures, the price and spread of the symbol and the open positions", async () => {
    const view = await mountPanel();
    const content = text(view.container);

    expect(content).toContain("WSA Trade");
    expect(content).toContain("10,000.00 USD");
    expect(content).toContain("10,050.00 USD");
    expect(content).toContain("+50.00");
    expect(content).toContain("5,025%");
    // the broker lists XAUUSD with 2 digits: 0.3 is 30 points
    expect(content).toContain("Bid 2301.1 · Ask 2301.4 · Spread 0.3 (30 pt)");
    expect(content).toContain("Positions (1)");
    expect(content).toContain("WSA trading system");

    const card = view.container.querySelector("[aria-label='Position XAUUSD 9001']") as Element;
    expect(text(card)).toContain("Buy");
    expect(text(card)).toContain("XAUUSD");
    expect(text(card)).toContain("0.1 lots");
    expect(text(card)).toContain("Open 2300.5");
    expect(text(card)).toContain("SL 2290");
    expect(text(card)).toContain("TP -");
    expect(text(card)).toContain("+50.00");
    // the sell button shows the bid, the buy button the ask
    expect(sureButton(view.container, "Sell XAUUSD at market").textContent).toContain("2301.1");
    expect(sureButton(view.container, "Buy XAUUSD at market").textContent).toContain("2301.4");
  });

  test("reads the account the platform has selected, with the symbol of the ticket, and the broker's symbols", async () => {
    await mountPanel({ suggested: A1 });

    expect(stateCalls().length).toBeGreaterThan(0);
    const url = new URL(stateCalls()[0].url, "https://app.wsa.test");
    expect(url.searchParams.get("accountId")).toBe(A1);
    expect(url.searchParams.get("symbol")).toBe("XAUUSD");
    expect(symbolCalls()[0].url).toBe(`/api/terminal/trade/symbols?accountId=${A1}`);
  });

  test("prefers the account saved in the workspace over the one selected elsewhere", async () => {
    installFetch({ accounts: accountsResponse([tradeAccount(A1, "Alpha"), tradeAccount(A2, "Beta")]) });

    await mountPanel({ initial: { accountId: A2 }, suggested: A1 });

    expect(new URL(stateCalls()[0].url, "https://app.wsa.test").searchParams.get("accountId")).toBe(A2);
  });

  test("a price that the bridge cannot give is said plainly", async () => {
    installFetch({ state: (accountId) => json({ ok: true, data: stateFor(accountId, { quote: null }) }) });

    const view = await mountPanel();

    expect(text(view.container)).toContain("No price for this symbol - the order is sent at the market price.");
  });

  test("the price of another symbol is never shown as the price of this one", async () => {
    installFetch({
      state: (accountId) => json({ ok: true, data: stateFor(accountId, { quote: quoteFor("EURUSD.m") }) }),
    });

    const view = await mountPanel();

    expect(text(view.container)).toContain("No price for this symbol");
    expect(text(view.container)).not.toContain("Bid 1.085");
  });

  test("an account with nothing open says so, for positions and for pending orders", async () => {
    installFetch({ state: stateWith([]) });

    const view = await mountPanel();

    expect(text(view.container)).toContain("No open positions on this account.");
    expect(view.container.querySelector("ul[aria-label='Open positions']")).toBeNull();
    click(bookTab(view.container, "Pending"));
    await settle();
    expect(text(view.container)).toContain("No pending orders on this account.");
  });

  test("without a connected account it explains what to do and asks the broker nothing", async () => {
    installFetch({ accounts: accountsResponse([tradeAccount(A1, "Alpha", { status: "PENDING", reachable: false })]) });

    const view = await mountPanel();

    expect(text(view.container)).toContain("None of your accounts is connected to the broker service yet.");
    expect(text(view.container)).toContain("Alpha · MT5 · IC Markets (not connected)");
    expect(stateCalls()).toHaveLength(0);
    expect(symbolCalls()).toHaveLength(0);
    expect(view.container.querySelector("form[aria-label='Order ticket']")).toBeNull();
  });

  test("a hidden pane does not poll the broker, and starts when it is shown", async () => {
    const view = await mountPanel({ active: false });

    expect(stateCalls()).toHaveLength(0);
    expect(symbolCalls()).toHaveLength(0);
    expect(calls.some((call) => call.url.startsWith("/api/terminal/trade/accounts"))).toBe(true);

    view.rerender(harness({ active: true }));
    await settle(6);
    expect(stateCalls().length).toBeGreaterThan(0);
    expect(symbolCalls().length).toBeGreaterThan(0);
  });

  test("waits for the stored workspace before it reads an account", async () => {
    await mountPanel({ workspaceLoaded: false });

    expect(stateCalls()).toHaveLength(0);
  });

  test("a failing broker read is shown and the positions are not invented", async () => {
    installFetch({
      state: () => json({ ok: false, error: { code: "BROKER_ERROR", message: "The broker did not answer." } }, 502),
    });

    const view = await mountPanel();

    expect(alerts(view.container)).toContain("The broker did not answer.");
    expect(text(view.container)).toContain("Positions could not be read.");
    expect(view.container.querySelector("ul[aria-label='Open positions']")).toBeNull();
  });

  test("a slow trading system is said, with the figures still shown", async () => {
    installFetch({ state: stateWith([POSITION], [], { delayed: true }) });

    const view = await mountPanel();

    expect(text(view.container)).toContain("The trading system is slow to answer right now");
    expect(text(view.container)).toContain("Positions (1)");
  });

  test("the route that carries the orders is named", async () => {
    installFetch({ state: stateWith([POSITION], [], { route: "direct" }) });
    const direct = await mountPanel();
    expect(text(direct.container)).toContain("Direct");
    unmountAll();

    installFetch({ state: stateWith([POSITION], [], { route: "none" }) });
    const none = await mountPanel();
    expect(text(none.container)).toContain("Read only");
  });

  test("without the broker's symbol list the panel still works, with an inferred point size", async () => {
    installFetch({ symbols: null });

    const view = await mountPanel();

    expect(text(view.container)).toContain("The broker's symbol list could not be loaded");
    // no digits from the list: the quote's own decimals (one) give the point
    expect(text(view.container)).toContain("Bid 2301.1 · Ask 2301.4 · Spread 0.3 (3 pt)");
    expect(symbolBox(view.container).value).toBe("XAUUSD");
    expect(symbolBox(view.container).disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Symbols
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - the broker's symbols", () => {
  test("typing finds symbols by name, description or alias and lists them in the broker's spelling", async () => {
    const view = await mountPanel();

    setValue(symbolBox(view.container), "gold");
    await settle();
    expect(options(view.container)[0].textContent).toContain("XAUUSD");

    setValue(symbolBox(view.container), "eur usd");
    await settle();
    const names = options(view.container).map((item) => item.textContent);
    expect(names[0]).toContain("EURUSD.m");
    expect(names[0]).toContain("Euro vs US Dollar");

    setValue(symbolBox(view.container), "nothing like this");
    await settle();
    expect(text(view.container.querySelector("[role='listbox']") as Element)).toContain("No symbol of this broker looks like");
  });

  test("choosing a symbol saves it, reads its price and opens it on the chart", async () => {
    const changes: WsaTradePatch[] = [];
    const chart: string[] = [];
    const view = await mountPanel({ onChange: (patch) => changes.push(patch), onChartSymbol: (symbol) => chart.push(symbol) });

    setValue(symbolBox(view.container), "eur");
    await settle();
    click(options(view.container).find((item) => (item.textContent ?? "").includes("EURUSD.m")) ?? null);
    await settle(6);

    expect(changes).toContainEqual({ symbol: "EURUSD.m" });
    expect(chart).toEqual(["OANDA:EURUSD"]);
    expect(symbolBox(view.container).value).toBe("EURUSD.m");
    expect(lastStateSymbol()).toBe("EURUSD.m");
    // the price of the new symbol, with the point of a 5-digit symbol
    expect(text(view.container)).toContain("Bid 1.085 · Ask 1.0852 · Spread 0.0002 (20 pt)");
    expect(sureButton(view.container, "Buy EURUSD.m at market")).not.toBeNull();
  });

  test("Enter takes the highlighted symbol; the arrow keys move the highlight", async () => {
    const changes: WsaTradePatch[] = [];
    const view = await mountPanel({ onChange: (patch) => changes.push(patch) });

    setValue(symbolBox(view.container), "usd");
    await settle();
    expect(options(view.container).length).toBeGreaterThan(1);
    keyDown(symbolBox(view.container), "ArrowDown");
    await settle();
    expect(options(view.container).filter((item) => item.getAttribute("aria-selected") === "true")).toHaveLength(1);
    const highlighted = options(view.container).find((item) => item.getAttribute("aria-selected") === "true");

    keyDown(symbolBox(view.container), "Enter");
    await settle();

    const chosen = (highlighted?.querySelector("span span")?.textContent ?? "").trim();
    expect(chosen).not.toBe("");
    expect(changes).toContainEqual({ symbol: chosen });
  });

  test("half-typed text never changes the symbol when the box is left, and Escape puts it back", async () => {
    const changes: WsaTradePatch[] = [];
    const chart: string[] = [];
    const view = await mountPanel({ onChange: (patch) => changes.push(patch), onChartSymbol: (symbol) => chart.push(symbol) });

    setValue(symbolBox(view.container), "xyz");
    blur(symbolBox(view.container));
    await settle();
    expect(symbolBox(view.container).value).toBe("XAUUSD");

    setValue(symbolBox(view.container), "gbp");
    keyDown(symbolBox(view.container), "Escape");
    await settle();
    expect(symbolBox(view.container).value).toBe("XAUUSD");
    expect(options(view.container)).toHaveLength(0);

    expect(changes).toHaveLength(0);
    expect(chart).toHaveLength(0);
  });

  test("a name typed exactly is accepted when the box is left, whatever the case", async () => {
    const changes: WsaTradePatch[] = [];
    const view = await mountPanel({ onChange: (patch) => changes.push(patch) });

    setValue(symbolBox(view.container), "gbpusd.M");
    blur(symbolBox(view.container));
    await settle();

    expect(changes).toContainEqual({ symbol: "GBPUSD.m" });
    expect(symbolBox(view.container).value).toBe("GBPUSD.m");
  });

  test("without a list a valid typed name is accepted and one that cannot be a symbol is put back", async () => {
    installFetch({ symbols: null });
    const changes: WsaTradePatch[] = [];
    const view = await mountPanel({ onChange: (patch) => changes.push(patch) });

    setValue(symbolBox(view.container), "XAU USD");
    keyDown(symbolBox(view.container), "Enter");
    await settle();
    expect(symbolBox(view.container).value).toBe("XAUUSD");
    expect(changes).toHaveLength(0);

    setValue(symbolBox(view.container), "EURUSD.m");
    keyDown(symbolBox(view.container), "Enter");
    await settle();
    expect(changes).toContainEqual({ symbol: "EURUSD.m" });
    expect(lastStateSymbol()).toBe("EURUSD.m");
  });

  test("the chart's watchlist becomes one-click symbols in the broker's spelling", async () => {
    const changes: WsaTradePatch[] = [];
    const chart: string[] = [];
    const view = await mountPanel({
      chartWatchlist: ["OANDA:XAUUSD", "OANDA:EURUSD", "BINANCE:BTCUSDT", "NASDAQ:AAPL"],
      onChange: (patch) => changes.push(patch),
      onChartSymbol: (symbol) => chart.push(symbol),
    });

    const group = view.container.querySelector("[aria-label='Symbols from your chart watchlist']") as Element;
    const chips = Array.from(group.querySelectorAll("button")).map((item) => item.textContent?.trim());
    // a symbol this broker does not list (AAPL) is not offered
    expect(chips).toEqual(["XAUUSD", "EURUSD.m", "BTCUSD"]);
    expect(button(group, "XAUUSD").getAttribute("aria-pressed")).toBe("true");
    expect(button(group, "EURUSD.m").getAttribute("aria-pressed")).toBe("false");

    click(button(group, "EURUSD.m"));
    await settle(6);

    expect(changes).toContainEqual({ symbol: "EURUSD.m" });
    expect(chart).toEqual(["OANDA:EURUSD"]);
    expect(button(group, "EURUSD.m").getAttribute("aria-pressed")).toBe("true");
  });

  test("a symbol picked on the chart selects the same instrument of the broker; the panel's own pick does not echo", async () => {
    const changes: WsaTradePatch[] = [];
    const chart: string[] = [];
    const props: HarnessProps = {
      chartSymbol: "OANDA:XAUUSD",
      onChange: (patch) => changes.push(patch),
      onChartSymbol: (symbol) => chart.push(symbol),
    };
    const view = await mountPanel(props);
    // opening the page never moves the symbol
    expect(changes).toHaveLength(0);

    view.rerender(harness({ ...props, chartSymbol: "OANDA:GBPUSD" }));
    await settle(6);

    expect(changes).toEqual([{ symbol: "GBPUSD.m" }]);
    expect(symbolBox(view.container).value).toBe("GBPUSD.m");
    expect(lastStateSymbol()).toBe("GBPUSD.m");
    // the chart already shows it: nothing is sent back to the chart
    expect(chart).toHaveLength(0);

    // another spelling of the instrument the panel already trades changes nothing
    view.rerender(harness({ ...props, chartSymbol: "FX:GBPUSD" }));
    await settle(6);
    expect(changes).toHaveLength(1);
  });

  test("the chart opens on a symbol this broker does not list: the panel says so and keeps its symbol", async () => {
    const changes: WsaTradePatch[] = [];
    const props: HarnessProps = { chartSymbol: "OANDA:XAUUSD", onChange: (patch) => changes.push(patch) };
    const view = await mountPanel(props);

    view.rerender(harness({ ...props, chartSymbol: "NASDAQ:AAPL" }));
    await settle(6);

    expect(changes).toHaveLength(0);
    expect(symbolBox(view.container).value).toBe("XAUUSD");
    expect(text(view.container)).toContain("The chart shows NASDAQ:AAPL, which this broker does not list - choose the symbol here.");

    // the person goes back to a symbol it lists: the note goes away
    view.rerender(harness({ ...props, chartSymbol: "OANDA:XAUUSD" }));
    await settle(6);
    expect(text(view.container)).not.toContain("which this broker does not list");
  });

  test("picking in the panel what the chart already shows does not touch the chart", async () => {
    const chart: string[] = [];
    const view = await mountPanel({ chartSymbol: "OANDA:EURUSD", onChartSymbol: (symbol) => chart.push(symbol) });

    setValue(symbolBox(view.container), "eurusd.m");
    blur(symbolBox(view.container));
    await settle(6);

    expect(symbolBox(view.container).value).toBe("EURUSD.m");
    expect(chart).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ticket
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - the order ticket", () => {
  test.each([
    ["a volume of zero", { volume: "0" }, "Volume must be between 0.001 and 100 lots"],
    ["a volume that is not a number", { volume: "lots" }, "Volume must be between 0.001 and 100 lots"],
    ["a volume with four decimals", { volume: "0.0123" }, "at most 3 decimals"],
    ["a stop loss that is not a price", { stopLoss: "abc" }, "The stop loss must be a price above zero."],
    ["a negative take profit", { takeProfit: "-5" }, "The take profit must be a price above zero."],
    ["a buy with the stop loss above the entry", { stopLoss: "2400", takeProfit: "2450" }, "For a buy the stop loss must be below the entry price."],
    ["a buy with the take profit below the entry", { stopLoss: "2290", takeProfit: "2250" }, "For a buy the take profit must be above the entry price."],
  ])("refuses %s before anything is sent", async (_name, input, message) => {
    const view = await mountPanel();
    const typed = input as { volume?: string; stopLoss?: string; takeProfit?: string };
    if (typed.volume !== undefined) setValue(field(view.container, "Volume (lots)"), typed.volume);
    if (typed.stopLoss !== undefined) setValue(field(view.container, "Stop loss (price)"), typed.stopLoss);
    if (typed.takeProfit !== undefined) setValue(field(view.container, "Take profit (price)"), typed.takeProfit);

    click(sureButton(view.container, "Buy XAUUSD at market"));
    await settle();

    expect(alerts(view.container)).toContain(message);
    expect(orders()).toHaveLength(0);
  });

  test("a sell needs the stop loss above the entry and the target below it", async () => {
    const view = await mountPanel();

    setValue(field(view.container, "Stop loss (price)"), "2290");
    click(sureButton(view.container, "Sell XAUUSD at market"));
    await settle();
    expect(alerts(view.container)).toContain("For a sell the stop loss must be above the entry price.");

    setValue(field(view.container, "Stop loss (price)"), "2310");
    setValue(field(view.container, "Take profit (price)"), "2320");
    click(sureButton(view.container, "Sell XAUUSD at market"));
    await settle();
    expect(alerts(view.container)).toContain("For a sell the take profit must be below the entry price.");
    expect(orders()).toHaveLength(0);
  });

  test("Buy is the command: one click sends the order and there is nothing to confirm", async () => {
    const view = await mountPanel();
    setValue(field(view.container, "Stop loss (price)"), "2290");
    setValue(field(view.container, "Take profit (price)"), "2320");

    click(sureButton(view.container, "Buy XAUUSD at market"));

    // the request is on its way before anything else could be asked
    expect(orders()).toHaveLength(1);
    expectNoConfirmation(view.container);
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].body).toMatchObject({ side: "BUY", stopLoss: 2290, takeProfit: 2320 });
    expectNoConfirmation(view.container);
  });

  test("sends the order once, with a request id and the order type, and reads the account again", async () => {
    installFetch({
      order: () => json({ ok: true, data: { ok: true, ticket: "9001", timing: { queueMs: 120, runMs: 63 } } }),
    });
    const view = await mountPanel();
    setValue(field(view.container, "Stop loss (price)"), "2290");
    setValue(field(view.container, "Take profit (price)"), "2320");
    const before = stateCalls().length;

    click(sureButton(view.container, "Buy XAUUSD at market"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].url).toBe("/api/terminal/trade/open");
    expect(orders()[0].body).toMatchObject({
      accountId: A1,
      symbol: "XAUUSD",
      side: "BUY",
      volume: 0.01,
      orderKind: "MARKET",
      price: null,
      stopLoss: 2290,
      takeProfit: 2320,
    });
    expect(orders()[0].body.clientRequestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // the person is told what went, how long they waited in all (next to the sentence) and where the time went (under it)
    const notice = resultNotice(view.container, "Buy 0.01 XAUUSD sent to the broker.");
    expect(notice.querySelector("strong")?.textContent).toMatch(/^\d+ ms$/);
    expect(notice.querySelectorAll("p")[1]?.textContent).toBe("183 ms (queue 120 ms · broker 63 ms)");
    expect(stateCalls().length).toBeGreaterThan(before);
    // the levels of a finished order do not stay in the boxes
    expect(field(view.container, "Stop loss (price)").value).toBe("");
    expect(field(view.container, "Take profit (price)").value).toBe("");
  });

  test("a sell without stop loss and take profit sends them as none", async () => {
    const view = await mountPanel();

    click(sureButton(view.container, "Sell XAUUSD at market"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].body).toMatchObject({ side: "SELL", stopLoss: null, takeProfit: null, orderKind: "MARKET" });
  });

  test("every new order gets its own request id", async () => {
    const view = await mountPanel();

    await buyAtMarket(view);
    await buyAtMarket(view);

    expect(orders()).toHaveLength(2);
    expect(orders()[0].body.clientRequestId).not.toBe(orders()[1].body.clientRequestId);
  });

  test("what was sent is listed under Activity", async () => {
    const view = await mountPanel();
    click(bookTab(view.container, "Activity"));
    await settle();
    expect(text(view.container)).toContain("What you send from this panel is listed here");

    await buyAtMarket(view);
    click(bookTab(view.container, "Activity"));
    await settle();

    const list = view.container.querySelector("ol[aria-label='Activity']") as Element;
    expect(list).not.toBeNull();
    expect(text(list)).toContain("Buy 0.01 XAUUSD sent to the broker.");
  });

  describe("limit and stop orders", () => {
    test("the order type is saved, the price box appears and Bid / Ask fill it", async () => {
      const changes: WsaTradePatch[] = [];
      const view = await mountPanel({ onChange: (patch) => changes.push(patch) });
      expect(view.container.querySelector("input[placeholder='price the order waits for']")).toBeNull();

      click(kindTab(view.container, "Limit"));
      await settle();

      expect(changes).toContainEqual({ orderKind: "LIMIT" });
      expect(kindTab(view.container, "Limit").getAttribute("aria-selected")).toBe("true");
      expect(field(view.container, "Price (entry)").value).toBe("");
      expect(sureButton(view.container, "Buy XAUUSD limit")).not.toBeNull();

      click(sureButton(view.container, "Use the ask price"));
      expect(field(view.container, "Price (entry)").value).toBe("2301.4");
      click(sureButton(view.container, "Use the bid price"));
      expect(field(view.container, "Price (entry)").value).toBe("2301.1");
    });

    test("a pending order needs its price, and a price on the wrong side of the market is explained", async () => {
      const view = await mountPanel({ initial: { orderKind: "LIMIT" } });

      click(sureButton(view.container, "Buy XAUUSD limit"));
      await settle();
      expect(alerts(view.container)).toContain("Enter the price the order waits for (a number above zero).");

      setValue(field(view.container, "Price (entry)"), "2310");
      click(sureButton(view.container, "Buy XAUUSD limit"));
      await settle();
      expect(alerts(view.container)).toContain(
        "Buy limit must be placed below the current ask (2301.4). At 2310 this is a buy stop - switch the order type.",
      );

      click(kindTab(view.container, "Stop"));
      await settle();
      setValue(field(view.container, "Price (entry)"), "2310");
      click(sureButton(view.container, "Sell XAUUSD stop"));
      await settle();
      expect(alerts(view.container)).toContain(
        "Sell stop must be placed below the current bid (2301.1). At 2310 this is a sell limit - switch the order type.",
      );
      expect(orders()).toHaveLength(0);
    });

    test("sends a buy limit with its price", async () => {
      const view = await mountPanel({ initial: { orderKind: "LIMIT" } });
      setValue(field(view.container, "Price (entry)"), "2295");
      setValue(field(view.container, "Stop loss (price)"), "2285");

      click(sureButton(view.container, "Buy XAUUSD limit"));
      await settle();
      expectNoConfirmation(view.container);

      expect(orders()).toHaveLength(1);
      expect(orders()[0].url).toBe("/api/terminal/trade/open");
      expect(orders()[0].body).toMatchObject({
        accountId: A1,
        symbol: "XAUUSD",
        side: "BUY",
        orderKind: "LIMIT",
        price: 2295,
        stopLoss: 2285,
        takeProfit: null,
      });
      expect(text(view.container)).toContain("Buy limit 0.01 XAUUSD placed at 2295.");
      // the price of one order is not kept for the next
      expect(field(view.container, "Price (entry)").value).toBe("");
    });

    test("sends a sell stop below the market with levels around its price", async () => {
      const view = await mountPanel({ initial: { orderKind: "STOP" } });
      setValue(field(view.container, "Price (entry)"), "2290");
      setValue(field(view.container, "Stop loss (price)"), "2300");
      setValue(field(view.container, "Take profit (price)"), "2270");

      click(sureButton(view.container, "Sell XAUUSD stop"));
      await settle();

      expect(orders()).toHaveLength(1);
      expect(orders()[0].body).toMatchObject({ side: "SELL", orderKind: "STOP", price: 2290, stopLoss: 2300, takeProfit: 2270 });
      expect(text(view.container)).toContain("Sell stop 0.01 XAUUSD placed at 2290.");
    });

    test("the levels of a pending order are checked against its own price", async () => {
      const view = await mountPanel({ initial: { orderKind: "LIMIT" } });
      setValue(field(view.container, "Price (entry)"), "2295");
      setValue(field(view.container, "Stop loss (price)"), "2296");

      click(sureButton(view.container, "Buy XAUUSD limit"));
      await settle();

      expect(alerts(view.container)).toContain("For a buy the stop loss must be below the entry price.");
      expect(orders()).toHaveLength(0);
    });
  });

  describe("volume", () => {
    test("the + and - buttons step the volume and the new volume is saved", async () => {
      const changes: WsaTradePatch[] = [];
      const view = await mountPanel({ onChange: (patch) => changes.push(patch) });

      click(sureButton(view.container, "Increase volume"));
      await settle();
      expect(field(view.container, "Volume (lots)").value).toBe("0.02");
      expect(changes).toContainEqual({ volume: 0.02 });

      click(sureButton(view.container, "Set volume to 1 lots"));
      await settle();
      click(sureButton(view.container, "Increase volume"));
      await settle();
      // from one lot the step is a tenth
      expect(field(view.container, "Volume (lots)").value).toBe("1.1");
      expect(changes).toContainEqual({ volume: 1.1 });

      click(sureButton(view.container, "Decrease volume"));
      await settle();
      expect(field(view.container, "Volume (lots)").value).toBe("1");
    });

    test("quick volumes are one click, and a typed volume is kept when Enter is pressed", async () => {
      const changes: WsaTradePatch[] = [];
      const view = await mountPanel({ onChange: (patch) => changes.push(patch) });

      click(sureButton(view.container, "Set volume to 0.5 lots"));
      await settle();
      expect(field(view.container, "Volume (lots)").value).toBe("0.5");
      expect(changes).toContainEqual({ volume: 0.5 });

      setValue(field(view.container, "Volume (lots)"), "0,25");
      keyDown(field(view.container, "Volume (lots)"), "Enter");
      await settle();
      expect(changes).toContainEqual({ volume: 0.25 });
      expect(field(view.container, "Volume (lots)").value).toBe("0.25");
    });

    test("a volume that cannot be right is put back instead of being saved", async () => {
      const changes: WsaTradePatch[] = [];
      const view = await mountPanel({ onChange: (patch) => changes.push(patch) });

      setValue(field(view.container, "Volume (lots)"), "abc");
      keyDown(field(view.container, "Volume (lots)"), "Enter");
      await settle();
      expect(field(view.container, "Volume (lots)").value).toBe("0.01");

      setValue(field(view.container, "Volume (lots)"), "1000");
      blur(field(view.container, "Volume (lots)"));
      await settle();
      expect(field(view.container, "Volume (lots)").value).toBe("0.01");
      expect(changes).toHaveLength(0);
    });

    test("the volume typed in the box is the one that is sent, even before it was committed", async () => {
      const view = await mountPanel();

      setValue(field(view.container, "Volume (lots)"), "0.3");
      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();

      expect(orders()).toHaveLength(1);
      expect(orders()[0].body.volume).toBe(0.3);
    });
  });

  describe("stop loss and take profit in points", () => {
    test("distances are turned into prices from the entry, with the broker's digits", async () => {
      const view = await mountPanel({ initial: { levelMode: "points" } });
      expect(field(view.container, "Stop loss (points)")).not.toBeNull();
      expect(field(view.container, "Take profit (points)")).not.toBeNull();

      setValue(field(view.container, "Stop loss (points)"), "200");
      setValue(field(view.container, "Take profit (points)"), "400");
      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();
      // a buy enters at the ask 2301.4: 200 points = 2.00 below, 400 points = 4.00 above
      expect(orders()).toHaveLength(1);
      expect(orders()[0].body).toMatchObject({ side: "BUY", stopLoss: 2299.4, takeProfit: 2305.4 });

      // the distances stay in the boxes for the next order; a sell enters at the bid 2301.1 and goes the other way
      expect(field(view.container, "Stop loss (points)").value).toBe("200");
      click(sureButton(view.container, "Sell XAUUSD at market"));
      await settle();
      expect(orders()).toHaveLength(2);
      expect(orders()[1].body).toMatchObject({ side: "SELL", stopLoss: 2303.1, takeProfit: 2297.1 });
    });

    test("a distance that is not a number of points is refused", async () => {
      const view = await mountPanel({ initial: { levelMode: "points" } });

      setValue(field(view.container, "Stop loss (points)"), "abc");
      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();

      expect(alerts(view.container)).toContain("The stop loss must be a distance in points above zero.");
      expect(orders()).toHaveLength(0);
    });

    test("without a live price a distance cannot be turned into a price, and the person is told", async () => {
      installFetch({ state: stateWith([POSITION], [], { quote: null }) });
      const view = await mountPanel({ initial: { levelMode: "points" } });

      setValue(field(view.container, "Stop loss (points)"), "200");
      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();

      expect(alerts(view.container)).toContain("no live price for XAUUSD yet");
      expect(orders()).toHaveLength(0);
    });
  });

  describe("the starting levels", () => {
    test("an empty box uses the default distance; a typed price wins for its own level", async () => {
      const view = await mountPanel({ initial: { stopLossPoints: 150, takeProfitPoints: 300 } });
      expect(field(view.container, "Stop loss (price)").placeholder).toBe("default 150 pt");
      expect(field(view.container, "Take profit (price)").placeholder).toBe("default 300 pt");

      // the entry is the ask 2301.4: 150 points = 1.50 below, 300 points = 3.00 above
      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();
      expect(orders()).toHaveLength(1);
      expect(orders()[0].body).toMatchObject({ stopLoss: 2299.9, takeProfit: 2304.4 });

      setValue(field(view.container, "Stop loss (price)"), "2290");
      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();
      expect(orders()).toHaveLength(2);
      expect(orders()[1].body).toMatchObject({ stopLoss: 2290, takeProfit: 2304.4 });
    });
  });

  describe("the person's own rules", () => {
    test("a rule that every order needs a stop loss refuses one without", async () => {
      const view = await mountPanel({ initial: { requireStopLoss: true } });

      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();
      expect(alerts(view.container)).toContain("Your rule: every new order needs a stop loss");
      expect(orders()).toHaveLength(0);

      setValue(field(view.container, "Stop loss (price)"), "2290");
      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();
      // the refusal is gone and the order, now with its stop loss, went out with that one click
      expect(alerts(view.container)).not.toContain("Your rule");
      expect(orders()).toHaveLength(1);
      expect(orders()[0].body).toMatchObject({ stopLoss: 2290 });
    });

    test("a limit on the volume refuses a larger order", async () => {
      const view = await mountPanel({ initial: { maxVolume: 0.05, volume: 0.1 } });

      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();

      expect(alerts(view.container)).toContain("Your own limit is 0.05 lots per order");
      expect(orders()).toHaveLength(0);

      setValue(field(view.container, "Volume (lots)"), "0.05");
      click(sureButton(view.container, "Buy XAUUSD at market"));
      await settle();
      expect(alerts(view.container)).not.toContain("Your own limit");
      expect(orders()).toHaveLength(1);
      expect(orders()[0].body).toMatchObject({ volume: 0.05 });
    });

    test("the ticket never asks the person to confirm anything", async () => {
      const view = await mountPanel();
      expect(text(view.container)).not.toContain("One-click is on");
      expectNoConfirmation(view.container);

      click(sureButton(view.container, "Sell XAUUSD at market"));
      await settle();

      expectNoConfirmation(view.container);
      expect(orders()).toHaveLength(1);
      expect(orders()[0].body).toMatchObject({ side: "SELL", orderKind: "MARKET" });
      resultNotice(view.container, "Sell 0.01 XAUUSD sent to the broker.");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Trade settings
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - trade settings", () => {
  async function openSettings(props: HarnessProps = {}) {
    const view = await mountPanel(props);
    const opener = view.container.querySelector<HTMLButtonElement>("button[aria-controls$='-settings']") as HTMLButtonElement;
    expect(opener.getAttribute("aria-expanded")).toBe("false");
    click(opener);
    await settle();
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    return { view, opener };
  }

  test("the rules in force are summarised while the settings are closed", async () => {
    const view = await mountPanel({
      initial: { requireStopLoss: true, maxVolume: 2, stopLossPoints: 150, takeProfitPoints: 300 },
    });

    const summary = text(view.container.querySelector("button[aria-controls$='-settings']") as Element);
    expect(summary).toContain("one click · stop loss required · max 2 lots · SL 150 pt · TP 300 pt");
  });

  test("the switches and the entry mode are saved at once, and there is no switch to ask before sending", async () => {
    const changes: WsaTradePatch[] = [];
    const { view } = await openSettings({ onChange: (patch) => changes.push(patch) });
    // Buy, Sell, Close and Delete are the command itself: nothing in the settings brings a confirmation back
    expect(() => toggle(view.container, "Ask before an order is sent")).toThrow("switch not found");
    expect(text(view.container.querySelector("[aria-label='Trade settings']") as Element)).not.toMatch(/confirm|ask before/i);

    click(toggle(view.container, "Every new order needs a stop loss"));
    click(button(view.container, "Points"));
    await settle();

    expect(changes).toContainEqual({ requireStopLoss: true });
    expect(changes).toContainEqual({ levelMode: "points" });
    expect(button(view.container, "Points").getAttribute("aria-pressed")).toBe("true");
    expect(button(view.container, "Prices").getAttribute("aria-pressed")).toBe("false");
    // the ticket follows
    expect(field(view.container, "Stop loss (points)")).not.toBeNull();
  });

  test("default distances: a whole number of points is saved, empty switches it off, anything else is put back", async () => {
    const changes: WsaTradePatch[] = [];
    const { view } = await openSettings({ onChange: (patch) => changes.push(patch) });
    const box = () => field(view.container, "Default stop loss (points)");

    setValue(box(), "250");
    keyDown(box(), "Enter");
    await settle();
    expect(changes).toContainEqual({ stopLossPoints: 250 });
    expect(box().value).toBe("250");

    setValue(box(), "12.5");
    keyDown(box(), "Enter");
    await settle();
    expect(box().value).toBe("250");

    setValue(box(), "0");
    blur(box());
    await settle();
    expect(box().value).toBe("250");

    setValue(box(), "");
    keyDown(box(), "Enter");
    await settle();
    expect(changes).toContainEqual({ stopLossPoints: null });

    setValue(field(view.container, "Default take profit (points)"), "500");
    keyDown(field(view.container, "Default take profit (points)"), "Enter");
    await settle();
    expect(changes).toContainEqual({ takeProfitPoints: 500 });
    expect(changes.filter((patch) => "stopLossPoints" in patch)).toHaveLength(2);
  });

  test("the largest volume per order: a valid volume is saved, empty means no limit, a wrong one is put back", async () => {
    const changes: WsaTradePatch[] = [];
    const { view } = await openSettings({ onChange: (patch) => changes.push(patch) });
    const box = () => field(view.container, "Largest volume per order (lots)");

    setValue(box(), "2");
    keyDown(box(), "Enter");
    await settle();
    expect(changes).toContainEqual({ maxVolume: 2 });

    setValue(box(), "1000");
    keyDown(box(), "Enter");
    await settle();
    expect(box().value).toBe("2");

    setValue(box(), "");
    keyDown(box(), "Enter");
    await settle();
    expect(changes).toContainEqual({ maxVolume: null });
    expect(changes.filter((patch) => "maxVolume" in patch)).toHaveLength(2);
  });

  test("the settings can be closed again", async () => {
    const { view, opener } = await openSettings();

    click(opener);
    await settle();

    expect(opener.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector("[aria-label='Trade settings']")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// When an order does not go through
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - when an order does not go through", () => {
  test("a broker rejection is shown in the broker's words and the order stays open for a change", async () => {
    installFetch({
      order: () => json({ ok: false, error: { code: "PROVIDER_ERROR", message: "Invalid stops" } }, 502),
    });
    const view = await mountPanel();

    setValue(field(view.container, "Stop loss (price)"), "2290");
    await buyAtMarket(view);

    expect(alerts(view.container)).toContain("Invalid stops");
    expect(alerts(view.container)).not.toContain("check the positions below");
    // nothing to dismiss first: the ticket is as it was, ready for a change and another click
    expectNoConfirmation(view.container);
    expect(sureButton(view.container, "Buy XAUUSD at market").disabled).toBe(false);
    expect(field(view.container, "Stop loss (price)").value).toBe("2290");
  });

  test("a broker that gave no clear answer asks the trader to check the positions first", async () => {
    installFetch({
      order: () => json({ ok: false, error: { code: "BROKER_ERROR", message: "The broker did not answer." } }, 502),
    });
    const view = await mountPanel();

    await buyAtMarket(view);

    expect(alerts(view.container)).toContain("The broker did not answer.");
    expect(alerts(view.container)).toContain("check the positions below before sending it again");
  });

  test("an order that waited too long for the trading system is treated the same way", async () => {
    installFetch({
      order: () => json({ ok: false, error: { code: "ORDER_UNCERTAIN", message: "The order may have reached the broker." } }, 504),
    });
    const view = await mountPanel();

    await buyAtMarket(view);

    expect(alerts(view.container)).toContain("The order may have reached the broker.");
    expect(alerts(view.container)).toContain("check the positions below before sending it again");
  });

  test("a dropped connection is treated the same way", async () => {
    installFetch({
      order: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const view = await mountPanel();

    await buyAtMarket(view);

    expect(alerts(view.container)).toContain("The connection dropped before an answer came back.");
    expect(alerts(view.container)).toContain("check the positions below before sending it again");
  });

  test("an order the server had already handled is reported as such", async () => {
    installFetch({ order: () => json({ ok: true, data: { ok: true, ticket: "9001", repeated: true } }) });
    const view = await mountPanel();

    await buyAtMarket(view);

    expect(text(view.container)).toContain("This order had already been sent - nothing was sent twice.");
  });

  test("a second click while the first order travels sends nothing more", async () => {
    let release: (value: Response) => void = () => undefined;
    installFetch({ order: () => new Promise<Response>((resolve) => (release = resolve)) });
    const view = await mountPanel();
    const buy = () => sureButton(view.container, "Buy XAUUSD at market");

    click(buy());
    click(buy());
    click(sureButton(view.container, "Sell XAUUSD at market"));
    await settle();
    // the buttons are switched off while the order travels, and nothing else was sent
    expect(orders()).toHaveLength(1);
    expect(buy().disabled).toBe(true);
    expect(sureButton(view.container, "Sell XAUUSD at market").disabled).toBe(true);

    release(json({ ok: true, data: { ok: true, ticket: "9001" } }));
    await settle();
    expect(orders()).toHaveLength(1);
    expect(buy().disabled).toBe(false);
  });

  test("the same order sent again after an answer that never came keeps its request id, so it can never be placed twice", async () => {
    let attempt = 0;
    installFetch({
      order: () => {
        attempt += 1;
        return attempt === 1
          ? json({ ok: false, error: { code: "ORDER_UNCERTAIN", message: "The order may have reached the broker." } }, 504)
          : json({ ok: true, data: { ok: true, ticket: "9001", repeated: true } });
      },
    });
    const view = await mountPanel();

    await buyAtMarket(view);
    await buyAtMarket(view);

    expect(orders()).toHaveLength(2);
    expect(orders()[1].body.clientRequestId).toBe(orders()[0].body.clientRequestId);
    // the server had it already: the person is told so
    expect(text(view.container)).toContain("This order had already been sent - nothing was sent twice.");
  });

  test("a clearly refused order, or a changed one, is a new order with a new request id", async () => {
    let attempt = 0;
    installFetch({
      order: () => {
        attempt += 1;
        return attempt <= 2
          ? json({ ok: false, error: { code: "PROVIDER_ERROR", message: "Invalid stops" } }, 502)
          : json({ ok: true, data: { ok: true, ticket: "9001" } });
      },
    });
    const view = await mountPanel();

    // 1: refused with a clear reason -> nothing may exist at the broker, so the next try is a fresh order
    await buyAtMarket(view);
    await buyAtMarket(view);
    expect(orders()[1].body.clientRequestId).not.toBe(orders()[0].body.clientRequestId);

    // 2: another volume is another order
    setValue(field(view.container, "Volume (lots)"), "0.02");
    await buyAtMarket(view);
    expect(orders()).toHaveLength(3);
    expect(orders()[2].body.volume).toBe(0.02);
    expect(orders()[2].body.clientRequestId).not.toBe(orders()[1].body.clientRequestId);
  });

  test("an order that is changed after an answer that never came is not sent under the old id", async () => {
    let attempt = 0;
    installFetch({
      order: () => {
        attempt += 1;
        return attempt === 1
          ? json({ ok: false, error: { code: "ORDER_UNCERTAIN", message: "The order may have reached the broker." } }, 504)
          : json({ ok: true, data: { ok: true, ticket: "9001" } });
      },
    });
    const view = await mountPanel();

    await buyAtMarket(view);
    setValue(field(view.container, "Stop loss (price)"), "2290");
    await buyAtMarket(view);

    expect(orders()).toHaveLength(2);
    expect(orders()[1].body.stopLoss).toBe(2290);
    expect(orders()[1].body.clientRequestId).not.toBe(orders()[0].body.clientRequestId);
  });

  test("both the failure and the success are kept under Activity", async () => {
    let attempt = 0;
    installFetch({
      order: () => {
        attempt += 1;
        return attempt === 1
          ? json({ ok: false, error: { code: "PROVIDER_ERROR", message: "Market is closed" } }, 502)
          : json({ ok: true, data: { ok: true, ticket: "9001" } });
      },
    });
    const view = await mountPanel();

    await buyAtMarket(view);
    expect(alerts(view.container)).toContain("Market is closed");
    await buyAtMarket(view);
    click(bookTab(view.container, "Activity"));
    await settle();

    const list = text(view.container.querySelector("ol[aria-label='Activity']") as Element);
    expect(list).toContain("Market is closed");
    expect(list).toContain("Buy 0.01 XAUUSD sent to the broker.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Open positions
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - stop loss and take profit of a position", () => {
  async function openLevels(view: PanelView) {
    click(sureButton(view.container, "Change stop loss and take profit of XAUUSD 9001"));
    await settle();
  }

  test("the editor starts with the position's levels", async () => {
    const view = await mountPanel();

    await openLevels(view);

    expect(field(view.container, "Stop loss").value).toBe("2290");
    expect(field(view.container, "Take profit").value).toBe("");
  });

  test("sends only the level that changed", async () => {
    const view = await mountPanel();
    await openLevels(view);

    setValue(field(view.container, "Take profit"), "2320");
    click(button(view.container, "Save levels"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].url).toBe("/api/terminal/trade/modify");
    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9001", takeProfit: 2320 });
    expect(text(view.container)).toContain("Stop loss / take profit of XAUUSD updated.");
    expect(view.container.querySelector("#sl-9001")).toBeNull();
  });

  test("an emptied field removes that level", async () => {
    const view = await mountPanel();
    await openLevels(view);

    setValue(field(view.container, "Stop loss"), "");
    click(button(view.container, "Save levels"));
    await settle();

    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9001", stopLoss: null });
  });

  test("changing nothing is said, not sent", async () => {
    const view = await mountPanel();
    await openLevels(view);

    click(button(view.container, "Save levels"));
    await settle();

    expect(alerts(view.container)).toContain("Stop loss and take profit are unchanged.");
    expect(orders()).toHaveLength(0);
  });

  test("a target below the stop loss of a buy is refused on the spot", async () => {
    const view = await mountPanel();
    await openLevels(view);

    setValue(field(view.container, "Take profit"), "2200");
    click(button(view.container, "Save levels"));
    await settle();

    expect(alerts(view.container)).toContain("For a buy the stop loss must be below the take profit.");
    expect(orders()).toHaveLength(0);
  });

  test("a level that is not a price is refused", async () => {
    const view = await mountPanel();
    await openLevels(view);

    setValue(field(view.container, "Take profit"), "high");
    click(button(view.container, "Save levels"));
    await settle();

    expect(alerts(view.container)).toContain("Stop loss and take profit must be prices above zero.");
    expect(orders()).toHaveLength(0);
  });

  test("cancel closes the editor without a request", async () => {
    const view = await mountPanel();
    await openLevels(view);

    click(button(view.container, "Cancel"));
    await settle();

    expect(view.container.querySelector("#sl-9001")).toBeNull();
    expect(orders()).toHaveLength(0);
  });

  test("the broker's reason for refusing a level is shown and the editor stays open", async () => {
    installFetch({
      order: () => json({ ok: false, error: { code: "PROVIDER_ERROR", message: "Invalid stops" } }, 502),
    });
    const view = await mountPanel();
    await openLevels(view);

    setValue(field(view.container, "Take profit"), "2301");
    click(button(view.container, "Save levels"));
    await settle();

    expect(alerts(view.container)).toContain("Invalid stops");
    expect(view.container.querySelector("#sl-9001")).not.toBeNull();
  });

  test("break-even moves the stop loss to the entry price in one click", async () => {
    const view = await mountPanel();

    click(sureButton(view.container, "Move the stop loss of XAUUSD 9001 to break-even"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].url).toBe("/api/terminal/trade/modify");
    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9001", stopLoss: 2300.5 });
    expect(text(view.container)).toContain("Stop loss of XAUUSD moved to the entry price 2300.5.");
  });

  test("break-even is not offered when the stop loss is already at or beyond the entry", async () => {
    // A buy whose stop sits above the entry and a sell whose stop sits below it are both already locked in.
    installFetch({ state: stateWith([{ ...POSITION, stopLoss: 2310 }, { ...LOSER, ticket: "9002", stopLoss: 1.08 }]) });
    const view = await mountPanel();

    expect(sureButton(view.container, "Move the stop loss of XAUUSD 9001 to break-even").disabled).toBe(true);
    expect(sureButton(view.container, "Move the stop loss of EURUSD.m 9002 to break-even").disabled).toBe(true);
  });

  test("break-even is offered to a sell whose stop loss is still above the entry", async () => {
    installFetch({ state: stateWith([{ ...LOSER, ticket: "9002", stopLoss: 1.09 }]) });
    const view = await mountPanel();

    expect(sureButton(view.container, "Move the stop loss of EURUSD.m 9002 to break-even").disabled).toBe(false);
  });
});

describe("WsaTradePanel - closing a position", () => {
  /** The part-close editor: only a number of lots needs the person's input, the rest is one click. */
  async function openCloseEditor(view: PanelView) {
    click(sureButton(view.container, "Close part of XAUUSD 9001"));
    await settle();
  }

  test("Close shuts the whole position with that one click - there is nothing to confirm", async () => {
    const view = await mountPanel();

    click(sureButton(view.container, "Close XAUUSD 9001"));
    // the request is on its way before anything else could be asked
    expect(orders()).toHaveLength(1);
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].url).toBe("/api/terminal/trade/close");
    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9001" });
    expect(view.container.querySelector("#lots-9001")).toBeNull();
    expectNoConfirmation(view.container);
    resultNotice(view.container, "XAUUSD position closed.");
  });

  test("the closed position leaves the list at once, before the next picture of the account arrives", async () => {
    installFetch({ state: stateWith([POSITION, SMALL_WIN]) });
    const view = await mountPanel();
    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (2)");

    click(sureButton(view.container, "Close XAUUSD 9001"));
    await settle();

    // the polled picture still lists both: the answer of the trading system is laid over it
    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (1)");
    expect(view.container.querySelector("[aria-label='Position XAUUSD 9001']")).toBeNull();
    expect(view.container.querySelector("[aria-label='Position XAUUSD 9003']")).not.toBeNull();
  });

  test("a close that fails keeps the position on the list, shows why, and Close can be pressed again", async () => {
    installFetch({
      order: () => json({ ok: false, error: { code: "POSITION_NOT_FOUND", message: "This position is no longer open on the account." } }, 404),
    });
    const view = await mountPanel();

    click(sureButton(view.container, "Close XAUUSD 9001"));
    await settle();

    expect(alerts(view.container)).toContain("This position is no longer open on the account.");
    expect(view.container.querySelector("[aria-label='Position XAUUSD 9001']")).not.toBeNull();
    expect(sureButton(view.container, "Close XAUUSD 9001").disabled).toBe(false);
  });

  test("fewer lots close only that part, and the button says so", async () => {
    const view = await mountPanel();
    await openCloseEditor(view);

    setValue(field(view.container, "Lots to close"), "0.04");
    click(button(view.container, "Close 0.04 lots"));
    await settle();

    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9001", volume: 0.04 });
    expect(text(view.container)).toContain("0.04 lots of XAUUSD closed.");
    // the part that is left is shown at once
    expect(view.container.querySelector("[aria-label='Position XAUUSD 9001']")?.textContent).toContain("0.06 lots");
  });

  test("the part-close editor closes the whole position when all the lots are asked for", async () => {
    const view = await mountPanel();
    await openCloseEditor(view);

    expect(field(view.container, "Lots to close").value).toBe("0.05");
    click(sureButton(view.container, "Close all of XAUUSD 9001"));
    expect(field(view.container, "Lots to close").value).toBe("0.1");
    click(button(view.container, "Close position"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9001" });
    expect(text(view.container)).toContain("XAUUSD position closed.");
  });

  test("Partial starts with half of the position", async () => {
    const view = await mountPanel();

    click(sureButton(view.container, "Close part of XAUUSD 9001"));
    await settle();

    expect(field(view.container, "Lots to close").value).toBe("0.05");
    click(button(view.container, "Close 0.05 lots"));
    await settle();
    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9001", volume: 0.05 });
  });

  test("the share buttons fill the lots, rounded down to a hundredth", async () => {
    installFetch({ state: stateWith([{ ...POSITION, volume: 0.37 }]) });
    const view = await mountPanel();
    await openCloseEditor(view);

    click(sureButton(view.container, "Close 25% of XAUUSD 9001"));
    expect(field(view.container, "Lots to close").value).toBe("0.09");
    click(sureButton(view.container, "Close 75% of XAUUSD 9001"));
    expect(field(view.container, "Lots to close").value).toBe("0.27");
    click(sureButton(view.container, "Close all of XAUUSD 9001"));
    expect(field(view.container, "Lots to close").value).toBe("0.37");
    expect(button(view.container, "Close position")).not.toBeNull();
  });

  test("more lots than the position holds are refused on the spot", async () => {
    const view = await mountPanel();
    await openCloseEditor(view);

    setValue(field(view.container, "Lots to close"), "0.5");
    click(button(view.container, "Close position"));
    await settle();

    expect(alerts(view.container)).toContain("The position has 0.1 lots open.");
    expect(orders()).toHaveLength(0);
  });

  test("a volume that is not a number is refused", async () => {
    const view = await mountPanel();
    await openCloseEditor(view);

    setValue(field(view.container, "Lots to close"), "half");
    click(button(view.container, "Close position"));
    await settle();

    expect(alerts(view.container)).toContain("Enter how many lots to close");
    expect(orders()).toHaveLength(0);
  });

  test("a part-close that fails keeps the editor and shows why", async () => {
    installFetch({
      order: () => json({ ok: false, error: { code: "POSITION_NOT_FOUND", message: "This position is no longer open on the account." } }, 404),
    });
    const view = await mountPanel();
    await openCloseEditor(view);

    click(button(view.container, "Close 0.05 lots"));
    await settle();

    expect(alerts(view.container)).toContain("This position is no longer open on the account.");
    expect(view.container.querySelector("#lots-9001")).not.toBeNull();
  });

  test("a part-close that went through closes the editor", async () => {
    const view = await mountPanel();
    await openCloseEditor(view);
    expect(view.container.querySelector("#lots-9001")).not.toBeNull();

    click(button(view.container, "Close 0.05 lots"));
    await settle();

    expect(view.container.querySelector("#lots-9001")).toBeNull();
    expect(text(view.container)).toContain("0.05 lots of XAUUSD closed.");
  });

  test("a close is never blocked by the person's own volume or stop loss rules, in either way", async () => {
    const view = await mountPanel({ initial: { requireStopLoss: true, maxVolume: 0.01 } });

    // the whole position: one click
    click(sureButton(view.container, "Close XAUUSD 9001"));
    await settle();
    expect(orders()).toHaveLength(1);
    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9001" });
  });

  test("a part-close is not blocked by those rules either", async () => {
    installFetch({ state: stateWith([POSITION, SMALL_WIN]) });
    const view = await mountPanel({ initial: { requireStopLoss: true, maxVolume: 0.01 } });

    click(sureButton(view.container, "Close part of XAUUSD 9003"));
    await settle();
    // half of 0.05 lots, rounded down to a hundredth
    click(button(view.container, "Close 0.02 lots"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9003", volume: 0.02 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pending orders
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - pending orders", () => {
  async function openPending(extra: Scenario = {}, props: HarnessProps = {}) {
    installFetch({ state: stateWith([POSITION], [PENDING_LIMIT, PENDING_STOP]), ...extra });
    const view = await mountPanel(props);
    click(bookTab(view.container, "Pending"));
    await settle();
    return view;
  }

  test("lists the orders with their kind, price and levels, and counts them", async () => {
    const view = await openPending();

    expect(bookTab(view.container, "Pending").textContent).toContain("Pending (2)");
    const limit = text(view.container.querySelector("[aria-label='Pending order EURUSD.m 9101']") as Element);
    expect(limit).toContain("Buy limit");
    expect(limit).toContain("0.2 lots");
    expect(limit).toContain("At 1.08");
    expect(limit).toContain("SL 1.07");
    expect(limit).toContain("TP -");
    expect(text(view.container.querySelector("[aria-label='Pending order XAUUSD 9102']") as Element)).toContain("Sell stop");
  });

  test("orders the broker listed but that could not be read are counted, not hidden", async () => {
    const view = await openPending({ state: (accountId, symbol) => json({ ok: true, data: stateFor(accountId, { quote: quoteFor(symbol), pending: [PENDING_LIMIT], pendingOrders: 3 }) }) });

    expect(bookTab(view.container, "Pending").textContent).toContain("Pending (3)");
    expect(text(view.container)).toContain("2 more pending orders exist at the broker but could not be read here.");
  });

  test("the editor starts with the order's price and levels, and only what changed is sent", async () => {
    const view = await openPending();
    click(sureButton(view.container, "Change price and levels of EURUSD.m 9101"));
    await settle();

    expect(field(view.container, "Price").value).toBe("1.08");
    expect(field(view.container, "Stop loss").value).toBe("1.07");
    expect(field(view.container, "Take profit").value).toBe("");

    setValue(field(view.container, "Price"), "1.079");
    click(button(view.container, "Save order"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].url).toBe("/api/terminal/trade/modify");
    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9101", price: 1.079 });
    expect(text(view.container)).toContain("Pending order EURUSD.m 9101 updated.");
    expect(view.container.querySelector("#pp-9101")).toBeNull();
  });

  test("a level can be added or removed on a pending order", async () => {
    const view = await openPending();
    click(sureButton(view.container, "Change price and levels of EURUSD.m 9101"));
    await settle();

    setValue(field(view.container, "Stop loss"), "");
    setValue(field(view.container, "Take profit"), "1.09");
    click(button(view.container, "Save order"));
    await settle();

    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9101", stopLoss: null, takeProfit: 1.09 });
  });

  test.each([
    ["nothing changed", {}, "The order is unchanged."],
    ["no price", { price: "" }, "Enter the price the order waits for (a number above zero)."],
    ["a price that is not a number", { price: "soon" }, "Enter the price the order waits for (a number above zero)."],
    ["a stop loss that is not a price", { stopLoss: "x" }, "Stop loss and take profit must be prices above zero."],
    ["a stop loss above the price of a buy", { stopLoss: "1.09" }, "For a buy the stop loss must be below the entry price."],
    ["a take profit below the price of a buy", { takeProfit: "1.07" }, "For a buy the take profit must be above the entry price."],
  ])("refuses %s before anything is sent", async (_name, input, message) => {
    const view = await openPending();
    click(sureButton(view.container, "Change price and levels of EURUSD.m 9101"));
    await settle();
    const typed = input as { price?: string; stopLoss?: string; takeProfit?: string };
    if (typed.price !== undefined) setValue(field(view.container, "Price"), typed.price);
    if (typed.stopLoss !== undefined) setValue(field(view.container, "Stop loss"), typed.stopLoss);
    if (typed.takeProfit !== undefined) setValue(field(view.container, "Take profit"), typed.takeProfit);

    click(button(view.container, "Save order"));
    await settle();

    expect(alerts(view.container)).toContain(message);
    expect(orders()).toHaveLength(0);
  });

  test("Delete removes the pending order with that one click - there is nothing to confirm", async () => {
    const view = await openPending();

    click(sureButton(view.container, "Delete pending order EURUSD.m 9101"));
    // the request is on its way before anything else could be asked
    expect(orders()).toHaveLength(1);
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].url).toBe("/api/terminal/trade/cancel");
    expect(orders()[0].body).toEqual({ accountId: A1, ticket: "9101" });
    expectNoConfirmation(view.container);
    resultNotice(view.container, "Pending order EURUSD.m 9101 deleted.");
  });

  test("the deleted order leaves the list at once and the other one stays", async () => {
    const view = await openPending();
    expect(bookTab(view.container, "Pending").textContent).toContain("Pending (2)");

    click(sureButton(view.container, "Delete pending order XAUUSD 9102"));
    await settle();

    // the polled picture still lists both: the answer of the trading system is laid over it
    expect(bookTab(view.container, "Pending").textContent).toContain("Pending (1)");
    expect(view.container.querySelector("[aria-label='Pending order XAUUSD 9102']")).toBeNull();
    expect(view.container.querySelector("[aria-label='Pending order EURUSD.m 9101']")).not.toBeNull();
  });

  test("a delete the broker refuses shows why and leaves the order on the list", async () => {
    const view = await openPending({
      order: () => json({ ok: false, error: { code: "PROVIDER_ERROR", message: "Order is locked" } }, 502),
    });

    click(sureButton(view.container, "Delete pending order EURUSD.m 9101"));
    await settle();

    expect(alerts(view.container)).toContain("Order is locked");
    expect(bookTab(view.container, "Pending").textContent).toContain("Pending (2)");
    expect(sureButton(view.container, "Delete pending order EURUSD.m 9101").disabled).toBe(false);
  });

  test("the broker's refusal to change an order is shown and the editor stays", async () => {
    const view = await openPending({
      order: () => json({ ok: false, error: { code: "PROVIDER_ERROR", message: "Invalid price" } }, 502),
    });
    click(sureButton(view.container, "Change price and levels of EURUSD.m 9101"));
    await settle();

    setValue(field(view.container, "Price"), "1.079");
    click(button(view.container, "Save order"));
    await settle();

    expect(alerts(view.container)).toContain("Invalid price");
    expect(view.container.querySelector("#pp-9101")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Several at once
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - closing several at once", () => {
  const MANY = [POSITION, LOSER, SMALL_WIN];

  async function mountMany(order?: Scenario["order"]) {
    installFetch({
      state: stateWith(MANY, [PENDING_LIMIT, PENDING_STOP]),
      order: order ?? ((_action, body) => json({ ok: true, data: { ok: true, ticket: null, closed: body.scope === "PROFIT" ? 2 : 1 } })),
    });
    return mountPanel();
  }

  test("each choice says how many positions it covers - without a click - and nothing is sent by looking", async () => {
    const view = await mountMany();

    // the number is on the chip itself and in its name for screen readers
    for (const [label, count] of [
      ["Close all", 3],
      ["Close winners", 2],
      ["Close losers", 1],
      ["Close buys", 1],
      ["Close sells", 2],
      ["Close this symbol", 2],
    ] as const) {
      const chip = sureButton(view.container, `${label} (${count})`);
      expect(chip.disabled).toBe(false);
      expect(chip.textContent ?? "").toMatch(new RegExp(`${count}$`));
    }
    expect(orders()).toHaveLength(0);
    expectNoConfirmation(view.container);
  });

  test("winners are closed with that one click and the result is reported", async () => {
    const view = await mountMany();

    click(sureButton(view.container, "Close winners (2)"));
    // the request is on its way before anything else could be asked
    expect(orders()).toHaveLength(1);
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].url).toBe("/api/terminal/trade/close-bulk");
    expect(orders()[0].body).toMatchObject({ accountId: A1, scope: "PROFIT", symbol: null });
    expect(orders()[0].body.clientRequestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    resultNotice(view.container, "2 positions closed.");
    expectNoConfirmation(view.container);
    // both winners are off the list at once; the loser stays
    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (1)");
    expect(view.container.querySelector("[aria-label='Position EURUSD.m 9002']")).not.toBeNull();
  });

  test("'This symbol' carries the symbol of the ticket", async () => {
    const view = await mountMany();

    click(sureButton(view.container, "Close this symbol (2)"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].body).toMatchObject({ scope: "SYMBOL", symbol: "XAUUSD" });
  });

  test("every bulk command gets its own request id", async () => {
    const view = await mountMany();

    click(sureButton(view.container, "Close losers (1)"));
    await settle();
    click(sureButton(view.container, "Close this symbol (2)"));
    await settle();

    expect(orders()).toHaveLength(2);
    expect(orders()[0].body.clientRequestId).not.toBe(orders()[1].body.clientRequestId);
  });

  test("a choice that covers nothing is switched off", async () => {
    installFetch({ state: stateWith([POSITION, SMALL_WIN]) });
    const view = await mountPanel();

    expect(sureButton(view.container, "Close losers (0)").disabled).toBe(true);
    expect(sureButton(view.container, "Close winners (2)").disabled).toBe(false);
    click(sureButton(view.container, "Close losers (0)"));
    await settle();
    expect(orders()).toHaveLength(0);
  });

  test("pending orders are deleted together from their own tab with one click", async () => {
    const view = await mountMany();
    click(bookTab(view.container, "Pending"));
    await settle();

    click(sureButton(view.container, "Delete all pending orders (2)"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(orders()[0].body).toMatchObject({ accountId: A1, scope: "PENDING", symbol: null });
    resultNotice(view.container, "1 pending order deleted.");
    expectNoConfirmation(view.container);
    // Only one of two deletions is confirmed and the answer does not identify which.
    // Keep the old list until the next broker snapshot rather than hiding an unconfirmed order.
    expect(bookTab(view.container, "Pending").textContent).toContain("Pending (2)");
  });

  test("positions that could not be closed are named, and the rest is still reported", async () => {
    const view = await mountMany(() =>
      json({
        ok: true,
        data: {
          ok: true,
          ticket: null,
          closed: 2,
          failed: 1,
          failures: [{ ticket: "9002", symbol: "EURUSD.m", message: "Market is closed" }],
        },
      }),
    );

    click(sureButton(view.container, "Close all (3)"));
    await settle();

    expect(text(view.container)).toContain("2 positions closed.");
    expect(alerts(view.container)).toContain("1 could not be handled - EURUSD.m 9002: Market is closed.");
    // the one that could not be closed is still on the list; the two that were closed are gone
    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (1)");
    expect(view.container.querySelector("[aria-label='Position EURUSD.m 9002']")).not.toBeNull();
    expect(view.container.querySelector("[aria-label='Position XAUUSD 9001']")).toBeNull();
  });

  test("the choices are switched off while a command travels, so nothing is sent twice", async () => {
    let release: (value: Response) => void = () => undefined;
    const view = await mountMany(() => new Promise<Response>((resolve) => (release = resolve)));

    click(sureButton(view.container, "Close winners (2)"));
    click(sureButton(view.container, "Close winners (2)"));
    click(sureButton(view.container, "Close all (3)"));
    await settle();

    expect(orders()).toHaveLength(1);
    expect(sureButton(view.container, "Close all (3)").disabled).toBe(true);

    release(json({ ok: true, data: { ok: true, ticket: null, closed: 2 } }));
    await settle();
    expect(orders()).toHaveLength(1);
  });

  test("a bulk command whose answer never came keeps its request id when it is sent again", async () => {
    let attempt = 0;
    const view = await mountMany(() => {
      attempt += 1;
      return attempt === 1
        ? json({ ok: false, error: { code: "ORDER_UNCERTAIN", message: "The order may have reached the broker." } }, 504)
        : json({ ok: true, data: { ok: true, ticket: null, closed: 2, repeated: true } });
    });

    click(sureButton(view.container, "Close winners (2)"));
    await settle();
    expect(alerts(view.container)).toContain("check the positions below before sending it again");
    click(sureButton(view.container, "Close winners (2)"));
    await settle();

    expect(orders()).toHaveLength(2);
    expect(orders()[1].body.clientRequestId).toBe(orders()[0].body.clientRequestId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What the platform does not allow
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - what the platform does not allow", () => {
  const MANAGE_BUTTONS = [
    "Change stop loss and take profit of XAUUSD 9001",
    "Move the stop loss of XAUUSD 9001 to break-even",
    "Close part of XAUUSD 9001",
    "Close XAUUSD 9001",
  ];

  test("without a subscription new orders and changes are switched off, and the reason is on screen", async () => {
    const message = "Activate your platform subscription to place and manage orders from WSA Trade.";
    installFetch({
      accounts: accountsResponse([tradeAccount(A1, "Alpha")], {
        canOpen: false,
        canManage: false,
        reason: "SUBSCRIPTION_REQUIRED",
        message,
      }),
    });
    const view = await mountPanel();

    expect(text(view.container)).toContain(message);
    expect(sureButton(view.container, "Buy XAUUSD at market").disabled).toBe(true);
    expect(sureButton(view.container, "Sell XAUUSD at market").disabled).toBe(true);
    for (const label of MANAGE_BUTTONS) expect(sureButton(view.container, label).disabled).toBe(true);
    // the positions can still be followed
    expect(text(view.container)).toContain("Positions (1)");
  });

  test("with execution switched off the panel is read only", async () => {
    installFetch({
      accounts: accountsResponse([tradeAccount(A1, "Alpha")], {
        canOpen: false,
        canManage: false,
        reason: "EXECUTION_DISABLED",
        message: "Order execution is switched off on this platform. You can still follow your positions here.",
      }),
    });
    const view = await mountPanel();

    expect(text(view.container)).toContain("Order execution is switched off on this platform.");
    expect(sureButton(view.container, "Buy XAUUSD at market").disabled).toBe(true);
    expect(sureButton(view.container, "Close XAUUSD 9001").disabled).toBe(true);
  });

  test("when the WSA trading system is not reporting in, orders are not offered and the reason is on screen", async () => {
    const message = "The WSA trading system is not reachable right now, so orders cannot be sent. Your positions are not affected.";
    installFetch({
      accounts: accountsResponse(
        [tradeAccount(A1, "Alpha")],
        { canOpen: false, canManage: false, reason: "GATEWAY_OFFLINE", message },
        "none",
      ),
    });
    const view = await mountPanel();

    expect(text(view.container)).toContain(message);
    expect(sureButton(view.container, "Buy XAUUSD at market").disabled).toBe(true);
    for (const label of MANAGE_BUTTONS) expect(sureButton(view.container, label).disabled).toBe(true);
  });

  test("risk rules block new orders but never closing or moving a stop", async () => {
    const riskMessage = "Risk rules block new orders on this account (Max drawdown). You can still close positions and change stop loss / take profit.";
    installFetch({ state: stateWith([POSITION], [], { riskBlocked: true, riskMessage }) });
    const view = await mountPanel();

    expect(text(view.container)).toContain(riskMessage);
    expect(sureButton(view.container, "Buy XAUUSD at market").disabled).toBe(true);
    expect(sureButton(view.container, "Sell XAUUSD at market").disabled).toBe(true);
    for (const label of MANAGE_BUTTONS) expect(sureButton(view.container, label).disabled).toBe(false);
  });

  test("an account connected with the investor password can be followed but not traded", async () => {
    installFetch({ state: stateWith([POSITION], [], { readOnly: true }) });
    const view = await mountPanel();

    expect(text(view.container)).toContain("read-only (investor) password");
    expect(sureButton(view.container, "Buy XAUUSD at market").disabled).toBe(true);
    for (const label of MANAGE_BUTTONS) expect(sureButton(view.container, label).disabled).toBe(true);
    expect(text(view.container)).toContain("Positions (1)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// More than one account
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - more than one account", () => {
  test("another account's positions are never shown as this account's while it loads", async () => {
    let releaseSecond: (value: Response) => void = () => undefined;
    installFetch({
      accounts: accountsResponse([tradeAccount(A1, "Alpha"), tradeAccount(A2, "Beta")]),
      state: (accountId) => {
        if (accountId === A2) return new Promise<Response>((resolve) => (releaseSecond = resolve));
        return json({ ok: true, data: stateFor(accountId) });
      },
    });
    const changes: WsaTradePatch[] = [];
    const view = await mountPanel({ onChange: (patch) => changes.push(patch) });
    expect(text(view.container)).toContain("Positions (1)");

    setValue(view.container.querySelector("select"), A2);
    await settle();

    expect(changes).toContainEqual({ accountId: A2 });
    expect(view.container.querySelector("ul[aria-label='Open positions']")).toBeNull();
    expect(text(view.container)).toContain("Reading the account from the broker…");
    expect(text(view.container)).not.toContain("10,050.00 USD");
    // the symbols of the broker are asked for the new account
    expect(symbolCalls().some((call) => call.url.includes(A2))).toBe(true);

    releaseSecond(json({ ok: true, data: stateFor(A2, { positions: [], balance: 250, equity: 250, floatingProfit: 0 }) }));
    await settle();

    expect(text(view.container)).toContain("No open positions on this account.");
    expect(text(view.container)).toContain("250.00 USD");
  });

  test("an account that is not connected cannot be picked", async () => {
    installFetch({
      accounts: accountsResponse([tradeAccount(A1, "Alpha"), tradeAccount(A2, "Beta", { status: "PENDING", reachable: false })]),
    });
    const view = await mountPanel();

    const choices = Array.from(view.container.querySelectorAll("option")).map((option) => [option.textContent, option.disabled]);

    expect(choices).toContainEqual(["Alpha · MT5 · IC Markets", false]);
    expect(choices).toContainEqual(["Beta · MT5 · IC Markets (not connected)", true]);
  });

  test("after the account is changed the next order is for the new account, and nothing is left over from the old one", async () => {
    installFetch({ accounts: accountsResponse([tradeAccount(A1, "Alpha"), tradeAccount(A2, "Beta")]) });
    const view = await mountPanel();
    await buyAtMarket(view);
    expect(orders()).toHaveLength(1);
    expect(orders()[0].body.accountId).toBe(A1);
    resultNotice(view.container, "Buy 0.01 XAUUSD sent to the broker.");

    setValue(view.container.querySelector("select"), A2);
    await settle();

    // the result line of the old account is gone; no order was sent by changing the account
    expect(() => resultNotice(view.container, "Buy 0.01 XAUUSD sent to the broker.")).toThrow("no result line");
    expect(orders()).toHaveLength(1);

    await buyAtMarket(view);
    expect(orders()).toHaveLength(2);
    expect(orders()[1].body.accountId).toBe(A2);
  });

  test("what an order changed on one account is never laid over another account", async () => {
    const mine = { ...POSITION, ticket: "9500" };
    installFetch({
      accounts: accountsResponse([tradeAccount(A1, "Alpha"), tradeAccount(A2, "Beta")]),
      state: (accountId, symbol) =>
        json({ ok: true, data: stateFor(accountId, { quote: quoteFor(symbol), positions: accountId === A1 ? [POSITION] : [LOSER] }) }),
      order: () =>
        json({ ok: true, data: { ok: true, ticket: "9500", detail: { fillPrice: 2301.4, volume: 0.01 } } }),
    });
    const view = await mountPanel();
    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (1)");

    await buyAtMarket(view);
    // the position that was just bought shows at once on the account it was bought on ...
    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (2)");
    expect(view.container.querySelector(`[aria-label='Position XAUUSD ${mine.ticket}']`)).not.toBeNull();

    // ... and not on the other account
    setValue(view.container.querySelector("select"), A2);
    await settle();
    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (1)");
    expect(view.container.querySelector(`[aria-label='Position XAUUSD ${mine.ticket}']`)).toBeNull();
    expect(view.container.querySelector("[aria-label='Position EURUSD.m 9002']")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// How long it took
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - how long it took", () => {
  /** Every part of the report: the trading system's own times and the web server's. The server is slow enough that the browser's own total cannot exceed it. */
  const FULL_TIMING = { queueMs: 120, runMs: 330, sessionMs: 12, sendMs: 310, serverMs: 9000, waitMs: 8500 };

  test("the whole wait stands next to the result and the parts of it are listed under it", async () => {
    installFetch({ order: () => json({ ok: true, data: { ok: true, ticket: "9001", timing: FULL_TIMING } }) });
    const view = await mountPanel();

    await buyAtMarket(view);

    const notice = resultNotice(view.container, "Buy 0.01 XAUUSD sent to the broker.");
    // the browser measured the whole wait itself
    expect(notice.querySelector("strong")?.textContent).toMatch(/^\d+ ms$/);
    // network = total - server; server = server - wait; relay = wait - queue - broker
    expect(notice.querySelectorAll("p")[1]?.textContent).toMatch(
      /^\d+ ms in total: network 0 ms · server 500 ms · queue 120 ms · broker 330 ms \(session 12 ms · send 310 ms\) · relay 8\.05 s/,
    );
  });

  test("an older server that reports only the trading system's time still gets a line", async () => {
    installFetch({ order: () => json({ ok: true, data: { ok: true, ticket: "9001", timing: { queueMs: 120, runMs: 63 } } }) });
    const view = await mountPanel();

    await buyAtMarket(view);

    const notice = resultNotice(view.container, "Buy 0.01 XAUUSD sent to the broker.");
    expect(notice.querySelectorAll("p")[1]?.textContent).toBe("183 ms (queue 120 ms · broker 63 ms)");
  });

  test("an answer without any timing shows the result and no time line", async () => {
    const view = await mountPanel();

    await buyAtMarket(view);

    const notice = resultNotice(view.container, "Buy 0.01 XAUUSD sent to the broker.");
    expect(notice.querySelector("strong")).toBeNull();
    expect(notice.querySelectorAll("p")).toHaveLength(1);
  });

  test("the time is kept in the Activity list next to what was sent", async () => {
    installFetch({ order: () => json({ ok: true, data: { ok: true, ticket: "9001", timing: FULL_TIMING } }) });
    const view = await mountPanel();

    await buyAtMarket(view);
    click(bookTab(view.container, "Activity"));
    await settle();

    const entry = view.container.querySelector("ol[aria-label='Activity'] li") as Element;
    expect(entry.textContent).toContain("Buy 0.01 XAUUSD sent to the broker.");
    expect(entry.querySelector("strong")?.textContent).toMatch(/^\d+ ms$/);
    expect(entry.textContent).toContain("queue 120 ms · broker 330 ms (session 12 ms · send 310 ms)");
  });

  test("an order the server had already handled reports no time, because nothing was sent", async () => {
    installFetch({
      order: () => json({ ok: true, data: { ok: true, ticket: "9001", repeated: true, timing: FULL_TIMING } }),
    });
    const view = await mountPanel();

    await buyAtMarket(view);

    const notice = resultNotice(view.container, "This order had already been sent - nothing was sent twice.");
    expect(notice.querySelector("strong")).toBeNull();
    expect(notice.querySelectorAll("p")).toHaveLength(1);
  });

  test("a failed command shows its reason and no result line", async () => {
    installFetch({
      order: () => json({ ok: false, error: { code: "PROVIDER_ERROR", message: "Market is closed" } }, 502),
    });
    const view = await mountPanel();

    await buyAtMarket(view);

    expect(alerts(view.container)).toContain("Market is closed");
    expect(() => resultNotice(view.container, "sent to the broker")).toThrow("no result line");
  });

  test("the result of the last command is cleared as soon as the next one starts", async () => {
    let release: (value: Response) => void = () => undefined;
    let attempt = 0;
    installFetch({
      order: () => {
        attempt += 1;
        return attempt === 1
          ? json({ ok: true, data: { ok: true, ticket: "9001", timing: FULL_TIMING } })
          : new Promise<Response>((resolve) => (release = resolve));
      },
    });
    const view = await mountPanel();
    await buyAtMarket(view);
    resultNotice(view.container, "Buy 0.01 XAUUSD sent to the broker.");

    click(sureButton(view.container, "Sell XAUUSD at market"));
    await settle();

    // the old line must not be mistaken for the answer to the order that is still travelling
    expect(() => resultNotice(view.container, "sent to the broker")).toThrow("no result line");

    release(json({ ok: true, data: { ok: true, ticket: "9002", timing: { queueMs: 1, runMs: 2 } } }));
    await settle();
    resultNotice(view.container, "Sell 0.01 XAUUSD sent to the broker.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What the lists show at once
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - what the lists show at once", () => {
  const BOUGHT = { ok: true, ticket: "9500", detail: { fillPrice: 2301.4, volume: 0.01 } };

  test("a bought position is listed the moment the trading system confirms it, before the next picture", async () => {
    installFetch({ order: () => json({ ok: true, data: BOUGHT }) });
    const view = await mountPanel();
    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (1)");

    await buyAtMarket(view);

    // the polled picture still has one position: the new one comes from the answer
    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (2)");
    const card = view.container.querySelector("[aria-label='Position XAUUSD 9500']") as Element;
    expect(card).not.toBeNull();
    expect(text(card)).toContain("0.01 lots");
    expect(text(card)).toContain("Open 2301.4");
    // and it can be closed straight away
    expect(sureButton(view.container, "Close XAUUSD 9500").disabled).toBe(false);
  });

  test("the position that was just bought is not listed twice when the real picture has it too", async () => {
    installFetch({
      state: stateWith([POSITION, { ...POSITION, ticket: "9500", volume: 0.01, openPrice: 2301.4, profit: -0.3 }]),
      order: () => json({ ok: true, data: BOUGHT }),
    });
    const view = await mountPanel();

    await buyAtMarket(view);

    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (2)");
    expect(view.container.querySelectorAll("[aria-label='Position XAUUSD 9500']")).toHaveLength(1);
  });

  test("a refused order lists nothing", async () => {
    installFetch({ order: () => json({ ok: false, error: { code: "PROVIDER_ERROR", message: "Invalid stops" } }, 502) });
    const view = await mountPanel();

    await buyAtMarket(view);

    expect(bookTab(view.container, "Positions").textContent).toContain("Positions (1)");
    expect(view.container.querySelector("[aria-label='Position XAUUSD 9500']")).toBeNull();
  });

  test("a limit order that was placed is listed under Pending at once", async () => {
    installFetch({ order: () => json({ ok: true, data: { ok: true, ticket: "9600" } }) });
    const view = await mountPanel({ initial: { orderKind: "LIMIT" } });
    expect(bookTab(view.container, "Pending").textContent).toContain("Pending (0)");
    setValue(field(view.container, "Price (entry)"), "2295");

    click(sureButton(view.container, "Buy XAUUSD limit"));
    await settle();

    expect(bookTab(view.container, "Pending").textContent).toContain("Pending (1)");
    click(bookTab(view.container, "Pending"));
    await settle();
    const card = view.container.querySelector("[aria-label='Pending order XAUUSD 9600']") as Element;
    expect(card).not.toBeNull();
    expect(text(card)).toContain("Buy limit");
    expect(text(card)).toContain("At 2295");
  });

  test("new stop loss and take profit are shown at once", async () => {
    const view = await mountPanel();
    click(sureButton(view.container, "Change stop loss and take profit of XAUUSD 9001"));
    await settle();
    setValue(field(view.container, "Take profit"), "2320");
    setValue(field(view.container, "Stop loss"), "2295");

    click(button(view.container, "Save levels"));
    await settle();

    const card = view.container.querySelector("[aria-label='Position XAUUSD 9001']") as Element;
    // the polled picture still says SL 2290 / TP none
    expect(text(card)).toContain("SL 2295 · TP 2320");
  });

  test("break-even moves the stop loss on the list at once", async () => {
    const view = await mountPanel();

    click(sureButton(view.container, "Move the stop loss of XAUUSD 9001 to break-even"));
    await settle();

    expect(text(view.container.querySelector("[aria-label='Position XAUUSD 9001']") as Element)).toContain("SL 2300.5");
    // the stop loss is at the entry now: break-even is no longer offered
    expect(sureButton(view.container, "Move the stop loss of XAUUSD 9001 to break-even").disabled).toBe(true);
  });

  test("the changed price of a pending order is shown at once", async () => {
    installFetch({ state: stateWith([POSITION], [PENDING_LIMIT]) });
    const view = await mountPanel();
    click(bookTab(view.container, "Pending"));
    await settle();
    click(sureButton(view.container, "Change price and levels of EURUSD.m 9101"));
    await settle();
    setValue(field(view.container, "Price"), "1.079");

    click(button(view.container, "Save order"));
    await settle();

    expect(text(view.container.querySelector("[aria-label='Pending order EURUSD.m 9101']") as Element)).toContain("At 1.079");
  });

  test("the changes fade out after a few seconds, when the real picture has long caught up", async () => {
    // hold back the timers of the changes (and only those) so the end of their life can be reached at once
    const realSetTimeout = globalThis.setTimeout;
    const held: Array<() => void> = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === OVERLAY_TTL_MS && typeof handler === "function") {
        held.push(() => handler(...args));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout);
    try {
      const view = await mountPanel();

      click(sureButton(view.container, "Close XAUUSD 9001"));
      await settle();
      expect(bookTab(view.container, "Positions").textContent).toContain("Positions (0)");
      expect(held).toHaveLength(1);

      act(() => {
        for (const expire of held) expire();
      });
      await settle();

      // the polled picture is the truth again (here it still lists the position)
      expect(bookTab(view.container, "Positions").textContent).toContain("Positions (1)");
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The order routes are kept warm
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - routes kept warm", () => {
  const warmCalls = () => calls.filter((call) => call.method === "GET" && /\/api\/terminal\/trade\/(open|modify|close|cancel|close-bulk)$/.test(call.url));
  /** The wake-ups that carry the account: the route reads - as the signed-in person - what an order on it checks. */
  const accountWarmCalls = () =>
    calls.filter((call) => call.method === "GET" && /\/api\/terminal\/trade\/(open|modify|close|cancel|close-bulk)\?accountId=/.test(call.url));
  const routeOf = (call: { url: string }) => call.url.split("?")[0].split("/").pop();

  test("the five order routes are woken up once when the panel opens", async () => {
    await mountPanel();

    expect(warmCalls().map((call) => call.url.split("/").pop()).sort()).toEqual(["cancel", "close", "close-bulk", "modify", "open"]);
  });

  test("a hidden panel does not wake anything", async () => {
    await mountPanel({ active: false });

    expect(warmCalls()).toHaveLength(0);
    expect(accountWarmCalls()).toHaveLength(0);
  });

  test("once the account is known the routes also read what an order on it checks", async () => {
    await mountPanel();

    expect(accountWarmCalls().map((call) => call.url).sort()).toEqual(
      ["cancel", "close", "close-bulk", "modify", "open"].map((route) => `/api/terminal/trade/${route}?accountId=${A1}`).sort(),
    );
  });

  test("another account is warmed for itself", async () => {
    installFetch({ accounts: accountsResponse([tradeAccount(A1, "Alpha"), tradeAccount(A2, "Beta")]) });
    const view = await mountPanel();
    expect(accountWarmCalls().every((call) => call.url.endsWith(`accountId=${A1}`))).toBe(true);

    setValue(view.container.querySelector("select"), A2);
    await settle(6);

    expect(accountWarmCalls().filter((call) => call.url.endsWith(`accountId=${A2}`)).map(routeOf).sort()).toEqual([
      "cancel",
      "close",
      "close-bulk",
      "modify",
      "open",
    ]);
  });

  test("a hand reaching for the panel renews the three routes that run orders - at most once every eight seconds", async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const view = await mountPanel();
      const panel = view.container.querySelector("section[aria-label='WSA Trade']");
      expect(panel).not.toBeNull();
      const afterOpening = accountWarmCalls().length;
      expect(afterOpening).toBe(5);

      // the routes were just warmed: a pointer over the panel changes nothing
      act(() => {
        panel?.dispatchEvent(new Event("pointermove", { bubbles: true }));
      });
      expect(accountWarmCalls()).toHaveLength(afterOpening);

      // eight seconds on, the next hand renews open / close / modify - only those, only for this account
      clock += 8_100;
      act(() => {
        panel?.dispatchEvent(new Event("pointermove", { bubbles: true }));
      });
      const renewed = accountWarmCalls().slice(afterOpening);
      expect(renewed.map(routeOf).sort()).toEqual(["close", "modify", "open"]);
      expect(renewed.every((call) => call.url.endsWith(`?accountId=${A1}`))).toBe(true);

      // and a key, a focus or a press right after it: nothing more
      keyDown(panel, "Shift");
      act(() => {
        panel?.dispatchEvent(new Event("focusin", { bubbles: true }));
        panel?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      expect(accountWarmCalls()).toHaveLength(afterOpening + 3);

      // a key is as good as a pointer once the time has passed
      clock += 8_100;
      keyDown(panel, "Shift");
      expect(accountWarmCalls()).toHaveLength(afterOpening + 6);
    } finally {
      now.mockRestore();
    }
  });

  test("with no account to trade with a hand on the panel wakes nothing", async () => {
    installFetch({ accounts: accountsResponse([]) });
    const view = await mountPanel({ suggested: null });
    const before = calls.length;
    const panel = view.container.querySelector("section[aria-label='WSA Trade']");

    act(() => {
      panel?.dispatchEvent(new Event("pointermove", { bubbles: true }));
    });

    expect(accountWarmCalls()).toHaveLength(0);
    expect(calls).toHaveLength(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The size of the panel
// ─────────────────────────────────────────────────────────────────────────────

describe("WsaTradePanel - panel size", () => {
  /** A ResizeObserver the test can drive: `fire(width, height)` tells every watching panel how much room it has. */
  function stubResizeObserver() {
    const watching: Array<{ callback: ResizeObserverCallback; nodes: Element[] }> = [];
    class FakeResizeObserver {
      private readonly entry: { callback: ResizeObserverCallback; nodes: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, nodes: [] };
        watching.push(this.entry);
      }
      observe(node: Element) {
        this.entry.nodes.push(node);
      }
      unobserve() {}
      disconnect() {
        this.entry.nodes = [];
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    return {
      fire(width: number, height: number) {
        act(() => {
          for (const entry of watching) {
            if (entry.nodes.length === 0) continue;
            entry.callback([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
          }
        });
      },
    };
  }

  const section = (container: ParentNode) => container.querySelector("section[aria-label='WSA Trade']") as HTMLElement;
  /** everything under the title bar: it is the part that is zoomed */
  const zoomed = (container: ParentNode) => section(container).children[1] as HTMLElement;
  const sizeGroup = (container: ParentNode) => container.querySelector("[role='group'][aria-label='Panel size']") as HTMLElement;
  const smaller = (container: ParentNode) => sureButton(container, "Make the panel smaller");
  const larger = (container: ParentNode) => sureButton(container, "Make the panel larger");
  const sizeLabel = (container: ParentNode) => (sizeGroup(container).querySelectorAll("button")[1] as HTMLButtonElement).textContent;
  /** ticket and lists side by side, or one under the other */
  const sideBySide = (container: ParentNode) =>
    Array.from(container.querySelectorAll("div")).some((item) => item.className.includes("grid-cols-[minmax(340px,420px)_minmax(0,1fr)]"));

  test("with no room measured and no size chosen the panel is at 100%, fitted automatically", async () => {
    const view = await mountPanel();

    expect(sizeLabel(view.container)).toBe("Auto 100%");
    expect(sureButton(view.container, "Panel size: fits automatically (100%)")).not.toBeNull();
    expect(zoomed(view.container).style.zoom).toBeFalsy();
    expect(sideBySide(view.container)).toBe(false);
  });

  test("the zoom buttons make the panel smaller and larger in steps and the choice is saved", async () => {
    const changes: WsaTradePatch[] = [];
    const view = await mountPanel({ onChange: (patch) => changes.push(patch) });

    click(smaller(view.container));
    await settle();
    expect(changes).toContainEqual({ zoom: 0.9 });
    expect(sizeLabel(view.container)).toBe("90%");
    expect(zoomed(view.container).style.zoom).toBe("0.9");

    click(larger(view.container));
    click(larger(view.container));
    await settle();
    expect(changes).toContainEqual({ zoom: 1 });
    expect(changes).toContainEqual({ zoom: 1.1 });
    expect(sizeLabel(view.container)).toBe("110%");
    expect(zoomed(view.container).style.zoom).toBe("1.1");
  });

  test("a click on the size goes back to fitting the room automatically", async () => {
    const changes: WsaTradePatch[] = [];
    const view = await mountPanel({ initial: { zoom: 1.2 }, onChange: (patch) => changes.push(patch) });
    expect(sizeLabel(view.container)).toBe("120%");

    click(sureButton(view.container, "Panel size 120% - click to fit automatically"));
    await settle();

    expect(changes).toContainEqual({ zoom: null });
    expect(sizeLabel(view.container)).toBe("Auto 100%");
  });

  test("the limits are 60% and 160%", async () => {
    const lowest = await mountPanel({ initial: { zoom: 0.6 } });
    expect(smaller(lowest.container).disabled).toBe(true);
    expect(larger(lowest.container).disabled).toBe(false);
    unmountAll();

    const highest = await mountPanel({ initial: { zoom: 1.6 } });
    expect(larger(highest.container).disabled).toBe(true);
    expect(smaller(highest.container).disabled).toBe(false);
  });

  test("the title bar with the size buttons is not zoomed, so they stay in reach", async () => {
    const view = await mountPanel({ initial: { zoom: 0.7 } });

    expect(section(view.container).children[0].contains(sizeGroup(view.container))).toBe(true);
    expect(zoomed(view.container).contains(sizeGroup(view.container))).toBe(false);
    expect(zoomed(view.container).style.zoom).toBe("0.7");
    // the ticket is inside the zoomed part: Buy and Sell are reached by the zoom
    expect(zoomed(view.container).contains(sureButton(view.container, "Buy XAUUSD at market"))).toBe(true);
  });

  test("a narrow or low pane makes the panel smaller by itself, never below 80%", async () => {
    const room = stubResizeObserver();
    const view = await mountPanel();

    room.fire(342, 900);
    expect(sizeLabel(view.container)).toBe("Auto 90%");

    room.fire(300, 500);
    expect(sizeLabel(view.container)).toBe("Auto 80%");
    expect(zoomed(view.container).style.zoom).toBe("0.8");

    room.fire(1000, 900);
    expect(sizeLabel(view.container)).toBe("Auto 100%");
    expect(zoomed(view.container).style.zoom).toBeFalsy();
  });

  test("a size the person chose is not changed by the room", async () => {
    const room = stubResizeObserver();
    const view = await mountPanel({ initial: { zoom: 1.3 } });

    room.fire(300, 500);

    expect(sizeLabel(view.container)).toBe("130%");
    expect(zoomed(view.container).style.zoom).toBe("1.3");
  });

  test("ticket and lists stand side by side when the room allows it and one under the other when it does not", async () => {
    const room = stubResizeObserver();
    const view = await mountPanel();

    room.fire(900, 800);
    expect(sideBySide(view.container)).toBe(true);

    room.fire(500, 800);
    expect(sideBySide(view.container)).toBe(false);
  });

  test("the room is counted at the zoom in force: a smaller panel fits more across the same width", async () => {
    const room = stubResizeObserver();
    const small = await mountPanel({ initial: { zoom: 0.8 } });
    room.fire(600, 800);
    // 600 / 0.8 = 750 >= 720
    expect(sideBySide(small.container)).toBe(true);
    unmountAll();

    const large = await mountPanel({ initial: { zoom: 1.6 } });
    room.fire(900, 800);
    // 900 / 1.6 = 562 < 720
    expect(sideBySide(large.container)).toBe(false);
  });

  test("the ticket, the lists and the buttons all work at any zoom", async () => {
    const view = await mountPanel({ initial: { zoom: 0.6 } });

    await buyAtMarket(view);
    click(sureButton(view.container, "Close XAUUSD 9001"));
    await settle();

    expect(orders().map((call) => call.url)).toEqual(["/api/terminal/trade/open", "/api/terminal/trade/close"]);
  });
});
