import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  GUARDRAIL_HEALTH_WINDOW_HOURS,
  guardrailHealthWindowStart,
  readGuardrailHealth,
} from "@/modules/guardrails/health";

// What the guardrail screen actually did, read back from the flow log. The reason this read exists
// at all: analysis is fail-open, so a screen that can never run is indistinguishable from one that
// ran and approved, and the `guardrail`/`error` row is the only place the difference survives.
//
// Every row below carries an EXPLICIT createdAt from this process's clock, and the window is
// computed from that same clock. Letting Postgres stamp `now()` while the window comes from the
// host puts the two on different clocks, and a Docker VM that drifted behind after a sleep is
// exactly how a past worker test started reading rows "from the future" (see the alert-worker
// incident): the count would go empty for reasons that have nothing to do with this code.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
// Seeding runs as the migration role (it writes rows for two tenants); every READ goes through the
// application role, which is the one RLS actually constrains.
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const NOW = new Date();
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const SINCE = ago(24 * 60);

let tenantA = 0n;
let tenantB = 0n;
let AGENT = 0n;
let OTHER_AGENT = 0n;
let AGENT_B = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

// The window the controller hands the read. Pinned to an exact instant because the failure mode is
// an arithmetic one that no other test can see: the count is always right for the window it gets.
describe("guardrailHealthWindowStart", () => {
  test("goes back exactly the advertised number of hours", () => {
    expect(
      guardrailHealthWindowStart(new Date("2026-08-19T12:00:00.000Z")),
    ).toEqual(new Date("2026-08-18T12:00:00.000Z"));
    expect(GUARDRAIL_HEALTH_WINDOW_HOURS).toBe(24);
  });

  test("crosses a month boundary without drifting", () => {
    expect(
      guardrailHealthWindowStart(new Date("2026-03-01T03:00:00.000Z")),
    ).toEqual(new Date("2026-02-28T03:00:00.000Z"));
  });
});

describe.skipIf(!dbUp)("readGuardrailHealth", () => {
  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "GhA", slug: `gh-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "GhB", slug: `gh-b-${process.pid}` },
      })
    ).id;
    const agentRow = (tenantId: bigint, name: string) =>
      suDb.agent.create({
        data: {
          tenantId,
          name,
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
        select: { id: true },
      });
    AGENT = (await agentRow(tenantA, "Guarded")).id;
    OTHER_AGENT = (await agentRow(tenantA, "Sibling")).id;
    // Tenant B's own agent. The RLS assertion below asks for a reading while scoped to B, and with
    // the agent resolved first that has to be an agent B can actually see, or the read would 404 for
    // the wrong reason and the leak it guards against would go untested.
    AGENT_B = (await agentRow(tenantB, "Other tenant")).id;
    await suDb.executionLog.createMany({
      data: [
        // Two analyses that could not run, the newer one carrying the cause.
        {
          tenantId: tenantA,
          turnId: "g1",
          agentId: AGENT,
          stage: "guardrail",
          level: "warn",
          status: "error",
          source: "inbox",
          errorMessage: "401 incorrect api key provided",
          createdAt: ago(90),
        },
        {
          tenantId: tenantA,
          turnId: "g2",
          agentId: AGENT,
          stage: "guardrail",
          level: "warn",
          status: "error",
          source: "inbox",
          errorMessage: "400 temperature is not supported",
          createdAt: ago(5),
        },
        // A screen that RAN and tripped a check. It is the healthy shape of this stage and must
        // never be counted as a failure: the same stage, the same warn level, a different status.
        {
          tenantId: tenantA,
          turnId: "g3",
          agentId: AGENT,
          stage: "guardrail",
          level: "warn",
          status: "ok",
          source: "inbox",
          createdAt: ago(10),
        },
        // Another stage failing on the same agent says nothing about moderation.
        {
          tenantId: tenantA,
          turnId: "g4",
          agentId: AGENT,
          stage: "tts",
          level: "error",
          status: "error",
          source: "inbox",
          errorMessage: "boom",
          createdAt: ago(10),
        },
        // Outside the window: real, but not what the panel is reporting on.
        {
          tenantId: tenantA,
          turnId: "g5",
          agentId: AGENT,
          stage: "guardrail",
          level: "warn",
          status: "error",
          source: "inbox",
          errorMessage: "ancient",
          createdAt: ago(48 * 60),
        },
        // A different agent on the same tenant has its own answer.
        {
          tenantId: tenantA,
          turnId: "g6",
          agentId: OTHER_AGENT,
          stage: "guardrail",
          level: "warn",
          status: "error",
          source: "inbox",
          errorMessage: "not this agent",
          createdAt: ago(3),
        },
        // Another tenant's failure, for the RLS assertion.
        {
          tenantId: tenantB,
          turnId: "g7",
          agentId: AGENT_B,
          stage: "guardrail",
          level: "warn",
          status: "error",
          source: "inbox",
          errorMessage: "other tenant",
          createdAt: ago(3),
        },
      ],
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM execution_logs WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("counts the analyses that could not run, and only those", async () => {
    const health = await readGuardrailHealth(ctx(tenantA), AGENT, SINCE, appDb);
    expect(health.failures).toBe(2);
  });

  test("reports the most recent failure and the cause it carried", async () => {
    const health = await readGuardrailHealth(ctx(tenantA), AGENT, SINCE, appDb);
    expect(health.lastError).toBe("400 temperature is not supported");
    expect(health.lastAt).toBe(ago(5).toISOString());
  });

  test("a different agent gets its own count", async () => {
    const health = await readGuardrailHealth(
      ctx(tenantA),
      OTHER_AGENT,
      SINCE,
      appDb,
    );
    expect(health.failures).toBe(1);
    expect(health.lastError).toBe("not this agent");
  });

  test("an agent with nothing logged reads as zero, not as unknown", async () => {
    const quiet = (
      await suDb.agent.create({
        data: {
          tenantId: tenantA,
          name: "Quiet",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
        select: { id: true },
      })
    ).id;
    const health = await readGuardrailHealth(ctx(tenantA), quiet, SINCE, appDb);
    expect(health).toEqual({ failures: 0, lastAt: null, lastError: null });
  });

  // An agent whose only failure predates the window. The count is bounded twice over (the window on
  // the filter, the keyset on the count), but the row being QUOTED is chosen by the filter alone, so
  // without the window there the reading comes back as zero failures next to a timestamp and an
  // error from days ago: a response that contradicts itself, and a "last error" the operator would
  // read as current.
  test("a failure older than the window leaves nothing behind, not even a timestamp", async () => {
    const healed = (
      await suDb.agent.create({
        data: {
          tenantId: tenantA,
          name: "Healed",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
        select: { id: true },
      })
    ).id;
    await suDb.executionLog.create({
      data: {
        tenantId: tenantA,
        turnId: "g14",
        agentId: healed,
        stage: "guardrail",
        level: "warn",
        status: "error",
        source: "inbox",
        errorMessage: "fixed three days ago",
        createdAt: ago(72 * 60),
      },
    });
    expect(
      await readGuardrailHealth(ctx(tenantA), healed, SINCE, appDb),
    ).toEqual({ failures: 0, lastAt: null, lastError: null });
  });

  // Zero and "there is no such agent" are different answers, and the endpoint advertises 404. Rows
  // outlive the agent inside the retention window, so without this an id that was deleted (or one
  // that never existed) answers with a confident zero, and a recycled id answers with somebody
  // else's history.
  test("an agent that does not exist is a 404, never a zero", async () => {
    await expect(
      readGuardrailHealth(ctx(tenantA), 9_999_999n, SINCE, appDb),
    ).rejects.toThrow("agent not found");
  });

  test("another tenant's agent is a 404, not a reading", async () => {
    await expect(
      readGuardrailHealth(ctx(tenantA), AGENT_B, SINCE, appDb),
    ).rejects.toThrow("agent not found");
  });

  // The read does not filter by source. Today that is a distinction without a difference: the
  // guardrail stage is only ever written from the turn path, and the playground does not run the
  // pass at all, so this row is seeded by hand and the product cannot currently produce it. Pinned
  // anyway, because a filter added "for correctness" would report zero the day the pass runs
  // somewhere else, which is the exact failure this module exists to remove.
  test("a failure from any source counts, not just inbox", async () => {
    await suDb.executionLog.create({
      data: {
        tenantId: tenantA,
        turnId: "g8",
        agentId: AGENT,
        stage: "guardrail",
        level: "warn",
        status: "error",
        source: "playground",
        errorMessage: "400 temperature is not supported",
        createdAt: ago(1),
      },
    });
    const health = await readGuardrailHealth(ctx(tenantA), AGENT, SINCE, appDb);
    expect(health.failures).toBe(3);
    expect(health.lastAt).toBe(ago(1).toISOString());
  });

  // The rows are written fire-and-forget from independent transactions, and `now()` is the
  // TRANSACTION's start time, so the sequence can hand a higher id to a turn that started earlier.
  // Reading "the most recent" off the id would then report a failure that is not the most recent,
  // and that single field is what an operator uses to decide whether the screen is still failing.
  test("the most recent failure is the newest one, not the highest id", async () => {
    const older = await suDb.executionLog.create({
      data: {
        tenantId: tenantA,
        turnId: "g9",
        agentId: OTHER_AGENT,
        stage: "guardrail",
        level: "warn",
        status: "error",
        source: "inbox",
        errorMessage: "started earlier, written later",
        createdAt: ago(30),
      },
      select: { id: true },
    });
    // flowlog-scope: seeded — reads the row this test inserted above with `create`, awaited. No
    // emit in the path, so neither the scope nor the wait obligation applies.
    const newer = await suDb.executionLog.findFirst({
      where: { tenantId: tenantA, turnId: "g6" },
      select: { id: true },
    });
    // The row that must win is the one with the EARLIER id, which is the whole point.
    expect(older.id > (newer?.id ?? 0n)).toBe(true);
    const health = await readGuardrailHealth(
      ctx(tenantA),
      OTHER_AGENT,
      SINCE,
      appDb,
    );
    expect(health.lastError).toBe("not this agent");
    expect(health.lastAt).toBe(ago(3).toISOString());
  });

  // Two rows can carry the same createdAt, and the error has to come from one of them rather than
  // from a third read of "the newest row". The later insert wins; both answers agree on the time.
  test("a tie on the timestamp resolves to the later insert", async () => {
    // Its own agent: the rows above are shared by every test in this block, and a burst asserted
    // against a shared agent would be answered by whatever an earlier test happened to add.
    const burst = (
      await suDb.agent.create({
        data: {
          tenantId: tenantA,
          name: "Burst",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
        select: { id: true },
      })
    ).id;
    const at = ago(4);
    for (const msg of ["first of the burst", "second of the burst"]) {
      await suDb.executionLog.create({
        data: {
          tenantId: tenantA,
          turnId: "g10",
          agentId: burst,
          stage: "guardrail",
          level: "warn",
          status: "error",
          source: "inbox",
          errorMessage: msg,
          createdAt: at,
        },
      });
    }
    const health = await readGuardrailHealth(ctx(tenantA), burst, SINCE, appDb);
    expect(health.failures).toBe(2);
    expect(health.lastAt).toBe(at.toISOString());
    expect(health.lastError).toBe("second of the burst");
  });

  // The rule that only concurrency can see. The two reads are ordered newest-row-first so the count
  // can never exclude the row being quoted, and the count is capped at that row's timestamp to keep
  // it that way. Both statements run at READ COMMITTED, so a row committing between them is real:
  // this test forces exactly that interleaving by inserting a NEWER failure, from another
  // connection, in the moment between the row read and the count.
  test("a failure that commits mid-read cannot land in the count alone", async () => {
    const late = (
      await suDb.agent.create({
        data: {
          tenantId: tenantA,
          name: "Late",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
        select: { id: true },
      })
    ).id;
    await suDb.executionLog.create({
      data: {
        tenantId: tenantA,
        turnId: "g11",
        agentId: late,
        stage: "guardrail",
        level: "warn",
        status: "error",
        source: "inbox",
        errorMessage: "the one that was read",
        createdAt: ago(20),
      },
    });
    let injected = false;
    const racing = appDb.$extends({
      query: {
        executionLog: {
          count: async ({ args, query }) => {
            if (!injected) {
              injected = true;
              await suDb.executionLog.create({
                data: {
                  tenantId: tenantA,
                  turnId: "g12",
                  agentId: late,
                  stage: "guardrail",
                  level: "warn",
                  status: "error",
                  source: "inbox",
                  errorMessage: "committed mid-read",
                  createdAt: ago(1),
                },
              });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const health = await readGuardrailHealth(ctx(tenantA), late, SINCE, racing);
    expect(injected).toBe(true);
    expect(health.failures).toBe(1);
    // One or the other, never a mix: the count must not include a failure newer than the one it is
    // reporting, or the panel reads "2 failures, the most recent 20 minutes ago" while the newest is
    // a minute old and said something else.
    expect(health.failures).toBe(1);
    expect(health.lastError).toBe("the one that was read");
    expect(health.lastAt).toBe(ago(20).toISOString());
  });

  // Same interleaving, same millisecond. createdAt is a TIMESTAMP(3), so a burst lands several
  // failures inside one, and the row that commits mid-read is then NEWER by the ordering this module
  // uses (createdAt, then id) while carrying the same timestamp. A count cut on the timestamp alone
  // readmits it and reports a failure the message is not describing.
  test("a mid-read failure in the same millisecond is not counted either", async () => {
    const tied = (
      await suDb.agent.create({
        data: {
          tenantId: tenantA,
          name: "Tied",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
        select: { id: true },
      })
    ).id;
    const at = ago(20);
    const row = (msg: string) => ({
      tenantId: tenantA,
      turnId: "g13",
      agentId: tied,
      stage: "guardrail",
      level: "warn",
      status: "error",
      source: "inbox",
      errorMessage: msg,
      createdAt: at,
    });
    await suDb.executionLog.create({ data: row("the one that was read") });
    let injected = false;
    const racing = appDb.$extends({
      query: {
        executionLog: {
          count: async ({ args, query }) => {
            if (!injected) {
              injected = true;
              await suDb.executionLog.create({
                data: row("same millisecond, higher id"),
              });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const health = await readGuardrailHealth(ctx(tenantA), tied, SINCE, racing);
    expect(injected).toBe(true);
    expect(health.failures).toBe(1);
    expect(health.lastError).toBe("the one that was read");
  });

  test("RLS: a tenant only ever reads its own agent's failures", async () => {
    const health = await readGuardrailHealth(
      ctx(tenantB),
      AGENT_B,
      SINCE,
      appDb,
    );
    expect(health.failures).toBe(1);
    expect(health.lastError).toBe("other tenant");
  });
});
