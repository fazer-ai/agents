import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, RemoveMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import {
  chatwootThreadId,
  contactInboxThreadId,
  getCheckpointer,
} from "@/graph/checkpointer";
import { owesHandbackNote } from "@/graph/handback";
import { drainPendingIngest } from "@/graph/ingest-drain";
import { memoryHeadMessage, stampedConversationId } from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
import type { ModelConfig } from "@/graph/model-config";
import { resolveModelOverride } from "@/graph/model-override";
import { createChatModel, type ResolvedModelConfig } from "@/graph/models";
import { buildCallbacks, loadAgentConfig } from "@/graph/prepare";
import { turnOwnsThread } from "@/graph/thread-claim";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import {
  type JobResult,
  registerDeadLetterHandler,
  registerJobHandler,
} from "@/modules/scheduler/worker";
import {
  MEMORY_HEAD_MAX_ATTENDANCES,
  renderEmptyMemoryHead,
  renderMemoryHead,
  selectClosedPrefix,
} from "./cut";
import { readMemoryConfig } from "./settings";
import { summarizeAttendance } from "./summarize";

// Memory compaction: when an attendance ends, its raw turns on the contact's thread are replaced by
// one summary of it, so the thread becomes "N summarized attendances + the current one, raw". Runs
// off the hot path as a scheduler job; no customer waits on the summarizer. See docs/graph.md,
// Memory compaction.

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
// protect; "new_attendance" means a later conversation already opened, and the cut finds it by the
// stamps.
export type CompactionReason = "resolved" | "new_attendance";

export interface ArmCompactionParams {
  tenantId: bigint;
  instanceId: bigint;
  contactInboxId: number;
  // The attendance that ended.
  conversationId: number;
  agentId: bigint;
  reason: CompactionReason;
  // The per-agent switch, already resolved by the caller (readMemoryConfig).
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
      // NOTE: guarantee 1 of 3 against compacting twice: SchedulerJob is unique on
      // (tenant, kind, dedupeKey) and enqueueJob upserts, so both triggers collapse into ONE row.
      dedupeKey: threadId,
      runAt: new Date(
        Date.now() + (p.reason === "resolved" ? GRACE_ON_RESOLVE_MS : 0),
      ),
      // NOTE: the dedupeKey is the THREAD, reused by every attendance, so each arm gets a fresh retry
      // budget or one bad day retires compaction for that contact permanently.
      rearm: "new-work",
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
  // NOTE: the thread's owner is asked of the ROW, not only of this process: a turn runs wherever the
  // webhook landed, and an in-process registry would read a busy thread as free.
  const owner = { tenantId, instanceId, contactInboxId, graphThreadId };

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
    // NOTE: a conversation reopened inside the grace window is not a closed attendance; the
    // boundary trigger picks it up later. It is not a reason to stop: an owed rewrite still lands.
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
    // NOTE: which conversation the thread is on now: a new attendance opened inside the grace window
    // leaves the resolved one resolved, and closing the whole thread would summarize the live one.
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
      // NOTE: never runs the tested variant, so it must not resolve one: that INSERTS a phantom
      // assignment into every experiment's denominator. And a summary is not a reply, so a monitoring
      // agent's memory is compacted like a production agent's.
      { skipExperiment: true, ignoreMode: true },
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

  // NOTE: barrier, before the generation fence below: a message still in the ingestion queue would
  // be summarized out of existence. Drained here because the worker that drains it may be off, and
  // the answer is consulted: anything still owed (deferred, failed, claimed elsewhere) reschedules
  // this job with nothing paid and nothing written.
  if ((await drainPendingIngest(tenantId, graphThreadId, base)) !== "drained") {
    logger.info(
      "memory: ingestion still owed on thread=%s, deferring compaction",
      graphThreadId,
    );
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + DEFER_ON_TURN_MS),
    };
  }

  // NOTE: generation fence, first half. The AgentThread row id says which generation of this thread
  // the job belongs to (second half at the write). No row means /reset wiped the thread, and any
  // channel residue (an earlier invoke saving, a nudge) must not be summarized back into memory.
  // Read after the drain, which creates the row for a thread with real messages owed: whatever is
  // still null after it is residue.
  const threadRowId =
    loaded.threadRowId ??
    (
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.agentThread.findUnique({
          where: {
            tenantId_chatwootInstanceId_contactInboxId: {
              tenantId,
              chatwootInstanceId: instanceId,
              contactInboxId,
            },
          },
          select: { id: true },
        }),
      )
    )?.id ??
    null;
  if (threadRowId === null) return { outcome: "done" };

  // NOTE: a turn holding this thread would undo the rewrite. Checked here to avoid PAYING for a
  // summary; the check under the lock is what makes it correct.
  if (await turnOwnsThread(owner, base)) {
    return deferForTurn(graphThreadId, "before reading the thread");
  }

  const checkpointer = deps.checkpointer ?? (await getCheckpointer());
  const graph = buildThreadStateGraph(checkpointer);
  const threadCfg = { configurable: { thread_id: graphThreadId } };
  const state = await graph.getState(threadCfg);
  const messages = ((state.values as { messages?: BaseMessage[] } | undefined)
    ?.messages ?? []) as BaseMessage[];

  // NOTE: whether the thread is still ON this conversation, asked of the last stamp rather than
  // AgentThread.lastConversationId: a skipped boundary claim leaves the marker naming a conversation
  // the thread has left. Threads with no stamps still answer from the marker.
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

  // NOTE: a summary row whose turns are STILL in the thread is owed its rewrite (the row commits
  // first, so a deferral leaves one behind). It is applied FIRST and only up to where it ends, at no
  // generation cost; otherwise a wider cut would pay to describe those turns again. The rest compacts
  // on the next pass.
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
  // NOTE: which attendance the folded segment belongs to, read off the segment, not the payload: an
  // owed row describes an OLDER attendance, and a claimed job's cut can reach past the attendance its
  // payload names. The chunk's last stamp is where it ends; threads without stamps use the payload.
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
  // NOTE: the last turn in the cut is the segment's identity: a reopened conversation's second cut
  // writes its OWN row, and a retry of the same cut costs nothing. Absent, it is guarantee 3 of 3
  // against compacting twice: an already compacted thread has an empty closed chunk and stops here.
  const lastMessageId = cut.closed.at(-1)?.id;
  if (!lastMessageId) return { outcome: "done" };
  // NOTE: dated by the SEGMENT's conversation, not the job's clock (it can run months later) nor the
  // payload's conversation.
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
    // NOTE: everything inherited from the agent comes back through the resolver BY NAME, never a
    // spread of `cfg.mc`, which would carry unknown fields (a credentialRef) across a provider switch.
    const resolved = resolveModelOverride(
      cfg.memoryCompactionOverride,
      {
        provider: cfg.mc.provider,
        model: cfg.mc.model,
        baseURL: cfg.credentialBaseUrl ?? cfg.mc.baseURL,
      },
      { ownCredentialBaseURL: cfg.memoryCompactionCredentialBaseUrl },
    );
    // NOTE: FAIL, where the speech rewrite skips: skipping would leave the thread raw while reporting
    // success. It reaches DEAD with the reason on the line; the next attendance re-arms, so a
    // corrected configuration recovers on its own.
    if (!resolved.runnable) {
      return {
        outcome: "fail",
        error: `memory compaction model not runnable: ${resolved.reason ?? "unknown"}`,
      };
    }
    // NOTE: its own credential did not resolve; the AGENT's key would be a silent substitution.
    if (resolved.credential === "own" && !cfg.memoryCompactionApiKey) {
      return {
        outcome: "fail",
        error: "memory compaction model: credential_not_found",
      };
    }
    // NOTE: same VENDOR is not enough to carry the agent's sampling: `reasoningEffort` is picked for
    // one model id and turns into a /v1/responses call another model can refuse.
    const sameModel =
      resolved.provider === cfg.mc.provider && resolved.model === cfg.mc.model;
    const mc: ResolvedModelConfig = {
      provider: resolved.provider as ModelConfig["provider"],
      model: resolved.model,
      apiKey:
        resolved.credential === "own"
          ? cfg.memoryCompactionApiKey
          : resolved.credential === "agent"
            ? cfg.apiKey
            : "",
      baseURL: resolved.baseURL ?? undefined,
      // NOTE: carried only on the SAME model: it keeps the summaries identical to what the install
      // already produced (the prompt was chosen at the agent's settings), and a different model need
      // not accept those knobs.
      ...(sameModel
        ? {
            temperature: cfg.mc.temperature,
            reasoningEffort: cfg.mc.reasoningEffort,
          }
        : {}),
    };
    const makeModel = deps.makeModel ?? createChatModel;
    // NOTE: createChatModel throws synchronously on some configurations (openai-compatible with no
    // base URL); this one is separately editable, so the throw becomes a named failure.
    let model: BaseChatModel;
    try {
      model = makeModel(mc);
    } catch (err) {
      return {
        outcome: "fail",
        error: `memory compaction model could not be built: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    // NOTE: outside every lock: holding one across a provider round-trip would block ingestion.
    // Carries the turn's usage/trace handlers under its own node, since the call is billed.
    const result = await summarizeAttendance(
      model,
      cut.closed,
      buildCallbacks(cfg, {
        tenantId,
        threadId: graphThreadId,
        node: "memory_compact",
        // NOTE: the SEGMENT's conversation, matching the row and the flow event.
        conversationId: segment?.id ?? null,
        // NOTE: the model that actually ran, which is what the cost break-down reads.
        billedModel: mc,
        source: "inbox",
        base,
      }),
      cfg.maxHistoryTokens,
    );
    if (result.error) return { outcome: "fail", error: result.error };
    summary = result.summary;
  }

  // NOTE: the row is committed BEFORE the rewrite: duplicated memory is recoverable, lost memory is
  // not. The reset fence sits in the same transaction under the lock /reset takes: a CLAIMED job
  // outlives `cancelPendingJob`, and /reset deletes the AgentThread row (the next message recreates it
  // with a new id), so the id this job started with is the generation token.
  if (summary) {
    const wrote = await withKeyedQueue(`ingest:${graphThreadId}`, () =>
      runScopedOn(base, sysCtx(tenantId), async (db) => {
        // NOTE: generation fence, second half: the row is gone, so a /reset ran mid-call.
        const stillThere = await db.agentThread.count({
          where: { id: threadRowId },
        });
        if (stillThere === 0) return false;
        // NOTE: guarantee 2 of 3: one row per attendance SEGMENT. `upsert`, since a P2002 caught
        // inside an aborted transaction cannot recover with an update.
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

  // NOTE: the critical section ingestion also enters. A graph TURN does not, which is why the update
  // names the messages it removes. A process-local queue, not an advisory lock: the section spans
  // the checkpointer's separate pool, and a Prisma transaction held across it drains the main pool.
  const rewrite = await withKeyedQueue(`ingest:${graphThreadId}`, async () => {
    // NOTE: the check that makes this safe. An invoke saves the WHOLE channel it loaded, so a rewrite
    // landing mid-turn is undone when it finishes. Turns mark themselves under this same lock
    // (runtime.ts, nudge.ts), so the read here is exclusive.
    if (await turnOwnsThread(owner, base)) return "busy" as const;
    const fresh = await graph.getState(threadCfg);
    const current = ((fresh.values as { messages?: BaseMessage[] } | undefined)
      ?.messages ?? []) as BaseMessage[];
    const consumed = [...(cut.head ? [cut.head] : []), ...cut.closed];
    // NOTE: append-only between the read and this write, so the summarized messages must still be
    // the prefix; otherwise (a /reset) abandon rather than delete what we never read. Past the end of
    // a shorter thread `current[i]` is undefined, which never equals an id.
    for (let i = 0; i < consumed.length; i++) {
      if (current[i]?.id !== consumed[i]?.id) return "changed" as const;
    }
    // NOTE: only what the head can render: rows are kept forever, so newest-first with a limit, then
    // back to chronological order.
    const rows = (
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.attendanceSummary.findMany({
          where: {
            tenantId,
            chatwootInstanceId: instanceId,
            contactInboxId,
          },
          // NOTE: Postgres puts NULLs first on DESC; an undated row must not displace a newer one.
          orderBy: [
            { attendanceAt: { sort: "desc", nulls: "last" } },
            { id: "desc" },
          ],
          take: MEMORY_HEAD_MAX_ATTENDANCES,
          select: { conversationId: true, summary: true, attendanceAt: true },
        }),
      )
    ).reverse();
    // NOTE: what the summarized stretch ended in. The deleted messages are the only place the
    // hand-back decision reads its evidence, so an empty head is kept when that stamp needs a carrier
    // (see renderEmptyMemoryHead).
    const owedHandback = owesHandbackNote(consumed);
    const head =
      renderMemoryHead(rows, cfg.timezone) ??
      (owedHandback ? renderEmptyMemoryHead() : null);
    // NOTE: removes BY ID and never clears the channel: a graph TURN takes no lock and may append in
    // this window. The head reuses the id of the FIRST message it replaces, which keeps it at the
    // front (the reducer replaces same-id in place and appends unknown ids).
    const survivorId = consumed[0]?.id;
    const dropped = consumed.filter((m) => m.id !== survivorId);
    await graph.updateState(
      threadCfg,
      {
        messages: [
          ...(head && survivorId
            ? [
                memoryHeadMessage(
                  contentToText(head.content),
                  survivorId,
                  // NOTE: asked of the consumed prefix: an older head carries its own stamp, so it
                  // propagates across repeated compactions.
                  owedHandback,
                ),
              ]
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
  });
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
      // NOTE: the Logs page filters by these ids. The attendance folded, which on the owed path is
      // not the one the job carried.
      conversationId: segment?.id ?? cfg.conversationDbId,
      inboxId: cfg.inboxDbId,
      base,
    },
    {
      stage: "memory",
      level: "info",
      status: "ok",
      detail: {
        // NOTE: the segment's own attendance, older than the job's on an owed rewrite.
        attendanceConversationId: segmentConversationId,
        messagesCompacted: cut.closed.length,
        summaryChars: summary.length,
        reason,
      },
    },
  );
  // NOTE: past an owed prefix the natural cut is still raw, and the triggers that would re-arm this
  // job already fired, so it asks for one more pass.
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
  // NOTE: an unreadable payload never becomes readable, so it is done, not retried.
  if (!payload) return { outcome: "done" };
  return runCompaction(job.tenantId, payload, base);
};

// Announces on the flow trail that this attendance will never be summarized, since a configuration
// can fail ONLY compaction while replies keep going out. Only at the dead-letter, the one moment
// nobody is coming back for it; the line carries the last error, not the attempt count (failJob and
// the reaper disagree on it; "reaped: the claim never finished" tells the roads apart). `error`, since
// nothing recovers this attendance. No Chatwoot note: a missing memory is invisible to the customer
// and a human agent can do nothing with it.
export async function announceDeadCompaction(
  job: ClaimedJob,
  error: string,
  base: PrismaClient,
): Promise<void> {
  const payload = parsePayload(job.payload);
  if (!payload) return;
  const { instanceId, contactInboxId, conversationId, agentId, reason } =
    payload;
  const read = await runScopedOn(base, sysCtx(job.tenantId), async (db) => {
    // NOTE: re-read rather than trust the dead-letter: `armCompaction` may have upserted this row
    // back to PENDING (the key is the THREAD), and a still-broken configuration announces on that arm.
    // This narrows the window without closing it: the trail write is fire-and-forget.
    const row = await db.schedulerJob.findUnique({
      where: { id: job.id },
      select: { status: true },
    });
    // NOTE: any status but DEAD suppresses. PENDING is a re-arm; DONE is what /reset writes
    // (`cancelPendingJob` updates). A missing row cannot happen for this kind (JOB_DELETE_ON_DONE is
    // false) and reads as live: no row is not evidence that work was lost.
    if (row?.status !== "DEAD") return "live" as const;
    // NOTE: the Logs page filters by conversation and inbox database ids.
    return db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: job.tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: { id: true, inboxId: true },
    });
  });
  // NOTE: distinct from a missing mirror row, which still announces with null ids.
  if (read === "live") return;
  const conv = read;
  emitFlowEvent(
    {
      tenantId: job.tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      agentId,
      threadId: contactInboxThreadId(job.tenantId, instanceId, contactInboxId),
      conversationId: conv?.id ?? null,
      inboxId: conv?.inboxId ?? null,
      base,
    },
    {
      stage: "memory",
      level: "error",
      status: "error",
      detail: {
        // NOTE: the attendance the job was ARMED for: nothing was cut, so there is no segment.
        attendanceConversationId: conversationId,
        reason,
      },
      // NOTE: already a closed vocabulary (the resolver's reasons, the reaper's line, what
      // providerFailure allows), so a provider's own words never arrive here; emitFlowEvent still
      // sanitizes and bounds it.
      errorMessage: error,
    },
  );
}

let registered = false;
export function registerMemoryHandlers(): void {
  if (registered) return;
  registerJobHandler("MEMORY_COMPACT", compactHandler);
  registerDeadLetterHandler("MEMORY_COMPACT", announceDeadCompaction);
  registered = true;
}
