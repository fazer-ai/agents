import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { armCompaction } from "@/modules/memory/compact";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { type IngestRole, ingestMessageIntoThread } from "./ingest";

// Continuous ingestion as a scheduler job, instead of an append made inline while the webhook is
// being acked (issue #194).
//
// The reason is NOT retries, which is what a queue usually buys. It is that appending on arrival has
// nowhere to defer TO. A graph invoke is a read-modify-write of the whole message channel, so a
// message appended while a turn is in flight is erased when that turn saves — and on the inline path
// the only alternatives were to append anyway (the message is lost, and the thread's own record says
// it was handled) or to block the webhook until the turn finished, which is an ack we do not have
// the time budget for. With a row to come back to, the third answer exists: put it down and try
// again in a minute.
//
// THE TEXT IS ENCRYPTED AT REST. The receiver deliberately keeps message bodies out of our database
// — the delivery ledger stores status and never the payload, "which is PII" (docs/chatwoot.md) — and
// a durable job row is exactly the thing that would have quietly walked one back in, transcriptions
// and quoted context included. `encryptJson` is the same treatment every other secret at rest gets.
// It does not restore the stronger property the receiver has (the body never lands here at all);
// that would mean carrying only a reference and re-reading Chatwoot at run time, which is a provider
// round-trip on every ingestion and a credential this job does not otherwise need.
//
// WHAT THE PAYLOAD CARRIES, and why it is the rendered text rather than the raw message. Rendering
// folds in the eager media pass — transcription, image description, extracted text, quoted context —
// which has already run by the time the webhook reaches ingestion and which the job has no way to
// re-derive. Re-rendering later would also read a Chatwoot that has moved on. So the webhook renders
// and the job stores words, exactly as ../modules/chatwoot/render.ts produced them.

const DEFER_ON_TURN_MS = 60_000;

// One row per MESSAGE, and this is the field the dedupe key cannot leave out. `enqueueJob` keeps one
// live row per (tenant, kind, dedupeKey) and a re-enqueue REPLACES the payload, so a key scoped to
// the thread would let the second message of a burst overwrite the first — the same message loss
// this job exists to stop, moved one layer out. Chatwoot message ids are unique per account, so the
// thread and the id together name exactly one append.
function dedupeKey(graphThreadId: string, messageId: number): string {
  return `ingest:${graphThreadId}:${messageId}`;
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
  agentId: bigint;
  compactionEnabled: boolean;
  base?: PrismaClient;
}

export async function armIngest(params: ArmIngestParams): Promise<void> {
  await enqueueJob({
    tenantId: params.tenantId,
    kind: "INGEST_MESSAGE",
    dedupeKey: dedupeKey(params.graphThreadId, params.messageId),
    // Now: the fast tick drains this lane, and what waits behind a queued ingestion is the next
    // turn's context rather than a customer reading a reply.
    runAt: new Date(),
    payload: {
      instanceId: String(params.instanceId),
      conversationId: params.conversationId,
      contactInboxId: params.contactInboxId,
      graphThreadId: params.graphThreadId,
      messageId: params.messageId,
      text: encryptJson(params.text),
      role: params.role,
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

function parsePayload(payload: Record<string, unknown>): IngestPayload | null {
  const s = (k: string) =>
    typeof payload[k] === "string" ? (payload[k] as string) : null;
  const n = (k: string) =>
    typeof payload[k] === "number" ? (payload[k] as number) : null;
  const instanceId = s("instanceId");
  const agentId = s("agentId");
  const graphThreadId = s("graphThreadId");
  // Decryption is NOT part of the shape check below: a body we cannot read is a real failure (a
  // rotated key), and it throws so the job retries and then dead-letters visibly, rather than being
  // silently dropped as an unreadable payload.
  const encrypted = s("text");
  const text = encrypted === null ? null : decryptJson<string>(encrypted);
  const role = s("role");
  const conversationId = n("conversationId");
  const contactInboxId = n("contactInboxId");
  const messageId = n("messageId");
  if (
    instanceId === null ||
    agentId === null ||
    graphThreadId === null ||
    text === null ||
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
  const p = parsePayload(job.payload);
  if (!p) return { outcome: "done" };
  const tenantId = job.tenantId;

  // THE DEFERRAL THIS JOB EXISTS FOR, asked for with a flag rather than checked here. The decision
  // has to be taken under the `ingest:<thread>` lock to be exclusive with a turn marking itself, and
  // that lock lives inside ./ingest.ts — a check made out here would only be staggered: the turn can
  // take the lock, mark itself and release it between our check and the append.
  const outcome = await ingestMessageIntoThread({
    deferIfTurnInFlight: true,
    tenantId,
    instanceId: p.instanceId,
    conversationId: p.conversationId,
    contactInboxId: p.contactInboxId,
    graphThreadId: p.graphThreadId,
    messageId: p.messageId,
    text: p.text,
    role: p.role,
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

  // `reschedule` rather than `fail`: waiting on a turn is not an error and must not consume an
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
  registerJobHandler("INGEST_MESSAGE", ingestHandler);
}

registerIngestJob();
