import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  attendanceHasStarted,
  claimAttendanceBoundary,
  needsAttendanceStartProbe,
} from "./attendance-boundary";
import { getCheckpointer } from "./checkpointer";
import { isTurnInFlight } from "./inflight";
import { conversationDividerMessage, conversationStamp } from "./markers";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "./thread-state";

// Continuous ingestion: fold a customer message into the agent's graph memory thread WITHOUT running
// a model, so the agent has full context even for the messages no turn handled — the ones it stayed
// silent on, out of hours or while a human owned the conversation. The seam is graph.updateState,
// which appends to the thread's MessagesAnnotation channel via the same reducer the real turn uses.
//
// Customer messages only. A human agent's own reply is NOT ingested: `rt` is resolved solely for a
// new INCOMING message (src/modules/chatwoot/webhook.ts), so an outgoing one never reaches this
// module at all. That predates memory compaction and is tracked on its own; the branch that used to
// handle it here was code no delivery could run.
//
// At-most-once: the delivery ledger dedups re-deliveries, message_created gating ignores edits, and a
// monotonic per-thread watermark (AgentThread.lastSyncedMessageId, CAS under a per-thread advisory
// lock) is defense-in-depth against a re-delivery that slips a new delivery UUID. The lock also
// serializes concurrent ingestions on one thread so two appends can't clobber each other's checkpoint.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface IngestMessageParams {
  tenantId: bigint;
  instanceId: bigint;
  // Chatwoot display_id — only used for the per-thread "new conversation" divider marker.
  conversationId: number;
  // The native ContactInbox id: the AgentThread key (== the graph thread's discriminator).
  contactInboxId: number;
  // The graph memory thread to append to (tenant:instance:ci:<contactInboxId>).
  graphThreadId: string;
  // Chatwoot message id — the monotonic watermark guarding against re-append.
  messageId: number;
  // The message body: a rendered customer message (renderInboundMessage) or a human agent's raw text.
  text: string;
  base?: PrismaClient;
  checkpointer?: BaseCheckpointSaver;
  // Fired when this message OPENED a new attendance on the thread, carrying the display_id of the
  // one that just ended. A callback rather than a direct call because the work it triggers (arming
  // memory compaction) opens its own transaction, and this one runs under an advisory lock — so it
  // is invoked only after the lock is released.
  onAttendanceClosed?: (previousConversationId: number) => Promise<void> | void;
}

export async function ingestMessageIntoThread(
  params: IngestMessageParams,
): Promise<"ingested" | "skipped"> {
  const base = params.base ?? basePrisma;
  const {
    tenantId,
    instanceId,
    conversationId,
    contactInboxId,
    graphThreadId,
    messageId,
  } = params;
  if (!params.text.trim()) return "skipped";
  const checkpointer = params.checkpointer ?? (await getCheckpointer());
  const graph = buildThreadStateGraph(checkpointer);

  const done = await runScopedOn(base, sysCtx(tenantId), (db) =>
    withEntityLock(db, `ingest:${graphThreadId}`, async () => {
      const key = {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      };
      const row = await db.agentThread.findUnique({
        where: key,
        select: { lastSyncedMessageId: true, lastConversationId: true },
      });
      // Monotonic watermark: never re-append a message already folded into the thread.
      if (
        row?.lastSyncedMessageId != null &&
        messageId <= row.lastSyncedMessageId
      ) {
        return { outcome: "skipped" as const, closedConversationId: null };
      }

      // Which attendance this message belongs to, and what that costs the thread. One decision,
      // shared with the reactive turn and the proactive nudge (./attendance-boundary.ts). Human-agent
      // messages count as a start: an agent who opens the conversation sends its first message, and
      // skipping them here left that message sitting inside the PREVIOUS attendance, summarized and
      // removed with it when the customer finally replied.
      const prevConv = row?.lastConversationId ?? null;
      const anotherInvokeIsReading = isTurnInFlight(graphThreadId);
      const alreadyStarted = needsAttendanceStartProbe(
        prevConv,
        conversationId,
        anotherInvokeIsReading,
      )
        ? attendanceHasStarted(
            (
              (
                await graph.getState({
                  configurable: { thread_id: graphThreadId },
                })
              ).values as { messages?: BaseMessage[] } | undefined
            )?.messages ?? [],
            conversationId,
          )
        : false;
      const claim = claimAttendanceBoundary({
        previousConversationId: prevConv,
        conversationId,
        anotherInvokeIsReading,
        attendanceAlreadyStarted: alreadyStarted,
      });

      // Every message carries the conversation it belongs to, which is what the compaction cut reads.
      // The divider on top is prompt content, and goes through the factory because nothing else can
      // make a message COUNT as one — the text alone never does, or a customer could type it
      // (src/graph/markers.ts).
      const msg = claim.writeDivider
        ? conversationDividerMessage(conversationId, params.text)
        : new HumanMessage({
            content: params.text,
            additional_kwargs: conversationStamp(conversationId),
          });

      await graph.updateState(
        { configurable: { thread_id: graphThreadId } },
        { messages: [msg] },
        THREAD_STATE_NODE,
      );

      // Advance the watermark; customer messages also advance the divider marker (turns do the same).
      await db.agentThread.upsert({
        where: key,
        create: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
          threadId: graphThreadId,
          lastSyncedMessageId: messageId,
          lastConversationId: conversationId,
        },
        update: {
          lastSyncedMessageId: messageId,
          // Held back when the claim declined the boundary (./attendance-boundary.ts). The synced
          // watermark still advances — it guards at-most-once append, and rewinding it would trade a
          // lost divider for a duplicated message.
          lastConversationId: claim.advanceMarker ? conversationId : prevConv,
        },
      });
      return {
        outcome: "ingested" as const,
        // Armed even when the boundary was not consumed. The attendance that just ended is
        // compactable right now — its boundary lives on the messages, not on the divider this call
        // declined to write — and withholding the arm would make it wait on a next message that may
        // never come.
        closedConversationId: claim.closedConversationId,
      };
    }),
  );

  if (done.closedConversationId !== null) {
    await params.onAttendanceClosed?.(done.closedConversationId);
  }
  return done.outcome;
}
