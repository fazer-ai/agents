import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { parseThreadId } from "@/graph/nudge";
import { type AgentConfig, loadAgentConfig } from "@/graph/prepare";
import {
  type RunAgentTurnOutcome,
  type RuntimeDeps,
  runLoadedTurn,
} from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { overlayMediaAnnotations } from "@/modules/chatwoot/annotations";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  buildQuoteResolver,
  type ChatwootMessageRow,
  maxIncomingId,
  parseChatwootMessages,
  pendingIncoming,
  toRenderable,
} from "@/modules/chatwoot/messages";
import { shouldBotHandle } from "@/modules/chatwoot/normalize";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import {
  clearConversationError,
  recordConversationError,
} from "@/modules/conversations/error";
import { emitFlowEvent } from "@/modules/flowlog/service";
import type { FlowStage } from "@/modules/flowlog/stages";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { readLastMessageId } from "./service";
import { readDebounceConfig } from "./settings";
import { advanceHandledWatermark } from "./watermark";

// The DEBOUNCE flush: re-fetch the conversation from Chatwoot, coalesce the inbound messages past the
// watermark into one turn, and answer once. Two re-fetches by design: the first builds the burst to
// answer; the second (in shouldPost, just before posting) is the n8n-faithful post-response
// supersede — if a newer message arrived during the LLM call, drop this reply and let the re-armed
// flush answer the full burst. The monotonic watermark CAS makes a concurrent claim post at most
// once. All network I/O is outside transactions; deps are injectable for tests.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The shared "re-fetch → coalesce a burst → answer once" tail, reused by the debounce flush AND the
// manual re-engage (item 6). The caller resolves the agent + conversation context; `selectPending`
// is the burst strategy (flush: incoming past the watermark; re-engage: incoming after the last
// outgoing). At-most-once is the monotonic watermark CAS in `shouldPost` (NOT an advisory lock — the
// turn does network I/O and must not hold a transaction): a concurrent flush/re-engage that lost the
// CAS posts nothing. Returns the runtime outcome, or "empty" when there is nothing to answer.
export interface CoalesceTurnContext {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  threadId: string;
  agentBotId: number | null;
  convDbId: bigint;
  loaded: AgentConfig;
  settings: unknown;
  selectPending: (messages: ChatwootMessageRow[]) => ChatwootMessageRow[];
  // Label for the single summary log line ("debounce flush" / "reengage").
  label: string;
  // When set (the debounce flush passes "debounce"), emit a flow line for the coalescing under the
  // turn's group. Reengage leaves it unset (it is a manual re-fire, not message grouping).
  coalesceStage?: FlowStage;
}

export async function coalesceAndRunTurn(
  ctx: CoalesceTurnContext,
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<RunAgentTurnOutcome | "empty"> {
  const {
    tenantId,
    instanceId,
    conversationId,
    threadId,
    agentBotId,
    convDbId,
    loaded,
  } = ctx;

  // 1. Re-fetch the thread (network) and select the burst to answer.
  const client = await loadChatwootClient(tenantId, instanceId, {
    base,
    makeClient: deps?.makeClient,
  });
  const messages = parseChatwootMessages(
    await client.getMessages(conversationId),
  );
  // NOTE: Overlay the in-process media annotations BEFORE selecting/rendering: on upstream Chatwoot
  // the attachment-meta write-back 404s, so this is the only way a voice note's transcription (or a
  // vision extraction) reaches the flush (issue #49). Meta values, when present, stay authoritative.
  overlayMediaAnnotations(tenantId, instanceId, messages);
  let pending = ctx.selectPending(messages);
  if (pending.length === 0) return "empty";

  const cfg = readDebounceConfig(ctx.settings);
  if (pending.length > cfg.maxMessagesPerBurst) {
    logger.warn(
      "%s: burst of %d messages capped to %d (conv=%s)",
      ctx.label,
      pending.length,
      cfg.maxMessagesPerBurst,
      String(conversationId),
    );
    pending = pending.slice(pending.length - cfg.maxMessagesPerBurst);
  }
  const targetWatermark = pending[pending.length - 1]?.id as number;
  // The agent answers the burst's MOST RECENT message, so {{message_id}} must be that exact id.
  // Take the max id over the burst (order-independent, and across every message type incl. an
  // audio-only last message) instead of trusting the array position.
  const lastMessageId = pending.reduce(
    (max, m) => (m.id > max ? m.id : max),
    0,
  );
  // Resolve quoted/replied-to messages from the full page, then render each pending message for the
  // agent (markers for audio/image/file, quote context). Coalesce into one turn.
  const resolveQuoted = buildQuoteResolver(messages);
  const rendered = pending
    .map((m) => renderInboundMessage(toRenderable(m), { resolveQuoted }))
    .filter((s) => s.length > 0);
  if (rendered.length === 0) {
    // Nothing in the burst renders to answerable text — it never will, so mark it handled or every
    // future flush re-fetches and re-stops on the same messages.
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: convDbId,
      toMessageId: targetWatermark,
      base,
    });
    return "empty";
  }
  const text = rendered.join("\n");

  // 2. Post gate: re-fetch to detect mid-turn arrivals (supersede), then advance the watermark
  //    monotonically so a concurrent claim cannot also post. Re-fetch failure is non-fatal.
  const shouldPost = async (): Promise<boolean> => {
    try {
      const latest = parseChatwootMessages(
        await client.getMessages(conversationId),
      );
      if (maxIncomingId(latest, targetWatermark) > targetWatermark) {
        logger.info(
          "%s: superseded mid-turn (conv=%s), deferring",
          ctx.label,
          String(conversationId),
        );
        return false;
      }
    } catch (e) {
      logger.warn(
        "%s: supersede re-fetch failed (conv=%s): %s",
        ctx.label,
        String(conversationId),
        err(e),
      );
    }
    return advanceHandledWatermark({
      tenantId,
      conversationDbId: convDbId,
      toMessageId: targetWatermark,
      base,
    });
  };

  // 3. Run the turn with the coalesced text. A thrown error bubbles to the caller. Share one turnId
  //    so the coalescing line and the turn's stages group together in the logs.
  const turnId = crypto.randomUUID();
  if (ctx.coalesceStage) {
    emitFlowEvent(
      {
        tenantId,
        turnId,
        source: "inbox",
        conversationId: loaded.conversationDbId,
        agentId: loaded.agentId,
        inboxId: loaded.inboxDbId,
        threadId,
        base,
      },
      {
        stage: ctx.coalesceStage,
        level: "info",
        status: "ok",
        detail: { coalesced: pending.length },
      },
    );
  }
  const outcome = await runLoadedTurn({
    loaded,
    tenantId,
    instanceId,
    conversationId,
    agentBotId,
    threadId,
    turnId,
    text,
    // The id of the burst's most recent message, exposed to tools as {{message_id}}.
    messageId: lastMessageId,
    userSentAudio: pending.some((m) => m.attachmentTypes.includes("audio")),
    base,
    deps,
    shouldPost,
  });
  // Every completed outcome except "superseded" consumed the burst: answered ("posted" — where
  // shouldPost's CAS already advanced, making this a no-op, including the input-guardrail template
  // which claims through the same gate), or deliberately dropped (taken over mid-turn, empty
  // reply, guardrail "silent"). Advance so the next flush cannot re-answer the same burst (issue
  // #8: the pre-handoff backlog was re-coalesced — and the bot re-transferred for the old reason —
  // after a human returned the conversation). "superseded" stays put by design: the re-armed flush
  // answers the FULL burst.
  if (outcome !== "superseded") {
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: convDbId,
      toMessageId: targetWatermark,
      base,
    });
  }
  logger.info(
    "%s: conv=%s msgs=%d watermark→%d outcome=%s",
    ctx.label,
    String(conversationId),
    pending.length,
    targetWatermark,
    outcome,
  );
  return outcome;
}

export interface FlushDebounceParams {
  job: ClaimedJob;
  base: PrismaClient;
  deps?: RuntimeDeps;
}

export async function flushDebounceJob(
  params: FlushDebounceParams,
): Promise<JobResult> {
  const { job, base, deps } = params;
  const threadId =
    typeof job.payload.threadId === "string" ? job.payload.threadId : null;
  if (!threadId) return { outcome: "done" };
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return { outcome: "done" };
  const { instanceId, conversationId } = parsed;
  const tenantId = job.tenantId;
  const agentBotId =
    typeof job.payload.agentBotId === "number" ? job.payload.agentBotId : null;

  // 1. Scoped read: mirror conv + gate + resolve the agent config (DB only).
  const ctx = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: {
        id: true,
        status: true,
        assigneeType: true,
        inboxId: true,
        lastHandledMessageId: true,
      },
    });
    if (!conv?.inboxId) return null;
    // Gate: only the bot still owns it (pending, no human / our bot).
    if (
      !shouldBotHandle(
        { assigneeType: conv.assigneeType, status: conv.status },
        { ourAgentBotId: agentBotId },
      )
    ) {
      return { gateClosed: true as const, convDbId: conv.id };
    }
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return null;
    const agentRow = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { settings: true },
    });
    const loaded = await loadAgentConfig(db, {
      tenantId,
      instanceId,
      conversationId,
      agentId: inbox.agentId,
      threadId,
    });
    if (!loaded) return null;
    return {
      convDbId: conv.id,
      watermark: conv.lastHandledMessageId,
      loaded,
      settings: agentRow?.settings ?? {},
    };
  });
  // No agent / unbound inbox → nothing to do (not a failure).
  if (ctx === null) return { outcome: "done" };
  // Human took over between the arm and this flush: the burst is the human's to answer now, so it
  // still counts as handled. The arm path kept the burst's newest message id in the payload
  // precisely so this advance needs no network fetch (issue #8) — without it, the burst would sit
  // below the watermark and the first flush after the human returns the conversation would
  // re-answer it.
  if ("gateClosed" in ctx) {
    const last = readLastMessageId(job.payload);
    if (last !== null) {
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: ctx.convDbId,
        toMessageId: last,
        base,
      });
    }
    return { outcome: "done" };
  }

  // Coalesce the burst past the watermark and answer once. A thrown error (LLM/Chatwoot) bubbles to
  // the worker → retry with backoff (watermark not advanced, so the retry re-answers the same burst).
  // The error is also surfaced on the conversation (item 6) so the operator can re-engage; a
  // successful answer clears it.
  const watermark = ctx.watermark;
  try {
    const outcome = await coalesceAndRunTurn(
      {
        tenantId,
        instanceId,
        conversationId,
        threadId,
        agentBotId,
        convDbId: ctx.convDbId,
        loaded: ctx.loaded,
        settings: ctx.settings,
        selectPending: (messages) => pendingIncoming(messages, watermark),
        label: "debounce flush",
        coalesceStage: "debounce",
      },
      base,
      deps,
    );
    if (outcome === "posted") {
      await clearConversationError({
        tenantId,
        instanceId,
        chatwootConversationId: conversationId,
        base,
      });
    }
    return { outcome: "done" };
  } catch (e) {
    await recordConversationError({
      tenantId,
      instanceId,
      chatwootConversationId: conversationId,
      error: e,
      base,
    });
    throw e;
  }
}

// Production handler: no injected deps (real client/model/checkpointer).
function debounceFlushHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  return flushDebounceJob({ job, base });
}

let registered = false;
export function registerDebounceHandler(): void {
  if (registered) return;
  registerJobHandler("DEBOUNCE", debounceFlushHandler);
  registered = true;
}
