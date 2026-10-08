import { describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  isTransactionNeverStarted,
  retryWhileTransactionNeverStarted,
} from "@/lib/pool-retry";

// Only a transaction that never started is retried, because only there did nothing run. The error
// is taken from a real pool of one connection, not written by hand: the classifier matches Prisma's
// code and words, and a Prisma upgrade that changes either must turn this red, not turn every
// saturated pool back into an unretried failure.

const appUrl = process.env.TEST_APP_DATABASE_URL;

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
  const held = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      await new Promise<void>((r) => {
        release = r;
      });
    },
    { timeout: 20_000 },
  );
  await new Promise((r) => setTimeout(r, 200));
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

describe("isTransactionNeverStarted", () => {
  test.skipIf(!appUrl)(
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

  test("no retry starts past the deadline", async () => {
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
    // Refusals at 2s and 4s retry (250ms and 500ms of backoff fit); at 6s the next wait would pass 5s.
    expect(calls).toBe(3);
  });
});
