import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  AGENT_EXPORT_KIND,
  AGENT_EXPORT_VERSION,
  importAgent,
} from "@/modules/agents/transfer";
import { ensureConversationRef } from "@/modules/integrations/conversation-ref";
import { createIntegrationInstance } from "@/modules/integrations/service";
import { type ClaimedJob, upsertJobRows } from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";
import {
  ensureAllInboundSweeps,
  redispatchInbound,
  redispatchKey,
  registerInboundSweepHandlers,
  sweepStrandedInbound,
} from "@/modules/webhooks/inbound/sweep";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";

// Issue #817: the receptor acks first and dispatches detached, so a death in between left the row
// PENDING or PROCESSING with the sender holding a 2xx, and only a redelivery ever retried it. The
// sweep finds those rows and arms one re-dispatch each; the re-dispatch is the processor itself, so
// the claim, the attempt cap and the dead-letter line are the processor's and are asserted here only
// as far as the sweep reaches them.

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const MIN = 60_000;

describe.skipIf(!dbUp)("inbound sweep (issue #817)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let tenantQuiet = 0n;
  let tenantImport = 0n;
  let instanceA = 0n;
  let instanceB = 0n;
  let seq = 0;

  const hash = (t: string) =>
    new Bun.CryptoHasher("sha256").update(t).digest("hex");

  beforeAll(async () => {
    registerInboundSweepHandlers();
    const mk = async (slug: string) =>
      (
        await suDb.tenant.create({
          data: { name: slug, slug: `${slug}-${process.pid}` },
        })
      ).id;
    tenantA = await mk("in817a");
    tenantB = await mk("in817b");
    tenantQuiet = await mk("in817q");
    tenantImport = await mk("in817i");
    const instance = async (tenantId: bigint, tok: string) =>
      (
        await suDb.integrationInstance.create({
          data: {
            tenantId,
            catalogType: "GENERIC",
            name: "inbound",
            enabled: true,
            config: {},
            routeTokenHash: hash(`${tok}-${process.pid}`),
            inboundAuthStrategy: "NONE",
          },
        })
      ).id;
    instanceA = await instance(tenantA, "tok-817a");
    instanceB = await instance(tenantB, "tok-817b");
    // The quiet tenant has an OUTBOUND-only instance: no route token, nothing inbound to strand.
    await suDb.integrationInstance.create({
      data: {
        tenantId: tenantQuiet,
        catalogType: "GENERIC",
        name: "outbound only",
        enabled: true,
        config: {},
        inboundAuthStrategy: "NONE",
      },
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB, tenantQuiet, tenantImport]) {
      if (!tid) continue;
      await clearFlowLog(suDb, { tenantId: tid });
      for (const tbl of [
        "scheduler_jobs",
        "inbound_deliveries",
        "audit_logs",
        "agent_tool_selections",
        "agents",
        "integration_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  async function clear(tid: bigint) {
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tid}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM inbound_deliveries WHERE tenant_id = ${tid}`,
    );
  }

  function seed(
    tenantId: bigint,
    instanceId: bigint,
    row: {
      status: "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED";
      attempts?: number;
      receivedAgoMs: number;
      claimedAgoMs?: number | null;
    },
  ) {
    const now = Date.now();
    seq += 1;
    return suDb.inboundDelivery.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        dedupeKey: `d817-${process.pid}-${seq}`,
        payload: { kind: "status_update" },
        status: row.status,
        attempts: row.attempts ?? 0,
        receivedAt: new Date(now - row.receivedAgoMs),
        claimedAt:
          row.claimedAgoMs == null ? null : new Date(now - row.claimedAgoMs),
      },
    });
  }

  const jobs = (tenantId: bigint) =>
    suDb.schedulerJob.findMany({
      where: { tenantId, kind: "INBOUND_REDISPATCH" },
      select: { dedupeKey: true, payload: true, status: true, id: true },
      orderBy: { id: "asc" },
    });

  function claimed(
    tenantId: bigint,
    payload: Record<string, unknown>,
  ): ClaimedJob {
    return {
      id: 0n,
      tenantId,
      kind: "INBOUND_REDISPATCH",
      payload,
    } as ClaimedJob;
  }

  test("arms one re-dispatch per stranded row, and none for a row still owned or finished", async () => {
    await clear(tenantA);
    const pendingOld = await seed(tenantA, instanceA, {
      status: "PENDING",
      receivedAgoMs: 10 * MIN,
    });
    const staleClaim = await seed(tenantA, instanceA, {
      status: "PROCESSING",
      attempts: 1,
      receivedAgoMs: 11 * MIN,
      claimedAgoMs: 10 * MIN,
    });
    // A claim that predates the `claimedAt` column: judged by receipt, as the processor judges it.
    const unstamped = await seed(tenantA, instanceA, {
      status: "PROCESSING",
      attempts: 1,
      receivedAgoMs: 10 * MIN,
      claimedAgoMs: null,
    });
    // Owned or done, so never armed.
    await seed(tenantA, instanceA, { status: "PENDING", receivedAgoMs: MIN });
    await seed(tenantA, instanceA, {
      status: "PROCESSING",
      attempts: 5,
      receivedAgoMs: 60 * MIN,
      claimedAgoMs: MIN,
    });
    await seed(tenantA, instanceA, {
      status: "PROCESSED",
      attempts: 1,
      receivedAgoMs: 60 * MIN,
      claimedAgoMs: 59 * MIN,
    });
    await seed(tenantA, instanceA, {
      status: "FAILED",
      attempts: 5,
      receivedAgoMs: 60 * MIN,
      claimedAgoMs: 59 * MIN,
    });

    const res = await sweepStrandedInbound({ tenantId: tenantA, base: appDb });
    expect(res.armed).toBe(3);
    expect((await jobs(tenantA)).map((j) => j.dedupeKey).sort()).toEqual(
      [
        redispatchKey(pendingOld.id, 0),
        redispatchKey(staleClaim.id, 1),
        redispatchKey(unstamped.id, 1),
      ].sort(),
    );
    for (const j of await jobs(tenantA)) {
      expect(j.status).toBe("PENDING");
    }
  });

  test("the same attempt is armed once; a new attempt that strands again is armed again", async () => {
    await clear(tenantA);
    const row = await seed(tenantA, instanceA, {
      status: "PENDING",
      receivedAgoMs: 10 * MIN,
    });
    expect(
      (await sweepStrandedInbound({ tenantId: tenantA, base: appDb })).armed,
    ).toBe(1);
    // A pass after the job died leaves it dead instead of reviving it, which is what bounds a
    // delivery whose dispatch throws before anything commits.
    await suDb.schedulerJob.updateMany({
      where: { tenantId: tenantA, kind: "INBOUND_REDISPATCH" },
      data: { status: "DEAD" },
    });
    expect(
      (await sweepStrandedInbound({ tenantId: tenantA, base: appDb })).armed,
    ).toBe(0);
    expect((await jobs(tenantA)).map((j) => j.status)).toEqual(["DEAD"]);
    // The re-dispatch claimed it (attempt 1) and then the process died in the middle.
    await suDb.inboundDelivery.update({
      where: { id: row.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        claimedAt: new Date(Date.now() - 10 * MIN),
      },
    });
    expect(
      (await sweepStrandedInbound({ tenantId: tenantA, base: appDb })).armed,
    ).toBe(1);
    expect((await jobs(tenantA)).map((j) => j.dedupeKey)).toEqual([
      redispatchKey(row.id, 0),
      redispatchKey(row.id, 1),
    ]);
  });

  test("the re-dispatch runs the processor: a stranded row ends PROCESSED, one claim later", async () => {
    await clear(tenantA);
    const row = await seed(tenantA, instanceA, {
      status: "PENDING",
      receivedAgoMs: 10 * MIN,
    });
    await sweepStrandedInbound({ tenantId: tenantA, base: appDb });
    const [job] = await jobs(tenantA);
    const handler = getJobHandler("INBOUND_REDISPATCH");
    expect(handler).toBeDefined();
    const out = await handler?.(
      claimed(tenantA, job?.payload as Record<string, unknown>),
      appDb,
    );
    expect(out).toEqual({ outcome: "done" });
    const after = await suDb.inboundDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("PROCESSED");
    expect(after.attempts).toBe(1);
    expect(after.processedAt).not.toBeNull();
    // Finished rows are not stranded: the next pass arms nothing.
    expect(
      (await sweepStrandedInbound({ tenantId: tenantA, base: appDb })).armed,
    ).toBe(0);
  });

  test("two re-dispatches of one row race and the row is claimed once", async () => {
    await clear(tenantA);
    const row = await seed(tenantA, instanceA, {
      status: "PENDING",
      receivedAgoMs: 10 * MIN,
    });
    const handler = getJobHandler("INBOUND_REDISPATCH");
    const job = claimed(tenantA, { deliveryId: String(row.id) });
    await Promise.all([handler?.(job, appDb), handler?.(job, appDb)]);
    const after = await suDb.inboundDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("PROCESSED");
    expect(after.attempts).toBe(1);
  });

  test("a stranded row past its attempt budget ends FAILED and is announced once", async () => {
    await clear(tenantA);
    await clearFlowLog(suDb, { tenantId: tenantA });
    const row = await seed(tenantA, instanceA, {
      status: "PROCESSING",
      attempts: 5,
      receivedAgoMs: 60 * MIN,
      claimedAgoMs: 10 * MIN,
    });
    await sweepStrandedInbound({ tenantId: tenantA, base: appDb });
    const [job] = await jobs(tenantA);
    expect(job?.dedupeKey).toBe(redispatchKey(row.id, 5));
    const handler = getJobHandler("INBOUND_REDISPATCH");
    await handler?.(
      claimed(tenantA, job?.payload as Record<string, unknown>),
      appDb,
    );
    expect(
      (await suDb.inboundDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("FAILED");
    // A second pass finds nothing to arm, so nothing announces twice.
    expect(
      (await sweepStrandedInbound({ tenantId: tenantA, base: appDb })).armed,
    ).toBe(0);
    const lines = await flowLogRows(suDb, {
      // flowlog-scope: tenant-wide — "announced once" is about every line the tenant got, and this
      // tenant belongs to this file alone; a filter by delivery id would hide a second line for it.
      where: { tenantId: tenantA, stage: "dead_letter" },
      select: { level: true, detail: true },
    });
    expect(lines).toHaveLength(1);
    const detail = lines[0]?.detail as Record<string, unknown>;
    expect(lines[0]?.level).toBe("error");
    expect(detail.unit).toBe("inbound_delivery");
    expect(detail.deliveryId).toBe(String(row.id));
    expect(detail.reason).toBe("attempts-exhausted");
  });

  test("a tenant's sweep arms only its own rows", async () => {
    await clear(tenantA);
    await clear(tenantB);
    await seed(tenantA, instanceA, {
      status: "PENDING",
      receivedAgoMs: 10 * MIN,
    });
    const b = await seed(tenantB, instanceB, {
      status: "PENDING",
      receivedAgoMs: 10 * MIN,
    });
    expect(
      (await sweepStrandedInbound({ tenantId: tenantB, base: appDb })).armed,
    ).toBe(1);
    expect((await jobs(tenantB)).map((j) => j.dedupeKey)).toEqual([
      redispatchKey(b.id, 0),
    ]);
    expect(await jobs(tenantA)).toEqual([]);
  });

  test("a re-dispatch with no delivery id fails instead of retrying", async () => {
    const handler = getJobHandler("INBOUND_REDISPATCH");
    const out = await handler?.(claimed(tenantA, {}), appDb);
    expect(out?.outcome).toBe("fail");
  });

  test("the sweep is armed for every tenant with an inbound surface, and only those", async () => {
    for (const t of [tenantA, tenantB, tenantQuiet]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${t} AND kind = 'INBOUND_SWEEP'`,
      );
    }
    await ensureAllInboundSweeps(appDb);
    const armed = await suDb.schedulerJob.findMany({
      where: {
        kind: "INBOUND_SWEEP",
        tenantId: { in: [tenantA, tenantB, tenantQuiet] },
      },
      select: { tenantId: true, dedupeKey: true },
    });
    expect(armed.map((r) => r.tenantId).sort()).toEqual(
      [tenantA, tenantB].sort(),
    );
    // Its own handler reschedules it, so the row is perpetual.
    const handler = getJobHandler("INBOUND_SWEEP");
    const out = await handler?.(
      {
        id: 0n,
        tenantId: tenantA,
        kind: "INBOUND_SWEEP",
        payload: {},
      } as ClaimedJob,
      appDb,
    );
    expect(out?.outcome).toBe("reschedule");
  });

  test("creating a tenant's first inbound instance arms its sweep", async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantQuiet} AND kind = 'INBOUND_SWEEP'`,
    );
    const ctx: TenantContext = {
      tenantId: tenantQuiet,
      userId: null,
      role: "TENANT_ADMIN",
    };
    const made = await createIntegrationInstance(
      ctx,
      { catalogType: "GENERIC", name: "now inbound" },
      appDb,
    );
    expect(made.routeToken).not.toBeNull();
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId: tenantQuiet, kind: "INBOUND_SWEEP" },
      }),
    ).toBe(1);
  });

  // Review round 1: a row whose re-dispatch died keeps its attempt count and stays stranded, so a
  // pass that read only the oldest N rows would hand every pass to N such rows and never reach a newer
  // delivery. More than one page of them here, and the newer row must still be armed.
  test("rows whose re-dispatch already died do not starve a newer stranded row", async () => {
    await clear(tenantA);
    const now = Date.now();
    const dead = 205;
    await suDb.inboundDelivery.createMany({
      data: Array.from({ length: dead }, (_, k) => ({
        tenantId: tenantA,
        integrationInstanceId: instanceA,
        dedupeKey: `poison-817-${process.pid}-${k}`,
        payload: { kind: "status_update" },
        status: "PENDING" as const,
        attempts: 0,
        receivedAt: new Date(now - 60 * MIN + k),
      })),
    });
    const poisoned = await suDb.inboundDelivery.findMany({
      where: { tenantId: tenantA, dedupeKey: { startsWith: "poison-817-" } },
      select: { id: true, attempts: true },
    });
    await suDb.schedulerJob.createMany({
      data: poisoned.map((p) => ({
        tenantId: tenantA,
        kind: "INBOUND_REDISPATCH" as const,
        dedupeKey: redispatchKey(p.id, p.attempts),
        runAt: new Date(now),
        payload: { deliveryId: String(p.id) },
        status: "DEAD" as const,
        attempts: 5,
      })),
    });
    const fresh = await seed(tenantA, instanceA, {
      status: "PENDING",
      receivedAgoMs: 10 * MIN,
    });
    const res = await sweepStrandedInbound({ tenantId: tenantA, base: appDb });
    expect(res.armed).toBe(1);
    const live = await suDb.schedulerJob.findMany({
      where: {
        tenantId: tenantA,
        kind: "INBOUND_REDISPATCH",
        status: "PENDING",
      },
      select: { dedupeKey: true },
    });
    expect(live.map((j) => j.dedupeKey)).toEqual([redispatchKey(fresh.id, 0)]);
  });

  // Review round 1: an agent import creates its integrations with a route token each, and it can be
  // the tenant's first inbound surface, which the boot arm never saw.
  test("an agent import that brings an integration arms the sweep, and its dry run does not", async () => {
    const ctx: TenantContext = {
      tenantId: tenantImport,
      userId: null,
      role: "TENANT_ADMIN",
    };
    const bundle = (name: string) => ({
      version: AGENT_EXPORT_VERSION,
      kind: AGENT_EXPORT_KIND,
      agent: {
        name,
        systemPrompt: "x",
        modelConfig: {},
        settings: {},
        transferWithSummary: false,
        businessHours: null,
        followUpHours: null,
        tools: [],
        credentials: [],
      },
      components: {
        httpTools: [],
        mcpServers: [],
        integrations: [
          { catalogType: "GENERIC", name: `hook-${name}`, config: {} },
        ],
        knowledgeBases: [],
      },
    });
    const sweeps = () =>
      suDb.schedulerJob.count({
        where: { tenantId: tenantImport, kind: "INBOUND_SWEEP" },
      });
    await importAgent(ctx, bundle("dry"), appDb, { dryRun: true });
    expect(await sweeps()).toBe(0);
    await importAgent(ctx, bundle("real"), appDb);
    expect(await sweeps()).toBe(1);
  });

  // Review round 2: the run's deadline has to reach the turn, or a turn past it finishes beside the
  // next attempt. Driven through the re-dispatch with a fake nudge, on a GENERIC event that reaches
  // the nudge phase.
  test("the re-dispatch hands its deadline signal to the nudge turn", async () => {
    await clear(tenantA);
    const minted = await ensureConversationRef({
      tenantId: tenantA,
      integrationInstanceId: instanceA,
      threadId: `thread-817-${process.pid}`,
      base: appDb,
    });
    if (!minted.ok) throw new Error("mint");
    seq += 1;
    const row = await suDb.inboundDelivery.create({
      data: {
        tenantId: tenantA,
        integrationInstanceId: instanceA,
        dedupeKey: `sig-817-${process.pid}-${seq}`,
        externalId: minted.ref,
        payload: { kind: "agent_nudge", text: "sinal" },
        status: "PENDING",
        receivedAt: new Date(Date.now() - 10 * MIN),
      },
    });
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const out = await redispatchInbound(
      claimed(tenantA, { deliveryId: String(row.id) }),
      appDb,
      { signal: controller.signal } as Parameters<typeof redispatchInbound>[2],
      {
        runNudge: async (args) => {
          seen = args.signal;
          return "messaged";
        },
      },
    );
    expect(out).toEqual({ outcome: "done" });
    expect(seen).toBe(controller.signal);
  });

  // The bulk writer's `once` is what the sweep writes with. Through the sweep it is invisible (the
  // query already skips an armed key), so it is asserted here: an existing row stays exactly as it is,
  // and a missing one is inserted.
  test("a bulk `once` arm inserts what is missing and leaves an existing row alone", async () => {
    await clear(tenantA);
    const kept = await suDb.schedulerJob.create({
      data: {
        tenantId: tenantA,
        kind: "INBOUND_REDISPATCH",
        dedupeKey: "once-817-kept",
        runAt: new Date(Date.now() - MIN),
        payload: { deliveryId: "1" },
        status: "DEAD",
        attempts: 5,
        lastError: "boom",
      },
    });
    const inserted = await runScopedOn(
      appDb,
      { tenantId: tenantA, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        upsertJobRows(db, {
          tenantId: tenantA,
          kind: "INBOUND_REDISPATCH",
          rearm: "once",
          runAt: new Date(),
          rows: [
            { dedupeKey: "once-817-kept", payload: { deliveryId: "2" } },
            { dedupeKey: "once-817-new", payload: { deliveryId: "3" } },
          ],
        }),
    );
    expect(inserted).toBe(1);
    const after = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: kept.id },
    });
    expect(after.status).toBe("DEAD");
    expect(after.attempts).toBe(5);
    expect(after.lastError).toBe("boom");
    expect(after.payload).toEqual({ deliveryId: "1" });
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId: tenantA, dedupeKey: "once-817-new" },
      }),
    ).toBe(1);
  });
});
