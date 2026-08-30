import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { countingBase } from "../utils/counting-base";

// `countingBase` is the instrument two suites use to assert that a section holds no connection
// across an await (`tests/graph/pool-inversion.test.ts`, `tests/modules/contact-auth-nudge.test.ts`).
// Both used to read the raw COUNT, and the count answers a different question than either asks: the
// client is shared with writes this run neither started nor awaits — `emitFlowEvent` is one by
// design — so a detached INSERT still in flight made the count non-zero while the caller held
// nothing. That was a real CI failure on a green branch, reproducible with
// `PROBE_FLOWLOG_DELAY_MS=12`, and it is why `heldHere` is answered from the caller's own async
// context rather than from a number.
//
// A fake client rather than a database: what is under test is the instrument's bookkeeping, and a
// real transaction would only make the two answers harder to tell apart.
function fakeClient(): PrismaClient {
  const c = {
    $extends: () => c,
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  };
  return c as unknown as PrismaClient;
}

describe("countingBase tells 'the caller is inside one' from 'one exists'", () => {
  test("heldHere is true inside the transaction and false outside it", async () => {
    const c = countingBase(fakeClient());
    expect(c.heldHere()).toBe(false);
    await c.base.$transaction(async () => {
      expect(c.heldHere()).toBe(true);
    });
    expect(c.heldHere()).toBe(false);
  });

  test("a detached transaction in flight does not make the caller look held", async () => {
    const c = countingBase(fakeClient());
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    // Started and NOT awaited, which is the shape of `emitFlowEvent`.
    const detached = c.base.$transaction(async () => blocked);
    await Bun.sleep(0);

    // The count sees it, which is what the leak check is for and what used to be read here.
    expect(c.open()).toBe(1);
    // The caller does not, because it is not in that transaction's context.
    expect(c.heldHere()).toBe(false);

    release?.();
    await detached;
    expect(c.open()).toBe(0);
  });

  test("the mark does not leak into a transaction opened beside it", async () => {
    const c = countingBase(fakeClient());
    let seen: boolean | undefined;
    await c.base.$transaction(async () => {
      // A second transaction started from inside the first WOULD see the mark, so the case that
      // matters is the sibling: opened after the first resolved, from the top level.
      seen = c.heldHere();
    });
    expect(seen).toBe(true);
    expect(c.heldHere()).toBe(false);
  });

  test("$extends keeps one watch rather than starting a second", async () => {
    const c = countingBase(fakeClient());
    const extended = c.base.$extends({}) as unknown as PrismaClient;
    await extended.$transaction(async () => {
      expect(c.heldHere()).toBe(true);
    });
    expect(c.total()).toBe(1);
  });
});
