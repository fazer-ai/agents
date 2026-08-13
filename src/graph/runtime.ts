import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
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
import { deliverReply } from "@/modules/split/service";
import { llmNormalizeForSpeech } from "@/modules/tts/normalize";
import { synthesizeReply } from "@/modules/tts/service";
import { shouldReplyWithAudio } from "@/modules/tts/settings";
import { chatwootThreadId, resolveGraphThreadId } from "./checkpointer";
import { lastAssistantText } from "./graph";
import { clearTurnInFlight, markTurnInFlight } from "./inflight";
import { CONVERSATION_DIVIDER } from "./ingest";
import { createChatModel, type ResolvedModelConfig } from "./models";
import {
  type AgentConfig,
  buildCallbacks,
  buildModelAndGraph,
  buildToolset,
  loadAgentConfig,
} from "./prepare";
import { AgentStatusReporter } from "./status";
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
  const turnState: TurnState = { resolveRequested: false };
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
  let turnText = text;
  if (loaded.contactInboxId != null) {
    const contactInboxId = loaded.contactInboxId;
    const isNewConversation = await runScopedOn(
      base,
      sysCtx(tenantId),
      async (db) => {
        // Per-THREAD divider marker (AgentThread keyed by contact-inbox): compare the last
        // conversation that ran on THIS thread. A different display_id ⇒ a new conversation reusing
        // the thread ⇒ inject the "fresh attendance" divider. Tracking it per-thread (not per-contact)
        // means a multi-channel contact never gets a spurious divider from activity on another channel.
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
        const prev = existing?.lastConversationId ?? null;
        // Advance the marker to the current conversation (idempotent within one conversation).
        if (prev !== conversationId) {
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
        return prev != null && prev !== conversationId;
      },
    );
    if (isNewConversation) turnText = `${CONVERSATION_DIVIDER}\n\n${text}`;
  }

  // The live "agent is working" indicator on the per-tenant realtime channel:
  // `started` before the first token (instant feedback), `step` events from the
  // graph callbacks (thinking / tool), and a GUARANTEED `finished` in the finally
  // (every exit — posted, empty, taken-over, superseded, or thrown — clears it).
  const status = new AgentStatusReporter({
    tenantId,
    conversationDbId: loaded.conversationDbId,
  });
  // Logs each tool call (name/status/duration) under this turn's flow group.
  const toolLogger = new ToolFlowLogger(flow);

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
    text: string,
  ): Promise<{ reply: string | null } | null> => {
    const dir = gr[direction];
    if (!guardrailModel || !dir.enabled) return null;
    const verdict = await analyzeGuardrail(guardrailModel, {
      direction,
      text,
      checks: dir.checks,
      competitors: gr.competitors,
      customPolicy: gr.customPolicy,
      systemPrompt: direction === "output" ? loaded.systemPrompt : undefined,
      generationPrompt:
        dir.action === "generated" ? dir.generationPrompt : undefined,
    });
    if (!verdict.violated) return null;
    emitFlowEvent(flow, {
      stage: "guardrail",
      status: "ok",
      level: "warn",
      detail: {
        direction,
        action: dir.action,
        categories: verdict.categories,
        rationale: verdict.rationale,
      },
    });
    await client
      .sendPrivateNote(
        conversationId,
        `Guardrail (${direction}): ${verdict.categories.join(", ") || "policy"} — ${dir.action}. ${verdict.rationale}`,
      )
      .catch(() => {});
    if (dir.action === "silent") return { reply: null };
    return {
      reply:
        dir.action === "generated"
          ? (verdict.suggestedReply ?? dir.templateMessage)
          : dir.templateMessage,
    };
  };
  // How many balloons the (text) reply was delivered as, surfaced on `finished` so the UI can hold a
  // "delivering" indicator until the paced balloons land. 1 for audio / single send; null on no post.
  let deliveredBalloons: number | null = null;
  status.started();
  // Mark this conversation's turn as in-flight so a concurrently-fired follow-up backs off instead
  // of nudging mid-turn (cleared in the finally on every exit). See ./inflight.
  markTurnInFlight(threadId);
  try {
    // INPUT guardrail: screen the customer message BEFORE the agent processes it. On a violation,
    // send the configured template / a guardrails-generated safe reply and skip the graph, or stay
    // silent (send nothing). null ⇒ nothing tripped, proceed as normal.
    const inGuard = await runGuardrail("input", turnText);
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
          { messages: [new HumanMessage(turnText)] },
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

    // Empty reply: nothing to post, but a deferred resolve intent still applies (resolve with no
    // final text is a legitimate shape). This runs AFTER the recheck and the supersede gate on
    // purpose: resolving under a takeover belongs to the human, and resolving under a superseded
    // turn would make the next flush's gate read "resolved" and swallow the customer's newest
    // message via the watermark.
    if (!reply) {
      await applyDeferredResolve(client, conversationId, turnState, flow);
      return "empty";
    }

    // OUTPUT guardrail: screen the model's reply BEFORE delivery. On a violation, replace it with the
    // template / a guardrails-generated safe reply, or suppress the send entirely ("silent"). A
    // suppressed send also discards the deferred resolve intent — resolving a conversation whose
    // goodbye was blocked would strand the customer with no reply and no human.
    const outGuard = await runGuardrail("output", reply);
    if (outGuard) {
      if (outGuard.reply === null) return "blocked";
      reply = outGuard.reply;
    }

    // Reply modality: audio (TTS) per the agent's mode + the customer's modality/preference, else
    // text. TTS is best-effort — any synthesis failure falls back to a text reply, never drops it.
    const wantAudio = shouldReplyWithAudio(
      loaded.ttsConfig.mode,
      params.userSentAudio ?? false,
      recheck.voiceReply,
    );
    if (wantAudio) {
      try {
        // Opt-in LLM speech normalization: build a temp-0 model from the agent's own model config
        // (no extra credential), or use the injected normalizer in tests. Only when the agent enabled
        // it — and synthesizeReply still falls back to raw text if it throws.
        let normalizeSpeech = params.deps?.normalizeSpeech;
        if (!normalizeSpeech && loaded.ttsConfig.normalize) {
          const makeModel = params.deps?.makeModel ?? createChatModel;
          const normModel = makeModel({
            ...loaded.mc,
            apiKey: loaded.apiKey,
            baseURL: loaded.credentialBaseUrl ?? loaded.mc.baseURL,
            temperature: 0,
          });
          normalizeSpeech = (t) => llmNormalizeForSpeech(normModel, t);
        }
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
