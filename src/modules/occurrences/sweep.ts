import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  type LoadChatwootClientDeps,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  type JobContext,
  type JobResult,
  jobDeadlineMs,
  registerJobHandler,
  SCHEDULER_STALE_MS,
} from "@/modules/scheduler/worker";
import { jobMonitorId } from "./arm";
import { readMonitorOccurrences, sysCtx } from "./config";
import type { MonitorKey } from "./monitors";
import type { OccurrencesConfig } from "./settings";

// THE SWEEP (docs/occurrences.md, "Inboxes no agent receives"). An inbox only people answer has no
// agent, so no webhook feeds the mirror the reading queue reads. A job of its own (`OCCURRENCE_SWEEP`,
// armed with the monitor's round, ./arm.ts) lists each such inbox by latest activity, with its own
// time, and queues what moved at the activity listed: due when newer than what the last reading
// covered. No message is fetched and nothing is written to Chatwoot. A conversation the mirror lacks
// gets a bare `sweep_only` row, inserted once and never written by the sweep again (the first webhook
// mirrors it over that row, chatwoot/mirror.ts).

// How many pages of 25 one inbox's listing reads per round, and the size of Chatwoot's page: a
// shorter one is the end of the listing. The cursor moves only when the whole listing fit in one page:
// the pages are by offset, so a conversation leaving the inbox between two requests slides the next
// one onto a page already read, and only one request is safe from that. A longer listing leaves the
// cursor where it was, the next round lists from the top again, and what lies past the last page is
// not read (docs/occurrences.md says so).
export const SWEEP_PAGES = 8;
const PAGE_SIZE = 25;
// How many requests to Chatwoot the whole sweep makes per round, pins and pages: a count, so the
// reading after it always keeps its time, however many inboxes there are.
export const SWEEP_REQUESTS_PER_ROUND = 30;

export interface SweepInbox {
  id: bigint;
  name: string;
  chatwootInstanceId: bigint;
  chatwootInboxId: number;
}

interface Listed {
  id: number;
  status: string;
  activityAt: Date;
}

// The rows of one inbox to queue, newest activity first, and whether the whole listing, down to the
// cursor (or the window) or its end, came in its first page, which is what lets the cursor move.
async function listInbox(
  client: ChatwootClient,
  inbox: SweepInbox,
  pinned: Set<number>,
  floor: Date,
  // The round's requests left, spent here one per page.
  budget: { left: number },
): Promise<{ rows: Listed[]; onePage: boolean }> {
  // By id: a conversation that moved between two page requests can be listed on both.
  const rows = new Map<number, Listed>();
  const done = (onePage: boolean) => ({ rows: [...rows.values()], onePage });
  for (let page = 1; page <= SWEEP_PAGES && budget.left > 0; page++) {
    budget.left -= 1;
    const listed = await client.listInboxConversations(
      inbox.chatwootInboxId,
      "all",
      page,
    );
    if (listed.length === 0) return done(page === 1);
    let reached = listed.length < PAGE_SIZE;
    for (const c of listed) {
      // An unreadable clock says nothing about where the activity order is.
      if (c.lastActivityAt === null)
        throw new Error(
          `inbox ${inbox.chatwootInboxId}: conversation ${c.id} has no activity time`,
        );
      if (c.lastActivityAt < floor) {
        // A pinned conversation leads the listing whatever its age, so only an unpinned one ends it.
        if (!pinned.has(c.id)) reached = true;
        continue;
      }
      const seen = rows.get(c.id);
      if (!seen || seen.activityAt < c.lastActivityAt)
        rows.set(c.id, {
          id: c.id,
          status: c.status ?? "open",
          activityAt: c.lastActivityAt,
        });
    }
    if (reached) return done(page === 1);
  }
  return done(false);
}

// The listed conversations into the monitor's queue: the bare row where the mirror has none (never
// touched again once there), then the read row's listed activity, which only ever moves forward.
async function enqueue(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  inbox: SweepInbox,
  rows: Listed[],
): Promise<void> {
  if (rows.length === 0) return;
  await runScopedOn(base, sysCtx(tenantId), async (db) => {
    await db.conversation.createMany({
      data: rows.map((r) => ({
        tenantId,
        chatwootInstanceId: inbox.chatwootInstanceId,
        chatwootConversationId: r.id,
        inboxId: inbox.id,
        status: r.status,
        threadId: `${tenantId}:${inbox.chatwootInstanceId}:${r.id}`,
        sweepOnly: true,
      })),
      skipDuplicates: true,
    });
    // Only the mirror's rows of this inbox: one the mirror holds in another inbox moved away, and
    // follows its own inbox's rule.
    await db.$executeRaw`
      INSERT INTO occurrence_conversation_reads
             (tenant_id, monitor_id, conversation_id, swept_activity_at, swept_due_since)
      SELECT c.tenant_id, ${monitorId}, c.id, v.at::timestamptz AT TIME ZONE 'UTC',
             v.at::timestamptz AT TIME ZONE 'UTC'
        FROM unnest(${rows.map((r) => r.id)}::int[], ${rows.map((r) => r.activityAt.toISOString())}::text[]) AS v(cid, at)
        JOIN conversations c ON c.tenant_id = ${tenantId}
                            AND c.chatwoot_instance_id = ${inbox.chatwootInstanceId}
                            AND c.chatwoot_conversation_id = v.cid
                            AND c.inbox_id = ${inbox.id}
      ON CONFLICT (monitor_id, conversation_id) DO UPDATE
        SET swept_activity_at = GREATEST(occurrence_conversation_reads.swept_activity_at,
                                         EXCLUDED.swept_activity_at),
            -- Moves only when the conversation becomes due: newer activity over one that was not
            -- waiting. One already waiting keeps the activity it became due at.
            swept_due_since = CASE
              WHEN EXCLUDED.swept_activity_at > occurrence_conversation_reads.swept_activity_at
               AND occurrence_conversation_reads.read_swept_activity_at
                   >= occurrence_conversation_reads.swept_activity_at
              THEN EXCLUDED.swept_activity_at
              WHEN occurrence_conversation_reads.swept_activity_at IS NULL
              THEN EXCLUDED.swept_activity_at
              ELSE occurrence_conversation_reads.swept_due_since
            END`;
  });
}

async function saveCursor(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  inboxId: bigint,
  activityAt: Date | undefined,
  sweptAt: Date,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.occurrenceSweepCursor.upsert({
      where: { monitorId_inboxId: { monitorId, inboxId } },
      create: {
        tenantId,
        monitorId,
        inboxId,
        activityAt: activityAt ?? null,
        sweptAt,
      },
      update: { ...(activityAt ? { activityAt } : {}), sweptAt },
    }),
  );
}

// A failed listing is kept on the inbox's cursor until one lists again, for the round to say.
async function markUnlisted(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  inboxId: bigint,
  at: Date | null,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.occurrenceSweepCursor.updateMany({
      where: { monitorId, inboxId },
      data: { unlistedAt: at },
    }),
  );
}

export interface SweepDeps {
  // Clients that expire where the sweep's time does: the only deadline here.
  clientOf: (instanceId: bigint) => Promise<ChatwootClient>;
  signal: AbortSignal;
  windowStart: Date;
  now: () => Date;
  // The round's request count; tests lower it.
  requests?: number;
}

// Sweeps the inboxes, the one swept longest ago first, within SWEEP_REQUESTS_PER_ROUND requests to
// Chatwoot: what does not fit waits for the next round, first in line. Each inbox tried records the
// attempt at once, so one cut short does not come back first. The pins are asked once per account
// before the inboxes and once after, and the cursors move at the end, only where the account's pins
// held. Answers the names of the inboxes whose listing failed, whose cursor stays.
export async function sweepInboxes(
  base: PrismaClient,
  m: MonitorKey,
  inboxes: SweepInbox[],
  deps: SweepDeps,
): Promise<{ unlisted: string[] }> {
  const unlisted: string[] = [];
  if (inboxes.length === 0) return { unlisted };
  const cursors = new Map(
    (
      await runScopedOn(base, sysCtx(m.tenantId), (db) =>
        db.occurrenceSweepCursor.findMany({
          where: {
            monitorId: m.monitorId,
            inboxId: { in: inboxes.map((i) => i.id) },
          },
          select: { inboxId: true, activityAt: true, sweptAt: true },
        }),
      )
    ).map((c) => [c.inboxId, c]),
  );
  const order = [...inboxes].sort(
    (a, b) =>
      (cursors.get(a.id)?.sweptAt?.getTime() ?? 0) -
        (cursors.get(b.id)?.sweptAt?.getTime() ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const budget = { left: deps.requests ?? SWEEP_REQUESTS_PER_ROUND };
  const accounts = new Map<
    bigint,
    { client: ChatwootClient; pinned: Set<number> }
  >();
  // Inboxes whose whole listing fit in one page, and the newest activity it showed.
  const moves: Array<{ inbox: SweepInbox; top: Date }> = [];
  for (const inbox of order) {
    if (deps.signal.aborted) break;
    let account = accounts.get(inbox.chatwootInstanceId);
    // A new account takes its two pin requests and one page; an inbox of one already asked, a page.
    if (budget.left < (account ? 1 : 3)) break;
    const sweptAt = deps.now();
    try {
      await saveCursor(base, m, inbox.id, undefined, sweptAt);
      if (!account) {
        const client = await deps.clientOf(inbox.chatwootInstanceId);
        // The pins before, and the ones after, kept for the end.
        budget.left -= 2;
        account = { client, pinned: await client.listPinnedConversationIds() };
        accounts.set(inbox.chatwootInstanceId, account);
      }
      const cursor = cursors.get(inbox.id)?.activityAt ?? null;
      const floor =
        cursor && cursor > deps.windowStart ? cursor : deps.windowStart;
      const { rows, onePage } = await listInbox(
        account.client,
        inbox,
        account.pinned,
        floor,
        budget,
      );
      await enqueue(base, m, inbox, rows);
      // The newest activity listed, so the next listing stops where this one started; ties at the
      // cursor are listed again, which queues nothing new.
      const top = rows.reduce<Date | undefined>(
        (max, r) => (max && max >= r.activityAt ? max : r.activityAt),
        undefined,
      );
      if (onePage && top) moves.push({ inbox, top });
      await markUnlisted(base, m, inbox.id, null);
    } catch (err) {
      if (deps.signal.aborted) break;
      logger.warn(
        {
          tenantId: String(m.tenantId),
          inboxId: String(inbox.id),
          err,
        },
        "occurrence sweep: the inbox could not be listed from Chatwoot",
      );
      unlisted.push(inbox.name);
      await markUnlisted(base, m, inbox.id, deps.now()).catch(() => undefined);
    }
  }
  // A pin made during the sweep leads its account's listings as an old row the first answer did not
  // name, which can end one before rows nobody saw: that account's cursors stay.
  for (const [instanceId, account] of accounts) {
    if (deps.signal.aborted) break;
    const after = await account.client
      .listPinnedConversationIds()
      .catch(() => null);
    const held =
      after !== null &&
      after.size === account.pinned.size &&
      [...account.pinned].every((id) => after.has(id));
    if (!held) continue;
    for (const { inbox, top } of moves)
      if (inbox.chatwootInstanceId === instanceId)
        await saveCursor(base, m, inbox.id, top, deps.now()).catch(
          () => undefined,
        );
  }
  return { unlisted };
}

// The monitored inboxes, split by whether an agent receives them right now (bound, or observing): the
// webhook feeds the mirror of the first, and the sweep lists the others from Chatwoot.
export async function splitInboxes(
  base: PrismaClient,
  tenantId: bigint,
  inboxIds: string[],
): Promise<{ received: string[]; swept: SweepInbox[] }> {
  if (inboxIds.length === 0) return { received: [], swept: [] };
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.inbox.findMany({
      where: { tenantId, id: { in: inboxIds.map(BigInt) } },
      select: {
        id: true,
        name: true,
        agentId: true,
        chatwootInstanceId: true,
        chatwootInboxId: true,
        instance: { select: { disconnectedAt: true } },
        _count: { select: { observers: true } },
      },
    }),
  );
  const received: string[] = [];
  const swept: SweepInbox[] = [];
  for (const r of rows) {
    if (r.agentId !== null || r._count.observers > 0)
      received.push(String(r.id));
    // A disconnected account's bindings are gone, and nothing of it is read from Chatwoot.
    else if (r.instance.disconnectedAt !== null) continue;
    else
      swept.push({
        id: r.id,
        name: r.name,
        chatwootInstanceId: r.chatwootInstanceId,
        chatwootInboxId: r.chatwootInboxId,
      });
  }
  return { received, swept };
}

// How long one sweep may take: a minute short of the scheduler's deadline for the run, as the round.
export const SWEEP_BUDGET_MS = jobDeadlineMs(SCHEDULER_STALE_MS) - 60_000;

export interface OccurrenceSweepDeps {
  base?: PrismaClient;
  now?: () => Date;
  signal?: AbortSignal;
  makeChatwootClient?: LoadChatwootClientDeps["makeClient"];
  // The sweep's request count; tests lower it.
  requests?: number;
}

// One sweep of a monitor's inboxes no agent receives, asked now, not from the saved list: one that
// lost its agent since it was listed is swept from then on, and one that got one is not.
export async function runOccurrenceSweep(
  m: MonitorKey,
  cfg: OccurrencesConfig,
  deps: OccurrenceSweepDeps = {},
): Promise<{ unlisted: string[] }> {
  if (cfg.fields.length === 0 || cfg.inboxIds.length === 0)
    return { unlisted: [] };
  const base = deps.base ?? basePrisma;
  const now = deps.now ?? (() => new Date());
  const { swept } = await splitInboxes(base, m.tenantId, cfg.inboxIds);
  if (swept.length === 0) return { unlisted: [] };
  const signal = AbortSignal.any([
    ...(deps.signal ? [deps.signal] : []),
    AbortSignal.timeout(SWEEP_BUDGET_MS),
  ]);
  const clients = new Map<bigint, Promise<ChatwootClient>>();
  const clientOf = (inst: bigint) => {
    let c = clients.get(inst);
    if (!c) {
      c = loadChatwootClient(m.tenantId, inst, {
        base,
        expiresOn: signal,
        ...(deps.makeChatwootClient
          ? { makeClient: deps.makeChatwootClient }
          : {}),
      });
      clients.set(inst, c);
    }
    return c;
  };
  return sweepInboxes(base, m, swept, {
    clientOf,
    signal,
    windowStart: new Date(now().getTime() - cfg.windowMinutes * 60_000),
    now,
    ...(deps.requests !== undefined ? { requests: deps.requests } : {}),
  });
}

// The job, one per monitor, beside its round. ON: sweep and re-arm one cadence later. OFF, or
// deleted: end the loop; the save that switches it on arms it again. It never throws.
export async function occurrenceSweepHandler(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
  deps: Omit<OccurrenceSweepDeps, "base"> = {},
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
      "occurrence sweep: the monitor could not be read; asking again in a minute",
    );
    return { outcome: "reschedule", runAt: new Date(now().getTime() + 60_000) };
  }
  if (!cfg?.enabled) return { outcome: "done" };
  try {
    jobCtx?.commit();
    await runOccurrenceSweep({ tenantId: job.tenantId, monitorId }, cfg, {
      ...deps,
      base,
      now,
      ...(jobCtx ? { signal: jobCtx.signal } : {}),
    });
  } catch (err) {
    logger.warn(
      { err, tenantId: String(job.tenantId), monitorId: String(monitorId) },
      "occurrence sweep failed",
    );
  }
  return {
    outcome: "reschedule",
    runAt: new Date(now().getTime() + cfg.cadenceMinutes * 60_000),
  };
}

let registered = false;
export function registerOccurrenceSweepHandler(): void {
  if (registered) return;
  registerJobHandler("OCCURRENCE_SWEEP", (job, base, jobCtx) =>
    occurrenceSweepHandler(job, base, {}, jobCtx),
  );
  registered = true;
}
