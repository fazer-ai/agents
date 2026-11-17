import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import logger from "@/api/lib/logger";
import {
  TICK_OUTAGE_PAGE_MS,
  tickFailureLevel,
  tickFailures,
} from "@/lib/tick-failure";

// A failed tick logs at warn while the database is only briefly unavailable, and at error once the
// outage lasts or when the error is anything else.

function neverStarted(): Error {
  return Object.assign(
    new Error(
      "Transaction API error: Unable to start a transaction in the given time.",
    ),
    { code: "P2028" },
  );
}

function expired(): Error {
  return Object.assign(
    new Error(
      "Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5131 ms passed since the start of the transaction.",
    ),
    { code: "P2028" },
  );
}

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const warn = spyOn(logger, "warn");
const error = spyOn(logger, "error");

// The logger is shared by every file the process runs after this one.
afterAll(() => {
  warn.mockRestore();
  error.mockRestore();
});

afterEach(() => {
  warn.mockClear();
  error.mockClear();
});

const lines = (spy: typeof warn) =>
  spy.mock.calls.map((c) => ({ fields: c[0], msg: c[1] }));

describe("tickFailureLevel", () => {
  test.each([
    [true, 0, "warn"],
    [true, TICK_OUTAGE_PAGE_MS - 1, "warn"],
    [true, TICK_OUTAGE_PAGE_MS, "error"],
    [false, 0, "error"],
  ] as const)("unavailable=%p outage=%pms logs at %s", (u, ms, level) => {
    expect(tickFailureLevel(u, ms)).toBe(level);
  });
});

describe("tickFailures", () => {
  test("one tick the database refused, then a good one: a warn that names the loop, no error", () => {
    const c = clock();
    const f = tickFailures({ now: c.now });
    f.failed(neverStarted(), {}, "observe tick failed");
    c.advance(2_500);
    f.succeeded();
    expect(error).not.toHaveBeenCalled();
    const [w] = lines(warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(w?.msg).toContain("observe tick failed");
    expect(w?.msg).toContain("transient");
    expect(w?.fields).toMatchObject({ transient: true, outageMs: 0 });
  });

  test("an outage that lasts pages: warn until it is a minute old, error from then on", () => {
    const c = clock();
    const f = tickFailures({ now: c.now });
    for (let i = 0; i < 24; i++) {
      f.failed(neverStarted(), {}, "debounce tick failed");
      c.advance(2_500);
    }
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(24);
    f.failed(neverStarted(), {}, "debounce tick failed");
    f.failed(neverStarted(), {}, "debounce tick failed");
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[1]).toBe("debounce tick failed");
  });

  test("a good tick ends the outage: a refusal after it starts a new one", () => {
    const c = clock();
    const f = tickFailures({ now: c.now });
    f.failed(neverStarted(), {}, "scheduler tick failed");
    f.succeeded();
    c.advance(TICK_OUTAGE_PAGE_MS * 2);
    f.failed(neverStarted(), {}, "scheduler tick failed");
    expect(error).not.toHaveBeenCalled();
    expect(lines(warn)[1]?.fields).toMatchObject({ outageMs: 0 });
  });

  test.each([
    ["an expired transaction, whose statements ran", expired()],
    ["a bug", new TypeError("x is undefined")],
    [
      "a unique violation",
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    ],
    [
      "a connection refused by an HTTP client",
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    ],
  ])("%s logs at error the first time", (_, err) => {
    const f = tickFailures({ now: clock().now });
    f.failed(err, { err }, "Alert tick failed: %s", "masked");
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual([
      { err },
      "Alert tick failed: %s",
      "masked",
    ]);
  });

  test("each loop keeps its own outage: one that recovered does not hide one that keeps failing", () => {
    const c = clock();
    const a = tickFailures({ now: c.now });
    const b = tickFailures({ now: c.now });
    a.failed(neverStarted(), {}, "observe tick failed");
    b.failed(neverStarted(), {}, "traffic tick failed");
    c.advance(TICK_OUTAGE_PAGE_MS);
    a.succeeded();
    b.failed(neverStarted(), {}, "traffic tick failed");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toBe("traffic tick failed");
  });
});
