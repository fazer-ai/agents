import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { seedChatwootInstance } from "@/tests/utils/chatwoot";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The conversation family's trail, driven through the console's own doors (issue #398).
//
// `tests/modules/audit-conversation-family.test.ts` proves the SERVICES record. This file answers
// the half that measurement cannot see: whether the five REST routes reach those services with a
// principal at all. `v1.controller.ts` contains no `audit`, and it never did: the row was the MCP
// transport's, so a reply typed into the console went to a live customer and left nothing.
//
// The services are WRAPPED and the wrappers call through, which is what `mock.module` always demands
// here: it is global to the worker and outlives this file. All a wrapper does is hand the write the
// test database and a Chatwoot the test controls, neither of which the controller can inject.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

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

setupPrismaMock();

// A Chatwoot that accepts everything. What this file measures is who the row names, so the calls
// themselves only have to succeed; `tests/modules/chatwoot-reset.test.ts` is where a double that
// authenticates like the real one earns its keep.
const chatwootCalls: string[] = [];
const makeClient = async () =>
  ({
    sendMessage: async () => {
      chatwootCalls.push("sendMessage");
      return {};
    },
    assignToAgent: async () => {
      chatwootCalls.push("assignToAgent");
      return {};
    },
    unassignConversation: async () => {
      chatwootCalls.push("unassignConversation");
      return {};
    },
    toggleStatus: async () => {
      chatwootCalls.push("toggleStatus");
      return {};
    },
    getConversation: async () => {
      chatwootCalls.push("getConversation");
      return {};
    },
  }) as unknown as ChatwootClient;

const conversations = await import("@/modules/conversations/service");
const reengage = await import("@/modules/conversations/reengage");
// COPIES taken before the mocks are installed: Bun updates the imported namespace in place, so a
// wrapper that called the module by name would call itself.
const realConversations = { ...conversations };
const realReengage = { ...reengage };

// The context the re-engage route handed down, captured rather than exercised. Running that path for
// real means a model turn, and the question here is the transport's: a route that dropped the
// principal would produce a row nobody can be held to, and the row itself is measured against the
// service in `tests/modules/reengage.test.ts`.
let reengageCtx: TenantContext | null = null;
// NOTE: read through a function. The only writer is the mock callback below, which TypeScript's
// control-flow analysis does not see from the assertion's scope, so a direct read narrows to `never`.
const readReengageCtx = () => reengageCtx;

mock.module("@/modules/conversations/service", () => ({
  ...realConversations,
  replyToConversation: mock(
    (ctx: TenantContext, id: bigint, content: string, isPrivate: boolean) =>
      realConversations.replyToConversation(
        ctx,
        id,
        content,
        isPrivate,
        { makeClient },
        app,
      ),
  ),
  handoffConversation: mock(
    (ctx: TenantContext, id: bigint, assigneeId: number | null) =>
      realConversations.handoffConversation(
        ctx,
        id,
        assigneeId,
        { makeClient },
        app,
      ),
  ),
  returnConversationToAgent: mock((ctx: TenantContext, id: bigint) =>
    realConversations.returnConversationToAgent(ctx, id, { makeClient }, app),
  ),
  setConversationStatus: mock(
    (ctx: TenantContext, id: bigint, status: "open" | "pending" | "resolved") =>
      realConversations.setConversationStatus(
        ctx,
        id,
        status,
        { makeClient },
        app,
      ),
  ),
  getConversationDetail: (ctx: TenantContext, id: bigint) =>
    realConversations.getConversationDetail(ctx, id, app),
}));

mock.module("@/modules/conversations/reengage", () => ({
  ...realReengage,
  reengageConversation: mock(async (ctx: TenantContext) => {
    reengageCtx = ctx;
    return { outcome: "empty" as const };
  }),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does NOT
// run, while this one does, and the wrappers are already installed for the whole worker.
afterAll(() => {
  mock.module("@/modules/conversations/service", () => realConversations);
  mock.module("@/modules/conversations/reengage", () => realReengage);
});

const ADMIN_ID = 9397n;
let tenantId = 0n;
let instanceId = 0n;
let convDbId = 0n;
let cookie = "";

const rows = async () =>
  (await su?.auditLog.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
  })) ?? [];

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
  );
}

function req(path: string, init: RequestInit = {}): Request {
  return new BunRequest(`http://localhost/api/v1${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...init.headers },
  });
}

describe.skipIf(!dbUp)(
  "the console's own conversation doors name who wrote",
  () => {
    beforeAll(async () => {
      if (!su || !app) return;
      const t = await su.tenant.create({
        data: { name: "CONVREST", slug: `convrest-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(su, {
        tenantId,
        accountId: 5,
        baseUrl: "https://203.0.113.9",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const agent = await su.agent.create({
        data: { tenantId, name: "Atendente", systemPrompt: "Olá." },
      });
      await su.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `convrest-route-${process.pid}`,
          name: "Atendente",
        },
      });
      const inbox = await su.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: 7,
          name: "Suporte",
          agentId: agent.id,
        },
      });
      const conv = await su.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 7001,
          inboxId: inbox.id,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:7001`,
          lastEventAt: new Date(),
        },
      });
      convDbId = conv.id;
      mockFindUnique.mockImplementation(() =>
        Promise.resolve({
          id: ADMIN_ID,
          tenantId,
          email: "admin@example.com",
          passwordHash: null,
          googleId: null,
          name: null,
          role: "TENANT_ADMIN" as const,
          lastLoginAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      const token = await new SignJWT({
        userId: ADMIN_ID.toString(),
        email: "admin@example.com",
        role: "TENANT_ADMIN",
        tenantId: tenantId.toString(),
      })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(config.jwtSecret));
      cookie = `fazerai_auth_token=${token}`;
      await clearAudit();
    });

    afterAll(async () => {
      // `dbUp`, not `su`: the probe assigns the client and only then checks the connection, so a
      // configured-but-unreachable database leaves `su` truthy while the suite skips.
      if (dbUp && su && tenantId) {
        for (const table of [
          "audit_logs",
          "conversations",
          "inboxes",
          "chatwoot_agent_bots",
          "agents",
          "chatwoot_instances",
        ]) {
          await su.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          );
        }
        await su.$executeRawUnsafe(
          `DELETE FROM chatwoot_deployments WHERE tenant_id = ${tenantId}`,
        );
        await su.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("a reply, a handoff, a hand-back and a status change each name the operator", async () => {
      await clearAudit();
      for (const [path, body] of [
        ["reply", { content: "bom dia" }],
        ["handoff", { assigneeId: 77 }],
        ["return", undefined],
        ["status", { status: "resolved" }],
      ] as Array<[string, Record<string, unknown> | undefined]>) {
        const res = await server.handle(
          req(`/conversations/${convDbId}/${path}`, {
            method: "POST",
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        );
        expect(res.status).toBe(200);
      }

      const r = await rows();
      expect(r.map((x) => x.action)).toEqual([
        "conversation.reply",
        "conversation.handoff",
        "conversation.return",
        "conversation.status",
      ]);
      // The door is a browser session, so every row is attributed to one, and to the operator behind
      // it. This is the half no transport-written row could have covered for the console.
      expect(r.every((x) => x.actorType === "user")).toBe(true);
      expect(r.every((x) => x.actorId === ADMIN_ID)).toBe(true);
      expect(r.every((x) => x.tenantId === tenantId)).toBe(true);
      expect(r.every((x) => x.target === `conversation:${convDbId}`)).toBe(
        true,
      );
    });

    test("a reply with no session is refused before anything is sent or recorded", async () => {
      await clearAudit();
      chatwootCalls.length = 0;
      const res = await server.handle(
        new BunRequest(
          `http://localhost/api/v1/conversations/${convDbId}/reply`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "não autorizado" }),
          },
        ),
      );
      expect(res.status).toBe(401);
      expect(chatwootCalls).toEqual([]);
      expect(await rows()).toEqual([]);
    });

    test("the re-engage route hands the principal down", async () => {
      reengageCtx = null;
      const res = await server.handle(
        req(`/conversations/${convDbId}/reengage`, { method: "POST" }),
      );
      expect(res.status).toBe(200);
      expect(readReengageCtx()?.userId).toBe(ADMIN_ID);
      expect(readReengageCtx()?.tenantId).toBe(tenantId);
    });
  },
);
