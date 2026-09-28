import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { writeFlowEvent } from "@/modules/flowlog/service";
import {
  attendanceHasStarted,
  claimAttendanceBoundary,
  movesAttendanceFrontier,
  needsAttendanceStartProbe,
} from "./attendance-boundary";
import { getCheckpointer } from "./checkpointer";
import {
  INGEST_ID_WINDOW,
  ingestVerdict,
  rememberIngested,
} from "./ingest-dedup";
import {
  conversationDividerMessage,
  conversationStamp,
  humanAgentMessage,
  sentAtStamp,
} from "./markers";
import { resetLandedAfter, threadResetBoundary } from "./reset-episode";
import {
  claimIngestWrite,
  type IngestWriteClaim,
  releaseIngestWrite,
  turnOwnsThread,
} from "./thread-claim";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "./thread-state";

// Continuous ingestion: fold a message into the agent's graph memory thread WITHOUT running a model,
// through graph.updateState and the reducer the real turn uses, so the agent keeps context for the
// messages no turn handled. Two writers: a customer message the agent stayed silent on, and a human
// agent's reply sent meanwhile. Both enter as HumanMessages, so `role` is what keeps the operator's
// words from being summarized as the contact's, and it is required, since a default would let the
// next writer inherit "customer" silently. A message appended while a turn is in flight is still
// erased when the turn saves (./inflight.ts): go through the deferring job (./ingest-job.ts), never
// directly mid-turn. The channel is append-only, so an inverted pair stays inverted.

// At-most-once: the delivery ledger dedups re-deliveries, message_created gating ignores edits, and
// the per-direction remembered ids on AgentThread (./ingest-dedup.ts), read and written under the
// per-thread queue below, catch a re-delivery that slips a new delivery UUID.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type IngestRole = "customer" | "human_agent";

// What goes into the channel for one ingested message: two writers times two boundary outcomes,
// pure for the same reason as ./attendance-boundary.ts (the wrong cell is a permanent memory with the
// wrong person's words). The divider is its OWN message for a human agent's reply and folded into
// the text for the customer's: a message carries ONE marker, so an attendant's reply that also opened
// the attendance cannot be both. `conversationId` is NULL for a late message that must not claim an
// attendance: ../modules/memory/cut.ts reads the LAST stamp, so a late stamp would redefine the open
// attendance and summarize the live conversation. Unstamped, it is filed with the open attendance
// instead: a wrong file for one message, against destroying a live conversation.
export function ingestedMessages(
  role: IngestRole,
  text: string,
  conversationId: number | null,
  writeDivider: boolean,
  messageId?: number,
  // When Chatwoot recorded it. Kept even for a late message that claims no attendance: the date is
  // about the message, not about where the thread is.
  sentAt?: Date | null,
): BaseMessage[] {
  // NOTE: ids derived from the Chatwoot message make a retry safe: the checkpointer append and our
  // row write are not atomic, and the reducer replaces a same-id message in place, so a retried job
  // rewrites instead of appending again. The divider written with its message needs its own id.
  const id = messageId === undefined ? undefined : `ingest:${messageId}`;
  const dividerId = id === undefined ? undefined : `${id}:divider`;
  // NOTE: a divider names the attendance it opens, so it cannot be written by a message that is not
  // claiming one.
  const divides = writeDivider && conversationId !== null;
  if (role === "human_agent") {
    const reply = humanAgentMessage(conversationId, text, id, sentAt);
    return divides
      ? [
          conversationDividerMessage(conversationId, undefined, dividerId),
          reply,
        ]
      : [reply];
  }
  return [
    divides
      ? conversationDividerMessage(conversationId, text, id, sentAt)
      : new HumanMessage({
          ...(id ? { id } : {}),
          content: text,
          additional_kwargs: {
            ...(conversationId === null
              ? {}
              : conversationStamp(conversationId)),
            ...sentAtStamp(sentAt),
          },
        }),
  ];
}

export interface IngestMessageParams {
  tenantId: bigint;
  instanceId: bigint;
  // Chatwoot display_id of the conversation the message belongs to.
  conversationId: number;
  // The native ContactInbox id: the AgentThread key (== the graph thread's discriminator).
  contactInboxId: number;
  // The graph memory thread to append to (tenant:instance:ci:<contactInboxId>).
  graphThreadId: string;
  // Chatwoot message id: what the per-direction dedupe remembers.
  messageId: number;
  // The message body: a rendered customer message (renderInboundMessage) or a human agent's raw text.
  text: string;
  // Who said it. Decides attribution in the channel and, through it, in the permanent memory.
  role: IngestRole;
  // When Chatwoot recorded the message, shown to the model in front of it. Absent leaves it undated,
  // never dated "now".
  sentAt?: Date | null;
  base?: PrismaClient;
  checkpointer?: BaseCheckpointSaver;
  // Fired when this message OPENED a new attendance on the thread, carrying the display_id of the
  // one that just ended. A callback because the work it triggers (arming memory compaction) opens its
  // own transaction, so it is invoked only after this section's queue is released.
  onAttendanceClosed?: (previousConversationId: number) => Promise<void> | void;
  // Return "deferred" instead of appending when a turn owns the thread. Opt-in, and the only caller
  // that sets it is the scheduler job, because it is the only one with somewhere to come back from:
  // deferring on a path that cannot retry would just drop the message by a different route.
  deferIfTurnInFlight?: boolean;
  // Asked once more INSIDE the lock, right before anything is written: is this append still wanted?
  // A caller that waited for the lock may have been overtaken by a /reset, which clears the thread
  // under this same lock, so pre-reset text would rebuild memory the operator was told was cleared.
  // False means stand down having written nothing; absent means always wanted, right for callers that
  // never queued. A callback because the answer lives in the scheduler and this module knows nothing
  // about jobs (same separation as ./ingest-drain.ts).
  stillWanted?: () => Promise<boolean>;
}

export async function ingestMessageIntoThread(
  params: IngestMessageParams,
): Promise<"ingested" | "skipped" | "deferred"> {
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

  // NOTE: serialized by the process-local queue, not a transaction-scoped advisory lock: this section
  // talks to the checkpointer's SEPARATE pool, and a Prisma transaction held across those round-trips
  // drains the main pool until every query, the webhook ack included, times out. The row read and
  // write are short transactions of their own, and the queue orders them. The durable half of the
  // exclusion is the thread's row (./thread-claim.ts), which every thread here has, since continuous
  // ingestion only exists for a thread keyed by contact inbox.
  const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
  let writeClaim: IngestWriteClaim | null = null;
  const done = await withKeyedQueue(`ingest:${graphThreadId}`, async () => {
    try {
      const key = {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      };
      // NOTE: never re-append a message already folded in. Membership in the ids this direction
      // remembers, not a highest-id mark (ids arrive out of order, ./ingest-dedup.ts), and one set per
      // direction, since an attendant answering a voice note can land before the note itself. This
      // cheap look can only say "already done" (the sets only grow); everything else is decided from
      // the row read after the claim below, so a stale "not seen yet" here is harmless.
      const preRow = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.agentThread.findUnique({
          where: key,
          select: {
            recentSyncedMessageIds: true,
            recentAgentMessageIds: true,
          },
        }),
      );
      const seenAlready =
        params.role === "human_agent"
          ? (preRow?.recentAgentMessageIds ?? [])
          : (preRow?.recentSyncedMessageIds ?? []);
      // NOTE: `duplicate` ONLY; `ancient` falls through to the claim. A duplicate is work already done,
      // while an `ancient` is an append that will NOT land and must be reported, from the answer taken
      // under the claim, since this read can be stale.
      if (ingestVerdict(seenAlready, messageId) === "duplicate") {
        return { outcome: "skipped" as const, closedConversationId: null };
      }

      // NOTE: stand down from IN HERE: a turn owning the channel undoes anything appended beside it,
      // and a check before the lock is only staggered (the turn can take the lock, mark itself and
      // release in between). Turns mark themselves under this same lock (./inflight.ts,
      // ../graph/runtime.ts). Nothing is written on this path, the dedupe sets included: the message
      // has to stay OWED. And CLAIMED, not merely asked: across replicas a question answered here is
      // stale by the time the write lands, while a held claim makes the turn's own mark refuse
      // (./thread-claim.ts). Released in the `finally` below, on every exit.
      if (params.deferIfTurnInFlight) {
        const held = await claimIngestWrite(owner, base);
        if (held.state === "busy") {
          return { outcome: "deferred" as const, closedConversationId: null };
        }
        // NOTE: recorded only when something was actually taken, so the release in the `finally`
        // never touches a claim held by whoever refused us.
        writeClaim = held;
      }

      // NOTE: read AFTER the claim: while this call waits on a claim another replica's append holds, a
      // row read earlier goes stale, and every decision below comes from it (dedupe sets, frontier,
      // stamp); a stale copy treats a delayed lower id as the newest and restores the older marker.
      // The turn side orders it the same way (../graph/runtime.ts).
      const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.agentThread.findUnique({
          where: key,
          select: {
            lastSyncedMessageId: true,
            lastAgentMessageId: true,
            recentSyncedMessageIds: true,
            recentAgentMessageIds: true,
            lastConversationId: true,
          },
        }),
      );

      // NOTE: the episode boundary, asked in here for the same reason as the stand-down. `/reset`
      // revokes every queued `INGEST_MESSAGE` for the thread in its critical section, but cannot revoke
      // a job armed AFTER that (the receiver's own arm racing the command, or a stranded reply's
      // recovery, ../modules/chatwoot/recover-human-reply.ts); here it cannot go stale, since the
      // command waits on the claim held above (`threadBusyForResetOn`). The THREAD's latest reset, not
      // the conversation's: a `/reset` in a sibling conversation clears the memory both share.
      const cleared = await threadResetBoundary(
        tenantId,
        instanceId,
        contactInboxId,
        base,
      );
      if (resetLandedAfter(messageId, cleared)) {
        logger.info(
          "ingest: message %s on conversation %s predates the /reset that cleared this thread; not restoring it",
          String(messageId),
          String(conversationId),
        );
        return { outcome: "skipped" as const, closedConversationId: null };
      }

      // NOTE: the same question, now on the row this call is entitled to trust. Another append may
      // have folded this very id in while this one waited for the claim.
      const recent =
        params.role === "human_agent"
          ? (row?.recentAgentMessageIds ?? [])
          : (row?.recentSyncedMessageIds ?? []);
      const verdict = ingestVerdict(recent, messageId);
      if (verdict !== "new") {
        // NOTE: an `ancient` is reported from here, where the answer is authoritative: past the
        // window's floor the append is refused SUCCESSFULLY, the job completes and its row is
        // deleted, and nothing else names the words that never landed (the recovery's own check is
        // minutes older). UNDECIDABLE, not lost: an evicted id reads exactly like one that never
        // landed, so a person has to read the conversation. Both directions: the customer messages
        // queued here are the ones no turn covers, so neither the loss list nor the delivery ledger
        // (PROCESSED once the arm succeeded) shows them. A migrated window starts saturated, so early
        // re-deliveries can read `ancient`: if that is noise, rate-limit, never drop a direction.
        if (verdict === "ancient") {
          const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
            db.conversation.findUnique({
              where: {
                tenantId_chatwootInstanceId_chatwootConversationId: {
                  tenantId,
                  chatwootInstanceId: instanceId,
                  chatwootConversationId: conversationId,
                },
              },
              select: { id: true, inbox: { select: { agentId: true } } },
            }),
          );
          logger.error(
            "ingest: message %s (%s) on conversation %s is older than everything this thread's memory still remembers; it was not appended, and whether it ever was cannot be decided from here",
            String(messageId),
            params.role,
            String(conversationId),
          );
          await writeFlowEvent(
            {
              tenantId,
              turnId: crypto.randomUUID(),
              source: "inbox",
              conversationId: conv?.id ?? null,
              agentId: conv?.inbox?.agentId ?? null,
              base,
            },
            {
              stage: "memory",
              level: "error",
              status: "error",
              detail: {
                reason: "ingest_append_undecidable",
                messageId,
                role: params.role,
                window: INGEST_ID_WINDOW,
              },
            },
          );
        }
        return { outcome: "skipped" as const, closedConversationId: null };
      }

      // NOTE: revoked while we waited. Checked here and not before the lock, for the same reason the
      // deferral above is: /reset does its clearing while holding this lock, so a check made outside
      // it answers about a thread that may be cleared a microsecond later. "Skipped" and not
      // "deferred": the work is not owed later, it is not wanted at all.
      if (params.stillWanted && !(await params.stillWanted())) {
        return { outcome: "skipped" as const, closedConversationId: null };
      }

      // NOTE: a late arrival does not move the frontier, and the frontier is the THREAD'S (the newest
      // id either writer folded in): the marks go in as a pair, since reading only one direction's
      // lets a delayed customer message close the live conversation an attendant just opened. The rule
      // lives in ./attendance-boundary.ts.
      const movesFrontier = movesAttendanceFrontier(
        [row?.lastSyncedMessageId, row?.lastAgentMessageId],
        messageId,
      );

      // NOTE: which attendance this message belongs to, one decision shared with the reactive turn and
      // the nudge (./attendance-boundary.ts). Human-agent messages count as a start: an agent who opens
      // the conversation sends its first message, which would otherwise sit inside the PREVIOUS
      // attendance and be summarized away with it.
      const prevConv = row?.lastConversationId ?? null;
      // NOTE: asked of the ROW, not only of this process. On the deferring path the answer is false
      // by construction (holding the write claim means no turn holds the thread), and it is the
      // OTHER path this matters on: a caller that appends inline gets the cross-process answer
      // instead of its own replica's.
      const anotherInvokeIsReading = await turnOwnsThread(owner, base);
      const alreadyStarted =
        movesFrontier &&
        needsAttendanceStartProbe(
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
      const claim = !movesFrontier
        ? // NOTE: appended, and nothing else: no divider, no marker move, no compaction armed.
          {
            writeDivider: false,
            advanceMarker: false,
            closedConversationId: null,
          }
        : claimAttendanceBoundary({
            previousConversationId: prevConv,
            conversationId,
            anotherInvokeIsReading,
            attendanceAlreadyStarted: alreadyStarted,
          });

      // NOTE: a retry repairing its own half-done attempt must not rewrite the message: the append and
      // the row write are not atomic, and on attempt 2 the claim sees this conversation's stamp, so
      // `writeDivider` is false and the derived id would REPLACE the divider-bearing message with a
      // plain one. So an id already in the channel skips the append; only the row write is owed. Asked
      // of the CHANNEL, not the scheduler's attempt count: a duplicate delivery re-arming a CLAIMED row
      // leaves attempts at zero on a run that is in fact repairing.
      const alreadyAppended = (
        (
          (
            await graph.getState({
              configurable: { thread_id: graphThreadId },
            })
          ).values as { messages?: BaseMessage[] } | undefined
        )?.messages ?? []
      ).some((m) => m.id === `ingest:${messageId}`);

      // NOTE: every message carries the conversation it belongs to, which the compaction cut reads.
      // Markers go through their factories because nothing else can make a message COUNT as one: the
      // text alone never does, or a customer could type it (src/graph/markers.ts).
      if (!alreadyAppended)
        await graph.updateState(
          { configurable: { thread_id: graphThreadId } },
          {
            messages: ingestedMessages(
              params.role,
              params.text,
              // NOTE: the whole late-arrival rule, spent here: a message that does not move the
              // frontier claims NOTHING, not the divider, not the marker, not the attendance stamp.
              movesFrontier ? conversationId : null,
              claim.writeDivider,
              messageId,
              params.sentAt,
            ),
          },
          THREAD_STATE_NODE,
        );

      // NOTE: remember THIS direction's message only. The scalar is the HIGHEST id folded in (a
      // `max`), so an out-of-order message never walks it back. Re-read under a row lock: the top read
      // and this write are separate transactions with checkpointer round-trips between, and across
      // processes two appends computing from one stale row would walk the scalar back and drop each
      // other's id from the dedupe ledger. Recomputing from the locked row needs no second copy of the
      // cap rule, which a merge written in SQL would.
      await runScopedOn(base, sysCtx(tenantId), async (db) => {
        const locked = (
          await db.$queryRaw<
            {
              lastSyncedMessageId: number | null;
              lastAgentMessageId: number | null;
              recentSyncedMessageIds: number[];
              recentAgentMessageIds: number[];
            }[]
          >`
            SELECT last_synced_message_id AS "lastSyncedMessageId",
                   last_agent_message_id  AS "lastAgentMessageId",
                   recent_synced_message_ids AS "recentSyncedMessageIds",
                   recent_agent_message_ids  AS "recentAgentMessageIds"
              FROM agent_threads
             WHERE tenant_id = ${tenantId}
               AND chatwoot_instance_id = ${instanceId}
               AND contact_inbox_id = ${contactInboxId}
             FOR UPDATE`
        )[0];
        const fresh =
          params.role === "human_agent"
            ? locked?.recentAgentMessageIds
            : locked?.recentSyncedMessageIds;
        const freshMark =
          (params.role === "human_agent"
            ? locked?.lastAgentMessageId
            : locked?.lastSyncedMessageId) ?? null;
        const mark =
          freshMark === null ? messageId : Math.max(freshMark, messageId);
        const remembered = rememberIngested(fresh ?? [], messageId);
        const advance =
          params.role === "human_agent"
            ? { lastAgentMessageId: mark, recentAgentMessageIds: remembered }
            : { lastSyncedMessageId: mark, recentSyncedMessageIds: remembered };
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
            // NOTE: held back when the claim declined the boundary (./attendance-boundary.ts). The
            // id watermark still advances: it guards at-most-once append, and rewinding it would
            // trade a lost divider for a duplicated message.
            lastConversationId: claim.advanceMarker ? conversationId : prevConv,
          },
        });
      });
      return {
        outcome: "ingested" as const,
        // NOTE: armed even when the boundary was not consumed. The attendance that just ended is
        // compactable right now (its boundary lives on the messages, not on the divider this call
        // declined to write), and withholding the arm would make it wait on a next message that may
        // never come.
        closedConversationId: claim.closedConversationId,
      };
    } finally {
      // NOTE: released inside the queue, so the next thing this process runs on the thread never
      // waits on it, and on a throw too, or a leaked claim would defer every later append until the
      // lease ran out. Best-effort, as at ../graph/runtime.ts's release: a throw here would skip
      // `onAttendanceClosed` below after the append committed, and the retry would find the message
      // already remembered and never arm the closed attendance. The lease recovers a lost release.
      if (writeClaim) {
        const claim = writeClaim;
        try {
          await releaseIngestWrite(owner, base, claim);
        } catch (err) {
          logger.warn(
            { err, thread: graphThreadId },
            "failed to release the durable ingest write claim; its lease will expire",
          );
        }
      }
    }
  });

  if (done.closedConversationId !== null) {
    await params.onAttendanceClosed?.(done.closedConversationId);
  }
  return done.outcome;
}
