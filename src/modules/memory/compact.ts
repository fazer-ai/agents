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
  // The thread's owner, asked of the ROW and not only of this process: compaction runs on the
  // leader and a turn runs wherever the webhook landed, so an in-process registry reads a busy
  // thread as free and the rewrite is undone by the turn that saves after it (issue #203).
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

  // BARRIER (issue #194), and it runs BEFORE the generation fence below for a reason spelled out
  // there. Compaction is the other reader of this thread, and it is the one that cannot be corrected
  // afterwards: it replaces the raw turns of a closed attendance with a summary of them, so a message
  // still sitting in the ingestion queue is a message summarised out of existence — the later turn's
  // own barrier then appends it AFTER a summary written without it.
  //
  // This is also what makes the whole design independent of which workers a deployment runs. The
  // shared tick and the compaction tick are separately switchable, and a queue whose only drain is a
  // worker that may be off is a queue that silently stops.
  //
  // AND THE ANSWER IS CONSULTED, unlike at the two readers that cannot wait. A drain that ends with
  // the thread still owing something — a job that deferred for a turn, one that failed, one another
  // process has claimed — leaves this compaction about to read an incomplete attendance, and the
  // turn's release would clear the in-flight check below without putting the message back. Nothing
  // is paid for and nothing is written: the compaction job comes back, exactly as it does for a turn.
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

  // GENERATION FENCE, first half. The AgentThread row id is the token that says which generation of
  // this thread the job belongs to (see the second half, at the write below), so a job that starts
  // without one has no token and every later check would wave it through.
  //
  // No row means the thread was wiped: /reset deletes the row, the summary rows and the checkpoint
  // under this same lock. The channel can still come back populated afterwards — an invoke that
  // started earlier saves the state it had loaded, stamps included, and a nudge can write a
  // checkpoint without ever creating a row — and that residue is exactly what would be summarized
  // here and rendered back into the memory the operator explicitly cleared.
  //
  // THE PREMISE OF THAT MOVED WITH #194, which is why the drain above is not below this. The fence
  // rests on "every path that stamps a message upserts the row", so a thread with something to
  // compact and no row is residue and nothing else. Ingestion now stamps from a QUEUED row, so a
  // brand-new contact inbox whose first attendance was handled entirely by a person can reach a
  // resolve with messages owed and no thread row yet — read as residue, that attendance is retired
  // without ever being summarised, and no later event re-arms it. The drain is what tells the two
  // apart: it creates the row for a thread that has real messages owed, and what is STILL null after
  // it is residue. Re-read only on that path, so the ordinary compaction pays nothing for it.
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

  // A turn holding this thread will undo the rewrite below, so there is nothing to gain by reading
  // its channel now. Checked here as well as under the lock because this side is what avoids PAYING
  // for a summary that the locked check would then discard; the locked one is what makes it correct.
  if (await turnOwnsThread(owner, base)) {
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
    // WHICH model writes the memory. Everything the summariser may inherit from the agent comes back
    // through the resolver BY NAME, and the config below is built from that alone rather than spread
    // from `cfg.mc`: a spread carries whatever else the agent's config holds — today its
    // credentialRef, tomorrow any field the schema grows — across a provider switch, which is the
    // one thing the resolution exists to refuse. The speech rewrite is built the same way.
    const resolved = resolveModelOverride(
      cfg.memoryCompactionOverride,
      {
        provider: cfg.mc.provider,
        model: cfg.mc.model,
        baseURL: cfg.credentialBaseUrl ?? cfg.mc.baseURL,
      },
      { ownCredentialBaseURL: cfg.memoryCompactionCredentialBaseUrl },
    );
    // FAIL, where the speech rewrite SKIPS. Skipping the rewrite costs one reply its delivery in
    // speech; skipping the summary would leave the thread raw while reporting success, and the next
    // run would find the same turns and pay for them again. Failing keeps the thread intact, retries
    // with backoff, and — because a configuration this refuses will not become runnable by retrying —
    // reaches DEAD after five attempts with the reason on the line. The next attendance re-arms with
    // a fresh budget, so a corrected configuration recovers on its own.
    if (!resolved.runnable) {
      return {
        outcome: "fail",
        error: `memory compaction model not runnable: ${resolved.reason ?? "unknown"}`,
      };
    }
    // Its own credential was configured and did not resolve. Falling back to the AGENT's key would be
    // a silent substitution on a provider that may not even accept it.
    if (resolved.credential === "own" && !cfg.memoryCompactionApiKey) {
      return {
        outcome: "fail",
        error: "memory compaction model: credential_not_found",
      };
    }
    // Same VENDOR is not enough to carry the agent's sampling: `reasoningEffort` is an OpenAI-only
    // setting picked for one model id, and `planOpenAITransport` turns any explicit value into a
    // /v1/responses call carrying that effort. Handed to a different model on the same account —
    // the cheap-swap this knob exists for — that is a request the endpoint can refuse, and the
    // refusal costs every compaction on the agent, not one call.
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
      // Carried from the agent only while the call lands on the SAME model. Not a style choice: with
      // nothing configured this is the whole of what keeps the summaries identical to the ones this
      // install was already producing, and the prompt behind them was chosen by an A/B battery (see
      // ./summarize.ts) measured at whatever the agent was set to. Silently moving the temperature
      // would invalidate that measurement for every existing install.
      //
      // And that reason stops applying the instant the operator names a different model, which is
      // what makes "same vendor" the wrong test: the measurement being preserved was taken on the
      // agent's model, and a knob chosen for it is not a setting the new one has to accept.
      ...(sameModel
        ? {
            temperature: cfg.mc.temperature,
            reasoningEffort: cfg.mc.reasoningEffort,
          }
        : {}),
    };
    const makeModel = deps.makeModel ?? createChatModel;
    // createChatModel REJECTS some configurations synchronously (openai-compatible with no effective
    // base URL throws), and this config is separately editable, so that throw is reachable without
    // the agent's own model being broken. Uncaught it would escape as an unhandled job error rather
    // than a named one.
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
        // The model that ACTUALLY ran, not the agent's: this row is what the cost break-down reads,
        // and naming the agent's model here would file the summariser's spend under a model that
        // never saw the transcript.
        model: mc.model,
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
    const wrote = await withKeyedQueue(`ingest:${graphThreadId}`, () =>
      runScopedOn(base, sysCtx(tenantId), async (db) => {
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

  // The critical section ingestion also enters, so an ingested message cannot interleave with the
  // rewrite. It is NOT the whole story: a graph TURN writes to this thread without entering it,
  // which is why the update below names the messages it removes instead of clearing the channel.
  //
  // A process-local queue rather than a transaction-scoped advisory lock: the section reads and
  // writes the checkpointer, a SEPARATE Postgres pool, and holding a Prisma transaction open across
  // that is what drained the main pool for everything else in the process (issue #225).
  const rewrite = await withKeyedQueue(`ingest:${graphThreadId}`, async () => {
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
    if (await turnOwnsThread(owner, base)) return "busy" as const;
    const fresh = await graph.getState(threadCfg);
    const current = ((fresh.values as { messages?: BaseMessage[] } | undefined)
      ?.messages ?? []) as BaseMessage[];
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
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.attendanceSummary.findMany({
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
        }),
      )
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

// THE STATEMENT: this attendance will never be summarised.
//
// Every failure inside runCompaction returns before the success line, so until this existed the
// operator's trail showed every other stage of the turn and no memory line at all — for a model that
// does not exist on the account, a key not entitled to it, an endpoint that is down, a rate limit.
// The gap predates the summariser's own model override and the override is what makes it cost: a
// configuration can now fail ONLY compaction, so replies keep going out normally and the thing that
// silently stops is what the agent remembers (issue #196).
//
// ONLY AT THE DEAD-LETTER, not on the failures before it. A failure is not a statement that the work
// is lost — the next attempt may succeed, and the four before the cap are usually the same sentence
// four times inside half a minute (the whole budget burns in ~30s of jittered backoff). DEAD is the
// one moment the scheduler can say nobody is coming back for it, which is also the moment worth an
// alert channel's attention. What this trades away is a failure whose CAUSE changed between attempts:
// the line carries the last error, so four refusals from the provider followed by a lost race at the
// rewrite report the race.
//
// The attempt count is deliberately NOT on the line. It looked like it would say which road ended the
// job and it does not: both roads end at the cap, and the two disagree about the number while meaning
// the same thing — `failJob` increments the row and hands the hook the claim it was given, so the
// fifth failure reports four, while the reaper increments in SQL and returns five. What actually
// tells the roads apart is the error itself, which the reaper writes as "reaped: the claim never
// finished" and nothing else does.
//
// `error`, not `warn`: the convention elsewhere is that a stage whose failure the caller RECOVERS
// from is an advisory. Nothing recovers this one. The next attendance re-arms with a fresh budget, so
// a corrected configuration heals on its own — but the attendance this job was carrying is gone.
//
// The trail alone, and no private note in Chatwoot the way a dead debounce flush posts one (issue
// #71). A turn that never happened is visible to the customer, who is waiting; a memory that was
// never written is not, and a note about it would land in the conversation of a human agent who can
// do nothing with it.
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
    // RE-READ rather than trust the dead-letter that got us here. `armCompaction` upserts this very
    // row — the dedupeKey is the THREAD, reused by every attendance this contact ever has — back to
    // PENDING with a fresh retry budget, and the raw turns this job failed to cut are still on the
    // thread, so a re-armed row is an attendance that may yet be summarised. Suppressing loses
    // nothing: a configuration still broken fails the new arm too, and announces then.
    //
    // It NARROWS the window and cannot close it, which is worth stating rather than leaving for
    // someone to discover. The trail write is fire-and-forget by design (../flowlog/service.ts), so
    // no job ever waits on it, and a re-arm landing between this read and that insert still gets
    // announced over. Closing it would mean writing the row inside this transaction — giving up the
    // redaction and alert dispatch that live in the emit, to defend against an attendance boundary
    // arriving inside one scheduled callback. The residue is a line the next attendance's success
    // line follows, which is legible; the alternative was announcing over EVERY re-arm.
    const row = await db.schedulerJob.findUnique({
      where: { id: job.id },
      select: { status: true },
    });
    // Any status but DEAD suppresses, and the two that get here are not the same statement. PENDING
    // is the re-arm above. DONE is what /reset writes (`cancelPendingJob` updates rather than
    // deletes), so an operator who just cleared this thread is not told its memory went unwritten —
    // though only if the reset lands inside this hook's own execution, since a DEAD row is not
    // PENDING and reset leaves it alone. A missing row cannot be reached by this kind at all
    // (JOB_DELETE_ON_DONE is false for MEMORY_COMPACT, so nothing ever deletes it) and is treated as
    // live for the same reason the others are: no row is not evidence that work was lost.
    if (row?.status !== "DEAD") return "live" as const;
    // Without these the line exists and cannot be FOUND: the Logs page filters by conversation and
    // inbox database ids, and the operator opening the trail from a conversation is exactly who this
    // line is for. One indexed read on the mirror row, on a path that runs once per lost attendance.
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
  // Kept apart from "the mirror row is gone", which is a different answer with the same shape: that
  // one still announces, with null ids, because the attendance really was lost.
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
        // The attendance the job was ARMED for. The success line names the segment it actually cut,
        // which on an owed rewrite is an older one — but nothing was cut here, so there is no segment
        // to name and the arming is the only true anchor.
        attendanceConversationId: conversationId,
        reason,
      },
      // The half an operator acts on: `credential_not_found` and `HTTP 401` are different problems
      // with different fixes. Everything that reaches here is already a closed vocabulary — the
      // resolver's own reasons, the scheduler's "reaped: the claim never finished", and what
      // ./summarize.ts allows a provider failure to say — so this is not where a provider's words
      // would be filtered out, it is where they must never arrive. emitFlowEvent sanitizes and
      // bounds it regardless, as defence in depth.
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
