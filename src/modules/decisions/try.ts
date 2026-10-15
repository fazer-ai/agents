// A TEST OF A DECISIONS AGENT ON ONE CONVERSATION, from the conversation page (docs/decisions.md,
// "Testing an agent on a conversation"): the agent's SAVED questions and rules run once, as a tick
// would, and nothing acts. The same evidence a tick reads (`readObserveEvidence`), its classifier and
// key, and `applyDecisions` under `dryRun` with the conversation's trigger state read and not
// claimed. The result is the shape the page already draws a tick with, so a test reads like one.

import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { buildToolset, loadAgentConfig } from "@/graph/prepare";
import type { McpLoadDeps } from "@/graph/tools/mcp";
import { applyLabelDelta, buildNativeTools } from "@/graph/tools/native";
import { preconditionStateLoader } from "@/graph/tools/precondition";
import { recordDirectUsage } from "@/graph/usage";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { providerFailure } from "@/lib/provider-failure";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readLimitsConfig } from "@/modules/agents/limits";
import { isMonitoring } from "@/modules/agents/mode";
import { getAgent } from "@/modules/agents/service";
import { readProtectedLabels } from "@/modules/agents/tool-guidance";
import {
  evaluatePrecondition,
  type PreconditionState,
  type ToolPrecondition,
} from "@/modules/agents/tool-preconditions";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import { underSignal } from "@/modules/contact-auth/check";
import { observerRuleVerdict } from "@/modules/contact-auth/observer";
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
import {
  type DecisionRule,
  decisionsFingerprint,
  readDecisionsConfig,
} from "./config";
import {
  type ActionReport,
  answersForLog,
  applyDecisions,
  askProvider,
} from "./run";
import { readLatchedRules } from "./trigger-state";

// How long a test waits for the classifier, the same order as a tick's budget for one call.
const TRY_TIMEOUT_MS = 60_000;

export interface DecisionsTryDeps {
  // The fetch the classifier is reached with. Production never passes it.
  decisionFetch?: typeof fetch;
  makeClient?: LoadChatwootClientDeps["makeClient"];
  mcp?: McpLoadDeps;
  // The test's deadline, shorter in tests. Production never passes it.
  timeoutMs?: number;
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
  // The agent's toolset, built as the tick builds it, so a test sees what the tick would: a rule
  // whose tool is not granted, and each tool's argument schema (a required argument left empty is
  // `missing_value`, which costs no call). Building it discovers the agent's MCP servers; nothing is
  // invoked, since the run below is a dry run, and no flow line is written for it. Built before the
  // paid call, so a toolset that cannot be built costs nothing, and under the test's deadline, which
  // is what bounds discovery: an SSE server that never sends its endpoint has no timeout of its own.
  if (!cfg) return line({ failed: "toolset_build" }, "error");
  let tools: Awaited<ReturnType<typeof buildToolset>>;
  try {
    const deadline = AbortSignal.timeout(deps.timeoutMs ?? TRY_TIMEOUT_MS);
    tools = await underSignal(
      buildToolset(
        { ...cfg, transferWithSummary: true },
        {
          tenantId,
          instanceId,
          base,
          client,
          conversationId: conv.chatwootConversationId,
          threadId: conv.threadId,
          expiresOn: deadline,
          ...(evidence.current === null
            ? {}
            : { conversationLabels: evidence.current }),
        },
        { buildNativeTools, mcp: deps.mcp },
      ),
      deadline,
    );
  } catch {
    return line({ failed: "toolset_build" }, "error");
  }

  // The contact gate's conditions, asked as the tick asks them before it spends anything: a
  // conversation the gate leaves out is never classified. Its endpoint is not asked (the tick does
  // not ask it either) and no line is written. A tick also asks the conditions again between
  // actions, of what the earlier ones wrote; a test does not.
  const ruled = await observerRuleVerdict(
    {
      tenantId,
      instanceId,
      conversationId: conv.chatwootConversationId,
      agentId,
      settings: agent.settings,
      base,
    },
    { emit: false },
  );
  if (ruled !== "allowed") {
    return line(
      ruled === "refused"
        ? { skipped: "contact_gate", messagesRead: evidence.transcript.length }
        : { failed: "contact_gate", messagesRead: evidence.transcript.length },
      ruled === "refused" ? "skipped" : "error",
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
  const callDeadline = AbortSignal.timeout(deps.timeoutMs ?? TRY_TIMEOUT_MS);
  try {
    result = await askProvider(config, {
      input: observeDecisionInput(evidence),
      apiKey: key.secret,
      baseURL: key.baseUrl ?? null,
      ...(deps.decisionFetch ? { fetchImpl: deps.decisionFetch } : {}),
      signal: callDeadline,
    });
  } catch (err) {
    return line(
      {
        failed: "decision_call",
        // The tick's closed vocabulary (`HTTP 401`, `timeout`, `provider error`): a test writes no
        // line, so this is the only place an operator tells a wrong key from a provider outage.
        failure: providerFailure(err, callDeadline.aborted),
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

  const report = await applyDecisions(
    config,
    result.answers,
    tools,
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
  const actions = await withFences(report.actions, config.rules, {
    preconditions: cfg.toolPreconditions,
    loadAttributes: preconditionStateLoader({
      base,
      tenantId,
      conversationDbId: cfg.conversationDbId ?? null,
      contactDbId: cfg.contactDbId ?? null,
    }),
    labels: evidence.current,
    protectedLabels: cfg.protectedLabels,
    hasContact: cfg.chatwootContactId !== null,
    loadContactLabels: async () => {
      const id = cfg.chatwootContactId;
      if (id === null) return null;
      return client.getContactLabels(id).catch(() => null);
    },
    allowed:
      cfg.allowedLabels.length > 0
        ? { labels: cfg.allowedLabels, mode: cfg.outsideAllowedLabels }
        : undefined,
  });

  return line(
    {
      block: decisionsFingerprint(config),
      modelVersion: result.modelVersion,
      answers: answersForLog(result.answers),
      actions,
      notFired: report.missed,
      held: report.held,
      messagesRead: evidence.transcript.length,
    },
    "ok",
  );
}

// The fences a tick asks INSIDE the tool, which a dry run never invokes, asked here in rule order of
// the same state: a tool's precondition (settings.toolPreconditions) of the mirrored attributes, and
// a conversation `set_labels`'s protected and allowed labels of the labels read for the evidence,
// through the handler's own `applyLabelDelta`. An action a fence refuses whole is `refused` with the
// fence; one it refuses in part stays `decided` with `fence` and `partial`, as a tick reports a
// partial write. What an earlier decided rule would write (an attribute, a label set) counts, with
// its rule's fixed arguments, since on a tick the later fence reads what the earlier rules wrote.
async function withFences(
  actions: ActionReport[],
  rules: readonly DecisionRule[],
  fences: {
    preconditions: Record<string, ToolPrecondition>;
    loadAttributes: () => Promise<PreconditionState>;
    labels: string[] | null;
    protectedLabels: string[];
    allowed: { labels: string[]; mode: "refuse" | "accept" } | undefined;
    // Whether the conversation has a contact linked to Chatwoot: without one a contact write has no
    // effect on a tick, so it is reported `no_effect` and its attribute is not counted as written.
    hasContact: boolean;
    // The contact's labels, read only when a rule writes them; null when unreadable.
    loadContactLabels: () => Promise<string[] | null>;
  },
): Promise<ActionReport[]> {
  const decided = actions.filter((a) => a.outcome === "decided");
  if (decided.length === 0) return actions;
  const needsAttributes = decided.some((a) =>
    Object.hasOwn(fences.preconditions, a.tool),
  );
  const loaded = needsAttributes
    ? await fences.loadAttributes()
    : { conversationAttributes: {}, contactAttributes: {} };
  // Null-prototype copies, so a key such as `__proto__` is written as the own property the mirror's
  // jsonb would hold, not through an inherited setter.
  const bagCopy = (b: Record<string, unknown>) =>
    Object.assign(Object.create(null) as Record<string, unknown>, b);
  const state: PreconditionState = {
    conversationAttributes: bagCopy(loaded.conversationAttributes),
    contactAttributes: bagCopy(loaded.contactAttributes),
  };
  let labels = fences.labels;
  let contactLabels =
    decided.some((a) => {
      const args = rules[a.rule]?.action.args;
      return a.tool === "set_labels" && args?.scope === "contact";
    }) && fences.hasContact
      ? await fences.loadContactLabels()
      : null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return actions.map((a): ActionReport => {
    if (a.outcome !== "decided") return a;
    const cond = Object.hasOwn(fences.preconditions, a.tool)
      ? fences.preconditions[a.tool]
      : undefined;
    if (cond && !evaluatePrecondition(cond, state)) {
      return { ...a, outcome: "refused", fence: "precondition" };
    }
    const args = rules[a.rule]?.action.args ?? {};
    const scope = args.scope ?? "conversation";
    if (
      scope === "contact" &&
      !fences.hasContact &&
      (a.tool === "set_custom_attribute" || a.tool === "set_labels")
    ) {
      return { ...a, outcome: "no_effect" };
    }
    if (
      a.tool === "set_custom_attribute" &&
      typeof args.key === "string" &&
      typeof args.value === "string" &&
      (scope === "conversation" || scope === "contact")
    ) {
      const bag =
        scope === "contact"
          ? state.contactAttributes
          : state.conversationAttributes;
      bag[args.key] = args.value;
    }
    if (
      a.tool === "set_labels" &&
      strings(args.add).every((l) => l.trim() === "") &&
      strings(args.remove).every((l) => l.trim() === "")
    ) {
      // Nothing to add or remove: the tool reports `no_effect` before any fence.
      return { ...a, outcome: "no_effect" };
    }
    if (a.tool === "set_labels") {
      // The fences hold on every scope. The conversation's labels were read for the evidence and the
      // contact's are read above; a card's are not. Which labels a fence refuses does not depend on
      // the current set, but whether the call still writes something does (a refused addition that
      // is not standing holds the removals), so where the set is unknown a refusal is told whole
      // only when nothing else was asked, and in part otherwise.
      const known =
        scope === "conversation"
          ? labels
          : scope === "contact"
            ? contactLabels
            : null;
      const o = applyLabelDelta(
        strings(args.add),
        strings(args.remove),
        known ?? [],
        fences.protectedLabels,
        fences.allowed,
      );
      if (scope === "conversation" && labels !== null) labels = o.next;
      if (scope === "contact" && contactLabels !== null) {
        contactLabels = o.next;
      }
      const fence =
        o.refusedAdd.length > 0 || o.refusedRemove.length > 0
          ? ("protected_label" as const)
          : (o.refusedOutside ?? []).length > 0
            ? ("allowed_labels" as const)
            : null;
      if (fence) {
        const refused = new Set([
          ...o.refusedAdd,
          ...o.refusedRemove,
          ...(o.refusedOutside ?? []),
        ]);
        const writes =
          known !== null
            ? o.added.length > 0 || o.removed.length > 0
            : [...strings(args.add), ...strings(args.remove)].some(
                (l) => !refused.has(l.trim()),
              );
        return writes
          ? { ...a, fence, partial: true }
          : { ...a, outcome: "refused", fence };
      }
    }
    return a;
  });
}
