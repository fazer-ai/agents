import { createHash, randomUUID } from "node:crypto";
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

// THE POLL THAT WRITES WHAT THE GATE READS. A job reads the month's cost per source from Langfuse
// into `spend_cost_snapshots`, and the gate reads the row, so a Langfuse outage costs staleness
// instead of blocking or unbounding every message. Fenced by environment (source) and by the trace's
// `userId` (tenant); the figure is monotonic inside a month, and unpriced models are named on the
// row. The full design is in docs/spend-ceiling.md.

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
  // that no longer exists, and is dropped rather than written.
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

// THE IDENTITY IS OPAQUE: a self-hosted base URL may carry userinfo or a secret path, and the key
// lands on every row and in the switch announcement unredacted. So the key is a hash of the instance
// and the project id; what is shown is the origin alone.
export function projectKeyOf(apiBase: string, id: string): string {
  return createHash("sha256")
    .update(`${apiBase}#${id}`)
    .digest("hex")
    .slice(0, 32);
}

function originOf(apiBase: string): string {
  try {
    return new URL(apiBase).origin;
  } catch {
    return "unknown";
  }
}

function apiBaseOf(cfg: LangfuseConfig): string {
  return cfg.baseUrl ?? "https://cloud.langfuse.com";
}

function authOf(cfg: LangfuseConfig): string {
  return `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`;
}

// WHICH PROJECT THE FIGURE BELONGS TO, so a mid-month project switch carries the old figure instead
// of flooring the new series under it. Keyed on the instance and Langfuse's project id, never the
// credential: a key rotated inside a project is the same project. A project that cannot be named
// fails the poll.
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
  return projectKeyOf(apiBase, id);
}

// One metrics query: the month's generations of one environment AND one tenant, summed and counted
// per model. v1 endpoint, because v2 is Langfuse-cloud-only. The tenant filter is the trace's
// `userId` (the tenant's slug): the environment is deployment-wide and a project may be shared, so
// without it another tenant's spend would count here.
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
    // NOTE: How many of the group carried a price: a price added mid-month leaves earlier calls NULL
    // (Langfuse does not re-price), and a call with no usage block is NULL too. `avg` skips NULL
    // where `count` does not, so sum / avg is the priced count; a zero price counts as unpriced.
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

// The write, read-then-write so the figure stays monotonic, UNDER THE ROW'S ADVISORY LOCK: two
// polls of one tenant can overlap (a save re-arms the job), and without the lock the lower answer
// could land last. The figure is the CARRY (the row at the last project switch, zero if none) plus
// the current project's total, still floored against the previous figure.
async function writeSuccess(
  db: ScopedDb,
  tenantId: bigint,
  source: UsageSource,
  month: Date,
  seen: MonthCost,
  at: Date,
  projectKey: string,
): Promise<{ switched: boolean }> {
  return withEntityLock(
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
            // NOTE: The names travel with the figure: the old project is never asked again, so an
            // unpriced model would otherwise vanish while its calls stay in the carried counters.
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
      // NOTE: A partial answer (behind the row) keeps the names too, since its counters stand on the
      // previous figure. At or past the row the answer is whole, so a model priced since drops off.
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
        // NOTE: The row's health never moves backwards: an older poll succeeding after a newer one
        // failed keeps that failure and the later `polledAt`, though its figure still lands as a
        // floor. "Newer" is against the LATEST failure (`pollLastFailedAt`), not the streak's start.
        polledAt: prev?.polledAt && prev.polledAt > at ? prev.polledAt : at,
        ...(prev?.pollLastFailedAt && prev.pollLastFailedAt > at
          ? {
              pollError: prev.pollError,
              pollFailedAt: prev.pollFailedAt,
              pollLastFailedAt: prev.pollLastFailedAt,
            }
          : { pollError: null, pollFailedAt: null, pollLastFailedAt: null }),
      };
      await db.spendCostSnapshot.upsert({
        where: key,
        create: { tenantId, source, monthStart: month, ...figure },
        update: figure,
      });
      return { switched };
    },
  );
}

function monthLockKey(tenantId: bigint, month: Date) {
  return `spend-snapshot:${tenantId}:${month.toISOString()}`;
}

function snapshotLockKey(tenantId: bigint, source: UsageSource, month: Date) {
  return `spend-snapshot:${tenantId}:${source}:${month.toISOString()}`;
}

// The failure, which touches the failure pair only: the last good figure and its `polledAt` stay, so
// the gate decides on a floor. `pollFailedAt` is when the CURRENT streak began ("failing since");
// `pollLastFailedAt` is the latest attempt, which an older poll is measured against. Same lock as
// the success write.
async function writeFailure(
  db: ScopedDb,
  tenantId: bigint,
  source: UsageSource,
  month: Date,
  error: string,
  at: Date,
): Promise<boolean> {
  const key = {
    tenantId_source_monthStart: { tenantId, source, monthStart: month },
  };
  return withEntityLock(
    db,
    snapshotLockKey(tenantId, source, month),
    async () => {
      const prev = await db.spendCostSnapshot.findUnique({
        where: key,
        select: { pollFailedAt: true, pollLastFailedAt: true, polledAt: true },
      });
      // NOTE: A failure older than the row's last success, or than its newest failure, is not the
      // row's present: an older overlapping poll finishing last would otherwise overwrite a fresher
      // figure or sentinel. `at` is the instant the poll began.
      if (
        (prev?.polledAt && prev.polledAt > at) ||
        (prev?.pollLastFailedAt && prev.pollLastFailedAt > at)
      ) {
        return false;
      }
      const pollFailedAt = prev?.pollFailedAt ?? at;
      await db.spendCostSnapshot.upsert({
        where: key,
        create: {
          tenantId,
          source,
          monthStart: month,
          pollError: error,
          pollFailedAt,
          pollLastFailedAt: at,
        },
        update: { pollError: error, pollFailedAt, pollLastFailedAt: at },
      });
      return true;
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

// A SWITCH IS ANNOUNCED: spend that reached the old project after its last reading is not counted,
// in the under-refusing direction, and only the operator can act on that (by switching after a
// quiet period). Once per switch.
function announceProjectSwitch(
  tenantId: bigint,
  apiBase: string,
  base: PrismaClient,
): void {
  emitFlowEvent(
    { tenantId, turnId: randomUUID(), source: "inbox", base },
    {
      stage: "spend_ceiling",
      level: "warn",
      status: "ok",
      detail: { subject: "project", projectOrigin: originOf(apiBase) },
      errorMessage:
        "spend ceiling: the Langfuse project changed mid-month; what the old project stood at is carried, and spend that reached it after its last reading is not counted",
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
  // NOTE: Held outside the try so the failure path can ask whether the credential it failed under is
  // still the tenant's. `undefined` means the poll never got to resolve one.
  let cfg: LangfuseConfig | null | undefined;
  try {
    cfg = await runScopedOn(base, ctx, (db) =>
      resolveLangfuseConfig(db, tenantId),
    );
    if (!cfg) {
      // NOTE: Rechecked under the month's lock: a credential added while this poll was out would
      // otherwise get the sentinel written over it. A Langfuse save re-arms the poll.
      const wrote = await runScopedOn(base, ctx, (db) =>
        withEntityLock(db, monthLockKey(tenantId, month), async () => {
          if ((await resolveLangfuseConfig(db, tenantId)) !== null)
            return false;
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
          return true;
        }),
      );
      return wrote
        ? { status: LANGFUSE_NOT_CONFIGURED }
        : { status: "superseded" };
    }
    // Narrowed once for the closures below, which TypeScript would not narrow through.
    const resolved: LangfuseConfig = cfg;
    // No slug, no query: the project's total is not this tenant's, and a poll that cannot say whose
    // the figure is records a failure rather than a number. Unreachable in practice (the slug is a
    // NOT NULL column and the tenant's own row is readable here); the fence is for the day that
    // changes.
    if (!resolved.tenantSlug) {
      throw new Error("the tenant has no slug to scope the Langfuse query by");
    }
    const projectKey = await fetchProjectKey(resolved, fetchFn);
    // Both sources are asked before either is written, so a failure on the second leaves neither
    // half-updated against the other's fresh figure.
    const seen = await Promise.all(
      SOURCES.map((source) =>
        fetchMonthCost(
          resolved,
          resolved.tenantSlug as string,
          environmentForSource(source),
          month,
          now,
          fetchFn,
        ),
      ),
    );
    // NOTE: THE ANSWER IS TIED TO THE CREDENTIAL IT WAS ASKED WITH. A poll under an old credential
    // can land after one under the new, and would read the new project as a switch and double count.
    // The check and the write share the month's lock and transaction, so they cannot interleave.
    const written = await runScopedOn(base, ctx, (db) =>
      withEntityLock(db, monthLockKey(tenantId, month), async () => {
        const current = await resolveLangfuseConfig(db, tenantId);
        if (!current || !sameCredential(current, resolved)) return null;
        let switched = false;
        for (const [i, source] of SOURCES.entries()) {
          const cost = seen[i];
          if (!cost) continue;
          const r = await writeSuccess(
            db,
            tenantId,
            source,
            month,
            cost,
            now,
            projectKey,
          );
          if (r.switched) switched = true;
        }
        return { switched };
      }),
    );
    if (written === null) {
      logger.info(
        { tenantId: String(tenantId) },
        "spend ceiling poll: the credential changed while asking; the answer was dropped",
      );
      return { status: "superseded" };
    }
    if (written.switched) {
      announceProjectSwitch(tenantId, apiBaseOf(resolved), base);
    }
    return { status: "polled" };
  } catch (err) {
    // NOTE: A parse error may quote Langfuse's body, and a NUL or unpaired surrogate in it would make
    // Postgres refuse the very write that records the failure.
    const error = sanitizeErrorMessage(err);
    // NOTE: The sanitized message, not the error: Bun's network errors carry the request URL,
    // userinfo and all, in an enumerable `path` that pino would copy into the log.
    logger.warn(
      { error, tenantId: String(tenantId) },
      "spend ceiling poll failed; the last figure stands",
    );
    // NOTE: Announced only when it was the row's present (a stale failure would page about a window
    // already recovered); an unknown write outcome is announced. Under the month's lock the failure
    // is re-read against the credential now: gone means not-configured, rotated means dropped, the
    // same means the failure stands; a poll with no resolved credential records it as is.
    const asked = cfg;
    let outcome: "failed" | "superseded" | typeof LANGFUSE_NOT_CONFIGURED =
      "failed";
    let current = true;
    try {
      current = await runScopedOn(base, ctx, (db) =>
        withEntityLock(db, monthLockKey(tenantId, month), async () => {
          const present =
            asked === undefined
              ? undefined
              : await resolveLangfuseConfig(db, tenantId);
          if (present === null) {
            outcome = LANGFUSE_NOT_CONFIGURED;
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
            return false;
          }
          if (
            present !== undefined &&
            asked &&
            !sameCredential(present, asked)
          ) {
            outcome = "superseded";
            return false;
          }
          let applied = false;
          for (const source of SOURCES) {
            if (await writeFailure(db, tenantId, source, month, error, now)) {
              applied = true;
            }
          }
          return applied;
        }),
      );
    } catch (writeErr) {
      logger.warn(
        { err: writeErr, tenantId: String(tenantId) },
        "spend ceiling poll: the failure itself could not be recorded",
      );
    }
    if (current) announcePollFailure(tenantId, error, base);
    if (outcome === "failed") return { status: "failed", error };
    return { status: outcome };
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
  // NOTE: The settings read is a failure like any other: it sits before the poll's own try, so it
  // re-arms and asks again next period. "done" is reserved for a ceiling READ as off.
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
