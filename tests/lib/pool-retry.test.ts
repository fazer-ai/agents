import { describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  isDatabaseUnavailable,
  isTransactionNeverStarted,
  retryWhileTransactionNeverStarted,
} from "@/lib/pool-retry";

// Only a transaction that never started is retried, because only there did nothing run. The error
// is taken from a real pool of one connection, not written by hand: the classifier matches Prisma's
// code and words, and a Prisma upgrade that changes either must turn this red, not turn every
// saturated pool back into an unretried failure.

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
if (appUrl) {
  const probe = new PrismaClient({
    adapter: new PrismaPg({ connectionString: appUrl }),
  });
  try {
    await probe.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  } finally {
    await probe.$disconnect().catch(() => {});
  }
}

function neverStarted(): Error {
  return Object.assign(
    new Error(
      "Transaction API error: Unable to start a transaction in the given time.",
    ),
    { code: "P2028" },
  );
}

async function realPoolRefusal(url: string): Promise<unknown> {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: 1 }),
  });
  let release: () => void = () => {};
  let ready: () => void = () => {};
  const holding = new Promise<void>((r) => {
    ready = r;
  });
  const held = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      const freed = new Promise<void>((r) => {
        release = r;
      });
      // Signalled only once the connection is taken and `release` can end it.
      ready();
      await freed;
    },
    { timeout: 20_000 },
  );
  await holding;
  try {
    await db.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, {
      maxWait: 300,
      timeout: 2_000,
    });
    return null;
  } catch (err) {
    return err;
  } finally {
    release();
    await held;
    await db.$disconnect();
  }
}

describe("isDatabaseUnavailable", () => {
  const prismaError = (code: string, message = "boom") =>
    Object.assign(new Error(message), { code });

  test("the connection codes and a transaction that never started are the database's", () => {
    for (const code of ["P1001", "P1002", "P1017", "P2024"]) {
      expect(isDatabaseUnavailable(prismaError(code))).toBe(true);
    }
    expect(
      isDatabaseUnavailable(
        prismaError(
          "P2028",
          "Transaction API error: Unable to start a transaction in the given time.",
        ),
      ),
    ).toBe(true);
  });

  test("wrapped by another layer, it is still the database's", () => {
    const wrapped = new Error("recovery failed", {
      cause: prismaError("P1017"),
    });
    expect(isDatabaseUnavailable(wrapped)).toBe(true);
  });

  test("a query that failed on its own merits, or an HTTP error, is not", () => {
    expect(isDatabaseUnavailable(prismaError("P2002"))).toBe(false);
    expect(
      isDatabaseUnavailable(
        prismaError("P2028", "Transaction already closed: expired"),
      ),
    ).toBe(false);
    expect(isDatabaseUnavailable(new Error("Chatwoot API 401"))).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
  });
});

describe("isTransactionNeverStarted", () => {
  test.skipIf(!dbUp)(
    "a transaction a full pool never started is recognised",
    async () => {
      const err = await realPoolRefusal(appUrl as string);
      expect(err).not.toBeNull();
      expect(isTransactionNeverStarted(err)).toBe(true);
    },
  );

  test("a transaction that started and then expired is not", () => {
    const expired = Object.assign(
      new Error(
        "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.",
      ),
      { code: "P2028" },
    );
    expect(isTransactionNeverStarted(expired)).toBe(false);
  });

  test("other database errors and non-errors are not", () => {
    expect(
      isTransactionNeverStarted(
        Object.assign(new Error("Unique constraint"), { code: "P2002" }),
      ),
    ).toBe(false);
    expect(isTransactionNeverStarted(new Error("boom"))).toBe(false);
    expect(isTransactionNeverStarted(null)).toBe(false);
    expect(isTransactionNeverStarted("P2028")).toBe(false);
  });

  test("a refusal wrapped by a layer that names itself is still one", () => {
    expect(
      isTransactionNeverStarted(
        new Error("the turn failed", { cause: neverStarted() }),
      ),
    ).toBe(true);
  });

  test("the engine pool's own timeout is the same moment", () => {
    expect(
      isTransactionNeverStarted(
        Object.assign(new Error("Timed out fetching a new connection"), {
          code: "P2024",
        }),
      ),
    ).toBe(true);
  });
});

describe("retryWhileTransactionNeverStarted", () => {
  const waits: number[] = [];
  const opts = {
    label: "test",
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    random: () => 1,
  };

  test("runs again after a pool refusal and returns what the next run returns", async () => {
    waits.length = 0;
    let calls = 0;
    const out = await retryWhileTransactionNeverStarted(async () => {
      calls++;
      if (calls < 3) throw neverStarted();
      return "ok";
    }, opts);
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    // Doubling ceilings, taken at their top by `random: () => 1`.
    expect(waits).toEqual([250, 500]);
  });

  test("any other error is thrown on the first run", async () => {
    let calls = 0;
    const boom = new Error("boom");
    await expect(
      retryWhileTransactionNeverStarted(async () => {
        calls++;
        throw boom;
      }, opts),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
  });

  test("the attempts bound the runs, and the last refusal is what the caller sees", async () => {
    let calls = 0;
    const last = neverStarted();
    await expect(
      retryWhileTransactionNeverStarted(
        async () => {
          calls++;
          throw calls === 4 ? last : neverStarted();
        },
        { ...opts, attempts: 4 },
      ),
    ).rejects.toBe(last);
    expect(calls).toBe(4);
  });

  test("a backoff that wakes late, past the deadline, starts no new attempt", async () => {
    let clock = 0;
    let calls = 0;
    await expect(
      retryWhileTransactionNeverStarted(
        async () => {
          calls++;
          clock += 2_000;
          throw neverStarted();
        },
        {
          ...opts,
          attempts: 10,
          deadlineMs: 10_000,
          now: () => clock,
          // The timer fires eleven seconds late, as on an overloaded event loop.
          sleep: async () => {
            clock += 11_000;
          },
        },
      ),
    ).rejects.toThrow("Unable to start a transaction");
    expect(calls).toBe(1);
  });

  test("no retry starts past the deadline", async () => {
    waits.length = 0;
    let clock = 0;
    let calls = 0;
    await expect(
      retryWhileTransactionNeverStarted(
        async () => {
          calls++;
          // Each run waits out `maxWait` before the refusal, as a real one does.
          clock += 2_000;
          throw neverStarted();
        },
        { ...opts, attempts: 10, deadlineMs: 5_000, now: () => clock },
      ),
    ).rejects.toThrow("Unable to start a transaction");
    // Refusals at 2s and 4s retry (250ms and 500ms of backoff fit); at 6s the next wait would pass 5s,
    // so it gives up without sleeping it.
    expect(calls).toBe(3);
    expect(waits).toEqual([250, 500]);
  });
});
