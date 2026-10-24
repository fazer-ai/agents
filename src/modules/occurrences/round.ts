import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { sumTurnUsage } from "@/graph/usage";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn } from "@/lib/tenancy";
import type { LoadChatwootClientDeps } from "@/modules/chatwoot/instance";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  type JobContext,
  type JobResult,
  jobDeadlineMs,
  registerJobHandler,
  SCHEDULER_STALE_MS,
} from "@/modules/scheduler/worker";
import { jobMonitorId } from "./arm";
import {
  runCanonicalConsolidation,
  runCanonicalCopy,
  runCanonicalStep,
} from "./canonicals";
import { readMonitorOccurrences, sysCtx } from "./config";
import { runFlagsStep } from "./flags";
import { type RoundModelDeps, roundModels } from "./model";
import type { MonitorKey } from "./monitors";
import { runReadingStep } from "./reading";
import type { RecoveryDeps } from "./recovery";
import { runThreadId } from "./runs";
import type { OccurrencesConfig } from "./settings";
import { runAssignmentStep, runConsolidationStep } from "./themes";

// ONE ROUND OF THE OCCURRENCE MONITOR (docs/occurrences.md). Every round leaves an `occurrence_runs`
// row, ok or failed, with what it read and how long it took, so "is it running, and what does it
// cost" is answered by rows and not by logs.

export interface RoundSummary {
  runId: bigint;
  status: "ok" | "failed";
  readings: number;
  durationMs: number;
  error?: string;
}

// How long a round may keep calling models: a minute short of the scheduler's deadline for the run
// (scheduler/worker.ts, jobDeadlineMs), so the round always ends, writes its row and reschedules
// itself before the run is cut. What it had no time for waits for the next round.
export const ROUND_BUDGET_MS = jobDeadlineMs(SCHEDULER_STALE_MS) - 60_000;

export interface RoundDeps {
  base?: PrismaClient;
  now?: () => Date;
  signal?: AbortSignal;
  makeModel?: RoundModelDeps["makeModel"];
  makeChatwootClient?: LoadChatwootClientDeps["makeClient"];
  // The media recovery's providers, which tests replace.
  recovery?: Omit<RecoveryDeps, "makeChatwootClient">;
}

// The consolidation is due when no round consolidated within one consolidation cadence.
async function consolidationDue(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  cfg: OccurrencesConfig,
  startedAt: Date,
): Promise<boolean> {
  const last = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.occurrenceRun.findFirst({
      where: { monitorId, consolidated: true, startedAt: { lt: startedAt } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    }),
  );
  return (
    !last ||
    startedAt.getTime() - last.startedAt.getTime() >=
      cfg.consolidationMinutes * 60_000
  );
}

// The same skip said by many reads (a provider down for every conversation) is one line with its
// count, so a round's row stays readable and small.
const SKIPPED_LINES_MAX = 20;
function foldSkipped(lines: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts]
    .slice(0, SKIPPED_LINES_MAX)
    .map(([l, n]) => (n > 1 ? `${l} (${n}x)` : l));
}

export async function runOccurrenceRound(
  m: MonitorKey,
  cfg: OccurrencesConfig,
  deps: RoundDeps = {},
): Promise<RoundSummary> {
  const { tenantId, monitorId } = m;
  const base = deps.base ?? basePrisma;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const run = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.occurrenceRun.create({
      data: { tenantId, monitorId, startedAt, status: "running" },
      select: { id: true },
    }),
  );
  const threadId = runThreadId(tenantId, run.id);
  let readings = 0;
  let error: string | undefined;
  let consolidated = false;
  const detail: Record<string, unknown> = {};
  const { usage } = await sumTurnUsage(threadId, async () => {
    try {
      const models = await roundModels(tenantId, cfg, {
        base,
        threadId,
        deadline: Date.now() + ROUND_BUDGET_MS,
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.makeModel ? { makeModel: deps.makeModel } : {}),
      });
      // The conversations first, so this round's steps already see what they say; then the references,
      // so the flags of this round count by canonical; then the new sentences; then, when due, the
      // stronger model over what the assignment left.
      const reading = await runReadingStep(base, m, cfg, models, {
        now,
        threadId,
        ...deps.recovery,
        ...(deps.makeChatwootClient
          ? { makeChatwootClient: deps.makeChatwootClient }
          : {}),
      });
      detail.reading = reading;
      // The conversations this round read: the readings column and `detail.reading.read` agree.
      readings = reading.read;
      const canonical = await runCanonicalStep(base, m, cfg, models);
      detail.canonical = canonical;
      detail.assignment = await runAssignmentStep(base, m, cfg, models);
      if (await consolidationDue(base, m, cfg, startedAt)) {
        const themes = await runConsolidationStep(base, m, models, run.id);
        const canonicals = await runCanonicalConsolidation(
          base,
          m,
          cfg,
          models,
        );
        detail.consolidation = themes;
        detail.canonicalMerges = canonicals;
        // Only a pass that completed starts the next interval; a skipped one is tried next round.
        consolidated = themes.completed && canonicals.completed;
      }
      detail.flags = await runFlagsStep(base, m, now());
      // Last, so a slow Chatwoot spends only what the analytical steps left.
      canonical.copied = await runCanonicalCopy(
        base,
        m,
        cfg,
        models.budget,
        deps.makeChatwootClient,
      );
      if (models.skipped.length > 0)
        detail.skipped = foldSkipped(models.skipped);
    } catch (err) {
      error = sanitizeErrorMessage(err);
      logger.warn(
        { error, tenantId: String(tenantId), monitorId: String(monitorId) },
        "occurrence round failed",
      );
    }
  });
  const finishedAt = now();
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  const status = error === undefined ? "ok" : "failed";
  if (error !== undefined) detail.error = error;
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.occurrenceRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt,
        durationMs,
        readings,
        consolidated,
        modelCalls: usage.calls,
        unpricedCalls: usage.unpricedCalls,
        // The priced calls' sum; with none priced there is no figure, which is not a cost of zero.
        costUsd: usage.calls > usage.unpricedCalls ? usage.costUsd : null,
        detail: detail as Prisma.InputJsonValue,
      },
    }),
  );
  return { runId: run.id, status, readings, durationMs, error };
}

// The job, one per monitor. ON: run and re-arm one cadence later. OFF, or deleted: end the loop; the
// next save that switches it on arms it again. It never throws, so the ladder never reaches DEAD.
export async function occurrenceRoundHandler(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
  deps: Omit<RoundDeps, "base"> = {},
  jobCtx?: JobContext,
): Promise<JobResult> {
  const now = deps.now ?? (() => new Date());
  const monitorId = jobMonitorId(job.payload);
  if (monitorId === null) return { outcome: "done" };
  let cfg: OccurrencesConfig | null;
  try {
    cfg = await readMonitorOccurrences(job.tenantId, monitorId, base);
  } catch (err) {
    logger.warn(
      { err, tenantId: String(job.tenantId), monitorId: String(monitorId) },
      "occurrence round: the monitor could not be read; asking again in a minute",
    );
    return { outcome: "reschedule", runAt: new Date(now().getTime() + 60_000) };
  }
  if (!cfg?.enabled) return { outcome: "done" };
  try {
    // A round's writes are not taken back on a retry, so a run cut past its deadline still has its
    // reschedule written (scheduler/worker.ts, JobContext.commit).
    jobCtx?.commit();
    await runOccurrenceRound({ tenantId: job.tenantId, monitorId }, cfg, {
      ...deps,
      base,
      now,
      ...(jobCtx ? { signal: jobCtx.signal } : {}),
    });
  } catch (err) {
    // The run row itself could not be written: nothing to record it in, so the log is the record.
    logger.warn(
      { err, tenantId: String(job.tenantId), monitorId: String(monitorId) },
      "occurrence round could not be recorded",
    );
  }
  return {
    outcome: "reschedule",
    runAt: new Date(now().getTime() + cfg.cadenceMinutes * 60_000),
  };
}

let registered = false;
export function registerOccurrenceRoundHandler(): void {
  if (registered) return;
  registerJobHandler("OCCURRENCE_ROUND", (job, base, jobCtx) =>
    occurrenceRoundHandler(job, base, {}, jobCtx),
  );
  registered = true;
}
