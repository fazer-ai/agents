/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type {
  AgentActivityEvent,
  AgentConfigEvent,
  ConversationEvent,
  KnowledgeDocumentEvent,
} from "@/api/features/realtime/realtime.service";
import { AuthProvider } from "@/client/contexts/AuthContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import {
  type UseTenantEventsOptions,
  useTenantEvents,
} from "@/client/hooks/useTenantEvents";
import {
  installFakeWebSocket,
  openSocket,
  restoreWebSocket,
} from "../utils/fake-websocket";

// ── UM CAMPO NOVO NO EVENTO PRECISA CHEGAR NA PONTA, E O TYPESCRIPT NÃO COBRA ISSO ──
// `useTenantEvents` remonta cada evento campo a campo antes de entregá-lo ao consumidor. Todo campo
// OPCIONAL acrescentado ao evento do servidor e esquecido nessa remontagem some em silêncio: o tipo
// do cliente declara o campo, a página o lê, o compilador aprova, e o valor nunca sai do hook.
//
// Perguntado ao hook rodando: cada evento do servidor, com TODOS os campos que o tipo dele declara
// (`Required<…>`, então um campo novo no servidor não compila aqui até entrar no evento), passa
// pelo socket, e o consumidor recebe todos eles menos o envelope.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  restoreWebSocket();
  // NOTE: the signed-in tenant is remembered in storage, and a later file's page would open a real
  // socket for it.
  sessionStorage.clear();
  localStorage.clear();
});

function Listener(props: UseTenantEventsOptions) {
  useTenantEvents(props);
  return null;
}

// O hook montado para um operador com tenant, e o que cada consumidor recebeu.
async function listen() {
  installFakeWebSocket();
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        user: {
          id: "9",
          email: "op@example.com",
          role: "ADMIN",
          tenantId: "t1",
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
  const got: Record<string, unknown[]> = {
    conversation: [],
    activity: [],
    document: [],
    config: [],
  };
  render(
    <ThemeProvider>
      <AuthProvider>
        <Listener
          onConversation={(e) => got.conversation?.push(e)}
          onAgentActivity={(e) => got.activity?.push(e)}
          onKnowledgeDocument={(e) => got.document?.push(e)}
          onAgentConfig={(e) => got.config?.push(e)}
        />
      </AuthProvider>
    </ThemeProvider>,
  );
  const socket = await waitFor(openSocket);
  return { socket, got };
}

const ENVELOPE = { at: 1_760_000_000_000, tenantId: "t1" };
const withoutEnvelope = (e: Record<string, unknown>) => {
  const { type: _t, at: _a, tenantId: _id, ...rest } = e;
  return rest;
};

const EVENTS = {
  conversation: {
    type: "conversation",
    ...ENVELOPE,
    conversationId: "77",
    status: "open",
    assigneeId: 5,
    assigneeType: "User",
    lastEventAt: "2026-10-10T12:00:00.000Z",
  } satisfies Required<ConversationEvent>,
  activity: {
    type: "agent-activity",
    ...ENVELOPE,
    conversationId: "77",
    phase: "step",
    stage: "tool",
    tool: "skip_reply",
    runAt: "2026-10-10T12:00:10.000Z",
    balloons: 2,
    delivered: true,
  } satisfies Required<AgentActivityEvent>,
  document: {
    type: "knowledge-document",
    ...ENVELOPE,
    knowledgeBaseId: "kb1",
    documentId: "d1",
    status: "FAILED",
    chunkCount: 12,
    error: "arquivo vazio",
  } satisfies Required<KnowledgeDocumentEvent>,
  config: {
    type: "agent-config",
    ...ENVELOPE,
    agentId: "41",
    updatedAt: "2026-10-10T12:00:00.000Z",
  } satisfies Required<AgentConfigEvent>,
};

describe("o evento do canal chega inteiro na ponta", () => {
  for (const [kind, event] of Object.entries(EVENTS)) {
    test(`${event.type}: o consumidor recebe todo campo que o servidor manda`, async () => {
      const { socket, got } = await listen();
      socket.deliver(event);
      await waitFor(() => expect(got[kind]?.length).toBe(1));
      // NOTE: through JSON because the transport revives ISO strings as `Date`s.
      expect(JSON.parse(JSON.stringify(got[kind]?.[0]))).toEqual(
        withoutEnvelope(event),
      );
    });
  }
});
