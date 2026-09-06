import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";
import {
  handoffConversation,
  replyToConversation,
  returnConversationToAgent,
  setConversationStatus,
} from "@/modules/conversations/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { conversationReply } from "@/modules/mcp/write-conversations";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE CONVERSATION-CONTROL FAMILY, WHOSE TRAIL WAS WRITTEN BY THE MCP TRANSPORT AND BY NOTHING ELSE.
//
// Issue #398, the last of #306's service families. What separates it from the five configuration
// families (#399) is that the mutation is not ours: reply, handoff, return, status and reengage all
// change state inside somebody else's system, so "the row shares the mutation's transaction" is not
// available here and the row follows the effect instead. That is the invariant this file pins from
// both sides: a call Chatwoot accepted leaves a row, and a call it refused leaves none.
//
// The actor half is the point of the move: the console speaks REST, and before this the console's
// own reply to a live customer left nothing at all.

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

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;

const USER = 9398n;
const BOT_TOKEN = "BOT-TOKEN";
const ADMIN_TOKEN = "ADMIN-TOKEN";

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

const principal = (over: Partial<VerifiedToken> = {}): VerifiedToken => ({
  userId: USER,
  tenantId,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
  ...over,
});

// The client the services build is replaced wholesale where the service takes a factory; the calls
// it records are what says the action reached Chatwoot at all.
function stubClient(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const client = {
    sendMessage: async () => {
      calls.push("sendMessage");
      return {};
    },
    assignToAgent: async () => {
      calls.push("assignToAgent");
      return {};
    },
    unassignConversation: async () => {
      calls.push("unassignConversation");
      return {};
    },
    toggleStatus: async () => {
      calls.push("toggleStatus");
      return {};
    },
    getConversation: async () => {
      calls.push("getConversation");
      return {};
    },
    ...over,
  };
  return { calls, makeClient: async () => client as unknown as ChatwootClient };
}

async function seedConversation(
  convId: number,
  over: {
    status?: string;
    assigneeType?: string | null;
    assigneeId?: number | null;
  } = {},
): Promise<bigint> {
  const c = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      inboxId: inboxDbId,
      status: over.status ?? "pending",
      assigneeType: over.assigneeType ?? null,
      assigneeId: over.assigneeId ?? null,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
  return c.id;
}

// A client whose MIRROR write fails and whose everything else works, for the case where Chatwoot has
// already accepted the action and our own bookkeeping is what breaks.
const mirrorFailingBase = (client: PrismaClient): PrismaClient => {
  // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
  const wrap = (target: any): any =>
    new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === "$extends") {
          return (...args: unknown[]) => wrap(t.$extends(...args));
        }
        if (prop === "$transaction") {
          return (fn: unknown, ...rest: unknown[]) =>
            typeof fn === "function"
              ? t.$transaction(
                  (tx: unknown) => (fn as (c: unknown) => unknown)(wrap(tx)),
                  ...rest,
                )
              : t.$transaction(fn, ...rest);
        }
        if (prop === "conversation") {
          const real = Reflect.get(t, prop, receiver);
          return {
            ...real,
            update: async () => {
              throw new Error("mirror write failed (pool timeout)");
            },
            updateMany: async () => {
              throw new Error("mirror write failed (pool timeout)");
            },
          };
        }
        return Reflect.get(t, prop, receiver);
      },
    });
  return wrap(client) as PrismaClient;
};

// A client whose audit INSERT fails and whose everything else works. The Prisma surface is proxied
// through `$extends` and through the transaction client, because `runScopedOn` calls both before the
// seam ever sees a delegate.
const auditFailingBase = (client: PrismaClient): PrismaClient => {
  // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
  const wrap = (target: any): any =>
    new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === "$extends") {
          return (...args: unknown[]) => wrap(t.$extends(...args));
        }
        if (prop === "$transaction") {
          return (fn: unknown, ...rest: unknown[]) =>
            typeof fn === "function"
              ? t.$transaction(
                  (tx: unknown) => (fn as (c: unknown) => unknown)(wrap(tx)),
                  ...rest,
                )
              : t.$transaction(fn, ...rest);
        }
        if (prop === "auditLog") {
          return {
            ...Reflect.get(t, prop, receiver),
            create: async () => {
              throw new Error("audit insert failed (pool timeout)");
            },
          };
        }
        return Reflect.get(t, prop, receiver);
      },
    });
  return wrap(client) as PrismaClient;
};

async function rows(action?: string) {
  return (
    (await su?.auditLog.findMany({
      where: { tenantId, ...(action ? { action } : {}) },
      orderBy: { id: "asc" },
    })) ?? []
  );
}

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
  );
}

describe.skipIf(!dbUp)(
  "the conversation family records its own control actions",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "AUD398", slug: `aud398-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 5,
        // An IP literal in TEST-NET-3: the MCP case below builds the REAL client, so the SSRF guard
        // vets this URL for real, and an address needs no resolver to be vetted.
        baseUrl: "https://203.0.113.9",
        adminToken: encryptJson(ADMIN_TOKEN),
      });
      instanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          // A RUNNABLE model configuration, which the hand-back asks for since issue #495 review
          // round 6: an unconfigured agent cannot answer, so it cannot be handed a conversation.
          modelConfig: {
            provider: "openai-compatible",
            model: "local",
            baseURL: "https://llm.example.invalid/v1",
          },
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson(BOT_TOKEN),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `aud398-route-${process.pid}`,
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
        },
      });
      inboxDbId = inbox.id;
    });

    afterAll(async () => {
      if (su && tenantId) {
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

    test("a reply from the console records what was sent, and to whom", async () => {
      await clearAudit();
      const id = await seedConversation(4001);
      const stub = stubClient();
      await replyToConversation(
        ctx(),
        id,
        "já te ajudo",
        false,
        { makeClient: stub.makeClient },
        appDb,
      );
      expect(stub.calls).toEqual(["sendMessage"]);
      const [row, ...rest] = await rows();
      expect(rest).toEqual([]);
      expect(row?.action).toBe("conversation.reply");
      expect(row?.target).toBe(`conversation:${id}`);
      expect(row?.actorId).toBe(USER);
      expect(row?.actorType).toBe("user");
      expect(row?.after).toEqual({ private: false, content: "já te ajudo" });
    });

    test("a private note is recorded as one", async () => {
      await clearAudit();
      const id = await seedConversation(4002);
      const stub = stubClient();
      await replyToConversation(
        ctx(),
        id,
        "cliente já reclamou disso antes",
        true,
        { makeClient: stub.makeClient },
        appDb,
      );
      const [row] = await rows();
      expect(row?.after).toEqual({
        private: true,
        content: "cliente já reclamou disso antes",
      });
    });

    test("a handoff names who it went to, and the status it left behind", async () => {
      await clearAudit();
      const id = await seedConversation(4003, { status: "pending" });
      const stub = stubClient();
      await handoffConversation(
        ctx(),
        id,
        77,
        { makeClient: stub.makeClient },
        appDb,
      );
      const [row] = await rows();
      expect(row?.action).toBe("conversation.handoff");
      expect(row?.before).toEqual({
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      expect(row?.after).toEqual({
        status: "open",
        assigneeType: "User",
        assigneeId: 77,
      });
    });

    // An untargeted handoff is the console's ordinary one: it asks for a human without naming which,
    // so `assignToAgent` never runs and who ends up holding the conversation is Chatwoot's answer, not
    // the caller's argument. A row built from the argument says `null` about a conversation somebody is
    // holding, and it disagrees with the broadcast published one line above it from the same write.
    test("an untargeted handoff records who ended up holding it", async () => {
      await clearAudit();
      const id = await seedConversation(4009, { status: "pending" });
      const seen: string[] = [];
      const stub = stubClient({
        getConversation: async () => {
          seen.push("getConversation");
          return {
            id: 4009,
            status: "open",
            meta: { assignee_type: "User", assignee: { id: 42, name: "Ana" } },
            // NEWER than the mirrored row, or the reconcile refuses the reading and `state` comes back
            // null: this case is about the row that a SUCCESSFUL live read produced.
            last_activity_at: Math.floor(Date.now() / 1000) + 60,
            updated_at: Math.floor(Date.now() / 1000) + 60.5,
          };
        },
      });
      await handoffConversation(
        ctx(),
        id,
        null,
        { makeClient: stub.makeClient },
        appDb,
      );
      // No `assignToAgent`: nobody was named, which is the whole point of the case.
      expect(stub.calls).toEqual(["toggleStatus"]);
      expect(seen).toEqual(["getConversation"]);
      const [row] = await rows();
      expect(row?.after).toEqual({
        status: "open",
        assigneeType: "User",
        assigneeId: 42,
      });
    });

    test("a hand-back records the outcome, because taken-over is not the outcome asked for", async () => {
      await clearAudit();
      const id = await seedConversation(4004, {
        status: "open",
        assigneeType: "User",
        assigneeId: 5,
      });
      const stub = stubClient();
      const outcome = await returnConversationToAgent(
        ctx(),
        id,
        { makeClient: stub.makeClient },
        appDb,
      );
      const [row] = await rows();
      expect(row?.action).toBe("conversation.return");
      expect(row?.before).toEqual({
        status: "open",
        assigneeType: "User",
        assigneeId: 5,
      });
      expect(row?.after).toEqual({
        status: "pending",
        assigneeType: null,
        assigneeId: null,
        outcome,
      });
    });

    // THE MATRIX, and it is here because the same finding arrived twice: a row that carries what the
    // caller ASKED for instead of where the write LANDED. Every action of this family that writes
    // through `mirrorConsoleWrite` gets a row from the same value the broadcast publishes, so the two
    // cannot disagree about the same instant, and each one is measured on a conversation whose live
    // state answers something other than the request.
    const liveConversation = (over: {
      status: string;
      assigneeId?: number | null;
    }) => ({
      id: 1,
      status: over.status,
      meta:
        over.assigneeId == null
          ? { assignee_type: null, assignee: null }
          : {
              assignee_type: "User",
              assignee: { id: over.assigneeId, name: "Ana" },
            },
      // NEWER than the mirrored row, or the reconcile refuses the reading and `state` comes back null.
      last_activity_at: Math.floor(Date.now() / 1000) + 60,
      updated_at: Math.floor(Date.now() / 1000) + 60.5,
    });

    test("a status change records where it landed, not what it asked for", async () => {
      await clearAudit();
      const id = await seedConversation(4010, { status: "pending" });
      const stub = stubClient({
        // A webhook outranked the toggle: Chatwoot answers `open` to a request for `resolved`.
        getConversation: async () => liveConversation({ status: "open" }),
      });
      await setConversationStatus(
        ctx(),
        id,
        "resolved",
        { makeClient: stub.makeClient },
        appDb,
      );
      const [row] = await rows();
      expect(row?.action).toBe("conversation.status");
      expect(row?.before).toEqual({ status: "pending" });
      expect(row?.after).toEqual({ status: "open" });
    });

    test("a hand-back records where it landed too", async () => {
      await clearAudit();
      const id = await seedConversation(4011, {
        status: "open",
        assigneeType: "User",
        assigneeId: 5,
      });
      const stub = stubClient({
        getConversation: async () =>
          liveConversation({ status: "open", assigneeId: 5 }),
      });
      const outcome = await returnConversationToAgent(
        ctx(),
        id,
        { makeClient: stub.makeClient },
        appDb,
      );
      // The holder never left, so the hand-back reports the takeover rather than the return it asked
      // for, and the status the row carries is the one the mirror ended up with.
      expect(outcome).toBe("taken-over");
      const [row] = await rows();
      expect(row?.after).toEqual({
        status: "open",
        assigneeType: "User",
        assigneeId: 5,
        outcome: "taken-over",
      });
    });

    // WHO HELD IT, on both sides, and not just the id. `User` and `AgentBot` are separate id namespaces
    // in Chatwoot — `returnConversationToAgent` says so in as many words where it compares holders — so
    // a row carrying `assigneeId: 7` cannot tell AgentBot 7 from User 7, and a handoff that only
    // changes the type reads as a row where nothing moved.
    test("a handoff records the holder's type, not only the id", async () => {
      await clearAudit();
      const id = await seedConversation(4012, {
        status: "pending",
        assigneeType: "AgentBot",
        assigneeId: 7,
      });
      const stub = stubClient({
        getConversation: async () =>
          liveConversation({ status: "open", assigneeId: 7 }),
      });
      await handoffConversation(
        ctx(),
        id,
        7,
        { makeClient: stub.makeClient },
        appDb,
      );
      const [row] = await rows();
      expect(row?.before).toEqual({
        status: "pending",
        assigneeType: "AgentBot",
        assigneeId: 7,
      });
      expect(row?.after).toEqual({
        status: "open",
        assigneeType: "User",
        assigneeId: 7,
      });
    });

    // A hand-back on a conversation that is ALREADY pending moves nothing but the holder, so a row
    // carrying only the status is a row that says nothing happened.
    test("a hand-back records the holder it removed", async () => {
      await clearAudit();
      const id = await seedConversation(4013, {
        status: "pending",
        assigneeType: "User",
        assigneeId: 9,
      });
      const stub = stubClient();
      const outcome = await returnConversationToAgent(
        ctx(),
        id,
        { makeClient: stub.makeClient },
        appDb,
      );
      expect(outcome).toBe("returned");
      const [row] = await rows();
      expect(row?.before).toEqual({
        status: "pending",
        assigneeType: "User",
        assigneeId: 9,
      });
      expect(row?.after).toEqual({
        status: "pending",
        assigneeType: null,
        assigneeId: null,
        outcome: "returned",
      });
    });

    // THE PARTIAL, which is the half an "on success" row cannot reach. The two Chatwoot calls of a
    // targeted handoff are separate requests: the assignment can land and the status toggle fail, and
    // then a person is holding a conversation with nothing on the trail saying who put them there.
    test("a handoff that half happened is still recorded", async () => {
      await clearAudit();
      const id = await seedConversation(4014, { status: "pending" });
      const stub = stubClient({
        toggleStatus: async () => {
          throw new Error("Chatwoot API 502 for POST /toggle_status");
        },
      });
      await expect(
        handoffConversation(
          ctx(),
          id,
          33,
          { makeClient: stub.makeClient },
          appDb,
        ),
      ).rejects.toThrow();
      const [row, ...rest] = await rows();
      expect(rest).toEqual([]);
      expect(row?.action).toBe("conversation.handoff");
      expect(row?.after).toEqual({
        status: "pending",
        assigneeType: "User",
        assigneeId: 33,
        partial: true,
      });
    });

    // The same seam on the hand-back, whose own documentation calls this partial the recoverable one:
    // the status went to pending and the human is still there.
    test("a hand-back that half happened is still recorded", async () => {
      await clearAudit();
      const id = await seedConversation(4015, {
        status: "open",
        assigneeType: "User",
        assigneeId: 12,
      });
      const stub = stubClient({
        getConversation: async () =>
          liveConversation({ status: "pending", assigneeId: 12 }),
        unassignConversation: async () => {
          throw new Error("Chatwoot API 502 for POST /assignments");
        },
      });
      await expect(
        returnConversationToAgent(
          ctx(),
          id,
          { makeClient: stub.makeClient },
          appDb,
        ),
      ).rejects.toThrow();
      const [row, ...rest] = await rows();
      expect(rest).toEqual([]);
      expect(row?.action).toBe("conversation.return");
      expect(row?.after).toEqual({
        status: "pending",
        assigneeType: "User",
        assigneeId: 12,
        partial: true,
      });
    });

    test("a status change records both sides", async () => {
      await clearAudit();
      const id = await seedConversation(4005, { status: "open" });
      const stub = stubClient();
      await setConversationStatus(
        ctx(),
        id,
        "resolved",
        { makeClient: stub.makeClient },
        appDb,
      );
      const [row] = await rows();
      expect(row?.action).toBe("conversation.status");
      expect(row?.before).toEqual({ status: "open" });
      expect(row?.after).toEqual({ status: "resolved" });
    });

    // The row follows the EFFECT, and this is the half a service that recorded first would get wrong:
    // Chatwoot refused the send, the customer got nothing, and a row saying otherwise is worse than no
    // row at all.
    test("a call Chatwoot refused leaves no row", async () => {
      await clearAudit();
      const id = await seedConversation(4006);
      const stub = stubClient({
        sendMessage: async () => {
          throw new Error("Chatwoot API 422 for POST /messages");
        },
      });
      await expect(
        replyToConversation(
          ctx(),
          id,
          "não vai sair",
          false,
          { makeClient: stub.makeClient },
          appDb,
        ),
      ).rejects.toThrow();
      expect(await rows()).toEqual([]);
    });

    // THE ROW MAY BE LOST; THE MESSAGE MAY NOT BE SENT TWICE.
    //
    // This is the price of recording after the effect, and it is paid deliberately. The seam's other
    // families share the mutation's transaction, so a failed row means a failed change and the caller
    // is right to see the error. Here the change is Chatwoot's and cannot be rolled back: an error
    // raised after the customer already has the message tells the caller to retry, and the retry sends
    // it again. On the /reset path it is worse, because the throw escapes the delivery processor after
    // the erase has happened and leaves the ledger row stranded.
    test("a row that cannot be written does not undo, or repeat, what already happened", async () => {
      await clearAudit();
      const id = await seedConversation(4016);
      const stub = stubClient();
      await replyToConversation(
        ctx(),
        id,
        "chegou ao cliente",
        false,
        { makeClient: stub.makeClient },
        auditFailingBase(appDb),
      );
      expect(stub.calls).toEqual(["sendMessage"]);
      expect(await rows()).toEqual([]);
    });

    // THE OTHER HALF OF THE SAME TRADE. Chatwoot accepted the toggle, and the mirror write after it
    // threw. Everything below that line is our own bookkeeping, so a row written only on the happy
    // path would be missing for a status change that really happened, in somebody else's system.
    test("a status change whose mirror write fails is still recorded", async () => {
      await clearAudit();
      const id = await seedConversation(4017, { status: "pending" });
      const stub = stubClient();
      await expect(
        setConversationStatus(
          ctx(),
          id,
          "resolved",
          { makeClient: stub.makeClient },
          mirrorFailingBase(appDb),
        ),
      ).rejects.toThrow();
      expect(stub.calls).toContain("toggleStatus");
      const [row, ...rest] = await rows();
      expect(rest).toEqual([]);
      expect(row?.action).toBe("conversation.status");
      // The status Chatwoot ACCEPTED, because the reconciled one was never read.
      expect(row?.after).toEqual({ status: "resolved" });
    });

    test("a handoff whose mirror write fails is still recorded", async () => {
      await clearAudit();
      const id = await seedConversation(4018, { status: "pending" });
      const stub = stubClient();
      await expect(
        handoffConversation(
          ctx(),
          id,
          55,
          { makeClient: stub.makeClient },
          mirrorFailingBase(appDb),
        ),
      ).rejects.toThrow();
      expect(stub.calls).toEqual(["assignToAgent", "toggleStatus"]);
      const [row, ...rest] = await rows();
      expect(rest).toEqual([]);
      expect(row?.action).toBe("conversation.handoff");
      expect(row?.after).toEqual({
        status: "open",
        assigneeType: "User",
        assigneeId: 55,
      });
    });

    // The hand-back's own version of the same case, and the fallback here has to be what the call
    // KNOWS rather than where it started: the unassign ran, so the human is gone, and a row falling
    // back to the baseline would say they are still holding a conversation this call just freed.
    test("a hand-back whose mirror write fails records the holder it removed", async () => {
      await clearAudit();
      const id = await seedConversation(4019, {
        status: "open",
        assigneeType: "User",
        assigneeId: 21,
      });
      const stub = stubClient();
      await expect(
        returnConversationToAgent(
          ctx(),
          id,
          { makeClient: stub.makeClient },
          mirrorFailingBase(appDb),
        ),
      ).rejects.toThrow();
      expect(stub.calls).toContain("unassignConversation");
      const [row, ...rest] = await rows();
      expect(rest).toEqual([]);
      expect(row?.action).toBe("conversation.return");
      expect(row?.after).toEqual({
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
    });

    // An untargeted handoff makes no assignment request, and the open toggle does not auto-assign
    // anybody (measured on 4.17.0). With the post-write state unusable, the row must not invent a
    // human: the holder is the one the conversation already had.
    test("an untargeted handoff with no usable state does not invent a holder", async () => {
      await clearAudit();
      const id = await seedConversation(4020, { status: "pending" });
      const stub = stubClient();
      await handoffConversation(
        ctx(),
        id,
        null,
        { makeClient: stub.makeClient },
        appDb,
      );
      const [row] = await rows();
      expect(row?.after).toEqual({
        status: "open",
        assigneeType: null,
        assigneeId: null,
      });
      // And the MIRROR agrees, which is the half the row alone cannot show: the fallback write must
      // not stamp a person onto a conversation that has none.
      const mirrored = await suDb.conversation.findUniqueOrThrow({
        where: { id },
        select: { status: true, assigneeType: true, assigneeId: true },
      });
      expect(mirrored).toEqual({
        status: "open",
        assigneeType: null,
        assigneeId: null,
      });
    });

    test("the door is carried by the actor, not by the action", async () => {
      await clearAudit();
      const id = await seedConversation(4007);
      const stub = stubClient();
      await replyToConversation(
        ctx({ actorType: "api_key" }),
        id,
        "via chave",
        false,
        { makeClient: stub.makeClient },
        appDb,
      );
      const [row] = await rows();
      expect(row?.action).toBe("conversation.reply");
      expect(row?.actorType).toBe("api_key");
    });

    // One logical mutation, one row. The transport used to write its own AFTER the service returned,
    // so a service that records as well would double every MCP apply.
    test("an apply over MCP leaves exactly one row, and it names the mcp door", async () => {
      await clearAudit();
      const id = await seedConversation(4008);
      const realFetch = globalThis.fetch;
      const seen: string[] = [];
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = typeof input === "string" ? input : input.toString();
        seen.push(url);
        // Authenticates like Chatwoot does: a blank token is a 401 before any authorization runs, so a
        // stub that accepts anything is what let issue #79 ship.
        const token =
          new Headers(init?.headers).get(CHATWOOT_AUTH_HEADER) ?? "";
        if (!token) return new Response("unauthorized", { status: 401 });
        return new Response(JSON.stringify({ id: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      try {
        const r = await conversationReply(
          principal(),
          {
            conversation_id: String(id),
            content: "oi pelo mcp",
            dry_run: false,
          },
          { base: appDb },
        );
        expect(r.ok).toBe(true);
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(seen.some((u) => u.includes("/messages"))).toBe(true);
      const all = await rows();
      expect(all.length).toBe(1);
      expect(all[0]?.action).toBe("conversation.reply");
      expect(all[0]?.actorType).toBe("mcp");
    });
  },
);
