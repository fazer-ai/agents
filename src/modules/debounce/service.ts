import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { upsertJobRow } from "@/modules/scheduler/service";
import { type DebounceConfig, readDebounceConfig } from "./settings";

// Debounce arming + config resolution. Arming re-uses the durable scheduler row (one live row per
// thread): each new inbound message pushes runAt forward (the coalescing window), capped at the
// anti-starvation ceiling measured from the burst's start. The DEBOUNCE job is drained by the
// dedicated fast worker; the flush (handler.ts) re-fetches and answers only the new burst.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function debounceDedupeKey(threadId: string): string {
  return `debounce:${threadId}`;
}

// Resolves the debounce config for the inbox's agent. Returns null when the agent is unbound,
// disabled, or has debounce turned off — the caller then takes the direct (no-coalesce) path.
export async function resolveDebounceConfig(
  tenantId: bigint,
  instanceId: bigint,
  chatwootInboxId: number,
  base: PrismaClient = basePrisma,
): Promise<DebounceConfig | null> {
  const cfg = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const inbox = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId,
        },
      },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { enabled: true, settings: true },
    });
    if (!agent?.enabled) return null;
    return readDebounceConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

// EXPORTED because the flush reads it too: it is the only anchor a deferral ceiling can use that a
// re-arm does not erase (see the ceiling in ./handler.ts).
export function readDeferringSince(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).deferringSince;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readBurstStart(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).burstStartedAt;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// The burst's newest known Chatwoot message id, kept in the job payload so a flush abandoned by the
// human-takeover gate can still advance the handled watermark without a network fetch.
export function readLastMessageId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).lastMessageId;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Whether any message of this burst is a customer's REACTION. The fork's default page
// carries a reaction only when the message it reacts to is among the page's last twenty of the same
// conversation, so the flush cannot learn from the page that one is missing. The arm can: it saw the
// webhook. Sticky across the burst's arms, and across a flush still running, so a text typed after an
// orphan reaction does not hide it.
export function readReactionArmed(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as Record<string, unknown>).reactionArmed === true;
}

// The id of the burst's EARLIEST reaction. A conversation the agent never answered has no mark to
// catch up from, and the id that armed the flush last may be a text typed after the reaction, which
// would read past it. The flush catches up from here instead.
export function readReactionFrom(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).reactionFrom;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Whether the thread's debounce row carries a reaction right now. The post gate asks it: a reaction that arrives while a turn runs re-arms this row with the mark, and the
// default page the gate reads would not carry it, so the turn would post over it instead of yielding
// to the flush it armed. A database read, so the common post pays no extra Chatwoot call.
export async function reactionArmedOnThread(params: {
  tenantId: bigint;
  threadId: string;
  base?: PrismaClient;
}): Promise<boolean> {
  const base = params.base ?? basePrisma;
  const row = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.schedulerJob.findFirst({
      where: {
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(params.threadId),
      },
      select: { payload: true },
    }),
  );
  return row !== null && readReactionArmed(row.payload);
}

// Stamps when a burst STARTED waiting for a busy thread, if it is not stamped already. Under
// `armDebounce`'s lock rather than a `payloadPatch` on `rescheduleJob`: that CAS needs the row still
// CLAIMED, and a message arriving mid-flush re-arms it to PENDING, so the stamp would be dropped and
// the deadline restarted on every arrival. With the shared lock either order merges. Never
// overwrites: the deadline belongs to the FIRST deferral.
export async function stampDeferral(params: {
  tenantId: bigint;
  threadId: string;
  since: number;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  const dedupeKey = debounceDedupeKey(params.threadId);
  await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    withEntityLock(db, `debounce-arm:${params.threadId}`, async () => {
      const row = await db.schedulerJob.findFirst({
        where: { kind: "DEBOUNCE", dedupeKey },
        select: { id: true, payload: true },
      });
      // No row means the flush that is deferring has already been completed or retired by somebody
      // else; there is nothing whose deadline this would be.
      if (!row || readDeferringSince(row.payload) !== null) return;
      await db.schedulerJob.update({
        where: { id: row.id },
        data: {
          payload: {
            ...(row.payload as Prisma.InputJsonObject),
            deferringSince: params.since,
          },
        },
      });
    }),
  );
}

// Drops the deferral stamp once the waiting it measured is over. Otherwise a re-arm during the
// flush carries the stamp into the NEW burst (the completion CAS needs a CLAIMED row, so it cannot
// clear it), and once older than the ceiling every later flush skips the busy-thread check. Under the
// arm lock, like the stamp, so a racing re-arm cannot resurrect what this removed.
export async function clearDeferral(params: {
  tenantId: bigint;
  threadId: string;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  const dedupeKey = debounceDedupeKey(params.threadId);
  await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    withEntityLock(db, `debounce-arm:${params.threadId}`, async () => {
      const row = await db.schedulerJob.findFirst({
        where: { kind: "DEBOUNCE", dedupeKey },
        select: { id: true, payload: true },
      });
      if (!row || readDeferringSince(row.payload) === null) return;
      const { deferringSince: _dropped, ...rest } = row.payload as Record<
        string,
        unknown
      >;
      await db.schedulerJob.update({
        where: { id: row.id },
        data: { payload: rest as Prisma.InputJsonObject },
      });
    }),
  );
}

export interface ArmDebounceParams {
  tenantId: bigint;
  threadId: string;
  agentBotId: number | null;
  cfg: DebounceConfig;
  // Chatwoot id of the inbound message arming this flush (see readLastMessageId). Optional: an arm
  // without it keeps the burst's previous high-water mark.
  lastMessageId?: number;
  // Whether the arming message is a customer's reaction: see `readReactionArmed`.
  reaction?: boolean;
  base?: PrismaClient;
  now?: Date;
}

// Re-arms the per-thread DEBOUNCE job: runAt = min(now + window, burstStart + maxWindow). The first
// message of a burst stamps burstStartedAt; subsequent ones keep it (so the anti-starvation cap is
// measured from the start). Serialized per thread by an advisory lock so concurrent deliveries for
// the same conversation cannot lose the burst-start stamp. instanceId/conversationId are recoverable
// from threadId, so the payload stays JSON-safe (no bigint). Returns the computed flush time so the
// caller can surface a live countdown on the realtime "waiting for more messages" indicator.
export async function armDebounce(params: ArmDebounceParams): Promise<Date> {
  const { tenantId, threadId, agentBotId, cfg } = params;
  const base = params.base ?? basePrisma;
  const nowMs = (params.now ?? new Date()).getTime();
  const dedupeKey = debounceDedupeKey(threadId);
  return runScopedOn(base, sysCtx(tenantId), (db) =>
    withEntityLock(db, `debounce-arm:${threadId}`, async () => {
      const existing = await db.schedulerJob.findFirst({
        where: { kind: "DEBOUNCE", dedupeKey },
        select: { status: true, payload: true },
      });
      // NOTE: The deferral deadline survives re-arms of a LIVE row (PENDING or CLAIMED), unlike
      // `burstStartedAt`, which a claim in flight resets: it measures how long the burst has waited
      // for a busy thread, which a customer typing again must not restart. A DONE or DEAD row carries
      // nothing, or the next burst would start out already past its deadline.
      const stillLive =
        existing?.status === "PENDING" || existing?.status === "CLAIMED";
      const deferringSince = stillLive
        ? readDeferringSince(existing.payload)
        : null;
      // NOTE: A live PENDING row is the burst this message joins; anything else (no row, DONE,
      // DEAD, or a claim in flight) means the previous flush is finished business and this message
      // opens a new burst. Every question below reads that one fact, so they cannot answer it
      // differently.
      const continuingBurst = existing?.status === "PENDING";
      const prevBurst = continuingBurst
        ? readBurstStart(existing.payload)
        : null;
      const burstStartedAt = prevBurst ?? nowMs;
      // High-water message id across the burst's arms (a fresh burst starts over, like burstStartedAt).
      const prevLast = continuingBurst
        ? readLastMessageId(existing.payload)
        : null;
      const lastCandidate = Math.max(prevLast ?? 0, params.lastMessageId ?? 0);
      const lastMessageId = lastCandidate > 0 ? lastCandidate : null;
      const reactionArmed =
        params.reaction === true ||
        (stillLive && readReactionArmed(existing.payload));
      // NOTE: Carried across a CLAIMED row too, like `deferringSince`: a text that arrives while the
      // reaction's flush runs supersedes that turn, and the flush it arms would find its own text on
      // the page and never ask for the reaction.
      const prevReactionFrom = stillLive
        ? readReactionFrom(existing.payload)
        : null;
      const ownReactionFrom =
        params.reaction === true && params.lastMessageId != null
          ? params.lastMessageId
          : null;
      const reactionFrom =
        prevReactionFrom === null
          ? ownReactionFrom
          : ownReactionFrom === null
            ? prevReactionFrom
            : Math.min(prevReactionFrom, ownReactionFrom);
      const runAtMs = Math.min(
        nowMs + cfg.windowSeconds * 1000,
        burstStartedAt + cfg.maxWindowSeconds * 1000,
      );
      const payload = {
        threadId,
        agentBotId,
        burstStartedAt,
        ...(lastMessageId !== null ? { lastMessageId } : {}),
        ...(reactionArmed ? { reactionArmed: true } : {}),
        ...(reactionFrom !== null ? { reactionFrom } : {}),
        ...(deferringSince !== null ? { deferringSince } : {}),
      } satisfies Prisma.InputJsonObject;
      await upsertJobRow(db, {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey,
        runAt: new Date(runAtMs),
        payload,
        // NOTE: A new burst is new work with fresh attempts (the key is the THREAD, reused by every
        // burst); a message joining the open burst is the SAME flush pushed out, and must not hand
        // one waiting on its backoff more attempts.
        rearm: continuingBurst ? "same-work" : "new-work",
      });
      return new Date(runAtMs);
    }),
  );
}
