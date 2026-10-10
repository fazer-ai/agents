import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { consoleUrl } from "@/modules/mcp/console-links";
import {
  AUTO_FLOOR,
  AUTO_LOOKBACK_DAYS,
  AUTO_MULTIPLIER,
  autoLimitFor,
  type ProactiveBreakerMode,
  readProactiveBreakerConfig,
} from "./settings";

// THE ACCOUNT-WIDE PROACTIVE BREAKER. Every proactive send of the account is counted over a rolling
// 24 hours, and the send that finds the count at the limit trips it: from then on no agent of the
// account sends a proactive message until an admin resumes. It latches because a window that
// reopens on its own lets a steady bug keep sending all weekend. See docs/proactive-breaker.md.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTO_REFRESH_MS = 24 * 60 * 60 * 1000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The card where an admin resumes the breaker, raises its limit or turns it off.
export function proactiveBreakerSettingsUrl(tenantId: bigint | null): string {
  return consoleUrl("/resources/advanced?section=proactive-breaker", {
    tenantId,
  });
}

export function breakerLockKey(tenantId: bigint): string {
  return `proactive-breaker:${tenantId}`;
}

type BreakerRow = {
  trippedAt: Date | null;
  tripCount: number | null;
  tripLimit: number | null;
  resumedAt: Date | null;
  autoPeak: number | null;
  autoPeakAt: Date | null;
  autoComputedAt: Date | null;
};

const ROW_SELECT = {
  trippedAt: true,
  tripCount: true,
  tripLimit: true,
  resumedAt: true,
  autoPeak: true,
  autoPeakAt: true,
  autoComputedAt: true,
} as const;

// The limit in force, or null when the breaker is off.
function effectiveLimit(
  mode: ProactiveBreakerMode,
  fixed: number | null,
  row: BreakerRow | null,
): number | null {
  if (mode === "off") return null;
  if (mode === "fixed" && fixed !== null) return fixed;
  return autoLimitFor(row?.autoPeak ?? null);
}

// The count starts at the later of a day ago and the last resume: a resume is a fresh allowance,
// so an account resumed while still above its limit does not trip again on the next send.
function windowStartFor(now: Date, resumedAt: Date | null): Date {
  const dayAgo = new Date(now.getTime() - WINDOW_MS);
  return resumedAt && resumedAt > dayAgo ? resumedAt : dayAgo;
}

async function countWindow(
  db: ScopedDb,
  tenantId: bigint,
  since: Date,
): Promise<number> {
  return db.agentTurnDelivery.count({
    where: { tenantId, proactive: true, deliveredAt: { gt: since } },
  });
}

// The largest number of proactive messages the account delivered in any 24h window of the last 30
// days, read from what the app already recorded: the flow log's line for a nudge that reached the
// customer (`generate` with outcome `messaged` or `templated`), written since before this breaker
// existed, so no account starts below its own peak. Bounded by the log's retention.
export async function computeAutoPeak(
  db: ScopedDb,
  tenantId: bigint,
  now: Date,
): Promise<{ peak: number; at: Date | null }> {
  const since = new Date(now.getTime() - AUTO_LOOKBACK_DAYS * WINDOW_MS);
  const rows = await db.$queryRaw<Array<{ n: bigint; at: Date }>>(Prisma.sql`
    SELECT n, at FROM (
      SELECT created_at AS at,
             count(*) OVER (
               ORDER BY created_at
               RANGE BETWEEN CURRENT ROW AND INTERVAL '24 hours' FOLLOWING
             ) AS n
        FROM execution_logs
       WHERE tenant_id = ${tenantId}
         AND stage = 'generate'
         AND source = 'inbox'
         AND created_at > ${since}
         AND detail->>'outcome' IN ('messaged', 'templated')
    ) w
    ORDER BY n DESC, at ASC
    LIMIT 1`);
  const top = rows[0];
  return top ? { peak: Number(top.n), at: top.at } : { peak: 0, at: null };
}

const refreshing = new Map<string, Promise<void>>();

// Refreshes the automatic limit's inputs when they are missing or a day old. Outside the send's
// lock, since it reads a month of the flow log; concurrent sends of one tenant share one read. A
// failure keeps the last figure (or the floor) and never blocks a send.
export async function refreshAutoPeak(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<void> {
  const key = String(tenantId);
  const inFlight = refreshing.get(key);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      await runScopedOn(base, sysCtx(tenantId), async (db) => {
        const row = await db.proactiveBreaker.findUnique({
          where: { tenantId },
          select: { autoComputedAt: true },
        });
        if (
          row?.autoComputedAt &&
          now.getTime() - row.autoComputedAt.getTime() < AUTO_REFRESH_MS
        )
          return;
        const { peak, at } = await computeAutoPeak(db, tenantId, now);
        await db.proactiveBreaker.upsert({
          where: { tenantId },
          create: {
            tenantId,
            autoPeak: peak,
            autoPeakAt: at,
            autoComputedAt: now,
          },
          update: { autoPeak: peak, autoPeakAt: at, autoComputedAt: now },
        });
      });
    } catch (err) {
      logger.warn(
        { err, tenantId: String(tenantId) },
        "proactive breaker: could not refresh the automatic limit",
      );
    } finally {
      refreshing.delete(key);
    }
  })();
  refreshing.set(key, run);
  return run;
}

export type BreakerVerdict =
  | { open: true }
  | {
      open: false;
      // This send is the one that tripped it, which is the line that alerts.
      trippedNow: boolean;
      trippedAt: Date;
      count: number;
      limit: number;
    };

// The breaker's answer for one proactive send, inside the caller's transaction and under the
// tenant's lock, so two sends cannot both take the last slot. A tripped breaker refuses; an open one
// at its limit trips and refuses. The caller writes the send's own row after an open answer, inside
// the same lock, which is what makes the count include every send ahead of it.
export async function checkBreakerLocked(
  db: ScopedDb,
  tenantId: bigint,
  now: Date,
): Promise<BreakerVerdict> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const cfg = readProactiveBreakerConfig(tenant?.settings);
  if (cfg.mode === "off") return { open: true };
  const row = await db.proactiveBreaker.findUnique({
    where: { tenantId },
    select: ROW_SELECT,
  });
  if (row?.trippedAt)
    return {
      open: false,
      trippedNow: false,
      trippedAt: row.trippedAt,
      count: row.tripCount ?? 0,
      limit: row.tripLimit ?? 0,
    };
  const limit = effectiveLimit(cfg.mode, cfg.limit, row) as number;
  const count = await countWindow(
    db,
    tenantId,
    windowStartFor(now, row?.resumedAt ?? null),
  );
  if (count < limit) return { open: true };
  await db.proactiveBreaker.upsert({
    where: { tenantId },
    create: { tenantId, trippedAt: now, tripCount: count, tripLimit: limit },
    update: { trippedAt: now, tripCount: count, tripLimit: limit },
  });
  return { open: false, trippedNow: true, trippedAt: now, count, limit };
}

export interface ProactiveBreakerStatus {
  mode: ProactiveBreakerMode;
  // The pinned number, kept while the mode is not `fixed` so switching back restores it.
  fixedLimit: number | null;
  // The limit in force; null when the breaker is off.
  limit: number | null;
  // Where an automatic limit came from: 3x the peak, or the floor when 3x the peak is below it.
  auto: {
    limit: number;
    peak: number | null;
    peakAt: string | null;
    basis: "peak" | "floor";
    multiplier: number;
    floor: number;
    computedAt: string | null;
  };
  // Proactive messages counted toward the limit right now (since the later of a day ago and the
  // last resume).
  count: number;
  windowStart: string;
  tripped: { at: string; count: number; limit: number } | null;
  resumedAt: string | null;
}

async function statusOn(
  db: ScopedDb,
  tenantId: bigint,
  now: Date,
): Promise<ProactiveBreakerStatus> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const cfg = readProactiveBreakerConfig(tenant?.settings);
  const row = await db.proactiveBreaker.findUnique({
    where: { tenantId },
    select: ROW_SELECT,
  });
  const windowStart = windowStartFor(now, row?.resumedAt ?? null);
  const peak = row?.autoPeak ?? null;
  const autoLimit = autoLimitFor(peak);
  return {
    mode: cfg.mode,
    fixedLimit: cfg.limit,
    limit: effectiveLimit(cfg.mode, cfg.limit, row),
    auto: {
      limit: autoLimit,
      peak,
      peakAt: row?.autoPeakAt?.toISOString() ?? null,
      basis: AUTO_MULTIPLIER * (peak ?? 0) > AUTO_FLOOR ? "peak" : "floor",
      multiplier: AUTO_MULTIPLIER,
      floor: AUTO_FLOOR,
      computedAt: row?.autoComputedAt?.toISOString() ?? null,
    },
    count: await countWindow(db, tenantId, windowStart),
    windowStart: windowStart.toISOString(),
    tripped: row?.trippedAt
      ? {
          at: row.trippedAt.toISOString(),
          count: row.tripCount ?? 0,
          limit: row.tripLimit ?? 0,
        }
      : null,
    resumedAt: row?.resumedAt?.toISOString() ?? null,
  };
}

function requireTenantId(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  return ctx.tenantId;
}

// What the card, the banner, REST and MCP read. Refreshes the automatic limit first when it is stale,
// so the card shows the number the next send will be held to.
export async function getProactiveBreakerStatus(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<ProactiveBreakerStatus> {
  const tenantId = requireTenantId(ctx);
  await refreshAutoPeak(tenantId, base, now);
  return runScopedOn(base, ctx, (db) => statusOn(db, tenantId, now));
}

// Reopens a tripped breaker. The count after it starts from zero. Resuming an open breaker changes
// nothing and writes no audit row, so a double click is harmless.
export async function resumeProactiveBreaker(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<ProactiveBreakerStatus> {
  const tenantId = requireTenantId(ctx);
  return runScopedOn(base, ctx, (db) =>
    withEntityLock(db, breakerLockKey(tenantId), async () => {
      const row = await db.proactiveBreaker.findUnique({
        where: { tenantId },
        select: ROW_SELECT,
      });
      if (row?.trippedAt) {
        await db.proactiveBreaker.update({
          where: { tenantId },
          data: {
            trippedAt: null,
            tripCount: null,
            tripLimit: null,
            resumedAt: now,
          },
        });
        await auditMutation(db, ctx, {
          action: "proactive_breaker.resume",
          target: "proactive_breaker",
          before: {
            trippedAt: row.trippedAt.toISOString(),
            count: row.tripCount,
            limit: row.tripLimit,
          },
          after: { trippedAt: null, resumedAt: now.toISOString() },
        });
      }
      return statusOn(db, tenantId, now);
    }),
  );
}

// Turning the breaker off ends a trip: an off breaker is never asked, so a latch left behind would
// keep the banner up for a guard that is not running, and come back by surprise the day it is turned
// on again. Same effect as a resume, recorded by the settings write that caused it.
export async function clearTripForOff(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<void> {
  const tenantId = requireTenantId(ctx);
  await runScopedOn(base, ctx, (db) =>
    withEntityLock(db, breakerLockKey(tenantId), () =>
      db.proactiveBreaker.updateMany({
        where: { tenantId, trippedAt: { not: null } },
        data: {
          trippedAt: null,
          tripCount: null,
          tripLimit: null,
          resumedAt: now,
        },
      }),
    ),
  );
}
