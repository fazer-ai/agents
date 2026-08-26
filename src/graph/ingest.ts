import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  attendanceHasStarted,
  claimAttendanceBoundary,
  movesAttendanceFrontier,
  needsAttendanceStartProbe,
} from "./attendance-boundary";
import { getCheckpointer } from "./checkpointer";
import { ingestVerdict, rememberIngested } from "./ingest-dedup";
import {
  conversationDividerMessage,
  conversationStamp,
  humanAgentMessage,
} from "./markers";
import {
  claimIngestWrite,
  type IngestWriteClaim,
  releaseIngestWrite,
  turnOwnsThread,
} from "./thread-claim";
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
// WHERE THE CALLER HAS TO HELP, and where it no longer does (issue #194). Two of the three hazards
// this header used to list are closed, and the third is not:
//
//   - A message appended while a graph turn is IN FLIGHT is still erased when that turn saves the
//     channel it loaded (see ./inflight.ts), and this module does NOT check for that — it consults
//     the claim only to hold back the DIVIDER (./attendance-boundary.ts). What changed is that the
//     caller can now say "not yet": continuous ingestion arrives as a scheduler job
//     (./ingest-job.ts), which defers rather than appending. Calling this directly while a turn runs
//     is still a lost message, so do not.
//   - Arrival order is still not Chatwoot order, but it no longer COSTS a message. Dedup is
//     membership in the ids each direction remembers rather than a comparison against the highest
//     one (./ingest-dedup.ts), so a later-arriving lower id is folded in instead of read as handled.
//   - The channel remains append-only, so an inverted pair stays inverted: a reply can sit above the
//     question it answers, and the summarizer reads it that way. Strictly smaller than a missing
//     half, and tracked as issue #200 rather than here.

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
// IDS ARE DERIVED FROM THE CHATWOOT MESSAGE, not generated, and that is what makes a retry safe.
// The append and the row that records it are not one atomic write: `graph.updateState` goes to the
// checkpointer's own store, the watermark goes to our transaction, and a failure between them rolls
// back only the second. Since ingestion became a retried job, that partial success comes back — and
// with a fresh uuid each time, the retry would append the SAME message again, once per transient
// failure. The reducer replaces a same-id message in place, so a derived id turns the retry into a
// no-op rewrite instead. `messageId` is unique per Chatwoot account, and a divider written with its
// message needs its own, hence the suffix.
// `conversationId` is NULL for a message that must not claim an attendance, which is the SECOND half
// of the late-arrival rule and the half a marker check cannot reach. ../modules/memory/cut.ts decides
// which attendance is open by reading the LAST stamp in the channel and walking back over its run, so
// a late message stamped with the conversation it belongs to redefines the open attendance from the
// end: everything above it, the live conversation included, becomes the closed prefix and is replaced
// by a summary mid-attendance. Holding back the divider and the marker is not enough, because the
// stamp is a third, independent way of saying which attendance the thread is on.
//
// Unstamped, the message is still in the thread and still attributed to whoever sent it; it simply
// travels with the attendance in progress instead of claiming one, exactly as an assistant reply
// does. The cost is that it is summarised with the open attendance rather than the one it belongs
// to, which is a wrong FILE for one message against destroying a live conversation.
export function ingestedMessages(
  role: IngestRole,
  text: string,
  conversationId: number | null,
  writeDivider: boolean,
  messageId?: number,
): BaseMessage[] {
  const id = messageId === undefined ? undefined : `ingest:${messageId}`;
  const dividerId = id === undefined ? undefined : `${id}:divider`;
  // A divider names the attendance it opens, so it cannot be written by a message that is not
  // claiming one. The types say so rather than a comment saying so.
  const divides = writeDivider && conversationId !== null;
  if (role === "human_agent") {
    const reply = humanAgentMessage(conversationId, text, id);
    return divides
      ? [
          conversationDividerMessage(conversationId, undefined, dividerId),
          reply,
        ]
      : [reply];
  }
  return [
    divides
      ? conversationDividerMessage(conversationId, text, id)
      : new HumanMessage({
          ...(id ? { id } : {}),
          content: text,
          ...(conversationId === null
            ? {}
            : { additional_kwargs: conversationStamp(conversationId) }),
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
  // Return "deferred" instead of appending when a turn owns the thread. Opt-in, and the only caller
  // that sets it is the scheduler job, because it is the only one with somewhere to come back from:
  // deferring on a path that cannot retry would just drop the message by a different route.
  deferIfTurnInFlight?: boolean;
  // Asked once more INSIDE the lock, immediately before anything is written: is this append still
  // wanted? A caller that had to wait for the lock may have been overtaken while waiting, and the
  // case that matters is /reset — it clears the thread under this same lock, so a queued ingestion
  // holding pre-reset text lands the moment the reset releases and rebuilds both the row and the
  // checkpoint from memory the operator was told had been cleared. False means stand down having
  // written nothing.
  //
  // A callback rather than a flag because the answer lives in the scheduler, and this module knows
  // nothing about jobs (same separation as ./ingest-drain.ts). Absent ⇒ always wanted, which is
  // right for the callers that never queued.
  //
  // IT IS HANDED THE CONNECTION THIS TRANSACTION IS ALREADY HOLDING, and that is not a convenience.
  // The shared lane runs up to twenty jobs at once against a pool that can be smaller than that, so
  // a callback that opened a transaction of its own would have every handler waiting for a
  // connection only another handler could release — all of them timing out, retrying, and
  // dead-lettering a customer's message on a pool that was merely busy.
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

  // Serialized by the process-local queue, not by a transaction-scoped advisory lock. This section
  // reads and writes the checkpointer, which is a SEPARATE Postgres pool, and holding a Prisma
  // transaction open across those round-trips drained the main pool: every other query in the
  // process, the webhook ack included, then waited out `maxWait` and failed (issue #225). The row
  // read and the row write are short transactions of their own now, and the ordering between them,
  // which is what the lock was really providing, comes from the queue.
  // The durable half of the exclusion, and the only thread key that has a row to hang it on. See
  // ./thread-claim.ts for why that is enough: continuous ingestion only exists for a thread keyed by
  // contact inbox, so the race that loses a message always has one.
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
      // Never re-append a message already folded into the thread. The decision is membership in the
      // ids this direction remembers, NOT a comparison against the highest one: within a direction
      // the ids arrive out of order too, and a mark read the later-arriving lower id as handled
      // (./ingest-dedup.ts, issue #194). ONE SET PER DIRECTION for the older half of the same
      // reason: the two writers do not share a latency at all, so an attendant answering a voice
      // note lands before the note itself.
      // A CHEAP LOOK FIRST, and it can only ever say "already done". The remembered ids only grow,
      // so a message found here was ingested for certain and there is nothing to claim the thread
      // for. Everything else is decided from the row read AFTER the claim below: this one can be
      // stale, and a stale "not seen yet" is harmless because the authoritative check repeats.
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
      if (ingestVerdict(seenAlready, messageId) !== "new") {
        return { outcome: "skipped" as const, closedConversationId: null };
      }

      // STAND DOWN, and do it from IN HERE. A turn owning the channel undoes anything appended
      // beside it, and the caller cannot ask this question for us: a check made before the lock is
      // only staggered, not exclusive, the turn can take the lock, mark itself and release between
      // that check and this one, and the append then lands inside the invoke after all. Turns mark
      // themselves under this same lock (./inflight.ts, ../graph/runtime.ts), so asking here is what
      // makes the two mutually exclusive.
      //
      // Nothing is written on this path, watermark included: the message has to stay OWED. Recording
      // it as handled and not having it is the exact shape of the loss this whole change is about.
      //
      // PROCESS-LOCAL, like the two consumers of that claim that came before this one. It holds under
      // the invariant ./inflight.ts states and docs/deploy.md §4 asks for (one replica, or one leader
      // sharing the process with the scheduler worker) and not on a scaled web tier, where turns run
      // wherever the webhook landed. What is new here is that this consumer's cross-process failure
      // is the irreversible one, so it is written down: issue #203, for the module rather than for
      // this call site.
      // NOTE: CLAIMED, not merely asked. The check and the append are not one atomic step across
      // processes, so a question answered here is stale by the time the write lands: a turn on another
      // replica can mark itself and load the channel in between, and the append still ends up inside
      // the invoke. Taking the claim is what closes that, because the turn's own mark refuses while it
      // is held (../graph/thread-claim.ts). Released in the `finally` below, on every exit.
      if (params.deferIfTurnInFlight) {
        const held = await claimIngestWrite(owner, base);
        if (held.state === "busy") {
          return { outcome: "deferred" as const, closedConversationId: null };
        }
        // NOTE: recorded only when something was actually taken, so the release in the `finally`
        // never touches a claim held by whoever refused us.
        writeClaim = held;
      }

      // READ AFTER THE CLAIM, never before it. Two replicas can be appending to the same thread: a
      // row read first goes stale while this call waits for the claim the other append is holding,
      // and every decision below is made from it (the dedupe sets, the frontier, the attendance
      // stamp). Using the stale copy treats a delayed lower id as the newest, writes the wrong
      // divider, and puts the older marker back over the fresh one. The same ordering the turn side
      // uses, for the same reason (../graph/runtime.ts).
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

      // The same question, now on the row this call is entitled to trust. Another append may have
      // folded this very id in while this one waited for the claim.
      const recent =
        params.role === "human_agent"
          ? (row?.recentAgentMessageIds ?? [])
          : (row?.recentSyncedMessageIds ?? []);
      if (ingestVerdict(recent, messageId) !== "new") {
        return { outcome: "skipped" as const, closedConversationId: null };
      }

      // REVOKED WHILE WE WAITED. Checked here and not before the lock, for the same reason the
      // deferral above is: /reset does its clearing while holding this lock, so a check made outside
      // it answers about a thread that may be cleared a microsecond later. "Skipped" and not
      // "deferred", the work is not owed later, it is not wanted at all.
      if (params.stillWanted && !(await params.stillWanted())) {
        return { outcome: "skipped" as const, closedConversationId: null };
      }

      // A LATE ARRIVAL DOES NOT MOVE THE FRONTIER, and the frontier is the THREAD'S, the newest id
      // either writer has folded in, not the newest of the arriving one's own direction. The rule
      // and both hazards it closes live in ./attendance-boundary.ts; what matters here is that the
      // marks go in as a pair, because reading only this direction's is what let a delayed customer
      // message close the live conversation an attendant had just opened.
      //
      // A late message is appended with its own conversation stamp, which is all the compaction cut
      // needs to file it correctly, and nothing else.
      const movesFrontier = movesAttendanceFrontier(
        [row?.lastSyncedMessageId, row?.lastAgentMessageId],
        messageId,
      );

      // Which attendance this message belongs to, and what that costs the thread. One decision,
      // shared with the reactive turn and the proactive nudge (./attendance-boundary.ts). Human-agent
      // messages count as a start: an agent who opens the conversation sends its first message, and
      // skipping them here left that message sitting inside the PREVIOUS attendance, summarized and
      // removed with it when the customer finally replied.
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
        ? // Appended, and nothing else: no divider, no marker move, no compaction armed.
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

      // A RETRY REPAIRING ITS OWN HALF-DONE ATTEMPT MUST NOT REWRITE THE MESSAGE. The append and the
      // row that records it are not atomic, so attempt 2 can find attempt 1's message already in the
      // channel, and it would not write the same thing twice over: the boundary claim now sees this
      // conversation's stamp already present, so `writeDivider` is false, and the derived id makes
      // the reducer REPLACE the divider-bearing message with a plain one. The attendance boundary
      // would be silently erased by the retry that was supposed to be idempotent.
      //
      // So the append is skipped outright when its id is already there. Only the row write is owed,
      // which is exactly what failed the first time.
      // ASKED OF THE CHANNEL, EVERY TIME. The first version gated this on the scheduler's attempt
      // count, which is a different question wearing the same clothes: "has this job run before"
      // does not answer "is this message already in the thread". A duplicate delivery re-arming the
      // row while it is CLAIMED flips it back to PENDING, `failJob`'s CAS then refuses, and attempts
      // stays at zero, so a run that IS repairing a half-done append announced itself as the first
      // one, and went on to replace the divider-bearing message with a plain one. One channel read
      // is the price of asking the question that is actually being asked.
      const alreadyAppended = (
        (
          (
            await graph.getState({
              configurable: { thread_id: graphThreadId },
            })
          ).values as { messages?: BaseMessage[] } | undefined
        )?.messages ?? []
      ).some((m) => m.id === `ingest:${messageId}`);

      // Every message carries the conversation it belongs to, which is what the compaction cut reads.
      // Markers go through their factories because nothing else can make a message COUNT as one,
      // the text alone never does, or a customer could type it (src/graph/markers.ts).
      if (!alreadyAppended)
        await graph.updateState(
          { configurable: { thread_id: graphThreadId } },
          {
            messages: ingestedMessages(
              params.role,
              params.text,
              // The whole late-arrival rule, spent here: a message that does not move the frontier
              // claims NOTHING, not the divider, not the marker, not the attendance stamp.
              movesFrontier ? conversationId : null,
              claim.writeDivider,
              messageId,
            ),
          },
          THREAD_STATE_NODE,
        );

      // Remember THIS direction's message, and only it. The scalar stays the HIGHEST id folded in,
      // which is now a `max` rather than an assignment: a message ingested out of order must not
      // walk the mark backwards, or the next reader would read the thread as less complete than it
      // is. Both messages also advance the divider marker (turns do the same).
      //
      // RE-READ UNDER A ROW LOCK, and that is the second half of issue #203. The read at the top of
      // this section and this write are two short transactions with checkpointer round-trips between
      // them, and the queue that used to order them is process-local. Two appends on one thread in
      // two processes both computed their `max` and their remembered ids from the SAME stale row:
      // the later write walked the scalar backwards and dropped the other's id out of the dedupe
      // ledger, which is a re-delivery this thread can no longer recognise. Locking the row and
      // recomputing from it costs one short transaction and needs no second copy of the cap rule,
      // which a merge written in SQL would have.
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
            // Held back when the claim declined the boundary (./attendance-boundary.ts). The synced
            // watermark still advances: it guards at-most-once append, and rewinding it would trade a
            // lost divider for a duplicated message.
            lastConversationId: claim.advanceMarker ? conversationId : prevConv,
          },
        });
      });
      return {
        outcome: "ingested" as const,
        // Armed even when the boundary was not consumed. The attendance that just ended is
        // compactable right now, its boundary lives on the messages, not on the divider this call
        // declined to write, and withholding the arm would make it wait on a next message that may
        // never come.
        closedConversationId: claim.closedConversationId,
      };
    } finally {
      // Released inside the queue, so the next thing this process runs on the thread never waits on
      // it, and released even on a throw: a claim leaked by an exception would make every later append
      // defer until the lease ran out.
      //
      // NOTE: and best-effort, for the reason ../graph/runtime.ts gives at its own release. By here
      // the append and its watermark may be committed; a throw from the cleanup would leave through
      // this `finally` and skip `onAttendanceClosed` below, and the scheduler's retry then finds the
      // message already in the dedupe ledger and returns "skipped", so the closed attendance is
      // never armed for compaction. The lease is the recovery path for a release that never lands.
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
