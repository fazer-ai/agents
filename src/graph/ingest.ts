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
import {
  conversationDividerMessage,
  conversationStamp,
  humanAgentMessage,
} from "./markers";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "./thread-state";

// Continuous ingestion: fold a customer message into the agent's graph memory thread WITHOUT running
// a model, so the agent has full context even for the messages no turn handled — the ones it stayed
// silent on, out of hours or while a human owned the conversation. The seam is graph.updateState,
// which appends to the thread's MessagesAnnotation channel via the same reducer the real turn uses.
//
// TWO WRITERS, ONE THREAD. A customer message the agent stayed silent on, and a human agent's own
// reply sent while it was silent. The second is what `role` exists for: both enter the channel as
// HumanMessages (a system role is dropped before the model call, src/graph/markers.ts), so nothing
// downstream could tell the operator's words from the contact's — and the summarizer wrote the
// operator's into the contact's permanent memory as things the contact said (issue #187).
//
// `role` is required, not defaulted. It reaches every call site of this module, and a default would
// let the next writer inherit "customer" silently, which is exactly the attribution bug back again.
//
// WHAT THIS MODULE DOES NOT PROMISE, so the next reader does not rediscover it as a surprise. All
// three predate the second writer and hold identically for a customer's message on main today; they
// are properties of appending to a checkpointer channel on webhook arrival, not of `role`:
//
//   - A message appended while a graph turn is IN FLIGHT is erased when that turn saves the channel
//     it loaded (see ./inflight.ts). The watermark has already advanced, so nothing restores it. The
//     in-flight claim is consulted here only to hold back the DIVIDER (./attendance-boundary.ts).
//   - Arrival order is not Chatwoot order. Two messages of the same direction can invert (the eager
//     media pass makes one wait on a provider round-trip and the other not), and the monotonic
//     watermark then skips the later-arriving lower id entirely.
//   - Across directions the watermarks keep both messages, but the channel is append-only, so an
//     inverted pair stays inverted: a reply can sit above the question it answers.
//
// Closing any of them means deferring or reordering, which is a change to continuous ingestion as a
// whole and would reintroduce the first item at a far higher rate. Tracked separately.

// At-most-once: the delivery ledger dedups re-deliveries, message_created gating ignores edits, and a
// monotonic per-thread watermark PER DIRECTION (AgentThread.lastSyncedMessageId /
// lastAgentMessageId, CAS under a per-thread advisory
// lock) is defense-in-depth against a re-delivery that slips a new delivery UUID. The lock also
// serializes concurrent ingestions on one thread so two appends can't clobber each other's checkpoint.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type IngestRole = "customer" | "human_agent";

// WHAT GOES INTO THE CHANNEL for one ingested message: two writers times two boundary outcomes.
// Pure and separate from the transaction around it, for the same reason as ./attendance-boundary.ts —
// it is a decision, and the wrong cell here is not a slow prompt, it is a permanent memory with the
// wrong person's words in it.
//
// The divider travels as its OWN message for a human agent's reply and folded into the text for the
// customer's. Both shapes already exist (the reactive turn writes it standalone, ingestion folds it
// in), and the split is forced rather than chosen: a message carries ONE marker, so an attendant's
// reply that also opened the attendance cannot be both.
export function ingestedMessages(
  role: IngestRole,
  text: string,
  conversationId: number,
  writeDivider: boolean,
): BaseMessage[] {
  if (role === "human_agent") {
    const reply = humanAgentMessage(conversationId, text);
    return writeDivider
      ? [conversationDividerMessage(conversationId), reply]
      : [reply];
  }
  return [
    writeDivider
      ? conversationDividerMessage(conversationId, text)
      : new HumanMessage({
          content: text,
          additional_kwargs: conversationStamp(conversationId),
        }),
  ];
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
  // Who said it. Decides attribution in the channel and, through it, in the permanent memory.
  role: IngestRole;
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
        select: {
          lastSyncedMessageId: true,
          lastAgentMessageId: true,
          lastConversationId: true,
        },
      });
      // Monotonic watermark: never re-append a message already folded into the thread. ONE PER
      // DIRECTION, because monotonic only guards while the ids reaching it arrive in order, and the
      // two writers do not share a latency: a customer's message waits on the eager media pass (a
      // provider round-trip for STT/vision) and an agent's reply waits on nothing. An attendant
      // answering a voice note lands FIRST, so a shared column would advance past the customer's id
      // and drop THEIR message from the memory for good — trading a duplicated attendant line, which
      // is what this guard is actually for, against a lost customer message.
      const watermark =
        params.role === "human_agent"
          ? row?.lastAgentMessageId
          : row?.lastSyncedMessageId;
      if (watermark != null && messageId <= watermark) {
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
      // Markers go through their factories because nothing else can make a message COUNT as one —
      // the text alone never does, or a customer could type it (src/graph/markers.ts).
      await graph.updateState(
        { configurable: { thread_id: graphThreadId } },
        {
          messages: ingestedMessages(
            params.role,
            params.text,
            conversationId,
            claim.writeDivider,
          ),
        },
        THREAD_STATE_NODE,
      );

      // Advance THIS direction's watermark, and only it. Both messages also advance the divider
      // marker (turns do the same).
      const advance =
        params.role === "human_agent"
          ? { lastAgentMessageId: messageId }
          : { lastSyncedMessageId: messageId };
      await db.agentThread.upsert({
        where: key,
        create: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
          threadId: graphThreadId,
          ...advance,
          lastConversationId: conversationId,
        },
        update: {
          ...advance,
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
