import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { getCheckpointer } from "@/graph/checkpointer";
import { parseDbId } from "@/lib/db-id";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { EXPIRY_CLAIM } from "@/modules/client-channel/identity";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { monthStart } from "@/modules/spend-ceiling/decide";

// Anonymous conversations left with no message past their app's `anonExpiryDays` are deleted
// (docs/client-channel.md, "Anonymous visitors"): the thread row, its checkpoint, and the anonymous
// user once no thread is left. One CLIENT_ANON_SWEEP job per tenant, armed when an app is created or
// deleted and at boot, self-rearming every 24h while the tenant has an app or an anonymous user left,
// in the mold of the flow log's retention sweep.
// A conversation handed over to a signed-in user belongs to an `app:` user and is never touched.

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const EXPIRY_BATCH = 500;
const SWEEP_KEY = "client-anon-sweep";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface ExpiringApp {
  id: bigint;
  anonExpiryDays: number;
}

// The last message before which an anonymous conversation of this app expires.
export function expiryCutoff(app: ExpiringApp, now: Date): Date {
  return new Date(now.getTime() - app.anonExpiryDays * 86_400_000);
}

interface Candidate {
  threadId: string;
  externalUserId: bigint | null;
  activeTurnId: string | null;
  lastTurnAt: Date;
}

// Until when a thread being expired is claimed (`EXPIRY_CLAIM`): for good, so no round-trip and no
// hand-over can take it, and a pass that stopped between the checkpoint and the row is finished by
// the next one.
const FOREVER = new Date("9999-12-31T00:00:00Z");

// Where a pass stopped inside one app: the last thread it handled, kept or expired.
export interface ExpiryCursor {
  lastTurnAt: Date;
  threadId: string;
}

// Deletes this app's expired anonymous conversations, and answers their thread ids and whether it ran
// out of time (`stopAt`) first, with the cursor to resume from (`start`; null is the beginning). Three steps per
// thread, because the checkpoint lives in another store and no transaction spans both: a short write
// claims the row while it is still expired, still this anonymous user's and held by no round-trip (a
// turn that arrived since moved `lastTurnAt`, a hand-over moved the owner or holds the claim); then
// the checkpoint is deleted; then the row. A checkpoint that fails to delete leaves the row claimed,
// unusable and picked up again by the next pass.
export async function expireAnonymousThreads(p: {
  ctx: TenantContext;
  app: ExpiringApp;
  base: PrismaClient;
  checkpointer: Pick<BaseCheckpointSaver, "deleteThread">;
  now?: Date;
  batch?: number;
  start?: ExpiryCursor | null;
  stopAt?: number;
}): Promise<{
  expired: string[];
  stopped: boolean;
  resumeAt: ExpiryCursor | null;
}> {
  const now = p.now ?? new Date();
  const cutoff = expiryCutoff(p.app, now);
  const prefix = `anon:${p.app.id}:`;
  const unclaimed = [{ activeTurnId: null }, { activeUntil: { lt: now } }];
  const month = monthStart(now);
  const expired: string[] = [];
  // Keyset over (lastTurnAt, threadId): the threads kept by a pass stay in the table, so paging by
  // position or by an exclusion list would revisit them or grow without bound.
  let after: ExpiryCursor | null = p.start ?? null;
  const outOfTime = () => p.stopAt !== undefined && Date.now() >= p.stopAt;
  while (true) {
    // NOTE: before every page too, so an app with nothing to expire still spends no time past it.
    if (outOfTime()) return { expired, stopped: true, resumeAt: after };
    const page: ExpiryCursor | null = after;
    const batch: Candidate[] = await runScopedOn(p.base, p.ctx, (db) =>
      db.detachedThread.findMany({
        where: {
          kind: "client",
          externalUser: {
            channel: "client",
            externalId: { startsWith: prefix },
          },
          AND: [
            {
              OR: [
                { lastTurnAt: { lt: cutoff }, OR: unclaimed },
                { activeTurnId: EXPIRY_CLAIM },
              ],
            },
            ...(page
              ? [
                  {
                    OR: [
                      { lastTurnAt: { gt: page.lastTurnAt } },
                      {
                        lastTurnAt: page.lastTurnAt,
                        threadId: { gt: page.threadId },
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
        select: {
          threadId: true,
          externalUserId: true,
          activeTurnId: true,
          lastTurnAt: true,
        },
        orderBy: [{ lastTurnAt: "asc" }, { threadId: "asc" }],
        take: p.batch ?? EXPIRY_BATCH,
      }),
    );
    for (const t of batch) {
      if (outOfTime()) return { expired, stopped: true, resumeAt: after };
      const gone = await expireOne(p, t, {
        cutoff,
        now,
        month,
        unclaimed,
      }).catch((err) => {
        logger.warn(
          { threadId: t.threadId, err },
          "anonymous conversation could not be expired; kept for the next sweep",
        );
        return false;
      });
      if (gone) expired.push(t.threadId);
      after = { lastTurnAt: t.lastTurnAt, threadId: t.threadId };
    }
    if (batch.length < (p.batch ?? EXPIRY_BATCH)) break;
  }
  // The anonymous users left with no conversation and not seen since the cutoff, in batches of
  // their own transactions. A turn arriving now moves `lastSeenAt` on the row the delete takes, so it
  // is never one being used, and a deleted row leaves the query, so no cursor is needed.
  const idle = {
    channel: "client",
    externalId: { startsWith: prefix },
    lastSeenAt: { lt: cutoff },
    threads: { none: {} },
  };
  while (true) {
    if (outOfTime()) return { expired, stopped: true, resumeAt: after };
    const ids = await runScopedOn(p.base, p.ctx, (db) =>
      db.externalUser.findMany({
        where: idle,
        select: { id: true },
        take: p.batch ?? EXPIRY_BATCH,
      }),
    );
    if (ids.length === 0) break;
    await runScopedOn(p.base, p.ctx, (db) =>
      db.externalUser.deleteMany({
        where: { ...idle, id: { in: ids.map((u) => u.id) } },
      }),
    );
    if (ids.length < (p.batch ?? EXPIRY_BATCH)) break;
  }
  return { expired, stopped: false, resumeAt: null };
}

async function expireOne(
  p: {
    ctx: TenantContext;
    base: PrismaClient;
    checkpointer: Pick<BaseCheckpointSaver, "deleteThread">;
  },
  t: {
    threadId: string;
    externalUserId: bigint | null;
    activeTurnId: string | null;
  },
  w: {
    cutoff: Date;
    now: Date;
    month: Date;
    unclaimed: Array<{ activeTurnId: null } | { activeUntil: { lt: Date } }>;
  },
): Promise<boolean> {
  if (t.activeTurnId !== EXPIRY_CLAIM) {
    // A conversation with a call billed this month stays until the month is over, whatever its term
    // and whether or not the app has a ceiling now: an app's month spend is summed by joining the
    // calls to these rows, and a call can be billed after the `lastTurnAt` its turn wrote on entry.
    const billed = await runScopedOn(p.base, p.ctx, (db) =>
      db.llmUsage.count({
        where: { threadId: t.threadId, createdAt: { gte: w.month } },
      }),
    );
    if (billed > 0) return false;
    const claimed = await runScopedOn(p.base, p.ctx, (db) =>
      db.detachedThread.updateMany({
        where: {
          threadId: t.threadId,
          externalUserId: t.externalUserId,
          lastTurnAt: { lt: w.cutoff },
          OR: w.unclaimed,
        },
        data: { activeTurnId: EXPIRY_CLAIM, activeUntil: FOREVER },
      }),
    );
    if (claimed.count !== 1) return false;
  }
  await p.checkpointer.deleteThread(t.threadId);
  await runScopedOn(p.base, p.ctx, (db) =>
    db.detachedThread.deleteMany({
      where: { threadId: t.threadId, activeTurnId: EXPIRY_CLAIM },
    }),
  );
  return true;
}

// The deleted apps this tenant's anonymous users still name: their tokens stopped verifying with
// the app, so their conversations are unreachable and go at once. Decided against the app table in
// the same statement: an anonymous user exists only after its app does, so a user this statement sees
// has its app visible to it too, and an app created meanwhile is never taken for a deleted one.
async function deletedAppIds(
  base: PrismaClient,
  ctx: TenantContext,
): Promise<bigint[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT DISTINCT split_part(eu.external_id, ':', 2) AS id
      FROM external_users eu
      WHERE eu.channel = 'client'
        AND eu.external_id LIKE 'anon:%'
        AND NOT EXISTS (
          SELECT 1 FROM client_apps ca
          WHERE ca.id::text = split_part(eu.external_id, ':', 2)
        )`),
  );
  return rows.flatMap((r) => {
    const id = parseDbId(r.id);
    return id === null ? [] : [id];
  });
}

// How long one run may sweep before it hands the rest to the next run: well under the scheduler's
// deadline, so a large tenant makes progress run after run instead of timing out and starting over.
const SWEEP_BUDGET_MS = 60_000;
const CONTINUE_AFTER_MS = 60_000;

function readCursor(
  payload: Record<string, unknown> | null | undefined,
): { appId: bigint; after: ExpiryCursor | null } | null {
  const c = payload?.cursor as
    | { appId?: unknown; lastTurnAt?: unknown; threadId?: unknown }
    | undefined;
  const appId = typeof c?.appId === "string" ? parseDbId(c.appId) : null;
  if (!c || appId === null) return null;
  if (typeof c.lastTurnAt !== "string" || typeof c.threadId !== "string")
    return { appId, after: null };
  const at = new Date(c.lastTurnAt);
  if (Number.isNaN(at.getTime())) return { appId, after: null };
  return { appId, after: { lastTurnAt: at, threadId: c.threadId } };
}

export async function clientAnonSweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
  opts: { budgetMs?: number } = {},
): Promise<JobResult> {
  const ctx = sysCtx(job.tenantId);
  const stopAt = Date.now() + (opts.budgetMs ?? SWEEP_BUDGET_MS);
  const apps: ExpiringApp[] = await runScopedOn(base, ctx, (db) =>
    db.clientApp.findMany({
      select: { id: true, anonExpiryDays: true },
    }),
  );
  const deleted = (await deletedAppIds(base, ctx)).map((id) => ({
    id,
    anonExpiryDays: 0,
  }));
  if (apps.length === 0 && deleted.length === 0) return { outcome: "done" };
  const cursor = readCursor(job.payload);
  const targets = [...apps, ...deleted].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const checkpointer = await getCheckpointer();
  for (const app of targets) {
    if (cursor && app.id < cursor.appId) continue;
    const { stopped, resumeAt } = await expireAnonymousThreads({
      ctx,
      app,
      base,
      checkpointer,
      start: cursor && app.id === cursor.appId ? cursor.after : null,
      stopAt,
    });
    if (stopped)
      return {
        outcome: "reschedule",
        runAt: new Date(Date.now() + CONTINUE_AFTER_MS),
        payload: {
          cursor: {
            appId: String(app.id),
            ...(resumeAt
              ? {
                  lastTurnAt: resumeAt.lastTurnAt.toISOString(),
                  threadId: resumeAt.threadId,
                }
              : {}),
          },
        },
      };
  }
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    payload: {},
  };
}

let registered = false;
export function registerClientAnonSweepHandler(): void {
  if (registered) return;
  registerJobHandler("CLIENT_ANON_SWEEP", (job, base) =>
    clientAnonSweepHandler(job, base),
  );
  registered = true;
}

// Arms the tenant's sweep unless a pass is already pending. A pending pass keeps its time: re-arming
// it on every boot or app change would push it back each time, and a tenant that restarts or edits
// more often than daily would never be swept. A pass running now is re-armed, which also discards its
// own outcome (`completeJob` and `rescheduleJob` only write a row still claimed), so a pass that read
// no app just before one was created cannot end the sweep.
export async function ensureClientAnonSweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const live = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.count({
      where: {
        kind: "CLIENT_ANON_SWEEP",
        dedupeKey: SWEEP_KEY,
        status: "PENDING",
      },
    }),
  );
  if (live > 0) return;
  await enqueueJob({
    tenantId,
    kind: "CLIENT_ANON_SWEEP",
    dedupeKey: SWEEP_KEY,
    rearm: "same-work",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    base,
  });
}

// Arms the sweep for every tenant with an app or an anonymous user left (once, at boot). One tenant failing must not deprive
// the later ones of their re-arm.
export async function ensureAllClientAnonSweeps(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.$queryRaw<{ tenant_id: bigint }[]>(Prisma.sql`
      SELECT tenant_id FROM client_apps
      UNION
      SELECT tenant_id FROM external_users
      WHERE channel = 'client' AND external_id LIKE 'anon:%'`),
  );
  for (const t of tenants) {
    try {
      await ensureClientAnonSweep(t.tenant_id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.tenant_id), err },
        "client anonymous sweep re-arm failed for tenant; continuing",
      );
    }
  }
}
