import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
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

// THE POLL THAT WRITES WHAT THE GATE READS (issue #426). One scheduler job per tenant with the
// ceiling on, re-armed forever like the heartbeat, asking Langfuse for the month's cost per source
// and writing it to the local snapshot. What is pinned here: the question it asks (the query, the
// window, the environment that separates the two sources), what it writes, and the three ways a poll
// can go wrong without the gate ever seeing a wrong number — a failure keeps the last good figure, a
// total that went DOWN (ingestion behind) never lowers it, and a tenant with no Langfuse is told so
// on the row rather than polled for nothing.

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
const appDb = app as PrismaClient;

const NOW = new Date("2026-08-15T12:00:00Z");
const BASE_URL = "https://langfuse.example.test";
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

interface Seen {
  url: URL;
  query: Record<string, unknown>;
  auth: string | null;
}

// A Langfuse that answers per ENVIRONMENT, and records what it was asked.
function langfuseStub(
  rowsByEnv: Record<string, unknown[] | Error | number>,
  seen: Seen[] = [],
) {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const query = JSON.parse(url.searchParams.get("query") ?? "{}") as Record<
      string,
      unknown
    >;
    const headers = new Headers(init?.headers);
    seen.push({ url, query, auth: headers.get("authorization") });
    const env = (
      (query.filters as Array<{ column: string; value: string }>) ?? []
    ).find((f) => f.column === "environment")?.value;
    const answer = rowsByEnv[env ?? ""];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") {
      return new Response("{}", { status: answer });
    }
    return new Response(JSON.stringify({ data: answer ?? [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const INBOX_ENV = config.env;
const PLAY_ENV = `${config.env}-playground`;

const snapshot = (tenantId: bigint, source: string, at = NOW) =>
  suDb.spendCostSnapshot.findUnique({
    where: {
      tenantId_source_monthStart: {
        tenantId,
        source,
        monthStart: monthStart(at),
      },
    },
  });

const job = (tenantId: bigint): ClaimedJob =>
  ({
    id: 1n,
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
        baseUrl: BASE_URL,
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
      await suDb.schedulerJob.deleteMany({ where: { tenantId: id } });
      await clearFlowLog(suDb, { tenantId: id });
    }
  });

  afterAll(async () => {
    for (const id of [tenantA, tenantB, tenantC]) {
      if (!id) continue;
      for (const table of [
        "spend_cost_snapshots",
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

  test("asks Langfuse for the month, per environment, and writes what it answered", async () => {
    const { fetchFn, seen } = langfuseStub({
      [INBOX_ENV]: [
        {
          providedModelName: "gpt-5.4-mini",
          sum_totalCost: "1.25",
          count_count: 3,
        },
        {
          providedModelName: "openrouter/free-model",
          sum_totalCost: 0,
          count_count: 2,
        },
      ],
      [PLAY_ENV]: [
        {
          providedModelName: "gpt-5.4-mini",
          sum_totalCost: 0.5,
          count_count: 1,
        },
      ],
    });
    const out = await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn,
      now: NOW,
    });
    expect(out.status).toBe("polled");

    // The question: one query per source, on the observations view, summing cost and counting
    // generations per model, fenced to the source's environment and to the calendar month.
    expect(seen.map((s) => s.url.pathname)).toEqual([
      "/api/public/metrics",
      "/api/public/metrics",
    ]);
    expect(seen.map((s) => s.url.origin)).toEqual([BASE_URL, BASE_URL]);
    const expectedAuth = `Basic ${Buffer.from("pk-poll:sk-poll").toString("base64")}`;
    expect(seen.map((s) => s.auth)).toEqual([expectedAuth, expectedAuth]);
    const envs = seen.map(
      (s) =>
        (s.query.filters as Array<{ column: string; value: string }>).find(
          (f) => f.column === "environment",
        )?.value,
    );
    expect(envs.sort()).toEqual([INBOX_ENV, PLAY_ENV].sort());
    for (const s of seen) {
      expect(s.query.view).toBe("observations");
      expect(s.query.metrics).toEqual([
        { measure: "totalCost", aggregation: "sum" },
        { measure: "count", aggregation: "count" },
      ]);
      expect(s.query.dimensions).toEqual([{ field: "providedModelName" }]);
      expect(s.query.filters).toContainEqual({
        column: "type",
        operator: "=",
        value: "GENERATION",
        type: "string",
      });
      expect(s.query.fromTimestamp).toBe(monthStart(NOW).toISOString());
      expect(s.query.toTimestamp).toBe(NOW.toISOString());
    }

    // The answer, per source: the sum, the counts, and the models that carried no price.
    const inbox = await snapshot(tenantA, "inbox");
    expect(Number(inbox?.costUsd)).toBe(1.25);
    expect(inbox?.tracedCalls).toBe(5);
    expect(inbox?.costedCalls).toBe(3);
    expect(inbox?.unpricedModels).toEqual(["openrouter/free-model"]);
    expect(inbox?.polledAt?.toISOString()).toBe(NOW.toISOString());
    expect(inbox?.pollError).toBeNull();
    const play = await snapshot(tenantA, "playground");
    expect(Number(play?.costUsd)).toBe(0.5);
    expect(play?.tracedCalls).toBe(1);
    expect(play?.unpricedModels).toEqual([]);
    // Nothing was worth warning about.
    expect(
      // flowlog-scope: tenant-wide (the file clears each tenant's rows before every case)
      await flowLogRows(suDb, {
        where: { tenantId: tenantA, stage: "spend_ceiling" },
      }),
    ).toHaveLength(0);
  });

  test("a failed poll keeps the last good figure, records the failure, and warns once per window", async () => {
    const good = langfuseStub({
      [INBOX_ENV]: [
        { providedModelName: "m", sum_totalCost: "4", count_count: 4 },
      ],
      [PLAY_ENV]: [],
    });
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: good.fetchFn,
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const bad = langfuseStub({ [INBOX_ENV]: 500, [PLAY_ENV]: 500 });
    const out = await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: bad.fetchFn,
      now: later,
    });
    expect(out.status).toBe("failed");
    const inbox = await snapshot(tenantA, "inbox");
    expect(Number(inbox?.costUsd)).toBe(4);
    expect(inbox?.polledAt?.toISOString()).toBe(NOW.toISOString());
    expect(inbox?.pollError).toContain("500");
    expect(inbox?.pollFailedAt?.toISOString()).toBe(later.toISOString());
    // The operator hears about it ONCE per window, not once per poll.
    // flowlog-scope: tenant-wide (the file clears each tenant's rows before every case)
    const rows = await flowLogRows(suDb, {
      where: { tenantId: tenantA, stage: "spend_ceiling" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("warn");
    const detail = (rows[0]?.detail ?? {}) as { pollError?: string };
    expect(detail.pollError).toContain("500");
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: bad.fetchFn,
      now: new Date(later.getTime() + 5 * 60_000),
    });
    expect(
      // flowlog-scope: tenant-wide (the file clears each tenant's rows before every case)
      await flowLogRows(suDb, {
        where: { tenantId: tenantA, stage: "spend_ceiling" },
      }),
    ).toHaveLength(1);
    // A poll that works again clears the error and leaves the figure to catch up.
    const better = langfuseStub({
      [INBOX_ENV]: [
        { providedModelName: "m", sum_totalCost: "6", count_count: 6 },
      ],
      [PLAY_ENV]: [],
    });
    const after = new Date(later.getTime() + 10 * 60_000);
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: better.fetchFn,
      now: after,
    });
    const healed = await snapshot(tenantA, "inbox");
    expect(Number(healed?.costUsd)).toBe(6);
    expect(healed?.pollError).toBeNull();
    expect(healed?.pollFailedAt).toBeNull();
    expect(healed?.polledAt?.toISOString()).toBe(after.toISOString());
  });

  // Ingestion lag makes a total DROP: the month's cost is what Langfuse has finished ingesting, and
  // a burst that has not landed yet reads as money never spent. The figure is monotonic inside a
  // month, so a lower answer is not written over a higher one, and the counts follow the same rule.
  test("a total that went down never lowers the figure", async () => {
    const first = langfuseStub({
      [INBOX_ENV]: [
        { providedModelName: "m", sum_totalCost: "9", count_count: 9 },
      ],
      [PLAY_ENV]: [],
    });
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: first.fetchFn,
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 60_000);
    const behind = langfuseStub({
      [INBOX_ENV]: [
        { providedModelName: "m", sum_totalCost: "2", count_count: 2 },
      ],
      [PLAY_ENV]: [],
    });
    const out = await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: behind.fetchFn,
      now: later,
    });
    expect(out.status).toBe("polled");
    const inbox = await snapshot(tenantA, "inbox");
    expect(Number(inbox?.costUsd)).toBe(9);
    expect(inbox?.tracedCalls).toBe(9);
    // ...but the poll DID happen, and the health says so.
    expect(inbox?.polledAt?.toISOString()).toBe(later.toISOString());
  });

  test("a new month starts its own row, and last month's is left alone", async () => {
    const aug = langfuseStub({
      [INBOX_ENV]: [
        { providedModelName: "m", sum_totalCost: "9", count_count: 9 },
      ],
      [PLAY_ENV]: [],
    });
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: aug.fetchFn,
      now: NOW,
    });
    const sep = new Date("2026-09-03T00:00:00Z");
    const sepStub = langfuseStub({
      [INBOX_ENV]: [
        { providedModelName: "m", sum_totalCost: "0.1", count_count: 1 },
      ],
      [PLAY_ENV]: [],
    });
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: sepStub.fetchFn,
      now: sep,
    });
    expect(Number((await snapshot(tenantA, "inbox", sep))?.costUsd)).toBe(0.1);
    expect(Number((await snapshot(tenantA, "inbox", NOW))?.costUsd)).toBe(9);
    const sepQuery = sepStub.seen[0]?.query as
      | { fromTimestamp?: string }
      | undefined;
    expect(sepQuery?.fromTimestamp).toBe("2026-09-01T00:00:00.000Z");
  });

  test("a tenant with no Langfuse is told so on the row, and is not polled", async () => {
    const { fetchFn, seen } = langfuseStub({});
    const out = await pollTenantSpend(tenantB, {
      base: appDb,
      fetchFn,
      now: NOW,
    });
    expect(out.status).toBe("langfuse-not-configured");
    expect(seen).toHaveLength(0);
    const inbox = await snapshot(tenantB, "inbox");
    expect(Number(inbox?.costUsd)).toBe(0);
    expect(inbox?.polledAt).toBeNull();
    expect(inbox?.pollError).toBe("langfuse-not-configured");
  });

  describe("the job", () => {
    test("a tenant with the ceiling off ends the loop, without asking Langfuse", async () => {
      const { fetchFn, seen } = langfuseStub({});
      const result = await spendPollHandler(job(tenantC), appDb, {
        fetchFn,
        now: NOW,
      });
      expect(result).toEqual({ outcome: "done" });
      expect(seen).toHaveLength(0);
    });

    test("a tenant with the ceiling on polls and re-arms at the configured cadence", async () => {
      const { fetchFn, seen } = langfuseStub({
        [INBOX_ENV]: [
          { providedModelName: "m", sum_totalCost: "1", count_count: 1 },
        ],
        [PLAY_ENV]: [],
      });
      const before = Date.now();
      const result = await spendPollHandler(job(tenantA), appDb, {
        fetchFn,
        now: NOW,
      });
      expect(seen).toHaveLength(2);
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
    // reaches DEAD over a Langfuse that is down for an hour. The row carries the failure instead.
    test("a failing Langfuse keeps the loop alive", async () => {
      const { fetchFn } = langfuseStub({
        [INBOX_ENV]: new Error("ECONNREFUSED"),
        [PLAY_ENV]: 500,
      });
      const result = await spendPollHandler(job(tenantA), appDb, {
        fetchFn,
        now: NOW,
      });
      expect(result.outcome).toBe("reschedule");
      expect((await snapshot(tenantA, "inbox"))?.pollError).toContain(
        "ECONNREFUSED",
      );
    });
  });

  describe("arming", () => {
    const pending = (tenantId: bigint) =>
      suDb.schedulerJob.findMany({
        where: { tenantId, kind: "SPEND_CEILING_POLL", status: "PENDING" },
      });

    test("saving the ceiling on arms one job; saving it off cancels it; twice is once", async () => {
      await syncTenantSpendPoll(tenantA, appDb);
      await syncTenantSpendPoll(tenantA, appDb);
      const rows = await pending(tenantA);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.dedupeKey).toBe(SPEND_POLL_DEDUPE_KEY);
      await setCeiling(tenantA, { enabled: false, monthlyInboxUsd: 10 });
      try {
        await syncTenantSpendPoll(tenantA, appDb);
        expect(await pending(tenantA)).toHaveLength(0);
      } finally {
        await setCeiling(tenantA, { enabled: true, monthlyInboxUsd: 10 });
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

    // Boot: the rows are re-armed for every tenant whose ceiling is on, so a lost row (DB reset,
    // a truncate) is not a ceiling that silently stops being enforced against a figure frozen at
    // the last poll. A tenant with no Langfuse is armed too: its poll writes the reason on the row,
    // which is what the console shows, and the day Langfuse is configured the loop is already there.
    test("boot arms every tenant with the ceiling on, and no other", async () => {
      await ensureAllSpendPolls(appDb);
      expect(await pending(tenantA)).toHaveLength(1);
      expect(await pending(tenantB)).toHaveLength(1);
      expect(await pending(tenantC)).toHaveLength(0);
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
