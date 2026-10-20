// The client channel: an agent embedded in a host application, whose page declares the tools it
// runs itself. One turn is one or more round-trips: the turn runs until the model either answers or
// calls client tools; on the second it suspends (graph/client-tools.ts) and the caller gets the
// calls back as `pending`. The host runs them in the browser, with the signed-in user's session,
// and resumes the same turn with the answers.
//
// Its threads (tenantId:client:agentId:uuid, graph/detached-thread.ts), its usage source and its
// spend ceiling are its own: `client` is real traffic, so its errors page like the inbox's.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import appConfig from "@/config";
import { getCheckpointer } from "@/graph/checkpointer";
import {
  boundClientAnswers,
  buildClientToolStubs,
  type ClientToolAnswer,
  type ClientToolCall,
  type ClientToolSpec,
  type ClientToolsInterrupt,
  unansweredToolMessages,
} from "@/graph/client-tools";
import {
  buildDetachedToolset,
  loadDetachedConfig,
} from "@/graph/detached-turn";
import {
  lastAssistantText,
  recursionLimitFor,
  replyWrittenThisTurn,
} from "@/graph/graph";
import { sentAtStamp } from "@/graph/markers";
import { modelTelemetry } from "@/graph/model-telemetry";
import type { ResolvedModelConfig } from "@/graph/models";
import { buildCallbacks, buildModelAndGraph } from "@/graph/prepare";
import { customerFacingReply } from "@/graph/silence";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import { CLIENT_CHANNEL_NATIVES } from "@/graph/tools/channel-natives";
import type { McpLoadDeps } from "@/graph/tools/mcp";
import { logSchemaRefusals } from "@/graph/tools/refusal-log";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { isAnonUserId } from "@/modules/client-apps/anonymous";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import {
  buildExternalCheck,
  type ExternalCallDeps,
  turnToolCalls,
} from "@/modules/guardrails/external";
import {
  buildGuardrailGate,
  type GuardrailDecision,
  guardrailTripped,
  screenedByOperator,
  screenedText,
} from "@/modules/guardrails/gate";
import type { GuardrailsConfig } from "@/modules/guardrails/settings";
import { assertClientSpendCeiling } from "@/modules/spend-ceiling/service";
import { detachedCaseFor } from "./case";
import {
  admitWorkFor,
  fencedCheckpointer,
  interruptedToolMessages,
  recoveryNode,
  unansweredCalls,
  withoutAnswers,
} from "./fence";
import {
  claimClientThread,
  type ExternalIdentity,
  leaseClientThread,
  recordClientMessage,
  releaseClientThread,
  renewClientThread,
} from "./identity";
import { type ClientTurnEvent, ClientTurnProgress } from "./progress";
import {
  MAX_SCREEN_CONTEXT_CHARS,
  screenContextTooLarge,
  withoutScreenContext,
  withScreenContext,
} from "./screen-context";

export interface ClientChannelDeps {
  makeModel?: (cfg: ResolvedModelConfig) => BaseChatModel;
  checkpointer?: BaseCheckpointSaver;
  mcp?: McpLoadDeps;
  // The Chatwoot client of the account a case is opened in; tests stub it.
  loadChatwootClient?: (
    tenantId: bigint,
    instanceId: bigint,
  ) => Promise<ChatwootClient>;
  // The claim on the thread and how often it is renewed; tests shorten both.
  lease?: { ms: number; renewEveryMs: number };
  // The external guardrail check's network half; tests stub it.
  externalCheck?: ExternalCallDeps;
}

export interface ClientTurnParams {
  ctx: TenantContext;
  agentId: bigint;
  threadId?: string;
  // The host's signed-in user, as its server states it. The thread is bound to them and to their scope.
  user: ExternalIdentity;
  // Exactly one of the two: a new message from the user, or the answers to the pending calls.
  message?: string;
  // The message was spoken: the widget sent its transcription. Kept with it in the transcript.
  voice?: boolean;
  answers?: Record<string, ClientToolAnswer>;
  // What the page says about itself right now (screen, ids, last error). Sent with each message.
  context?: Record<string, unknown>;
  clientTools: ClientToolSpec[];
  base?: PrismaClient;
  deps?: ClientChannelDeps;
  // The clock the suspension deadline is read against; tests move it.
  now?: Date;
  // Told of each server-side tool as it starts and ends, for a caller that streams progress.
  onEvent?: (event: ClientTurnEvent) => void;
}

// The claim a round-trip holds on its thread, renewed while it runs. A round-trip has no overall
// deadline (each model call has its own, and the tool budget allows several), so a fixed claim could
// expire under a live one. Renewed, it only expires when the process holding it stopped, and two
// minutes is how long such a thread stays refused.
const TURN_LEASE = { ms: 2 * 60_000, renewEveryMs: 30_000 };

export type ClientTurnResult =
  | { threadId: string; status: "pending"; calls: ClientToolCall[] }
  | { threadId: string; status: "done"; reply: string };

function pendingInterrupt(
  interrupts: unknown,
): ClientToolsInterrupt | undefined {
  if (!Array.isArray(interrupts)) return undefined;
  for (const it of interrupts) {
    const value = (it as { value?: ClientToolsInterrupt }).value;
    if (value?.kind === "client_tools") return value;
  }
  return undefined;
}

// The user's own words in the turn being answered: the last human message, without the screen
// context this channel puts ahead of it. A round-trip that resumes with the browser's answers
// carries no message of its own, and the output screening still has to know what was asked.
function lastUserMessage(messages: BaseMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.getType() !== "human") continue;
    const content = typeof m.content === "string" ? m.content : "";
    return withoutScreenContext(content) || undefined;
  }
  return undefined;
}

// The guardrails as this channel can carry them out. A handoff has no team to go to here, so the
// handoff message would promise a person who never comes; the direction's refusal is said instead,
// and the gate records the action it actually took. A held screening (`onFailure: "hold"`) says
// the handoff message whatever the action, so that message is the refusal too.
function clientGuardrails(cfg: GuardrailsConfig): GuardrailsConfig {
  const direction = (d: GuardrailsConfig["input"]) => ({
    ...d,
    action: d.action === "handoff" ? ("template" as const) : d.action,
    handoffMessage: d.templateMessage,
  });
  return { ...cfg, input: direction(cfg.input), output: direction(cfg.output) };
}

export async function runClientTurn(
  params: ClientTurnParams,
): Promise<ClientTurnResult> {
  const { ctx, agentId } = params;
  const base = params.base ?? basePrisma;
  const text = params.message?.trim();
  if (!text === !params.answers)
    throw new AppError("send either a message or the tool answers", 400);
  if (screenContextTooLarge(params.context))
    throw new AppError(
      `the page context is over ${MAX_SCREEN_CONTEXT_CHARS} characters`,
      413,
      "errors.clientContextTooLarge",
      { max: MAX_SCREEN_CONTEXT_CHARS },
    );

  const { threadId, externalUserId } = await claimClientThread({
    ctx,
    agentId,
    threadId: params.threadId,
    user: params.user,
    base,
    message: params.message,
  });
  const turnId = crypto.randomUUID();
  const lease = params.deps?.lease ?? TURN_LEASE;
  const leasedAt = Date.now();
  const leased = await leaseClientThread({
    ctx,
    threadId,
    turnId,
    base,
    leaseMs: lease.ms,
    owner: { externalUserId, scope: params.user.scope ?? null },
  });
  if (!leased)
    throw new AppError(
      "another request is running on this thread",
      409,
      "errors.clientTurnInProgress",
    );
  // The round-trip stops admitting work once its claim is gone (another request took it) or about
  // to lapse unconfirmed (renewals kept failing), so two requests never run the thread together. The
  // signal goes to the graph's own cancellation path, which ends it at a consistent point.
  const fence = new AbortController();
  let settled = false;
  const stop = (why: string) => {
    if (settled || fence.signal.aborted) return;
    logger.warn({ threadId, turnId }, `client turn stopped: ${why}`);
    fence.abort(
      new AppError(
        "this request lost its claim on the thread and was stopped",
        409,
        "errors.clientTurnClaimLost",
      ),
    );
  };
  let lapse = setTimeout(
    () => stop("claim not confirmed in time"),
    admitWorkFor(leasedAt, lease.ms, Date.now()),
  );
  const renewal = setInterval(() => {
    const askedAt = Date.now();
    renewClientThread({ ctx, threadId, turnId, base, leaseMs: lease.ms })
      .then((held) => {
        // NOTE: a renewal still in flight when the round-trip ended must not rearm anything.
        if (settled) return;
        if (!held) return stop("claim taken by another request");
        clearTimeout(lapse);
        lapse = setTimeout(
          () => stop("claim not confirmed in time"),
          admitWorkFor(askedAt, lease.ms, Date.now()),
        );
      })
      .catch((err) =>
        logger.warn({ err, threadId }, "client turn claim renewal failed"),
      );
  }, lease.renewEveryMs);
  try {
    const result = await runLeasedTurn(params, {
      threadId,
      externalUserId,
      turnId,
      text,
      base,
      signal: fence.signal,
    });
    // NOTE: a run that ended after the claim was lost is the lost claim, not a reply. The fenced
    // checkpointer already makes such a run throw on its next write; this holds for one that wrote
    // nothing.
    if (fence.signal.aborted) throw fence.signal.reason;
    // NOTE: the reply exactly as it goes to the page, after both screenings; silence records nothing.
    if (result.status === "done" && result.reply)
      await recordClientMessage({
        ctx,
        base,
        threadId,
        role: "agent",
        text: result.reply,
      });
    // NOTE: the claim can be lost while the reply is written; the turn is then the lost claim, as
    // above. The reply stays in the transcript, as it stays in the checkpoint it was written beside.
    if (fence.signal.aborted) throw fence.signal.reason;
    return result;
  } catch (err) {
    if (fence.signal.aborted) throw fence.signal.reason;
    throw err;
  } finally {
    settled = true;
    clearInterval(renewal);
    clearTimeout(lapse);
    // NOTE: the turn's result is already checkpointed, so a release that fails must not replace it
    // with an error; the claim then expires on its own.
    await releaseClientThread({ ctx, threadId, turnId, base }).catch((err) =>
      logger.warn({ err, threadId }, "client turn claim release failed"),
    );
  }
}

async function runLeasedTurn(
  params: ClientTurnParams,
  turn: {
    threadId: string;
    externalUserId: bigint;
    turnId: string;
    text: string | undefined;
    base: PrismaClient;
    signal: AbortSignal;
  },
): Promise<ClientTurnResult> {
  const { ctx, agentId } = params;
  const { threadId, externalUserId, turnId, text, base } = turn;
  const tenantId = ctx.tenantId as bigint;
  const anonymous = isAnonUserId(params.user.id);
  const flow: FlowContext = {
    tenantId,
    turnId,
    source: "client",
    anonymous,
    agentId,
    threadId,
    base,
  };
  const loaded = await loadDetachedConfig({ ctx, agentId, threadId, base });
  await assertClientSpendCeiling({ tenantId, base, flow });
  // The output gate is built after the graph; a case's opening is screened by it once it exists.
  let screenOpening: ((text: string) => Promise<GuardrailDecision>) | null =
    null;

  const agentTools = logSchemaRefusals(
    await buildDetachedToolset(loaded, {
      ctx,
      threadId,
      base,
      mcp: params.deps?.mcp,
      flow,
      // NOTE: no spoken reply on this channel, so `reply_as_text` has nothing to choose between.
      replyChoice: undefined,
      natives: CLIENT_CHANNEL_NATIVES,
      documents: "omitted",
      caseOrigin: await detachedCaseFor({
        ctx,
        base,
        loaded,
        threadId,
        externalUserId,
        turnId,
        loadClient: params.deps?.loadChatwootClient,
        checkpointer: params.deps?.checkpointer,
        currentMessage: text,
      }),
      screenCustomerText: async (opening) => {
        const d = await screenOpening?.(opening);
        return d && guardrailTripped(d) ? "drop" : "send";
      },
    }),
    flow,
    loaded.logToolValues,
  );
  const taken = new Set(agentTools.map((tl) => tl.name));
  const clash = params.clientTools.find((spec) => taken.has(spec.name));
  if (clash)
    throw new AppError(
      `client tool "${clash.name}" has the name of one of the agent's tools`,
      400,
    );
  const tools = [...agentTools, ...buildClientToolStubs(params.clientTools)];
  // Which model wrote the reply, for the external check's request.
  let fallbackAnswered = false;
  const telemetry = modelTelemetry(flow, loaded.mc.provider);
  const graph = await buildModelAndGraph(loaded, tools, {
    makeModel: params.deps?.makeModel,
    checkpointer: fencedCheckpointer(
      params.deps?.checkpointer ?? (await getCheckpointer()),
      turn.signal,
    ),
    clientToolNames: new Set(params.clientTools.map((spec) => spec.name)),
    signal: turn.signal,
    // Customers reach this channel as they reach the inbox, so a primary outage the fallback hides
    // has to reach the operator's alerts the same way.
    ...telemetry,
    onModelFallback: (info) => {
      fallbackAnswered = true;
      telemetry.onModelFallback?.(info);
    },
  });
  const callbacks = buildCallbacks(loaded, {
    tenantId,
    threadId,
    base,
    source: "client",
    anonymous,
    turnId,
    tools,
  });
  flow.fullDetail = loaded.fullDetail;

  const config = { configurable: { thread_id: threadId } };
  const snapshot = await graph.getState(config);
  let waiting = pendingInterrupt(snapshot.tasks.flatMap((t) => t.interrupts));
  const orphans = waiting
    ? []
    : unansweredCalls(
        (snapshot.values as { messages?: BaseMessage[] }).messages ?? [],
      );
  if (orphans.length > 0) {
    // NOTE: a round-trip stopped mid-tool, or a process that died there, left calls with no answer.
    // They are closed as interrupted so the history the model gets is one the providers accept.
    await graph.updateState(
      config,
      { messages: interruptedToolMessages(orphans) },
      recoveryNode(graph.nodes),
    );
  }
  if (text && waiting) {
    const suspendedAt = snapshot.createdAt
      ? Date.parse(snapshot.createdAt)
      : Number.NaN;
    const age = (params.now ?? new Date()).getTime() - suspendedAt;
    if (!(age >= appConfig.agent.clientTurnSuspendTimeoutMs))
      throw new AppError(
        "the turn is waiting for the answers to its client tool calls",
        409,
        "errors.clientTurnAwaitingAnswers",
      );
    // NOTE: the browser is gone. The old turn is closed by recording every pending call as
    // unanswered, without a model call for a reply nobody would read, and the new message starts
    // the next turn on top of it.
    turn.signal.throwIfAborted();
    const open = withoutAnswers(
      waiting.calls,
      (snapshot.values as { messages?: BaseMessage[] }).messages ?? [],
    );
    if (open.length > 0)
      await graph.updateState(
        config,
        { messages: unansweredToolMessages(open) },
        "client_tools",
      );
    emitFlowEvent(flow, {
      stage: "tool",
      level: "info",
      status: "skipped",
      detail: { phase: "client_timeout", calls: open.length },
    });
    waiting = undefined;
  }
  if (params.answers) {
    if (!waiting)
      throw new AppError(
        "no client tool call is waiting for an answer",
        409,
        "errors.clientTurnNothingWaiting",
      );
    const expected = new Set(waiting.calls.map((c) => c.toolCallId));
    const unknown = Object.keys(params.answers).find((id) => !expected.has(id));
    if (unknown)
      throw new AppError(
        `no pending call has the id "${unknown}"`,
        400,
        "errors.clientTurnUnknownCall",
        { id: unknown },
      );
    // The suspended node answers the calls of the tools this request declares; a pending call
    // to a tool missing from it would be skipped, and its answer lost.
    const declared = new Set(params.clientTools.map((spec) => spec.name));
    const undeclared = waiting.calls.find((c) => !declared.has(c.name));
    if (undeclared)
      throw new AppError(
        `the pending call to "${undeclared.name}" is to a tool this request does not declare`,
        400,
        "errors.clientTurnUndeclaredTool",
        { tool: undeclared.name },
      );
  }

  // The agent's guardrails, as the inbox and the playground run them: the gate writes its own flow
  // lines, which are this channel's trail. A browser's tool answers are tool results, not the user's
  // words, so only a new message is screened on the way in.
  const customerMessage =
    text ??
    lastUserMessage(
      (snapshot.values as { messages?: BaseMessage[] }).messages ?? [],
    );
  const guardrails = clientGuardrails(loaded.guardrails);
  const screen = buildGuardrailGate({
    cfg: guardrails,
    apiKey: loaded.guardrailsApiKey,
    credentialBaseUrl: loaded.guardrailsCredentialBaseUrl,
    flow,
    systemPrompt: loaded.systemPrompt,
    customerMessage,
    makeModel: params.deps?.makeModel,
    langfuseCfg: loaded.langfuseCfg,
  });
  screenOpening = (opening) => screen("output", opening);
  if (text) {
    // The user's message as they sent it, into what they are shown on reopening; recorded once every
    // refusal of the request itself is behind, and before the screening, whose refusal answers it.
    // Not by a request that lost its claim on the way here: another may own the thread by now.
    turn.signal.throwIfAborted();
    await recordClientMessage({
      ctx,
      base,
      threadId,
      role: "user",
      text,
      voice: params.voice,
    });
    const inGuard = await screen("input", text);
    // NOTE: a violation skips the graph, so the message never enters the thread and the model is
    // not billed for a reply that would be thrown away.
    if (guardrailTripped(inGuard))
      return {
        threadId,
        status: "done",
        reply: screenedText(inGuard, text) ?? "",
      };
  }

  const input: Parameters<typeof graph.invoke>[0] = params.answers
    ? // NOTE: the Command's node-name parameter is `string`, the graph's is its own node union.
      (new Command({
        resume: boundClientAnswers(params.answers),
      }) as Parameters<typeof graph.invoke>[0])
    : {
        messages: [
          // Dated like any customer message, so a thread resumed days later reads "today" as it was.
          new HumanMessage({
            content: withScreenContext(text as string, params.context),
            id: turnId,
            additional_kwargs: sentAtStamp(loaded.promptOpts.messageAt),
          }),
        ],
      };
  // Settled when the round-trip ends, so a tool that failed on every call of it is the warn line the
  // health block and the alerts read.
  const toolLogger = new ToolFlowLogger(flow, {
    logValues: loaded.logToolValues,
    tools,
  });
  let result: Awaited<ReturnType<typeof graph.invoke>>;
  try {
    result = await withFlowStage(
      flow,
      "generate",
      { provider: loaded.mc.provider, model: loaded.mc.model },
      () =>
        graph.invoke(input, {
          ...config,
          recursionLimit: recursionLimitFor(loaded.maxToolCalls),
          callbacks: [
            ...callbacks,
            toolLogger,
            ...(params.onEvent
              ? [
                  new ClientTurnProgress(
                    params.onEvent,
                    new Set(params.clientTools.map((spec) => spec.name)),
                  ),
                ]
              : []),
          ],
        }),
    );
  } finally {
    toolLogger.settle();
  }

  const suspended = pendingInterrupt(
    (result as { __interrupt__?: unknown }).__interrupt__,
  );
  if (suspended) return { threadId, status: "pending", calls: suspended.calls };
  const drafted = customerFacingReply(lastAssistantText(result.messages));
  // A reply written beside a tool call, before a final message that said nothing, is the reply: the
  // inbox's recovery (docs/graph.md, "Saying nothing"). Nothing else answers a client turn, and
  // `skip_reply` still reads as silence there.
  const raw = drafted.wroteText
    ? drafted.text
    : customerFacingReply(replyWrittenThisTurn(result.messages)).text;
  const outGuard = raw
    ? await screen("output", raw)
    : ({ kind: "not-run" } as const);
  let reply = screenedText(outGuard, raw) ?? "";
  // The operator's endpoint, as the inbox and the playground ask it: after the built-in screening, on
  // what would be returned, unless that is already the operator's own text. A block or a held failure
  // says the refusal, since there is no team to hand over to here.
  const external = buildExternalCheck({
    cfg: guardrails,
    ctx: {
      tenantId,
      agentId,
      conversationId: null,
      chatwootConversationId: null,
      turnId,
      customerMessage: customerMessage ?? "",
    },
    secret: loaded.guardrailsExternalSecret,
    secretMissing: loaded.guardrailsExternalSecretMissing,
    logValues: loaded.logToolValues,
    flow,
    deps: params.deps?.externalCheck,
  });
  if (external && reply && !screenedByOperator(outGuard)) {
    const judged = await external({
      text: reply,
      attachments: [],
      model: fallbackAnswered ? "fallback" : "primary",
      toolCalls: turnToolCalls(
        result.messages,
        loaded.guardrails.external.sendToolValues,
      ),
    });
    reply = screenedText(judged, reply) ?? "";
  }
  return { threadId, status: "done", reply };
}
