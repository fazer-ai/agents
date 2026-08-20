import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { lastAssistantText } from "@/graph/graph";
import type { ResolvedModelConfig } from "@/graph/models";
import {
  type AgentNudge,
  FOLLOWUP_SKIP_SENTINEL,
  isNudgeSilent,
  renderNudge,
} from "@/graph/nudge";
import {
  type AgentConfig,
  type AgentConfigOverrides,
  buildCallbacks,
  buildModelAndGraph,
  buildSpeechNormalizer,
  buildToolset,
  loadAgentConfig,
} from "@/graph/prepare";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import {
  CONVERSATION_NATIVE_TOOL_NAMES,
  UTILITY_NATIVE_TOOL_NAMES,
} from "@/graph/tools/catalog";
import type { McpLoadDeps } from "@/graph/tools/mcp";
import { buildSimulatedNativeTools } from "@/graph/tools/native";
import {
  buildPlaygroundTrace,
  buildVisionTraceEntry,
  collectTraceSources,
  type TraceEntry,
  type TraceLabelOpts,
  type TraceSource,
} from "@/graph/trace";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import { readObservabilityConfig } from "@/modules/flowlog/settings";
import {
  readFollowUpConfig,
  stepDelayMinutes,
} from "@/modules/followups/settings";
import { transcribePlaygroundAudio } from "@/modules/stt/service";
import { synthesizeReply } from "@/modules/tts/service";
import { shouldReplyWithAudio } from "@/modules/tts/settings";
import { extractPlaygroundFile } from "@/modules/vision/service";
import { readVisionConfig } from "@/modules/vision/settings";
import { type PlaygroundMediaKind, savePlaygroundMedia } from "./media";
import { upsertPlaygroundSession } from "./sessions";
import { isValidPlaygroundThread, newPlaygroundThreadId } from "./thread";

// Agent playground: chat with a configured agent straight from the console, with NO Chatwoot round
// trip (no webhook, no real conversation, no debounce, no post). It runs the SAME model + system
// prompt + knowledge/HTTP/MCP tools as production so the operator tests behavior faithfully. The
// native CONVERSATION tools (handoff/resolve/…) ARE exposed but SIMULATED (no real effect), so the
// agent's decision to call them is testable; the operator can also mock ANY tool's result
// (`toolMocks`). Turns persist in the checkpointer under a tenant+agent-fenced playground thread, so
// the test session has memory. The agent's `enabled` toggle is ignored — you test before going live.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface PlaygroundDeps {
  makeModel?: (cfg: ResolvedModelConfig) => BaseChatModel;
  checkpointer?: BaseCheckpointSaver;
  mcp?: McpLoadDeps;
  // The voice provider's fetch, injectable exactly as RuntimeDeps.ttsFetch is on the inbox path:
  // without this seam the playground's audio reply could only ever be exercised against the network.
  ttsFetch?: typeof fetch;
}

export interface PlaygroundTurnParams {
  tenantId: bigint;
  agentId: bigint;
  message: string;
  threadId?: string;
  // Session-history title for a NEW session; defaults to the message. The audio path passes the
  // clean transcription so the title isn't the raw <mensagem-de-audio> wrapper.
  titleHint?: string;
  // Unsaved draft (live-edit popup): non-persisted prompt/model/settings override.
  overrides?: AgentConfigOverrides;
  // Inbound binary media to persist for replay (the user's recorded audio / uploaded file). Linked
  // to the human message of this turn.
  userMedia?: {
    kind: Extract<PlaygroundMediaKind, "user_audio" | "user_file">;
    mime: string;
    fileName?: string | null;
    bytes: ArrayBuffer;
  };
  // Whether this turn came from a voice note (drives the TTS "mirror" decision).
  userSentAudio?: boolean;
  // Manual override: force a TTS reply regardless of the agent's mode (the playground toggle).
  forceAudio?: boolean;
  base?: PrismaClient;
  deps?: PlaygroundDeps;
}

export interface PlaygroundTurnResult {
  reply: string;
  threadId: string;
  // Sanitized execution trace (tool calls/results, KB sources, intermediate reasoning) for the
  // operator/agent to debug behavior. Never carries resolved credentials.
  trace: TraceEntry[];
  // Deduped KB sources the answer was grounded on (a flat summary of the trace's tool_result sources).
  sources: TraceSource[];
  // Persisted-media ids (for in-session playback via the media endpoint).
  userMediaId?: string;
  ttsMediaId?: string;
}

// Surfaces a model/tool invocation failure to the operator with the provider's own message when
// one can be extracted. LangChain wraps the raw HTTP body (e.g. `404 {"type":"error","error":
// {"message":"model: x"}}`) plus a troubleshooting URL; neither carries credentials. Falls back
// to the first line of the wrapped message, capped.
export function toPlaygroundInvokeError(e: unknown): AppError {
  const raw = e instanceof Error ? e.message : String(e);
  const embedded = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
  const firstLine = raw.split("\n", 1)[0] ?? raw;
  const detail = (embedded || firstLine).slice(0, 300);
  return new AppError(`model invocation failed: ${detail}`, 502);
}

// Replaces a tool's execution with an operator-supplied canned result, keeping its model-facing
// name/description/schema. Applied AFTER the toolset is built, over ANY tool (native/HTTP/MCP/KB), so
// the agent's behavior can be tested deterministically without a real call. Exported for tests.
export function applyToolMocks(
  tools: StructuredToolInterface[],
  mocks: Record<string, string> | undefined,
): StructuredToolInterface[] {
  const names = new Set(Object.keys(mocks ?? {}));
  if (names.size === 0) return tools;
  return tools.map((tl) =>
    names.has(tl.name)
      ? tool(async () => mocks?.[tl.name] ?? "", {
          name: tl.name,
          description: tl.description,
          schema: tl.schema,
        })
      : tl,
  );
}

// Loads the agent config for the playground (ignoring the `enabled` toggle — you test before going
// live). instance/conversation ids are absent here (dummy 0n/0 → no mirror row), so contact/prompt
// vars come from `overrides.promptVars` when the operator simulates them. Throws the same
// not-runnable errors as the turn path (agent missing vs no model credential).
async function loadPlaygroundConfig(params: {
  tenantId: bigint;
  agentId: bigint;
  threadId: string;
  base: PrismaClient;
  overrides?: AgentConfigOverrides;
}): Promise<AgentConfig> {
  const { tenantId, agentId, threadId, base } = params;
  const loaded = await runScopedOn(base, sysCtx(tenantId), (db) =>
    loadAgentConfig(
      db,
      { tenantId, instanceId: 0n, conversationId: 0, agentId, threadId },
      { ignoreDisabled: true, overrides: params.overrides },
    ),
  );
  if (!loaded) {
    // Agent missing OR no model credential configured — distinguish the two for the operator.
    const exists = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.agent.findUnique({ where: { id: agentId }, select: { id: true } }),
    );
    if (!exists)
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    throw new AppError(
      "agent has no runnable model configured",
      400,
      "errors.agentNotRunnable",
    );
  }
  return loaded;
}

// Builds the playground toolset: the CONVERSATION native tools SIMULATED (no real effect; a dummy
// client satisfies the type and is never called) alongside the real utility/HTTP/MCP/KB tools.
// Shared by the turn path (then mocks are applied over it) and the tool-listing endpoint.
function buildPlaygroundToolset(
  loaded: AgentConfig,
  params: {
    tenantId: bigint;
    threadId: string;
    base: PrismaClient;
    deps?: PlaygroundDeps;
  },
): Promise<StructuredToolInterface[]> {
  return buildToolset(
    loaded,
    {
      tenantId: params.tenantId,
      instanceId: 0n,
      base: params.base,
      client: {} as ChatwootClient,
      conversationId: 0,
      threadId: params.threadId,
    },
    {
      // Conversation tools (handoff/resolve/…) are SIMULATED (no real effect); utility tools
      // (calculator, get_current_time) run for real. `allowed` is the agent's own native set.
      buildNativeTools: (ctx, allowed) =>
        buildSimulatedNativeTools(ctx, allowed),
      mcp: params.deps?.mcp,
    },
  );
}

// Shared load→build tail for both playground entry points. Loads the agent config + the simulated
// toolset, applies the operator's `toolMocks` over the result, then the model+graph and tracing
// callbacks. Returns `traceLabels` so callers can tag mocked/simulated results in the trace.
async function buildPlaygroundGraph(params: {
  tenantId: bigint;
  agentId: bigint;
  threadId: string;
  base: PrismaClient;
  deps?: PlaygroundDeps;
  overrides?: AgentConfigOverrides;
  // Reused as the Langfuse trace id (item 10) so a playground trace correlates with the turn.
  turnId?: string;
  // Same warn line the reactive turn leaves when a model call had to be retried. The caller passes
  // it because the FlowContext is the caller's.
  onModelRetry?: (info: { attempt: number; error: unknown }) => void;
  onHistoryTrim?: (info: {
    kept: number;
    dropped: number;
    tokens: number;
  }) => void;
}) {
  const { tenantId, agentId, threadId, base } = params;
  const loaded = await loadPlaygroundConfig({
    tenantId,
    agentId,
    threadId,
    base,
    overrides: params.overrides,
  });
  const rawTools = await buildPlaygroundToolset(loaded, {
    tenantId,
    threadId,
    base,
    deps: params.deps,
  });
  const toolMocks = params.overrides?.toolMocks;
  const tools = applyToolMocks(rawTools, toolMocks);
  // Trace labels: which tool names are mocked (operator) vs simulated (conversation natives that the
  // agent actually has, minus any the operator mocked — the mock takes precedence).
  const mockedNames = new Set(Object.keys(toolMocks ?? {}));
  const toolNames = new Set(tools.map((tl) => tl.name));
  const simulatedNames = new Set(
    CONVERSATION_NATIVE_TOOL_NAMES.filter(
      (n) => toolNames.has(n) && !mockedNames.has(n),
    ),
  );
  const traceLabels: TraceLabelOpts = { mockedNames, simulatedNames };
  const graph = await buildModelAndGraph(loaded, tools, {
    makeModel: params.deps?.makeModel,
    checkpointer: params.deps?.checkpointer,
    onModelRetry: params.onModelRetry,
    onHistoryTrim: params.onHistoryTrim,
  });
  // Tag usage as playground so it never pollutes the real dashboard figures (the dashboard
  // defaults to source="inbox"). inboxId is null here (no mirror conversation).
  const callbacks = buildCallbacks(loaded, {
    tenantId,
    threadId,
    base,
    source: "playground",
    turnId: params.turnId,
    tools,
  });
  return { graph, callbacks, loaded, tools, traceLabels };
}

export type PlaygroundToolCategory =
  | "native" // conversation native (auto-simulated; no real Chatwoot effect)
  | "utility" // native utility (calculator/clock; runs for real)
  | "knowledge" // RAG (search_knowledge / suggest_kb_entry)
  | "http" // custom HTTP tool
  | "mcp" // MCP server tool
  | "integration" // toolpack integration
  | "external"; // unclassified external tool

export interface PlaygroundToolInfo {
  name: string;
  description: string;
  category: PlaygroundToolCategory;
  // True when auto-simulated in the playground (conversation natives have no real effect). Every
  // other category runs for real unless the operator supplies a mock (toolMocks) for it.
  simulated: boolean;
}

// Lists the tools the agent would have in a playground turn, with category + whether each is
// auto-simulated — so the console can render the simulate-a-return UI without the operator typing
// tool names by hand. Loads the config + builds the SAME (simulated-native) toolset a turn builds,
// then classifies each tool by the loaded grant name-sets. MCP is best-effort (same network a turn
// does); a failed MCP load just omits those tools, like a turn.
export async function listPlaygroundTools(params: {
  tenantId: bigint;
  agentId: bigint;
  base?: PrismaClient;
  deps?: PlaygroundDeps;
}): Promise<PlaygroundToolInfo[]> {
  const base = params.base ?? basePrisma;
  const threadId = newPlaygroundThreadId(params.tenantId, params.agentId);
  const loaded = await loadPlaygroundConfig({
    tenantId: params.tenantId,
    agentId: params.agentId,
    threadId,
    base,
  });
  const tools = await buildPlaygroundToolset(loaded, {
    tenantId: params.tenantId,
    threadId,
    base,
    deps: params.deps,
  });

  const conversation = new Set<string>(CONVERSATION_NATIVE_TOOL_NAMES);
  const utility = new Set<string>(UTILITY_NATIVE_TOOL_NAMES);
  const knowledge = new Set(loaded.ragConfig?.tools ?? []);
  const http = new Set(loaded.httpToolDefs.map((d) => d.name));
  const mcp = new Set(loaded.mcpSelections.flatMap((s) => s.enabledTools));
  const integration = new Set(
    loaded.integrationSelections.flatMap((s) => s.enabledTools),
  );

  return tools.map((tl): PlaygroundToolInfo => {
    const name = tl.name;
    const description = tl.description ?? "";
    if (conversation.has(name))
      return { name, description, category: "native", simulated: true };
    if (utility.has(name))
      return { name, description, category: "utility", simulated: false };
    if (knowledge.has(name))
      return { name, description, category: "knowledge", simulated: false };
    if (http.has(name))
      return { name, description, category: "http", simulated: false };
    if (mcp.has(name))
      return { name, description, category: "mcp", simulated: false };
    if (integration.has(name))
      return { name, description, category: "integration", simulated: false };
    return { name, description, category: "external", simulated: false };
  });
}

// The id of the last AI message in the invoke result (for linking the TTS audio to its turn).
function lastAiMessageId(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { id?: unknown; getType?: () => string };
    const type = m?.getType?.();
    if (type === "ai" && typeof m.id === "string") return m.id;
  }
  return undefined;
}

export async function runPlaygroundTurn(
  params: PlaygroundTurnParams,
): Promise<PlaygroundTurnResult> {
  const { tenantId, agentId, message } = params;
  const base = params.base ?? basePrisma;
  const text = message.trim();
  if (!text) throw new AppError("empty message", 400, "errors.emptyMessage");

  const threadId =
    params.threadId &&
    isValidPlaygroundThread(params.threadId, tenantId, agentId)
      ? params.threadId
      : newPlaygroundThreadId(tenantId, agentId);

  // One id correlates the ExecutionLog turn, the tool-call logs, and the Langfuse trace (item 10).
  const turnId = crypto.randomUUID();
  // Execution-flow telemetry, tagged source=playground so it never pages an alert channel and stays
  // out of the dashboard's real view (the Logs page can still filter to it). Built before the graph
  // because the graph's retry callback writes to it.
  const flow: FlowContext = {
    tenantId,
    turnId,
    source: "playground",
    agentId,
    threadId,
    base,
  };
  const { graph, callbacks, loaded, tools, traceLabels } =
    await buildPlaygroundGraph({
      tenantId,
      agentId,
      threadId,
      base,
      deps: params.deps,
      overrides: params.overrides,
      turnId,
      onModelRetry: ({ attempt }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          detail: { retriedEmptyResponse: attempt },
        }),
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

  // Give the human message an explicit id when we have media to link to it (so reopening the
  // session can re-attach the recorded audio / uploaded file to this exact turn).
  const humanId = params.userMedia ? crypto.randomUUID() : undefined;
  const human = humanId
    ? new HumanMessage({ content: text, id: humanId })
    : new HumanMessage(text);

  let result: Awaited<ReturnType<typeof graph.invoke>>;
  try {
    result = await withFlowStage(
      flow,
      "generate",
      { provider: loaded.mc.provider, model: loaded.mc.model },
      () =>
        graph.invoke(
          { messages: [human] },
          {
            configurable: { thread_id: threadId },
            // ToolFlowLogger so playground tool calls land in the Logs page (item 3), same as a
            // real turn does in runLoadedTurn.
            callbacks: [
              ...callbacks,
              new ToolFlowLogger(flow, {
                logValues: loaded.logToolValues,
                tools,
              }),
            ],
          },
        ),
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw toPlaygroundInvokeError(e);
  }
  const trace = buildPlaygroundTrace(result.messages, traceLabels);
  const reply = lastAssistantText(result.messages).trim();
  await upsertPlaygroundSession(
    base,
    tenantId,
    agentId,
    threadId,
    params.titleHint ?? text,
  );

  // Persist the user's inbound media (best-effort) for replay on reopen.
  let userMediaId: string | undefined;
  if (params.userMedia && humanId) {
    userMediaId =
      (await savePlaygroundMedia(base, {
        tenantId,
        agentId,
        threadId,
        messageId: humanId,
        kind: params.userMedia.kind,
        mime: params.userMedia.mime,
        fileName: params.userMedia.fileName ?? null,
        bytes: params.userMedia.bytes,
      })) ?? undefined;
  }

  // TTS reply: the agent's mode decides (mirror/preference), or the manual toggle forces it. Audio
  // is best-effort — synthesis failure falls back to the text reply.
  let ttsMediaId: string | undefined;
  const wantAudio =
    !!reply &&
    (params.forceAudio ||
      shouldReplyWithAudio(
        loaded.ttsConfig.mode,
        params.userSentAudio ?? false,
        loaded.contactVoiceReply,
      ));
  if (wantAudio) {
    try {
      const tts = await synthesizeReply({
        tenantId,
        cfg: loaded.ttsConfig,
        text: reply,
        base,
        // NOTE: the playground synthesized WITHOUT the speech normalizer until now, so the operator
        // heard a different rendering of the same reply than the customer does, which is the one setting the
        // playground exists to let them test. Its usage is tagged source=playground (out of the
        // dashboard) and its flow lines never page an alert channel.
        deps: {
          fetchImpl: params.deps?.ttsFetch,
          normalizeSpeech: buildSpeechNormalizer(loaded, {
            makeModel: params.deps?.makeModel,
            callbacks: {
              tenantId,
              threadId,
              base,
              source: "playground",
              turnId,
            },
            flow,
          }),
        },
        flow,
      });
      const aiId = lastAiMessageId(result.messages);
      if (tts && aiId) {
        ttsMediaId =
          (await savePlaygroundMedia(base, {
            tenantId,
            agentId,
            threadId,
            messageId: aiId,
            kind: "tts_audio",
            mime: tts.mime,
            fileName: tts.fileName,
            bytes: tts.audio,
          })) ?? undefined;
      }
    } catch (e) {
      logger.warn(
        "playground: tts synthesis failed: %s",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return {
    reply,
    threadId,
    trace,
    sources: collectTraceSources(trace),
    ...(userMediaId ? { userMediaId } : {}),
    ...(ttsMediaId ? { ttsMediaId } : {}),
  };
}

export interface PlaygroundFollowupParams {
  tenantId: bigint;
  agentId: bigint;
  threadId?: string;
  // Optional operator-supplied situation note; overrides the default "inactive for ~N min" summary.
  context?: string;
  overrides?: AgentConfigOverrides;
  base?: PrismaClient;
  deps?: PlaygroundDeps;
}

export interface PlaygroundFollowupResult {
  reply: string;
  threadId: string;
  trace: TraceEntry[];
  sources: TraceSource[];
  // The agent chose not to follow up (empty reply) — a legitimate, common outcome, surfaced so the
  // UI can say "stayed silent" instead of rendering an empty bubble.
  silent: boolean;
}

// Simulate a proactive follow-up in the playground: inject the SAME inactivity nudge the scheduler
// would (renderNudge), let the agent DECIDE whether to message, and return what it would say — with
// NO Chatwoot post, no service-window gate, no watermark. The playground always lets the bot message
// (canMessageCustomer = true; there is no human assignee here). The instructions + configured window
// come from the agent's own follow-up settings so the simulation matches production; the enabled
// toggle is ignored (test the behavior before turning it on).
export async function runPlaygroundFollowup(
  params: PlaygroundFollowupParams,
): Promise<PlaygroundFollowupResult> {
  const { tenantId, agentId } = params;
  const base = params.base ?? basePrisma;

  const threadId =
    params.threadId &&
    isValidPlaygroundThread(params.threadId, tenantId, agentId)
      ? params.threadId
      : newPlaygroundThreadId(tenantId, agentId);

  // One id correlates the tool-call logs and the Langfuse trace for this simulated follow-up.
  const turnId = crypto.randomUUID();
  // Flow telemetry tagged source=playground (never pages an alert channel, stays out of the
  // dashboard) so the simulated follow-up's tool calls show up in the Logs page (item 3). Built
  // before the graph because the graph's retry callback writes to it.
  const flow: FlowContext = {
    tenantId,
    turnId,
    source: "playground",
    agentId,
    threadId,
    base,
  };
  const { graph, callbacks, tools, traceLabels } = await buildPlaygroundGraph({
    tenantId,
    agentId,
    threadId,
    base,
    deps: params.deps,
    overrides: params.overrides,
    turnId,
    onModelRetry: ({ attempt }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { retriedEmptyResponse: attempt },
      }),
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

  // Draft settings (if present) drive the follow-up instructions/delay so the simulation matches
  // what the operator is editing live; otherwise the saved settings.
  const agent = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.agent.findUnique({ where: { id: agentId }, select: { settings: true } }),
  );
  const settings = params.overrides?.settings ?? agent?.settings;
  const followUp = readFollowUpConfig(settings);
  // The playground previews the FIRST step's message (the simulation has no real schedule). Post
  // actions (label/resolve) are NOT applied here — there is no real conversation to act on.
  const firstStep = followUp.steps[0];
  const summary = params.context?.trim()
    ? params.context.trim().slice(0, 500)
    : `The customer has been inactive for about ${
        firstStep ? stepDelayMinutes(firstStep) : 60
      } minutes.`;
  const nudge: AgentNudge = {
    source: "followup",
    kind: "inactivity",
    summary,
    instructions: firstStep?.instructions || undefined,
  };

  let result: Awaited<ReturnType<typeof graph.invoke>>;
  try {
    result = await graph.invoke(
      // HUMAN turn, not SystemMessage: the agent node prepends the only system prompt; a second
      // system message makes strict providers (Google) reject the call. See graph.ts agentNode.
      { messages: [new HumanMessage(renderNudge(nudge, true))] },
      {
        configurable: { thread_id: threadId },
        callbacks: [
          ...callbacks,
          new ToolFlowLogger(flow, {
            logValues: readObservabilityConfig(settings).logToolValues,
            tools,
          }),
        ],
      },
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw toPlaygroundInvokeError(e);
  }
  const trace = buildPlaygroundTrace(result.messages, traceLabels);
  // Same silence contract as production (runAgentNudge): the skip sentinel / narrated-emptiness is
  // "stayed silent", and a stray sentinel is stripped so it never shows in the simulated reply.
  const replyRaw = lastAssistantText(result.messages);
  const silent = isNudgeSilent(replyRaw);
  const reply = silent
    ? ""
    : replyRaw.split(FOLLOWUP_SKIP_SENTINEL).join("").trim();
  // Bump the session (or create one titled by the first message if the follow-up is the first turn).
  await upsertPlaygroundSession(base, tenantId, agentId, threadId, "");
  return {
    reply,
    threadId,
    trace,
    sources: collectTraceSources(trace),
    silent: silent || reply.length === 0,
  };
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Size + type validation and mime normalization for an uploaded voice note, shared by the
// transcribe-only step and the full audio turn.
async function normalizeAudioUpload(
  file: File,
): Promise<{ bytes: ArrayBuffer; mimeType: string | null }> {
  if (file.size > MAX_AUDIO_BYTES) {
    throw new AppError("audio too large", 413, "errors.audioTooLarge");
  }
  // NOTE: Bun derives a multipart File's content-type from the filename extension, not the
  // browser-set `type`. MediaRecorder voice notes are `.webm`, which maps to `video/webm` (webm
  // is a video-container MIME even when it carries only an audio track), so an audio-only
  // recording legitimately arrives as `video/webm`. Accept it alongside `audio/*`, then normalize
  // it so the downstream STT request advertises an audio mime.
  const rawType = file.type || null;
  const isAudioLike =
    !rawType || rawType.startsWith("audio/") || rawType === "video/webm";
  if (!isAudioLike) {
    throw new AppError(
      "unsupported audio type",
      415,
      "errors.unsupportedAudioType",
    );
  }
  const mimeType = rawType === "video/webm" ? "audio/webm" : rawType;
  return { bytes: await file.arrayBuffer(), mimeType };
}

export interface PlaygroundTranscribeOnlyParams {
  tenantId: bigint;
  agentId: bigint;
  file: File;
  // Live draft (live-edit popup): its STT config overrides the saved one, so an unsaved credential
  // can be tested without persisting it first.
  overrides?: AgentConfigOverrides;
  base?: PrismaClient;
  sttDeps?: { fetchImpl?: typeof fetch };
}

// STT-only step for the playground UI: transcribe the uploaded voice note so the console can show
// the transcription IMMEDIATELY, before the (slower) agent turn runs. The full turn is a second
// call that receives this transcription back, skipping a redundant STT round trip (and the doubled
// latency it would add before the reply).
export async function runPlaygroundTranscribe(
  params: PlaygroundTranscribeOnlyParams,
): Promise<{ transcription: string }> {
  const { bytes, mimeType } = await normalizeAudioUpload(params.file);
  const transcription = await transcribePlaygroundAudio({
    tenantId: params.tenantId,
    agentId: params.agentId,
    audio: bytes,
    mimeType,
    base: params.base,
    deps: params.sttDeps,
    settings: params.overrides?.settings,
  });
  return { transcription };
}

export interface PlaygroundAudioParams {
  tenantId: bigint;
  agentId: bigint;
  file: File;
  threadId?: string;
  overrides?: AgentConfigOverrides;
  forceAudio?: boolean;
  // A transcription already produced by the transcribe-only step (the UI's two-step flow). When
  // present, STT is skipped here — no redundant round trip, no doubled latency before the reply.
  transcription?: string;
  base?: PrismaClient;
  deps?: PlaygroundDeps;
  sttDeps?: { fetchImpl?: typeof fetch };
}

export interface PlaygroundAudioResult extends PlaygroundTurnResult {
  // The cleaned transcription shown to the operator (may be empty for inaudible audio — the agent
  // still receives the production "inaudible voice note" marker so the test stays faithful).
  transcription: string;
}

// Voice-note round trip in the playground: transcribe the uploaded audio with the agent's STT
// provider (unless a transcription is supplied), render it as the SAME <mensagem-de-audio> the
// production inbound path feeds the agent, then run a normal turn. Returns the transcription (for
// display) plus the reply/trace.
export async function runPlaygroundAudioTurn(
  params: PlaygroundAudioParams,
): Promise<PlaygroundAudioResult> {
  const { tenantId, agentId, file } = params;
  const { bytes, mimeType } = await normalizeAudioUpload(file);

  // Reuse the transcribe-only step's result when supplied (the UI shows it early); otherwise
  // transcribe here. Either way the live draft's STT config overrides the saved one.
  const transcription =
    params.transcription !== undefined
      ? params.transcription
      : await transcribePlaygroundAudio({
          tenantId,
          agentId,
          audio: bytes,
          mimeType,
          base: params.base,
          deps: params.sttDeps,
          settings: params.overrides?.settings,
        });

  // Faithful rendering: the agent sees exactly what production would feed it for a voice note.
  const message = renderInboundMessage({
    text: "",
    transcribedText: transcription,
    attachmentTypes: ["audio"],
  });
  const turn = await runPlaygroundTurn({
    tenantId,
    agentId,
    message,
    threadId: params.threadId,
    // Title the session by the clean transcription, not the <mensagem-de-audio> wrapper.
    titleHint: transcription,
    overrides: params.overrides,
    // Persist the recording for replay, and let TTS "mirror" trigger (the user sent audio).
    userMedia: {
      kind: "user_audio",
      mime: mimeType ?? "audio/webm",
      fileName: file.name || "recording.webm",
      bytes,
    },
    userSentAudio: true,
    forceAudio: params.forceAudio,
    base: params.base,
    deps: params.deps,
  });
  return { transcription, ...turn };
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Size check + read bytes for an uploaded image/document, shared by the extract-only step and the
// full file turn. (Unlike audio there is no type guard — extractPlaygroundFile reports an
// unsupported type as kind: "unsupported" rather than throwing.)
async function readFileUpload(file: File): Promise<ArrayBuffer> {
  if (file.size > MAX_FILE_BYTES) {
    throw new AppError("file too large", 413, "errors.fileTooLarge");
  }
  return file.arrayBuffer();
}

export type PlaygroundExtractKind = "image" | "document" | "unsupported";

export interface PlaygroundExtractOnlyParams {
  tenantId: bigint;
  agentId: bigint;
  file: File;
  // Live draft (live-edit popup): its vision config overrides the saved one (test an unsaved key).
  overrides?: AgentConfigOverrides;
  base?: PrismaClient;
  visionDeps?: { fetchImpl?: typeof fetch };
}

// Vision-only step for the playground UI: extract the uploaded file so the console can show the
// extracted content IMMEDIATELY, before the (slower) agent turn runs. The full turn is a second
// call that receives this extraction back, skipping a redundant vision round trip (and the doubled
// latency it would add before the reply).
export async function runPlaygroundExtract(
  params: PlaygroundExtractOnlyParams,
): Promise<{ kind: PlaygroundExtractKind; extracted: string }> {
  const bytes = await readFileUpload(params.file);
  // Log the read as a `vision` stage on the Logs page (source=playground). This is step 1 of the
  // two-step UI flow, so the extraction runs HERE (step 2 reuses the result and skips it).
  const flow: FlowContext = {
    tenantId: params.tenantId,
    turnId: crypto.randomUUID(),
    source: "playground",
    agentId: params.agentId,
    base: params.base,
  };
  const { kind, text } = await extractPlaygroundFile({
    tenantId: params.tenantId,
    agentId: params.agentId,
    file: bytes,
    mimeType: params.file.type || null,
    base: params.base,
    deps: params.visionDeps,
    settings: params.overrides?.settings,
    flow,
  });
  return { kind, extracted: text };
}

export interface PlaygroundFileParams {
  tenantId: bigint;
  agentId: bigint;
  file: File;
  threadId?: string;
  overrides?: AgentConfigOverrides;
  forceAudio?: boolean;
  // An extraction already produced by the extract-only step (the UI's two-step flow). When both are
  // present, vision is skipped here — no redundant round trip, no doubled latency before the reply.
  kind?: PlaygroundExtractKind;
  extracted?: string;
  base?: PrismaClient;
  deps?: PlaygroundDeps;
  visionDeps?: { fetchImpl?: typeof fetch };
}

export interface PlaygroundFileResult extends PlaygroundTurnResult {
  // What the extractor produced, for display: "image" | "document" | "unsupported".
  kind: PlaygroundExtractKind;
  // The extracted content (empty for unsupported files).
  extracted: string;
}

// The vision provider/model that read a playground file, for the trace label (which reader ran —
// e.g. openai-compatible for a local Qwen). Draft settings win; else the saved agent settings.
// Playground-only read; falls back to a generic label if the agent/config vanished.
async function resolveVisionLabel(
  base: PrismaClient,
  tenantId: bigint,
  agentId: bigint,
  draftSettings: unknown,
): Promise<{ provider: string; model: string | null }> {
  const cfg =
    draftSettings !== undefined
      ? readVisionConfig(draftSettings)
      : await runScopedOn(base, sysCtx(tenantId), async (db) => {
          const agent = await db.agent.findUnique({
            where: { id: agentId },
            select: { settings: true },
          });
          return agent ? readVisionConfig(agent.settings) : null;
        });
  return { provider: cfg?.provider ?? "vision", model: cfg?.model || null };
}

// Image/document round trip in the playground: extract the uploaded file with the agent's vision
// provider (unless an extraction is supplied), render it as the SAME marker the production inbound
// path feeds the agent (<imagem> / <documento> / "could not extract"), then run a normal turn.
// Returns the extraction + the reply.
export async function runPlaygroundFileTurn(
  params: PlaygroundFileParams,
): Promise<PlaygroundFileResult> {
  const { tenantId, agentId, file } = params;
  const base = params.base ?? basePrisma;
  const bytes = await readFileUpload(file);

  // Reuse the extract-only step's result when supplied (the UI shows it early); otherwise extract
  // here (logging a `vision` stage). Either way the live draft's vision config overrides the saved one.
  const { kind, text } =
    params.kind !== undefined && params.extracted !== undefined
      ? { kind: params.kind, text: params.extracted }
      : await extractPlaygroundFile({
          tenantId,
          agentId,
          file: bytes,
          mimeType: file.type || null,
          base: params.base,
          deps: params.visionDeps,
          settings: params.overrides?.settings,
          flow: {
            tenantId,
            turnId: crypto.randomUUID(),
            source: "playground",
            agentId,
            base,
          },
        });

  // Faithful rendering: the agent sees exactly what production would feed it for this attachment.
  const message =
    kind === "image"
      ? renderInboundMessage({
          text: "",
          imageDescription: text,
          attachmentTypes: ["image"],
        })
      : kind === "document"
        ? renderInboundMessage({
            text: "",
            extractedText: text,
            attachmentTypes: ["file"],
          })
        : renderInboundMessage({
            text: "",
            attachmentTypes: ["file"],
            attachmentName: file.name || null,
          });

  const turn = await runPlaygroundTurn({
    tenantId,
    agentId,
    message,
    threadId: params.threadId,
    titleHint: file.name || text || "arquivo",
    overrides: params.overrides,
    // Persist the uploaded file for replay (best-effort).
    userMedia: {
      kind: "user_file",
      mime: file.type || "application/octet-stream",
      fileName: file.name || null,
      bytes,
    },
    forceAudio: params.forceAudio,
    base: params.base,
    deps: params.deps,
  });

  // Inject a `vision` entry at the HEAD of the trace so the read shows in "Execution details" — it
  // ran BEFORE the graph, so it is not in the message-derived trace. Unsupported files read nothing.
  const visionTrace: TraceEntry[] = [];
  if (kind === "image" || kind === "document") {
    const label = await resolveVisionLabel(
      base,
      tenantId,
      agentId,
      params.overrides?.settings,
    );
    visionTrace.push(
      buildVisionTraceEntry({
        mediaKind: kind,
        provider: label.provider,
        model: label.model,
        text,
      }),
    );
  }
  return {
    kind,
    extracted: text,
    ...turn,
    trace: [...visionTrace, ...turn.trace],
  };
}
