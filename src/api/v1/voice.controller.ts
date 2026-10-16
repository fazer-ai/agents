import { Elysia, t } from "elysia";
import logger from "@/api/lib/logger";
import { doc } from "@/api/lib/openapi";
import { CONVERSATION_NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import type { TenantContext } from "@/lib/tenancy";
import { loadPlaygroundVoiceAgent } from "@/modules/playground/service";
import { CallBridge } from "@/modules/voice-call/bridge";
import { readPlaygroundCallTicket } from "@/modules/voice-call/playground";
import { elevenLabsProvider } from "@/modules/voice-call/providers/elevenlabs";
import { elevenLabsCallSummary } from "@/modules/voice-call/providers/elevenlabs-agent";
import type { VoiceProvider } from "@/modules/voice-call/providers/types";
import {
  type CallContext,
  conversationHistory,
  fenceConversation,
  reportCall,
  resolveVoiceRoute,
  voiceSessionConfig,
} from "@/modules/voice-call/service";
import { type CallsSetup, setUpAgentCalls } from "@/modules/voice-call/setup";
import { loadVoiceAgent } from "@/modules/voice-call/tools";

const PLAYGROUND_SIMULATED_TOOLS: ReadonlySet<string> = new Set(
  CONVERSATION_NATIVE_TOOL_NAMES,
);

// Public, JWT-less media stream of a WhatsApp call, dialled by the whatsapp-connector when Chatwoot
// hands it a call this agent takes. The Agent Bot's opaque route token resolves tenant, instance and
// agent, as on the webhook; the query carries the thread the call belongs to.
const bridges = new Map<string, CallBridge>();

function intOrNull(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The agent's calls settings (key, voice, the agent on ElevenLabs) are resolved while the call is
// configured; the engine opens on them right after.
function callsProvider(setup: () => CallsSetup | null): VoiceProvider {
  return {
    name: "elevenlabs",
    open: (config, handlers) => {
      const s = setup();
      if (!s) throw new Error("calls are not set up for this agent");
      return elevenLabsProvider({
        apiKey: s.apiKey,
        agentId: s.elevenLabsAgentId,
        toolSound: s.calls.toolSound,
      }).open(config, handlers);
    },
  };
}

function callsUnavailable(result: { problem: string; detail?: string }) {
  return new Error(
    `calls not available for this agent: ${result.problem}${result.detail ? ` (${result.detail})` : ""}`,
  );
}

function logCall(message: string, fields?: Record<string, unknown>) {
  logger.info("voice-call: %s %s", message, JSON.stringify(fields ?? {}));
}

function relayMessage(ws: { id: string | number }, message: unknown) {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  bridges.get(String(ws.id))?.onMessage(text);
}

function relayClose(ws: { id: string | number }) {
  bridges.get(String(ws.id))?.onClose();
  bridges.delete(String(ws.id));
}

export const voiceController = new Elysia({
  prefix: "/v1/voice",
  tags: ["Channels"],
})
  .ws("/stream/:routeToken", {
    detail: doc(
      "WhatsApp call media stream",
      "The voice of a WhatsApp call a voice agent carries. The Chatwoot fork hands the call to this URL, carrying the inbox's voice route token (set by binding a voice agent to the inbox); the connector streams the audio. The query names the conversation the call belongs to.",
    ),
    params: t.Object({ routeToken: t.String() }),
    query: t.Object({
      conversation_id: t.Optional(t.String()),
      inbox_id: t.Optional(t.String()),
      direction: t.Optional(t.String()),
      account_id: t.Optional(t.String()),
      call_id: t.Optional(t.String()),
    }),
    open(ws) {
      const id = String(ws.id);
      const route = resolveVoiceRoute(ws.data.params.routeToken);
      void route.then(
        (resolved) => {
          if (!resolved) ws.close();
        },
        () => ws.close(),
      );
      // The inbox is the token's, never the query's; the conversation is the query's only once fenced
      // to that inbox, so a call that ends before the fence reports to none.
      const requested = intOrNull(ws.data.query.conversation_id);
      const ctx: CallContext = {
        conversationId: null,
        inboxId: null,
        direction:
          ws.data.query.direction === "outbound" ? "outbound" : "inbound",
      };
      let setup: CallsSetup | null = null;
      const provider = callsProvider(() => setup);
      const bridge = new CallBridge(
        { send: (text) => ws.send(text), close: () => ws.close() },
        {
          provider,
          configure: async (start) => {
            const resolved = await route;
            if (!resolved) throw new Error("unknown route token");
            ctx.inboxId = resolved.inboxId;
            ctx.conversationId = await fenceConversation(resolved, requested);
            const [history, agent, calls] = await Promise.all([
              conversationHistory(resolved, ctx.conversationId),
              loadVoiceAgent(resolved, ctx.conversationId),
              setUpAgentCalls(
                {
                  tenantId: resolved.tenantId,
                  userId: null,
                  role: "TENANT_ADMIN",
                  actorType: "system",
                },
                resolved.agentId,
              ),
            ]);
            if (!calls.ok) throw callsUnavailable(calls);
            setup = calls.setup;
            return {
              ...voiceSessionConfig(
                { ...resolved, systemPrompt: agent.systemPrompt },
                { ...ctx, direction: start.direction },
                calls.setup.voice,
                history,
                calls.setup.calls.openingDelayMs,
              ),
              tools: agent.tools,
            };
          },
          log: logCall,
          onFinished: (record) => {
            bridges.delete(id);
            void route.then(async (resolved) => {
              if (!resolved) return;
              await reportCall(resolved, ctx, record, {
                summarize: async (done) =>
                  setup && done.engineConversationId
                    ? elevenLabsCallSummary(
                        setup.apiKey,
                        done.engineConversationId,
                      )
                    : null,
              });
            });
          },
        },
      );
      bridges.set(id, bridge);
    },
    message: relayMessage,
    close: relayClose,
  })
  .ws("/playground/:ticket", {
    detail: doc(
      "Playground call media stream",
      "The voice of a call from the playground: the operator's microphone in place of the WhatsApp line, in the same frames the connector sends, plus `transcript` frames with each line as it is heard and `tool` frames with each tool the agent ran (`simulated` for the conversation tools, which never reach Chatwoot from here). Opened with the ticket `POST /api/v1/agents/{id}/playground/call` returns.",
    ),
    params: t.Object({ ticket: t.String() }),
    open(ws) {
      const id = String(ws.id);
      const claims = readPlaygroundCallTicket(ws.data.params.ticket);
      if (!claims) {
        ws.close();
        return;
      }
      const ctx: TenantContext = {
        tenantId: claims.tenantId,
        userId: claims.userId,
        role: "TENANT_ADMIN",
      };
      let setup: CallsSetup | null = null;
      const bridge = new CallBridge(
        { send: (text) => ws.send(text), close: () => ws.close() },
        {
          provider: callsProvider(() => setup),
          configure: async (start) => {
            const [calls, agent] = await Promise.all([
              setUpAgentCalls(ctx, claims.agentId),
              loadPlaygroundVoiceAgent(ctx, claims.agentId),
            ]);
            if (!calls.ok) throw callsUnavailable(calls);
            setup = calls.setup;
            return {
              ...voiceSessionConfig(
                {
                  tenantId: claims.tenantId,
                  instanceId: 0n,
                  inboxId: null,
                  agentId: claims.agentId,
                  agentName: "",
                  systemPrompt: agent.systemPrompt,
                },
                {
                  conversationId: null,
                  inboxId: null,
                  direction: start.direction,
                },
                calls.setup.voice,
                "",
                calls.setup.calls.openingDelayMs,
              ),
              tools: agent.tools,
            };
          },
          log: logCall,
          onReady: () => ws.send(JSON.stringify({ event: "ready" })),
          onTranscript: (entry) =>
            ws.send(
              JSON.stringify({
                event: "transcript",
                role: entry.role,
                text: entry.text,
              }),
            ),
          // The conversation tools never touch Chatwoot from the playground: the screen says so.
          onTool: (name, ok) =>
            ws.send(
              JSON.stringify({
                event: "tool",
                name,
                ok,
                simulated: PLAYGROUND_SIMULATED_TOOLS.has(name),
              }),
            ),
          onFinished: () => bridges.delete(id),
        },
      );
      bridges.set(id, bridge);
    },
    message: relayMessage,
    close: relayClose,
  });
