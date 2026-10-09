import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { listConversations } from "@/modules/conversations/service";
import {
  countPendingApprovals,
  getApprovalRequest,
  issueOrRequestApproval,
  listApprovalRequests,
  listDecidedApprovals,
  listPendingApprovals,
  requestApprovalAgain,
} from "@/modules/documents/approval";
import { getApprovalContext } from "@/modules/documents/approval-context";
import { runApprovalOutcome } from "@/modules/documents/approval-outcome";
import type { DocumentSnapshot } from "@/modules/documents/issue";
import { documentStarter } from "@/modules/documents/starters";
import { createDocumentTemplate } from "@/modules/documents/templates";
import { alertLinks, buildAlertBody } from "@/modules/flowlog/alert-send";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";

// The team's side of a document approval (docs/documents.md, Approval): the alert a request raises,
// with the link to its page, what the page reads beside the preview, and asking an expired request
// again.

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
const DIR = `/tmp/fazerai-doc-page-${process.pid}`;

let tenantId = 0n;
let otherTenantId = 0n;
let instanceId = 0n;
let inboxId = 0n;
let contactId = 0n;
let templateId = 0n;
let channelId = 0n;
let seq = 0;

const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "AGENT",
});

const ARGS = {
  cliente: "Ana Ribeiro",
  itens: [{ description: "Consultoria", quantity: 2, unitPrice: 450 }],
  validade: "2026-12-05",
};

function recordingClient(messages: unknown[] = []) {
  const calls: [string, ...unknown[]][] = [];
  const client = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (name === "then" || name === "muted") return undefined;
        return async (...args: unknown[]) => {
          calls.push([name, ...args]);
          if (name === "getMessages") return { payload: messages };
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

async function newRequest(now = new Date()) {
  seq += 1;
  const chatwootConversationId = 11_400 + seq;
  const conv = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId,
      contactId,
      chatwootConversationId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${chatwootConversationId}`,
      lastEventAt: now,
      lastInboundAt: now,
    },
  });
  const out = await issueOrRequestApproval({
    ctx: ctx(),
    base: appDb,
    storageDir: DIR,
    templateId,
    idempotencyKey: `page-${seq}`,
    values: ARGS,
    threadId: conv.threadId,
    chatwootInstanceId: instanceId,
    conversationId: conv.id,
    now,
  });
  if (out.kind !== "approval") throw new Error("expected a request");
  return { requestId: BigInt(out.request.id), conversationId: conv.id };
}

async function deliveriesFor(requestId: bigint, outcome: string) {
  await settleFlowEvents();
  return suDb.alertDelivery.findMany({
    where: { tenantId, channelId, causeKey: `${outcome}:${requestId}` },
    select: {
      causeKey: true,
      conversationId: true,
      stage: true,
      level: true,
      count: true,
    },
  });
}

async function expire(requestId: bigint) {
  await suDb.documentApprovalRequest.update({
    where: { id: requestId },
    data: { status: "EXPIRED", expiresAt: new Date(Date.now() - 60_000) },
  });
}

describe.skipIf(!dbUp)(
  "document approval: alert, page and request again",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "DAP", slug: `dap-${process.pid}` },
      });
      tenantId = t.id;
      const other = await suDb.tenant.create({
        data: { name: "DAP other", slug: `dap-other-${process.pid}` },
      });
      otherTenantId = other.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 9,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
          settings: {},
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `dap-route-${process.pid}`,
          name: "Atendente",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: 7,
          name: "Suporte",
          agentId: agent.id,
          channelType: "Channel::Api",
        },
      });
      inboxId = inbox.id;
      const contact = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: 77,
          name: "Ana Ribeiro",
          phone: "+5511999990000",
          email: "ana@example.com",
        },
      });
      contactId = contact.id;
      // An error-only channel: the level a request's line is written at would never reach it, so
      // every alert it receives here came through as a cause.
      const ch = await suDb.alertChannel.create({
        data: {
          tenantId,
          name: "equipe",
          type: "discord",
          url: encryptJson(outboundUrl("/api/webhooks/doc-page")),
          minLevel: "error",
          stages: [],
          excludeAgentIds: [],
        },
      });
      channelId = ch.id;
      const starter = documentStarter("quote", "pt-BR");
      if (!starter) throw new Error("no starter");
      const tpl = await createDocumentTemplate(
        { tenantId, userId: null, role: "TENANT_ADMIN" },
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
      await settleFlowEvents();
      for (const id of [tenantId, otherTenantId]) {
        if (!id) continue;
        for (const table of [
          "alert_deliveries",
          "alert_channels",
          "execution_logs",
          "scheduler_jobs",
          "audit_logs",
          "document_approval_requests",
          "issued_documents",
          "document_templates",
          "conversations",
          "contacts",
          "chatwoot_agent_bots",
          "inboxes",
          "agents",
          "chatwoot_instances",
        ]) {
          await suDb.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${id}`,
          );
        }
        await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
      }
      await rm(DIR, { recursive: true, force: true });
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("a new request alerts an error-only channel once, and the alert links to the request's page", async () => {
      const { requestId, conversationId } = await newRequest();
      const rows = await deliveriesFor(
        requestId,
        "document_approval_requested",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.conversationId).toBe(conversationId);
      const lines = await flowLogRows(suDb, {
        where: {
          tenantId,
          conversationId,
          detail: { path: ["outcome"], equals: "document_approval_requested" },
        },
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe("info");

      const links = alertLinks({
        type: "discord",
        stage: "tool",
        level: "warn",
        summary: "[tool] ok: document_approval_requested",
        count: 1,
        tenantId,
        turnId: "t",
        conversationId,
        causeKey: `document_approval_requested:${requestId}`,
      });
      const page = new URL(links[0]?.url ?? "");
      expect(page.pathname).toBe(`/document-approvals/${requestId}`);
      // The tenant selector and nothing else: the console session is the only credential.
      expect([...page.searchParams.keys()]).toEqual(["switchTenant"]);
      expect(page.hash).toBe("");
      expect(links.map((l) => l.label)).toEqual([
        "Review document",
        "View conversation",
      ]);

      const webhook = JSON.parse(
        buildAlertBody({
          type: "webhook",
          stage: "tool",
          level: "warn",
          summary: "s",
          count: 1,
          tenantId,
          turnId: "t",
          conversationId,
          causeKey: `document_approval_requested:${requestId}`,
        }).rawBody,
      ) as { documentApproval: { requestId: string; url: string } | null };
      expect(webhook.documentApproval?.requestId).toBe(String(requestId));
      expect(new URL(webhook.documentApproval?.url ?? "").pathname).toBe(
        `/document-approvals/${requestId}`,
      );
    });

    test("two calls racing to open the same request raise one alert", async () => {
      seq += 1;
      const chatwootConversationId = 11_400 + seq;
      const conv = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId,
          contactId,
          chatwootConversationId,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${chatwootConversationId}`,
          lastEventAt: new Date(),
          lastInboundAt: new Date(),
        },
      });
      const now = new Date();
      const call = () =>
        issueOrRequestApproval({
          ctx: ctx(),
          base: appDb,
          storageDir: DIR,
          templateId,
          idempotencyKey: `page-race-${seq}`,
          values: ARGS,
          threadId: conv.threadId,
          chatwootInstanceId: instanceId,
          conversationId: conv.id,
          now,
        });
      const outs = await Promise.all([call(), call(), call()]);
      const ids = new Set(
        outs.map((o) => (o.kind === "approval" ? o.request.id : null)),
      );
      expect(ids.size).toBe(1);
      const [id] = [...ids];
      const rows = await deliveriesFor(
        BigInt(id as string),
        "document_approval_requested",
      );
      expect(rows.map((r) => r.count)).toEqual([1]);
    });

    test("a request the agent's retry lands on again raises no second alert", async () => {
      const now = new Date();
      const { requestId, conversationId } = await newRequest(now);
      const again = await issueOrRequestApproval({
        ctx: ctx(),
        base: appDb,
        storageDir: DIR,
        templateId,
        idempotencyKey: `page-${seq}`,
        values: ARGS,
        threadId: `${tenantId}:${instanceId}:${11_400 + seq}`,
        chatwootInstanceId: instanceId,
        conversationId,
        now,
      });
      expect(again.kind === "approval" && again.request.id).toBe(
        String(requestId),
      );
      expect(
        await deliveriesFor(requestId, "document_approval_requested"),
      ).toHaveLength(1);
    });

    test("an expired request alerts with the link to its page, where it can be asked again", async () => {
      const { requestId } = await newRequest();
      await expire(requestId);
      const rec = recordingClient();
      expect(
        await runApprovalOutcome(tenantId, requestId, appDb, {
          makeClient: rec.makeClient,
        }),
      ).toBe("noted");
      const rows = await deliveriesFor(requestId, "document_approval_expired");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.stage).toBe("tool");
    });

    test("asking an expired request again opens one new request dated today, and the old one stays expired", async () => {
      const first = new Date("2026-10-01T15:00:00Z");
      const { requestId, conversationId } = await newRequest(first);
      await expire(requestId);
      const later = new Date("2031-03-20T15:00:00Z");
      const [a, b] = await Promise.all([
        requestApprovalAgain({
          ctx: ctx(),
          requestId,
          base: appDb,
          now: later,
        }),
        requestApprovalAgain({
          ctx: ctx(),
          requestId,
          base: appDb,
          now: later,
        }),
      ]);
      expect(a.id).toBe(b.id);
      expect(a.id).not.toBe(String(requestId));
      expect(a.status).toBe("PENDING");
      expect(a.conversationId).toBe(String(conversationId));
      expect(a.templateId).toBe(String(templateId));
      expect(a.expiresAt.getTime()).toBeGreaterThan(later.getTime());
      expect((await getApprovalRequest(ctx(), requestId, appDb)).status).toBe(
        "EXPIRED",
      );
      const [oldRow, newRow] = await Promise.all(
        [requestId, BigInt(a.id)].map((id) =>
          suDb.documentApprovalRequest.findUniqueOrThrow({
            where: { id },
            select: { snapshot: true },
          }),
        ),
      );
      expect(
        (oldRow?.snapshot as unknown as DocumentSnapshot | undefined)
          ?.issuedDate,
      ).toBe("2026-10-01");
      expect(
        (newRow?.snapshot as unknown as DocumentSnapshot | undefined)
          ?.issuedDate,
      ).toBe("2031-03-20");
      expect(
        await suDb.documentApprovalRequest.count({
          where: { tenantId, conversationId },
        }),
      ).toBe(2);
      expect(
        await deliveriesFor(BigInt(a.id), "document_approval_requested"),
      ).toHaveLength(1);
    });

    test("asking again after the template was switched off answers with the replacement already made", async () => {
      const { requestId } = await newRequest();
      await expire(requestId);
      const first = await requestApprovalAgain({
        ctx: ctx(),
        requestId,
        base: appDb,
      });
      await suDb.documentTemplate.update({
        where: { id: templateId },
        data: { enabled: false },
      });
      try {
        const retry = await requestApprovalAgain({
          ctx: ctx(),
          requestId,
          base: appDb,
        });
        expect(retry.id).toBe(first.id);
      } finally {
        await suDb.documentTemplate.update({
          where: { id: templateId },
          data: { enabled: true },
        });
      }
    });

    test("asking again in parallel audits once, with the request that was made", async () => {
      const { requestId } = await newRequest();
      await expire(requestId);
      const [a, b] = await Promise.all([
        requestApprovalAgain({ ctx: ctx(), requestId, base: appDb }),
        requestApprovalAgain({ ctx: ctx(), requestId, base: appDb }),
      ]);
      expect(a.id).toBe(b.id);
      const audits = await suDb.auditLog.findMany({
        where: {
          tenantId,
          action: "document_approval.request_again",
          target: `document_approval:${requestId}`,
        },
        select: { after: true },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.after).toEqual({ requestId: a.id });
    });

    test("a document a caller issued under the old again key does not block asking again", async () => {
      const { requestId } = await newRequest();
      await expire(requestId);
      // Any key the REST route accepts, including the one older builds opened a replacement under.
      await suDb.issuedDocument.create({
        data: {
          tenantId,
          title: "Planted",
          idempotencyKey: `again:${requestId}`,
        },
      });
      const replacement = await requestApprovalAgain({
        ctx: ctx(),
        requestId,
        base: appDb,
      });
      expect(replacement.status).toBe("PENDING");
      expect(replacement.id).not.toBe(String(requestId));
    });

    test("only an expired request can be asked again", async () => {
      const { requestId } = await newRequest();
      await expect(
        requestApprovalAgain({ ctx: ctx(), requestId, base: appDb }),
      ).rejects.toMatchObject({
        statusCode: 409,
        translationKey: "errors.documentApprovalNotExpired",
      });
    });

    test("the page's context names the customer and shows the last public messages", async () => {
      const { requestId } = await newRequest();
      const rec = recordingClient([
        { id: 1, content: "oi", message_type: 0, private: false },
        { id: 2, content: "nota da equipe", message_type: 1, private: true },
        { id: 3, content: "Olá! Como posso ajudar?", message_type: 1 },
        { id: 4, content: "quero um orçamento", message_type: 0 },
      ]);
      const context = await getApprovalContext(
        ctx(),
        requestId,
        {
          makeClient: rec.makeClient,
        },
        appDb,
      );
      expect(context.contact).toEqual({
        name: "Ana Ribeiro",
        phone: "+5511999990000",
        email: "ana@example.com",
      });
      expect(context.messages.map((m) => [m.content, m.fromCustomer])).toEqual([
        ["oi", true],
        ["Olá! Como posso ajudar?", false],
        ["quero um orçamento", true],
      ]);
      expect(context.messagesUnavailable).toBe(false);
    });

    test("a voice note or a file with no caption reaches the reviewer as what it was", async () => {
      const { requestId } = await newRequest();
      const rec = recordingClient([
        {
          id: 1,
          content: null,
          message_type: 0,
          attachments: [
            {
              id: 11,
              file_type: "audio",
              data_url: "https://chat.example.com/a.ogg",
              transcribed_text: "quero o orçamento para três salas",
            },
          ],
        },
        {
          id: 2,
          content: "",
          message_type: 0,
          attachments: [
            { id: 12, file_type: "image", data_url: "https://x/y.png" },
          ],
        },
      ]);
      const context = await getApprovalContext(
        ctx(),
        requestId,
        { makeClient: rec.makeClient },
        appDb,
      );
      expect(context.messages.map((m) => m.attachments)).toEqual([
        [
          {
            fileType: "audio",
            transcribedText: "quero o orçamento para três salas",
          },
        ],
        [{ fileType: "image", transcribedText: null }],
      ]);
    });

    test("the context reads older pages until it has the last ten public messages", async () => {
      const { requestId } = await newRequest();
      // Sixty messages, one in five public: Chatwoot's latest page of twenty holds only four.
      const all = Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        content: `m${i + 1}`,
        message_type: (i + 1) % 5 === 0 ? 0 : 1,
        private: (i + 1) % 5 !== 0,
      }));
      const asked: (number | undefined)[] = [];
      const client = new Proxy(
        {},
        {
          get(_t, name: string) {
            if (name === "then" || name === "muted") return undefined;
            return async (_id: number, opts?: { before?: number }) => {
              if (name !== "getMessages") return {};
              asked.push(opts?.before);
              const older = all.filter(
                (m) => opts?.before === undefined || m.id < opts.before,
              );
              return { payload: older.slice(-20) };
            };
          },
        },
      );
      const context = await getApprovalContext(
        ctx(),
        requestId,
        { makeClient: async () => client as never },
        appDb,
      );
      expect(context.messages.map((m) => m.content)).toEqual(
        [15, 20, 25, 30, 35, 40, 45, 50, 55, 60].map((n) => `m${n}`),
      );
      expect(asked).toEqual([undefined, 41, 21]);
    });

    test("a Chatwoot client that cannot be built leaves the customer on the page, without the messages", async () => {
      const { requestId } = await newRequest();
      const context = await getApprovalContext(
        ctx(),
        requestId,
        {
          makeClient: async () => {
            throw new Error("getaddrinfo ENOTFOUND chat.example.com");
          },
        },
        appDb,
      );
      expect(context.contact?.name).toBe("Ana Ribeiro");
      expect(context.messages).toEqual([]);
      expect(context.messagesUnavailable).toBe(true);
    });

    test("the queue lists what waits on the team now, oldest first, with the customer's name", async () => {
      const before = (await listPendingApprovals(ctx(), appDb)).map(
        (r) => r.id,
      );
      const countBefore = await countPendingApprovals(ctx(), appDb);
      const a = await newRequest();
      const b = await newRequest();
      const lapsed = await newRequest();
      await suDb.documentApprovalRequest.update({
        where: { id: lapsed.requestId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const decided = await newRequest();
      await suDb.documentApprovalRequest.update({
        where: { id: decided.requestId },
        data: { status: "APPROVED" },
      });
      const listed = (await listPendingApprovals(ctx(), appDb)).filter(
        (r) => !before.includes(r.id),
      );
      expect(listed.map((r) => r.id)).toEqual([
        String(a.requestId),
        String(b.requestId),
      ]);
      expect(listed[0]?.contactName).toBe("Ana Ribeiro");
      expect(listed[0]?.conversationId).toBe(String(a.conversationId));
      expect(listed[0]?.chatwootConversationId).toEqual(expect.any(Number));
      const foreign: TenantContext = {
        tenantId: otherTenantId,
        userId: null,
        role: "TENANT_ADMIN",
      };
      expect(await listPendingApprovals(foreign, appDb)).toEqual([]);
      // A page starts after the last id of the one before, and the count covers every page.
      const firstPage = await listPendingApprovals(ctx(), appDb, new Date(), {
        limit: 1,
      });
      const nextPage = await listPendingApprovals(ctx(), appDb, new Date(), {
        after: BigInt(firstPage[0]?.id as string),
        limit: 1,
      });
      expect(nextPage[0]?.id).not.toBe(firstPage[0]?.id);
      expect(Number(nextPage[0]?.id)).toBeGreaterThan(Number(firstPage[0]?.id));
      expect(await countPendingApprovals(ctx(), appDb)).toBe(countBefore + 2);
    });

    test("the history lists what is no longer waiting, newest first, with who decided and what it came to", async () => {
      const reviewer = await suDb.user.create({
        data: {
          email: `hist-${Date.now()}@local.test`,
          name: "Bruno Revisor",
          passwordHash: "x",
        },
      });
      const waiting = await newRequest();
      const approved = await newRequest();
      await suDb.documentApprovalRequest.update({
        where: { id: approved.requestId },
        data: {
          status: "APPROVED",
          reviewerUserId: reviewer.id,
          decidedAt: new Date(),
          outcome: "DELIVERED",
          outcomeAt: new Date(),
        },
      });
      const expired = await newRequest();
      await suDb.documentApprovalRequest.update({
        where: { id: expired.requestId },
        data: { status: "EXPIRED" },
      });
      const history = await listDecidedApprovals(ctx(), appDb);
      const ids = history.map((r) => r.id);
      expect(ids).not.toContain(String(waiting.requestId));
      expect(ids.indexOf(String(expired.requestId))).toBeLessThan(
        ids.indexOf(String(approved.requestId)),
      );
      const row = history.find((r) => r.id === String(approved.requestId));
      expect(row?.status).toBe("APPROVED");
      expect(row?.reviewerName).toBe("Bruno Revisor");
      expect(row?.outcome).toBe("DELIVERED");
      expect(row?.contactName).toBe("Ana Ribeiro");
      // A page starts before the last id of the one before.
      const next = await listDecidedApprovals(ctx(), appDb, {
        before: BigInt(String(expired.requestId)),
        limit: 50,
      });
      expect(next.map((r) => r.id)).toContain(String(approved.requestId));
      expect(next.map((r) => r.id)).not.toContain(String(expired.requestId));
      const foreign: TenantContext = {
        tenantId: otherTenantId,
        userId: null,
        role: "TENANT_ADMIN",
      };
      expect(await listDecidedApprovals(foreign, appDb)).toEqual([]);
      const read = await getApprovalRequest(ctx(), approved.requestId, appDb);
      expect(read.reviewerName).toBe("Bruno Revisor");
      await suDb.user.delete({ where: { id: reviewer.id } });
    });

    test("the conversations list flags a conversation whose document waits on the team", async () => {
      const waiting = await newRequest();
      const lapsed = await newRequest();
      await suDb.documentApprovalRequest.update({
        where: { id: lapsed.requestId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const page = await listConversations(ctx(), { limit: 100 }, appDb);
      const flag = (id: bigint) =>
        page.items.find((c) => c.id === String(id))?.awaitingApproval;
      expect(flag(waiting.conversationId)).toBe(true);
      expect(flag(lapsed.conversationId)).toBe(false);
    });

    test("a conversation's requests are listed apart from every other conversation's", async () => {
      const mine = await newRequest();
      await newRequest();
      const listed = await listApprovalRequests(
        ctx(),
        { conversationId: mine.conversationId },
        appDb,
      );
      expect(listed.length).toBeGreaterThan(0);
      for (const r of listed) {
        expect(r.conversationId).toBe(String(mine.conversationId));
      }
      expect(listed.map((r) => r.id)).toContain(String(mine.requestId));
    });

    test("another tenant reads nothing of the request, its page or its context", async () => {
      const { requestId } = await newRequest();
      const foreign: TenantContext = {
        tenantId: otherTenantId,
        userId: null,
        role: "TENANT_ADMIN",
      };
      await expect(
        getApprovalRequest(foreign, requestId, appDb),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        getApprovalContext(foreign, requestId, {}, appDb),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expire(requestId);
      await expect(
        requestApprovalAgain({ ctx: foreign, requestId, base: appDb }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  },
);
