import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { encryptSecret } from "@/lib/crypto/brokerCrypto";
import { AuthError, requireAuth } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/services/auditService";
import { GET as listAccounts } from "@/app/api/terminal/metatrader/accounts/route";
import { POST as launchAccount } from "@/app/api/terminal/metatrader/launch/route";
import { POST as resolveTerminal } from "@/app/api/terminal/metatrader/resolve/route";
import { resolveBrokerWebTerminal } from "@/lib/services/brokerWebTerminalService";
import { GET as getWorkspace, PATCH as patchWorkspace } from "@/app/api/terminal/workspace/route";
import { PATCH as patchPreferences } from "@/app/api/terminal/preferences/route";
import { defaultWorkspace, MAX_WORKSPACE_BYTES } from "@/lib/terminal/workspace";
import { fakeDb, type Row } from "./helpers/fakeSupabase";

vi.mock("@/lib/supabase/admin", async () => {
  const { fakeDb: db } = await import("./helpers/fakeSupabase");
  return { createAdminClient: () => ({ from: db.from }) };
});

vi.mock("@/lib/auth/session", () => {
  class AuthError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly statusCode: number = 401,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  return { AuthError, requireAuth: vi.fn() };
});

vi.mock("@/lib/services/auditService", () => ({ writeAuditLog: vi.fn(async () => undefined) }));

// the search for a broker's web terminal (network, cache) has its own tests; the route is checked on what it passes in
vi.mock("@/lib/services/brokerWebTerminalService", () => ({ resolveBrokerWebTerminal: vi.fn() }));

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const FOREIGN_ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const PASSWORD = "Sup3r-Secret-pw!";
const LOGIN = "88776655";
const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

const trader = { id: USER, email: "trader@example.com", role: "TRADER", status: "ACTIVE" };

function signIn(overrides: Partial<typeof trader> = {}) {
  vi.mocked(requireAuth).mockResolvedValue({ ...trader, ...overrides } as Awaited<ReturnType<typeof requireAuth>>);
}

function accountRow(id: string, userId: string, overrides: Row = {}): Row {
  return {
    id,
    user_id: userId,
    account_name: "Main account",
    broker_name: "IC Markets",
    broker_server: "ICMarketsSC-Demo",
    broker_platform: "MT5",
    currency: "USD",
    status: "CONNECTED",
    ...overrides,
  };
}

function credentialRow(accountId: string): Row {
  return {
    trading_account_id: accountId,
    encrypted_reference: encryptSecret(
      JSON.stringify({ login: LOGIN, password: PASSWORD, server: "ICMarketsSC-Demo02", platform: "MT5" }),
    ),
  };
}

function post(url: string, body: unknown, method = "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// the envelope is checked field by field in the tests below, so its payload is deliberately loose
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseData = any;

async function readJson(response: Response): Promise<{ ok: boolean; data?: LooseData; error?: { code: string; message: string } }> {
  return (await response.json()) as never;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "unit-test-encryption-key";
  fakeDb.reset();
  vi.mocked(writeAuditLog).mockClear();
  signIn();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("GET /api/terminal/metatrader/accounts", () => {
  test("needs a signed-in user", async () => {
    vi.mocked(requireAuth).mockRejectedValue(new AuthError("UNAUTHORIZED", "Not authenticated", 401));
    const response = await listAccounts();
    expect(response.status).toBe(401);
    expect((await readJson(response)).error?.code).toBe("UNAUTHORIZED");
  });

  test("partners have no trading terminal", async () => {
    signIn({ role: "PARTNER" });
    const response = await listAccounts();
    expect(response.status).toBe(403);
    expect(fakeDb.calls).toHaveLength(0);
  });

  test("returns the caller's accounts only, uncached, without secrets", async () => {
    fakeDb.tables.trading_accounts = [accountRow(ACCOUNT_1, USER), accountRow(FOREIGN_ACCOUNT, OTHER_USER)];
    fakeDb.tables.broker_credentials = [credentialRow(ACCOUNT_1), credentialRow(FOREIGN_ACCOUNT)];

    const response = await listAccounts();
    const text = await response.clone().text();
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.ok).toBe(true);
    expect(body.data.accounts.map((entry: { accountId: string }) => entry.accountId)).toEqual([ACCOUNT_1]);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(LOGIN);
  });

  test("an administrator also sees only their own accounts here", async () => {
    signIn({ role: "ADMIN" });
    fakeDb.tables.trading_accounts = [accountRow(FOREIGN_ACCOUNT, OTHER_USER)];
    fakeDb.tables.broker_credentials = [credentialRow(FOREIGN_ACCOUNT)];

    const body = await readJson(await listAccounts());

    expect(body.data.accounts).toEqual([]);
  });
});

describe("POST /api/terminal/metatrader/launch", () => {
  beforeEach(() => {
    fakeDb.tables.trading_accounts = [accountRow(ACCOUNT_1, USER), accountRow(FOREIGN_ACCOUNT, OTHER_USER)];
    fakeDb.tables.broker_credentials = [credentialRow(ACCOUNT_1), credentialRow(FOREIGN_ACCOUNT)];
  });

  test("needs a signed-in, non-partner user", async () => {
    vi.mocked(requireAuth).mockRejectedValue(new AuthError("UNAUTHORIZED", "Not authenticated", 401));
    expect((await launchAccount(post("/x", { accountId: ACCOUNT_1 }))).status).toBe(401);

    signIn({ role: "PARTNER" });
    expect((await launchAccount(post("/x", { accountId: ACCOUNT_1 }))).status).toBe(403);
  });

  test.each([
    ["not json", "{nope"],
    ["no id", {}],
    ["not a uuid", { accountId: "12345" }],
    ["a number", { accountId: 5 }],
    ["an injection attempt", { accountId: "x' or '1'='1" }],
  ])("rejects a body that is %s", async (_name, body) => {
    const response = await launchAccount(post("/x", body));
    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.calls).toHaveLength(0);
  });

  test("opens an own account: login, server and platform - and nothing secret - and audits it", async () => {
    const response = await launchAccount(post("/x", { accountId: ACCOUNT_1 }));
    const text = await response.clone().text();
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.data).toEqual({
      accountId: ACCOUNT_1,
      accountName: "Main account",
      brokerName: "IC Markets",
      platform: "MT5",
      server: "ICMarketsSC-Demo02",
      login: LOGIN,
    });
    expect(text).not.toContain(PASSWORD);

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const audit = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(audit).toEqual({
      actorUserId: USER,
      action: "METATRADER_TERMINAL_LAUNCHED",
      entityType: "trading_account",
      entityId: ACCOUNT_1,
      metadata: { platform: "MT5" },
    });
    expect(JSON.stringify(audit)).not.toContain(LOGIN);
    expect(JSON.stringify(audit)).not.toContain("ICMarketsSC");
  });

  test("an upper-case id is accepted", async () => {
    const response = await launchAccount(post("/x", { accountId: ACCOUNT_1.toUpperCase() }));
    expect(response.status).toBe(200);
  });

  test("somebody else's account is a 404 - even for an administrator - and is not audited", async () => {
    for (const role of ["TRADER", "ADMIN", "SUPER_ADMIN"] as const) {
      signIn({ role });
      const response = await launchAccount(post("/x", { accountId: FOREIGN_ACCOUNT }));
      expect(response.status).toBe(404);
      expect((await readJson(response)).error?.code).toBe("ACCOUNT_NOT_FOUND");
    }
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("an account without a stored login is a 409 and is not audited", async () => {
    fakeDb.tables.broker_credentials = [];
    const response = await launchAccount(post("/x", { accountId: ACCOUNT_1 }));
    expect(response.status).toBe(409);
    expect((await readJson(response)).error?.code).toBe("CREDENTIALS_MISSING");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("unexpected failures are a generic 500", async () => {
    fakeDb.selectErrors.trading_accounts = { message: "db exploded" };
    const response = await launchAccount(post("/x", { accountId: ACCOUNT_1 }));
    expect(response.status).toBe(500);
    expect((await readJson(response)).error?.code).toBe("INTERNAL_ERROR");
  });
});

describe("POST /api/terminal/metatrader/resolve", () => {
  const FOUND = {
    serverKey: "icmarketssc",
    status: "FOUND",
    url: "https://webtrader.icmarkets.com/",
    host: "webtrader.icmarkets.com",
    source: "DISCOVERED",
    embeddable: true,
    brokerName: "IC Markets",
    checkedAt: "2026-10-12T12:00:00.000Z",
  };
  const lastInput = () => vi.mocked(resolveBrokerWebTerminal).mock.calls[0][0];

  beforeEach(() => {
    fakeDb.tables.trading_accounts = [accountRow(ACCOUNT_1, USER), accountRow(FOREIGN_ACCOUNT, OTHER_USER)];
    fakeDb.tables.broker_credentials = [credentialRow(ACCOUNT_1), credentialRow(FOREIGN_ACCOUNT)];
    vi.mocked(resolveBrokerWebTerminal).mockReset();
    vi.mocked(resolveBrokerWebTerminal).mockResolvedValue({ ...FOUND } as never);
  });

  test("needs a signed-in, non-partner user", async () => {
    vi.mocked(requireAuth).mockRejectedValue(new AuthError("UNAUTHORIZED", "Not authenticated", 401));
    expect((await resolveTerminal(post("/x", { accountId: ACCOUNT_1 }))).status).toBe(401);

    signIn({ role: "PARTNER" });
    expect((await resolveTerminal(post("/x", { accountId: ACCOUNT_1 }))).status).toBe(403);
    expect(resolveBrokerWebTerminal).not.toHaveBeenCalled();
    expect(fakeDb.calls).toHaveLength(0);
  });

  test.each([
    ["not json", "{nope"],
    ["json null", "null"],
    ["empty", {}],
    ["a list", []],
    ["not a uuid", { accountId: "12345" }],
    ["a number", { accountId: 5 }],
    ["an injection attempt", { accountId: "x' or '1'='1" }],
    ["a server without a platform", { server: "ICMarketsSC-Demo" }],
    ["an unknown platform", { server: "ICMarketsSC-Demo", platform: "MT6" }],
    ["a platform without a server", { platform: "MT5" }],
    ["a server that is markup", { server: "<script>", platform: "MT5" }],
  ])("rejects a body that is %s", async (_name, body) => {
    const response = await resolveTerminal(post("/x", body));
    expect(response.status).toBe(400);
    expect((await readJson(response)).error?.code).toBe("VALIDATION_ERROR");
    expect(resolveBrokerWebTerminal).not.toHaveBeenCalled();
    expect(fakeDb.calls).toHaveLength(0);
  });

  test("an own account is answered from the account itself: its server, platform and broker - nothing secret", async () => {
    const response = await resolveTerminal(post("/api/terminal/metatrader/resolve", { accountId: ACCOUNT_1 }));
    const text = await response.clone().text();
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(FOUND);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(LOGIN);

    expect(resolveBrokerWebTerminal).toHaveBeenCalledTimes(1);
    expect(lastInput()).toEqual({
      userId: USER,
      server: "ICMarketsSC-Demo02", // the server stored with the login, not the account's display name
      platform: "MT5",
      brokerName: "IC Markets",
      ownOrigin: "http://localhost",
      refresh: false,
    });
    // looking something up is not opening the account
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  test("the placeholder broker name of the platform's own accounts is not passed on", async () => {
    fakeDb.tables.trading_accounts = [accountRow(ACCOUNT_1, USER, { broker_name: "WSA GLOBAL" })];
    await resolveTerminal(post("/x", { accountId: ACCOUNT_1.toUpperCase() }));
    expect(lastInput().brokerName).toBeNull();
  });

  test("somebody else's account is a 404 - even for an administrator", async () => {
    for (const role of ["TRADER", "ADMIN", "SUPER_ADMIN"] as const) {
      signIn({ role });
      const response = await resolveTerminal(post("/x", { accountId: FOREIGN_ACCOUNT }));
      expect(response.status).toBe(404);
      expect((await readJson(response)).error?.code).toBe("ACCOUNT_NOT_FOUND");
    }
    expect(resolveBrokerWebTerminal).not.toHaveBeenCalled();
  });

  test("an account without a stored login is a 409", async () => {
    fakeDb.tables.broker_credentials = [];
    const response = await resolveTerminal(post("/x", { accountId: ACCOUNT_1 }));
    expect(response.status).toBe(409);
    expect((await readJson(response)).error?.code).toBe("CREDENTIALS_MISSING");
    expect(resolveBrokerWebTerminal).not.toHaveBeenCalled();
  });

  test("an account added by hand sends only its server name and platform - no database access", async () => {
    const response = await resolveTerminal(post("/x", { server: "  ICMarketsSC-Demo ", platform: "mt5" }));
    expect(response.status).toBe(200);
    expect(lastInput()).toEqual({
      userId: USER,
      server: "ICMarketsSC-Demo",
      platform: "MT5",
      brokerName: null,
      ownOrigin: "http://localhost",
      refresh: false,
    });
    expect(fakeDb.calls).toHaveLength(0);
  });

  test("an address in the request is never used - the search only ever starts from a server name", async () => {
    await resolveTerminal(
      post("/x", {
        server: "ICMarketsSC-Demo",
        platform: "MT5",
        url: "https://evil.example.net/",
        website: "https://evil.example.net",
        brokerName: "evil.example.net",
        domain: "evil.example.net",
      }),
    );
    expect(Object.keys(lastInput()).sort()).toEqual(["brokerName", "ownOrigin", "platform", "refresh", "server", "userId"]);
    expect(lastInput().brokerName).toBeNull();
    expect(JSON.stringify(lastInput())).not.toContain("evil.example.net");
  });

  test("a refresh is asked for only with a real true", async () => {
    await resolveTerminal(post("/x", { server: "ICMarketsSC-Demo", platform: "MT5", refresh: true }));
    await resolveTerminal(post("/x", { server: "ICMarketsSC-Demo", platform: "MT5", refresh: "true" }));
    await resolveTerminal(post("/x", { accountId: ACCOUNT_1, refresh: 1 }));
    const refreshes = vi.mocked(resolveBrokerWebTerminal).mock.calls.map((call) => call[0].refresh);
    expect(refreshes).toEqual([true, false, false]);
  });

  test("the answer of the search is passed through as it is, also when nothing was found", async () => {
    const none = {
      serverKey: "pepperstone",
      status: "NOT_FOUND",
      url: null,
      host: null,
      source: null,
      embeddable: true,
      brokerName: null,
      checkedAt: null,
    };
    vi.mocked(resolveBrokerWebTerminal).mockResolvedValue(none as never);
    const body = await readJson(await resolveTerminal(post("/x", { server: "Pepperstone-Demo", platform: "MT5" })));
    expect(body.data).toEqual(none);
  });

  test("unexpected failures are a generic 500", async () => {
    vi.mocked(resolveBrokerWebTerminal).mockRejectedValue(new Error("db exploded with secret details"));
    const response = await resolveTerminal(post("/x", { server: "ICMarketsSC-Demo", platform: "MT5" }));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("secret details");
  });
});

describe("GET /api/terminal/workspace", () => {
  test("needs a signed-in user", async () => {
    vi.mocked(requireAuth).mockRejectedValue(new AuthError("UNAUTHORIZED", "Not authenticated", 401));
    expect((await getWorkspace()).status).toBe(401);
  });

  test("a trader without stored settings gets the defaults", async () => {
    const response = await getWorkspace();
    const body = await readJson(response);
    expect(response.status).toBe(200);
    expect(body.data).toEqual({ workspace: defaultWorkspace(), persisted: false, storage: "ok" });
    expect(fakeDb.callsTo("terminal_user_preferences")[0].filters).toEqual([
      { op: "eq", column: "user_id", value: USER },
    ]);
  });

  test("stored settings come back cleaned", async () => {
    fakeDb.tables.terminal_user_preferences = [
      {
        user_id: USER,
        layout: {
          legacy: true,
          workspace: { view: "split", tradingview: { symbol: "<x>", watchlist: ["nasdaq:aapl", "bad one"] } },
        },
      },
    ];
    const body = await readJson(await getWorkspace());
    expect(body.data.persisted).toBe(true);
    expect(body.data.workspace.view).toBe("split");
    expect(body.data.workspace.tradingview.symbol).toBe(defaultWorkspace().tradingview.symbol);
    expect(body.data.workspace.tradingview.watchlist).toEqual(["NASDAQ:AAPL"]);
  });

  test("another user's row is never read", async () => {
    fakeDb.tables.terminal_user_preferences = [
      { user_id: OTHER_USER, layout: { workspace: { view: "metatrader" } } },
    ];
    const body = await readJson(await getWorkspace());
    // the default layout (the trade section: chart + WSA Trade since workspace version 3), never the other user's "metatrader"
    expect(body.data.workspace.view).toBe(defaultWorkspace().view);
    expect(body.data.workspace.view).not.toBe("metatrader");
    expect(body.data.persisted).toBe(false);
  });

  test("a deployment without the preferences table still answers with defaults", async () => {
    fakeDb.selectErrors.terminal_user_preferences = { code: "42P01", message: 'relation "x" does not exist' };
    const body = await readJson(await getWorkspace());
    expect(body.ok).toBe(true);
    expect(body.data.storage).toBe("unavailable");
    expect(body.data.workspace).toEqual(defaultWorkspace());
  });
});

describe("PATCH /api/terminal/workspace", () => {
  test("merges the patch into the stored settings under the caller's id", async () => {
    fakeDb.tables.terminal_user_preferences = [
      {
        user_id: USER,
        layout: { legacy: { keep: "me" }, workspace: { view: "split", tradingview: { watchlist: ["NASDAQ:AAPL"] } } },
      },
    ];

    const response = await patchWorkspace(post("/x", { workspace: { tradingview: { timeframe: "1H" } } }, "PATCH"));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data.workspace.view).toBe("split");
    expect(body.data.workspace.tradingview.watchlist).toEqual(["NASDAQ:AAPL"]);
    expect(body.data.workspace.tradingview.timeframe).toBe("1H");

    const [saved] = fakeDb.tables.terminal_user_preferences;
    expect(saved.user_id).toBe(USER);
    expect((saved.layout as Row).legacy).toEqual({ keep: "me" });
    expect(((saved.layout as Row).workspace as Row).view).toBe("split");
    const upsert = fakeDb.callsTo("terminal_user_preferences", "upsert")[0];
    expect(upsert.conflictColumn).toBe("user_id");
  });

  test("creates the row for a first-time user and ignores a user id sent in the body", async () => {
    await patchWorkspace(
      post("/x", { user_id: OTHER_USER, userId: OTHER_USER, workspace: { view: "metatrader" } }, "PATCH"),
    );
    expect(fakeDb.tables.terminal_user_preferences).toHaveLength(1);
    expect(fakeDb.tables.terminal_user_preferences[0].user_id).toBe(USER);
  });

  test("a password in an account added by hand is dropped", async () => {
    await patchWorkspace(
      post(
        "/x",
        {
          workspace: {
            metatrader: {
              manualAccounts: [
                { id: "abcdef12", label: "Live", platform: "MT5", login: "1234567", server: "Srv-1", password: PASSWORD },
              ],
            },
          },
        },
        "PATCH",
      ),
    );
    const stored = JSON.stringify(fakeDb.tables.terminal_user_preferences);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).toContain("abcdef12");
  });

  test("bad requests are refused before anything is stored", async () => {
    const tooBig = "x".repeat(MAX_WORKSPACE_BYTES + 1);
    expect((await patchWorkspace(post("/x", tooBig, "PATCH"))).status).toBe(413);
    expect((await patchWorkspace(post("/x", "{nope", "PATCH"))).status).toBe(400);
    expect((await patchWorkspace(post("/x", { nothing: 1 }, "PATCH"))).status).toBe(400);
    expect((await patchWorkspace(post("/x", { workspace: "text" }, "PATCH"))).status).toBe(400);
    expect(fakeDb.callsTo("terminal_user_preferences", "upsert")).toHaveLength(0);
  });

  test("needs a signed-in user", async () => {
    vi.mocked(requireAuth).mockRejectedValue(new AuthError("UNAUTHORIZED", "Not authenticated", 401));
    expect((await patchWorkspace(post("/x", { workspace: {} }, "PATCH"))).status).toBe(401);
  });

  test("a deployment without the table answers 503 with a stable code", async () => {
    fakeDb.upsertErrors.terminal_user_preferences = { code: "42P01", message: "relation does not exist" };
    const response = await patchWorkspace(post("/x", { workspace: { view: "split" } }, "PATCH"));
    expect(response.status).toBe(503);
    expect((await readJson(response)).error?.code).toBe("TERMINAL_STORAGE_UNAVAILABLE");

    fakeDb.upsertErrors = {};
    fakeDb.selectErrors.terminal_user_preferences = { code: "PGRST205", message: "could not find the table" };
    const second = await patchWorkspace(post("/x", { workspace: { view: "split" } }, "PATCH"));
    expect(second.status).toBe(503);
  });
});

describe("PATCH /api/terminal/preferences keeps the workspace safe", () => {
  test("merges the layout and refuses to write the workspace key", async () => {
    const stored = { view: "split" };
    fakeDb.tables.terminal_user_preferences = [{ user_id: USER, layout: { a: 1, workspace: stored } }];

    const response = await patchPreferences(
      post("/x", { layout: { b: 2, workspace: { view: "metatrader", metatrader: { selection: "evil" } } } }, "PATCH"),
    );

    expect(response.status).toBe(200);
    const [row] = fakeDb.tables.terminal_user_preferences;
    expect(row.layout).toEqual({ a: 1, b: 2, workspace: stored });
  });

  test("without a layout the stored layout is not touched", async () => {
    const layout = { workspace: { view: "split" } };
    fakeDb.tables.terminal_user_preferences = [{ user_id: USER, layout }];

    await patchPreferences(post("/x", { symbol: "eurusd" }, "PATCH"));

    const [row] = fakeDb.tables.terminal_user_preferences;
    expect(row.layout).toEqual(layout);
    expect(row.symbol).toBe("EURUSD");
  });
});
