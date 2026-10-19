// The agent's own toolset on a call: the same `loadAgentConfig` + `buildToolset` a text turn runs,
// for the call's conversation, minus what makes no sense while talking (sending files, replying in
// text, closing the conversation under the call) or must not happen without a person confirming
// (creating a charge, sending an email). The client is muted: a slow tool's "um momento" text and
// the typing indicator would otherwise reach the contact on WhatsApp in the middle of the call.

import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { chatwootThreadId } from "@/graph/checkpointer";
import { buildToolset, loadAgentConfig } from "@/graph/prepare";
import { buildMcpContextSection } from "@/graph/tools/mcp";
import { buildNativeTools } from "@/graph/tools/native";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { createChatwootClient } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { isVoiceDeniedTool } from "./denied-tools";
import {
  invocationDeadlineFetch,
  withinInvocation,
} from "./invocation-deadline";
import {
  CALL_HTTP_TOOL_TIMEOUT_MS,
  fromElevenLabsToolArgs,
} from "./providers/elevenlabs-tools";
import type { VoiceTool } from "./providers/types";
import type { VoiceRoute } from "./service";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN", actorType: "system" };
}

/** The tools a call may use, out of an agent's text toolset, in the shape the voice engine declares. */
/**
 * What a call is given: the tools it may use and the prompt that explains them. An MCP tool carries
 * its server's scope and instructions, which a text turn appends in `buildModelAndGraph`; a call never
 * builds the graph, so the same block is appended here, over the tools the call keeps.
 */
export function voiceAgentFrom(
  systemPrompt: string,
  all: StructuredToolInterface[],
): VoiceAgent {
  const kept = all.filter((tool) => !isVoiceDeniedTool(tool.name));
  const mcpContext = buildMcpContextSection(kept);
  return {
    systemPrompt: mcpContext
      ? `${systemPrompt}\n\n${mcpContext}`
      : systemPrompt,
    tools: toVoiceTools(kept),
  };
}

export function toVoiceTools(all: StructuredToolInterface[]): VoiceTool[] {
  return all
    .filter((tool) => !isVoiceDeniedTool(tool.name))
    .map((tool) => {
      const fn = convertToOpenAITool(tool).function;
      return {
        name: fn.name,
        description: fn.description ?? "",
        parameters: structuredClone(
          (fn.parameters ?? { type: "object", properties: {} }) as Record<
            string,
            unknown
          >,
        ),
        invoke: async (args, callId, signal) => {
          const out = await withinInvocation(signal, () =>
            tool.invoke(
              {
                type: "tool_call",
                id: callId,
                name: tool.name,
                args: fromElevenLabsToolArgs(
                  (fn.parameters ?? {}) as Record<string, unknown>,
                  args,
                ),
              } as never,
              signal ? { signal } : undefined,
            ),
          );
          const content = (out as { content?: unknown })?.content ?? out;
          const text =
            typeof content === "string" ? content : JSON.stringify(content);
          // A tool that failed without throwing answers a ToolMessage marked as an error: the call
          // reports it as one, on the engine and to the caller.
          if ((out as { status?: unknown })?.status === "error")
            throw new Error(text);
          return text;
        },
      };
    });
}

export interface VoiceAgent {
  systemPrompt: string;
  tools: VoiceTool[];
}

/** The agent as a text turn on this conversation would see it: rendered prompt and usable tools. */
export async function loadVoiceAgent(
  route: VoiceRoute,
  conversationId: number | null,
  base: PrismaClient = basePrisma,
): Promise<VoiceAgent> {
  const fallback = { systemPrompt: route.systemPrompt, tools: [] };
  if (!conversationId) return fallback;
  try {
    const threadId = chatwootThreadId(
      route.tenantId,
      route.instanceId,
      conversationId,
    );
    const cfg = await runScopedOn(base, sysCtx(route.tenantId), (db) =>
      loadAgentConfig(
        db,
        {
          tenantId: route.tenantId,
          instanceId: route.instanceId,
          conversationId,
          agentId: route.agentId,
          threadId,
          lastIncomingAt: "now",
        },
        // The call talks through the voice engine: the agent's chat model is never built here.
        { chatModelUnused: true },
      ),
    );
    if (!cfg) return fallback;
    const client = await loadChatwootClient(route.tenantId, route.instanceId, {
      base,
      botToken: cfg.agentBotToken ?? "",
      makeClient: (config) =>
        createChatwootClient(config, { fetchImpl: invocationDeadlineFetch() }),
    });
    const all = await buildToolset(
      { ...cfg, documentSelections: [] },
      {
        tenantId: route.tenantId,
        instanceId: route.instanceId,
        base,
        client,
        conversationId,
        threadId,
        onCall: true,
        httpToolTimeoutMs: CALL_HTTP_TOOL_TIMEOUT_MS,
        outboundFetch: invocationDeadlineFetch(),
      },
      { buildNativeTools },
    );
    const agent = voiceAgentFrom(cfg.systemPrompt, all);
    logger.info(
      "voice-call: %d tools for the call: %s",
      agent.tools.length,
      agent.tools.map((t) => t.name).join(", "),
    );
    return agent;
  } catch (err) {
    logger.warn(
      "voice-call: could not load the agent's tools: %s",
      (err as Error).message,
    );
    return fallback;
  }
}
