import { type BaseMessage, RemoveMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import {
  chatwootThreadId,
  contactInboxThreadId,
  getCheckpointer,
} from "@/graph/checkpointer";
import { isTurnInFlight } from "@/graph/inflight";
import { memoryHeadMessage, stampedConversationId } from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
import { createChatModel } from "@/graph/models";
import { buildCallbacks, loadAgentConfig } from "@/graph/prepare";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  MEMORY_HEAD_MAX_ATTENDANCES,
  renderMemoryHead,
  selectClosedPrefix,
} from "./cut";
import { readMemoryConfig } from "./settings";
import { summarizeAttendance } from "./summarize";

// Memory compaction: when an attendance ends, its raw turns on the contact's thread are replaced by
// one summary of it, so the thread becomes "N summarized attendances + the current one, raw".
//
// Cutting on the attendance boundary rather than at an arbitrary token offset is the whole point:
// the boundary already exists (CONVERSATION_DIVIDER, Conversation.status, AgentThread
// .lastConversationId), it is what a human agent's notes actually look like, and it is explainable
// to an operator — "8 atendimentos resumidos + o atual" is a sentence; "dropped 40k tokens from the
// middle" is not.
//
// Everything here runs OFF the hot path, as a scheduler job, after the reply was posted. No customer
// ever waits on the summarizer.

const GRACE_ON_RESOLVE_MS = 15 * 60_000;

// How long to wait out a turn that is reading the thread right now. Short, because the only thing
// being waited on is one generation finishing, and the deferred attempt costs a handful of reads: the
// summary row is already durable by then, so nothing is generated twice.
const DEFER_ON_TURN_MS = 60_000;

function deferForTurn(graphThreadId: string, where: string): JobResult {
  logger.info(
    "memory: a turn is in flight (thread=%s, %s), deferring compaction",
    graphThreadId,
    where,
  );
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + DEFER_ON_TURN_MS),
  };
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Why the trigger fired, which is the only thing the cut cannot work out on its own: "resolved"
// means the conversation the thread is CURRENTLY on has ended, so there is no open attendance to
// protect; "new_attendance" means a later conversation already opened, and the cut finds it by its
// divider.
export type CompactionReason = "resolved" | "new_attendance";

export interface ArmCompactionParams {
  tenantId: bigint;
  instanceId: bigint;
  contactInboxId: number;
  // The attendance that ended.
  conversationId: number;
  agentId: bigint;
  reason: CompactionReason;
  // The per-agent switch, already resolved by the caller (readMemoryConfig). Passed in rather than
  // re-read here so a call site that already holds the agent's config does not open a query, and so
  // this function has one job.
  enabled: boolean;
  base?: PrismaClient;
}

// Enqueues (or re-arms) the one compaction job for this thread. Best-effort by contract: a failure
// to arm must never break the webhook or the turn that called it.
export async function armCompaction(
  p: ArmCompactionParams,
): Promise<"armed" | "disabled" | "failed"> {
  if (!p.enabled) return "disabled";
  const threadId = contactInboxThreadId(
    p.tenantId,
    p.instanceId,
    p.contactInboxId,
  );
  try {
    await enqueueJob({
      tenantId: p.tenantId,
      kind: "MEMORY_COMPACT",
      // GUARANTEE 1 of 3 against compacting twice: SchedulerJob is unique on
      // (tenant, kind, dedupeKey) and enqueueJob upserts, so both triggers firing for the same
      // thread collapse into ONE row instead of two jobs racing each other over the same messages.
      dedupeKey: threadId,
      runAt: new Date(
        Date.now() + (p.reason === "resolved" ? GRACE_ON_RESOLVE_MS : 0),
      ),
      // This dedupeKey is the THREAD, so the same row is reused by every attendance this contact ever
      // has. Each attendance is new work and gets its own retry budget; otherwise failures accumulate
      // across months and one bad day retires compaction for that contact permanently.
      resetAttempts: true,
      payload: {
        instanceId: String(p.instanceId),
        contactInboxId: p.contactInboxId,
        conversationId: p.conversationId,
        agentId: String(p.agentId),
        reason: p.reason,
      },
      base: p.base,
    });
    return "armed";
  } catch (err) {
    logger.warn({ err }, "memory: could not arm compaction");
    return "failed";
  }
}

export interface CompactPayload {
  instanceId: bigint;
  contactInboxId: number;
  conversationId: number;
  agentId: bigint;
  reason: CompactionReason;
}

function parsePayload(raw: Record<string, unknown>): CompactPayload | null {
  const instanceId = raw.instanceId;
  const agentId = raw.agentId;
  const contactInboxId = raw.contactInboxId;
  const conversationId = raw.conversationId;
  if (
    typeof instanceId !== "string" ||
    typeof agentId !== "string" ||
    typeof contactInboxId !== "number" ||
    typeof conversationId !== "number"
  ) {
    return null;
  }
  try {
    return {
      instanceId: BigInt(instanceId),
      agentId: BigInt(agentId),
      contactInboxId,
      conversationId,
      reason: raw.reason === "resolved" ? "resolved" : "new_attendance",
    };
  } catch {
    return null;
  }
}

export interface CompactionDeps {
  checkpointer?: BaseCheckpointSaver;
  makeModel?: typeof createChatModel;
}

export async function runCompaction(
  tenantId: bigint,
  payload: CompactPayload,
  base: PrismaClient,
  deps: CompactionDeps = {},
): Promise<JobResult> {
  const { instanceId, contactInboxId, conversationId, agentId, reason } =
    payload;
  const graphThreadId = contactInboxThreadId(
    tenantId,
    instanceId,
    contactInboxId,
  );

  const loaded = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { settings: true },
    });
    // NOTE: The switch is re-read at execution, not trusted from arming time: a job can sit in the
    // queue past the moment an operator turns compaction off, and the operator's last word wins.
    if (!agent || !readMemoryConfig(agent.settings).compaction.enabled) {
      return "off" as const;
    }
    // A conversation that was reopened inside the grace window is NOT a closed attendance, and
    // compacting it would hand the model a summary of the very conversation it is still in the
    // middle of. The boundary trigger picks it up later, when a genuinely new attendance opens. It is
    // not a reason to stop, though: an earlier attempt may have left a summary row owed a rewrite,
    // and that one still has to land (see `owed` below).
    let reopened = false;
    if (reason === "resolved") {
      const conv = await db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: conversationId,
          },
        },
        select: { status: true },
      });
      if (conv && conv.status !== "resolved") reopened = true;
    }
    // Which conversation the thread is on RIGHT NOW. The resolve trigger waits out a grace window,
    // and a contact can open a new attendance inside it: the resolved conversation stays resolved,
    // so the status check above passes, and treating the whole thread as closed would summarize the
    // conversation the agent is in the middle of. When the thread has moved on, the divider is the
    // boundary again.
    const thread = await db.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { id: true, lastConversationId: true },
    });
    const cfg = await loadAgentConfig(
      db,
      {
        tenantId,
        instanceId,
        conversationId,
        agentId,
        threadId: chatwootThreadId(tenantId, instanceId, conversationId),
      },
      // Compaction summarizes with a fixed prompt of its own and never runs the tested variant, so it
      // must not be counted as a participant. Resolving a variant INSERTS the assignment when the
      // thread has none — an attendance a human handled, or one that predates the experiment — and
      // that phantom row sits in the denominator of every result, quietly lowering the rates. Using
      // the conversation's own thread id is not enough on its own: it only makes the row LOOK real.
      { skipExperiment: true },
    );
    if (!cfg) return null;
    return {
      cfg,
      reopened,
      lastConversationId: thread?.lastConversationId ?? null,
      threadRowId: thread?.id ?? null,
    };
  });
  if (loaded === "off" || loaded === null) {
    return { outcome: "done" };
  }
  const cfg = loaded.cfg;

  // GENERATION FENCE, first half. The AgentThread row id is the token that says which generation of
  // this thread the job belongs to (see the second half, at the write below), so a job that starts
  // without one has no token and every later check would wave it through.
  //
  // No row means the thread was wiped: /reset deletes the row, the summary rows and the checkpoint
  // under this same lock. The channel can still come back populated afterwards — an invoke that
  // started earlier saves the state it had loaded, stamps included, and a nudge can write a
  // checkpoint without ever creating a row — and that residue is exactly what would be summarized
  // here and rendered back into the memory the operator explicitly cleared. Every path that stamps a
  // message upserts the row, so a thread with something to compact and no row is that residue and
  // nothing else. Refused before the state read, so it costs neither a generation nor a query.
  const threadRowId = loaded.threadRowId;
  if (threadRowId === null) return { outcome: "done" };

  // A turn holding this thread will undo the rewrite below, so there is nothing to gain by reading
  // its channel now. Checked here as well as under the lock because this side is what avoids PAYING
  // for a summary that the locked check would then discard; the locked one is what makes it correct.
  if (isTurnInFlight(graphThreadId)) {
    return deferForTurn(graphThreadId, "before reading the thread");
  }

  const checkpointer = deps.checkpointer ?? (await getCheckpointer());
  const graph = buildThreadStateGraph(checkpointer);
  const threadCfg = { configurable: { thread_id: graphThreadId } };
  const state = await graph.getState(threadCfg);
  const messages = ((state.values as { messages?: BaseMessage[] } | undefined)
    ?.messages ?? []) as BaseMessage[];

  // Whether the thread is still ON this conversation, asked of the MESSAGES rather than of
  // AgentThread.lastConversationId. The marker is advanced by whoever claims a boundary, and a claim
  // can be skipped (an overlapping invoke) while the turns of the new conversation are already in the
  // thread — so the marker can name a conversation the thread has left. The last stamp cannot. Older
  // threads carry no stamps at all, and those still answer from the marker.
  let lastStamp: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    const stamp = stampedConversationId(m);
    if (stamp !== null) {
      lastStamp = stamp;
      break;
    }
  }
  const attendanceIsCurrent =
    lastStamp !== null
      ? lastStamp === conversationId
      : loaded.lastConversationId === null ||
        loaded.lastConversationId === conversationId;

  const natural = selectClosedPrefix(messages, {
    currentAttendanceClosed:
      !loaded.reopened && reason === "resolved" && attendanceIsCurrent,
  });

  // A summary row whose turns are STILL in the thread is owed its rewrite. The row is committed
  // before the rewrite on purpose, so any deferral between the two leaves one behind, and this job's
  // dedupe key is the THREAD: a later attendance re-arms the same row and the retry arrives with a
  // wider prefix to summarize. Left alone, the wider cut gets its own key, the model is paid to
  // describe those turns a second time, and the head renders both rows over the same conversation.
  //
  // So the owed prefix is applied FIRST, and only up to where it ends: the summary for it already
  // exists, so the run costs no generation, and the rest compacts on the next pass.
  const owed = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.attendanceSummary.findFirst({
      where: { tenantId, chatwootInstanceId: instanceId, contactInboxId },
      orderBy: { id: "desc" },
      select: { lastMessageId: true, conversationId: true },
    }),
  );
  const owedIndex = owed
    ? messages.findIndex((m) => m.id === owed.lastMessageId)
    : -1;
  const headOffset = natural.head ? 1 : 0;
  const owedIsPending =
    owedIndex >= 0 &&
    owedIndex >= headOffset &&
    (loaded.reopened || owedIndex < headOffset + natural.closed.length);
  if (loaded.reopened && !owedIsPending) return { outcome: "done" };
  const cut = owedIsPending
    ? {
        head: natural.head,
        closed: messages.slice(headOffset, owedIndex + 1),
        open: messages.slice(owedIndex + 1),
      }
    : natural;
  // Which attendance the segment being folded belongs to, read off the segment itself rather than off
  // the payload. The two come apart in two ways, and both leave the memory filed under a conversation
  // it is not about:
  //
  //   - on the owed path the row describes an OLDER attendance than the job was armed for, and
  //     keying the lookup on the payload would miss the row it is about to apply and pay for a
  //     second summary of the same turns;
  //   - a job already CLAIMED cannot be called back. A new attendance re-arms the scheduler row while
  //     the handler is still running, so the cut it goes on to take can reach past the attendance the
  //     payload names — and the re-armed job then finds nothing left to do.
  //
  // The last stamped message of the closed chunk is what the chunk ENDS in, which is the attendance
  // it belongs to. Threads written before stamps existed have none, and fall back to the payload.
  let closedStamp: number | null = null;
  for (let i = cut.closed.length - 1; i >= 0; i--) {
    const m = cut.closed[i];
    if (m === undefined) continue;
    const stamp = stampedConversationId(m);
    if (stamp !== null) {
      closedStamp = stamp;
      break;
    }
  }
  const segmentConversationId = owedIsPending
    ? (owed?.conversationId ?? conversationId)
    : (closedStamp ?? conversationId);
  // What this row will be a summary OF: the last turn in the cut. It is the segment's identity, and
  // the reason a reopened conversation does not lose half its memory — a second cut on the same
  // conversation carries different turns, so it writes its OWN row instead of replacing or reusing
  // the first. A RETRY of the same cut lands on the same id and costs nothing.
  //
  // Absent, it also carries GUARANTEE 3 of 3 against compacting twice, and not as a flag anyone has
  // to remember to check: after a compaction the thread holds the head plus the open attendance, so
  // a second run finds an empty closed chunk, has no last turn, and stops HERE — before the model,
  // before the row, before the rewrite. Running the job twice costs one state read.
  const lastMessageId = cut.closed.at(-1)?.id;
  if (!lastMessageId) return { outcome: "done" };
  // When the attendance actually happened, read for the conversation the SEGMENT belongs to. The
  // boundary trigger fires only when the contact comes back, which can be months later, so the job's
  // own clock would date a returning customer's whole history to today — and the payload's
  // conversation would date it to a different attendance entirely.
  const segment = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: segmentConversationId,
        },
      },
      select: { id: true, lastEventAt: true },
    }),
  );
  const segmentAt = segment?.lastEventAt ?? null;
  const summaryKey = {
    tenantId_chatwootInstanceId_contactInboxId_conversationId_lastMessageId: {
      tenantId,
      chatwootInstanceId: instanceId,
      contactInboxId,
      conversationId: segmentConversationId,
      lastMessageId,
    },
  };
  const existing = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.attendanceSummary.findUnique({
      where: summaryKey,
      select: { summary: true },
    }),
  );
  let summary: string;
  if (existing) {
    summary = existing.summary;
  } else {
    const makeModel = deps.makeModel ?? createChatModel;
    const model = makeModel({
      ...cfg.mc,
      apiKey: cfg.apiKey,
      baseURL: cfg.credentialBaseUrl ?? cfg.mc.baseURL,
    });
    // Outside every lock: this is a provider round-trip, and holding a Postgres advisory lock across
    // the wire would block ingestion on this thread for as long as the model takes.
    // The same usage/trace handlers a turn's generation carries, with its own node label: this call
    // is billed to the tenant, and with compaction on by default it happens once per attendance
    // across every agent. Left off, the cost report would say the feature is free.
    const result = await summarizeAttendance(
      model,
      cut.closed,
      buildCallbacks(cfg, {
        tenantId,
        threadId: graphThreadId,
        node: "memory_compact",
        // The SEGMENT's conversation, not the payload's. Several boundaries can pass before a claimed
        // job reads the thread, and the row and the flow event already say which segment this is; a
        // usage row and a trace that said something else would put this spend on an attendance that
        // was never summarized here.
        conversationId: segment?.id ?? null,
        model: cfg.mc.model,
        source: "inbox",
        base,
      }),
      cfg.maxHistoryTokens,
    );
    if (result.error) return { outcome: "fail", error: result.error };
    summary = result.summary;
  }

  // The row is committed BEFORE the thread is rewritten, on purpose. The two failure orders are not
  // equally bad: a row written whose rewrite never lands means the same turns get summarized again
  // later and the memory says something twice, while a rewrite that lands with no row means the
  // attendance is simply gone. Duplicated memory is recoverable by reading it; lost memory is not.
  //
  // The reset fence sits in the SAME transaction, under the SAME lock /reset takes. `cancelPendingJob`
  // only reaches a job still PENDING, so a compaction already CLAIMED — provider call in flight —
  // outlives a reset that ran a second ago, and a check that is not atomic with the write is a race
  // the reset loses: it deletes, we recreate, and a later compaction renders memory the operator
  // explicitly cleared back into the thread. /reset deletes the AgentThread row and the next message
  // recreates it with a NEW id, so the id this job started with is the generation token — already in
  // the schema, one indexed read, nothing new to thread through.
  if (summary) {
    const wrote = await runScopedOn(base, sysCtx(tenantId), (db) =>
      withEntityLock(db, `ingest:${graphThreadId}`, async () => {
        // GENERATION FENCE, second half: the row this job started with is gone, so a /reset ran
        // while the provider call was in flight. Non-null by the check right after the load.
        const stillThere = await db.agentThread.count({
          where: { id: threadRowId },
        });
        if (stillThere === 0) return false;
        // GUARANTEE 2 of 3: one row per attendance SEGMENT, forever. `upsert` rather than
        // create+catch — a P2002 caught inside an aborted transaction cannot recover with an update.
        await db.attendanceSummary.upsert({
          where: summaryKey,
          create: {
            tenantId,
            chatwootInstanceId: instanceId,
            contactInboxId,
            conversationId: segmentConversationId,
            lastMessageId,
            summary,
            messageCount: cut.closed.length,
            attendanceAt: segmentAt,
          },
          update: { summary, messageCount: cut.closed.length },
        });
        return true;
      }),
    );
    if (!wrote) {
      logger.info(
        "memory: thread was reset while compacting (thread=%s), dropping the summary",
        graphThreadId,
      );
      return { outcome: "done" };
    }
  }

  const rewrite = await runScopedOn(base, sysCtx(tenantId), (db) =>
    // The lock ingestion also takes, so an ingested message cannot interleave with the rewrite.
    // It is NOT the whole story: a graph TURN writes to this thread without taking any lock, which
    // is why the update below names the messages it removes instead of clearing the channel.
    withEntityLock(db, `ingest:${graphThreadId}`, async () => {
      // The check that actually makes this safe. A graph invoke is a read-modify-write of the WHOLE
      // message channel — it saves the state it loaded at the start plus its own messages — so a
      // rewrite that lands while one is running is silently undone the moment it finishes: the raw
      // turns come back, the memory head disappears, and the next cut summarizes a segment that ends
      // one message later, writing a SECOND row that says the same thing. Removing messages by id
      // does not help, because the loser here is this whole checkpoint, not individual writes.
      //
      // Turns mark themselves under this same lock (src/graph/runtime.ts, src/graph/nudge.ts), so
      // reading the registry from inside it is exclusive: either no turn has started reading, or
      // this attempt stands down and comes back.
      if (isTurnInFlight(graphThreadId)) return "busy" as const;
      const fresh = await graph.getState(threadCfg);
      const current = ((
        fresh.values as { messages?: BaseMessage[] } | undefined
      )?.messages ?? []) as BaseMessage[];
      const consumed = [...(cut.head ? [cut.head] : []), ...cut.closed];
      // The thread is append-only between the read and this write, so the messages we summarized
      // must still be its prefix. If they are not, something rewrote the thread underneath us (the
      // /reset command deletes it outright) and the safe move is to abandon this attempt rather than
      // delete messages we never read. A shorter thread is covered by the same comparison: past its
      // end `current[i]` is undefined, which never equals an id.
      for (let i = 0; i < consumed.length; i++) {
        if (current[i]?.id !== consumed[i]?.id) return "changed" as const;
      }
      // Only what the head can render. The rows are kept forever by design (the head bounds what the
      // MODEL reads, not what the table stores), so a contact with years of history would otherwise
      // have every one of them loaded and sorted on every compaction to keep the newest twenty.
      // Newest-first with a limit, then back to chronological order, which is how the head reads.
      const rows = (
        await db.attendanceSummary.findMany({
          where: {
            tenantId,
            chatwootInstanceId: instanceId,
            contactInboxId,
          },
          // Unknown date sorts LAST on this descending window, never first. Postgres puts NULLs
          // first on DESC by default, which would let a row we could not date displace a genuinely
          // newer attendance out of the twenty the head renders.
          orderBy: [
            { attendanceAt: { sort: "desc", nulls: "last" } },
            { id: "desc" },
          ],
          take: MEMORY_HEAD_MAX_ATTENDANCES,
          select: { conversationId: true, summary: true, attendanceAt: true },
        })
      ).reverse();
      const head = renderMemoryHead(rows, cfg.timezone);
      // The update REMOVES BY ID and never clears the channel. REMOVE_ALL_MESSAGES would have been
      // shorter, and wrong: it replaces the whole list with what this update carries, so a message
      // appended between the read above and this write would be erased. Ingestion is held off by the
      // lock, but a graph TURN takes no lock and writes to this same thread, so that window is real
      // and a customer's message is what falls into it. Naming the ids leaves everything else alone,
      // whenever it arrived.
      //
      // The head reuses the id of the FIRST message it replaces, which is what keeps it at the front:
      // the reducer replaces a same-id message in place and appends an unknown-id one at the end, and
      // a memory head sitting after the conversation is not a header, it is a footnote.
      const survivorId = consumed[0]?.id;
      const dropped = consumed.filter((m) => m.id !== survivorId);
      await graph.updateState(
        threadCfg,
        {
          messages: [
            ...(head && survivorId
              ? [memoryHeadMessage(contentToText(head.content), survivorId)]
              : []),
            ...dropped.map((m) => new RemoveMessage({ id: m.id as string })),
            // NOTE: With no head to keep (every summary came back empty), the survivor has nothing
            // to become, so it is removed like the rest.
            ...(head
              ? []
              : survivorId
                ? [new RemoveMessage({ id: survivorId })]
                : []),
          ],
        },
        THREAD_STATE_NODE,
      );
      return "ok" as const;
    }),
  );
  if (rewrite === "busy") {
    return deferForTurn(graphThreadId, "at the rewrite");
  }
  if (rewrite === "changed") {
    return { outcome: "fail", error: "thread changed during compaction" };
  }

  emitFlowEvent(
    {
      tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      agentId,
      threadId: graphThreadId,
      // Without these the line exists but cannot be FOUND: the Logs page filters by conversation and
      // inbox database ids, and the operator who opens the trail from a conversation would see every
      // other stage and no compaction at all. It points at the attendance that was folded — the same
      // one `attendanceConversationId` names — which on the owed path is not the one the job carried.
      conversationId: segment?.id ?? cfg.conversationDbId,
      inboxId: cfg.inboxDbId,
      base,
    },
    {
      stage: "memory",
      level: "info",
      status: "ok",
      detail: {
        // The segment's own attendance, which on an owed rewrite is an OLDER one than the job was
        // armed for. Logging the payload's would file the compaction under the wrong conversation in
        // the operator's trail, exactly on the retries hardest to read.
        attendanceConversationId: segmentConversationId,
        messagesCompacted: cut.closed.length,
        summaryChars: summary.length,
        reason,
      },
    },
  );
  // An owed prefix is only the part a previous attempt already paid for. Anything the natural cut
  // reaches past it is still raw, and nothing else is going to come back for it: this job's row is
  // being retired right now, and the triggers that would re-arm it (a resolve, a new attendance) have
  // already fired. So the job asks for one more pass instead of declaring the thread compacted.
  if (owedIsPending && headOffset + natural.closed.length > owedIndex + 1) {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + DEFER_ON_TURN_MS),
    };
  }
  return { outcome: "done" };
}

const compactHandler = async (
  job: { tenantId: bigint; payload: Record<string, unknown> },
  base: PrismaClient,
): Promise<JobResult> => {
  const payload = parsePayload(job.payload);
  // A payload this process cannot read will never become readable, so retrying it only delays the
  // dead-letter. Nothing to compact is not a failure.
  if (!payload) return { outcome: "done" };
  return runCompaction(job.tenantId, payload, base);
};

let registered = false;
export function registerMemoryHandlers(): void {
  if (registered) return;
  registerJobHandler("MEMORY_COMPACT", compactHandler);
  registered = true;
}
