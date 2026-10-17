import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { encryptSecret } from "@/lib/crypto/brokerCrypto";
import {
  MetaTraderTerminalError,
  listMetaTraderTerminalAccounts,
  resolveMetaTraderLaunch,
} from "@/lib/services/metaTraderTerminalService";
import { fakeDb, type Row } from "./helpers/fakeSupabase";

vi.mock("@/lib/supabase/admin", async () => {
  const { fakeDb: db } = await import("./helpers/fakeSupabase");
  return { createAdminClient: () => ({ from: db.from }) };
});

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ACCOUNT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ACCOUNT_3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const FOREIGN_ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const PASSWORD = "Sup3r-Secret-pw!";
const LOGIN = "88776655";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

function account(id: string, userId: string, overrides: Row = {}): Row {
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

function credential(accountId: string, payload: Record<string, unknown>): Row {
  return { trading_account_id: accountId, encrypted_reference: encryptSecret(JSON.stringify(payload)) };
}

const FULL_PAYLOAD = { login: LOGIN, password: PASSWORD, server: "ICMarketsSC-Demo02", platform: "mt5" };

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "unit-test-encryption-key";
  fakeDb.reset();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("listMetaTraderTerminalAccounts", () => {
  test("lists only the caller's accounts and says so in the query", async () => {
    fakeDb.tables.trading_accounts = [
      account(ACCOUNT_1, USER),
      account(FOREIGN_ACCOUNT, OTHER_USER, { account_name: "Not yours" }),
    ];
    fakeDb.tables.broker_credentials = [credential(ACCOUNT_1, FULL_PAYLOAD), credential(FOREIGN_ACCOUNT, FULL_PAYLOAD)];

    const accounts = await listMetaTraderTerminalAccounts(USER);

    expect(accounts.map((entry) => entry.accountId)).toEqual([ACCOUNT_1]);
    const accountQuery = fakeDb.callsTo("trading_accounts")[0];
    expect(accountQuery.filters).toContainEqual({ op: "eq", column: "user_id", value: USER });
    expect(accountQuery.limit).toBe(100);
    // the credentials are only asked for the caller's own account ids
    const credentialQuery = fakeDb.callsTo("broker_credentials")[0];
    expect(credentialQuery.filters).toEqual([{ op: "in", column: "trading_account_id", value: [ACCOUNT_1] }]);
  });

  test("returns a masked login, platform and server - never the password or the full login", async () => {
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER)];
    fakeDb.tables.broker_credentials = [credential(ACCOUNT_1, FULL_PAYLOAD)];

    const [entry] = await listMetaTraderTerminalAccounts(USER);

    expect(entry).toEqual({
      accountId: ACCOUNT_1,
      accountName: "Main account",
      brokerName: "IC Markets",
      platform: "MT5",
      server: "ICMarketsSC-Demo02",
      loginMasked: "••••6655",
      currency: "USD",
      status: "CONNECTED",
      canLaunch: true,
      unavailableReason: null,
    });
    const json = JSON.stringify(entry);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain(LOGIN);
    expect(json.toLowerCase()).not.toContain("password");
  });

  test("explains why an account can not be opened", async () => {
    fakeDb.tables.trading_accounts = [
      account(ACCOUNT_1, USER, { account_name: "No login saved" }),
      account(ACCOUNT_2, USER, { account_name: "Broken login" }),
      account(ACCOUNT_3, USER, { account_name: "Half login", broker_platform: null }),
    ];
    fakeDb.tables.broker_credentials = [
      { trading_account_id: ACCOUNT_2, encrypted_reference: "not:a:valid-payload" },
      credential(ACCOUNT_3, { password: PASSWORD, server: "Srv-1" }),
    ];

    const byId = Object.fromEntries(
      (await listMetaTraderTerminalAccounts(USER)).map((entry) => [entry.accountId, entry]),
    );

    expect(byId[ACCOUNT_1]).toMatchObject({ canLaunch: false, unavailableReason: "NO_CREDENTIALS", loginMasked: null });
    expect(byId[ACCOUNT_2]).toMatchObject({ canLaunch: false, unavailableReason: "UNREADABLE", loginMasked: null });
    expect(byId[ACCOUNT_3]).toMatchObject({ canLaunch: false, unavailableReason: "INCOMPLETE" });
    expect(JSON.stringify(byId)).not.toContain(PASSWORD);
  });

  test("reports missing encryption configuration separately", async () => {
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER)];
    fakeDb.tables.broker_credentials = [credential(ACCOUNT_1, FULL_PAYLOAD)];
    delete process.env.ENCRYPTION_KEY;

    const [entry] = await listMetaTraderTerminalAccounts(USER);

    expect(entry).toMatchObject({ canLaunch: false, unavailableReason: "ENCRYPTION_UNAVAILABLE" });
  });

  test("falls back to the account row when the stored payload has no platform or a bad server", async () => {
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER, { broker_platform: "mt4", broker_server: "Row-Server" })];
    fakeDb.tables.broker_credentials = [credential(ACCOUNT_1, { login: LOGIN, password: PASSWORD, server: "bad;server" })];

    const [entry] = await listMetaTraderTerminalAccounts(USER);

    expect(entry).toMatchObject({ platform: "MT4", server: "Row-Server", canLaunch: true });
  });

  test("live accounts come first, newest first inside a group, unknown status counts as pending", async () => {
    fakeDb.tables.trading_accounts = [
      account(ACCOUNT_1, USER, { account_name: "disconnected", status: "DISCONNECTED" }),
      account(ACCOUNT_2, USER, { account_name: "connected newest", status: "CONNECTED" }),
      account(ACCOUNT_3, USER, { account_name: "weird", status: "SOMETHING_ELSE" }),
      account(FOREIGN_ACCOUNT.replace("bbbb", "cccc"), USER, { account_name: "connected older", status: "CONNECTED" }),
    ];
    fakeDb.tables.broker_credentials = [];

    const result = await listMetaTraderTerminalAccounts(USER);

    expect(result.map((entry) => entry.accountName)).toEqual([
      "connected newest",
      "connected older",
      "weird",
      "disconnected",
    ]);
    expect(result.find((entry) => entry.accountName === "weird")?.status).toBe("PENDING");
  });

  test("a user without accounts costs one query", async () => {
    fakeDb.tables.trading_accounts = [account(FOREIGN_ACCOUNT, OTHER_USER)];
    expect(await listMetaTraderTerminalAccounts(USER)).toEqual([]);
    expect(fakeDb.callsTo("broker_credentials")).toHaveLength(0);
  });

  test("database errors surface without credential data", async () => {
    fakeDb.selectErrors.trading_accounts = { message: "connection reset" };
    await expect(listMetaTraderTerminalAccounts(USER)).rejects.toThrow("Failed to list terminal accounts: connection reset");
  });
});

describe("resolveMetaTraderLaunch", () => {
  test("returns login, server and platform of the caller's account - not the password", async () => {
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER)];
    fakeDb.tables.broker_credentials = [credential(ACCOUNT_1, FULL_PAYLOAD)];

    const target = await resolveMetaTraderLaunch(USER, ACCOUNT_1);

    expect(target).toEqual({
      accountId: ACCOUNT_1,
      accountName: "Main account",
      brokerName: "IC Markets",
      platform: "MT5",
      server: "ICMarketsSC-Demo02",
      login: LOGIN,
    });
    expect(JSON.stringify(target)).not.toContain(PASSWORD);
    const accountQuery = fakeDb.callsTo("trading_accounts")[0];
    expect(accountQuery.filters).toEqual([
      { op: "eq", column: "id", value: ACCOUNT_1 },
      { op: "eq", column: "user_id", value: USER },
    ]);
  });

  test("somebody else's account is indistinguishable from a missing one", async () => {
    fakeDb.tables.trading_accounts = [account(FOREIGN_ACCOUNT, OTHER_USER)];
    fakeDb.tables.broker_credentials = [credential(FOREIGN_ACCOUNT, FULL_PAYLOAD)];

    await expect(resolveMetaTraderLaunch(USER, FOREIGN_ACCOUNT)).rejects.toMatchObject({
      name: "MetaTraderTerminalError",
      code: "ACCOUNT_NOT_FOUND",
      statusCode: 404,
    });
    // the credentials were never even read
    expect(fakeDb.callsTo("broker_credentials")).toHaveLength(0);
  });

  test("no stored login -> 409", async () => {
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER)];
    await expect(resolveMetaTraderLaunch(USER, ACCOUNT_1)).rejects.toMatchObject({
      code: "CREDENTIALS_MISSING",
      statusCode: 409,
    });
  });

  test("an unreadable payload -> 500 without leaking the ciphertext", async () => {
    const ciphertext = "c2VjcmV0:dGFn:Y2lwaGVy";
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER)];
    fakeDb.tables.broker_credentials = [{ trading_account_id: ACCOUNT_1, encrypted_reference: ciphertext }];

    const error = await resolveMetaTraderLaunch(USER, ACCOUNT_1).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MetaTraderTerminalError);
    expect(error).toMatchObject({ code: "CREDENTIALS_UNREADABLE", statusCode: 500 });
    expect((error as Error).message).not.toContain("c2VjcmV0");
  });

  test("missing encryption key -> 503", async () => {
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER)];
    fakeDb.tables.broker_credentials = [credential(ACCOUNT_1, FULL_PAYLOAD)];
    delete process.env.ENCRYPTION_KEY;

    await expect(resolveMetaTraderLaunch(USER, ACCOUNT_1)).rejects.toMatchObject({
      code: "ENCRYPTION_UNAVAILABLE",
      statusCode: 503,
    });
  });

  test("a payload without a login -> 422", async () => {
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER)];
    fakeDb.tables.broker_credentials = [credential(ACCOUNT_1, { password: PASSWORD, server: "Srv-1", platform: "MT5" })];

    await expect(resolveMetaTraderLaunch(USER, ACCOUNT_1)).rejects.toMatchObject({
      code: "CREDENTIALS_INCOMPLETE",
      statusCode: 422,
    });
  });

  test("the platform falls back to the account row, an unusable server becomes null", async () => {
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER, { broker_platform: "MT4", broker_server: "bad;server" })];
    fakeDb.tables.broker_credentials = [credential(ACCOUNT_1, { login: LOGIN, password: PASSWORD, server: "also bad;" })];

    const target = await resolveMetaTraderLaunch(USER, ACCOUNT_1);

    expect(target).toMatchObject({ platform: "MT4", server: null, login: LOGIN });
  });

  test("database errors are plain errors with the database message only", async () => {
    fakeDb.tables.trading_accounts = [account(ACCOUNT_1, USER)];
    fakeDb.selectErrors.broker_credentials = { message: "timeout" };
    await expect(resolveMetaTraderLaunch(USER, ACCOUNT_1)).rejects.toThrow("Failed to read the account login: timeout");
  });
});
