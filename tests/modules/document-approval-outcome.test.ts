import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { buildThreadStateGraph } from "@/graph/thread-state";
import type { TenantContext } from "@/lib/tenancy";
import {
  approveDocumentRequest,
  expireDueApprovalRequests,
  issueOrRequestApproval,
  outcomeJobKey,
  rejectDocumentRequest,
} from "@/modules/documents/approval";
import { runApprovalOutcome } from "@/modules/documents/approval-outcome";
import { documentStarter } from "@/modules/documents/starters";
import { createDocumentTemplate } from "@/modules/documents/templates";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRow } from "../utils/flowlog";
import {
  HandoffThenReplyModel,
  ScriptedCaptureModel,
} from "../utils/scripted-models";

// What a decided or expired approval request says in its conversation (docs/documents.md, Approval):
// the PDF on the agent's message when approved, a note and a hand-over when rejected, a note and an
// alert when expired, and a note wherever the customer cannot be messaged.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;
const DIR = `/tmp/fazerai-doc-outcome-${process.pid}`;

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let inboxId = 0n;
let templateId = 0n;
let seq = 0;

const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const ARGS = {
  cliente: "Ana Ribeiro",
  itens: [{ description: "Consultoria", quantity: 2, unitPrice: 450 }],
  validade: "2026-12-05",
};

type Call = [string, ...unknown[]];

function recordingClient() {
  const calls: Call[] = [];
  const client = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (name === "then" || name === "muted") return undefined;
        return async (...args: unknown[]) => {
          calls.push([name, ...args]);
          if (name === "getConversationLabels" || name.startsWith("list"))
            return [];
          if (name === "getConversation") return { id: args[0], meta: {} };
          return { id: 90_000 + calls.length };
        };
      },
    },
  );
  return { calls, makeClient: async () => client as never };
}

const named = (calls: Call[], name: string) =>
  calls.filter((c) => c[0] === name);

function noModel(): never {
  throw new Error("this outcome must not reach the model");
}

async function conversationWithRequest(opts: {
  assigneeType?: string | null;
  lastInboundAt?: Date;
}) {
  seq += 1;
  const chatwootConversationId = 11_390 + seq;
  const conv = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId,
      chatwootConversationId,
      status: opts.assigneeType === "User" ? "open" : "pending",
      assigneeType: opts.assigneeType ?? null,
      assigneeId: opts.assigneeType === "User" ? 5 : null,
      threadId: `${tenantId}:${instanceId}:${chatwootConversationId}`,
      lastEventAt: new Date(),
      lastInboundAt: opts.lastInboundAt ?? new Date(Date.now() - 3_600_000),
    },
  });
  const out = await issueOrRequestApproval({
    ctx: ctx(),
    base: appDb,
    storageDir: DIR,
    templateId,
    idempotencyKey: `outcome-${seq}`,
    values: ARGS,
    threadId: conv.threadId,
    chatwootInstanceId: instanceId,
    conversationId: conv.id,
    now: new Date(),
  });
  if (out.kind !== "approval") throw new Error("expected a request");
  return {
    requestId: BigInt(out.request.id),
    chatwootConversationId,
    conversationId: conv.id,
  };
}

async function outcomeJobs(requestId: bigint) {
  return suDb.schedulerJob.findMany({
    where: {
      tenantId,
      kind: "DOCUMENT_APPROVAL_OUTCOME",
      dedupeKey: outcomeJobKey(requestId),
    },
    select: { status: true },
  });
}

describe.skipIf(!dbUp)("document approval outcomes", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DAO", slug: `dao-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const vault = await suDb.vaultEntry.create({
      data: { tenantId, name: "k", secret: encryptJson("sk") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id}`,
        },
        settings: { serviceWindow: { templateName: "reengage" } },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `dao-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId,
        channelType: "Channel::Whatsapp",
        provider: "whatsapp_cloud",
      },
    });
    inboxId = inbox.id;
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(),
      {
        name: "Orçamento",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        numberPrefix: "ORC-",
        requiresApproval: true,
      },
      appDb,
    );
    templateId = BigInt(tpl.id);
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "scheduler_jobs",
        "audit_logs",
        "document_approval_requests",
        "issued_documents",
        "document_templates",
        "agent_threads",
        "conversations",
        "chatwoot_agent_bots",
        "inboxes",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await rm(DIR, { recursive: true, force: true });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("approval sends the numbered PDF on the agent's message, and approving again sends nothing", async () => {
    const { requestId, chatwootConversationId } = await conversationWithRequest(
      {},
    );
    const { document } = await approveDocumentRequest({
      ctx: ctx(),
      requestId,
      base: appDb,
      storageDir: DIR,
    });
    expect(await outcomeJobs(requestId)).toHaveLength(1);
    const rec = recordingClient();
    const model = new ScriptedCaptureModel([
      { reply: "Seu orçamento foi aprovado e segue em anexo." },
    ]);
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      storageDir: DIR,
      nudgeDeps: {
        makeModel: () => model as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    });
    expect(outcome).toBe("delivered");
    const files = named(rec.calls, "sendFileAttachment");
    expect(files).toHaveLength(1);
    const [, conv, bytes, fileName, mime, opts] = files[0] as [
      string,
      number,
      ArrayBuffer,
      string,
      string,
      { caption?: string },
    ];
    expect(conv).toBe(chatwootConversationId);
    expect(mime).toBe("application/pdf");
    expect(fileName).toContain(document.number as string);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(opts.caption).toContain("aprovado");
    expect(named(rec.calls, "sendMessage")).toHaveLength(0);
    expect(named(rec.calls, "sendPrivateNote")).toHaveLength(0);
    expect(named(rec.calls, "sendTemplate")).toHaveLength(0);

    await suDb.schedulerJob.deleteMany({
      where: { tenantId, dedupeKey: outcomeJobKey(requestId) },
    });
    await Promise.all([
      approveDocumentRequest({
        ctx: ctx(),
        requestId,
        base: appDb,
        storageDir: DIR,
      }),
      approveDocumentRequest({
        ctx: ctx(),
        requestId,
        base: appDb,
        storageDir: DIR,
      }),
      approveDocumentRequest({
        ctx: ctx(),
        requestId,
        base: appDb,
        storageDir: DIR,
      }),
    ]);
    expect(await outcomeJobs(requestId)).toHaveLength(0);
  });

  test("an agent that writes nothing still sends the approved PDF, with the default caption", async () => {
    const { requestId } = await conversationWithRequest({});
    await approveDocumentRequest({
      ctx: ctx(),
      requestId,
      base: appDb,
      storageDir: DIR,
    });
    const rec = recordingClient();
    const model = new ScriptedCaptureModel([{ reply: "" }]);
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      storageDir: DIR,
      nudgeDeps: {
        makeModel: () => model as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    });
    expect(outcome).toBe("delivered");
    const files = named(rec.calls, "sendFileAttachment");
    expect(files).toHaveLength(1);
    expect(
      (files[0]?.[5] as { caption?: string } | undefined)?.caption,
    ).toContain("aprovado pela equipe");
  });

  test("a person taking the conversation while the agent writes gets the note, not the agent's text", async () => {
    const { requestId, chatwootConversationId } = await conversationWithRequest(
      {},
    );
    await approveDocumentRequest({
      ctx: ctx(),
      requestId,
      base: appDb,
      storageDir: DIR,
    });
    const takeOver = async () => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId },
        data: { assigneeType: "User", assigneeId: 5, status: "open" },
      });
      return new AIMessage("Texto do agente que ninguém deve receber.");
    };
    const model = {
      invoke: takeOver,
      bindTools: () => ({ invoke: takeOver }),
    };
    const rec = recordingClient();
    const checkpointer = new MemorySaver();
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      storageDir: DIR,
      nudgeDeps: {
        makeModel: () => model as unknown as BaseChatModel,
        checkpointer,
        persistUsage: async () => {},
      },
    });
    expect(outcome).toBe("noted");
    const notes = named(rec.calls, "sendPrivateNote");
    expect(notes).toHaveLength(1);
    expect(String(notes[0]?.[2])).toContain("Documento aprovado");
    expect(String(notes[0]?.[2])).not.toContain("Texto do agente");
    expect(named(rec.calls, "sendFileAttachment")).toHaveLength(0);
    const state = await buildThreadStateGraph(checkpointer).getState({
      configurable: {
        thread_id: `${tenantId}:${instanceId}:${chatwootConversationId}`,
      },
    });
    expect(JSON.stringify(state.values ?? {})).not.toContain("Texto do agente");
  });

  test("a document revoked while the agent writes is a note, never the PDF", async () => {
    const { requestId } = await conversationWithRequest({});
    const { document } = await approveDocumentRequest({
      ctx: ctx(),
      requestId,
      base: appDb,
      storageDir: DIR,
    });
    const revoke = async () => {
      await suDb.issuedDocument.update({
        where: { id: BigInt(document.id) },
        data: { revoked: true },
      });
      return new AIMessage("Seu orçamento segue em anexo.");
    };
    const model = { invoke: revoke, bindTools: () => ({ invoke: revoke }) };
    const rec = recordingClient();
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      storageDir: DIR,
      nudgeDeps: {
        makeModel: () => model as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    });
    expect(outcome).toBe("noted");
    expect(named(rec.calls, "sendFileAttachment")).toHaveLength(0);
    expect(named(rec.calls, "sendMessage")).toHaveLength(0);
    const notes = named(rec.calls, "sendPrivateNote");
    expect(notes).toHaveLength(1);
    expect(String(notes[0]?.[2])).toContain("não está disponível");
  });

  test("a transfer during the approval turn sends its line and leaves the document to the person", async () => {
    const { requestId } = await conversationWithRequest({});
    await approveDocumentRequest({
      ctx: ctx(),
      requestId,
      base: appDb,
      storageDir: DIR,
    });
    const rec = recordingClient();
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      storageDir: DIR,
      nudgeDeps: {
        makeModel: () =>
          new HandoffThenReplyModel(
            "Segue o orçamento.",
            "Vou te passar para a nossa equipe.",
          ) as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    });
    expect(outcome).toBe("noted");
    expect(named(rec.calls, "sendFileAttachment")).toHaveLength(0);
    const notes = named(rec.calls, "sendPrivateNote").map((c) => String(c[2]));
    expect(notes.some((n) => n.includes("Documento aprovado"))).toBe(true);
  });

  test("an aborted run writes nothing, and a run that wrote commits its outcome", async () => {
    const { requestId } = await conversationWithRequest({});
    await rejectDocumentRequest({ ctx: ctx(), requestId, base: appDb });
    const aborted = new AbortController();
    aborted.abort();
    let commits = 0;
    const rec = recordingClient();
    expect(
      await runApprovalOutcome(tenantId, requestId, appDb, {
        makeClient: rec.makeClient,
        nudgeDeps: { makeModel: noModel },
        signal: aborted.signal,
        commit: () => {
          commits++;
        },
      }),
    ).toBe("retry");
    expect(rec.calls.filter((c) => c[0] !== "getConversation")).toEqual([]);
    expect(commits).toBe(0);
    const live = recordingClient();
    expect(
      await runApprovalOutcome(tenantId, requestId, appDb, {
        makeClient: live.makeClient,
        nudgeDeps: { makeModel: noModel },
        commit: () => {
          commits++;
        },
      }),
    ).toBe("handed");
    expect(named(live.calls, "sendPrivateNote")).toHaveLength(1);
    expect(commits).toBe(1);
  });

  test("an approved document over a person is a note, with no model and no message", async () => {
    const { requestId } = await conversationWithRequest({
      assigneeType: "User",
    });
    await approveDocumentRequest({
      ctx: ctx(),
      requestId,
      base: appDb,
      storageDir: DIR,
    });
    const rec = recordingClient();
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      storageDir: DIR,
      nudgeDeps: { makeModel: noModel, checkpointer: new MemorySaver() },
    });
    expect(outcome).toBe("noted");
    const notes = named(rec.calls, "sendPrivateNote");
    expect(notes).toHaveLength(1);
    expect(String(notes[0]?.[2])).toContain("Documento aprovado");
    expect(String(notes[0]?.[2])).toContain("atendente");
    expect(named(rec.calls, "sendFileAttachment")).toHaveLength(0);
    expect(named(rec.calls, "sendMessage")).toHaveLength(0);
    expect(named(rec.calls, "toggleStatus")).toHaveLength(0);
    expect(named(rec.calls, "assignToAgent")).toHaveLength(0);
  });

  test("an approved document outside the 24h window is a note asking a person to send it, never a template", async () => {
    const { requestId } = await conversationWithRequest({
      lastInboundAt: new Date(Date.now() - 30 * 3_600_000),
    });
    await approveDocumentRequest({
      ctx: ctx(),
      requestId,
      base: appDb,
      storageDir: DIR,
    });
    const rec = recordingClient();
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      storageDir: DIR,
      nudgeDeps: { makeModel: noModel, checkpointer: new MemorySaver() },
    });
    expect(outcome).toBe("noted");
    const notes = named(rec.calls, "sendPrivateNote");
    expect(notes).toHaveLength(1);
    expect(String(notes[0]?.[2])).toContain("janela de 24h");
    expect(String(notes[0]?.[2])).toContain("enviado por uma pessoa");
    expect(named(rec.calls, "sendTemplate")).toHaveLength(0);
    expect(named(rec.calls, "sendFileAttachment")).toHaveLength(0);
    expect(named(rec.calls, "sendMessage")).toHaveLength(0);
  });

  test("a rejection sends nothing to the customer, notes the reviewer's words and hands the conversation over", async () => {
    const { requestId, chatwootConversationId } = await conversationWithRequest(
      {},
    );
    await rejectDocumentRequest({
      ctx: ctx(),
      requestId,
      note: "preço do item 2 errado, refazer",
      base: appDb,
    });
    expect(await outcomeJobs(requestId)).toHaveLength(1);
    const rec = recordingClient();
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      nudgeDeps: { makeModel: noModel },
    });
    expect(outcome).toBe("handed");
    const notes = named(rec.calls, "sendPrivateNote");
    expect(notes).toHaveLength(1);
    expect(String(notes[0]?.[2])).toContain("preço do item 2 errado, refazer");
    expect(named(rec.calls, "toggleStatus")).toEqual([
      ["toggleStatus", chatwootConversationId, "open"],
    ]);
    expect(named(rec.calls, "sendMessage")).toHaveLength(0);
    expect(named(rec.calls, "sendFileAttachment")).toHaveLength(0);
  });

  test("an expiry sends nothing to the customer, leaves one note and raises a warn line", async () => {
    const { requestId, conversationId } = await conversationWithRequest({});
    await suDb.documentApprovalRequest.update({
      where: { id: requestId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const expired = await expireDueApprovalRequests(
      tenantId,
      new Date(),
      appDb,
    );
    expect(expired).toContain(requestId);
    expect(await outcomeJobs(requestId)).toHaveLength(1);
    const rec = recordingClient();
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      nudgeDeps: { makeModel: noModel },
    });
    expect(outcome).toBe("noted");
    const notes = named(rec.calls, "sendPrivateNote");
    expect(notes).toHaveLength(1);
    expect(String(notes[0]?.[2])).toContain("venceu");
    expect(named(rec.calls, "sendMessage")).toHaveLength(0);
    const line = await flowLogRow(suDb, {
      where: {
        tenantId,
        conversationId,
        level: "warn",
        detail: { path: ["outcome"], equals: "document_approval_expired" },
      },
    });
    expect(line).not.toBeNull();

    await suDb.schedulerJob.deleteMany({
      where: { tenantId, dedupeKey: outcomeJobKey(requestId) },
    });
    await expireDueApprovalRequests(tenantId, new Date(), appDb);
    expect(await outcomeJobs(requestId)).toHaveLength(0);
  });

  test("an approved document whose PDF was revoked is a note, never a send", async () => {
    const { requestId } = await conversationWithRequest({});
    const { document } = await approveDocumentRequest({
      ctx: ctx(),
      requestId,
      base: appDb,
      storageDir: DIR,
    });
    await suDb.issuedDocument.update({
      where: { id: BigInt(String(document.id)) },
      data: { revoked: true },
    });
    const rec = recordingClient();
    const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
      makeClient: rec.makeClient,
      storageDir: DIR,
      nudgeDeps: { makeModel: noModel },
    });
    expect(outcome).toBe("noted");
    expect(String(named(rec.calls, "sendPrivateNote")[0]?.[2])).toContain(
      "não está disponível",
    );
    expect(named(rec.calls, "sendFileAttachment")).toHaveLength(0);
  });

  test("an agent that cannot speak leaves the approved document to a person", async () => {
    const { requestId } = await conversationWithRequest({});
    await approveDocumentRequest({
      ctx: ctx(),
      requestId,
      base: appDb,
      storageDir: DIR,
    });
    await suDb.agent.update({
      where: { id: agentId },
      data: { enabled: false },
    });
    try {
      const rec = recordingClient();
      const outcome = await runApprovalOutcome(tenantId, requestId, appDb, {
        makeClient: rec.makeClient,
        storageDir: DIR,
        nudgeDeps: { makeModel: noModel, checkpointer: new MemorySaver() },
      });
      expect(outcome).toBe("noted");
      expect(String(named(rec.calls, "sendPrivateNote")[0]?.[2])).toContain(
        "precisa ser enviado por uma pessoa",
      );
      expect(named(rec.calls, "sendFileAttachment")).toHaveLength(0);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: true },
      });
    }
  });
});
