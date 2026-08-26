import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  scheduledFlowWrites,
  settleFlowEvents,
} from "@/modules/flowlog/scheduled";
import { emitFlowEvent } from "@/modules/flowlog/service";

// ── EMPTYING THE TABLE IS NOT THE SAME AS IT STAYING EMPTY (issue #375) ──
//
// `emitFlowEvent` is fire-and-forget by design (src/modules/flowlog/service.ts): the hot WhatsApp
// path must not pay write latency for six log lines. The reader-scope ledger
// (tests/modules/flowlog-reader-scope.test.ts) names two obligations that fall out of it, SCOPE and
// WAIT, and fences the first. This file is about the third one, which that ledger did not name:
//
//   CLEAR  a test that empties `execution_logs` between cases empties it of the rows that EXIST.
//          A write the previous case only scheduled lands afterwards, into a table the current case
//          believes it owns, and `orderBy: { id: "asc" }` hands it back FIRST.
//
// Measured on this branch, 8 full-suite runs on the base: one failure, and it was
// `a requeue that arrives as the worker is dying reads the count it died at`
// (tests/modules/webhooks-outbound-deliveries.test.ts) reading `{ attempts: 9, … }` — the death line
// of the case directly above it, verbatim. In isolation that file passes 3 of 3, because the write
// only loses the race when the machine is loaded.
//
// The cases below use a base whose transaction is deliberately slow, so the race is not a race: a
// 300ms write against an immediate DELETE has one possible order. Nothing here polls for a timeout
// to expire, which is what makes them evidence rather than another flake.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

let tenantId: bigint;

// The seam is `ctx.base`: `runScopedOn` calls `base.$extends(…)` and then `$transaction(…)` on what
// that returns, so delaying the transaction delays the whole write and nothing else. Binding to
// `target` rather than forwarding the proxy as the receiver is what keeps Prisma's own accessors
// working — several of them are getters that close over the client instance.
function slowBase(real: PrismaClient, delayMs: number): PrismaClient {
  const wrap = <T extends object>(obj: T, patch: (p: string) => unknown) =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        if (typeof prop === "string") {
          const replacement = patch(prop);
          if (replacement !== undefined) return replacement;
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return wrap(real, (prop) =>
    prop === "$extends"
      ? // biome-ignore lint/suspicious/noExplicitAny: Prisma's extension surface is not expressible here
        (...args: any[]) => {
          // biome-ignore lint/suspicious/noExplicitAny: same
          const extended = (real as any).$extends(...args);
          return wrap(extended, (p) =>
            p === "$transaction"
              ? // biome-ignore lint/suspicious/noExplicitAny: same
                async (...txArgs: any[]) => {
                  await Bun.sleep(delayMs);
                  return extended.$transaction(...txArgs);
                }
              : undefined,
          );
        }
      : undefined,
  ) as PrismaClient;
}

function event(turnId: string) {
  return {
    ctx: { tenantId, turnId, source: "inbox" as const },
    ev: {
      stage: "webhook" as const,
      level: "info" as const,
      status: "ok" as const,
    },
  };
}

async function rows() {
  return suDb.executionLog.findMany({
    // flowlog-scope: tenant-wide — the subject is HOW MANY rows the tenant holds, which is the whole
    // question here: whether a clear left one behind and whether a settle waited for all of them. A
    // reader scoped to a turn would answer neither, since each case emits under a fresh turn id.
    where: { tenantId },
    orderBy: { id: "asc" },
  });
}

describe.skipIf(!dbUp)(
  "flowlog: settling the writes an emit only scheduled",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "FLS", slug: `fls-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      if (!dbUp) return;
      await suDb.$executeRaw`DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`;
      await suDb.tenant.delete({ where: { id: tenantId } });
      await suDb.$disconnect();
    });

    test("the row is not there when the emit returns, which is the whole premise", async () => {
      await settleFlowEvents();
      await suDb.$executeRaw`DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`;
      const { ctx, ev } = event(crypto.randomUUID());
      emitFlowEvent({ ...ctx, base: slowBase(suDb, 300) }, ev);
      // No await of any kind: this is what every caller of `emitFlowEvent` gets back.
      expect(await rows()).toHaveLength(0);
      await settleFlowEvents();
      expect(await rows()).toHaveLength(1);
    });

    test("a DELETE that does not settle first leaves the scheduled write behind", async () => {
      await settleFlowEvents();
      await suDb.$executeRaw`DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`;
      const { ctx, ev } = event(crypto.randomUUID());
      emitFlowEvent({ ...ctx, base: slowBase(suDb, 300) }, ev);
      // The clear as every one of these files writes it today.
      await suDb.$executeRaw`DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`;
      await settleFlowEvents();
      // The table was emptied twice and still holds a row: this is the defect, stated as a fact so
      // that a future change making the write synchronous is a deliberate red rather than a silent
      // one. It is also why `settleFlowEvents` cannot be optional at a clear site.
      expect(await rows()).toHaveLength(1);
    });

    test("a DELETE that settles first leaves nothing behind", async () => {
      await settleFlowEvents();
      await suDb.$executeRaw`DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`;
      const { ctx, ev } = event(crypto.randomUUID());
      emitFlowEvent({ ...ctx, base: slowBase(suDb, 300) }, ev);
      await settleFlowEvents();
      await suDb.$executeRaw`DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`;
      // Nothing can arrive late, because nothing was still scheduled when the DELETE ran.
      await Bun.sleep(400);
      expect(await rows()).toHaveLength(0);
    });

    test("settling waits for EVERY scheduled write, not the first to finish", async () => {
      await settleFlowEvents();
      await suDb.$executeRaw`DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`;
      // Descending delays: a settle that returned on the first resolution would return with two
      // writes still in flight, and the count below would read 1 instead of 3.
      for (const delay of [300, 200, 100]) {
        const { ctx, ev } = event(crypto.randomUUID());
        emitFlowEvent({ ...ctx, base: slowBase(suDb, delay) }, ev);
      }
      await settleFlowEvents();
      expect(await rows()).toHaveLength(3);
    });

    test("an emit scheduled WHILE settling is settled too", async () => {
      await settleFlowEvents();
      await suDb.$executeRaw`DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`;
      const first = event(crypto.randomUUID());
      emitFlowEvent({ ...first.ctx, base: slowBase(suDb, 300) }, first.ev);
      const settling = settleFlowEvents();
      // Scheduled after the settle started, which is the ordinary case rather than an exotic one: the
      // suite runs many files in one process and a clear does not stop the rest of them from emitting.
      await Bun.sleep(60);
      const second = event(crypto.randomUUID());
      emitFlowEvent({ ...second.ctx, base: slowBase(suDb, 300) }, second.ev);
      await settling;
      // A settle that snapshotted the set once would have returned after the first write alone.
      expect(await rows()).toHaveLength(2);
    });

    test("a write removes itself from the pending set with nobody settling", async () => {
      await settleFlowEvents();
      expect(scheduledFlowWrites()).toBe(0);
      const { ctx, ev } = event(crypto.randomUUID());
      emitFlowEvent({ ...ctx, base: suDb }, ev);
      expect(scheduledFlowWrites()).toBeGreaterThan(0);
      // No settle anywhere in this case, because production never calls one: the write has to clear
      // its own entry or the set grows by one row per log line until the process dies. Polled rather
      // than slept so the failure says "never dropped" instead of "not dropped within 500ms".
      const deadline = Date.now() + 3000;
      while (scheduledFlowWrites() > 0 && Date.now() < deadline)
        await Bun.sleep(25);
      expect(scheduledFlowWrites()).toBe(0);
    });

    test("settling returns when nothing was scheduled", async () => {
      await settleFlowEvents();
      const before = Date.now();
      await settleFlowEvents();
      // An empty settle is not a sleep and not a poll: it has nothing to wait for.
      expect(Date.now() - before).toBeLessThan(50);
    });

    test("a write that fails is still settled, so the next settle cannot hang on it", async () => {
      await settleFlowEvents();
      await suDb.$executeRaw`DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`;
      // A tenant id no row can reference: the insert fails inside `writeFlowEvent`, which swallows it.
      // What matters here is the bookkeeping, not the row — a failed write that stayed in the pending
      // set would make every later settle wait out a promise that already finished.
      const { ev } = event(crypto.randomUUID());
      emitFlowEvent(
        {
          tenantId: 0n,
          turnId: crypto.randomUUID(),
          source: "inbox",
          base: suDb,
        },
        ev,
      );
      await settleFlowEvents();
      const before = Date.now();
      await settleFlowEvents();
      expect(Date.now() - before).toBeLessThan(50);
      expect(await rows()).toHaveLength(0);
    });
  },
);
