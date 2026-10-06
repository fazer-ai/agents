import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import type { UsageSource } from "@/graph/usage";
import { withEntityLock } from "@/lib/locks";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { claimContactAuthNotice } from "@/modules/contact-auth/state";
import { emitFlowEvent } from "@/modules/flowlog/service";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { monthEnd, monthStart } from "./decide";
import {
  readTenantSpendCeiling,
  SPEND_CEILING_WARN_COOLDOWN_MS,
  spendPollIntervalMs,
} from "./service";
import type { SpendCeilingConfig } from "./settings";

// THE POLL THAT WRITES WHAT THE GATE READS. A job sums the month's `llm_usage.cost_usd` per source
// into `spend_cost_snapshots`, and the gate reads the row, so no customer message pays for a sum
// over the month's ledger. The figure IS the ledger's at the instant of the poll, not a floor of it:
// a month re-priced downwards lowers the ceiling's figure on the next poll. The full design is in
// docs/spend-ceiling.md.

export interface PollDeps {
  base?: PrismaClient;
  // Injectable clock: the month, the window's upper edge and `polledAt` all come from it.
  now?: Date;
}

export type PollOutcome =
  | { status: "polled" }
  | { status: "failed"; error: string };

const SOURCES: UsageSource[] = ["inbox", "playground"];

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function snapshotLockKey(tenantId: bigint, source: UsageSource, month: Date) {
  return `spend-snapshot:${tenantId}:${source}:${month.toISOString()}`;
}

// The month's priced cost of one source. A call the ledger could not price (null `cost_usd`) adds
// nothing here; the console counts those calls beside the bar and the capture announces the model.
async function sumMonthCost(
  db: ScopedDb,
  tenantId: bigint,
  source: UsageSource,
  month: Date,
): Promise<number> {
  const agg = await db.llmUsage.aggregate({
    where: {
      tenantId,
      source,
      createdAt: { gte: month, lt: monthEnd(month) },
    },
    _sum: { costUsd: true },
  });
  return Number(agg._sum.costUsd ?? 0);
}

// UNDER THE ROW'S ADVISORY LOCK, because a save re-arms the job and two polls of one tenant can
// overlap. The newer reading wins: a poll that began before the row's last success writes nothing,
// and an older success landing after a newer failure keeps that failure on the row.
async function writeSuccess(
  db: ScopedDb,
  tenantId: bigint,
  source: UsageSource,
  month: Date,
  costUsd: number,
  at: Date,
): Promise<void> {
  await withEntityLock(
    db,
    snapshotLockKey(tenantId, source, month),
    async () => {
      const key = {
        tenantId_source_monthStart: { tenantId, source, monthStart: month },
      };
      const prev = await db.spendCostSnapshot.findUnique({
        where: key,
        select: {
          polledAt: true,
          pollError: true,
          pollFailedAt: true,
          pollLastFailedAt: true,
        },
      });
      if (prev?.polledAt && prev.polledAt > at) return;
      const figure = {
        costUsd,
        polledAt: at,
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
    },
  );
}

// The failure touches the failure trio only: the last good figure and its `polledAt` stay, so the
// gate decides on it and the console says it is stale. `pollFailedAt` is when the CURRENT streak
// began ("failing since"); `pollLastFailedAt` the latest attempt, which an older poll is measured
// against. A failure older than the row's last success or newest failure is not its present.
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

// Once per six hours, not once per poll: a database struggling for an afternoon would otherwise page
// the channels every minute about one unchanging fact.
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
      errorMessage: `spend ceiling: the month's cost could not be summed from the usage ledger (${error}); the last figure stands`,
    },
  );
}

// Sums the month's cost for both sources into the snapshot. Never throws: every outcome is on the
// row, and the caller (the job) has nothing to do with an exception but die.
export async function pollTenantSpend(
  tenantId: bigint,
  deps: PollDeps = {},
): Promise<PollOutcome> {
  const base = deps.base ?? basePrisma;
  const now = deps.now ?? new Date();
  const month = monthStart(now);
  const ctx = sysCtx(tenantId);
  try {
    await runScopedOn(base, ctx, async (db) => {
      for (const source of SOURCES) {
        const cost = await sumMonthCost(db, tenantId, source, month);
        await writeSuccess(db, tenantId, source, month, cost, now);
      }
    });
    return { status: "polled" };
  } catch (err) {
    const error = sanitizeErrorMessage(err);
    logger.warn(
      { error, tenantId: String(tenantId) },
      "spend ceiling poll failed; the last figure stands",
    );
    let current = true;
    try {
      current = await runScopedOn(base, ctx, async (db) => {
        let applied = false;
        for (const source of SOURCES) {
          if (await writeFailure(db, tenantId, source, month, error, now)) {
            applied = true;
          }
        }
        return applied;
      });
    } catch (writeErr) {
      logger.warn(
        { err: writeErr, tenantId: String(tenantId) },
        "spend ceiling poll: the failure itself could not be recorded",
      );
    }
    if (current) announcePollFailure(tenantId, error, base);
    return { status: "failed", error };
  }
}

// The job. With the ceiling on it polls and re-arms at the configured cadence; with it off there is
// nothing to enforce and the console reads the ledger itself, so the loop ends until the next save.
// It never throws, so the scheduler's ladder never reaches DEAD: `JOB_DEATH_LEVEL` says a death here
// is an error precisely because it would mean the ceiling silently froze.
export async function spendPollHandler(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
  deps: Omit<PollDeps, "base"> = {},
): Promise<JobResult> {
  const rearm = (
    intervalMs = config.spendCeiling.pollIntervalMs,
  ): JobResult => ({
    outcome: "reschedule",
    runAt: new Date(Date.now() + intervalMs),
  });
  // The settings read is a failure like any other: it re-arms and asks again next period. "done" is
  // reserved for a ceiling READ as off.
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
  return rearm(spendPollIntervalMs());
}

let registered = false;
export function registerSpendPollHandler(): void {
  if (registered) return;
  registerJobHandler("SPEND_CEILING_POLL", (job, base) =>
    spendPollHandler(job, base),
  );
  registered = true;
}
