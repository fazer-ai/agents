import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { seedChatwootInstance } from "./chatwoot";

// What a re-engage test stands on: one tenant with a Chatwoot instance, an agent behind an Agent Bot
// and the inbox it answers, plus a Chatwoot stub and the page shape it serves.

export const REPLY = "Desculpe a demora, já te ajudo!";
export const fakeModel = () => new FakeListChatModel({ responses: [REPLY] });

export interface ReengageWorld {
  tenantId: bigint;
  instanceId: bigint;
  inboxDbId: bigint;
  agentId: bigint;
}

export function reengageCtx(world: ReengageWorld): TenantContext {
  return { tenantId: world.tenantId, userId: null, role: "TENANT_ADMIN" };
}

// `pages` serves a DIFFERENT thread per `getMessages` call, which is how a delivery landing between
// two reads of the same conversation is told. Without it the stub is a Chatwoot frozen in time, and
// every re-read in the code under test is answered by the state it already saw.
export function makeStub(opts: {
  page?: unknown;
  pages?: unknown[];
  // What the catch-up read (`?after=`) answers.
  after?: unknown;
  sent: Array<[number, string]>;
  // Roda a cada leitura de mensagens, que é o único momento em que o hold do botão e a marca do
  // turno podem ser distinguidos de fora: o coalesce lê ANTES de o turno se marcar.
  onGetMessages?: () => void;
  // A versão que pode ESPERAR, para uma barreira de largada sincronizar duas chamadas no mesmo
  // ponto. `onGetMessages` é síncrono de propósito (é sonda); esta serve para segurar.
  onGetMessagesAsync?: () => Promise<void>;
}) {
  let i = 0;
  const client = {
    getMessages: async (_conv: number, o?: { after?: number }) => {
      // NOTE: the catch-up read (`?after=`) is the fork's listing by id, a read of its own that
      // carries the reactions its default page leaves out. It answers from `after`, and does not
      // advance `pages`: that sequence is the default page as it moves under the code.
      if (o?.after != null) return opts.after ?? { payload: [] };
      opts.onGetMessages?.();
      if (opts.onGetMessagesAsync) await opts.onGetMessagesAsync();
      if (!opts.pages) return opts.page;
      const p = opts.pages[Math.min(i, opts.pages.length - 1)];
      i += 1;
      return p;
    },
    sendMessage: async (conversationId: number, content: string) => {
      opts.sent.push([conversationId, content]);
      return {};
    },
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
  return async () => client;
}

export function page(
  msgs: Array<{
    id: number;
    content: string;
    type?: number;
    private?: boolean;
    // Segundos desde a época, como o Chatwoot manda. Só os testes de idade passam este campo; a
    // ausência dele é o que todo o resto do arquivo exercita, e ela tem que continuar significando
    // "esta página não diz quando a mensagem chegou".
    createdAt?: number;
  }>,
) {
  return {
    payload: msgs.map((m) => ({
      id: m.id,
      content: m.content,
      message_type: m.type ?? 0,
      private: m.private ?? false,
      ...(m.createdAt === undefined ? {} : { created_at: m.createdAt }),
    })),
  };
}

export async function seedReengageWorld(
  su: PrismaClient,
  slug: string,
): Promise<ReengageWorld> {
  const t = await su.tenant.create({ data: { name: "RE", slug } });
  const tenantId = t.id;
  const inst = await seedChatwootInstance(su, {
    tenantId,
    accountId: 9,
    baseUrl: "https://chat.example.com",
    adminToken: encryptJson("ADMIN"),
  });
  const llmKey = await su.vaultEntry.create({
    data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
    select: { id: true },
  });
  const agent = await su.agent.create({
    data: {
      tenantId,
      name: "Atendente",
      systemPrompt: "Você é prestativa.",
      modelConfig: {
        provider: "openai",
        model: "gpt-4o-mini",
        credentialRef: `vault:${llmKey.id}`,
      },
    },
  });
  await su.chatwootAgentBot.create({
    data: {
      tenantId,
      chatwootInstanceId: inst.id,
      agentId: agent.id,
      chatwootAgentBotId: 9,
      accessToken: encryptJson("BOT"),
      webhookSecret: encryptJson("S"),
      webhookRouteTokenHash: `${slug}-route`,
      name: "Atendente",
    },
  });
  const inbox = await su.inbox.create({
    data: {
      tenantId,
      chatwootInstanceId: inst.id,
      chatwootInboxId: 7,
      name: "Suporte",
      agentId: agent.id,
    },
  });
  return {
    tenantId,
    instanceId: inst.id,
    inboxDbId: inbox.id,
    agentId: agent.id,
  };
}

export async function dropReengageWorld(su: PrismaClient, tenantId: bigint) {
  for (const table of [
    "audit_logs",
    "llm_usage",
    "conversations",
    "contacts",
    "inboxes",
    "agents",
    "vault_entries",
    "chatwoot_instances",
  ]) {
    await su.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
    );
  }
  await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
}

export async function seedReengageConversation(
  su: PrismaClient,
  world: ReengageWorld,
  convId: number,
  over: {
    assigneeType?: string | null;
    assigneeId?: number | null;
    lastError?: string | null;
    contactId?: bigint;
    lastHandledMessageId?: number;
    contactInboxId?: number;
  } = {},
): Promise<bigint> {
  const c = await su.conversation.create({
    data: {
      tenantId: world.tenantId,
      chatwootInstanceId: world.instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: over.assigneeType ?? null,
      assigneeId: over.assigneeId ?? null,
      inboxId: world.inboxDbId,
      ...(over.contactId ? { contactId: over.contactId } : {}),
      threadId: `${world.tenantId}:${world.instanceId}:${convId}`,
      lastEventAt: new Date(),
      lastError: over.lastError ?? null,
      lastErrorAt: over.lastError ? new Date() : null,
      lastHandledMessageId: over.lastHandledMessageId ?? null,
      ...(over.contactInboxId !== undefined
        ? { contactInboxId: over.contactInboxId }
        : {}),
    },
  });
  return c.id;
}
