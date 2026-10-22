import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type ClaimedJob,
  claimDueDebounceJobs,
  claimDueJobs,
  claimDueTrafficJobs,
  claimPendingByKeyPrefix,
} from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";

// The claim picks its rows in an order (oldest first, or by rank and creation), and its callers run
// them in the order the array comes back: the traffic drain starts them that way, and the turn barrier
// folds a thread's queued messages in that way. The UPDATE that marks them CLAIMED returns rows in the
// order its join produces them, which is not the order the CTE chose. The plan is PINNED to the one
// that shows it, a hash join probed by a sequential scan, so rows come back in heap order, and the
// rows are written with ages that follow neither their write order nor its reverse.
const KNOBS = [
  "enable_nestloop=off",
  "enable_mergejoin=off",
  "enable_indexscan=off",
  "enable_bitmapscan=off",
]
  .map((k) => `-c ${k}`)
  .join(" ");

const suUrl = process.env.MIGRATION_DATABASE_URL;
const pinnedUrl = suUrl
  ? `${suUrl}${suUrl.includes("?") ? "&" : "?"}options=${encodeURIComponent(KNOBS)}`
  : undefined;

let dbUp = false;
let su: PrismaClient | undefined;
let pinned: PrismaClient | undefined;
if (suUrl && pinnedUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    pinned = new PrismaClient({
      adapter: new PrismaPg({ connectionString: pinnedUrl }),
    });
    await pinned.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const pinnedDb = pinned as PrismaClient;

// Minutes ago each row, in write order, was created and came due.
const AGES = [3, 6, 1, 5, 2, 4];
let tenantId = 0n;

// The keys in the order the claim takes them, oldest first.
async function arm(
  kind: "INGEST_MESSAGE" | "HEARTBEAT" | "DEBOUNCE",
  tag: string,
): Promise<string[]> {
  for (const [i, age] of AGES.entries()) {
    await suDb.$executeRaw`
      INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, payload, run_at,
                                  status, attempts, claim_seq, created_at, updated_at)
      VALUES (${tenantId}, ${kind}::"SchedulerJobKind", ${`${tag}${i}`}, '{}'::jsonb,
              now() - make_interval(mins => ${age}), 'PENDING', 0, 0,
              now() - make_interval(mins => ${age}), now())`;
  }
  return [...AGES.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([i]) => `${tag}${i}`);
}

const keys = (jobs: ClaimedJob[]) => jobs.map((j) => j.dedupeKey);

describe.skipIf(!dbUp)(
  "the claim hands its rows back in the order it chose them",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "CLAIMORDER", slug: `claim-order-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      if (tenantId) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
        );
        await suDb.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await su?.$disconnect();
      await pinned?.$disconnect();
    });

    const clear = () =>
      suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
      );

    test("the connection really carries the planner settings the rig depends on", async () => {
      for (const knob of ["enable_nestloop", "enable_mergejoin"]) {
        const [row] = await pinnedDb.$queryRawUnsafe<
          Array<Record<string, string>>
        >(`SHOW ${knob}`);
        expect(row?.[knob]).toBe("off");
      }
    });

    test("the traffic share, by rank and creation", async () => {
      const expected = await arm("INGEST_MESSAGE", "order-traffic-");
      expect(
        keys(await claimDueTrafficJobs(50, pinnedDb, new Date(), tenantId)),
      ).toEqual(expected);
      await clear();
    });

    test("the traffic share under a spend cap, by rank and creation", async () => {
      const expected = await arm("INGEST_MESSAGE", "order-capped-");
      expect(
        keys(await claimDueTrafficJobs(50, pinnedDb, new Date(), tenantId, 10)),
      ).toEqual(expected);
      await clear();
    });

    test("the fixed batch, oldest due first", async () => {
      const expected = await arm("HEARTBEAT", "order-batch-");
      expect(
        keys(await claimDueJobs(50, pinnedDb, new Date(), tenantId)),
      ).toEqual(expected);
      await clear();
    });

    test("the debounce share, oldest due first within a tenant", async () => {
      const expected = await arm("DEBOUNCE", "order-debounce-");
      expect(
        keys(await claimDueDebounceJobs(50, pinnedDb, new Date(), tenantId)),
      ).toEqual(expected);
      await clear();
    });

    test("the turn barrier's claim of a thread's queued messages, oldest first", async () => {
      const expected = await arm("INGEST_MESSAGE", "order-barrier-");
      expect(
        keys(
          await claimPendingByKeyPrefix(
            "INGEST_MESSAGE",
            "order-barrier-",
            50,
            pinnedDb,
            tenantId,
          ),
        ),
      ).toEqual(expected);
      await clear();
    });
  },
);
