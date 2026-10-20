import { describe, expect, test } from "vitest";
import { formatDuration, timingHeadline, timingText } from "@/lib/trade/webTradeFormat";

describe("durations", () => {
  test("under a second in milliseconds, then in seconds with two decimals, from ten seconds with one", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(183)).toBe("183 ms");
    expect(formatDuration(183.4)).toBe("183 ms");
    expect(formatDuration(1000)).toBe("1.00 s");
    expect(formatDuration(1250)).toBe("1.25 s");
    expect(formatDuration(10_000)).toBe("10.0 s");
    expect(formatDuration(12_345)).toBe("12.3 s");
  });

  test("anything that is not a time is a dash", () => {
    expect(formatDuration(-1)).toBe("-");
    expect(formatDuration(Number.NaN)).toBe("-");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("the time report of an order", () => {
  test("nothing reported, nothing shown", () => {
    expect(timingText(null)).toBe("");
    expect(timingText(undefined)).toBe("");
    expect(timingText({})).toBe("");
    expect(timingText({ queueMs: 120 })).toBe("");
    expect(timingText({ runMs: 63 })).toBe("");
    // a time that cannot be right is not shown
    expect(timingText({ queueMs: -1, runMs: 5 })).toBe("");
    expect(timingText({ queueMs: Number.NaN, runMs: 5 })).toBe("");
  });

  test("what the trading system reports on its own: the wait for it and its work", () => {
    expect(timingText({ queueMs: 120, runMs: 63 })).toBe("183 ms (queue 120 ms · broker 63 ms)");
  });

  test("the broker's part says what it was spent on, and leaves out the steps that cost nothing", () => {
    expect(timingText({ queueMs: 120, runMs: 330, readMs: 40, sessionMs: 12, sendMs: 310 })).toBe(
      "450 ms (queue 120 ms · broker 330 ms (read 40 ms · session 12 ms · send 310 ms))",
    );
    // a warm session (0 ms) and no read in front of a close are not mentioned
    expect(timingText({ queueMs: 5, runMs: 60, readMs: 0, sessionMs: 0, sendMs: 55 })).toBe("65 ms (queue 5 ms · broker 60 ms (send 55 ms))");
  });

  test("an order that had to be sent more than once says so", () => {
    expect(timingText({ queueMs: 5, runMs: 600, sendMs: 590, attempts: 3 })).toBe(
      "605 ms (queue 5 ms · broker 600 ms (send 590 ms · 3 attempts))",
    );
    expect(timingText({ queueMs: 5, runMs: 300, sendMs: 290, attempts: 1 })).toBe("305 ms (queue 5 ms · broker 300 ms (send 290 ms))");
  });

  test("the whole picture, when the browser and the web server measured their parts too", () => {
    // 640 ms in the browser = 120 network + 90 web server + 60 queue + 330 broker + 40 relay
    expect(timingText({ queueMs: 60, runMs: 330, sendMs: 310, serverMs: 520, waitMs: 430, totalMs: 640 })).toBe(
      "640 ms in total: network 120 ms · server 90 ms · queue 60 ms · broker 330 ms (send 310 ms) · relay 40 ms",
    );
  });

  test("a part that cannot be negative never is", () => {
    // the browser's clock and the server's clock do not agree to the millisecond
    expect(timingText({ queueMs: 60, runMs: 330, serverMs: 520, waitMs: 430, totalMs: 100 })).toBe(
      "100 ms in total: network 0 ms · server 90 ms · queue 60 ms · broker 330 ms · relay 40 ms",
    );
    expect(timingText({ queueMs: 60, runMs: 330, serverMs: 300, waitMs: 430, totalMs: 640 })).toBe(
      "640 ms in total: network 340 ms · server 0 ms · queue 60 ms · broker 330 ms · relay 40 ms",
    );
    expect(timingText({ queueMs: 300, runMs: 330, serverMs: 520, waitMs: 430, totalMs: 640 })).toBe(
      "640 ms in total: network 120 ms · server 90 ms · queue 300 ms · broker 330 ms · relay 0 ms",
    );
  });

  describe("what the web server and the AWS worker add (sign-in, checks, database trips, wake-up)", () => {
    const whole = { queueMs: 60, runMs: 330, serverMs: 520, waitMs: 430, totalMs: 640 };
    const plain = "640 ms in total: network 120 ms · server 90 ms";
    const tail = " · queue 60 ms · broker 330 ms · relay 40 ms";

    test("the server's own part says what it was spent on - and a held sign-in that cost nothing is still a measurement", () => {
      expect(timingText({ ...whole, signInMs: 40, checksMs: 12 })).toBe(`${plain} (sign-in 40 ms · checks 12 ms)${tail}`);
      expect(timingText({ ...whole, checksMs: 3 })).toBe(`${plain} (checks 3 ms)${tail}`);
      expect(timingText({ ...whole, signInMs: 0, checksMs: 0 })).toBe(`${plain} (sign-in 0 ms · checks 0 ms)${tail}`);
    });

    test("a report without any of it reads exactly as before", () => {
      expect(timingText(whole)).toBe(`${plain}${tail}`);
      expect(timingText({ ...whole, signInMs: -5, checksMs: Number.NaN })).toBe(`${plain}${tail}`);
    });

    test("the distance to the database is told for both sides - the floor under 'queue' and 'relay'", () => {
      expect(timingText({ ...whole, insertMs: 96, awsDbMs: 14 })).toBe(`${plain}${tail} Database round trip: web 96 ms · AWS 14 ms.`);
      expect(timingText({ ...whole, insertMs: 96 })).toBe(`${plain}${tail} Database round trip: web 96 ms.`);
      expect(timingText({ ...whole, awsDbMs: 14 })).toBe(`${plain}${tail} Database round trip: AWS 14 ms.`);
    });

    test("a busy AWS worker is named only when its loop really ran late", () => {
      expect(timingText({ ...whole, awsLoopMs: 3 })).toBe(`${plain}${tail}`);
      expect(timingText({ ...whole, awsLoopMs: 19 })).toBe(`${plain}${tail}`);
      expect(timingText({ ...whole, awsLoopMs: 20 })).toBe(`${plain}${tail} The AWS worker is busy: its loop ran 20 ms late.`);
      expect(timingText({ ...whole, awsLoopMs: 450 })).toBe(`${plain}${tail} The AWS worker is busy: its loop ran 450 ms late.`);
    });

    test("how the command and its answer found each other: live, or which side still asks again and again", () => {
      expect(timingText({ ...whole, wake: "live" })).toBe(`${plain}${tail} Wake-up: live.`);
      expect(timingText({ ...whole, wake: "web-poll" })).toBe(
        `${plain}${tail} Wake-up: the web server still asks the database again and again - apply migration 062.`,
      );
      expect(timingText({ ...whole, wake: "aws-poll" })).toBe(
        `${plain}${tail} Wake-up: the AWS worker still asks the database again and again - apply migration 062 and update the worker.`,
      );
    });

    test("everything together, in the order it is read", () => {
      expect(
        timingText({ ...whole, signInMs: 40, checksMs: 12, insertMs: 96, awsDbMs: 14, awsLoopMs: 80, wake: "live" }),
      ).toBe(
        `${plain} (sign-in 40 ms · checks 12 ms)${tail} Database round trip: web 96 ms · AWS 14 ms. The AWS worker is busy: its loop ran 80 ms late. Wake-up: live.`,
      );
    });

    test("the short form (no web server part) carries none of it", () => {
      expect(timingText({ queueMs: 60, runMs: 330, insertMs: 96, awsDbMs: 14, wake: "live", signInMs: 40 })).toBe(
        "390 ms (queue 60 ms · broker 330 ms)",
      );
    });
  });

  test("without the web server's part the short form is used, even when the browser measured the total", () => {
    expect(timingText({ queueMs: 60, runMs: 330, totalMs: 640 })).toBe("390 ms (queue 60 ms · broker 330 ms)");
  });

  test("slow parts are shown in seconds", () => {
    expect(timingText({ queueMs: 2500, runMs: 1250 })).toBe("3.75 s (queue 2.50 s · broker 1.25 s)");
  });
});

describe("the one number next to a result", () => {
  test("the whole wait when the browser measured it", () => {
    expect(timingHeadline({ queueMs: 60, runMs: 330, totalMs: 640 })).toBe("640 ms");
    expect(timingHeadline({ totalMs: 1250 })).toBe("1.25 s");
  });

  test("else the trading system's own time (waiting for it + its work)", () => {
    expect(timingHeadline({ queueMs: 120, runMs: 63 })).toBe("183 ms");
  });

  test("nothing when nothing was reported", () => {
    expect(timingHeadline(null)).toBe("");
    expect(timingHeadline(undefined)).toBe("");
    expect(timingHeadline({})).toBe("");
    expect(timingHeadline({ queueMs: 120 })).toBe("");
    expect(timingHeadline({ totalMs: -5 })).toBe("");
  });
});
