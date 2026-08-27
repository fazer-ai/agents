import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { lastAssistantText } from "@/graph/graph";
import type { ModelRetryInfo } from "@/graph/model-limit";
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
  type TraceGuardrail,
  type TraceLabelOpts,
  type TraceSource,
  traceGuardrail,
} from "@/graph/trace";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import { documentToolName } from "@/modules/documents/templates";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import {
  readFollowUpConfig,
  stepDelayMinutes,
} from "@/modules/followups/settings";
import {
  buildGuardrailGate,
  type GuardrailGate,
  guardrailTripped,
  screenedText,
} from "@/modules/guardrails/gate";
import { assertPlaygroundSpendCeiling } from "@/modules/spend-ceiling/service";
import { transcribePlaygroundAudio } from "@/modules/stt/service";
import { synthesizeReply } from "@/modules/tts/service";
import { shouldReplyWithAudio } from "@/modules/tts/settings";
import { extractPlaygroundFile } from "@/modules/vision/service";
import { readVisionConfig } from "@/modules/vision/settings";
import { type PlaygroundMediaKind, savePlaygroundMedia } from "./media";
import { rebuildPlaygroundTurns, upsertPlaygroundSession } from "./sessions";
import { isValidPlaygroundThread, newPlaygroundThreadId } from "./thread";
import { savePlaygroundTurnNote } from "./turn-notes";

// Agent playground: chat with a configured agent straight from the console, with NO Chatwoot round
// trip (no webhook, no real conversation, no debounce, no post). It runs the SAME model + system
// prompt + knowledge/HTTP/MCP tools as production so the operator tests behavior faithfully. The
// native CONVERSATION tools (handoff/resolve/…) ARE exposed but SIMULATED (no real effect), so the
// agent's decision to call them is testable; the operator can also mock ANY tool's result
// (`toolMocks`). Turns persist in the checkpointer under a tenant+agent-fenced playground thread, so
// the test session has memory. The agent's `enabled` toggle is ignored — you test before going live.

// The screening pass is a model call the operator pays for, on the one surface built for rapid
// iteration: an output turn can cost two on its own (`splitAnalyses` runs relevance alongside the
// rest), so a turn goes from one call to as many as three. On by default, because the playground's
// whole purpose is to show what the customer would get; off has to mean NO call, not a discarded
// verdict, which is why this picks the gate rather than filtering its answer.
const screensThisTurn = (p: { guardrails?: boolean }): boolean =>
  p.guardrails !== false;

const notScreened: GuardrailGate = async () => ({ kind: "not-run" });

// The id of the last message currently in the thread, which is where a turn the graph never ran
// belongs in the rebuilt transcript. Best-effort: without it the note still renders, just first.
// Where a turn the thread never received belongs: right after the last message the transcript
// SHOWS. It has to come from the renderer, because that is what resolves it — `applyTurnNotes`
// matches the anchor against the rebuilt turns, and the raw tail of the thread is not the same
// list. An AI message with no text is dropped by design, so anchoring to the raw tail after one
// yields an id no turn carries, and the note falls through to the end of a transcript it belongs in
// the middle of. One definition, taken from the side that does the matching.
async function lastRenderedMessageId(
  graph: {
    getState: (cfg: { configurable: { thread_id: string } }) => Promise<{
      values?: { messages?: unknown };
    }>;
  },
  threadId: string,
): Promise<string | null> {
  try {
    const st = await graph.getState({ configurable: { thread_id: threadId } });
    const msgs = st?.values?.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return null;
    const turns = rebuildPlaygroundTurns(msgs as BaseMessage[]);
    // The last turn's id is enough, with no walk back to one that has an id: `messagesStateReducer`
    // stamps a uuid on every message it takes in (measured), so a turn rebuilt from a checkpointed
    // thread always carries one. The guards inside the rebuild are for the hand-built arrays that
    // never see the reducer.
    return turns[turns.length - 1]?.messageId ?? null;
  } catch {
    return null;
  }
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
  // The REQUEST's context, not an id lifted out of it, and every playground entry point takes the
  // same. `runScopedOn` verifies an unknown tenant only for a SUPER_ADMIN caller, because the role
  // is what separates an id that came from outside the process from one it read from a row: this
  // module used to rebuild a TENANT_ADMIN context here, which told that check the id was internal
  // and turned a dead console selection into an empty playground instead of a refusal (issue #268).
  ctx: TenantContext;
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
  // Run the agent's guardrails over this turn (default true). See `screensThisTurn`.
  guardrails?: boolean;
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
  // The guardrail removed the reply (either direction). Distinct from an empty reply, which is the
  // agent having nothing to say, and it is what lets the live turn and a reload render the same
  // thing from the same fact.
  suppressed: boolean;
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
  const detail = clipText(embedded || firstLine, 300);
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
  ctx: TenantContext;
  agentId: bigint;
  threadId: string;
  base: PrismaClient;
  overrides?: AgentConfigOverrides;
}): Promise<AgentConfig> {
  const { ctx, agentId, threadId, base } = params;
  const tenantId = ctx.tenantId as bigint;
  const loaded = await runScopedOn(base, ctx, (db) =>
    loadAgentConfig(
      db,
      { tenantId, instanceId: 0n, conversationId: 0, agentId, threadId },
      { ignoreDisabled: true, overrides: params.overrides },
    ),
  );
  if (!loaded) {
    // Agent missing OR no model credential configured — distinguish the two for the operator.
    const exists = await runScopedOn(base, ctx, (db) =>
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
    ctx: TenantContext;
    threadId: string;
    base: PrismaClient;
    deps?: PlaygroundDeps;
    // The turn's telemetry context, so a tool-stage line the toolset produces lands in the Logs page
    // under source=playground. Without it a precondition refusal is invisible exactly where an
    // operator goes to find out what their agent does — a refused call never reaches the inner tool,
    // so ToolFlowLogger sees no run either and there is nothing else to read.
    flow: FlowContext | undefined;
  },
): Promise<StructuredToolInterface[]> {
  return buildToolset(
    loaded,
    {
      tenantId: params.ctx.tenantId as bigint,
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
      // A document tool is conversation-scoped for the same reason handoff/resolve are: it needs a
      // turn to attach the file to. Run for real here it would refuse every call with the message
      // meant for proactive nudges, so the playground would show behaviour production never
      // produces. Simulated, the operator sees the agent choose it — which is what they came to see.
      simulateDocuments: true,
      mcp: params.deps?.mcp,
      flow: params.flow,
    },
  );
}

// Shared load→build tail for both playground entry points. Loads the agent config + the simulated
// toolset, applies the operator's `toolMocks` over the result, then the model+graph and tracing
// callbacks. Returns `traceLabels` so callers can tag mocked/simulated results in the trace.
async function buildPlaygroundGraph(params: {
  ctx: TenantContext;
  agentId: bigint;
  threadId: string;
  base: PrismaClient;
  // Passed down to the toolset so a tool-stage line has somewhere to land. The graph's own callbacks
  // below already write to this same context; the toolset was the one seam that did not receive it.
  flow?: FlowContext;
  deps?: PlaygroundDeps;
  overrides?: AgentConfigOverrides;
  // Reused as the Langfuse trace id (item 10) so a playground trace correlates with the turn.
  turnId?: string;
  // The config, when the caller already resolved it. The two turn entrypoints do, because the
  // spend ceiling may only refuse a target that EXISTS — see the comment at their gates. Passing it
  // through keeps that ordering from costing a second read of the same agent row.
  loaded?: AgentConfig;
  // Same warn line the reactive turn leaves when a model call had to be retried. The caller passes
  // it because the FlowContext is the caller's.
  onModelRetry?: (info: ModelRetryInfo) => void;
  // The same two lines the two production entrypoints leave. The playground is where an operator
  // finds out what their agent does, so a fallback that silently answers here is a fallback they
  // conclude the wrong things from.
  onModelFallback?: (info: {
    provider: string;
    model: string;
    reason: string;
  }) => void;
  onModelFallbackFailed?: (info: {
    provider: string;
    model: string;
    reason: string;
  }) => void;
  onModelFallbackUnavailable?: (info: {
    provider: string;
    model: string;
    reason: string;
  }) => void;
  onHistoryTrim?: (info: {
    kept: number;
    dropped: number;
    tokens: number;
  }) => void;
}) {
  const { ctx, agentId, threadId, base } = params;
  const tenantId = ctx.tenantId as bigint;
  const loaded =
    params.loaded ??
    (await loadPlaygroundConfig({
      ctx,
      agentId,
      threadId,
      base,
      overrides: params.overrides,
    }));
  const rawTools = await buildPlaygroundToolset(loaded, {
    ctx,
    threadId,
    base,
    deps: params.deps,
    flow: params.flow,
  });
  const toolMocks = params.overrides?.toolMocks;
  const tools = applyToolMocks(rawTools, toolMocks);
  // Trace labels: which tool names are mocked (operator) vs simulated (conversation natives that the
  // agent actually has, minus any the operator mocked — the mock takes precedence).
  const mockedNames = new Set(Object.keys(toolMocks ?? {}));
  const toolNames = new Set(tools.map((tl) => tl.name));
  const simulatedNames = new Set(
    [
      ...CONVERSATION_NATIVE_TOOL_NAMES,
      // The document tools the agent was granted, by the name each template produces: they are
      // simulated here too, and a trace that did not say so would read as a document really issued.
      ...loaded.documentSelections.map((d) => documentToolName(d.slug)),
    ].filter((n) => toolNames.has(n) && !mockedNames.has(n)),
  );
  const traceLabels: TraceLabelOpts = { mockedNames, simulatedNames };
  const graph = await buildModelAndGraph(loaded, tools, {
    makeModel: params.deps?.makeModel,
    checkpointer: params.deps?.checkpointer,
    onModelRetry: params.onModelRetry,
    onModelFallback: params.onModelFallback,
    onModelFallbackFailed: params.onModelFallbackFailed,
    onModelFallbackUnavailable: params.onModelFallbackUnavailable,
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
  ctx: TenantContext;
  agentId: bigint;
  base?: PrismaClient;
  deps?: PlaygroundDeps;
}): Promise<PlaygroundToolInfo[]> {
  const base = params.base ?? basePrisma;
  const threadId = newPlaygroundThreadId(
    params.ctx.tenantId as bigint,
    params.agentId,
  );
  const loaded = await loadPlaygroundConfig({
    ctx: params.ctx,
    agentId: params.agentId,
    threadId,
    base,
  });
  const tools = await buildPlaygroundToolset(loaded, {
    ctx: params.ctx,
    threadId,
    base,
    deps: params.deps,
    // NOTE: A LISTING, not a turn: nothing here executes a tool, so there is no tool-stage line to
    // write and no FlowContext to write it to. Spelled out rather than omitted because the field is
    // required — the next caller has to answer the same question instead of inheriting a default.
    flow: undefined,
  });

  const conversation = new Set<string>(CONVERSATION_NATIVE_TOOL_NAMES);
  const utility = new Set<string>(UTILITY_NATIVE_TOOL_NAMES);
  // Simulated here for the same reason the conversation natives are, so the catalog has to say so:
  // the panel's badge is what tells the operator this run cannot issue a real document, and without
  // it the tool reads as an ordinary external one that does.
  const document = new Set(
    loaded.documentSelections.map((d) => documentToolName(d.slug)),
  );
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
    if (document.has(name))
      return { name, description, category: "external", simulated: true };
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
  const { ctx, agentId, message } = params;
  const tenantId = ctx.tenantId as bigint;
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
  // WHO IS BEING RUN, resolved before the ceiling is asked. A refusal says that spend was what stood
  // in the way, and for an agent that does not exist — or has no runnable model — there was never a
  // provider call to refuse: the same request in a month with budget to spare answers 404 or 400, so
  // answering 429 in a spent one reports a refusal that did not happen and sends the operator to
  // look at their budget over a selector that was simply wrong. The read is handed to the graph
  // below, so asking in this order costs nothing.
  const loadedConfig = await loadPlaygroundConfig({
    ctx,
    agentId,
    threadId,
    base,
    overrides: params.overrides,
  });
  // The playground's token ceiling, before the graph is built and before a single provider call.
  // Its own number, never the inbox one: an operator burning the month testing must not be able to
  // silence the agent for customers, and the two ledgers are already told apart by `source`.
  await assertPlaygroundSpendCeiling({ tenantId, base, flow });

  const { graph, callbacks, loaded, tools, traceLabels } =
    await buildPlaygroundGraph({
      ctx,
      agentId,
      threadId,
      base,
      deps: params.deps,
      overrides: params.overrides,
      turnId,
      flow,
      loaded: loadedConfig,
      onModelRetry: ({ attempt, provider, model }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { retriedEmptyResponse: attempt },
        }),
      onModelFallback: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { fallbackReason: reason },
        }),
      // ATTRIBUTION, NOT A SECOND ALARM, which is why this one line is `info` while the failure it
      // describes is an error. The `generate` stage this call sits inside emits its OWN error when the
      // turn throws, and alert coalescing keys on (channel, stage, level): two `generate`/`error` events
      // for one failed turn bump one delivery to "×2" — or, losing the race on the coalesce window, send
      // two — so the operator is paged twice for one outage and the Logs show two errors for one failure.
      // The stage owns the alarm; this line exists only to say WHICH model died, because the stage is
      // labelled with the primary by construction and would otherwise blame the model that never made
      // the second call. `status` stays "error": the call did fail.
      onModelFallbackFailed: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "info",
          status: "error",
          provider,
          model,
          detail: { fallbackFailed: reason },
        }),
      onModelFallbackUnavailable: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { fallbackUnavailable: reason },
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
  // Assigned rather than passed at construction: the debug mode is an agent SETTING, and the agent's
  // settings are what `buildPlaygroundGraph` just read. Every callback above only fires during
  // `graph.invoke` below, so none of them can emit before this line runs. Playground rows are on the
  // Logs page like any other, so an operator who turned the mode on for this agent gets the same
  // answer here as on real traffic (#58).
  flow.fullDetail = loaded.fullDetail;

  // The SAME gate the inbox path runs (issue #136). Without it the operator read the agent's raw
  // reply while the customer would have received the template, or nothing at all — the one setting
  // the playground exists to let them test. Announcements land in the trace instead of a private
  // note, because there is no conversation here to put a note on.
  //
  // The human message id is minted BEFORE the screening, because a blocked turn needs it too: the
  // media is linked to it, and the input direction returns before the graph produces any message.
  // Minted for EVERY turn, not only the ones carrying media: it is also the id a transcript note
  // points at, and the reload places the note next to the message it judged. Left to the reducer,
  // the id exists but nothing here knows it, and the note ends up with nowhere to go.
  const humanId = crypto.randomUUID();
  const saveInboundMedia = async (): Promise<string | undefined> =>
    params.userMedia
      ? ((await savePlaygroundMedia(base, {
          ctx,
          agentId,
          threadId,
          messageId: humanId,
          kind: params.userMedia.kind,
          mime: params.userMedia.mime,
          fileName: params.userMedia.fileName ?? null,
          bytes: params.userMedia.bytes,
        })) ?? undefined)
      : undefined;

  const gTrace: TraceGuardrail[] = [];
  const screen = screensThisTurn(params)
    ? buildGuardrailGate({
        cfg: loaded.guardrails,
        apiKey: loaded.guardrailsApiKey,
        credentialBaseUrl: loaded.guardrailsCredentialBaseUrl,
        announce: (r) => {
          gTrace.push(traceGuardrail(r));
        },
        flow,
        systemPrompt: loaded.systemPrompt,
        customerMessage: text,
        makeModel: params.deps?.makeModel,
      })
    : notScreened;

  // INPUT direction, reproduced faithfully: a violation does not merely alter the reply, it skips
  // the graph. Returning the template while still invoking the agent would read the same to the
  // operator and be a different (and billed) thing, which is the half a reply-only check misses.
  const inGuard = await screen("input", text);
  if (guardrailTripped(inGuard)) {
    const blockedReply = screenedText(inGuard, text) ?? "";
    await upsertPlaygroundSession(
      base,
      ctx,
      agentId,
      threadId,
      params.titleHint ?? text,
    );
    // The graph never ran, so the thread holds neither the message nor the reply and a reload would
    // simply lose the turn. The note carries both, anchored to the last message the transcript
    // SHOWS (see lastRenderedMessageId), which is not always what the thread ends on.
    const blockedMediaId = await saveInboundMedia();
    await savePlaygroundTurnNote(base, {
      ctx,
      agentId,
      threadId,
      messageId: null,
      anchorMessageId: await lastRenderedMessageId(graph, threadId),
      userMessageId: humanId,
      // The RENDERED text, markers and all, because the rebuild unwraps them exactly as it does for
      // a turn that reached the thread. Storing the clean text would need a SECOND renderer, which
      // is what got the audio and file turns wrong to begin with.
      userText: text,
      reply: blockedReply,
      guardrails: [...gTrace],
    });
    return {
      reply: blockedReply,
      threadId,
      trace: [...gTrace],
      sources: [],
      suppressed: blockedReply === "",
      ...(blockedMediaId ? { userMediaId: blockedMediaId } : {}),
    };
  }
  // Everything screened before the graph belongs ahead of the graph's own entries in the trace.
  const beforeGraph = gTrace.length;

  const human = new HumanMessage({ content: text, id: humanId });

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
  // OUTPUT direction: screen the reply BEFORE anything renders it, so the TTS below synthesizes the
  // text that would actually be delivered rather than the one the guardrail took away.
  const raw = lastAssistantText(result.messages).trim();
  const outGuard = raw
    ? await screen("output", raw)
    : { kind: "not-run" as const };
  const reply = screenedText(outGuard, raw) ?? "";
  const trace: TraceEntry[] = [
    ...gTrace.slice(0, beforeGraph),
    ...buildPlaygroundTrace(result.messages, traceLabels),
    ...gTrace.slice(beforeGraph),
  ];
  await upsertPlaygroundSession(
    base,
    ctx,
    agentId,
    threadId,
    params.titleHint ?? text,
  );

  // The checkpointer holds the model's OWN reply, as production's thread does, so a reload would
  // show the text the guardrail took away and no sign that it acted. Every turn the guardrail RAN
  // on gets a note, a clean verdict included: the toggle is per turn, so without the clean mark a
  // reopened session cannot tell an approved reply from one nothing ever screened, which is the
  // ambiguity the issue is about. `gTrace` empty means it never ran, and writes nothing.
  //
  // NOTE: The two stores are not written atomically, and cannot be: `graph.invoke` has already
  // committed the model's own reply to the checkpointer by the time the screening (a model call)
  // returns. A second mount reopening this same session in that window rebuilds from the
  // checkpointer alone and reads the raw reply. Left open deliberately — see `.codex-review-waived`
  // for what each way of closing it costs, all of them more than a seconds-long window on a
  // surface one operator drives.
  if (gTrace.length > 0) {
    await savePlaygroundTurnNote(base, {
      ctx,
      agentId,
      threadId,
      messageId: lastAiMessageId(result.messages) ?? null,
      anchorMessageId: null,
      // The reply this annotates can be empty (the agent said nothing), and the rebuild drops an
      // empty AI message, so `messageId` alone is not always an id the transcript shows. The human
      // message always is, and it is the one the verdict belongs next to.
      userMessageId: humanId,
      userText: null,
      reply,
      guardrails: [...gTrace],
    });
  }

  // Persist the user's inbound media (best-effort) for replay on reopen.
  const userMediaId = await saveInboundMedia();

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
            ctx,
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
    suppressed: raw.length > 0 && reply.length === 0,
    ...(userMediaId ? { userMediaId } : {}),
    ...(ttsMediaId ? { ttsMediaId } : {}),
  };
}

export interface PlaygroundFollowupParams {
  ctx: TenantContext;
  agentId: bigint;
  threadId?: string;
  // Optional operator-supplied situation note; overrides the default "inactive for ~N min" summary.
  context?: string;
  // Run the agent's guardrails over this turn (default true). See `screensThisTurn`.
  guardrails?: boolean;
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
  // The agent DID write a follow-up and the guardrail removed it. Mutually exclusive with `silent`:
  // both mean nothing is sent, and only this one has a verdict behind it.
  suppressed: boolean;
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
  const { ctx, agentId } = params;
  const tenantId = ctx.tenantId as bigint;
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
  // WHO IS BEING RUN, resolved before the ceiling is asked. A refusal says that spend was what stood
  // in the way, and for an agent that does not exist — or has no runnable model — there was never a
  // provider call to refuse: the same request in a month with budget to spare answers 404 or 400, so
  // answering 429 in a spent one reports a refusal that did not happen and sends the operator to
  // look at their budget over a selector that was simply wrong. The read is handed to the graph
  // below, so asking in this order costs nothing.
  const loadedConfig = await loadPlaygroundConfig({
    ctx,
    agentId,
    threadId,
    base,
    overrides: params.overrides,
  });
  // The playground's token ceiling, before the graph is built and before a single provider call.
  // Its own number, never the inbox one: an operator burning the month testing must not be able to
  // silence the agent for customers, and the two ledgers are already told apart by `source`.
  await assertPlaygroundSpendCeiling({ tenantId, base, flow });

  const { graph, callbacks, loaded, tools, traceLabels } =
    await buildPlaygroundGraph({
      ctx,
      agentId,
      threadId,
      base,
      deps: params.deps,
      overrides: params.overrides,
      turnId,
      flow,
      loaded: loadedConfig,
      onModelRetry: ({ attempt, provider, model }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { retriedEmptyResponse: attempt },
        }),
      onModelFallback: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { fallbackReason: reason },
        }),
      // ATTRIBUTION, NOT A SECOND ALARM, which is why this one line is `info` while the failure it
      // describes is an error. The `generate` stage this call sits inside emits its OWN error when the
      // turn throws, and alert coalescing keys on (channel, stage, level): two `generate`/`error` events
      // for one failed turn bump one delivery to "×2" — or, losing the race on the coalesce window, send
      // two — so the operator is paged twice for one outage and the Logs show two errors for one failure.
      // The stage owns the alarm; this line exists only to say WHICH model died, because the stage is
      // labelled with the primary by construction and would otherwise blame the model that never made
      // the second call. `status` stays "error": the call did fail.
      onModelFallbackFailed: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "info",
          status: "error",
          provider,
          model,
          detail: { fallbackFailed: reason },
        }),
      onModelFallbackUnavailable: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { fallbackUnavailable: reason },
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
  // Same reason as the turn path above: set after the settings read, before any callback can emit.
  flow.fullDetail = loaded.fullDetail;

  // Draft settings (if present) drive the follow-up instructions/delay so the simulation matches
  // what the operator is editing live; otherwise the saved settings.
  const agent = await runScopedOn(base, ctx, (db) =>
    db.agent.findUnique({ where: { id: agentId }, select: { settings: true } }),
  );
  const settings = params.overrides?.settings ?? agent?.settings;
  const followUp = readFollowUpConfig(settings);
  // The playground previews the FIRST step's message (the simulation has no real schedule). Post
  // actions (label/resolve) are NOT applied here — there is no real conversation to act on.
  const firstStep = followUp.steps[0];
  const summary = params.context?.trim()
    ? clipText(params.context.trim(), 500)
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
            // From the loaded config, which reads this block off the SAVED bag — never from
            // `settings` here, which is the draft. Recording policy does not follow a draft (see
            // `prepare.ts`), and this line reading it separately is how the follow-up path came to
            // answer differently from the turn path for the same agent.
            logValues: loaded.logToolValues,
            tools,
          }),
        ],
      },
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw toPlaygroundInvokeError(e);
  }
  // Same silence contract as production (runAgentNudge): the skip sentinel / narrated-emptiness is
  // "stayed silent", and a stray sentinel is stripped so it never shows in the simulated reply.
  const replyRaw = lastAssistantText(result.messages);
  const silentByChoice = isNudgeSilent(replyRaw);
  const drafted = silentByChoice
    ? ""
    : replyRaw.split(FOLLOWUP_SKIP_SENTINEL).join("").trim();
  // OUTPUT direction only, exactly as the inbox's proactive path (issue #160): a follow-up answers
  // no question, so there is no customer message for the relevance check to judge, and the gate
  // drops that check structurally when none is passed. A `silent` verdict reads as silence here for
  // the same reason it does in production — the customer gets nothing either way.
  const gTrace: TraceGuardrail[] = [];
  const screen = screensThisTurn(params)
    ? buildGuardrailGate({
        cfg: loaded.guardrails,
        apiKey: loaded.guardrailsApiKey,
        credentialBaseUrl: loaded.guardrailsCredentialBaseUrl,
        announce: (r) => {
          gTrace.push(traceGuardrail(r));
        },
        flow,
        systemPrompt: loaded.systemPrompt,
        makeModel: params.deps?.makeModel,
      })
    : notScreened;
  const outGuard = drafted
    ? await screen("output", drafted)
    : ({ kind: "not-run" } as const);
  const reply = screenedText(outGuard, drafted) ?? "";
  // "Nothing is sent" has two causes here and the operator needs them apart: the agent deciding a
  // follow-up is not warranted, and the guardrail removing one it did write. Reported as the
  // former, the second renders as "the agent chose not to send anything" and the verdict that
  // explains the silence is thrown away with the trace.
  // Defined on `drafted`, not on the sentinel: a model that answers with nothing at all is the
  // agent staying silent too, and only a follow-up that HAD text and lost it is a suppression.
  const suppressed = drafted.length > 0 && reply.length === 0;
  const silent = reply.length === 0 && !suppressed;
  const trace: TraceEntry[] = [
    ...buildPlaygroundTrace(result.messages, traceLabels),
    ...gTrace,
  ];
  if (gTrace.length > 0) {
    await savePlaygroundTurnNote(base, {
      ctx,
      agentId,
      threadId,
      messageId: lastAiMessageId(result.messages) ?? null,
      anchorMessageId: null,
      // No user message to hang it on: a follow-up is a nudge, and the rebuild renders a nudge as
      // an assistant turn alone. An annotation whose reply was empty therefore lands at the end,
      // which for a follow-up is where it happened anyway.
      userMessageId: null,
      userText: null,
      reply,
      guardrails: [...gTrace],
    });
  }
  // Bump the session (or create one titled by the first message if the follow-up is the first turn).
  await upsertPlaygroundSession(base, ctx, agentId, threadId, "");
  return {
    reply,
    threadId,
    trace,
    sources: collectTraceSources(trace),
    silent,
    suppressed,
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
  ctx: TenantContext;
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
    ctx: params.ctx,
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
  ctx: TenantContext;
  agentId: bigint;
  file: File;
  threadId?: string;
  overrides?: AgentConfigOverrides;
  forceAudio?: boolean;
  // See `screensThisTurn`. Forwarded to the turn this delegates to.
  guardrails?: boolean;
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
  const { ctx, agentId, file } = params;
  const { bytes, mimeType } = await normalizeAudioUpload(file);

  // Reuse the transcribe-only step's result when supplied (the UI shows it early); otherwise
  // transcribe here. Either way the live draft's STT config overrides the saved one.
  const transcription =
    params.transcription !== undefined
      ? params.transcription
      : await transcribePlaygroundAudio({
          ctx,
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
    ctx,
    agentId,
    message,
    threadId: params.threadId,
    // Title the session by the clean transcription, not the <mensagem-de-audio> wrapper.
    titleHint: transcription,
    overrides: params.overrides,
    guardrails: params.guardrails,
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
  ctx: TenantContext;
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
    tenantId: params.ctx.tenantId as bigint,
    turnId: crypto.randomUUID(),
    source: "playground",
    agentId: params.agentId,
    base: params.base,
  };
  const { kind, text } = await extractPlaygroundFile({
    ctx: params.ctx,
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
  ctx: TenantContext;
  agentId: bigint;
  file: File;
  threadId?: string;
  overrides?: AgentConfigOverrides;
  forceAudio?: boolean;
  // See `screensThisTurn`. Forwarded to the turn this delegates to.
  guardrails?: boolean;
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
  ctx: TenantContext,
  agentId: bigint,
  draftSettings: unknown,
): Promise<{ provider: string; model: string | null }> {
  const cfg =
    draftSettings !== undefined
      ? readVisionConfig(draftSettings)
      : await runScopedOn(base, ctx, async (db) => {
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
  const { ctx, agentId, file } = params;
  const tenantId = ctx.tenantId as bigint;
  const base = params.base ?? basePrisma;
  const bytes = await readFileUpload(file);

  // Reuse the extract-only step's result when supplied (the UI shows it early); otherwise extract
  // here (logging a `vision` stage). Either way the live draft's vision config overrides the saved one.
  const { kind, text } =
    params.kind !== undefined && params.extracted !== undefined
      ? { kind: params.kind, text: params.extracted }
      : await extractPlaygroundFile({
          ctx,
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
    ctx,
    agentId,
    message,
    threadId: params.threadId,
    titleHint: file.name || text || "arquivo",
    overrides: params.overrides,
    guardrails: params.guardrails,
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
      ctx,
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
