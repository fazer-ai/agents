import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { asSuperAdminOn } from "@/lib/tenancy";
import { runDebounceTick } from "@/modules/debounce/worker";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";

// The lane can run more turns than the main pool has connections (docs/deploy.md
// "Connection budget"), because a turn holds a connection per transaction and never across its model
// call: transactions are DB-only by rule (multi-tenant.ts). So six turns on a pool of two take turns
// on the connections, each transaction waiting well inside its `maxWait`, and none fails for want of
// one. A turn that held its connection across the call would make the third pair wait two calls for
// a connection, past `maxWait`, and fail here.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const POOL = 2;
const TURNS = 6;
// The model call: longer than the pool's whole queue of transactions, so the turns overlap on it.
const MODEL_MS = 300;
// Shorter than production's, so the case above fails fast; the claim is about the shape, not the number.
const BUDGET = { maxWait: 500, timeout: 5_000 };

let dbUp = false;
let small: PrismaClient | undefined;
if (appUrl) {
  try {
    small = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: POOL }),
    });
    await small.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const db = small as PrismaClient;

afterAll(async () => {
  await small?.$disconnect();
});

function job(id: number): ClaimedJob {
  return {
    id: BigInt(9_000 + id),
    tenantId: 1n,
    kind: "DEBOUNCE",
    payload: {},
    attempts: 0,
    claimSeq: 0,
  };
}

describe.skipIf(!dbUp)(
  "a lane with more slots than main-pool connections",
  () => {
    test("runs every turn at once, and no transaction fails for want of a connection", async () => {
      const due = Array.from({ length: TURNS }, (_, i) => job(i));
      let active = 0;
      let peak = 0;
      const failures: unknown[] = [];
      const done: bigint[] = [];
      const { claimed, settled } = await runDebounceTick(db, TURNS, {
        claim: async (limit) => due.splice(0, limit),
        run: async (j) => {
          active += 1;
          peak = Math.max(peak, active);
          try {
            // Reading history before the call, writing the reply and the flow log after it.
            await asSuperAdminOn(
              db,
              (tx) => tx.$executeRaw`SELECT pg_sleep(0.02)`,
              BUDGET,
            );
            await new Promise((r) => setTimeout(r, MODEL_MS));
            await asSuperAdminOn(
              db,
              (tx) => tx.$executeRaw`SELECT pg_sleep(0.02)`,
              BUDGET,
            );
            await asSuperAdminOn(db, (tx) => tx.$queryRaw`SELECT 1`, BUDGET);
            done.push(j.id);
          } catch (err) {
            failures.push(err);
          } finally {
            active -= 1;
          }
        },
      });
      await settled;
      expect(claimed).toBe(TURNS);
      expect(peak).toBe(TURNS);
      expect(failures).toEqual([]);
      expect(done).toHaveLength(TURNS);
    });
  },
);
