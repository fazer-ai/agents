// A TEST OF A DECISIONS AGENT ON ONE CONVERSATION, from the conversation page (docs/decisions.md,
// "Testing an agent on a conversation"): the agent's SAVED questions and rules run once, as a tick
// would, and nothing acts. The same evidence a tick reads (`readObserveEvidence`), its classifier and
// key, and `applyDecisions` under `dryRun` with the conversation's trigger state read and not
// claimed. The result is the shape the page already draws a tick with, so a test reads like one.

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { loadAgentConfig } from "@/graph/prepare";
import { recordDirectUsage } from "@/graph/usage";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readLimitsConfig } from "@/modules/agents/limits";
import { isMonitoring } from "@/modules/agents/mode";
import { getAgent } from "@/modules/agents/service";
import { readProtectedLabels } from "@/modules/agents/tool-guidance";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  currentBlockOf,
  type DecisionTick,
  decisionTickOf,
} from "@/modules/conversations/decision-trail";
import { readDebugModes } from "@/modules/flowlog/debug-mode";
import type { FlowContext } from "@/modules/flowlog/service";
import {
  attributeFillsOf,
  fillContextOf,
  observeDecisionInput,
  readObserveEvidence,
} from "@/modules/observe/job";
import { readMonitoringConfig } from "@/modules/observe/settings";
import { assertPlaygroundSpendCeiling } from "@/modules/spend-ceiling/service";
import { tryResolveApiKeyEntry } from "@/modules/vault/service";
import { decisionsFingerprint, readDecisionsConfig } from "./config";
import { answersForLog, applyDecisions, askProvider } from "./run";
import { readLatchedRules } from "./trigger-state";

// How long a test waits for the classifier, the same order as a tick's budget for one call.
const TRY_TIMEOUT_MS = 60_000;

export interface DecisionsTryDeps {
  // The fetch the classifier is reached with. Production never passes it.
  decisionFetch?: typeof fetch;
  makeClient?: LoadChatwootClientDeps["makeClient"];
}

export async function tryDecisionsAgent(
  ctx: TenantContext,
  agentId: bigint,
  conversationId: bigint,
  deps: DecisionsTryDeps = {},
  base: PrismaClient = basePrisma,
): Promise<DecisionTick> {
  const tenantId = ctx.tenantId;
  if (tenantId === null) throw new TenantTargetRequiredError();
  const agent = await getAgent(ctx, agentId, base);
  const mon = readMonitoringConfig(agent.settings);
  if (!isMonitoring(agent.mode) || mon.engine !== "decisions") {
    throw new AppError(
      "Only an agent that observes with questions and rules can be tested on a conversation.",
      400,
      "errors.agentNotDecisionsObserver",
    );
  }
  const fills = attributeFillsOf(mon);
  const conv = await runScopedOn(base, ctx, (db) =>
    db.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        inboxId: true,
        chatwootInstanceId: true,
        chatwootConversationId: true,
        resetAtMessageId: true,
        resetClearedLabels: true,
        threadId: true,
        inbox: { select: { provider: true } },
        // What a rule's custom tool may fill an argument from, read only when a rule does, as the
        // tick reads it.
        customAttributes: fills.conversation,
        ...(fills.contact
          ? { contact: { select: { customAttributes: true } } }
          : {}),
      },
    }),
  );
  if (!conv) {
    throw new NotFoundError(
      "conversation not found",
      "errors.conversationNotFound",
    );
  }
  const line = (detail: Record<string, unknown>, status: string) =>
    decisionTickOf(
      {
        agentId,
        status,
        level: status === "skipped" ? "info" : "warn",
        provider: read.ok ? read.config.provider : null,
        model: read.ok ? read.config.model : null,
        detail: { engine: "decisions", ...detail },
      },
      currentBlockOf(agent.settings),
      readDebugModes(agent.settings, null).logToolValues,
    ) as DecisionTick;

  const read = readDecisionsConfig({ decisions: mon.decisions });
  if (!read.ok) {
    return line(
      { skipped: "decisions_config_invalid", problem: read.problem },
      "error",
    );
  }
  const config = read.config;
  const key = await runScopedOn(base, ctx, (db) =>
    tryResolveApiKeyEntry(db, config.credentialRef),
  );
  if (key.state !== "ok") {
    return line({ skipped: "decisions_credential_unresolved" }, "error");
  }

  const instanceId = conv.chatwootInstanceId;
  const bot = await loadAgentBot(tenantId, instanceId, agentId, base);
  const client = await loadChatwootClient(tenantId, instanceId, {
    base,
    botToken: bot?.accessToken,
    makeClient: deps.makeClient,
    mute: true,
  });
  const evidence = await readObserveEvidence({
    tenantId,
    instanceId,
    conversationId: conv.chatwootConversationId,
    client,
    base,
    windowMessages: mon.window.messages,
    conv,
    protectedLabels: readProtectedLabels(agent.settings),
  });
  if (!evidence.customer) {
    return line(
      {
        skipped: "no_customer_message",
        messagesRead: evidence.transcript.length,
      },
      "skipped",
    );
  }

  // A test is the operator trying the agent, so it is billed and gated as the playground is, never
  // against the inbox's ceiling, which would let testing silence the agent for customers.
  const flow: FlowContext = {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "playground",
    agentId,
    base,
  };
  await assertPlaygroundSpendCeiling({ tenantId, base, flow });
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof askProvider>>;
  try {
    result = await askProvider(config, {
      input: observeDecisionInput(evidence),
      apiKey: key.secret,
      baseURL: key.baseUrl ?? null,
      ...(deps.decisionFetch ? { fetchImpl: deps.decisionFetch } : {}),
      signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
    });
  } catch {
    return line(
      {
        failed: "decision_call",
        failure: "provider_error",
        messagesRead: evidence.transcript.length,
      },
      "error",
    );
  }
  await recordDirectUsage(flow, {
    provider: config.provider,
    model: config.model,
    node: "decision",
    promptTokens: result.inputTokens,
    completionTokens: 0,
    durationMs: Date.now() - startedAt,
  });

  // The values a rule fills its tool's arguments from, built as the tick builds them: without them a
  // filled argument is dropped, and two rules that differ only by what they fill would read as one.
  const cfg = await runScopedOn(base, ctx, (db) =>
    loadAgentConfig(
      db,
      {
        tenantId,
        instanceId,
        conversationId: conv.chatwootConversationId,
        agentId,
        threadId: conv.threadId,
      },
      {
        ignoreDisabled: true,
        ignoreMode: true,
        skipExperiment: true,
        chatModelUnused: true,
      },
    ),
  );
  const logValues = readDebugModes(agent.settings, null).logToolValues;
  const latched = await readLatchedRules(base, {
    tenantId,
    agentId,
    conversationId: conv.id,
  });
  // A dry run checks only that a tool by the action's name is there: the editor already says on a
  // rule's card when its tool is not granted, and building the agent's toolset would reach its MCP
  // servers for a test that calls none of them.
  const named = config.rules.map(
    (r) => ({ name: r.action.tool }) as unknown as StructuredToolInterface,
  );
  const report = await applyDecisions(
    config,
    result.answers,
    named,
    [],
    AbortSignal.timeout(TRY_TIMEOUT_MS),
    async () => true,
    readLimitsConfig(agent.settings).maxToolCalls,
    () => null,
    true,
    latched,
    {},
    async () => true,
    {
      context: fillContextOf(
        cfg?.httpToolContext ?? { agent_name: agent.name },
        conv,
        conv.chatwootConversationId,
        client,
      ),
      questions: config.questions,
      logValues,
    },
  );
  return line(
    {
      block: decisionsFingerprint(config),
      modelVersion: result.modelVersion,
      answers: answersForLog(result.answers),
      actions: report.actions,
      notFired: report.missed,
      held: report.held,
      messagesRead: evidence.transcript.length,
    },
    "ok",
  );
}
