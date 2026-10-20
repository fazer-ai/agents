// What every turn that runs outside a Chatwoot conversation shares (the playground, the client
// channel): loading the agent and assembling its toolset for that channel. Each caller builds its
// own graph on top, with whatever it adds (the playground's mocks, the client channel's host tools).
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  type AgentConfig,
  type AgentConfigOverrides,
  buildToolset,
  loadAgentConfig,
} from "@/graph/prepare";
import type { NativeHandlers } from "@/graph/tools/channel-natives";
import type { McpLoadDeps } from "@/graph/tools/mcp";
import { buildChannelNativeTools, type ToolCtx } from "@/graph/tools/native";
import type { ReplyChoice } from "@/graph/tools/reply-as-text";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { FlowContext } from "@/modules/flowlog/service";

// Loads the agent config for a turn with no Chatwoot conversation behind it, ignoring the `enabled`
// toggle, which gates production auto-replies only. instance/conversation ids are absent (dummy
// 0n/0, no mirror row), so contact/prompt vars come from `overrides.promptVars` when given. Throws the
// same not-runnable errors as the turn path (agent missing vs no model credential).
export async function loadDetachedConfig(params: {
  ctx: TenantContext;
  agentId: bigint;
  threadId: string;
  base: PrismaClient;
  overrides?: AgentConfigOverrides;
  // A call talks through the voice engine: the agent's chat model is never built for it.
  chatModelUnused?: boolean;
}): Promise<AgentConfig> {
  const { ctx, agentId, threadId, base } = params;
  const tenantId = ctx.tenantId as bigint;
  const loaded = await runScopedOn(base, ctx, (db) =>
    loadAgentConfig(
      db,
      {
        tenantId,
        instanceId: 0n,
        conversationId: 0,
        agentId,
        threadId,
        // NOTE: the operator just typed it, so the age is "now"; omitted, the variable renders
        // EMPTY. The literal rather than a `Date` so the time simulation moves it too (`prepare.ts`).
        lastIncomingAt: "now" as const,
      },
      {
        ignoreDisabled: true,
        overrides: params.overrides,
        chatModelUnused: params.chatModelUnused,
      },
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

// The toolset of a turn with no conversation: the natives as the channel's map says, a dummy client
// that satisfies the type (the natives that would call it are simulated or not offered) and the
// real knowledge/HTTP/code/MCP/integration tools.
export function buildDetachedToolset(
  loaded: AgentConfig,
  params: {
    ctx: TenantContext;
    threadId: string;
    base: PrismaClient;
    mcp?: McpLoadDeps;
    // The turn's telemetry context, so a tool-stage line the toolset produces lands in the Logs page
    // under the turn's source. Without it a precondition refusal is invisible exactly where an
    // operator goes to find out what their agent does — a refused call never reaches the inner tool,
    // so ToolFlowLogger sees no run either and there is nothing else to read.
    flow: FlowContext | undefined;
    // Where `reply_as_text` records its choice. The turn passes the one its delivery
    // reads; the listing passes a throwaway, so the panel shows the tool the model is offered. Absent
    // on the simulated follow-up, which, like production's nudge, is never offered the tool.
    replyChoice: ReplyChoice | undefined;
    // How this channel runs each native.
    natives: NativeHandlers;
    documents: "simulated" | "omitted";
    // Where `open_case_in_inbox` opens a case from, on a channel whose map runs it `detached` (the
    // client channel). Null or absent ⇒ no case can be opened from here, and that tool is left out.
    caseOrigin?: NonNullable<ToolCtx["crossInboxCase"]>["detached"] | null;
    // The turn's output guardrail over a case's opening message, which reaches the user outside the
    // reply. Absent ⇒ not screened.
    screenCustomerText?: ToolCtx["screenCustomerText"];
    // The simulated follow-up, built like production's nudge (ToolCtx.proactive).
    proactive?: boolean;
    // A call's HTTP deadline, below what the voice engine waits (CALL_HTTP_TOOL_TIMEOUT_MS).
    httpToolTimeoutMs?: number;
    // A call's outbound fetch, which holds each request to its tool invocation's deadline.
    outboundFetch?: typeof fetch;
    // Built as an observation is: on a muted client, which drops what delivers to the customer
    // (those natives, documents, a pack's delivering tools) and gives the handoff its muted schema.
    muted?: boolean;
    // The account the build stands in, where 0n (no conversation) changes what a tool offers.
    instanceId?: bigint;
  },
): Promise<StructuredToolInterface[]> {
  return buildToolset(
    loaded,
    {
      tenantId: params.ctx.tenantId as bigint,
      instanceId: params.instanceId ?? 0n,
      base: params.base,
      client: (params.muted ? { muted: true } : {}) as ChatwootClient,
      conversationId: 0,
      threadId: params.threadId,
      replyChoice: params.replyChoice,
      screenCustomerText: params.screenCustomerText,
      ...(params.proactive ? { proactive: true } : {}),
      ...(params.httpToolTimeoutMs !== undefined
        ? { httpToolTimeoutMs: params.httpToolTimeoutMs }
        : {}),
      ...(params.outboundFetch ? { outboundFetch: params.outboundFetch } : {}),
    },
    {
      buildNativeTools: (ctx, allowed) =>
        buildChannelNativeTools(
          params.caseOrigin && ctx.crossInboxCase
            ? {
                ...ctx,
                crossInboxCase: {
                  ...ctx.crossInboxCase,
                  detached: params.caseOrigin,
                },
              }
            : ctx,
          allowed,
          params.natives,
        ),
      // NOTE: never "run": a document tool needs a conversation to attach the file to, and run here it
      // would refuse every call with the message meant for proactive nudges.
      documents: params.documents,
      mcp: params.mcp,
      flow: params.flow,
    },
  );
}
