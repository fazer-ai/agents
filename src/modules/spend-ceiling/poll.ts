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
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { claimContactAuthNotice } from "@/modules/contact-auth/state";
import { emitFlowEvent } from "@/modules/flowlog/service";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { monthStart } from "./decide";
import {
  readTenantSpendCeiling,
  SPEND_CEILING_WARN_COOLDOWN_MS,
} from "./service";

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
// selector makes. The window is the calendar month, closed at both ends, from `monthStart` to the
// instant of the poll.
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
  | { status: "failed"; error: string };

const NOT_CONFIGURED = "langfuse-not-configured";
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

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

// One metrics query: the month's generations of one environment, summed and counted per model.
// v1 endpoint, because v2 is Langfuse-cloud-only (../analytics/langfuse-costs.ts measured the 404).
async function fetchMonthCost(
  cfg: LangfuseConfig,
  environment: string,
  from: Date,
  to: Date,
  fetchFn: typeof fetch,
): Promise<MonthCost> {
  const apiBase = cfg.baseUrl ?? "https://cloud.langfuse.com";
  const query = {
    view: "observations",
    metrics: [
      { measure: "totalCost", aggregation: "sum" },
      { measure: "count", aggregation: "count" },
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
    ],
    fromTimestamp: from.toISOString(),
    toTimestamp: to.toISOString(),
    // Models, not observations: a tenant does not run a thousand distinct models in a month.
    config: { row_limit: 1000 },
  };
  const url = `${apiBase}/api/public/metrics?query=${encodeURIComponent(JSON.stringify(query))}`;
  const credentials = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString(
    "base64",
  );
  const res = await fetchFn(url, {
    headers: { Authorization: `Basic ${credentials}` },
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
    out.costUsd += cost;
    out.tracedCalls += calls;
    if (cost > 0) {
      out.costedCalls += calls;
    } else if (calls > 0) {
      const model =
        typeof row.providedModelName === "string" && row.providedModelName
          ? row.providedModelName
          : "unknown";
      out.unpricedModels.push(model);
    }
  }
  out.unpricedModels.sort();
  return out;
}

// The write, inside the tenant's own scope. Read-then-write so the figure can be kept monotonic;
// `runScopedOn` is one transaction, so the pair cannot interleave with another poll of the same row.
async function writeSuccess(
  db: ScopedDb,
  tenantId: bigint,
  source: UsageSource,
  month: Date,
  seen: MonthCost,
  at: Date,
): Promise<void> {
  const key = {
    tenantId_source_monthStart: { tenantId, source, monthStart: month },
  };
  const prev = await db.spendCostSnapshot.findUnique({ where: key });
  const costUsd = Math.max(Number(prev?.costUsd ?? 0), seen.costUsd);
  const tracedCalls = Math.max(prev?.tracedCalls ?? 0, seen.tracedCalls);
  const costedCalls = Math.max(prev?.costedCalls ?? 0, seen.costedCalls);
  await db.spendCostSnapshot.upsert({
    where: key,
    create: {
      tenantId,
      source,
      monthStart: month,
      costUsd,
      tracedCalls,
      costedCalls,
      unpricedModels: seen.unpricedModels,
      polledAt: at,
      pollError: null,
      pollFailedAt: null,
    },
    update: {
      costUsd,
      tracedCalls,
      costedCalls,
      unpricedModels: seen.unpricedModels,
      polledAt: at,
      pollError: null,
      pollFailedAt: null,
    },
  });
}

// The failure, which touches the failure pair and nothing else: the last good figure and its
// `polledAt` stay, which is what lets the gate keep deciding on a floor and the console say both.
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
  await db.spendCostSnapshot.upsert({
    where: key,
    create: {
      tenantId,
      source,
      monthStart: month,
      pollError: error,
      pollFailedAt: at,
    },
    update: { pollError: error, pollFailedAt: at },
  });
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
          await writeFailure(db, tenantId, source, month, NOT_CONFIGURED, now);
        }
      });
      return { status: NOT_CONFIGURED };
    }
    // Both sources are asked before either is written, so a failure on the second leaves neither
    // half-updated against the other's fresh figure.
    const seen = await Promise.all(
      SOURCES.map((source) =>
        fetchMonthCost(cfg, environmentForSource(source), month, now, fetchFn),
      ),
    );
    await runScopedOn(base, ctx, async (db) => {
      for (const [i, source] of SOURCES.entries()) {
        const cost = seen[i];
        if (!cost) continue;
        await writeSuccess(db, tenantId, source, month, cost, now);
      }
    });
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
  const cfg = await readTenantSpendCeiling(job.tenantId, base);
  if (!cfg.enabled) return { outcome: "done" };
  await pollTenantSpend(job.tenantId, { base, ...deps });
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + config.spendCeiling.pollIntervalMs),
  };
}

let registered = false;
export function registerSpendPollHandler(): void {
  if (registered) return;
  registerJobHandler("SPEND_CEILING_POLL", (job, base) =>
    spendPollHandler(job, base),
  );
  registered = true;
}
