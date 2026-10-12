import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { armCompaction } from "@/modules/memory/compact";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { type IngestRole, ingestMessageIntoThread } from "./ingest";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Continuous ingestion as a scheduler job rather than an append inline with the webhook ack. Not for
// retries: an inline append has nowhere to defer TO. An invoke is a read-modify-write of the whole
// channel, so a message appended mid-turn is erased when the turn saves, and blocking the ack until
// the turn ends does not fit its time budget; a row can be put down and retried in a minute. The text
// is encrypted at rest (`encryptJson`), since the receiver keeps message bodies, which are PII, out of
// the database (docs/chatwoot.md); carrying only a reference would cost a Chatwoot round-trip and a
// credential per ingestion. It is the RENDERED text (../modules/chatwoot/render.ts): it folds in the
// eager media pass, which the job cannot re-derive from a Chatwoot that has moved on.

const DEFER_ON_TURN_MS = 60_000;

// One row per MESSAGE: `enqueueJob` keeps one live row per (tenant, kind, dedupeKey) and a re-enqueue
// REPLACES the payload, so a key scoped to the thread would let a burst's second message overwrite
// the first. Chatwoot message ids are unique per account, so thread and id name exactly one append.
// Exported so tests ask for the key instead of rebuilding its format or counting the tenant's rows,
// which this module deletes on DONE and `drainPendingIngest` drains.
export function ingestDedupeKey(
  graphThreadId: string,
  messageId: number,
): string {
  return `${ingestKeyPrefix(graphThreadId)}${messageId}`;
}

// The fallback's own key, one per message like the append's.
export function ingestFallbackKey(
  graphThreadId: string,
  messageId: number,
): string {
  return `${ingestFallbackKeyPrefix(graphThreadId)}${messageId}`;
}

// The fallback holds the message body too, so `/reset` sweeps this prefix beside the append's.
export function ingestFallbackKeyPrefix(graphThreadId: string): string {
  return `ingest-fallback:${graphThreadId}:`;
}

// Everything up to the message id, built in one place because three readers need the prefix: the
// drain scans it, and the `/reset` revoke sweeps it and READS the id back off the key. A hand-written
// copy that drifted from the key's shape would leave the revoke unable to parse any key, and its
// unreadable case deletes, silently revoking the thread's whole queue. The trailing colon is
// load-bearing: without it thread `…:ci:10`'s prefix also matches `…:ci:100`'s rows.
export function ingestKeyPrefix(graphThreadId: string): string {
  return `ingest:${graphThreadId}:`;
}

export interface ArmIngestParams {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  contactInboxId: number;
  graphThreadId: string;
  messageId: number;
  text: string;
  role: IngestRole;
  // When Chatwoot recorded the message. Optional because a caller that does not know
  // must say nothing rather than "now", and a row armed without one carries none.
  sentAt?: Date | null;
  agentId: bigint;
  compactionEnabled: boolean;
  // A FALLBACK for the append, due this far in the future: a watcher that left the append to the
  // memory owner keeps the message recoverable without writing a memory line of its own. Absent, the
  // ordinary arm.
  fallbackAfterMs?: number;
  // The webhook event that armed the fallback: only a settled delivery of the SAME event stands in for
  // it, since a creation the owner settled with nothing to append (an empty message whose audio comes
  // in a `message_updated`) says nothing about the content that came later.
  event?: string;
  // The Chatwoot bot routes of the owner and of the watcher that armed the fallback. A message can
  // take several `message_updated`, and the owner settles the ones with nothing to append just as it
  // settles the one with the words, so one settled delivery of the event proves nothing about the
  // later update: the fallback stands down only once the owner settled as many as this route received.
  routes?: { owner: number; watcher: number };
  base?: PrismaClient;
}

export async function armIngest(params: ArmIngestParams): Promise<void> {
  const fallback = params.fallbackAfterMs !== undefined;
  const payloadSecret = encryptJson(params.text);
  const payload = {
    instanceId: String(params.instanceId),
    conversationId: params.conversationId,
    contactInboxId: params.contactInboxId,
    graphThreadId: params.graphThreadId,
    messageId: params.messageId,
    role: params.role,
    ...(params.sentAt && Number.isFinite(params.sentAt.getTime())
      ? { sentAt: params.sentAt.toISOString() }
      : {}),
    agentId: String(params.agentId),
    compactionEnabled: params.compactionEnabled,
    ...(fallback && params.event !== undefined ? { event: params.event } : {}),
    ...(fallback && params.routes !== undefined
      ? {
          ownerBotId: params.routes.owner,
          watcherBotId: params.routes.watcher,
        }
      : {}),
  };
  await enqueueJob({
    tenantId: params.tenantId,
    // NOTE: A fallback is a kind of its own and not a deferred append: it is no memory line until it
    // runs, and then it only arms the ordinary append if none exists (`fallbackHandler`).
    kind: fallback ? "INGEST_FALLBACK" : "INGEST_MESSAGE",
    dedupeKey: fallback
      ? ingestFallbackKey(params.graphThreadId, params.messageId)
      : ingestDedupeKey(params.graphThreadId, params.messageId),
    // NOTE: The key names ONE message, so a re-arm is that same append being armed again, never a
    // second one. The row is also deleted on DONE (JOB_DELETE_ON_DONE), so a completed ingest
    // leaves nothing for a later arm to inherit in the first place.
    // A redelivery of the deferring watcher leaves its fallback's run time as it was, rather than
    // pushing it later each time; its body is refreshed below.
    rearm: fallback ? "once" : "same-work",
    // NOTE: now: the fast tick drains this lane, and what waits behind a queued ingestion is the next
    // turn's context rather than a customer reading a reply. A fallback waits for the owner's own.
    runAt: new Date(Date.now() + (params.fallbackAfterMs ?? 0)),
    // NOTE: the ciphertext travels in its OWN column, never in `payload`: that is a Prisma `Json`
    // column, and an `encryptJson` blob does not go in one (CLAUDE.md, Encryption). A Json payload is
    // the thing that gets logged or serialized whole, and it would carry a contact's own words with it.
    payloadSecret,
    payload,
    base: params.base,
  });
  if (!fallback) return;
  // A later arm of a fallback still waiting (a transcription update after the unread marker) carries
  // the newer text: the body is refreshed and the run time is left as it was.
  const key = {
    tenantId: params.tenantId,
    kind: "INGEST_FALLBACK" as const,
    dedupeKey: ingestFallbackKey(params.graphThreadId, params.messageId),
  };
  const db = params.base ?? basePrisma;
  const refreshed = await runScopedOn(db, sysCtx(params.tenantId), (tx) =>
    tx.schedulerJob.updateMany({
      where: { ...key, status: "PENDING" },
      data: { payload, payloadSecret },
    }),
  );
  if (refreshed.count > 0) return;
  // No fallback left waiting: one already claimed carries the older body to the append it is about to
  // write. Re-armed as the same work, its row goes back to pending with the newer text and the claimed
  // run stands down at the append's fence (`stillWanted`, on the row's status and claim). One already
  // run is re-armed the same way, and its append then refuses an id already folded in. Not where the
  // ledger says some route queued the message.
  if (await fallbackCovered(params.tenantId, payload, db)) return;
  await enqueueJob({
    tenantId: params.tenantId,
    kind: "INGEST_FALLBACK",
    dedupeKey: key.dedupeKey,
    rearm: "same-work",
    runAt: new Date(),
    payloadSecret,
    payload,
    base: params.base,
  });
}

// BigInts do not survive JSON, so they travel as strings and are read back here. `tenantId` is NOT
// among them: it comes from the job ROW, which is what the scheduler scopes the handler with, and a
// payload-carried copy would be a second source of truth for a tenant fence. A payload this
// process cannot read will never become readable, so it is DONE rather than failed: retrying it only
// delays the dead-letter without changing the outcome.
type IngestPayload = Omit<ArmIngestParams, "tenantId" | "base">;

function parsePayload(
  payload: Record<string, unknown>,
  payloadSecret: string | null | undefined,
): IngestPayload | null {
  const s = (k: string) =>
    typeof payload[k] === "string" ? (payload[k] as string) : null;
  const n = (k: string) =>
    typeof payload[k] === "number" ? (payload[k] as number) : null;
  const instanceId = s("instanceId");
  const agentId = s("agentId");
  const graphThreadId = s("graphThreadId");
  // NOTE: THROWS on a missing secret, the guard for the column being optional on ClaimedJob: a query
  // that forgot to select it fails loudly instead of folding an empty message into a contact's
  // permanent memory. Decryption sits outside the shape check for the same reason: an unreadable body
  // is a real failure (a rotated key), so the job retries and dead-letters visibly.
  if (payloadSecret == null) {
    throw new Error("ingest: the job carries no message body");
  }
  const text = decryptJson<string>(payloadSecret);
  const role = s("role");
  const conversationId = n("conversationId");
  const contactInboxId = n("contactInboxId");
  const messageId = n("messageId");
  const sentAtRaw = s("sentAt");
  const sentAt = sentAtRaw === null ? null : new Date(sentAtRaw);
  if (
    instanceId === null ||
    agentId === null ||
    graphThreadId === null ||
    (role !== "customer" && role !== "human_agent") ||
    conversationId === null ||
    contactInboxId === null ||
    messageId === null
  ) {
    return null;
  }
  return {
    // biome-ignore lint/plugin/no-bigint-cast: a scheduler job payload this app enqueued; the shape is guarded above the cast.
    instanceId: BigInt(instanceId),
    conversationId,
    contactInboxId,
    graphThreadId,
    messageId,
    text,
    role,
    sentAt: sentAt && Number.isFinite(sentAt.getTime()) ? sentAt : null,
    // biome-ignore lint/plugin/no-bigint-cast: same payload, same guard.
    agentId: BigInt(agentId),
    compactionEnabled: payload.compactionEnabled === true,
  };
}

export async function ingestHandler(
  job: ClaimedJob,
  base: PrismaClient,
  // Test seam, exactly as ./ingest.ts takes one. The extra optional parameter keeps this assignable
  // to `JobHandler`, so the registration below is unchanged and production still resolves the real
  // PostgresSaver.
  checkpointer?: BaseCheckpointSaver,
  // A further condition asked with the claim's, inside the append's critical section: the fallback's
  // "nobody queued this message", so it is answered in the thread's own order (`fallbackHandler`).
  alsoWanted?: () => Promise<boolean>,
): Promise<JobResult> {
  const p = parsePayload(job.payload, job.payloadSecret);
  if (!p) return { outcome: "done" };
  const tenantId = job.tenantId;

  // The deferral this job exists for, asked for with a flag rather than checked here. It has to
  // be decided under the `ingest:<thread>` lock inside ./ingest.ts to be exclusive with a turn marking
  // itself; a check out here would only be staggered, since the turn can take the lock, mark itself
  // and release it between our check and the append.
  const outcome = await ingestMessageIntoThread({
    deferIfTurnInFlight: true,
    // NOTE: the generation fence. A claimed ingestion waiting on a memory reset's own lock would
    // append pre-reset text once it is released, recreating the thread row and the checkpoint after
    // the operator was told the reset succeeded. The token is the row, read under the lock: a revoked
    // job is no longer CLAIMED by this run, and `claimSeq` catches a re-enqueue (a duplicate delivery)
    // that re-armed the row, whose later run carries the same message. Its own short transaction, since
    // the section holds none while this runs; what matters is that it runs INSIDE the critical section.
    stillWanted: async () => {
      const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.schedulerJob.findUnique({
          where: { id: job.id },
          select: { status: true, claimSeq: true },
        }),
      );
      if (row?.status !== "CLAIMED" || row.claimSeq !== job.claimSeq)
        return false;
      return alsoWanted === undefined || (await alsoWanted());
    },
    tenantId,
    instanceId: p.instanceId,
    conversationId: p.conversationId,
    contactInboxId: p.contactInboxId,
    graphThreadId: p.graphThreadId,
    messageId: p.messageId,
    text: p.text,
    role: p.role,
    sentAt: p.sentAt,
    base,
    ...(checkpointer ? { checkpointer } : {}),
    onAttendanceClosed: (previousConversationId) =>
      armCompaction({
        tenantId,
        instanceId: p.instanceId,
        contactInboxId: p.contactInboxId,
        conversationId: previousConversationId,
        agentId: p.agentId,
        reason: "new_attendance",
        enabled: p.compactionEnabled,
        base,
      }).then(() => undefined),
  });

  // NOTE: `reschedule` rather than `fail`: waiting on a turn is not an error and must not consume an
  // attempt, or a contact in a long conversation would dead-letter their own message.
  if (outcome === "deferred") {
    logger.info(
      "ingest: a turn is in flight (thread=%s), deferring message %s",
      p.graphThreadId,
      String(p.messageId),
    );
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + DEFER_ON_TURN_MS),
    };
  }
  // The message is in memory now, so a watcher's fallback still waiting for it has nothing left to
  // do. Left there, it would arm a second append ten minutes on, which a thread that moved past the
  // dedup window could no longer tell apart from a lost one. One already running arms an append the
  // dedup still refuses.
  if (outcome === "ingested") {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.schedulerJob.deleteMany({
        where: {
          tenantId,
          kind: "INGEST_FALLBACK",
          dedupeKey: ingestFallbackKey(p.graphThreadId, p.messageId),
          status: "PENDING",
        },
      }),
    );
    await dueOlderFallbacks(tenantId, p.graphThreadId, p.messageId, base);
  }
  return { outcome: "done" };
}

// A watcher's fallback for the memory owner's append (../modules/chatwoot/webhook.ts): appends the
// message itself, in its own run, only where no route queued it. The owner's append wins: a settled
// owner delivery on the ledger, or the owner's append still queued, and the fallback does nothing.
// Appending here rather than arming a new append keeps the fallback's place in the queue: its row was
// created when the message arrived, so a claim that takes the oldest first reaches it before the newer
// appends queued meanwhile, which could otherwise push its id past the dedup window's floor. The
// append's own fences apply as for any ingestion: the claim (`stillWanted`), the reset boundary, the
// dedup window.
export async function fallbackHandler(
  job: ClaimedJob,
  base: PrismaClient,
  checkpointer?: BaseCheckpointSaver,
): Promise<JobResult> {
  const p = job.payload as Record<string, unknown>;
  const graphThreadId =
    typeof p.graphThreadId === "string" ? p.graphThreadId : null;
  const messageId = typeof p.messageId === "number" ? p.messageId : null;
  if (graphThreadId === null || messageId === null || job.payloadSecret == null)
    return { outcome: "done" };
  // Asked inside the append's critical section, not before it: awaited out here, a newer append
  // started in the same tick would take the thread's queue first, and enough of them would push this
  // message past the dedup window's floor.
  const nobodyQueuedIt = async () => {
    if (await fallbackCovered(job.tenantId, p, base)) return false;
    const queued = await runScopedOn(base, sysCtx(job.tenantId), (db) =>
      db.schedulerJob.findFirst({
        where: {
          tenantId: job.tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: ingestDedupeKey(graphThreadId, messageId),
          status: { in: ["PENDING", "CLAIMED"] },
        },
        select: { id: true },
      }),
    );
    return queued === null;
  };
  return ingestHandler(job, base, checkpointer, nobodyQueuedIt);
}

// Whether some route already queued this message: a settled delivery of it, on the fallback's event, whose
// claim records `route_remembers = true`. That statement is written just before the append is armed
// and moved back to `false` when the append fails, so with the delivery settled it is the durable
// answer to "did the owner write it", where the dedup window is not: a thread that took more messages since has forgotten the
// id, and an append of it would be reported as one that cannot be decided.
async function fallbackCovered(
  tenantId: bigint,
  p: Record<string, unknown>,
  base: PrismaClient,
): Promise<boolean> {
  const instanceId = parseDbId(
    typeof p.instanceId === "string" ? p.instanceId : null,
  );
  const conversationId =
    typeof p.conversationId === "number" ? p.conversationId : null;
  const messageId = typeof p.messageId === "number" ? p.messageId : null;
  if (instanceId === null || conversationId === null || messageId === null)
    return false;
  const ofMessage = {
    tenantId,
    chatwootInstanceId: instanceId,
    conversationId,
    inboundMessageId: messageId,
    ...(typeof p.event === "string" ? { event: p.event } : {}),
  };
  // Settled, not just claimed: the flag is written just before the append is armed, and a delivery
  // settles only once its message is queued. A crash in between leaves PROCESSING.
  const settledRemembering = {
    routeRemembers: true,
    status: "PROCESSED" as const,
  };
  if (typeof p.ownerBotId === "number" && typeof p.watcherBotId === "number") {
    const ownerBotId = p.ownerBotId;
    const watcherBotId = p.watcherBotId;
    // Counted per route, one row per Chatwoot delivery: an owner that settled the update without the
    // words and stranded the one carrying them has settled fewer than this route received.
    const [settled, received] = await runScopedOn(
      base,
      sysCtx(tenantId),
      (db) =>
        Promise.all([
          db.chatwootWebhookDelivery.count({
            where: {
              ...ofMessage,
              routeAgentBotId: ownerBotId,
              ...settledRemembering,
            },
          }),
          db.chatwootWebhookDelivery.count({
            where: { ...ofMessage, routeAgentBotId: watcherBotId },
          }),
        ]),
    );
    return settled > 0 && settled >= received;
  }
  const stated = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.findFirst({
      where: { ...ofMessage, ...settledRemembering },
      select: { id: true },
    }),
  );
  return stated !== null;
}

// A newer message on the thread is in memory, so the dedup window moved on: a fallback still waiting
// for an OLDER one comes due now rather than ten minutes on, when enough newer appends could have
// pushed its id below the window's floor and made its append read as `ancient`. Its handler still
// asks the ledger first, so one the owner did queue arms nothing.
async function dueOlderFallbacks(
  tenantId: bigint,
  graphThreadId: string,
  messageId: number,
  base: PrismaClient,
): Promise<void> {
  const prefix = ingestFallbackKeyPrefix(graphThreadId);
  const waiting = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "INGEST_FALLBACK",
        status: "PENDING",
        dedupeKey: { startsWith: prefix },
        runAt: { gt: new Date() },
        // Only the ones waiting for the owner: one that already failed is in backoff and keeps its
        // retry time.
        attempts: 0,
      },
      select: { id: true, dedupeKey: true },
    }),
  );
  const older = waiting
    .filter((row) => {
      const id = Number(row.dedupeKey.slice(prefix.length));
      return Number.isSafeInteger(id) && id < messageId;
    })
    .map((row) => row.id);
  if (older.length === 0) return;
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.updateMany({
      where: { id: { in: older }, status: "PENDING" },
      data: { runAt: new Date() },
    }),
  );
}

// The barrier's half of the same question (./ingest-drain.ts): a fallback still waiting whose message
// some route already stated it appends is deleted rather than counted as owed, so a redundant one
// does not hold compaction open until it comes due.
export async function retireCoveredFallbacks(
  tenantId: bigint,
  graphThreadId: string,
  base: PrismaClient,
): Promise<void> {
  const waiting = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "INGEST_FALLBACK",
        status: "PENDING",
        dedupeKey: { startsWith: ingestFallbackKeyPrefix(graphThreadId) },
      },
      select: { id: true, payload: true, payloadSecret: true },
    }),
  );
  for (const row of waiting) {
    if (
      !(await fallbackCovered(
        tenantId,
        (row.payload ?? {}) as Record<string, unknown>,
        base,
      ))
    )
      continue;
    // NOTE: only the body that was checked: a later arm refreshes the row in place (a transcription
    // update, another event), and the ledger answered about the event read above. Each arm encrypts
    // anew, so the ciphertext names the version.
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.schedulerJob.deleteMany({
        where: {
          id: row.id,
          status: "PENDING",
          payloadSecret: row.payloadSecret,
        },
      }),
    );
  }
}

let registered = false;
export function registerIngestJob(): void {
  if (registered) return;
  registered = true;
  // NOTE: wrapped, because the handler's third parameter is a test seam and not the JobContext.
  registerJobHandler("INGEST_MESSAGE", (job, base) => ingestHandler(job, base));
  registerJobHandler("INGEST_FALLBACK", (job, base) =>
    fallbackHandler(job, base),
  );
}

registerIngestJob();
