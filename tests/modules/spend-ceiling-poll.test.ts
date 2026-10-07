import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import {
  JOB_DEATH_LEVEL,
  JOB_DELETE_ON_DONE,
  JOB_LANE,
  JOB_SPENDS_PROVIDER,
  JOB_TRAFFIC_PROPORTIONAL,
} from "@/modules/scheduler/lanes";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  ensureAllSpendPolls,
  SPEND_POLL_DEDUPE_KEY,
  syncTenantSpendPoll,
} from "@/modules/spend-ceiling/arm";
import { monthStart } from "@/modules/spend-ceiling/decide";
import {
  pollTenantSpend,
  spendPollHandler,
} from "@/modules/spend-ceiling/poll";
import {
  updateLangfuse,
  updateSpendCeiling,
} from "@/modules/tenant-settings/service";
import { formatVaultRef } from "@/modules/vault/service";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { burnSchedulerJobId } from "../utils/scheduler";

// THE POLL THAT WRITES WHAT THE GATE READS. One scheduler job per tenant with the
// ceiling on, re-armed forever like the heartbeat, summing the month's priced `llm_usage.cost_usd`
// per source into the local snapshot. What is pinned here: what it sums (the tenant's month, per
// source, priced rows only, Langfuse or not), that the figure follows the ledger down as well as up,
// and the ways a poll can go wrong without the gate seeing a wrong number: a failure keeps the last
// good figure, and an older reading never overwrites a newer one.

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
const suDb = su as PrismaClient;

// Burned from `scheduler_jobs_id_seq`, never a literal: tests/utils/scheduler.ts says why.
let phantomJobId = 0n;
const appDb = app as PrismaClient;

const NOW = new Date("2026-08-15T12:00:00Z");
let tenantA = 0n; // Langfuse configured, ceiling on
let tenantB = 0n; // ceiling on, no Langfuse
let tenantC = 0n; // ceiling off

const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

async function setCeiling(id: bigint, patch: Record<string, unknown>) {
  const t = await suDb.tenant.findUnique({
    where: { id },
    select: { settings: true },
  });
  await suDb.tenant.update({
    where: { id },
    data: {
      settings: {
        ...(t?.settings as object),
        spendCeiling: patch,
      } as Prisma.InputJsonValue,
    },
  });
}

async function usage(
  tenantId: bigint,
  costUsd: number | null,
  opts: { source?: string; at?: Date; model?: string } = {},
) {
  return suDb.llmUsage.create({
    data: {
      tenantId,
      model: opts.model ?? "m",
      source: opts.source ?? "inbox",
      promptTokens: 10,
      completionTokens: 5,
      costUsd: costUsd ?? undefined,
      createdAt: opts.at ?? NOW,
    },
    select: { id: true },
  });
}

// A database whose ledger sum fails with `message`, everything else intact: the poll's own read is
// the one thing that can go wrong between it and the row.
function failingLedger(message: string): PrismaClient {
  return appDb.$extends({
    query: {
      llmUsage: {
        async aggregate() {
          throw new Error(message);
        },
      },
    },
  }) as unknown as PrismaClient;
}

const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const snapshot = (tenantId: bigint, source: string, when = NOW) =>
  suDb.spendCostSnapshot.findUnique({
    where: {
      tenantId_source_monthStart: {
        tenantId,
        source,
        monthStart: monthStart(when),
      },
    },
  });

const job = (tenantId: bigint): ClaimedJob =>
  ({
    id: phantomJobId,
    tenantId,
    kind: "SPEND_CEILING_POLL",
    dedupeKey: SPEND_POLL_DEDUPE_KEY,
    payload: {},
    payloadSecret: null,
    claimSeq: 1,
    attempts: 0,
  }) as unknown as ClaimedJob;

describe.skipIf(!dbUp)("the spend ceiling poll", () => {
  beforeAll(async () => {
    phantomJobId = await burnSchedulerJobId(suDb);
    const a = await suDb.tenant.create({
      data: { name: "SP-A", slug: `sp-a-${process.pid}` },
    });
    const b = await suDb.tenant.create({
      data: { name: "SP-B", slug: `sp-b-${process.pid}` },
    });
    const c = await suDb.tenant.create({
      data: { name: "SP-C", slug: `sp-c-${process.pid}` },
    });
    tenantA = a.id;
    tenantB = b.id;
    tenantC = c.id;
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId: tenantA,
        name: "lf-poll",
        kind: "langfuse",
        secret: encryptJson({ publicKey: "pk-poll", secretKey: "sk-poll" }),
        baseUrl: "https://langfuse.example.test",
      },
      select: { id: true },
    });
    await updateLangfuse(
      ctxOf(tenantA),
      { enabled: true, credentialRef: formatVaultRef(entry.id) },
      appDb,
    );
    await setCeiling(tenantA, { enabled: true, monthlyInboxUsd: 10 });
    await setCeiling(tenantB, { enabled: true, monthlyInboxUsd: 10 });
    await setCeiling(tenantC, { enabled: false, monthlyInboxUsd: 10 });
  });

  beforeEach(async () => {
    clearContactAuthState();
    for (const id of [tenantA, tenantB, tenantC]) {
      await suDb.spendCostSnapshot.deleteMany({ where: { tenantId: id } });
      await suDb.llmUsage.deleteMany({ where: { tenantId: id } });
      await suDb.schedulerJob.deleteMany({ where: { tenantId: id } });
      await clearFlowLog(suDb, { tenantId: id });
    }
  });

  afterAll(async () => {
    for (const id of [tenantA, tenantB, tenantC]) {
      if (!id) continue;
      for (const table of [
        "spend_cost_snapshots",
        "llm_usage",
        "scheduler_jobs",
        "execution_logs",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${id}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // The figure is the tenant's own month, per source, from the rows that carry a price. A tenant
  // with no Langfuse is polled like any other: the ledger is local, and the old poll's
  // "langfuse-not-configured" row, which left such a tenant with no ceiling, is gone.
  test("sums the month's priced ledger per source, with or without Langfuse", async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await usage(tenantId, 1.25);
      await usage(tenantId, 0.75, { at: at(-60 * 24 * 10) });
      await usage(tenantId, 2, { source: "playground" });
      // No price: in no figure, never as zero.
      await usage(tenantId, null, { model: "unpriced" });
      // Last month and next month are other rows.
      await usage(tenantId, 50, { at: new Date("2026-07-31T23:59:59Z") });
      await usage(tenantId, 70, { at: new Date("2026-09-01T00:00:00Z") });
    }
    // Another tenant's spend is not this one's.
    await usage(tenantC, 99);
    for (const tenantId of [tenantA, tenantB]) {
      const out = await pollTenantSpend(tenantId, { base: appDb, now: NOW });
      expect(out.status).toBe("polled");
      const inbox = await snapshot(tenantId, "inbox");
      expect(Number(inbox?.costUsd)).toBe(2);
      expect(inbox?.polledAt?.toISOString()).toBe(NOW.toISOString());
      expect(inbox?.pollError).toBeNull();
      expect(Number((await snapshot(tenantId, "playground"))?.costUsd)).toBe(2);
    }
  });

  // A re-priced month is the ledger's answer now, and the ceiling follows it: the old poll floored
  // the figure at its previous value against Langfuse's ingestion lag, which a local, synchronous
  // ledger does not have.
  test("a month re-priced downwards lowers the figure", async () => {
    const row = await usage(tenantB, 9);
    await pollTenantSpend(tenantB, { base: appDb, now: NOW });
    expect(Number((await snapshot(tenantB, "inbox"))?.costUsd)).toBe(9);
    await suDb.llmUsage.update({ where: { id: row.id }, data: { costUsd: 2 } });
    await pollTenantSpend(tenantB, { base: appDb, now: at(1) });
    const inbox = await snapshot(tenantB, "inbox");
    expect(Number(inbox?.costUsd)).toBe(2);
    expect(inbox?.polledAt?.toISOString()).toBe(at(1).toISOString());
  });

  test("a failed poll keeps the last good figure, records the failure, and warns once per window", async () => {
    await usage(tenantB, 4);
    await pollTenantSpend(tenantB, { base: appDb, now: NOW });
    const later = at(5);
    const down = failingLedger("statement timeout");
    const out = await pollTenantSpend(tenantB, { base: down, now: later });
    expect(out.status).toBe("failed");
    const inbox = await snapshot(tenantB, "inbox");
    expect(Number(inbox?.costUsd)).toBe(4);
    expect(inbox?.polledAt?.toISOString()).toBe(NOW.toISOString());
    expect(inbox?.pollError).toContain("statement timeout");
    expect(inbox?.pollFailedAt?.toISOString()).toBe(later.toISOString());
    // The operator hears about it ONCE per window, not once per poll.
    // flowlog-scope: tenant-wide (the file clears each tenant's rows before every case)
    const rows = await flowLogRows(suDb, {
      where: { tenantId: tenantB, stage: "spend_ceiling" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.errorMessage).toContain("usage ledger");
    expect(rows[0]?.errorMessage).not.toContain("Langfuse");
    await pollTenantSpend(tenantB, { base: down, now: at(10) });
    expect(
      // flowlog-scope: tenant-wide (the file clears each tenant's rows before every case)
      await flowLogRows(suDb, {
        where: { tenantId: tenantB, stage: "spend_ceiling" },
      }),
    ).toHaveLength(1);
    // A poll that works again clears the error and catches the figure up.
    await usage(tenantB, 2);
    await pollTenantSpend(tenantB, { base: appDb, now: at(15) });
    const healed = await snapshot(tenantB, "inbox");
    expect(Number(healed?.costUsd)).toBe(6);
    expect(healed?.pollError).toBeNull();
    expect(healed?.pollFailedAt).toBeNull();
    expect(healed?.polledAt?.toISOString()).toBe(at(15).toISOString());
  });

  // NOTE: an error text is not ours to store as it came: a NUL or an unpaired surrogate is a string
  // Postgres refuses, so the one write that records the failure would itself fail.
  test("an error text the database would refuse is stored sanitized", async () => {
    const out = await pollTenantSpend(tenantB, {
      base: failingLedger("body was \u0000nul\ud800tail"),
      now: NOW,
    });
    expect(out.status).toBe("failed");
    const inbox = await snapshot(tenantB, "inbox");
    expect(inbox?.pollError).toBeTruthy();
    expect(inbox?.pollError).not.toContain("\u0000");
    expect(inbox?.pollError).toContain("nul");
  });

  test("a new month starts its own row, and last month's is left alone", async () => {
    await usage(tenantB, 9);
    await pollTenantSpend(tenantB, { base: appDb, now: NOW });
    const sept = new Date("2026-09-02T00:00:00Z");
    await usage(tenantB, 1, { at: sept });
    await pollTenantSpend(tenantB, { base: appDb, now: sept });
    expect(Number((await snapshot(tenantB, "inbox", NOW))?.costUsd)).toBe(9);
    expect(Number((await snapshot(tenantB, "inbox", sept))?.costUsd)).toBe(1);
  });

  // NOTE: TWO POLLS OF ONE TENANT CAN OVERLAP (a save re-arms the job), so the row keeps the newer
  // reading: an older success landing last writes nothing, and an older failure neither.
  test("an older success landing last does not overwrite a newer reading", async () => {
    await usage(tenantB, 3);
    await pollTenantSpend(tenantB, { base: appDb, now: at(2) });
    await usage(tenantB, 4);
    await pollTenantSpend(tenantB, { base: appDb, now: at(1) });
    const row = await snapshot(tenantB, "inbox");
    expect(Number(row?.costUsd)).toBe(3);
    expect(row?.polledAt?.toISOString()).toBe(at(2).toISOString());
  });

  test("a failure that began before the row's last success writes nothing, and is not announced", async () => {
    await pollTenantSpend(tenantB, { base: appDb, now: at(2) });
    const down = failingLedger("connection reset");
    expect(
      (await pollTenantSpend(tenantB, { base: down, now: at(1) })).status,
    ).toBe("failed");
    const row = await snapshot(tenantB, "inbox");
    expect(row?.pollError).toBeNull();
    expect(row?.polledAt?.toISOString()).toBe(at(2).toISOString());
    expect(
      // flowlog-scope: tenant-wide (the file clears each tenant's rows before every case)
      await flowLogRows(suDb, {
        where: { tenantId: tenantB, stage: "spend_ceiling" },
      }),
    ).toHaveLength(0);
    // A failure that began after it is the row's present, and is recorded.
    await pollTenantSpend(tenantB, { base: down, now: at(3) });
    expect(
      (await snapshot(tenantB, "inbox"))?.pollFailedAt?.toISOString(),
    ).toBe(at(3).toISOString());
  });

  // NOTE: THE ROW'S HEALTH NEVER MOVES BACKWARDS: a success older than the latest failure keeps that
  // failure on the row, measured against the latest attempt, not the streak's start.
  test("an older success does not clear a streak that failed again after it", async () => {
    const down = failingLedger("connection reset");
    await pollTenantSpend(tenantB, { base: down, now: at(1) });
    await pollTenantSpend(tenantB, { base: down, now: at(3) });
    await usage(tenantB, 5);
    await pollTenantSpend(tenantB, { base: appDb, now: at(2) });
    const row = await snapshot(tenantB, "inbox");
    expect(Number(row?.costUsd)).toBe(5);
    expect(row?.pollError).toContain("connection reset");
    expect(row?.pollFailedAt?.toISOString()).toBe(at(1).toISOString());
    await pollTenantSpend(tenantB, { base: appDb, now: at(4) });
    const cleared = await snapshot(tenantB, "inbox");
    expect(cleared?.pollError).toBeNull();
    expect(cleared?.pollFailedAt).toBeNull();
  });

  // NOTE: THE INSTANT A FAILURE STREAK BEGAN. The console says "failing since", so the row keeps the
  // first failure of the streak; a success clears it, and the next failure starts a new one.
  test("a streak of failures keeps the instant it began", async () => {
    const down = failingLedger("connection reset");
    await pollTenantSpend(tenantB, { base: down, now: NOW });
    await pollTenantSpend(tenantB, { base: down, now: at(1) });
    expect(
      (await snapshot(tenantB, "inbox"))?.pollFailedAt?.toISOString(),
    ).toBe(NOW.toISOString());
    await pollTenantSpend(tenantB, { base: appDb, now: at(2) });
    expect((await snapshot(tenantB, "inbox"))?.pollFailedAt).toBeNull();
    await pollTenantSpend(tenantB, { base: down, now: at(3) });
    expect(
      (await snapshot(tenantB, "inbox"))?.pollFailedAt?.toISOString(),
    ).toBe(at(3).toISOString());
  });

  test("the failure's log line carries the sanitized message", async () => {
    const warn = spyOn(logger, "warn");
    try {
      await pollTenantSpend(tenantB, {
        base: failingLedger("boom"),
        now: NOW,
      });
      const logged = warn.mock.calls.map((c) => JSON.stringify(c)).join("\n");
      expect(logged).toContain("the last figure stands");
      expect(logged).toContain("boom");
    } finally {
      warn.mockRestore();
    }
  });

  describe("the job", () => {
    test("a tenant with the ceiling off ends the loop and writes nothing", async () => {
      await usage(tenantC, 1);
      const result = await spendPollHandler(job(tenantC), appDb, { now: NOW });
      expect(result).toEqual({ outcome: "done" });
      expect(await snapshot(tenantC, "inbox")).toBeNull();
    });

    test("a tenant with the ceiling on polls and re-arms at the configured cadence", async () => {
      await usage(tenantA, 1);
      const before = Date.now();
      const result = await spendPollHandler(job(tenantA), appDb, { now: NOW });
      expect(Number((await snapshot(tenantA, "inbox"))?.costUsd)).toBe(1);
      expect(result.outcome).toBe("reschedule");
      if (result.outcome !== "reschedule") throw new Error("unreachable");
      const delay = result.runAt.getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(
        config.spendCeiling.pollIntervalMs - 1000,
      );
      expect(delay).toBeLessThanOrEqual(
        config.spendCeiling.pollIntervalMs + 5000,
      );
    });

    // A failure is not a reason to stop: the handler never throws, so the scheduler's ladder never
    // reaches DEAD. The row carries the failure instead.
    test("a failing ledger read keeps the loop alive", async () => {
      const result = await spendPollHandler(
        job(tenantB),
        failingLedger("ECONNREFUSED"),
        { now: NOW },
      );
      expect(result.outcome).toBe("reschedule");
      expect((await snapshot(tenantB, "inbox"))?.pollError).toContain(
        "ECONNREFUSED",
      );
    });

    // NOTE: the settings read sits BEFORE the poll's own try: a pool with no free connection there
    // throws out of the handler, and five of those in a row is DEAD, the one outcome this job must
    // never reach. It is a failure like any other: log, re-arm, ask again.
    test("a settings read that fails keeps the loop alive too", async () => {
      const broken = appDb.$extends({
        query: {
          tenant: {
            async findUnique() {
              throw new Error("pool exhausted");
            },
          },
        },
      }) as unknown as PrismaClient;
      const result = await spendPollHandler(job(tenantA), broken, { now: NOW });
      expect(result.outcome).toBe("reschedule");
      expect(await snapshot(tenantA, "inbox")).toBeNull();
    });
  });

  describe("arming", () => {
    const pending = (tenantId: bigint) =>
      suDb.schedulerJob.findMany({
        where: { tenantId, kind: "SPEND_CEILING_POLL", status: "PENDING" },
      });

    test("saving the ceiling on arms one job; saving it off cancels it, Langfuse or not; twice is once", async () => {
      await syncTenantSpendPoll(tenantA, appDb);
      await syncTenantSpendPoll(tenantA, appDb);
      const rows = await pending(tenantA);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.dedupeKey).toBe(SPEND_POLL_DEDUPE_KEY);
      await syncTenantSpendPoll(tenantB, appDb);
      expect(await pending(tenantB)).toHaveLength(1);
      for (const id of [tenantA, tenantB]) {
        await setCeiling(id, { enabled: false, monthlyInboxUsd: 10 });
      }
      try {
        await syncTenantSpendPoll(tenantA, appDb);
        await syncTenantSpendPoll(tenantB, appDb);
        expect(await pending(tenantA)).toHaveLength(0);
        expect(await pending(tenantB)).toHaveLength(0);
      } finally {
        for (const id of [tenantA, tenantB]) {
          await setCeiling(id, { enabled: true, monthlyInboxUsd: 10 });
        }
      }
    });

    // The save is what arms it in practice: the settings service calls the sync after the write, so
    // an operator switching the ceiling on from the console gets a poll without a restart.
    test("the settings write arms and cancels the poll on its own", async () => {
      await updateSpendCeiling(
        ctxOf(tenantC),
        { enabled: true, monthlyInboxUsd: 10 },
        appDb,
      );
      try {
        expect(await pending(tenantC)).toHaveLength(1);
        await updateSpendCeiling(ctxOf(tenantC), { enabled: false }, appDb);
        expect(await pending(tenantC)).toHaveLength(0);
      } finally {
        await setCeiling(tenantC, { enabled: false, monthlyInboxUsd: 10 });
      }
    });

    // A Langfuse save changes nothing the poll reads anymore.
    test("saving the Langfuse block does not arm the poll", async () => {
      await updateLangfuse(ctxOf(tenantA), { sendContent: true }, appDb);
      try {
        expect(await pending(tenantA)).toHaveLength(0);
      } finally {
        await updateLangfuse(ctxOf(tenantA), { sendContent: false }, appDb);
      }
    });

    // NOTE: boot re-arms the rows for every tenant whose ceiling is on, so a lost row (DB reset, a
    // truncate) is not a ceiling that silently stops being enforced against a figure frozen at the
    // last poll. Langfuse plays no part.
    test("boot arms every tenant with the ceiling on, and no other", async () => {
      await setCeiling(tenantA, { enabled: false, monthlyInboxUsd: 10 });
      try {
        await ensureAllSpendPolls(appDb);
        expect(await pending(tenantA)).toHaveLength(0);
        expect(await pending(tenantB)).toHaveLength(1);
        expect(await pending(tenantC)).toHaveLength(0);
      } finally {
        await setCeiling(tenantA, { enabled: true, monthlyInboxUsd: 10 });
      }
    });
  });

  test("the kind is placed on the shared lane, spends no provider budget, and its death is an error", () => {
    expect(JOB_LANE.SPEND_CEILING_POLL).toBe("shared");
    expect(JOB_SPENDS_PROVIDER.SPEND_CEILING_POLL).toBe(false);
    expect(JOB_DELETE_ON_DONE.SPEND_CEILING_POLL).toBe(false);
    expect(JOB_TRAFFIC_PROPORTIONAL.SPEND_CEILING_POLL).toBe(false);
    expect(JOB_DEATH_LEVEL.SPEND_CEILING_POLL).toBe("error");
  });
});
