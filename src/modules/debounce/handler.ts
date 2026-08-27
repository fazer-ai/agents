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
import { retireCoveredDeliveries } from "@/modules/chatwoot/delivery-sweep";
import {
  describeClosedGate,
  type GateCloseDetail,
} from "@/modules/chatwoot/gate-close";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  buildQuoteResolver,
  type ChatwootMessageRow,
  maxIncomingId,
  parseChatwootMessages,
  pendingIncoming,
  toRenderable,
} from "@/modules/chatwoot/messages";
import {
  heldByAnotherParty,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import type { AuthContext } from "@/modules/contact-auth/check";
import {
  authorizeContact,
  contactAuthFlowEvent,
} from "@/modules/contact-auth/service";
import {
  clearConversationError,
  recordConversationError,
} from "@/modules/conversations/error";
import { announceFailedTurn } from "@/modules/conversations/failure-note";
import { emitFlowEvent } from "@/modules/flowlog/service";
import type { FlowStage } from "@/modules/flowlog/stages";
import { emitUnroutedMessage } from "@/modules/flowlog/unrouted";
import {
  type ClaimedJob,
  jobRetired,
  jobRetiredStrict,
} from "@/modules/scheduler/service";
import {
  type JobResult,
  registerDeadLetterHandler,
  registerJobHandler,
} from "@/modules/scheduler/worker";
import { announceSpendCeilingOnConversation } from "@/modules/spend-ceiling/notice";
import {
  announceSpendCeiling,
  SPEND_CEILING_BURST_WINDOW_MS,
  spendCeilingVerdict,
} from "@/modules/spend-ceiling/service";
import { readLastMessageId } from "./service";
import { readDebounceConfig } from "./settings";
import { advanceHandledWatermark, readHandledWatermark } from "./watermark";

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
  // The authorization verdict's context bag for the check this caller ran immediately before the
  // turn, or null when the gate is off. Required so a new caller of this tail has to answer the
  // question rather than inherit a silent default.
  authContext: AuthContext | null;
  // May be async: the debounce flush re-reads the handled watermark here, at the latest point
  // before the burst is chosen, because an authorization refusal that landed while this flush was
  // asking the endpoint has already moved it.
  selectPending: (
    messages: ChatwootMessageRow[],
  ) => ChatwootMessageRow[] | Promise<ChatwootMessageRow[]>;
  // Whether the run that queued this turn is still wanted, handed straight to `runLoadedTurn`,
  // which asks it inside the `ingest:` lock and again before each post. REQUIRED and nullable so a
  // future caller has to answer it: `null` says "nothing queued this, nothing can call it off".
  stillWanted: ((opts: { strict: boolean }) => Promise<boolean>) | null;
  // Label for the single summary log line ("debounce flush" / "reengage").
  label: string;
  // When set (the debounce flush passes "debounce"), emit a flow line for the coalescing under the
  // turn's group. Reengage leaves it unset (it is a manual re-fire, not message grouping).
  coalesceStage?: FlowStage;
}

// IS THERE A BURST TO ANSWER, and what is it? Step 1 of the coalescing tail, lifted out because two
// callers ask it and one of them is not running a turn: the spend-ceiling branch of the flush has to
// know whether the burst it is about to refuse EXISTS before it says a word to the customer. Asking
// it there with a second copy of this selection would be a second answer to one question, and the
// two would drift the first time the cap or the rendering changed.
//
// Null means there is nothing to answer, and it has already settled whatever "nothing" meant: a
// burst that renders to no answerable text never will, so the watermark advances past it or every
// future flush re-fetches and re-stops on the same messages.
interface AnswerableBurst {
  client: Awaited<ReturnType<typeof loadChatwootClient>>;
  pending: ChatwootMessageRow[];
  // The messages the burst cap took OUT. Answered by nobody, on purpose.
  dropped: ChatwootMessageRow[];
  targetWatermark: number;
  lastMessageId: number;
  text: string;
}

export async function selectAnswerableBurst(
  ctx: Pick<
    CoalesceTurnContext,
    | "tenantId"
    | "instanceId"
    | "conversationId"
    | "convDbId"
    | "selectPending"
    | "settings"
    | "label"
  >,
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<AnswerableBurst | null> {
  const { tenantId, instanceId, conversationId, convDbId } = ctx;

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
  let pending = await ctx.selectPending(messages);
  if (pending.length === 0) return null;
  let dropped: typeof pending = [];

  const cfg = readDebounceConfig(ctx.settings);
  if (pending.length > cfg.maxMessagesPerBurst) {
    logger.warn(
      "%s: burst of %d messages capped to %d (conv=%s)",
      ctx.label,
      pending.length,
      cfg.maxMessagesPerBurst,
      String(conversationId),
    );
    // Kept, because the watermark below advances past them all the same and the ledger has to say
    // the same thing the watermark does. These messages were LOOKED AT and deliberately left out —
    // that is what the cap is — so a row of theirs still sitting non-terminal is a deliberate
    // silence, not a delivery nothing ever reached. Left open, every capped burst that contains a
    // strand reports it as a customer nobody answered, which is true only in the sense that makes
    // the loss list worthless: nobody was ever going to.
    dropped = pending.slice(0, pending.length - cfg.maxMessagesPerBurst);
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
    return null;
  }
  return {
    client,
    pending,
    dropped,
    targetWatermark,
    lastMessageId,
    text: rendered.join("\n"),
  };
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

  const burst = await selectAnswerableBurst(ctx, base, deps);
  if (!burst) return "empty";
  const { client, pending, dropped, targetWatermark, lastMessageId, text } =
    burst;

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
    stillWanted: ctx.stillWanted,
    loaded,
    authContext: ctx.authContext,
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
  // "stale" stays put too, and NOT by the same reasoning: superseded means a newer message will
  // re-answer this burst, while stale means the burst was withdrawn with the thread the command
  // cleared. Advancing on it would declare handled a set of messages nothing ever answered, and the
  // next inbound would arm a flush that starts after them.
  // NOTE: Which this skip can only preserve where the CAS has not already run. A retirement that
  // lands inside `shouldPost` is caught by the ask after it, and by then the claim has advanced —
  // skipping here is a no-op for that one window. Accepted where it stands: the alternative is a
  // reply posted into a conversation the customer just reset.
  if (outcome !== "superseded" && outcome !== "stale") {
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: convDbId,
      toMessageId: targetWatermark,
      base,
    });
    // And say so on the LEDGER, for the messages this burst actually contained. A burst re-fetched
    // from Chatwoot can carry a message whose own delivery died mid-processing — rescuing those is
    // what re-reading the thread buys — and that row is still sitting non-terminal with nothing
    // working it. Retired here, the stranded-delivery sweep needs no watermark arithmetic to tell a
    // message a turn covered from one nothing ever looked at (issue #228). Normally updates nothing.
    // Best-effort: a miss costs a line in the loss list, never a reply.
    try {
      await retireCoveredDeliveries({
        tenantId,
        instanceId,
        conversationId,
        conversationRowId: convDbId,
        // "posted" is the only outcome that reached the customer. Every other one here consumed the
        // burst deliberately — an empty reply, a guardrail going silent, a human taking over
        // mid-turn — and calling those answered would be the lie the parameter exists to prevent.
        settlement: outcome === "posted" ? "answered" : "consumed",
        messageIds: pending.map((m) => m.id),
        base,
      });
      // And the ones the cap took out, which the watermark above just declared handled. Separate
      // call rather than a wider id list, because the WORD differs: a posted reply answered the
      // burst it was given, and never these.
      if (dropped.length > 0) {
        await retireCoveredDeliveries({
          tenantId,
          instanceId,
          conversationId,
          conversationRowId: convDbId,
          settlement: "consumed",
          messageIds: dropped.map((m) => m.id),
          base,
        });
      }
    } catch (e) {
      logger.warn(
        "%s: could not retire the covered deliveries (conv=%s): %s",
        ctx.label,
        String(conversationId),
        err(e),
      );
    }
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

// A gate exit consumed the burst without a turn, and the ledger has to hear it too.
//
// These three exits decide before any Chatwoot fetch, so the burst is not known message by message —
// what IS known is the watermark they advance, which says everything up to `last` is handled. A row
// still non-terminal below that is one whose delivery died before arming this very flush, and left
// unretired it becomes a reported loss for a message the product deliberately declined to answer
// (issue #228).
//
// Best-effort: a miss costs a line in the loss list, never a reply.
async function settleGateExit(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  conversationRowId: bigint;
  // The burst this exit consumed, and BOTH ends matter. The watermark as it stood is the lower
  // bound: below it sits whatever earlier messages already had decided for them, including a strand
  // this gate knows nothing about, and reaching back over one hides a real loss for good.
  afterMessageId: number | null;
  upToMessageId: number;
  // Whether the state that closed the gate is ANOTHER AgentBot, as opposed to a human, a status
  // change or a decision about the contact. The one thing about the gate this exit is scoped by.
  heldByAnotherBot: boolean;
  base: PrismaClient;
  label: string;
}): Promise<void> {
  // Another BOT holding the conversation is the exit that may not widen, and the rule is the direct
  // path's, at its own gate tail. Chatwoot fans a message to up to two routes (`agent_bots_for`: the
  // assignee bot and the inbox bot, each with its own delivery id), so the OWNER's delivery for a
  // message in this range may be `PROCESSING` right now — and a range write turns it `PROCESSED`,
  // the one state the sweep never looks at again. If that route then dies, a customer the owner was
  // answering goes unanswered with nothing anywhere saying so.
  //
  // Skipped whole rather than narrowed, because there is nothing here to narrow TO: the direct path
  // scopes to its own row, and a flush has none — every delivery that armed or extended this burst
  // reached `PROCESSED` at its own tx2, and what this exit retires is rows OTHER deliveries
  // stranded. Standing to close those comes from being the route that decided the silence, and once
  // another bot owns the conversation the silence is only about us.
  //
  // The cost is a strand of ours staying in the loss list while another bot answers the customer:
  // wrong and VISIBLE, correctable by the first turn that runs over the message.
  if (params.heldByAnotherBot) return;
  try {
    await retireCoveredDeliveries({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      conversationId: params.conversationId,
      conversationRowId: params.conversationRowId,
      // A gate exit is a deliberate silence by definition: it decided before any model call.
      settlement: "consumed",
      afterMessageId: params.afterMessageId,
      upToMessageId: params.upToMessageId,
      base: params.base,
    });
  } catch (e) {
    logger.warn(
      "%s: could not retire the deliveries the gate consumed (conv=%s): %s",
      params.label,
      String(params.conversationId),
      err(e),
    );
  }
}

// IS THE CONVERSATION STILL THIS ROUTE'S, asked against the mirror at the moment of asking.
//
// The gate at the top of a flush judges ONE instant, and what runs after it takes real time: the
// authorization gate waits on somebody else's endpoint, the spend ceiling on two of our own reads,
// and a human can claim the conversation while either does. So every gate that ACTS on the
// conversation afterwards has to ask again.
//
// One function rather than a block per gate, which is the whole reason it exists: the copy is the
// one that forgets `assigneeId`, and without it `shouldBotHandle` cannot tell OUR bot from another
// one, so a conversation handed to a different bot mid-gate reads as still ours.
async function conversationStillOurs(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentBotId: number | null;
  base: PrismaClient;
}): Promise<{
  ours: boolean;
  closed: GateCloseDetail;
  heldByAnotherBot: boolean;
}> {
  const { tenantId, instanceId, conversationId, agentBotId, base } = params;
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      // NOTE: assigneeId is part of the question, not decoration: without it shouldBotHandle
      // cannot tell OUR bot from another one, and a conversation handed to a different bot during
      // the gate would read as still ours.
      select: { status: true, assigneeType: true, assigneeId: true },
    });
    return {
      ours: shouldBotHandle(
        {
          assigneeType: conv?.assigneeType ?? null,
          assigneeId: conv?.assigneeId ?? null,
          status: conv?.status ?? null,
        },
        { ourAgentBotId: agentBotId },
      ),
      closed: describeClosedGate({
        assigneeType: conv?.assigneeType ?? null,
        status: conv?.status ?? null,
      }),
      // Same question as at the gate on the way in, and asked here for the same reason: this is
      // the exit that runs when the conversation moved to another bot DURING the gate, which is
      // precisely the window in which that bot's own delivery is in flight.
      heldByAnotherBot:
        conv?.assigneeType === "AgentBot" &&
        heldByAnotherParty(
          {
            assigneeType: conv.assigneeType,
            assigneeId: conv.assigneeId ?? null,
          },
          { ourAgentBotId: agentBotId },
        ),
    };
  });
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
        assigneeId: true,
        inboxId: true,
        lastHandledMessageId: true,
      },
    });
    if (!conv?.inboxId) return null;
    // NOTE: Read above the gate so a gate that CLOSES can still say whose conversation it was: the
    // line it writes is filtered by agent on the Logs page, and one written without an agent id is
    // invisible in exactly the view an operator investigating one agent is looking at.
    //
    // NOTE: the unbound-inbox bail stays BELOW the gate, where it was. Above it, a closed gate on an
    // inbox that lost its agent would leave without advancing the watermark, and the burst it was
    // holding would be re-coalesced and answered after a later rebind. Attribution is worth a
    // nullable id here; it is not worth changing what the gate does.
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true, chatwootInboxId: true },
    });
    // Gate: only the bot still owns it (pending, no human / our bot).
    if (
      !shouldBotHandle(
        {
          assigneeType: conv.assigneeType,
          assigneeId: conv.assigneeId,
          status: conv.status,
        },
        { ourAgentBotId: agentBotId },
      )
    ) {
      return {
        // Tagged with a literal, like the unbound exit below, rather than left to be told apart by
        // the presence of `gateClosed`. TypeScript gives every sibling of a union of object literals
        // an implicit `?: undefined` for the properties it lacks, so an `in` check narrows nothing
        // and every field read out of this branch comes back widened with `undefined`.
        gateExit: true as const,
        // NOTE: Classified WITH the gate, not after it: a second read would answer about a
        // different moment, and the whole point of the line is which state closed THIS gate.
        gateClosed: describeClosedGate({
          assigneeType: conv.assigneeType,
          status: conv.status,
        }),
        convDbId: conv.id,
        inboxDbId: conv.inboxId,
        agentId: inbox?.agentId ?? null,
        // Carried on this branch too, and it is not decoration: the exit below retires the ledger
        // rows of the burst it consumed, and this is that burst's LOWER bound. Missing, the range is
        // open at the bottom and reaches back over a strand an earlier message left behind.
        watermark: conv.lastHandledMessageId,
        // WHICH other party, when there is one. A human taking the conversation is a statement about
        // the message — they answer it, whichever route carried it — and another BOT is not. Read
        // from the same conversation row the gate just judged, for the same reason `gateClosed` is.
        heldByAnotherBot:
          conv.assigneeType === "AgentBot" &&
          heldByAnotherParty(
            { assigneeType: conv.assigneeType, assigneeId: conv.assigneeId },
            { ourAgentBotId: agentBotId },
          ),
      };
    }
    if (!inbox?.agentId) {
      // NOTE: The inbox has no agent — it never had one, or it lost it between the arm and this
      // flush. The burst is the customer's, and until issue #318 this exit was as silent as the
      // webhook's: same state, same line, written by the same producer. The watermark is
      // deliberately NOT advanced (see the note above): the burst has to survive a later rebind.
      return {
        unbound: true as const,
        convDbId: conv.id,
        inboxDbId: conv.inboxId,
        chatwootInboxId: inbox?.chatwootInboxId ?? null,
      };
    }
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
      inboxChatwootId: inbox.chatwootInboxId,
      watermark: conv.lastHandledMessageId,
      loaded,
      settings: agentRow?.settings ?? {},
    };
  });
  // No conversation / no config → nothing to do (not a failure).
  if (ctx === null) return { outcome: "done" };
  // NOTE: An unbound inbox is a state an operator has to repair, so it leaves the same line the
  // webhook's direct path leaves rather than ending as a silent "done" (issue #318).
  if ("unbound" in ctx) {
    emitUnroutedMessage({
      tenantId,
      conversationRowId: ctx.convDbId,
      inboxRowId: ctx.inboxDbId ?? null,
      chatwootInboxId: ctx.chatwootInboxId ?? null,
      threadId,
      base,
    });
    return { outcome: "done" };
  }
  // NOTE: The gate closed between the arm and this flush, and TWO different events wear that exit:
  // a human took the conversation, or it left `pending` with nobody on the other side — most often
  // Chatwoot escalating after a slow ack. Either way the burst counts as handled: the arm path kept
  // its newest message id in the payload precisely so this advance needs no network fetch (issue
  // #8), because without it the burst would sit below the watermark and the first flush after the
  // human returns the conversation would re-answer it.
  //
  // NOTE: the line is what this branch was missing (issue #271). The escalation closes THIS gate
  // rather than the runtime's recheck — no turn ever starts — so without a line here the case the
  // distinction exists for is the one case nothing records.
  if (ctx.gateExit) {
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: ctx.convDbId,
        agentId: ctx.agentId,
        inboxId: ctx.inboxDbId,
        threadId,
        base,
      },
      {
        stage: "handoff",
        status: "ok",
        detail: ctx.gateClosed,
      },
    );
    const last = readLastMessageId(job.payload);
    if (last !== null) {
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: ctx.convDbId,
        toMessageId: last,
        base,
      });
      await settleGateExit({
        tenantId,
        instanceId,
        conversationId,
        conversationRowId: ctx.convDbId,
        afterMessageId: ctx.watermark ?? null,
        upToMessageId: last,
        heldByAnotherBot: ctx.heldByAnotherBot,
        base,
        label: "debounce flush",
      });
    }
    return { outcome: "done" };
  }

  // The spend ceiling, again, at the point the TURN happens, and for the reason the gate below is
  // asked twice: debounce means the message that ARMS a flush and the turn that runs it are minutes
  // apart, and the tenant can cross its ceiling inside that window — from its own other
  // conversations, or from this one's earlier burst. The webhook's ask covered the arming; this one
  // covers the turn, which is the thing that actually spends.
  //
  // The burst is dropped the way a refused contact drops it: the watermark advances off the payload's
  // own last id, nothing is answered, and the flow line is what tells the operator. Where it goes
  // further is that this refusal is the FIRST one. A contact refused here was already told and
  // handed off by the webhook delivery that was refused; a ceiling crossed inside the debounce
  // window never refused anything, so this flush owes the whole contract — the operator's sentence
  // to the customer, the handoff, and the note — under the same cooldown key the webhook gate uses.
  //
  // None of it can be left to the customer's next message. With `handoffEnabled` (the default) the
  // open is precisely what takes the conversation out of `pending`, so `shouldBotHandle` is false
  // from then on and no later message of theirs reaches a gate at all; with the handoff off the
  // conversation stays `pending`, but the burst being dropped here would go unanswered in silence
  // unless the customer happened to write a second time.
  // NOTHING LEFT TO ANSWER ⇒ NOTHING TO REFUSE, asked before the ceiling rather than after it. A
  // claimed job can be retried after an earlier attempt already advanced the watermark past this
  // payload's own last id — the attempt answered the burst and died before the scheduler could mark
  // the job done. Over the ceiling, the retry would then tell the customer the agent cannot answer,
  // hand the conversation off and write a refusal, all about a burst that was answered. Read off
  // the payload and the watermark this flush already holds, so it costs nothing; a payload with no
  // last id cannot say, and falls through to ask exactly as before.
  // THE BURST SELECTOR, hoisted: the ceiling branch below asks the same question the turn does, and
  // it has to be the same closure or the two would answer about different floors.
  //
  // Re-read, not the value captured before the authorization call: that call is a round-trip to
  // somebody else's endpoint with a ceiling of ten seconds, and a message that arrived and was
  // REFUSED inside that window has already had the watermark advanced past it by its own delivery.
  // Against the stale value it would be selected here and handed to the model, and the post gate
  // would only withhold the reply — after the tools had run. The floor is the one this flush read at
  // claim time, so a watermark that somehow reads lower cannot widen the burst.
  const selectPending = async (messages: ChatwootMessageRow[]) => {
    const fresh = await readHandledWatermark({
      tenantId,
      conversationDbId: ctx.convDbId,
      base,
    });
    const armed = ctx.watermark;
    const floor =
      fresh === null ? armed : armed === null ? fresh : Math.max(fresh, armed);
    return pendingIncoming(messages, floor);
  };

  const armedLast = readLastMessageId(job.payload);
  const alreadyAnswered =
    armedLast !== null && ctx.watermark !== null && ctx.watermark >= armedLast;
  const flushCeiling = alreadyAnswered
    ? null
    : await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base,
      });
  // THE COMMAND'S FENCE, asked before the LINE and not only before the acts below. `/reset` retires
  // the burst, and a flush already CLAIMED is past every cancel — that is the whole reason
  // `stillWanted` exists on the turn path, asked once per WRITE rather than once per run. The flow
  // line is a write like any other: it is what the Logs page counts refused customers by, and an
  // `over` line is `error` severity, so it pages the alert channels too. A burst the operator
  // withdrew refused nobody, so there is nothing to report about it — and the claim the announcement
  // spends is the same one the real refusal would need later, which is the second cost of writing it
  // here (`spendCeilingAnnouncement` consumes the window as it decides, deliberately).
  //
  // Retired ⇒ this refusal is withdrawn with the burst rather than delivered about it. The watermark
  // stays where it was, which is the contract the reset scenarios already fix: the burst was not
  // answered, it was taken back, and a later flush asks the ceiling again with a fresh notice window.
  // Lenient (`jobRetired`, not the strict probe): an unreadable retirement row leaves this acting,
  // which is where every caller outside the thread's critical section sits, and the cost of that
  // guess here is a sentence sent once too often.
  const stillWanted = async (act: string): Promise<boolean> => {
    if (!(await jobRetired(job, base))) return true;
    logger.info(
      "debounce flush: spend-ceiling %s withdrawn with the burst (conv=%s) — the job was retired",
      act,
      String(conversationId),
    );
    return false;
  };
  // NOTHING TO ANSWER ⇒ NOTHING TO REFUSE, the second half of that rule and the one the watermark
  // cannot see. The `alreadyAnswered` check above catches a burst an earlier attempt ANSWERED; this
  // catches one that has nothing in it — the armed message was deleted, or it is an attachment that
  // renders to no answerable text. Without the ceiling that burst reaches `coalesceAndRunTurn`,
  // which returns "empty" and says nothing to anybody; over it, the branch below would send the
  // operator's sentence to a customer who is not waiting for one, put the conversation in a human's
  // queue, and declare the burst handled.
  //
  // Asked with the SAME selector and the same rendering the turn uses (`selectAnswerableBurst`), and
  // only on the refusing branch: `allowed` and `warning` both go on to ask it for real, and paying a
  // Chatwoot page here would double every flush's fetch to answer a question that path answers
  // anyway. The refusal is already three network writes deep, so one read is not what makes it
  // expensive.
  const ceilingBurst =
    flushCeiling?.state === "over"
      ? await selectAnswerableBurst(
          {
            tenantId,
            instanceId,
            conversationId,
            convDbId: ctx.convDbId,
            selectPending,
            settings: ctx.settings,
            label: "debounce flush",
          },
          base,
          deps,
        )
      : null;
  if (flushCeiling?.state === "over" && !ceilingBurst) {
    logger.info(
      "debounce flush: over the ceiling with nothing to answer (conv=%s) — the burst is empty, so there is no refusal to report",
      String(conversationId),
    );
    return { outcome: "done" };
  }
  // Asked only when there is something to say: `allowed` writes nothing, so the common flush pays no
  // read for a fence over a line that was never going to exist.
  if (
    flushCeiling &&
    flushCeiling.state !== "allowed" &&
    (await stillWanted("line"))
  ) {
    announceSpendCeiling(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: ctx.convDbId,
        agentId: ctx.loaded.agentId,
        inboxId: ctx.loaded.inboxDbId,
        threadId,
        base,
      },
      flushCeiling,
      "inbox",
      tenantId,
      // ONE LINE PER REFUSED BURST, not one per attempt at it. Advancing the watermark is the last
      // thing this branch does and it is a database write, so a flush that refuses and then throws
      // is re-pended by the scheduler and runs again on the same burst — writing a second `error`
      // line and paging the alert channels a second time about one refusal. Named by the burst the
      // way the customer-facing sequence below is: the conversation plus the payload's own last id,
      // which a retry repeats and the next burst does not.
      flushCeiling.state === "over"
        ? {
            key: `burst:${ctx.convDbId}:${armedLast ?? "unknown"}`,
            windowMs: SPEND_CEILING_BURST_WINDOW_MS,
          }
        : undefined,
    );
  }
  if (flushCeiling?.state === "over") {
    logger.info(
      "debounce flush: spend ceiling reached (conv=%s used=%s ceiling=%s), dropping the burst",
      String(conversationId),
      String(flushCeiling.usedTokens),
      String(flushCeiling.ceilingTokens),
    );
    // The PERSONA's token, not an empty one. `sendMessage`, `sendPrivateNote` and `toggleStatus` are
    // all bot-token endpoints (docs/chatwoot.md), and a client built without it never reaches
    // Chatwoot at all: the call raises ChatwootMissingTokenError, the catch logs it, and the burst is
    // marked handled while the conversation stays on a bot that will not answer (issue #79 is that
    // shape). Null when the persona has no Chatwoot bot of its own, and then the same error is the
    // honest report — there is no identity to speak or hand off as.
    const ceilingClient = () =>
      loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: deps?.makeClient,
        botToken: ctx.loaded.agentBotToken ?? undefined,
      });
    // OWNERSHIP, a different question from the command's fence above and asked alongside it
    // immediately before EACH act — the fence the webhook's own primitives carry, and for the same
    // reason. The gate at the top of this flush judged the instant before two database reads, and
    // the send below is a network call the next act sits behind. A human
    // claiming the conversation inside either window would otherwise be talked over, or have it
    // pulled back out of their hands by a gate that had already decided to go quiet. Dropping the
    // burst is right either way; only what we say and the status change are theirs to lose.
    const stillOurs = async (act: string): Promise<boolean> => {
      const owned = await conversationStillOurs({
        tenantId,
        instanceId,
        conversationId,
        agentBotId,
        base,
      });
      if (!owned.ours) {
        logger.info(
          "debounce flush: spend-ceiling %s skipped (conv=%s reason=%s) — the conversation is no longer the bot's",
          act,
          String(conversationId),
          owned.closed.outcome,
        );
      }
      return owned.ours;
    };
    await announceSpendCeilingOnConversation({
      tenantId,
      conversationRowId: ctx.convDbId,
      // The BURST is the refusal here, and its last id names it: a retry of this same job refuses
      // the same burst, and the next burst carries a later id.
      occasion: `burst:${armedLast ?? "unknown"}`,
      cfg: flushCeiling.cfg,
      verdict: flushCeiling,
      postPublicMessage: async (text) => {
        // Inside the try, deliberately: a fence that cannot answer has to report "not sent" like any
        // other failure, so the notice window it just claimed is given back.
        try {
          if (!(await stillWanted("message")) || !(await stillOurs("message")))
            return false;
          await (await ceilingClient()).sendMessage(conversationId, text);
          return true;
        } catch (err) {
          logger.warn(
            "debounce flush: spend-ceiling message not sent (conv=%s): %s",
            String(conversationId),
            err instanceof Error ? err.message : String(err),
          );
          return false;
        }
      },
      // No ownership fence, matching the webhook's own note: a private note is for the operator, it
      // is invisible to the customer, and a conversation a human just took is exactly the one where
      // the reason for the silence still needs saying.
      postPrivateNote: async (text) => {
        try {
          // Fenced by the command but not by ownership, and the two lines above say why for each
          // half: the note is the operator's, so a human inheriting the conversation does not
          // withhold it, and a burst the operator withdrew has nothing left to explain.
          if (!(await stillWanted("note"))) return false;
          await (await ceilingClient()).sendPrivateNote(conversationId, text);
          return true;
        } catch (err) {
          logger.warn(
            "debounce flush: spend-ceiling note failed (conv=%s): %s",
            String(conversationId),
            err instanceof Error ? err.message : String(err),
          );
          return false;
        }
      },
      handoff: async () => {
        try {
          if (!(await stillWanted("handoff")) || !(await stillOurs("handoff")))
            return false;
          await (await ceilingClient()).toggleStatus(conversationId, "open");
          return true;
        } catch (err) {
          // Best-effort, like every other handoff: a Chatwoot that will not take the status change
          // must not strand the flush.
          logger.warn(
            "debounce flush: could not open the conversation for humans (conv=%s): %s",
            String(conversationId),
            err instanceof Error ? err.message : String(err),
          );
          return false;
        }
      },
    });
    const last = readLastMessageId(job.payload);
    // The last write, and the last ask, because the three above are network round trips a command
    // can land inside. This is the one the reset scenarios name explicitly: a retired burst was
    // withdrawn, not answered, so the watermark stays where it was and a later flush re-coalesces
    // it against the thread the command cleared.
    if (last !== null && (await stillWanted("settlement"))) {
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: ctx.convDbId,
        toMessageId: last,
        base,
      });
      await settleGateExit({
        tenantId,
        instanceId,
        conversationId,
        conversationRowId: ctx.convDbId,
        afterMessageId: ctx.watermark ?? null,
        upToMessageId: last,
        // False, and for the reason the gate below gives: what closed this exit is a decision about
        // the TENANT, which holds for whichever route carried the message.
        heldByAnotherBot: false,
        base,
        label: "debounce flush",
      });
    }
    return { outcome: "done" };
  }

  // The contact-authorization gate, again, at the point the TURN happens. The webhook checks every
  // incoming message, but the turn is not the message: debounce means one message can arm a flush
  // that a later, refused message then rides into. The refused delivery returns "consumed" and arms
  // nothing, yet the flush already pending re-fetches everything past the watermark, so the refused
  // message reaches the model anyway — and a revocation landing inside the coalescing window is the
  // same hole from the other side. "No turn for a contact the endpoint will not vouch for" is a
  // statement about turns, so it has to be checked where a turn begins.
  //
  // A refusal ends the flush exactly like a human takeover does: the burst counts as handled (the
  // watermark advances off the payload's own last id, no fetch needed) and nothing is posted. No
  // customer copy and no handoff — those answer a message the customer just sent, and the webhook
  // path already gave them to the delivery that was refused; a verdict that flipped inside the
  // window reaches the customer on their next message, which is what "re-checked every message"
  // means. The flow line is what tells the operator this burst was dropped.
  let authContext: AuthContext | null = null;
  if (ctx.loaded.contactAuthConfig.enabled) {
    const auth = await authorizeContact({
      tenantId,
      agentId: ctx.loaded.agentId,
      contactDbId: ctx.loaded.contactDbId,
      conversationId,
      inboxId: ctx.inboxChatwootId,
      channelType: ctx.loaded.channelType,
      // The burst is many messages, not one: there is no single text to forward, and an unlock code
      // is something the customer sends on a message of their own, which the webhook path checks.
      messageText: null,
      // Its own asking, for the reason the nudge has one: it carries no message text and must never
      // join (or be joined by) the flight of an incoming message that does.
      requestKey: "debounce",
      cfg: ctx.loaded.contactAuthConfig,
      base,
      fetchImpl: deps?.contactAuthFetch,
    });
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: ctx.convDbId,
        agentId: ctx.loaded.agentId,
        inboxId: ctx.loaded.inboxDbId,
        threadId,
        base,
      },
      contactAuthFlowEvent(auth),
    );
    if (auth.outcome !== "allowed") {
      logger.info(
        "debounce flush: contact not authorized (conv=%s outcome=%s), dropping the burst",
        String(conversationId),
        auth.outcome,
      );
      const last = readLastMessageId(job.payload);
      if (last !== null) {
        await advanceHandledWatermark({
          tenantId,
          conversationDbId: ctx.convDbId,
          toMessageId: last,
          base,
        });
        await settleGateExit({
          tenantId,
          instanceId,
          conversationId,
          conversationRowId: ctx.convDbId,
          afterMessageId: ctx.watermark ?? null,
          upToMessageId: last,
          // False, and not read from anywhere: the gate above already proved this route owns the
          // conversation, and what closed THIS exit is a decision about the CONTACT. That decision
          // holds for whichever route carried the message, so the wide scope is the honest one.
          heldByAnotherBot: false,
          base,
          label: "debounce flush",
        });
      }
      return { outcome: "done" };
    }
    // The facts the endpoint volunteered about this contact, for the prompt of the turn below. They
    // come from the check THIS flush just made, so they are as fresh as the verdict that allowed it.
    authContext = auth.context ?? null;
    // Allowed, and the attribution gate above ran BEFORE a round-trip that may have taken ten
    // seconds. A human who took the conversation during it would otherwise get the burst answered
    // over their shoulder: the post gate withholds the reply, but the tools have run by then. Same
    // question as the gate above, asked again against the mirror; the burst still counts as handled,
    // exactly as it does when the gate was already closed on the way in.
    const recheck = await conversationStillOurs({
      tenantId,
      instanceId,
      conversationId,
      agentBotId,
      base,
    });
    if (!recheck.ours) {
      // NOTE: the same exit as the gate on the way in, so it says the same thing. The old line here
      // asserted a human takeover, which is the reading issue #225 measured as wrong: the ten
      // seconds this fence exists for are ten seconds in which Chatwoot can escalate the
      // conversation out of `pending` with nobody on it.
      emitFlowEvent(
        {
          tenantId,
          turnId: crypto.randomUUID(),
          source: "inbox",
          conversationId: ctx.convDbId,
          agentId: ctx.loaded.agentId,
          inboxId: ctx.loaded.inboxDbId,
          threadId,
          base,
        },
        { stage: "handoff", status: "ok", detail: recheck.closed },
      );
      logger.info(
        "debounce flush: the conversation left the bot during the authorization call (conv=%s reason=%s)",
        String(conversationId),
        recheck.closed.outcome,
      );
      const last = readLastMessageId(job.payload);
      if (last !== null) {
        await advanceHandledWatermark({
          tenantId,
          conversationDbId: ctx.convDbId,
          toMessageId: last,
          base,
        });
        await settleGateExit({
          tenantId,
          instanceId,
          conversationId,
          conversationRowId: ctx.convDbId,
          afterMessageId: ctx.watermark ?? null,
          upToMessageId: last,
          heldByAnotherBot: recheck.heldByAnotherBot,
          base,
          label: "debounce flush",
        });
      }
      return { outcome: "done" };
    }
  }

  // Coalesce the burst past the watermark and answer once. A thrown error (LLM/Chatwoot) bubbles to
  // the worker → retry with backoff (watermark not advanced, so the retry re-answers the same burst).
  // The error is also surfaced on the conversation (item 6) so the operator can re-engage; a
  // successful answer clears it.
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
        // The command's fence. Every cancel reaches PENDING rows only, so a flush already CLAIMED
        // when /reset arrived is past all of them — and it is a queued TURN: coalescing the burst
        // and invoking rewrites the very thread the command cleared, with the operator having been
        // told the conversation was started over. The reply is the smaller half; the checkpoint is
        // the one that outlives the command.
        //
        // Handed down rather than asked here, because here is not where the turn writes. Asked at
        // the top it would answer about a moment before the message fetch, the burst selection and
        // the model — all waits the command lands inside — and the run would still recreate the
        // thread. `runLoadedTurn` asks it inside the `ingest:` lock, which is the boundary the
        // divider and the claim are written at, and again before each post.
        stillWanted: async ({ strict }) =>
          !(await (strict
            ? jobRetiredStrict(job, base)
            : jobRetired(job, base))),
        authContext,
        // The same closure the ceiling branch above asked with; see its definition for the floor.
        selectPending,
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
    // The same ask the clean paths make, on the branch that reaches this write without passing any of
    // them: a throw from the invoke, the TTS call or a Chatwoot send unwinds past every `stillWanted`
    // above and lands here. `lastError`/`lastErrorAt` are state /reset clears, so recording a retired
    // run's failure puts back the failure banner the operator was just told had been cleared — and it
    // is about a turn that will never be retried, because the claim token this run holds was bumped.
    //
    // Asked HERE and not carried down from the fence above: everything between them is I/O, which is
    // exactly the stretch the answer decays over. Unreadable stays "not retired", the same direction
    // `jobRetired` takes everywhere else — an unknown must not swallow a real failure silently.
    if (!(await jobRetired(job, base))) {
      await recordConversationError({
        tenantId,
        instanceId,
        chatwootConversationId: conversationId,
        error: e,
        base,
      });
    }
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

// The burst is definitively unanswered: the flush exhausted its attempts and the row is DEAD, so no
// retry is coming and the customer is waiting on nobody. This is the only place on this path where
// that can be said — the handler's catch runs on attempt 1 too, and cannot know whether another
// attempt exists (issue #71).
export async function announceDeadDebounceFlush(
  job: ClaimedJob,
  error: string,
  base: PrismaClient,
): Promise<void> {
  const threadId =
    typeof job.payload.threadId === "string" ? job.payload.threadId : null;
  if (!threadId) return;
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return;
  await announceFailedTurn({
    tenantId: job.tenantId,
    instanceId: parsed.instanceId,
    chatwootConversationId: parsed.conversationId,
    // NOTE: Re-read rather than trust the dead-letter that got us here: `armDebounce` upserts this
    // very row back to PENDING on the next inbound message, and a row that is queued again is a turn
    // that is coming — announcing over it is what would make an operator take over and close the
    // gate that queued flush depends on.
    assess: async () => {
      const row = await runScopedOn(base, sysCtx(job.tenantId), (db) =>
        db.schedulerJob.findUnique({
          where: { id: job.id },
          select: { status: true },
        }),
      );
      return { path: "job", deadLettered: row?.status === "DEAD" };
    },
    error,
    base,
  });
}

let registered = false;
export function registerDebounceHandler(): void {
  if (registered) return;
  registerJobHandler("DEBOUNCE", debounceFlushHandler);
  registerDeadLetterHandler("DEBOUNCE", announceDeadDebounceFlush);
  registered = true;
}
