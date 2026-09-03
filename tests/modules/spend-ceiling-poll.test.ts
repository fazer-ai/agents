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

// A Langfuse that answers per ENVIRONMENT, and records what it was asked. `seen` is the metrics
// queries; the projects endpoint (the identity the figure is carried across) is counted apart, so
// a test about the queries does not have to know it is asked first.
function langfuseStub(
  rowsByEnv: Record<string, unknown[] | Error | number>,
  seen: Seen[] = [],
  opts: { projectId?: string; projectStatus?: number } = {},
) {
  const projects = { calls: 0, auth: [] as Array<string | null> };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/public/projects") {
      projects.calls += 1;
      projects.auth.push(headers.get("authorization"));
      if (opts.projectStatus !== undefined) {
        return new Response("{}", { status: opts.projectStatus });
      }
      return new Response(
        JSON.stringify({
          data: [{ id: opts.projectId ?? "proj-1", name: "P" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const query = JSON.parse(url.searchParams.get("query") ?? "{}") as Record<
      string,
      unknown
    >;
    seen.push({ url, query, auth: headers.get("authorization") });
    const env = (
      (query.filters as Array<{ column: string; value: string }>) ?? []
    ).find((f) => f.column === "environment")?.value;
    const answer = rowsByEnv[env ?? ""];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") {
      return new Response("{}", { status: answer });
    }
    // A fixture that says nothing about `avg_totalCost` is a fully priced group (avg = sum / count),
    // so the rows written before round 4 keep their meaning; a mixed group says its own avg.
    const data = (answer ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      if ("avg_totalCost" in row) return row;
      const sum = Number(row.sum_totalCost ?? 0);
      const count = Number(row.count_count ?? 0);
      return {
        ...row,
        avg_totalCost: sum > 0 && count > 0 ? sum / count : null,
      };
    });
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, seen, projects };
}

const INBOX_ENV = config.env;
const PLAY_ENV = `${config.env}-playground`;
const rows = (cost: number, calls: number) => ({
  [INBOX_ENV]: [
    { providedModelName: "m", sum_totalCost: cost, count_count: calls },
  ],
  [PLAY_ENV]: [],
});
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

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
    const { fetchFn, seen, projects } = langfuseStub({
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
    // And which project it is talking to, once, with the same credential: the identity the figure
    // is carried across (see "the figure across Langfuse projects").
    expect(projects).toEqual({ calls: 1, auth: [expectedAuth] });
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
        { measure: "totalCost", aggregation: "avg" },
      ]);
      expect(s.query.dimensions).toEqual([{ field: "providedModelName" }]);
      expect(s.query.filters).toContainEqual({
        column: "type",
        operator: "=",
        value: "GENERATION",
        type: "string",
      });
      // And fenced to THIS tenant (review round 2): the environment is deployment-wide, so a
      // project shared by two tenants, or one carrying another generator in the same environment,
      // would otherwise be summed into every tenant's month. The trace's `userId` is the slug.
      expect(s.query.filters).toContainEqual({
        column: "userId",
        operator: "=",
        value: `sp-a-${process.pid}`,
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

  // What Langfuse answers is not ours to store as it came (review round 1): a parse error quotes the
  // body, and a body with a NUL or an unpaired surrogate is a string Postgres refuses, so the one
  // write that records the failure would itself fail and the row would show a poll that never ran.
  test("an error text the database would refuse is stored sanitized", async () => {
    const { fetchFn } = langfuseStub({
      [INBOX_ENV]: new Error("body was \u0000nul\ud800tail"),
      [PLAY_ENV]: [],
    });
    const out = await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn,
      now: NOW,
    });
    expect(out.status).toBe("failed");
    const inbox = await snapshot(tenantA, "inbox");
    expect(inbox?.pollError).toBeTruthy();
    expect(inbox?.pollError).not.toContain("\u0000");
    expect(inbox?.pollError).toContain("nul");
    expect(inbox?.pollFailedAt?.toISOString()).toBe(NOW.toISOString());
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

  // A GROUP IS PRICED PER GENERATION, NOT PER MODEL (review round 4). A price added mid-month leaves
  // the earlier calls at NULL (Langfuse does not re-price, measured on v3.225.7), and a call with no
  // usage block is NULL under a priced model, so a model group with a positive sum can still hold
  // calls the ceiling never saw. The metrics API cannot filter on a measure, but `avg` skips NULL
  // where `count` does not: sum / avg is the number of generations that carried a cost.
  test("a model priced part of the month counts only the generations that carried a price", async () => {
    const { fetchFn } = langfuseStub({
      [INBOX_ENV]: [
        // Two calls, one priced at $2: sum 2, avg 2 (the NULL is skipped), count 2.
        {
          providedModelName: "mixed",
          sum_totalCost: 2,
          count_count: 2,
          avg_totalCost: 2,
        },
        // Three calls, all priced at $1.
        {
          providedModelName: "whole",
          sum_totalCost: 3,
          count_count: 3,
          avg_totalCost: 1,
        },
        // A model priced at ZERO by the operator is unpriced to a ceiling: no avg to divide by.
        {
          providedModelName: "zeroed",
          sum_totalCost: 0,
          count_count: 4,
          avg_totalCost: 0,
        },
      ],
      [PLAY_ENV]: [],
    });
    await pollTenantSpend(tenantA, { base: appDb, fetchFn, now: NOW });
    const row = await snapshot(tenantA, "inbox");
    expect(Number(row?.costUsd)).toBe(5);
    expect(row?.tracedCalls).toBe(9);
    expect(row?.costedCalls).toBe(4);
    expect(row?.unpricedModels).toEqual(["mixed", "zeroed"]);
  });

  // TWO POLLS ON ONE ROW (review round 5). A save re-arms the job with `enqueueJob`, which resets a
  // CLAIMED row to PENDING, so the next tick can claim it while the first run is still inside its
  // write: both read the same previous figure, and the one that finishes last writes what it
  // computed, lower answer included. The write takes the row's advisory lock before it reads, so
  // the second poll reads what the first committed. Poll A reads and is held inside its
  // transaction; poll B, with the higher answer, is let run meanwhile; without the lock B commits 9
  // and A then writes 5 over it.
  test("two polls racing on one row keep the higher figure", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let paused = false;
    const slow = appDb.$extends({
      query: {
        spendCostSnapshot: {
          async findUnique({ args, query }) {
            const out = await query(args);
            if (!paused) {
              paused = true;
              await held;
            }
            return out;
          },
        },
      },
    }) as unknown as PrismaClient;
    const a = pollTenantSpend(tenantA, {
      base: slow,
      fetchFn: langfuseStub(rows(5, 5)).fetchFn,
      now: NOW,
    });
    while (!paused) await Bun.sleep(5);
    const b = pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: langfuseStub(rows(9, 9)).fetchFn,
      now: at(1),
    });
    // Long enough for B to reach the row: with the lock it waits there, without it, it commits.
    await Bun.sleep(300);
    release();
    await Promise.all([a, b]);
    expect(Number((await snapshot(tenantA, "inbox"))?.costUsd)).toBe(9);
  });

  // A PARTIAL ANSWER KEEPS THE NAMES TOO (review round 6). The counters are monotonic, so an answer
  // behind the row (ingestion lag) leaves them standing; a list re-read from that same answer
  // would drop a model whose calls are still in them. Behind keeps the names; a whole answer,
  // which is any answer at or past the row, is the list as before, so a model priced since drops.
  test("a partial answer keeps the names the retained counters still stand on", async () => {
    const whole = langfuseStub({
      [INBOX_ENV]: [
        { providedModelName: "paid", sum_totalCost: 10, count_count: 10 },
        { providedModelName: "free", sum_totalCost: 0, count_count: 5 },
      ],
      [PLAY_ENV]: [],
    });
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: whole.fetchFn,
      now: NOW,
    });
    const behind = langfuseStub({
      [INBOX_ENV]: [
        { providedModelName: "paid", sum_totalCost: 3, count_count: 3 },
      ],
      [PLAY_ENV]: [],
    });
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: behind.fetchFn,
      now: at(1),
    });
    const kept = await snapshot(tenantA, "inbox");
    expect(kept?.tracedCalls).toBe(15);
    expect(kept?.unpricedModels).toEqual(["free"]);
    const priced = langfuseStub({
      [INBOX_ENV]: [
        { providedModelName: "paid", sum_totalCost: 12, count_count: 12 },
        { providedModelName: "free", sum_totalCost: 1, count_count: 5 },
      ],
      [PLAY_ENV]: [],
    });
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: priced.fetchFn,
      now: at(2),
    });
    expect((await snapshot(tenantA, "inbox"))?.unpricedModels).toEqual([]);
  });

  // THE INSTANT A FAILURE STREAK BEGAN (review round 5). The console says "failing since", so the
  // row has to keep the first failure of the streak, not the latest attempt; a success clears it,
  // and the next failure starts a new one.
  test("a streak of failures keeps the instant it began", async () => {
    const down = langfuseStub({ [INBOX_ENV]: 500, [PLAY_ENV]: 500 });
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: down.fetchFn,
      now: NOW,
    });
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: down.fetchFn,
      now: at(1),
    });
    expect(
      (await snapshot(tenantA, "inbox"))?.pollFailedAt?.toISOString(),
    ).toBe(NOW.toISOString());
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: langfuseStub(rows(1, 1)).fetchFn,
      now: at(2),
    });
    expect((await snapshot(tenantA, "inbox"))?.pollFailedAt).toBeNull();
    await pollTenantSpend(tenantA, {
      base: appDb,
      fetchFn: down.fetchFn,
      now: at(3),
    });
    expect(
      (await snapshot(tenantA, "inbox"))?.pollFailedAt?.toISOString(),
    ).toBe(at(3).toISOString());
  });

  // THE FIGURE FOLLOWS THE MONTH, NOT THE PROJECT (review round 3). A tenant that points its
  // Langfuse at another project mid-month starts a new series there: the new project's total
  // begins near zero, and a monotonic floor taken over the old figure would sit at $40 while
  // $40 + $20 was spent. So the poll asks which project it is talking to and, when that changes,
  // carries what the old one stood at into the row: the figure is the carry plus the new project's
  // own total. A key rotated INSIDE a project is the same project and carries nothing: identity is
  // the project's id, never the credential.
  describe("the figure across Langfuse projects", () => {
    test("a project switched mid-month carries what the first one stood at", async () => {
      const first = langfuseStub(rows(40, 40), [], { projectId: "proj-a" });
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: first.fetchFn,
        now: NOW,
      });
      const before = await snapshot(tenantA, "inbox");
      expect(Number(before?.costUsd)).toBe(40);
      expect(before?.projectKey).toBe(`${BASE_URL}#proj-a`);
      expect(Number(before?.carriedUsd)).toBe(0);

      const second = langfuseStub(rows(20, 10), [], { projectId: "proj-b" });
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: second.fetchFn,
        now: at(1),
      });
      const switched = await snapshot(tenantA, "inbox");
      expect(Number(switched?.costUsd)).toBe(60);
      expect(switched?.tracedCalls).toBe(50);
      expect(switched?.costedCalls).toBe(50);
      expect(switched?.projectKey).toBe(`${BASE_URL}#proj-b`);
      expect(Number(switched?.carriedUsd)).toBe(40);
      expect(switched?.carriedTracedCalls).toBe(40);

      // The carry is taken ONCE, at the switch: the new project's next answer adds to it.
      const later = langfuseStub(rows(25, 12), [], { projectId: "proj-b" });
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: later.fetchFn,
        now: at(2),
      });
      expect(Number((await snapshot(tenantA, "inbox"))?.costUsd)).toBe(65);
      // And the floor still holds inside the new series.
      const behind = langfuseStub(rows(15, 8), [], { projectId: "proj-b" });
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: behind.fetchFn,
        now: at(3),
      });
      expect(Number((await snapshot(tenantA, "inbox"))?.costUsd)).toBe(65);
    });

    // The names travel with the figure (review round 4): the old project is never asked again, so a
    // model it could not price would otherwise vanish from the screen while its calls stay in the
    // carried counters. Carried names stay for the month; the current project's own list is still
    // re-read on every poll, so a model priced there drops off as before.
    test("a project switched mid-month keeps the models the first one could not price", async () => {
      const first = langfuseStub(
        {
          [INBOX_ENV]: [
            { providedModelName: "paid", sum_totalCost: 10, count_count: 10 },
            { providedModelName: "free-a", sum_totalCost: 0, count_count: 5 },
          ],
          [PLAY_ENV]: [],
        },
        [],
        { projectId: "proj-a" },
      );
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: first.fetchFn,
        now: NOW,
      });
      const second = langfuseStub(
        {
          [INBOX_ENV]: [
            { providedModelName: "free-b", sum_totalCost: 0, count_count: 2 },
          ],
          [PLAY_ENV]: [],
        },
        [],
        { projectId: "proj-b" },
      );
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: second.fetchFn,
        now: at(1),
      });
      const switched = await snapshot(tenantA, "inbox");
      expect(switched?.unpricedModels).toEqual(["free-a", "free-b"]);
      expect(switched?.tracedCalls).toBe(17);
      expect(switched?.costedCalls).toBe(10);
      // The new project prices its model: its name goes, the carried one stays.
      const later = langfuseStub(
        {
          [INBOX_ENV]: [
            { providedModelName: "free-b", sum_totalCost: 1, count_count: 3 },
          ],
          [PLAY_ENV]: [],
        },
        [],
        { projectId: "proj-b" },
      );
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: later.fetchFn,
        now: at(2),
      });
      expect((await snapshot(tenantA, "inbox"))?.unpricedModels).toEqual([
        "free-a",
      ]);
    });

    // AN ANSWER FROM A CREDENTIAL THAT IS GONE IS DROPPED (review round 9). A save re-arms the job,
    // so a poll asked under the old credential can land after the one asked under the new. Written,
    // it would read the new project on the row as a switch and carry the combined figure on top of
    // its own. Poll A is held inside its fetch; the credential is rotated to project B and poll B
    // runs whole; A is then let go, and must write nothing.
    test("a poll asked under a credential that changed meanwhile writes nothing", async () => {
      const entry = await suDb.vaultEntry.findFirstOrThrow({
        where: { tenantId: tenantA, name: "lf-poll" },
        select: { id: true, secret: true },
      });
      let release: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      let paused = false;
      const inner = langfuseStub(rows(40, 40), [], { projectId: "proj-a" });
      const slowFetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        if (!paused) {
          paused = true;
          await held;
        }
        return inner.fetchFn(input, init);
      }) as typeof fetch;
      const a = pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: slowFetch,
        now: NOW,
      });
      while (!paused) await Bun.sleep(5);
      try {
        await suDb.vaultEntry.update({
          where: { id: entry.id },
          data: {
            secret: encryptJson({ publicKey: "pk-b", secretKey: "sk-b" }),
          },
        });
        const b = langfuseStub(rows(20, 10), [], { projectId: "proj-b" });
        expect(
          (
            await pollTenantSpend(tenantA, {
              base: appDb,
              fetchFn: b.fetchFn,
              now: at(1),
            })
          ).status,
        ).toBe("polled");
        release();
        expect((await a).status).toBe("superseded");
        const row = await snapshot(tenantA, "inbox");
        expect(Number(row?.costUsd)).toBe(20);
        expect(row?.projectKey).toBe(`${BASE_URL}#proj-b`);
        expect(Number(row?.carriedUsd)).toBe(0);
      } finally {
        await suDb.vaultEntry.update({
          where: { id: entry.id },
          data: { secret: entry.secret },
        });
      }
    });

    // THE CHECK AND THE WRITE ARE ONE (review round 10). Poll A passes its credential check, then
    // the credential changes and poll B, on the new project, writes before A does: A would read
    // B's row as a switch and carry B's combined figure on top of its own. Under the month's lock B
    // waits for A, and then carries A's figure once. A is held after its second vault read, which
    // is the check inside the write.
    test("a credential changed between a poll's check and its write cannot double the month", async () => {
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: langfuseStub(rows(40, 40), [], { projectId: "proj-a" })
          .fetchFn,
        now: NOW,
      });
      const entry = await suDb.vaultEntry.findFirstOrThrow({
        where: { tenantId: tenantA, name: "lf-poll" },
        select: { id: true, secret: true },
      });
      let release: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      let vaultReads = 0;
      let paused = false;
      const slow = appDb.$extends({
        query: {
          vaultEntry: {
            async findFirst({ args, query }) {
              const out = await query(args);
              vaultReads += 1;
              if (vaultReads === 2) {
                paused = true;
                await held;
              }
              return out;
            },
          },
        },
      }) as unknown as PrismaClient;
      const a = pollTenantSpend(tenantA, {
        base: slow,
        fetchFn: langfuseStub(rows(41, 41), [], { projectId: "proj-a" })
          .fetchFn,
        now: at(1),
      });
      while (!paused) await Bun.sleep(5);
      try {
        await suDb.vaultEntry.update({
          where: { id: entry.id },
          data: {
            secret: encryptJson({ publicKey: "pk-b", secretKey: "sk-b" }),
          },
        });
        const b = pollTenantSpend(tenantA, {
          base: appDb,
          fetchFn: langfuseStub(rows(20, 10), [], { projectId: "proj-b" })
            .fetchFn,
          now: at(2),
        });
        // Long enough for B to reach the lock: with it B waits there, without it B writes.
        await Bun.sleep(300);
        release();
        expect((await a).status).toBe("polled");
        expect((await b).status).toBe("polled");
        const row = await snapshot(tenantA, "inbox");
        expect(Number(row?.costUsd)).toBe(61);
        expect(Number(row?.carriedUsd)).toBe(41);
        expect(row?.projectKey).toBe(`${BASE_URL}#proj-b`);
      } finally {
        await suDb.vaultEntry.update({
          where: { id: entry.id },
          data: { secret: entry.secret },
        });
      }
    });

    test("a key rotated inside the same project carries nothing", async () => {
      const entry = await suDb.vaultEntry.findFirstOrThrow({
        where: { tenantId: tenantA, name: "lf-poll" },
        select: { id: true, secret: true },
      });
      const first = langfuseStub(rows(40, 40), [], { projectId: "proj-a" });
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: first.fetchFn,
        now: NOW,
      });
      try {
        await suDb.vaultEntry.update({
          where: { id: entry.id },
          data: {
            secret: encryptJson({
              publicKey: "pk-rotated",
              secretKey: "sk-rotated",
            }),
          },
        });
        const rotated = langfuseStub(rows(41, 41), [], { projectId: "proj-a" });
        await pollTenantSpend(tenantA, {
          base: appDb,
          fetchFn: rotated.fetchFn,
          now: at(1),
        });
        // The new key was the one used, and the figure is the project's own, not doubled.
        expect(rotated.seen[0]?.auth).toBe(
          `Basic ${Buffer.from("pk-rotated:sk-rotated").toString("base64")}`,
        );
        const row = await snapshot(tenantA, "inbox");
        expect(Number(row?.costUsd)).toBe(41);
        expect(Number(row?.carriedUsd)).toBe(0);
      } finally {
        await suDb.vaultEntry.update({
          where: { id: entry.id },
          data: { secret: entry.secret },
        });
      }
    });

    test("a project that cannot be named is a failed poll, and the figure stands", async () => {
      const first = langfuseStub(rows(40, 40), [], { projectId: "proj-a" });
      await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: first.fetchFn,
        now: NOW,
      });
      const nameless = langfuseStub(rows(45, 45), [], { projectStatus: 503 });
      const out = await pollTenantSpend(tenantA, {
        base: appDb,
        fetchFn: nameless.fetchFn,
        now: at(1),
      });
      expect(out.status).toBe("failed");
      // Nothing was summed on a project that could not be named.
      expect(nameless.seen).toHaveLength(0);
      const row = await snapshot(tenantA, "inbox");
      expect(Number(row?.costUsd)).toBe(40);
      expect(row?.pollError).toContain("503");
      expect(row?.polledAt?.toISOString()).toBe(NOW.toISOString());
    });
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

    // The settings read sits BEFORE the poll's own try (review round 3): a pool with no free
    // connection there threw out of the handler, and five of those in a row is DEAD, the one
    // outcome this job must never reach. It is a failure like any other: log, re-arm, ask again.
    test("a settings read that fails keeps the loop alive too", async () => {
      const { fetchFn, seen } = langfuseStub({});
      const broken = appDb.$extends({
        query: {
          tenant: {
            async findUnique() {
              throw new Error("pool exhausted");
            },
          },
        },
      }) as unknown as PrismaClient;
      const result = await spendPollHandler(job(tenantA), broken, {
        fetchFn,
        now: NOW,
      });
      expect(result.outcome).toBe("reschedule");
      expect(seen).toHaveLength(0);
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
