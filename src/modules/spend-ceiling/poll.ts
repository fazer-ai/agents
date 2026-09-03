import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import {
  environmentForSource,
  type LangfuseConfig,
  resolveLangfuseConfig,
} from "@/graph/observability";
import type { UsageSource } from "@/graph/usage";
import { withEntityLock } from "@/lib/locks";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { claimContactAuthNotice } from "@/modules/contact-auth/state";
import { emitFlowEvent } from "@/modules/flowlog/service";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { monthStart } from "./decide";
import {
  LANGFUSE_NOT_CONFIGURED,
  readTenantSpendCeiling,
  SPEND_CEILING_WARN_COOLDOWN_MS,
} from "./service";
import type { SpendCeilingConfig } from "./settings";

// THE POLL THAT WRITES WHAT THE GATE READS (issue #426).
//
// The ceiling is denominated in dollars and the dollars come from Langfuse, which keeps the price
// table. This is deliberately not "the gate asks Langfuse": that would put a scoped transaction, a
// vault decryption and an HTTP round trip with a ten-second timeout in front of every customer
// message, and the error branch has no good answer — failing open spends without limit, which is
// what the feature prevents, and failing closed lets a third-party outage silence every agent of the
// tenant. So a job reads the month's cost per source into `spend_cost_snapshots`, and the gate reads
// the row. A Langfuse outage costs STALENESS, and staleness is a failure the row can be honest about:
// `polledAt` is the last success, `pollError` the last failure, and the two never overwrite each
// other.
//
// One query per source. The two sources are told apart on the Langfuse side by the trace's
// ENVIRONMENT (`environmentForSource`: `<env>` for inbox, `<env>-playground` for the playground),
// which is a filterable column of the metrics API and the same split the Langfuse UI's environment
// selector makes. Both queries are fenced to THE TENANT by the trace's `userId`, the tenant's slug:
// the environment is deployment-wide, and a project two tenants share would otherwise be summed
// into both months (review round 2). The window is the calendar month, closed at both ends, from
// `monthStart` to the instant of the poll.
//
// THE FIGURE IS MONOTONIC INSIDE A MONTH. Langfuse ingests asynchronously and the lag correlates
// with load, so during the burst the ceiling exists for a total can read LOWER than the last one: a
// burst that has not landed yet is money never spent. A lower answer is therefore not written over
// a higher one, and the counts follow the same rule. The cost that buys is one-sided and bounded by
// the lag: the figure catches up on the next poll, and never runs ahead.
//
// THE RECONCILIATION SHIPS WITH IT. Langfuse prices a model it does not know at ZERO, silently, so a
// tenant on OpenRouter or a self-hosted endpoint would get a ceiling that never trips — worse than
// none, because the screen says it is enforcing. The same query groups by model and counts, so a
// model with calls and no cost is named on the row (`unpricedModels`), and the console compares
// what Langfuse costed against what the local ledger recorded.

export interface PollDeps {
  base?: PrismaClient;
  fetchFn?: typeof fetch;
  // Injectable clock: the month, the window's upper edge and `polledAt` all come from it.
  now?: Date;
}

export type PollOutcome =
  | { status: "polled" }
  // The tenant has no usable Langfuse: nothing to ask, and the row says so.
  | { status: "langfuse-not-configured" }
  // The credential changed while this poll was out asking: the answer belongs to a configuration
  // that no longer exists, and is dropped rather than written (review round 9).
  | { status: "superseded" }
  | { status: "failed"; error: string };

const SOURCES: UsageSource[] = ["inbox", "playground"];

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

interface MonthCost {
  costUsd: number;
  tracedCalls: number;
  costedCalls: number;
  unpricedModels: string[];
}

function asStringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((m): m is string => typeof m === "string")
    : [];
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function sameCredential(a: LangfuseConfig, b: LangfuseConfig): boolean {
  return (
    a.publicKey === b.publicKey &&
    a.secretKey === b.secretKey &&
    (a.baseUrl ?? null) === (b.baseUrl ?? null)
  );
}

function apiBaseOf(cfg: LangfuseConfig): string {
  return cfg.baseUrl ?? "https://cloud.langfuse.com";
}

function authOf(cfg: LangfuseConfig): string {
  return `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`;
}

// WHICH PROJECT THE FIGURE BELONGS TO (review round 3). A tenant that points its Langfuse at another
// project mid-month starts a new series there, and the monotonic floor below would then sit on the
// old project's last figure while the new one climbed from zero underneath it: $40 there plus $20
// here is a $40 row. The identity is the project's id as Langfuse names it (one GET per poll, on
// the same credential), keyed under the instance, never the credential: a key rotated inside a
// project is the same project, and carrying the figure over a rotation would count the month
// twice. A project that cannot be named fails the poll; nothing is summed on it.
async function fetchProjectKey(
  cfg: LangfuseConfig,
  fetchFn: typeof fetch,
): Promise<string> {
  const apiBase = apiBaseOf(cfg);
  const res = await fetchFn(`${apiBase}/api/public/projects`, {
    headers: { Authorization: authOf(cfg) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Langfuse projects API responded with ${res.status}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const id = body.data?.[0]?.id;
  if (typeof id !== "string" || id === "") {
    throw new Error("Langfuse projects response names no project");
  }
  return `${apiBase}#${id}`;
}

// One metrics query: the month's generations of one environment AND one tenant, summed and counted
// per model. v1 endpoint, because v2 is Langfuse-cloud-only (../analytics/langfuse-costs.ts
// measured the 404).
//
// The tenant filter is the trace's `userId`, which every trace of ours carries as the tenant's slug
// (review round 2). The environment is deployment-wide, not per tenant: two tenants may point at one
// Langfuse project, and a project may carry another generator's traces in the same environment,
// and either would be summed into this tenant's month and refuse its customers over someone
// else's spend. Measured on the observations view: `userId` is a filterable column there, joined
// from the trace.
async function fetchMonthCost(
  cfg: LangfuseConfig,
  tenantSlug: string,
  environment: string,
  from: Date,
  to: Date,
  fetchFn: typeof fetch,
): Promise<MonthCost> {
  const query = {
    view: "observations",
    metrics: [
      { measure: "totalCost", aggregation: "sum" },
      { measure: "count", aggregation: "count" },
      // `avg` skips NULL where `count` does not: see the loop below.
      { measure: "totalCost", aggregation: "avg" },
    ],
    dimensions: [{ field: "providedModelName" }],
    filters: [
      {
        column: "environment",
        operator: "=",
        value: environment,
        type: "string",
      },
      { column: "type", operator: "=", value: "GENERATION", type: "string" },
      { column: "userId", operator: "=", value: tenantSlug, type: "string" },
    ],
    fromTimestamp: from.toISOString(),
    toTimestamp: to.toISOString(),
    // Models, not observations: a tenant does not run a thousand distinct models in a month.
    config: { row_limit: 1000 },
  };
  const url = `${apiBaseOf(cfg)}/api/public/metrics?query=${encodeURIComponent(JSON.stringify(query))}`;
  const res = await fetchFn(url, {
    headers: { Authorization: authOf(cfg) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Langfuse metrics API responded with ${res.status}`);
  }
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error("Langfuse metrics response missing data array");
  }
  const out: MonthCost = {
    costUsd: 0,
    tracedCalls: 0,
    costedCalls: 0,
    unpricedModels: [],
  };
  for (const row of body.data as Record<string, unknown>[]) {
    const cost = num(row.sum_totalCost);
    const calls = Math.round(num(row.count_count ?? row.count));
    // HOW MANY OF THE GROUP CARRIED A PRICE (review round 4). A group is priced per generation, not
    // per model: a price added mid-month leaves the earlier calls at NULL (Langfuse does not
    // re-price, measured on v3.225.7), and a call with no usage block is NULL under a priced
    // model. The metrics API cannot filter on a measure, but `avg` skips NULL where `count` does
    // not, so sum / avg is the number of generations that carried a cost. A group priced at zero
    // has no avg to divide by and counts as unpriced, which is what a zero price means to a
    // ceiling.
    const avg = num(row.avg_totalCost);
    const priced = avg > 0 ? Math.min(calls, Math.round(cost / avg)) : 0;
    out.costUsd += cost;
    out.tracedCalls += calls;
    out.costedCalls += priced;
    if (calls > priced) {
      const model =
        typeof row.providedModelName === "string" && row.providedModelName
          ? row.providedModelName
          : "unknown";
      out.unpricedModels.push(model);
    }
  }
  out.unpricedModels = union(out.unpricedModels, []);
  return out;
}

// The write, inside the tenant's own scope. Read-then-write so the figure can be kept monotonic,
// UNDER THE ROW'S ADVISORY LOCK (review round 5): `runScopedOn` is one transaction, but two polls
// of the same tenant can run at once (a save re-arms the job, which resets a CLAIMED row to
// PENDING, and the next tick claims it while the first run is still inside its write), and two
// transactions that each read the previous figure and each write their own would let the lower
// answer land last. The lock is taken before the read, so the second poll reads what the first
// committed. The lock and the transaction end together.
//
// The figure is the CARRY plus the current project's own total. The carry is what the row stood at
// the moment the project changed (taken once, at the switch, all three counters), and stays on the
// row for the rest of the month; a row that never switched carries zero, and a row first written
// by a failure (no project yet) starts the series without one. The floor is still taken against
// the previous figure, so a switch never lowers the row and a lower answer inside one series is
// still not written over a higher one.
async function writeSuccess(
  db: ScopedDb,
  tenantId: bigint,
  source: UsageSource,
  month: Date,
  seen: MonthCost,
  at: Date,
  projectKey: string,
): Promise<void> {
  await withEntityLock(
    db,
    snapshotLockKey(tenantId, source, month),
    async () => {
      const key = {
        tenantId_source_monthStart: { tenantId, source, monthStart: month },
      };
      const prev = await db.spendCostSnapshot.findUnique({ where: key });
      const switched =
        prev !== null &&
        prev.projectKey !== null &&
        prev.projectKey !== projectKey;
      const carried = switched
        ? {
            usd: Number(prev.costUsd),
            traced: prev.tracedCalls,
            costed: prev.costedCalls,
            // The names travel with the figure (review round 4): the old project is never asked again,
            // so a model it could not price would otherwise vanish from the screen while its calls
            // stay in the carried counters.
            unpriced: union(
              asStringList(prev.carriedUnpricedModels),
              asStringList(prev.unpricedModels),
            ),
          }
        : {
            usd: Number(prev?.carriedUsd ?? 0),
            traced: prev?.carriedTracedCalls ?? 0,
            costed: prev?.carriedCostedCalls ?? 0,
            unpriced: asStringList(prev?.carriedUnpricedModels),
          };
      const costUsd = Math.max(
        Number(prev?.costUsd ?? 0),
        carried.usd + seen.costUsd,
      );
      const tracedCalls = Math.max(
        prev?.tracedCalls ?? 0,
        carried.traced + seen.tracedCalls,
      );
      const costedCalls = Math.max(
        prev?.costedCalls ?? 0,
        carried.costed + seen.costedCalls,
      );
      // A partial answer keeps the names too (review round 6): the counters above stand on the
      // previous figure when the answer is behind it, and a list re-read from that answer would
      // drop a model whose calls are still counted. At or past the row, the answer is whole and
      // the list is re-read, so a model priced since drops off.
      const behind =
        prev !== null &&
        !switched &&
        carried.traced + seen.tracedCalls < prev.tracedCalls;
      const figure = {
        costUsd,
        tracedCalls,
        costedCalls,
        unpricedModels: union(
          behind ? asStringList(prev?.unpricedModels) : carried.unpriced,
          seen.unpricedModels,
        ),
        projectKey,
        carriedUsd: carried.usd,
        carriedTracedCalls: carried.traced,
        carriedCostedCalls: carried.costed,
        carriedUnpricedModels: carried.unpriced,
        polledAt: at,
        pollError: null,
        pollFailedAt: null,
      };
      await db.spendCostSnapshot.upsert({
        where: key,
        create: { tenantId, source, monthStart: month, ...figure },
        update: figure,
      });
    },
  );
}

function snapshotLockKey(tenantId: bigint, source: UsageSource, month: Date) {
  return `spend-snapshot:${tenantId}:${source}:${month.toISOString()}`;
}

// The failure, which touches the failure pair and nothing else: the last good figure and its
// `polledAt` stay, which is what lets the gate keep deciding on a floor and the console say both.
// `pollFailedAt` is the instant the CURRENT streak began (review round 5): the console says
// "failing since", so a failure on top of a failure keeps the first one's instant, and a success,
// which clears the pair, is what lets the next failure start a new streak. Same lock as the
// success write, for the same reason.
async function writeFailure(
  db: ScopedDb,
  tenantId: bigint,
  source: UsageSource,
  month: Date,
  error: string,
  at: Date,
): Promise<void> {
  const key = {
    tenantId_source_monthStart: { tenantId, source, monthStart: month },
  };
  await withEntityLock(
    db,
    snapshotLockKey(tenantId, source, month),
    async () => {
      const prev = await db.spendCostSnapshot.findUnique({
        where: key,
        select: { pollFailedAt: true },
      });
      const pollFailedAt = prev?.pollFailedAt ?? at;
      await db.spendCostSnapshot.upsert({
        where: key,
        create: {
          tenantId,
          source,
          monthStart: month,
          pollError: error,
          pollFailedAt,
        },
        update: { pollError: error, pollFailedAt },
      });
    },
  );
}

// The operator hears about a failing poll ONCE per window (the warning's own six hours), not once
// per poll: a Langfuse down for an afternoon would otherwise page the channels every five minutes
// about one unchanging fact. In-process, like every other notice claim here.
function announcePollFailure(
  tenantId: bigint,
  error: string,
  base: PrismaClient,
): void {
  if (
    !claimContactAuthNotice(
      `spend_ceiling_poll_failed:${tenantId}`,
      SPEND_CEILING_WARN_COOLDOWN_MS,
    )
  ) {
    return;
  }
  emitFlowEvent(
    { tenantId, turnId: randomUUID(), source: "inbox", base },
    {
      stage: "spend_ceiling",
      level: "warn",
      status: "error",
      detail: { pollError: error, subject: "poll" },
      errorMessage: `spend ceiling: the month's cost could not be read from Langfuse (${error}); the last figure stands`,
    },
  );
}

// Reads the month's cost for both sources into the snapshot. Never throws: every outcome is on the
// row, and the caller (the job) has nothing to do with an exception but die.
export async function pollTenantSpend(
  tenantId: bigint,
  deps: PollDeps = {},
): Promise<PollOutcome> {
  const base = deps.base ?? basePrisma;
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? new Date();
  const month = monthStart(now);
  const ctx = sysCtx(tenantId);
  try {
    const cfg = await runScopedOn(base, ctx, (db) =>
      resolveLangfuseConfig(db, tenantId),
    );
    if (!cfg) {
      await runScopedOn(base, ctx, async (db) => {
        for (const source of SOURCES) {
          await writeFailure(
            db,
            tenantId,
            source,
            month,
            LANGFUSE_NOT_CONFIGURED,
            now,
          );
        }
      });
      return { status: LANGFUSE_NOT_CONFIGURED };
    }
    // No slug, no query: the project's total is not this tenant's, and a poll that cannot say whose
    // the figure is records a failure rather than a number. Unreachable in practice (the slug is a
    // NOT NULL column and the tenant's own row is readable here); the fence is for the day that
    // changes.
    if (!cfg.tenantSlug) {
      throw new Error("the tenant has no slug to scope the Langfuse query by");
    }
    const projectKey = await fetchProjectKey(cfg, fetchFn);
    // Both sources are asked before either is written, so a failure on the second leaves neither
    // half-updated against the other's fresh figure.
    const seen = await Promise.all(
      SOURCES.map((source) =>
        fetchMonthCost(
          cfg,
          cfg.tenantSlug as string,
          environmentForSource(source),
          month,
          now,
          fetchFn,
        ),
      ),
    );
    // THE ANSWER IS TIED TO THE CREDENTIAL IT WAS ASKED WITH (review round 9). A save re-arms the
    // job, so a poll asked under the old credential can land AFTER the one asked under the new:
    // its row read would see the new project on the row, take that for a switch, carry the
    // combined figure and add the old project's total on top of it, and the next poll would do
    // the same the other way. The lock serializes the writes; this is what refuses the obsolete
    // one. Asked inside the write's own transaction, so nothing can change between the check and
    // the row.
    const written = await runScopedOn(base, ctx, async (db) => {
      const current = await resolveLangfuseConfig(db, tenantId);
      if (!current || !sameCredential(current, cfg)) return false;
      for (const [i, source] of SOURCES.entries()) {
        const cost = seen[i];
        if (!cost) continue;
        await writeSuccess(db, tenantId, source, month, cost, now, projectKey);
      }
      return true;
    });
    if (!written) {
      logger.info(
        { tenantId: String(tenantId) },
        "spend ceiling poll: the credential changed while asking; the answer was dropped",
      );
      return { status: "superseded" };
    }
    return { status: "polled" };
  } catch (err) {
    // What Langfuse answered is not ours to store as it came: a parse error quotes the body, and a
    // NUL or an unpaired surrogate in it is a string Postgres refuses, which would turn the one
    // write that records the failure into a failure of its own (review round 1).
    const error = sanitizeErrorMessage(err);
    logger.warn(
      { err, tenantId: String(tenantId) },
      "spend ceiling poll failed; the last figure stands",
    );
    try {
      await runScopedOn(base, ctx, async (db) => {
        for (const source of SOURCES) {
          await writeFailure(db, tenantId, source, month, error, now);
        }
      });
    } catch (writeErr) {
      logger.warn(
        { err: writeErr, tenantId: String(tenantId) },
        "spend ceiling poll: the failure itself could not be recorded",
      );
    }
    announcePollFailure(tenantId, error, base);
    return { status: "failed", error };
  }
}

// The job. A tenant whose ceiling is off ends the loop (the arm side re-creates it on the next
// save); everyone else polls and re-arms at the configured cadence. It never throws, so the
// scheduler's ladder never reaches DEAD over a Langfuse that is down for an hour: `JOB_DEATH_LEVEL`
// says a death here is an error precisely because it would mean the ceiling silently froze.
export async function spendPollHandler(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
  deps: Omit<PollDeps, "base"> = {},
): Promise<JobResult> {
  const rearm = (): JobResult => ({
    outcome: "reschedule",
    runAt: new Date(Date.now() + config.spendCeiling.pollIntervalMs),
  });
  // The settings read is a failure like any other (review round 3): it sits before the poll's own
  // try, and a pool with no free connection here would otherwise throw out of the handler and walk
  // the ladder. Re-arm and ask again next period; "done" is reserved for a ceiling READ as off.
  let cfg: SpendCeilingConfig;
  try {
    cfg = await readTenantSpendCeiling(job.tenantId, base);
  } catch (err) {
    logger.warn(
      { err, tenantId: String(job.tenantId) },
      "spend ceiling poll: the ceiling could not be read; asking again next period",
    );
    return rearm();
  }
  if (!cfg.enabled) return { outcome: "done" };
  await pollTenantSpend(job.tenantId, { base, ...deps });
  return rearm();
}

let registered = false;
export function registerSpendPollHandler(): void {
  if (registered) return;
  registerJobHandler("SPEND_CEILING_POLL", (job, base) =>
    spendPollHandler(job, base),
  );
  registered = true;
}
