import { describe, expect, test } from "vitest";
import {
  describeProviderFailure,
  describeTradeCode,
  evaluateExecutionResponse,
  friendlyProviderFailure,
  friendlyTradeMessage,
  isSuccessCode,
  readExecutionResponse,
} from "@/lib/broker/tradeRetcodes";

describe("trade server codes", () => {
  test("MetaTrader 5 return codes and MetaTrader 4 error numbers have a sentence", () => {
    expect(describeTradeCode(10019)).toMatchObject({ success: false, retry: false });
    expect(describeTradeCode(10019)?.text).toMatch(/free margin/i);
    expect(describeTradeCode(10016)?.text).toMatch(/stop loss/i);
    expect(describeTradeCode(10018)?.text).toMatch(/market is closed/i);
    expect(describeTradeCode(134)?.text).toMatch(/free margin/i);
    expect(describeTradeCode(130)?.text).toMatch(/stop loss/i);
    expect(describeTradeCode(4106)?.text).toMatch(/symbol/i);
  });

  test("done, placed and partly done are successes; so is the single-order API's 0", () => {
    for (const code of [0, 10008, 10009, 10010]) {
      expect(isSuccessCode(code)).toBe(true);
      expect(describeTradeCode(code)?.success).toBe(true);
    }
    expect(isSuccessCode(10019)).toBe(false);
  });

  test("only codes that prove nothing was executed may be repeated", () => {
    for (const code of [10004, 10020, 10021, 10024, 10028, 135, 136, 137, 138, 141, 146]) {
      expect(describeTradeCode(code)?.retry).toBe(true);
    }
    for (const code of [10019, 10016, 10018, 10012, 10031, 128]) {
      expect(describeTradeCode(code)?.retry).toBe(false);
    }
  });

  test("a code nobody knows is null", () => {
    expect(describeTradeCode(99999)).toBeNull();
    expect(describeTradeCode(Number.NaN)).toBeNull();
  });
});

describe("what an order answer says", () => {
  test("a ticket alone is success, with the position id the broker will want later", () => {
    expect(evaluateExecutionResponse({ ticket: 123 })).toMatchObject({ ok: true, orderId: "123", positionId: "123" });
    expect(evaluateExecutionResponse({ ticket: 5, positionId: 77 })).toMatchObject({ ok: true, orderId: "5", positionId: "77" });
  });

  test("a return code decides when there is one", () => {
    expect(evaluateExecutionResponse({ retcode: 10009, order: 55, price: 1.1, volume: 0.1 })).toMatchObject({
      ok: true,
      orderId: "55",
      price: 1.1,
      volume: 0.1,
      retcode: 10009,
    });
    expect(evaluateExecutionResponse({ retcode: "10009", order: 55 }).ok).toBe(true);
    const partial = evaluateExecutionResponse({ retcode: 10010, order: 56 });
    expect(partial).toMatchObject({ ok: true });
    expect(partial.ok && partial.note).toMatch(/part/i);
  });

  test("a refusal says why, in words - the broker's comment is not thrown away", () => {
    const noMoney = evaluateExecutionResponse({ retcode: 10019, comment: "No money", ticket: 0 });
    expect(noMoney).toMatchObject({ ok: false, retcode: 10019, retry: false });
    expect(!noMoney.ok && noMoney.message).toMatch(/free margin/i);

    const stops = evaluateExecutionResponse({ error: "Invalid stops" });
    expect(!stops.ok && stops.message).toMatch(/stop loss \/ take profit/i);

    const closed = evaluateExecutionResponse({ ticket: 0, message: "Market closed" });
    expect(!closed.ok && closed.message).toMatch(/market is closed/i);
  });

  test("a requote may be repeated, a refusal for lack of money may not", () => {
    expect(evaluateExecutionResponse({ retcode: 10004 })).toMatchObject({ ok: false, retry: true });
    expect(evaluateExecutionResponse({ retcode: 10019 })).toMatchObject({ ok: false, retry: false });
  });

  test("'nothing to change' is not a failure (a modify to the same levels)", () => {
    const result = evaluateExecutionResponse({ retcode: 10025 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.note).toMatch(/nothing was changed/i);
  });

  test("an HTTP-like `code` is not a trade-server code", () => {
    expect(evaluateExecutionResponse({ code: 200, message: "OK", ticket: 5 }).ok).toBe(true);
    const other = evaluateExecutionResponse({ code: 200, message: "something went wrong" });
    expect(other).toMatchObject({ ok: false, retcode: null });
    expect(!other.ok && other.message).toBe("something went wrong");
  });

  test("a code the table does not know still refuses, with the server's own words when it sent some", () => {
    const own = evaluateExecutionResponse({ retcode: 123456, comment: "Weird refusal" });
    expect(!own.ok && own.message).toBe("Weird refusal");
    const bare = evaluateExecutionResponse({ retcode: 123456 });
    expect(!bare.ok && bare.message).toMatch(/code 123456/);
  });

  test("flags and words that mean done", () => {
    expect(evaluateExecutionResponse({ success: true }).ok).toBe(true);
    expect(evaluateExecutionResponse({ done: true }).ok).toBe(true);
    expect(evaluateExecutionResponse({ message: "Order placed" }).ok).toBe(true);
    expect(evaluateExecutionResponse({ success: false, message: "Trade is disabled" }).ok).toBe(false);
  });

  test("an empty answer is a refusal with a plain sentence", () => {
    const empty = evaluateExecutionResponse({});
    expect(empty).toMatchObject({ ok: false });
    expect(!empty.ok && empty.message).toBe("The broker rejected the operation.");
  });

  test("a ticket of 0 is no ticket", () => {
    expect(evaluateExecutionResponse({ ticket: 0, order: 0, positionId: "0" }).ok).toBe(false);
  });
});

describe("answers that are not objects", () => {
  test("a bare ticket, true, OK, a JSON text and a message", () => {
    expect(readExecutionResponse(12345)).toEqual({ ticket: 12345 });
    expect(readExecutionResponse("12345")).toEqual({ ticket: "12345" });
    expect(readExecutionResponse(true)).toEqual({ success: true });
    expect(readExecutionResponse(false)).toEqual({ success: false });
    expect(readExecutionResponse("OK")).toEqual({ success: true });
    expect(readExecutionResponse('{"retcode":10009,"order":7}')).toEqual({ retcode: 10009, order: 7 });
    expect(readExecutionResponse("Not enough money")).toEqual({ message: "Not enough money" });
    expect(readExecutionResponse(0)).toEqual({});
    expect(readExecutionResponse(null)).toEqual({});
    expect(readExecutionResponse(undefined)).toEqual({});
  });

  test("each of them reads as the right outcome", () => {
    expect(evaluateExecutionResponse(readExecutionResponse(12345)).ok).toBe(true);
    expect(evaluateExecutionResponse(readExecutionResponse(true)).ok).toBe(true);
    expect(evaluateExecutionResponse(readExecutionResponse("OK")).ok).toBe(true);
    expect(evaluateExecutionResponse(readExecutionResponse(false)).ok).toBe(false);
    expect(evaluateExecutionResponse(readExecutionResponse("Not enough money")).ok).toBe(false);
  });
});

describe("provider texts in words", () => {
  test("known phrases become sentences; credentials never leak", () => {
    expect(friendlyTradeMessage("ERR_INVALID_STOPS")).toMatch(/stop loss/i);
    expect(friendlyTradeMessage("Off quotes")).toMatch(/no quotes/i);
    expect(friendlyTradeMessage("Symbol not found")).toMatch(/does not know this symbol/i);
    expect(friendlyTradeMessage("Order not found")).toMatch(/does not exist/i);
    expect(friendlyTradeMessage("Account is read only")).toMatch(/investor/i);
    expect(friendlyTradeMessage("Trade is not allowed")).toMatch(/investor/i);
    expect(friendlyTradeMessage("")).toBe("");
  });

  test("unknown wording is kept (sanitised); a login problem keeps its own advice", () => {
    expect(friendlyTradeMessage("Something odd happened")).toBe("Something odd happened");
    expect(friendlyTradeMessage("Unauthorized")).toMatch(/^Connection failed/);
    expect(friendlyTradeMessage("bad password=hunter2 for user=1234567")).not.toMatch(/hunter2|1234567/);
  });

  test("the investor sentence keeps its word 'password' (it is advice, not a secret)", () => {
    expect(friendlyTradeMessage("investor mode")).toContain("main trading password");
  });
});

describe("failed provider calls", () => {
  test("a JSON body with a return code", () => {
    const failure = describeProviderFailure(new Error('Broker service request failed (400): {"retcode":10016,"comment":"Invalid stops"}'));
    expect(failure.message).toMatch(/stop loss/i);
    expect(failure.retry).toBe(false);

    expect(describeProviderFailure(new Error('Broker service request failed (400): {"retcode":10004}')).retry).toBe(true);
  });

  test("an error record put into the text", () => {
    expect(friendlyProviderFailure(new Error("OrderSendSafe failed: ERR_INVALID_STOPS: Invalid stops"))).toMatch(/stop loss/i);
  });

  test("an MT4 error number inside a text", () => {
    expect(friendlyProviderFailure(new Error("Broker service request failed (500): error 134"))).toMatch(/free margin/i);
    expect(describeProviderFailure(new Error("Broker service request failed (500): Error 138")).retry).toBe(true);
  });

  test("an HTML error page is not shown to the person", () => {
    expect(friendlyProviderFailure(new Error("Broker service request failed (502): <html><body>Bad gateway</body></html>"))).toBe(
      "The broker service is temporarily unavailable.",
    );
  });

  test("a time-out says to check before sending again", () => {
    expect(friendlyProviderFailure(new Error("Broker service did not answer OrderSendSafe within 20s."))).toMatch(/check the open positions/i);
  });

  test("anything else is kept as it is", () => {
    expect(friendlyProviderFailure(new Error("Broker service request failed (400): lot size too small for this account"))).toBe(
      "lot size too small for this account",
    );
  });
});
