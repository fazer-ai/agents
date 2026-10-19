import { Elysia, t } from "elysia";
import type { UserRole } from "@/../generated/prisma/client";
import { untrackSocket } from "@/api/features/realtime/realtime.service";
import { registerAndRecheck } from "@/api/features/realtime/socket-session";
import { authPlugin } from "@/api/lib/auth";
import logger from "@/api/lib/logger";
import { doc } from "@/api/lib/openapi";
import { originPlugin } from "@/api/lib/origin";
import { WS_CLOSE } from "@/api/lib/realtime";
import { CONVERSATION_NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { beginWork } from "@/lib/shutdown";
import { roleAtLeast, type TenantContext } from "@/lib/tenancy";
import { roleInTenant } from "@/lib/tenancy/membership";
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
    open: (config, handlers, signal) => {
      const s = setup();
      if (!s) throw new Error("calls are not set up for this agent");
      return elevenLabsProvider({
        apiKey: s.apiKey,
        agentId: s.providerAgentId,
        toolSound: s.calls.toolSound,
      }).open(config, handlers, signal);
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
}).ws("/stream/:routeToken", {
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
            throw new Error("the voice route changed before the call started");
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
});

// The operator's role in the tenant when it is an admin's (a tenant admin, or a super admin), else
// null: a demoted or removed operator keeps their session but not this tenant's tools.
function adminRoleIn(
  user: Parameters<typeof roleInTenant>[0],
  tenantId: bigint,
): UserRole | null {
  const role = roleInTenant(user, tenantId);
  return role && roleAtLeast(role, "TENANT_ADMIN") ? role : null;
}

// Playground sockets whose `open` is still re-checking the operator's session: a frame arriving
// meanwhile (the client sends `start` as soon as the socket opens) waits for the bridge instead of
// being dropped, and frames keep their order since they all wait on the same promise.
const playgroundReady = new Map<string, Promise<CallBridge | null>>();
// Playground sockets whose `open` has started and whose `close` has not run: one closed during the
// re-check gets no bridge, since no later close would end it.
const playgroundLive = new Set<string>();

// The playground's call runs the agent's real tools (HTTP, MCP, integrations) as the operator, so the
// socket is the operator's session, not just the ticket that opened it: the upgrade carries the
// session cookie, `open` registers the socket for revocation and re-reads the session, and a logout
// or a password change closes it (docs/realtime.md). The ticket still names the tenant and the agent,
// and must be this operator's own.
export const voicePlaygroundController = new Elysia({
  prefix: "/v1/voice",
  tags: ["Channels"],
})
  .use(authPlugin)
  .use(originPlugin)
  .resolve(async ({ getAuthUser }) => ({ user: await getAuthUser() }))
  .ws("/playground/:ticket", {
    detail: doc(
      "Playground call media stream",
      "The voice of a call from the playground: the operator's microphone in place of the WhatsApp line, in the same frames the connector sends, plus `transcript` frames with each line as it is heard and `tool` frames with each tool the agent ran (`simulated` for the conversation tools, which never reach Chatwoot from here). Opened with the ticket `POST /api/v1/agents/{id}/playground/call` returns, under the session that asked for it; a logout or a password change closes it.",
    ),
    params: t.Object({ ticket: t.String() }),
    requireAuth: true,
    requireAllowedOrigin: true,
    open(ws) {
      const id = String(ws.id);
      playgroundLive.add(id);
      playgroundReady.set(
        id,
        (async () => {
          const user = ws.data.user;
          const claims = readPlaygroundCallTicket(ws.data.params.ticket);
          if (!user || !claims || claims.userId !== user.id) {
            ws.close(WS_CLOSE.UNAUTHORIZED, "unauthorized");
            return null;
          }
          if (!(await registerAndRecheck(ws, user))) return null;
          if (!playgroundLive.has(id)) return null;
          // The ticket was issued to an admin of its tenant; the role is the session's now, not the
          // ticket's, and it is read again when the call starts (`configure`).
          const role = adminRoleIn(user, claims.tenantId);
          if (!role) {
            ws.close(WS_CLOSE.POLICY_VIOLATION, "forbidden tenant");
            return null;
          }
          const ctx: TenantContext = {
            tenantId: claims.tenantId,
            userId: claims.userId,
            role,
          };
          let setup: CallsSetup | null = null;
          // The role is the session's at each step that acts as the operator: the call's start and
          // every tool it runs. One taken away meanwhile closes the call instead of running the tool.
          const stillAdmin = async () => {
            const now = await ws.data.getAuthUser();
            return !!now && !!adminRoleIn(now, claims.tenantId);
          };
          const revoked = () =>
            new Error(
              "the operator is no longer an admin of the call's tenant",
            );
          const bridge = new CallBridge(
            { send: (text) => ws.send(text), close: () => ws.close() },
            {
              provider: callsProvider(() => setup),
              configure: async (start) => {
                if (!(await stillAdmin())) throw revoked();
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
                  tools: agent.tools.map((tool) => ({
                    ...tool,
                    invoke: async (args, callId, signal) => {
                      if (!(await stillAdmin())) {
                        ws.close(WS_CLOSE.POLICY_VIOLATION, "forbidden tenant");
                        throw revoked();
                      }
                      return tool.invoke(args, callId, signal);
                    },
                  })),
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
          return bridge;
        })(),
      );
    },
    message(ws, message) {
      const text =
        typeof message === "string" ? message : JSON.stringify(message);
      void playgroundReady
        .get(String(ws.id))
        ?.then((bridge) => bridge?.onMessage(text));
    },
    close(ws) {
      const id = String(ws.id);
      playgroundLive.delete(id);
      playgroundReady.delete(id);
      const user = ws.data.user;
      if (user) untrackSocket(user.id, id);
      relayClose(ws);
    },
  });
