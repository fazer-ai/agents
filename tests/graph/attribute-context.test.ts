import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { buildNativeTools } from "@/graph/tools/native";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type ChatwootClient,
  createChatwootClient,
} from "@/modules/chatwoot/client";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";
import { fakeChatwootAttributeStore } from "../utils/chatwoot-attribute-store";

// NOTE: End-to-end wiring of the attribute context: the mirrored bags (fed by the webhook) → the
// block appended to the agent's system prompt at turn prep. No Chatwoot call is involved.

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
let agentSelected = 0n;
let agentNone = 0n;
const CONV_ID = 7700;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

const load = (agentId: bigint) =>
  runScopedOn(appDb, ctx(tenantId), (db) =>
    loadAgentConfig(db, {
      tenantId,
      instanceId,
      conversationId: CONV_ID,
      agentId,
      threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
    }),
  );

describe.skipIf(!dbUp)("attribute context in the system prompt", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "AC", slug: `ac-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const keyId = (
      await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      })
    ).id;
    const mc = {
      provider: "openai",
      model: "gpt-4o-mini",
      credentialRef: `vault:${keyId}`,
    };
    agentSelected = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Com atributos",
          systemPrompt: "Você é um assistente.",
          modelConfig: mc,
          settings: {
            attributeContext: {
              conversation: ["origem", "observacao"],
              contact: ["plano", "cpf"],
              task: ["orcamento"],
            },
          },
        },
      })
    ).id;
    agentNone = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Sem atributos",
          systemPrompt: "Você é um assistente.",
          modelConfig: mc,
        },
      })
    ).id;
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instanceId,
        tenantId,
        chatwootContactId: 4242,
        name: "Maria",
        customAttributes: { plano: "pro" },
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: CONV_ID,
        contactId: contact.id,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
        customAttributes: {
          origem: "Instagram",
          // NOTE: A stored value is customer/agent-authored and can happen to contain our own
          // placeholder syntax. The block is appended AFTER interpolatePromptVars precisely so it
          // stays inert — see the assertion below.
          observacao: "cliente pediu para chamar de {{nome_contato}}",
        },
        kanbanAttributes: { orcamento: 3200 },
      },
    });
  });

  afterAll(async () => {
    if (dbUp && tenantId) {
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("selected attributes are appended with their current values, unset ones flagged", async () => {
    const loaded = await load(agentSelected);
    const prompt = loaded?.systemPrompt ?? "";
    // NOTE: The tenant's own prompt is preserved and the block is appended AFTER it.
    expect(prompt.startsWith("Você é um assistente.")).toBe(true);
    expect(prompt).toContain("<attribute_values>");
    expect(prompt).toContain('<attribute key="origem" value="Instagram"/>');
    expect(prompt).toContain('<attribute key="plano" value="pro"/>');
    expect(prompt).toContain('<attribute key="orcamento" value="3200"/>');
    // NOTE: Selected but never filled → the agent sees what is still missing.
    expect(prompt).toContain('<attribute key="cpf" filled="no"/>');
  });

  test("a stored value carrying template syntax is never interpolated", async () => {
    const prompt = (await load(agentSelected))?.systemPrompt ?? "";
    // NOTE: Pins the ORDER: the block is appended after interpolatePromptVars, so the placeholder
    // reaches the model verbatim instead of being substituted with the contact's name ("Maria").
    expect(prompt).toContain(
      '<attribute key="observacao" value="cliente pediu para chamar de {{nome_contato}}"/>',
    );
    expect(prompt).not.toContain("chamar de Maria");
  });

  test("an agent without the setting gets no block at all", async () => {
    const loaded = await load(agentNone);
    expect(loaded?.systemPrompt).toBe("Você é um assistente.");
  });

  test("concurrent set_custom_attribute writes keep every key (atomic jsonb merge)", async () => {
    const convId = CONV_ID + 1;
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${convId}`,
        customAttributes: { origem: "Instagram" },
      },
    });
    const client = {
      setConversationCustomAttributes: async () => ({}),
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: convId,
      tenantId,
      base: appDb,
      conversationDbId: conv.id,
    }) as StructuredToolInterface[];
    const tool = tools.find((t) => t.name === "set_custom_attribute");
    if (!tool) throw new Error("set_custom_attribute missing");

    // NOTE: A turn's tool calls run CONCURRENTLY in the tool node, so the mirror write-through has
    // to merge in ONE statement. A read-modify-write drops keys here: every call would read the
    // same starting bag and the last writer would win with only its own key.
    const keys = Array.from({ length: 10 }, (_, i) => `campo_${i}`);
    await Promise.all(keys.map((key) => tool.invoke({ key, value: key })));

    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv.id },
    });
    expect(row.customAttributes).toEqual({
      origem: "Instagram",
      ...Object.fromEntries(keys.map((k) => [k, k])),
    });
  });

  test("after a burst, what the operator sees and what the agent reads agree", async () => {
    // The test above proves OUR bag survives a concurrent burst. It stubs the Chatwoot call to a
    // no-op, so it says nothing about the other side — and the other side was where issue #112
    // lived: the mirror kept every key while Chatwoot kept one, and nothing ever reconciled them
    // (agent bots never receive contact_updated). Both views are asserted here, against a Chatwoot
    // that replaces the bag exactly as the deployed fork does.
    const convId = CONV_ID + 2;
    const contact = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 4242 },
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        contactId: contact.id,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${convId}`,
        customAttributes: { origem: "Instagram" },
      },
    });
    const cw = fakeChatwootAttributeStore(5, {
      conversations: { [convId]: { origem: "Instagram" } },
      contacts: { 4242: { plano: "pro" } },
    });
    const client = await createChatwootClient(
      {
        baseUrl: "https://chat.example.com",
        accountId: 5,
        adminToken: "ADMIN_TOK",
        botToken: "BOT_TOK",
      },
      { fetchImpl: cw.fetchImpl, assertSafe: async (u: string) => new URL(u) },
    );
    const tools = buildNativeTools({
      client,
      conversationId: convId,
      tenantId,
      base: appDb,
      conversationDbId: conv.id,
      contactDbId: contact.id,
    }) as StructuredToolInterface[];
    const tool = tools.find((t) => t.name === "set_custom_attribute");
    if (!tool) throw new Error("set_custom_attribute missing");

    // The burst from the report: several keys per scope in ONE turn.
    await Promise.all([
      tool.invoke({ key: "produto", value: "cadeira" }),
      tool.invoke({ key: "medida", value: "90cm" }),
      tool.invoke({ key: "quantidade", value: "4" }),
      tool.invoke({ key: "empresa", value: "Acme", scope: "contact" }),
      tool.invoke({ key: "nome_cliente", value: "Ana", scope: "contact" }),
    ]);

    const expectedConversation = {
      origem: "Instagram",
      produto: "cadeira",
      medida: "90cm",
      quantidade: "4",
    };
    const expectedContact = {
      plano: "pro",
      empresa: "Acme",
      nome_cliente: "Ana",
    };
    // What the operator opens in Chatwoot...
    expect(cw.conversations.get(convId)).toEqual(expectedConversation);
    expect(cw.contacts.get(4242)).toEqual(expectedContact);
    // ...and what the agent reads back from the mirror on the next turn.
    const convRow = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv.id },
    });
    const contactRow = await suDb.contact.findUniqueOrThrow({
      where: { id: contact.id },
    });
    expect(convRow.customAttributes).toEqual(expectedConversation);
    expect(contactRow.customAttributes).toEqual(expectedContact);
  });

  test("the write-through barrier is pinned to UTC, not the session timezone", async () => {
    // NOTE: `custom_attributes_at` is TIMESTAMP (no zone) holding UTC; bare NOW() is timestamptz.
    // Mixing them makes GREATEST resolve through the SESSION TimeZone, which nothing in the deploy
    // pins. Under UTC-3 the stored value reads as 3h in the FUTURE and wins, so the barrier never
    // advances and a pre-write snapshot walks straight through the compare-and-set.
    const [row] = await suDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Sao_Paulo'");
      // NOTE: The ::timestamp cast is not decoration — it is the conversion Postgres performs when
      // the expression is assigned back to the (zone-less) column, so this models the real UPDATE.
      return tx.$queryRaw<
        Array<{ naive_stuck: boolean; pinned_moves: boolean }>
      >`
        WITH w(stored) AS (SELECT (NOW() AT TIME ZONE 'UTC') - interval '1 hour')
        SELECT GREATEST(stored, NOW())::timestamp = stored AS naive_stuck,
               GREATEST(stored, (NOW() AT TIME ZONE 'UTC')) > stored AS pinned_moves
        FROM w
      `;
    });
    if (!row) throw new Error("no row");
    // Bare NOW() hands the STALE value back, so the barrier silently no-ops; pinned moves forward.
    expect(row.naive_stuck).toBe(true);
    expect(row.pinned_moves).toBe(true);
  });

  test("a pre-write snapshot delivered late cannot erase the write-through", async () => {
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instanceId,
        tenantId,
        chatwootContactId: 4243,
        name: "Rita",
        customAttributes: { plano: "free" },
      },
    });
    const client = {
      setContactCustomAttributes: async () => ({}),
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: CONV_ID,
      tenantId,
      base: appDb,
      contactDbId: contact.id,
    }) as StructuredToolInterface[];
    const tool = tools.find((t) => t.name === "set_custom_attribute");
    if (!tool) throw new Error("set_custom_attribute missing");
    await tool.invoke({ key: "plano", value: "pro", scope: "contact" });

    const now = Math.floor(Date.now() / 1000);
    const snapshot = (
      convId: number,
      at: number,
      bag: Record<string, unknown>,
    ): NormalizedChatwootEvent => ({
      event: "conversation_updated",
      conversationId: convId,
      contactInboxId: null,
      inboxId: null,
      status: "pending",
      assigneeType: null,
      assigneeId: null,
      assigneeName: null,
      contact: {
        id: 4243,
        name: "Rita",
        email: null,
        phone: null,
        identifier: null,
        customAttributes: bag,
      },
      inboxName: null,
      channel: null,
      lastActivityAt: at,
    });

    // NOTE: Chatwoot built this payload BEFORE the tool's API write, but it lands after. Its stamp
    // still beats the last mirrored event, so without the barrier the write-through leaves behind
    // (custom_attributes_at = NOW()) the whole bag would be replaced by the pre-write snapshot.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      snapshot(CONV_ID + 2, now - 60, { plano: "free" }),
      appDb,
    );
    let row = await suDb.contact.findUniqueOrThrow({
      where: { id: contact.id },
    });
    expect(row.customAttributes).toEqual({ plano: "pro" });

    // NOTE: …and the barrier is not a wall: a genuinely later event still wins, which is what keeps
    // Chatwoot the source of truth.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      snapshot(CONV_ID + 3, now + 60, { plano: "enterprise" }),
      appDb,
    );
    row = await suDb.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(row.customAttributes).toEqual({ plano: "enterprise" });
  });
});
