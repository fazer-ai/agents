import { Elysia, t } from "elysia";
import logger from "@/api/lib/logger";
import { doc } from "@/api/lib/openapi";
import { CONVERSATION_NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { beginWork } from "@/lib/shutdown";
import type { TenantContext } from "@/lib/tenancy";
import { loadPlaygroundVoiceAgent } from "@/modules/playground/service";
import { CallBridge, type CallRecord } from "@/modules/voice-call/bridge";
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

/**
 * The engine's summary of a call that ended, given up as soon as `cut` aborts: a shutdown at its bound
 * leaves less time than the summary takes, and the transcript and note are written after it.
 */
export async function callSummary(
  setup: CallsSetup | null,
  done: CallRecord,
  cut: AbortSignal,
  fetchSummary = elevenLabsCallSummary,
): Promise<string | null> {
  if (cut.aborted || !setup || !done.engineConversationId) return null;
  const given = new Promise<null>((resolve) =>
    cut.addEventListener("abort", () => resolve(null), { once: true }),
  );
  return Promise.race([
    fetchSummary(setup.apiKey, done.engineConversationId),
    given,
  ]);
}

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
      // A live call is work a shutdown waits for, up to its bound; past it the call is hung up.
      let endWork = () => {};
      const provider = callsProvider(() => setup);
      const bridge = new CallBridge(
        { send: (text) => ws.send(text), close: () => ws.close() },
        {
          provider,
          configure: async (start) => {
            const opened = await route;
            if (!opened) throw new Error("unknown route token");
            // Read again: an outbound call is configured once answered, and while it rang the agent
            // may have been disabled, switched to test mode or unbound, or its account disconnected.
            const resolved = await resolveVoiceRoute(ws.data.params.routeToken);
            if (!resolved || resolved.agentId !== opened.agentId)
              throw new Error(
                "the voice route changed before the call started",
              );
            ctx.inboxId = resolved.inboxId;
            // The start frame may name the direction the query left out; the report reads it too.
            if (start.direction === "outbound") ctx.direction = "outbound";
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
                ctx,
                calls.setup.voice,
                history,
                calls.setup.calls.openingDelayMs,
              ),
              tools: agent.tools,
            };
          },
          log: logCall,
          direction: ctx.direction,
          onFinished: (record) => {
            bridges.delete(id);
            // Work a shutdown waits for: the report is not retried, and a deploy landing on a call
            // that just ended would lose its transcript and note for good. Cut at the drain's bound
            // (or at once, for a call the shutdown hung up), it gives up the engine's summary and
            // writes the rest.
            const summaryCut = new AbortController();
            const endReport = beginWork("voice-call-report", () =>
              summaryCut.abort(),
            );
            void route
              .then(async (resolved) => {
                if (!resolved) return;
                await reportCall(resolved, ctx, record, {
                  summarize: (done) =>
                    callSummary(setup, done, summaryCut.signal),
                });
              })
              .catch((err: Error) => {
                // Detached from the call: a failure here must not take the server down with it.
                logger.warn(
                  "voice-call: the call could not be reported: %s",
                  err.message,
                );
              })
              .finally(endReport);
            // After the report is registered, so the drain never sees the call's work at zero.
            endWork();
          },
        },
      );
      bridges.set(id, bridge);
      endWork = beginWork("voice-call", () => bridge.hangup("shutdown"));
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
