import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { type AgentConfig, buildToolset } from "@/graph/prepare";
import { buildNativeTools } from "@/graph/tools/native";
import {
  guardedTool,
  preconditionStateLoader,
} from "@/graph/tools/precondition";
import type { ToolPrecondition } from "@/modules/agents/tool-preconditions";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { seedChatwootInstance } from "../utils/chatwoot";

// The effect the issue is about is NOT a return value: `handoff_to_human` reassigns a conversation
// and posts, irreversibly. So the assertion here is that the side effect DID NOT HAPPEN, read from a
// spy, while the state that decides it is read from a real Postgres through the real loader — the
// half a pure test cannot cover, because the loader is where scope, RLS and the jsonb shape live.
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

const CONV_ID = 9401;

function spyHandoff() {
  const calls: unknown[] = [];
  const t = tool(
    async (input: unknown) => {
      calls.push(input);
      return "Handed off to a human (status set to open).";
    },
    {
      name: "handoff_to_human",
      description: "Escalate the conversation to a human agent.",
      schema: z.object({ reason: z.string().optional() }),
    },
  ) as unknown as StructuredToolInterface;
  return { tool: t, calls };
}

describe.skipIf(!dbUp)(
  "preconditionStateLoader against a real database",
  () => {
    let tenantId = 0n;
    let instanceId = 0n;
    let conversationDbId = 0n;
    let contactDbId = 0n;

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "PRECOND", slug: `precond-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 41,
        baseUrl: "https://203.0.113.41:9",
      });
      instanceId = inst.id;
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: inst.id,
          chatwootInboxId: 410,
          name: "WhatsApp",
        },
        select: { id: true },
      });
      const contact = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: inst.id,
          chatwootContactId: 4101,
          customAttributes: { plan: "gold" },
        },
        select: { id: true },
      });
      contactDbId = contact.id;
      const conv = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: inst.id,
          inboxId: inbox.id,
          contactId: contact.id,
          chatwootConversationId: CONV_ID,
          status: "pending",
          threadId: `${tenantId}:${inst.id}:${CONV_ID}`,
          customAttributes: {},
        },
        select: { id: true },
      });
      conversationDbId = conv.id;
    });

    afterAll(async () => {
      if (tenantId) {
        await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    const cond: ToolPrecondition = {
      kind: "attribute",
      scope: "conversation",
      key: "article_url",
    };

    test("the guarded tool does not run while the attribute is unset, and runs once it is", async () => {
      const { tool: inner, calls } = spyHandoff();
      const guarded = guardedTool(
        inner,
        cond,
        preconditionStateLoader({
          base: appDb,
          tenantId,
          conversationDbId,
          contactDbId,
        }),
      );

      const refused = await guarded.invoke({ reason: "2 — link insertion" });
      expect(calls).toHaveLength(0);
      expect(String(refused)).toContain("was not run");

      // Written exactly the way `set_custom_attribute` writes it (jsonb merge on the mirror row), so
      // this test fails if that tool's write and this loader's read ever stop agreeing.
      await suDb.$executeRaw`
      UPDATE conversations
      SET custom_attributes = custom_attributes || ${JSON.stringify({
        article_url: "https://financefootball.com/artigo-123",
      })}::jsonb
      WHERE id = ${conversationDbId} AND tenant_id = ${tenantId}
    `;

      const ran = await guarded.invoke({ reason: "2 — link insertion" });
      expect(calls).toHaveLength(1);
      expect(String(ran)).toContain("Handed off");
    });

    test("reads the contact bag for a contact-scoped condition", async () => {
      const load = preconditionStateLoader({
        base: appDb,
        tenantId,
        conversationDbId,
        contactDbId,
      });
      const state = await load();
      expect(state.contactAttributes.plan).toBe("gold");
    });

    test("a conversation-less turn (the playground) reads an empty bag, so a condition is unmet", async () => {
      const { tool: inner, calls } = spyHandoff();
      const guarded = guardedTool(
        inner,
        cond,
        preconditionStateLoader({
          base: appDb,
          tenantId,
          conversationDbId: null,
          contactDbId: null,
        }),
      );
      const out = await guarded.invoke({});
      expect(calls).toHaveLength(0);
      expect(String(out)).toContain("was not run");
    });

    test("a MET condition is still stopped by the fence, and the turn's own wiring hands it in", async () => {
      // The read above is a wait between the graph's ask at dispatch and the call it authorises, so
      // a tool whose first act is a WRITE loses that cover the moment a precondition is configured
      // on it (issue #568, review round 24). Asked through `buildToolset` rather than `guardedTool`
      // because the fence's ARGUMENT POSITION is the half a unit test cannot see: passed one slot
      // over, the wrapper reads `undefined`, every assertion about the fence still passes, and
      // nothing is guarded. Measured while writing this: that is exactly what happened.
      const cfg = {
        agentId: 1n,
        contactDbId: null,
        conversationDbId,
        contactVoiceReply: null,
        documentSelections: [],
        handoffConfig: HANDOFF_DEFAULTS,
        kanbanConfig: KANBAN_DEFAULTS,
        contactAuth: CONTACT_AUTH_DEFAULTS,
        sendImageConfig: SEND_IMAGE_DEFAULTS,
        httpToolContext: {},
        codeToolDefs: [],
        httpToolDefs: [],
        integrationSelections: [],
        mcpSelections: [],
        nativeToolsAllow: ["private_note"],
        ragConfig: undefined,
        timezone: "America/Sao_Paulo",
        toolGuidance: {},
        toolPreconditions: { private_note: cond },
        transferWithSummary: true,
      } as unknown as AgentConfig;
      const posted: unknown[] = [];
      const client = {
        sendPrivateNote: async (...args: unknown[]) => {
          posted.push(args);
          return {};
        },
      } as unknown as ChatwootClient;
      const tools = await buildToolset(
        cfg,
        {
          tenantId,
          instanceId,
          base: appDb,
          client,
          conversationId: CONV_ID,
          threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
          // Wanted when the graph asked; withdrawn by the time the state read came back.
          stillWanted: async () => false,
        },
        { buildNativeTools },
      );
      const note = tools.find((t) => t.name === "private_note");
      if (!note) throw new Error("private_note was not built");
      const out = String(await note.invoke({ content: "resumo" }));
      // The condition IS met (the attribute was written above), so what stops it is the fence.
      expect(posted).toHaveLength(0);
      expect(out).toContain("called off");
    });

    test("another tenant's row cannot satisfy the condition", async () => {
      const other = await suDb.tenant.create({
        data: { name: "PRECOND2", slug: `precond2-${process.pid}` },
      });
      try {
        const { tool: inner, calls } = spyHandoff();
        // The ids are real and the attribute IS set on them — only the tenant is wrong. RLS is what
        // has to answer, and a loader that forgot to scope would let this through.
        const guarded = guardedTool(
          inner,
          cond,
          preconditionStateLoader({
            base: appDb,
            tenantId: other.id,
            conversationDbId,
            contactDbId,
          }),
        );
        const out = await guarded.invoke({});
        expect(calls).toHaveLength(0);
        expect(String(out)).toContain("was not run");
      } finally {
        await suDb.tenant.delete({ where: { id: other.id } }).catch(() => {});
      }
    });
  },
);
