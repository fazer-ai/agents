import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { overlayMediaAnnotations } from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  buildQuoteResolver,
  maxIncomingId,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  firstAudioAttachment,
  firstLocationAttachment,
  isIncomingMessage,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { advanceHandledWatermark } from "@/modules/debounce/watermark";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import { analyzeGuardrail } from "@/modules/guardrails/analyze";
import type { ImageFetchDeps } from "@/modules/images/fetch";
import { armCompaction } from "@/modules/memory/compact";
import { deliverReply } from "@/modules/split/service";
import { synthesizeReply } from "@/modules/tts/service";
import { shouldReplyWithAudio } from "@/modules/tts/settings";
import {
  attendanceHasStarted,
  claimAttendanceBoundary,
  needsAttendanceStartProbe,
} from "./attendance-boundary";
import {
  chatwootThreadId,
  getCheckpointer,
  resolveGraphThreadId,
} from "./checkpointer";
import { lastAssistantText } from "./graph";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "./inflight";
import { conversationDividerMessage, conversationStamp } from "./markers";
import { createChatModel, type ResolvedModelConfig } from "./models";
import {
  type AgentConfig,
  buildCallbacks,
  buildModelAndGraph,
  buildSpeechNormalizer,
  buildToolset,
  loadAgentConfig,
} from "./prepare";
import { AgentStatusReporter } from "./status";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "./thread-state";
import { ToolFlowLogger } from "./tool-flowlog";
import type { McpLoadDeps } from "./tools/mcp";
import { buildNativeTools, type TurnState } from "./tools/native";
import type { UsagePersist } from "./usage";

// The agent runtime: an incoming Chatwoot message (gate=act) → resolve the inbox's Agent config
// → build the model (key from the vault) → run the LangGraph thread (history persisted by the
// checkpointer keyed on the conversation) → re-check the live assignee → post the reply via the
// bot token. ALL network I/O is outside any transaction; the scoped reads are short and DB-only.
//
// runLoadedTurn is the shared tail used by BOTH entry points: the direct webhook path (runAgentTurn,
// one message) and the debounce flush (a coalesced burst). The flush passes a `shouldPost` hook so
// it can suppress the reply at the last moment (a newer message arrived during the LLM call → let
// the re-armed flush answer the full burst instead of double-replying).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type RunAgentTurnOutcome =
  | "posted"
  | "skipped"
  | "no-agent"
  | "empty"
  | "taken-over"
  | "superseded"
  | "blocked";

export interface RuntimeDeps {
  makeModel?: (cfg: ResolvedModelConfig) => BaseChatModel;
  makeClient?: (
    cfg: ConstructorParameters<typeof ChatwootClient>[0],
  ) => Promise<ChatwootClient>;
  checkpointer?: BaseCheckpointSaver;
  persistUsage?: UsagePersist;
  mcp?: McpLoadDeps;
  // Injectable fetch for the TTS provider (tests); real fetch in production.
  ttsFetch?: typeof fetch;
  // Injectable download + SSRF assertion for send_image (tests); the real ones in production.
  imageDeps?: ImageFetchDeps;
  // Injectable LLM speech normalizer (tests); production builds one from the agent's model when the
  // agent enables tts.normalize. Best-effort — synthesizeReply falls back to raw text on failure.
  normalizeSpeech?: (text: string) => Promise<string>;
  // Injectable sleep for the split/typing pacing (tests pass a no-op); real setTimeout otherwise.
  sleep?: (ms: number) => Promise<void>;
}

export interface RunLoadedTurnParams {
  loaded: AgentConfig;
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentBotId: number | null;
  threadId: string;
  // Optional turn correlation id. The debounce flush passes the same id it used for its own
  // `debounce` flow line, so the coalescing and the turn's stages group together in the logs.
  turnId?: string;
  // The user text to feed the graph (a single message, or the coalesced burst from a debounce flush).
  text: string;
  // Chatwoot id of the triggering message, surfaced to HTTP tools as {{message_id}}. Direct path: the
  // incoming message id; debounce flush: the burst watermark. Omitted ⇒ {{message_id}} stays unset.
  messageId?: number;
  // Whether the customer's turn included a voice note — drives the "mirror" TTS reply mode.
  userSentAudio?: boolean;
  base?: PrismaClient;
  deps?: RuntimeDeps;
  // Optional last-moment gate, called AFTER the assignee re-check and BEFORE the post. Returning
  // false suppresses the reply (outcome "superseded"). Used by the debounce flush to drop a reply
  // when a newer message arrived mid-turn; the re-armed flush then answers the full burst.
  shouldPost?: () => Promise<boolean>;
}

// Applies a deferred resolve_conversation intent AFTER the reply is delivered. The tool only
// records the intent (see tools/native.ts TurnState): toggling mid-turn makes the webhook mirror
// flip Conversation.status before the recheck, which then reads our own resolve as a human
// takeover and discards the generated reply — and posting into a resolved conversation reopens
// it anyway (same invariant as nudge.ts applyPostActions). Invariant: called ONLY on the
// "posted" and "empty" outcomes; the intent is discarded on taken-over / superseded / blocked /
// throw. Best-effort, never throws: the reply is already out, so a failed toggle only leaves the
// conversation pending (flow warn pages the operator).
async function applyDeferredResolve(
  client: ChatwootClient,
  conversationId: number,
  turnState: TurnState,
  flow: FlowContext,
): Promise<void> {
  if (!turnState.resolveRequested) return;
  turnState.resolveRequested = false;
  try {
    await client.toggleStatus(conversationId, "resolved");
    emitFlowEvent(flow, {
      stage: "handoff",
      status: "ok",
      detail: { outcome: "resolved" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(
      "deferred resolve failed (conv=%s): %s",
      String(conversationId),
      msg,
    );
    emitFlowEvent(flow, {
      stage: "handoff",
      level: "warn",
      status: "error",
      detail: { outcome: "resolved" },
      errorMessage: msg,
    });
  }
}

// Delivers the images the agent queued this turn, AFTER the same gates the reply passes. Best-effort
// per image: one failed attachment must not cost the customer the reply that follows it. Invariant:
// called only on the "posted" and "empty" outcomes — a superseded, taken-over or blocked turn drops
// the queue, exactly like the deferred resolve intent. Returns whether the customer actually received
// something, which is what makes an image-only turn count as answered.
async function deliverPendingImages(
  client: ChatwootClient,
  conversationId: number,
  turnState: TurnState,
  flow: FlowContext,
): Promise<boolean> {
  // NOTE: Sorted by the model's tool-call order, not by the order the downloads finished in — the
  // batch runs concurrently, and a caption only makes sense next to the picture it was written for.
  const queued = turnState.pendingImages
    .splice(0)
    .sort((a, b) => a.order - b.order);
  let sent = false;
  for (const img of queued) {
    try {
      await client.sendFileAttachment(
        conversationId,
        img.bytes,
        img.fileName,
        img.mime,
        { caption: img.caption },
      );
      sent = true;
      emitFlowEvent(flow, {
        stage: "tool",
        status: "ok",
        detail: { tool: "send_image", outcome: "sent" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(
        "send_image delivery failed (conv=%s): %s",
        String(conversationId),
        msg,
      );
      emitFlowEvent(flow, {
        stage: "tool",
        level: "warn",
        status: "error",
        detail: { tool: "send_image", outcome: "failed" },
        errorMessage: msg,
      });
    }
  }
  return sent;
}

// Builds the client + tools + graph from an already-loaded AgentConfig, invokes the thread, re-checks
// the live assignee, optionally consults `shouldPost`, then posts via the bot token.
export async function runLoadedTurn(
  params: RunLoadedTurnParams,
): Promise<RunAgentTurnOutcome> {
  const {
    loaded,
    tenantId,
    instanceId,
    conversationId,
    agentBotId,
    threadId,
    text,
  } = params;
  const base = params.base ?? basePrisma;

  // Execution-flow telemetry context: one turnId correlates every stage of this turn. Source is
  // real (inbox) traffic — warn/error stages may page an alert channel.
  const flow: FlowContext = {
    tenantId,
    turnId: params.turnId ?? crypto.randomUUID(),
    source: "inbox",
    conversationId: loaded.conversationDbId,
    agentId: loaded.agentId,
    inboxId: loaded.inboxDbId,
    threadId,
    base,
  };

  // Load the client + tools (network, outside the tx). The bot token is the PERSONA's, so replies are
  // attributed to this persona's Agent Bot in Chatwoot.
  const client = await loadChatwootClient(tenantId, instanceId, {
    base,
    makeClient: params.deps?.makeClient,
    botToken: loaded.agentBotToken ?? undefined,
  });
  // Per-turn mutable state shared with the native tools (deferred resolve intent).
  const turnState: TurnState = {
    resolveRequested: false,
    pendingImages: [],
    imagesInFlight: 0,
    imagesSeq: 0,
  };
  const tools = await buildToolset(
    loaded,
    {
      tenantId,
      instanceId,
      base,
      client,
      conversationId,
      threadId,
      messageId: params.messageId,
      imageDeps: params.deps?.imageDeps,
      turnState,
    },
    { buildNativeTools, mcp: params.deps?.mcp, flow },
  );

  // Build model + graph + cost/trace callbacks.
  const graph = await buildModelAndGraph(loaded, tools, {
    makeModel: params.deps?.makeModel,
    checkpointer: params.deps?.checkpointer,
    // Hard tool-call limit reached → surface a warn in the turn trail/Logs so the operator sees the
    // agent was forced to answer (vs silently looping or erroring with GraphRecursionError).
    onToolLimit: ({ maxToolCalls, toolCalls }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { toolLimitHit: maxToolCalls, toolCalls },
      }),
    // A turn recovered from an empty provider response must not read like a clean one: without this
    // line the fault is invisible and its rate (issue #63 measured 1 in 184 on one install) can
    // never be told apart from a turn that simply worked.
    onModelRetry: ({ attempt }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        provider: loaded.mc.provider,
        model: loaded.mc.model,
        detail: { retriedEmptyResponse: attempt },
      }),
    // The history ceiling dropped older attendances from this turn. INFO, not warn: emitFlowEvent
    // fans warn/error out to the alert channels, and a correctly configured ceiling trims on nearly
    // every turn of a long thread, so a warn here would page the operator forever for working.
    // Counts only, never a fragment of what was dropped.
    onHistoryTrim: ({ kept, dropped, tokens }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "info",
        status: "ok",
        detail: {
          historyKept: kept,
          historyDropped: dropped,
          historyTokens: tokens,
        },
      }),
  });
  const callbacks = buildCallbacks(loaded, {
    tenantId,
    threadId,
    base,
    persistUsage: params.deps?.persistUsage,
    // Same id as the ExecutionLog turn → the Langfuse trace correlates 1:1 with our Logs.
    turnId: flow.turnId,
    tools,
  });

  // Per-CONTACT-INBOX memory: the graph thread spans the conversations a contact has on ONE channel
  // (continuity, without mixing parallel channels), while the per-conversation threadId stays the
  // flow/debounce/watermark key. When a NEW conversation reuses the thread, prepend a divider so the
  // model treats it as a fresh attendance.
  const graphThreadId = resolveGraphThreadId(
    tenantId,
    instanceId,
    conversationId,
    loaded.contactInboxId,
  );

  // The live "agent is working" indicator on the per-tenant realtime channel:
  // `started` before the first token (instant feedback), `step` events from the
  // graph callbacks (thinking / tool), and a GUARANTEED `finished` in the finally
  // (every exit — posted, empty, taken-over, superseded, or thrown — clears it).
  const status = new AgentStatusReporter({
    tenantId,
    conversationDbId: loaded.conversationDbId,
  });
  // Logs each tool call (name/status/duration) under this turn's flow group.
  const toolLogger = new ToolFlowLogger(flow, {
    logValues: loaded.logToolValues,
    tools,
  });

  // Guardrails (input/output moderation): build the guardrails agent's model once (its OWN
  // credential, resolved in loadAgentConfig). runGuardrail returns null when nothing tripped,
  // { reply: string } to send/replace with, or { reply: null } to suppress (the "silent" action).
  // A trip logs a `guardrail` flow line (warn → may alert) + posts a private operator note so a
  // blocked/replaced reply is never invisible. Fail-open (see analyzeGuardrail).
  const gr = loaded.guardrails;
  const guardrailModel =
    gr.enabled && loaded.guardrailsApiKey
      ? (params.deps?.makeModel ?? createChatModel)({
          provider: gr.provider,
          model: gr.model,
          baseURL:
            loaded.guardrailsCredentialBaseUrl ?? gr.baseURL ?? undefined,
          apiKey: loaded.guardrailsApiKey,
          temperature: 0,
        })
      : null;
  const runGuardrail = async (
    direction: "input" | "output",
    // NOTE: Named `subject` rather than `text` on purpose. As `text` it shadowed this function's
    // enclosing `text` (the customer's message), and the answer_relevance check below needs BOTH:
    // the reply under review and the message it is supposed to answer.
    subject: string,
  ): Promise<{ reply: string | null } | null> => {
    const dir = gr[direction];
    if (!guardrailModel || !dir.enabled) return null;
    const verdict = await analyzeGuardrail(guardrailModel, {
      direction,
      text: subject,
      checks: dir.checks,
      competitors: gr.competitors,
      customPolicy: gr.customPolicy,
      systemPrompt: direction === "output" ? loaded.systemPrompt : undefined,
      // The raw inbound text, not `turnText`: on the first turn of a new conversation the latter
      // carries CONVERSATION_DIVIDER, and handing the guardrail a system marker as the customer's
      // words would make it judge the reply against something nobody said.
      customerMessage: direction === "output" ? text : undefined,
      generationPrompt:
        dir.action === "generated" ? dir.generationPrompt : undefined,
    });
    // A guardrail that could not run reads exactly like one that ran and approved, so without this
    // line an expired credential is silent moderation for as long as nobody notices. The turn is
    // NOT blocked (fail-open stays), only recorded.
    if (verdict.error) {
      emitFlowEvent(flow, {
        stage: "guardrail",
        status: "error",
        level: "warn",
        detail: { direction, outcome: "analysis_failed" },
        errorMessage: verdict.error,
      });
    }
    if (!verdict.violated) return null;
    // NOTE: The turn trail and the operator note report what the guardrail DID, not what it was
    // configured to do. `generated` with no replacement in hand sends the template — when the model
    // returns none, and on the input direction every time (see modules/guardrails/analyze.ts) — and
    // an operator reading "generated" on a line where the template went out is reading the config
    // back, not the event.
    const replacement =
      dir.action === "generated" ? verdict.suggestedReply : null;
    const effectiveAction =
      dir.action === "generated" && replacement === null
        ? "template"
        : dir.action;
    emitFlowEvent(flow, {
      stage: "guardrail",
      status: "ok",
      level: "warn",
      detail: {
        direction,
        action: effectiveAction,
        categories: verdict.categories,
        rationale: verdict.rationale,
      },
    });
    await client
      .sendPrivateNote(
        conversationId,
        `Guardrail (${direction}): ${verdict.categories.join(", ") || "policy"} — ${effectiveAction}. ${verdict.rationale}`,
      )
      .catch(() => {});
    if (dir.action === "silent") return { reply: null };
    return { reply: replacement ?? dir.templateMessage };
  };
  // How many balloons the (text) reply was delivered as, surfaced on `finished` so the UI can hold a
  // "delivering" indicator until the paced balloons land. 1 for audio / single send; null on no post.
  let deliveredBalloons: number | null = null;
  status.started();
  // Mark this conversation's turn as in-flight so a concurrently-fired follow-up backs off instead
  // of nudging mid-turn (cleared in the finally on every exit). See ./inflight.
  markTurnInFlight(threadId);
  // Released in the `finally` below, which is why the claim below lives INSIDE this try and not
  // above it: `getCheckpointer`, the divider write and the marker upsert can all throw, and a claim
  // that outlives its turn keeps every follow-up and every compaction for this contact backing off
  // until the process restarts.
  let claimedGraphThread = false;
  try {
    // ── Attendance boundary. A NEW conversation reusing this contact-inbox thread gets the
    //    "fresh attendance" divider, and the attendance it replaced becomes compactable.
    //
    //    Claimed ATOMICALLY, and the divider written as its own message rather than smuggled into the
    //    customer's turn text, because the three things have to be all-or-nothing:
    //
    //      - Two deliveries for the same new conversation can run at once (debounce off is the common
    //        setup). Both would read the same marker and both would prepend a divider; compaction cuts
    //        at the LAST one, so the first exchange of the OPEN attendance would be summarized away as
    //        if it had ended. The lock — the same one ingestion takes on this thread — makes exactly
    //        one turn the claimant.
    //      - The marker must not advance without the divider landing. It used to advance here while
    //        the divider only reached the checkpointer if the invoke ran, so an input guardrail that
    //        answered before the model, or a throw, left a boundary nothing could ever find again.
    //        Writing the divider inside the claim removes the dependency on the turn succeeding.
    //      - And with the divider durable at claim time, compaction can be armed right here instead of
    //        waiting for the invoke.
    //
    //    The divider being its own message (the ingestion mechanism, same graph) is also why the
    //    guardrails now see the customer's raw words on BOTH directions: there is no longer a turn text
    //    carrying a system marker the customer never wrote.
    if (loaded.contactInboxId != null) {
      const contactInboxId = loaded.contactInboxId;
      const checkpointerForDivider =
        params.deps?.checkpointer ?? (await getCheckpointer());
      const dividerGraph = buildThreadStateGraph(checkpointerForDivider);
      const closedConversationId = await runScopedOn(
        base,
        sysCtx(tenantId),
        (db) =>
          withEntityLock(db, `ingest:${graphThreadId}`, async () => {
            // Per-THREAD marker (AgentThread keyed by contact-inbox): a different display_id ⇒ a new
            // conversation reusing the thread. Per-thread and not per-contact, so a multi-channel
            // contact never gets a spurious divider from activity on another channel.
            const key = {
              tenantId_chatwootInstanceId_contactInboxId: {
                tenantId,
                chatwootInstanceId: instanceId,
                contactInboxId,
              },
            };
            const existing = await db.agentThread.findUnique({
              where: key,
              select: { lastConversationId: true },
            });
            // Read BEFORE this turn adds its own claim: what matters is whether some OTHER invoke
            // is mid-flight on this thread (./attendance-boundary.ts, case 1).
            const anotherInvokeIsReading = isTurnInFlight(graphThreadId);
            // Claim the thread against a memory-compaction rewrite, under the lock the rewrite also
            // holds while it checks. That makes the two exclusive rather than merely staggered: the
            // rewrite either completes before this claim — and the invoke below then loads the
            // rewritten channel — or it finds the thread claimed and stands down. Claimed for EVERY
            // turn, not only the ones that cross a boundary, because what has to be excluded is the
            // invoke, and every turn has one. Released in the `finally` below, on every exit.
            markTurnInFlight(graphThreadId);
            claimedGraphThread = true;
            const prev = existing?.lastConversationId ?? null;
            const alreadyStarted = needsAttendanceStartProbe(
              prev,
              conversationId,
              anotherInvokeIsReading,
            )
              ? attendanceHasStarted(
                  (
                    (
                      await dividerGraph.getState({
                        configurable: { thread_id: graphThreadId },
                      })
                    ).values as { messages?: BaseMessage[] } | undefined
                  )?.messages ?? [],
                  conversationId,
                )
              : false;
            const claim = claimAttendanceBoundary({
              previousConversationId: prev,
              conversationId,
              anotherInvokeIsReading,
              attendanceAlreadyStarted: alreadyStarted,
            });
            if (claim.writeDivider) {
              await dividerGraph.updateState(
                { configurable: { thread_id: graphThreadId } },
                { messages: [conversationDividerMessage(conversationId)] },
                THREAD_STATE_NODE,
              );
            }
            if (claim.advanceMarker) {
              await db.agentThread.upsert({
                where: key,
                create: {
                  tenantId,
                  chatwootInstanceId: instanceId,
                  contactInboxId,
                  threadId: graphThreadId,
                  lastConversationId: conversationId,
                },
                update: { lastConversationId: conversationId },
              });
            }
            return claim.closedConversationId;
          }),
      );
      if (closedConversationId !== null) {
        // Outside the lock: this opens its own transaction, and nesting one inside an advisory-lock
        // transaction would hold that lock across a second connection's work.
        await armCompaction({
          tenantId,
          instanceId,
          contactInboxId,
          conversationId: closedConversationId,
          agentId: loaded.agentId,
          reason: "new_attendance",
          enabled: loaded.memoryCompaction,
          base,
        });
      }
    }

    // INPUT guardrail: screen the customer message BEFORE the agent processes it. On a violation,
    // send the configured template / a guardrails-generated safe reply and skip the graph, or stay
    // silent (send nothing). null ⇒ nothing tripped, proceed as normal.
    const inGuard = await runGuardrail("input", text);
    if (inGuard) {
      if (inGuard.reply !== null) {
        // NOTE: The guardrail reply is a post like any other, so it claims the trigger through the
        // same gate: without this, two concurrent deliveries that both trip the guardrail each post
        // their template, and a stale one posts over newer customer input.
        if (params.shouldPost && !(await params.shouldPost())) {
          return "superseded";
        }
        await client.sendMessage(conversationId, inGuard.reply);
        deliveredBalloons = 1;
        return "posted";
      }
      return "blocked";
    }

    // Invoke the thread (network: LLM + any tool calls). The checkpointer resumes prior history.
    const result = await withFlowStage(
      flow,
      "generate",
      {
        provider: loaded.mc.provider,
        model: loaded.mc.model,
        // The fully-resolved system prompt the agent received THIS turn (item 15), so the operator can
        // inspect it in the Logs page. Passes through redactSecretsDeep on write (secret-scrubbed +
        // length-bounded); it is the tenant's own config, never customer PII.
        detail: { systemPrompt: loaded.systemPrompt },
      },
      () =>
        graph.invoke(
          {
            messages: [
              // Stamped with the conversation it belongs to: that stamp, not the divider, is what the
              // compaction cut reads to find where this attendance starts.
              new HumanMessage({
                content: text,
                additional_kwargs: conversationStamp(conversationId),
              }),
            ],
          },
          {
            configurable: { thread_id: graphThreadId },
            callbacks: [...callbacks, status, toolLogger],
          },
        ),
    );
    let reply = lastAssistantText(result.messages).trim();

    // Re-check the live assignee (mirror) before posting: a human may have taken over during
    // the LLM call. NOTE: small TOCTOU between this read and the POST (the post is network and
    // cannot share the tx); acceptable for the single-replica MVP.
    const ourBot = loaded.agentBotId ?? agentBotId;
    // Re-read the live assignee AND the contact's current voice preference in the same scoped read.
    // set_voice_preference writes Contact.voiceReply DURING the invoke, so the pre-turn snapshot
    // (loaded.contactVoiceReply) is stale — using the fresh value lets "prefiro texto" take effect in
    // THIS same turn instead of only the next one.
    const recheck = await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const conv = await db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: conversationId,
          },
        },
        select: { assigneeType: true, status: true },
      });
      const ours = shouldBotHandle(
        {
          assigneeType: conv?.assigneeType ?? null,
          status: conv?.status ?? null,
        },
        { ourAgentBotId: ourBot },
      );
      let voiceReply = loaded.contactVoiceReply;
      if (loaded.contactDbId != null) {
        const c = await db.contact.findUnique({
          where: { id: loaded.contactDbId },
          select: { voiceReply: true },
        });
        voiceReply = c?.voiceReply ?? null;
      }
      return { ours, voiceReply };
    });
    if (!recheck.ours) {
      emitFlowEvent(flow, {
        stage: "handoff",
        status: "ok",
        detail: { outcome: "taken_over" },
      });
      return "taken-over";
    }

    // Last-moment supersede gate (debounce): a newer message arrived mid-turn → drop this reply
    // AND any deferred resolve intent (the re-armed flush re-decides over the full burst).
    if (params.shouldPost && !(await params.shouldPost())) return "superseded";

    // OUTPUT guardrail: screen the model's reply BEFORE delivery. On a violation, replace it with the
    // template / a guardrails-generated safe reply, or suppress the send entirely ("silent"). A
    // suppressed send also discards the deferred resolve intent — resolving a conversation whose
    // goodbye was blocked would strand the customer with no reply and no human.
    // NOTE: The captions ride along into the screening: they are model-written text the customer
    // reads, so moderating the reply while a caption goes out unread would be a hole. A trip drops
    // the queue — the safe reply replaces what the model wrote, images included. This sits ABOVE the
    // empty-reply branch because a caption is customer-facing text even when the model produced no
    // final message of its own (skip_reply with an image is a legitimate shape).
    const captions = turnState.pendingImages
      .map((i) => i.caption?.trim())
      .filter((c): c is string => !!c);
    const screened = [reply, ...captions].filter(Boolean).join("\n");
    const outGuard = screened ? await runGuardrail("output", screened) : null;
    if (outGuard) {
      turnState.pendingImages.length = 0;
      if (outGuard.reply === null) return "blocked";
      reply = outGuard.reply;
    }

    // Empty reply: no text to post, but the queued images and a deferred resolve intent still apply
    // (both are legitimate shapes with no final text). This runs AFTER the recheck and the supersede
    // gate on purpose: resolving under a takeover belongs to the human, and resolving under a
    // superseded turn would make the next flush's gate read "resolved" and swallow the customer's
    // newest message via the watermark.
    // NOTE: An image that reached the customer IS an answer, so the turn reports "posted" — the
    // callers key the error-cleared/answered bookkeeping off that word, and an image-only turn that
    // reported "empty" would leave a stale turn error on a conversation that was just answered.
    if (!reply) {
      const queued = turnState.pendingImages.length;
      const sent = await deliverPendingImages(
        client,
        conversationId,
        turnState,
        flow,
      );
      // NOTE: The images WERE the turn and none of them reached the customer. That is a failed turn,
      // not a silent one: returning "empty" here would let the deferred resolve close a conversation
      // nobody answered, and the callers only record a turn error (private note, lastError, alert)
      // when the turn THROWS. Best-effort per image still holds where a reply carries the turn.
      if (queued > 0 && !sent) {
        throw new Error(
          "send_image: nenhuma imagem foi entregue e o turno não tinha resposta em texto",
        );
      }
      await applyDeferredResolve(client, conversationId, turnState, flow);
      return sent ? "posted" : "empty";
    }

    // The image lands before the text that talks about it, and before the TTS branch: an audio
    // reply must not swallow the attachment.
    await deliverPendingImages(client, conversationId, turnState, flow);

    // Reply modality: audio (TTS) per the agent's mode + the customer's modality/preference, else
    // text. TTS is best-effort — any synthesis failure falls back to a text reply, never drops it.
    const wantAudio = shouldReplyWithAudio(
      loaded.ttsConfig.mode,
      params.userSentAudio ?? false,
      recheck.voiceReply,
    );
    if (wantAudio) {
      try {
        // Opt-in LLM speech normalization (or the injected normalizer in tests). Its callbacks are
        // built fresh rather than reusing this turn's array: same usage/trace identity, different
        // node and model, and a nested Langfuse generation instead of a second root update.
        const normalizeSpeech =
          params.deps?.normalizeSpeech ??
          buildSpeechNormalizer(loaded, {
            makeModel: params.deps?.makeModel,
            callbacks: {
              tenantId,
              threadId,
              base,
              persistUsage: params.deps?.persistUsage,
              turnId: flow.turnId,
            },
            flow,
          });
        const tts = await synthesizeReply({
          tenantId,
          cfg: loaded.ttsConfig,
          text: reply,
          channelType: loaded.channelType,
          base,
          deps: { fetchImpl: params.deps?.ttsFetch, normalizeSpeech },
          flow,
        });
        if (tts) {
          await client.sendAudioMessage(
            conversationId,
            tts.audio,
            tts.fileName,
            tts.mime,
            { transcribedText: reply },
          );
          logger.info(
            "chatwoot agent replied (audio): conv=%s thread=%s len=%d",
            String(conversationId),
            threadId,
            reply.length,
          );
          deliveredBalloons = 1;
          await applyDeferredResolve(client, conversationId, turnState, flow);
          return "posted";
        }
      } catch (e) {
        logger.warn(
          "tts failed (conv=%s), falling back to text: %s",
          String(conversationId),
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // Post the reply via the bot token (network), reusing the client built for the tools. Split +
    // typing-paced into balloons when the agent enables it (humanized delivery), else a single send.
    const balloons = await deliverReply(
      client,
      conversationId,
      reply,
      loaded.splitConfig,
      params.deps?.sleep,
      flow,
    );
    logger.info(
      "chatwoot agent replied: conv=%s thread=%s len=%d balloons=%d",
      String(conversationId),
      threadId,
      reply.length,
      balloons,
    );
    deliveredBalloons = balloons;
    await applyDeferredResolve(client, conversationId, turnState, flow);
    return "posted";
  } finally {
    clearTurnInFlight(threadId);
    // Only what this turn actually took: releasing a claim we never made would release a CONCURRENT
    // turn's, and hand the thread to a compaction while that turn is still reading it.
    if (claimedGraphThread) clearTurnInFlight(graphThreadId);
    status.finished(deliveredBalloons);
  }
}

export interface RunAgentTurnParams {
  tenantId: bigint;
  instanceId: bigint;
  agentBotId: number | null;
  event: NormalizedChatwootEvent;
  base?: PrismaClient;
  deps?: RuntimeDeps;
}

// Direct (no-debounce) entry: one incoming message → resolve the inbox's Agent → run the turn.
export async function runAgentTurn(
  params: RunAgentTurnParams,
): Promise<RunAgentTurnOutcome> {
  const { tenantId, instanceId, agentBotId, event: n } = params;
  const base = params.base ?? basePrisma;

  if (n.conversationId == null || n.inboxId == null) return "skipped";
  if (!isIncomingMessage(n)) return "skipped";
  // Render the message for the agent (text / transcribed audio / image-or-file marker), mirroring the
  // flush. transcribedText is set by the eager STT pass.
  const renderable = {
    text: n.message?.content ?? "",
    transcribedText: n.message?.transcribedText,
    imageDescription: n.message?.imageDescription,
    extractedText: n.message?.extractedText,
    attachmentTypes: (n.message?.attachments ?? [])
      .map((a) => a.fileType)
      .filter((t): t is string => t !== null),
    location: firstLocationAttachment(n.message?.attachments),
    inReplyTo: n.message?.inReplyTo,
    isReaction: n.message?.isReaction,
  };
  let text = renderInboundMessage(renderable);
  if (!text) return "skipped";
  const conversationId = n.conversationId;
  const inboxId = n.inboxId;
  const threadId = chatwootThreadId(tenantId, instanceId, conversationId);

  // Reply context (item 11): when this message quotes another, fetch the thread page once and
  // re-render WITH the quoted snippet, so the agent sees "<em resposta a: …>" just like the flush
  // path. Best-effort and reply-only — a normal message never pays the extra fetch.
  if (n.message?.inReplyTo != null) {
    try {
      const client = await loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: params.deps?.makeClient,
      });
      const page = parseChatwootMessages(
        await client.getMessages(conversationId),
      );
      // NOTE: On upstream Chatwoot the meta write-back never lands, so a quoted voice note only
      // resolves to its transcription through the in-process overlay (issue #49).
      overlayMediaAnnotations(tenantId, instanceId, page);
      const withQuote = renderInboundMessage(renderable, {
        resolveQuoted: buildQuoteResolver(page),
      });
      if (withQuote) text = withQuote;
    } catch (e) {
      logger.warn(
        "quote resolve failed (conv=%s): %s",
        String(conversationId),
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Scoped read (no network): resolve the inbox's Agent + config bundle.
  const loaded = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const inbox = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: inboxId,
        },
      },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return null;
    return loadAgentConfig(db, {
      tenantId,
      instanceId,
      conversationId,
      agentId: inbox.agentId,
      threadId,
    });
  });
  if (!loaded) return "no-agent";

  // NOTE: Post gate, mirroring the debounce flush (issue #49): concurrent direct turns on the same
  // conversation (webhook deliveries are not serialized) each generate a reply — without this gate
  // the STALE one posts too, answering a message the customer already moved past. Re-fetch to
  // detect a newer incoming message (defer to its own turn), then advance the watermark via the
  // monotonic CAS so a duplicate/stale claim can never double-post. Re-fetch failure is non-fatal
  // (same contract as the flush); the CAS is the backstop.
  const triggerId = n.message?.id ?? null;
  const convDbId = loaded.conversationDbId;
  const shouldPost =
    triggerId !== null && convDbId !== null
      ? async (): Promise<boolean> => {
          try {
            const client = await loadChatwootClient(tenantId, instanceId, {
              base,
              makeClient: params.deps?.makeClient,
            });
            const latest = parseChatwootMessages(
              await client.getMessages(conversationId),
            );
            if (maxIncomingId(latest, triggerId) > triggerId) {
              logger.info(
                "direct turn: superseded mid-turn (conv=%s), deferring",
                String(conversationId),
              );
              return false;
            }
          } catch (e) {
            logger.warn(
              "direct turn: supersede re-fetch failed (conv=%s): %s",
              String(conversationId),
              e instanceof Error ? e.message : String(e),
            );
          }
          return advanceHandledWatermark({
            tenantId,
            conversationDbId: convDbId,
            toMessageId: triggerId,
            base,
          });
        }
      : undefined;

  const outcome = await runLoadedTurn({
    loaded,
    tenantId,
    instanceId,
    conversationId,
    agentBotId,
    threadId,
    text,
    messageId: n.message?.id ?? undefined,
    userSentAudio: firstAudioAttachment(n) !== null,
    base,
    deps: params.deps,
    shouldPost,
  });
  // NOTE: Watermark tail for the outcomes shouldPost's CAS did not cover ("posted" already advanced):
  // empty/blocked consumed the message, taken over hands it to the human — left alone the watermark
  // stays NULL forever, and the first flush after debounce is later enabled (or after an arm failure
  // fell back here) re-answers the whole recent page (issue #8). "superseded" stays put BY DESIGN:
  // the newer message's own turn advances past it. Best-effort — a watermark miss must not fail the
  // turn.
  if (
    outcome !== "superseded" &&
    n.message?.id != null &&
    loaded.conversationDbId !== null
  ) {
    try {
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: loaded.conversationDbId,
        toMessageId: n.message.id,
        base,
      });
    } catch (e) {
      logger.warn(
        "advance handled watermark failed (conv=%s): %s",
        String(conversationId),
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return outcome;
}
