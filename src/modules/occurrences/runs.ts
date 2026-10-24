import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError } from "@/lib/errors";
import { intRange } from "@/lib/number-range";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { OCCURRENCE_STEPS, type OccurrenceStep } from "./settings";

// The monitor's recent rounds, newest first, for the console, REST and MCP: when each ran, how long
// it took, what it read, what each step did and what its model calls cost.

export const RUNS_LIMIT_RANGE = intRange(1, 200);

// Why a step did not complete, as the round stored it ("<step>: <reason>", folded as " (Nx)"), as a
// code a screen says in its own language: the reasons the monitor writes itself by their phrase, and
// a provider's error by what it most likely means (a refused key, an unknown model, a timeout, an
// endpoint that does not answer). `error` is what none of those matched.
export type SkipReason =
  | "no_model"
  | "spend_ceiling"
  | "round_budget"
  | "unreadable_answer"
  | "credential_unresolved"
  | "credential_not_key"
  | "endpoint_missing"
  | "endpoint_not_taken"
  | "inbox_unreceived"
  | "inbox_unlisted"
  | "credential_refused"
  | "model_refused"
  | "rate_limited"
  | "timeout"
  | "endpoint_unreachable"
  | "error";

export interface SkippedStep {
  step: OccurrenceStep | null;
  reason: SkipReason;
  // The stored text, for any reason not written by the monitor in a fixed phrase: a provider's error
  // keeps its own words for whoever needs the detail.
  message: string | null;
  // The inbox the reason names, for `inbox_unreceived` (rounds before the sweep) and `inbox_unlisted`.
  inbox: string | null;
  count: number;
}

// What each step of the round did; a step the round never reached (it failed first, or the
// consolidation was not due) is null.
export interface RunSteps {
  reading: {
    read: number;
    failed: number;
    withdrawn: number;
    pending: number;
  } | null;
  canonical: { asked: number; created: number; copied: number } | null;
  assignment: {
    sent: number;
    assigned: number;
    newThemes: number;
    removed: number;
  } | null;
  consolidation: {
    merges: number;
    splits: number;
    renames: number;
    referenceMerges: number;
    completed: boolean;
  } | null;
  flags: { flagged: number } | null;
  skipped: SkippedStep[];
}

export interface OccurrenceRunView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: string;
  readings: number;
  modelCalls: number;
  // The calls with no price, which `costUsd` leaves out; null cost with calls means none had one.
  unpricedCalls: number;
  costUsd: number | null;
  error: string | null;
  steps: RunSteps;
}

export interface OccurrenceRunsPage {
  runs: OccurrenceRunView[];
  // Every round the account has, whatever page this is.
  total: number;
  // Pass back as `before` for the next (older) page; null on the last one.
  nextBefore: string | null;
}

// The thread a round's model calls carry in the usage ledger.
export function runThreadId(tenantId: bigint, runId: bigint): string {
  return `occurrences:${tenantId}:${runId}`;
}

const FIXED_REASONS: Record<string, SkipReason> = {
  "no model is set": "no_model",
  "no model id": "no_model",
  "spend ceiling": "spend_ceiling",
  "round budget": "round_budget",
  "unreadable answer": "unreadable_answer",
  "the credential does not resolve": "credential_unresolved",
  "an openai-compatible model needs an endpoint": "endpoint_missing",
  "endpoint unreachable": "endpoint_unreachable",
};

// The monitor's own phrases with a part that varies (model.ts, resolveMonitorModel; reading.ts).
const PATTERN_REASONS: [RegExp, SkipReason][] = [
  [/^the credential \(.*\) is not an API key$/s, "credential_not_key"],
  [/^a .+ model does not take an endpoint$/s, "endpoint_not_taken"],
  [
    /^the credential carries an endpoint a .+ model does not take$/s,
    "endpoint_not_taken",
  ],
];

// A provider's error, by its most likely meaning. What crosses the provider boundary is a closed
// vocabulary ("timeout", "HTTP <nnn>", "provider error"); the free-text patterns after it read rows
// stored before that boundary or errors raised before the call. Checked in order: a 401 that
// mentions a model is still a refused key.
const ERROR_REASONS: [RegExp, SkipReason][] = [
  [/^HTTP 429$/, "rate_limited"],
  [/^HTTP 40[13]$/, "credential_refused"],
  [/^HTTP 404$/, "model_refused"],
  [/^HTTP (408|504)$|^timeout$/, "timeout"],
  [/\b429\b|rate.?limit|too many requests|quota/i, "rate_limited"],
  [
    /\b40[13]\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api.?)?key|incorrect api key|authentication/i,
    "credential_refused",
  ],
  [
    /model.{0,80}(not found|does not exist|unknown|not supported|unsupported|not available)|no such model|unknown model|invalid model/i,
    "model_refused",
  ],
  [/timed? ?out|timeout|ETIMEDOUT|deadline exceeded/i, "timeout"],
  [
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|getaddrinfo|socket hang up|connection (refused|error|reset)|unable to connect/i,
    "endpoint_unreachable",
  ],
];

// Written by the rounds before the sweep (./sweep.ts), when an inbox no agent received was not read.
const UNRECEIVED_INBOX = /^no agent receives the inbox "(.*)"$/s;
// The sweep could not list an inbox's conversations: the round read what was already queued for it.
const UNLISTED_INBOX =
  /^the conversations of the inbox "(.*)" could not be listed from Chatwoot$/s;

export function parseSkipped(line: string): SkippedStep {
  const folded = /^(.*) \((\d+)x\)$/s.exec(line);
  const text = folded?.[1] ?? line;
  const count = folded ? Number(folded[2]) : 1;
  const at = text.indexOf(": ");
  const head = at < 0 ? "" : text.slice(0, at);
  const step = (OCCURRENCE_STEPS as readonly string[]).includes(head)
    ? (head as OccurrenceStep)
    : null;
  const rest = step === null ? text : text.slice(at + 2);
  const fixed = FIXED_REASONS[rest];
  if (fixed) return { step, reason: fixed, message: null, inbox: null, count };
  const inbox = UNRECEIVED_INBOX.exec(rest);
  if (inbox)
    return {
      step,
      reason: "inbox_unreceived",
      message: null,
      inbox: inbox[1] ?? "",
      count,
    };
  const unlisted = UNLISTED_INBOX.exec(rest);
  if (unlisted)
    return {
      step,
      reason: "inbox_unlisted",
      message: null,
      inbox: unlisted[1] ?? "",
      count,
    };
  const reason =
    PATTERN_REASONS.find(([re]) => re.test(rest))?.[1] ??
    ERROR_REASONS.find(([re]) => re.test(rest))?.[1] ??
    "error";
  return { step, reason, message: rest, inbox: null, count };
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const num = (o: Record<string, unknown>, k: string) =>
  typeof o[k] === "number" ? (o[k] as number) : 0;

export function runSteps(detail: Record<string, unknown>): RunSteps {
  const reading = obj(detail.reading);
  const canonical = obj(detail.canonical);
  const assignment = obj(detail.assignment);
  const consolidation = obj(detail.consolidation);
  const merges = obj(detail.canonicalMerges);
  const flags = obj(detail.flags);
  return {
    reading: reading && {
      read: num(reading, "read"),
      failed: num(reading, "failed"),
      withdrawn: num(reading, "withdrawn"),
      pending: num(reading, "pending"),
    },
    canonical: canonical && {
      asked: num(canonical, "asked"),
      created: num(canonical, "created"),
      copied: num(canonical, "copied"),
    },
    assignment: assignment && {
      sent: num(assignment, "sent"),
      assigned: num(assignment, "assigned"),
      newThemes: num(assignment, "newThemes"),
      removed: num(assignment, "removed"),
    },
    consolidation: consolidation && {
      merges: num(consolidation, "merges"),
      splits: num(consolidation, "splits"),
      renames: num(consolidation, "renames"),
      referenceMerges: merges ? num(merges, "merges") : 0,
      completed:
        consolidation.completed === true &&
        (merges === null || merges.completed === true),
    },
    flags: flags && { flagged: num(flags, "flagged") },
    skipped: Array.isArray(detail.skipped)
      ? detail.skipped
          .filter((l): l is string => typeof l === "string")
          .map(parseSkipped)
      : [],
  };
}

// A page of rounds, newest first. `before` is the last round of the previous page: keyed on the
// round itself rather than on a position, so a round that starts while the operator reads page one
// never pushes a row of page one onto page two.
export async function pageOccurrenceRuns(
  ctx: TenantContext,
  monitorId: bigint,
  opts: { limit?: number; before?: string | null } = {},
  base: PrismaClient = basePrisma,
): Promise<OccurrenceRunsPage> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? 20)),
    RUNS_LIMIT_RANGE.max,
  );
  const before = opts.before ? parseDbId(opts.before) : null;
  if (opts.before && before === null)
    throw new AppError(
      "The value sent in before is not valid.",
      422,
      "errors.invalidRequestValue",
      { field: "before" },
      "before",
    );
  const { rows, total } = await runScopedOn(base, ctx, async (db) => {
    const anchor =
      before === null
        ? null
        : await db.occurrenceRun.findFirst({
            where: { id: before, monitorId },
            select: { id: true, startedAt: true },
          });
    const rows = await db.occurrenceRun.findMany({
      where: {
        monitorId,
        ...(anchor
          ? {
              OR: [
                { startedAt: { lt: anchor.startedAt } },
                { startedAt: anchor.startedAt, id: { lt: anchor.id } },
              ],
            }
          : before !== null
            ? // A cursor naming no round of this monitor has nothing after it.
              { id: { in: [] } }
            : {}),
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const total = await db.occurrenceRun.count({ where: { monitorId } });
    return { rows, total };
  });
  const page = rows.slice(0, limit);
  return {
    runs: await viewsOf(base, ctx, tenantId, page),
    total,
    nextBefore:
      rows.length > limit ? String(page[page.length - 1]?.id ?? "") : null,
  };
}

export async function listOccurrenceRuns(
  ctx: TenantContext,
  monitorId: bigint,
  limit = 20,
  base: PrismaClient = basePrisma,
): Promise<OccurrenceRunView[]> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  return (await pageOccurrenceRuns(ctx, monitorId, { limit }, base)).runs;
}

type RunRow = Awaited<
  ReturnType<PrismaClient["occurrenceRun"]["findMany"]>
>[number];

async function viewsOf(
  base: PrismaClient,
  ctx: TenantContext,
  tenantId: bigint,
  rows: RunRow[],
): Promise<OccurrenceRunView[]> {
  // The ledger is what the round's calls cost: a call an adapter finished after the round gave up on
  // it still writes its row, after the run's own totals were saved. Read from the rows of the round's
  // thread, so a late one is counted; the saved totals answer for a run with no rows.
  const ledger = new Map(
    (rows.length === 0
      ? []
      : await runScopedOn(
          base,
          ctx,
          (db) => db.$queryRaw<
            {
              thread_id: string;
              calls: bigint;
              unpriced: bigint;
              cost: Prisma.Decimal | null;
            }[]
          >`
            SELECT thread_id, count(*) AS calls,
              count(*) FILTER (WHERE cost_usd IS NULL) AS unpriced,
              sum(cost_usd) AS cost
            FROM llm_usage
            WHERE tenant_id = ${tenantId}
              AND thread_id = ANY(${rows.map((r) => runThreadId(tenantId, r.id))})
            GROUP BY thread_id`,
        )
    ).map((u) => [u.thread_id, u]),
  );
  return rows.map((r) => {
    const detail = (r.detail ?? {}) as Record<string, unknown>;
    const u = ledger.get(runThreadId(tenantId, r.id));
    const calls = u ? Number(u.calls) : r.modelCalls;
    const unpriced = u ? Number(u.unpriced) : r.unpricedCalls;
    const cost = u
      ? calls > unpriced && u.cost !== null
        ? Number(u.cost)
        : null
      : r.costUsd === null
        ? null
        : Number(r.costUsd);
    return {
      id: String(r.id),
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      durationMs: r.durationMs,
      status: r.status,
      readings: r.readings,
      modelCalls: calls,
      unpricedCalls: unpriced,
      costUsd: cost,
      error: typeof detail.error === "string" ? detail.error : null,
      steps: runSteps(detail),
    };
  });
}

// The ledger node each step's calls are billed under (src/modules/occurrences/model.ts STEP_NODE),
// and the reading's media recovery (./recovery.ts): the same lines the dashboard's cost by call
// type shows.
export const MONITOR_NODES = [
  ...OCCURRENCE_STEPS.map((s) => `occurrence_${s}`),
  "occurrence_transcription",
  "occurrence_vision",
];

export interface MonitorCost {
  // The priced calls' sum; null when none of the period's calls had a price.
  costUsd: number | null;
  calls: number;
  unpricedCalls: number;
}

// What the monitor cost over the last 7 and the last 30 days, from the usage ledger: every call of
// every step, a round that failed half-way included. A call is the monitor's by its round's thread
// (`runThreadId`), which every one of its ledger rows carries, so two monitors' costs never mix.
export async function occurrenceCost(
  ctx: TenantContext,
  monitorId: bigint,
  now: Date = new Date(),
  base: PrismaClient = basePrisma,
): Promise<{ last7Days: MonitorCost; last30Days: MonitorCost }> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const day = 86_400_000;
  const since7 = new Date(now.getTime() - 7 * day);
  const since30 = new Date(now.getTime() - 30 * day);
  const [row] = await runScopedOn(
    base,
    ctx,
    (db) =>
      db.$queryRaw<
        {
          calls7: bigint;
          unpriced7: bigint;
          cost7: Prisma.Decimal | null;
          calls30: bigint;
          unpriced30: bigint;
          cost30: Prisma.Decimal | null;
        }[]
      >`
      SELECT
        count(*) FILTER (WHERE created_at > ${since7}) AS calls7,
        count(*) FILTER (WHERE created_at > ${since7} AND cost_usd IS NULL) AS unpriced7,
        sum(cost_usd) FILTER (WHERE created_at > ${since7}) AS cost7,
        count(*) AS calls30,
        count(*) FILTER (WHERE cost_usd IS NULL) AS unpriced30,
        sum(cost_usd) AS cost30
      FROM llm_usage
      WHERE tenant_id = ${tenantId}
        AND node = ANY(${MONITOR_NODES})
        AND created_at > ${since30}
        AND created_at <= ${now}
        AND thread_id IN (
          SELECT 'occurrences:' || r.tenant_id || ':' || r.id
            FROM occurrence_runs r
           WHERE r.monitor_id = ${monitorId})`,
  );
  const of = (
    calls: bigint | undefined,
    unpriced: bigint | undefined,
    cost: Prisma.Decimal | null | undefined,
  ): MonitorCost => {
    const c = Number(calls ?? 0);
    const u = Number(unpriced ?? 0);
    return {
      calls: c,
      unpricedCalls: u,
      costUsd: c > u && cost != null ? Number(cost) : null,
    };
  };
  return {
    last7Days: of(row?.calls7, row?.unpriced7, row?.cost7),
    last30Days: of(row?.calls30, row?.unpriced30, row?.cost30),
  };
}
