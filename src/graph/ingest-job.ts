import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
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
  base?: PrismaClient;
}

export async function armIngest(params: ArmIngestParams): Promise<void> {
  await enqueueJob({
    tenantId: params.tenantId,
    kind: "INGEST_MESSAGE",
    dedupeKey: ingestDedupeKey(params.graphThreadId, params.messageId),
    // NOTE: The key names ONE message, so a re-arm is that same append being armed again, never a
    // second one. The row is also deleted on DONE (JOB_DELETE_ON_DONE), so a completed ingest
    // leaves nothing for a later arm to inherit in the first place.
    rearm: "same-work",
    // NOTE: now: the fast tick drains this lane, and what waits behind a queued ingestion is the next
    // turn's context rather than a customer reading a reply.
    runAt: new Date(),
    // NOTE: the ciphertext travels in its OWN column, never in `payload`: that is a Prisma `Json`
    // column, and an `encryptJson` blob does not go in one (CLAUDE.md, Encryption). A Json payload is
    // the thing that gets logged or serialized whole, and it would carry a contact's own words with it.
    payloadSecret: encryptJson(params.text),
    payload: {
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
    },
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
    instanceId: BigInt(instanceId),
    conversationId,
    contactInboxId,
    graphThreadId,
    messageId,
    text,
    role,
    sentAt: sentAt && Number.isFinite(sentAt.getTime()) ? sentAt : null,
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
): Promise<JobResult> {
  const p = parsePayload(job.payload, job.payloadSecret);
  if (!p) return { outcome: "done" };
  const tenantId = job.tenantId;

  // NOTE: the deferral this job exists for, asked for with a flag rather than checked here. It has to
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
      return row?.status === "CLAIMED" && row.claimSeq === job.claimSeq;
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
  return { outcome: "done" };
}

let registered = false;
export function registerIngestJob(): void {
  if (registered) return;
  registered = true;
  // NOTE: wrapped, because the handler's third parameter is a test seam and not the JobContext.
  registerJobHandler("INGEST_MESSAGE", (job, base) => ingestHandler(job, base));
}

registerIngestJob();
