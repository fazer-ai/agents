import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { setPublisher, TOPICS } from "@/api/features/realtime/realtime.service";
import config from "@/config";
import { buildNativeTools } from "@/graph/tools/native";
import type { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  cloneAgent,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentToolSelections,
  listAgents,
  listAgentsPaged,
  PromptTooLongError,
  replaceAgentToolSelections,
  SettingsTextTooLongError,
  updateAgent,
} from "@/modules/agents/service";
import {
  CUSTOM_POLICY_MAX,
  EXTRACTION_PROMPT_MAX,
  FOLLOW_UP_INSTRUCTIONS_MAX,
  TOOL_INSTRUCTIONS_MAX,
} from "@/modules/agents/text-caps";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { readHandoffConfig } from "@/modules/handoff/settings";
import { readKanbanConfig } from "@/modules/kanban/settings";
import { seedChatwootInstance } from "../utils/chatwoot";

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

let tenantA = 0n;
let tenantB = 0n;
let agentAId = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("agents service", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "AgA", slug: `ag-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "AgB", slug: `ag-b-${process.pid}` },
    });
    tenantB = b.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenantA,
        name: "Sales",
        systemPrompt: "Be helpful.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    agentAId = agent.id;
    // B's own agent (must never be visible to A).
    await suDb.agent.create({
      data: {
        tenantId: tenantB,
        name: "Other",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("list returns only the tenant's agents, serialized", async () => {
    const list = await listAgents(ctx(tenantA), appDb);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("Sales");
    expect(typeof list[0]?.id).toBe("string");
    expect(list[0]?.modelConfig).toMatchObject({ model: "gpt-4o-mini" });
  });

  test("get fetches a single agent", async () => {
    const a = await getAgent(ctx(tenantA), agentAId, appDb);
    expect(a.systemPrompt).toBe("Be helpful.");
  });

  test("update patches allowlisted fields and returns the new state", async () => {
    const a = await updateAgent(
      ctx(tenantA),
      agentAId,
      { systemPrompt: "Be concise.", enabled: false },
      appDb,
    );
    expect(a.systemPrompt).toBe("Be concise.");
    expect(a.enabled).toBe(false);
  });

  // The editor tells the operator to paste a full URL and promises only the host is kept, and
  // `readSendImageConfig` does that — at READ time. What lands in the row is whatever was typed, so
  // a pasted presigned link stored its signature in `agent.settings` and handed it back to the
  // editor on the next load. Normalizing on the way IN is what makes the promise true.
  test("a pasted image URL is reduced to its host before it is stored", async () => {
    await updateAgent(
      ctx(tenantA),
      agentAId,
      {
        settings: {
          sendImage: {
            allowedHosts: [
              "https://usuario:senha-secreta@cdn.loja.com.br/fotos/x.png?X-Amz-Signature=deadbeef",
              "  *.IMAGENS.com.br  ",
              "localhost",
            ],
          },
        },
      },
      appDb,
    );
    const row = await suDb.agent.findFirstOrThrow({
      where: { id: agentAId },
      select: { settings: true },
    });
    const stored = (row.settings as Record<string, unknown>).sendImage as {
      allowedHosts: string[];
    };
    expect(stored.allowedHosts).toEqual([
      "cdn.loja.com.br",
      "*.imagens.com.br",
    ]);
    expect(JSON.stringify(row.settings)).not.toContain("senha-secreta");
    expect(JSON.stringify(row.settings)).not.toContain("deadbeef");
  });

  test("a tenant cannot read another tenant's agent", async () => {
    expect(getAgent(ctx(tenantB), agentAId, appDb)).rejects.toThrow();
  });

  test("a tenant cannot update another tenant's agent", async () => {
    expect(
      updateAgent(ctx(tenantB), agentAId, { enabled: true }, appDb),
    ).rejects.toThrow();
    // And A's agent is untouched by B's attempt.
    const a = await getAgent(ctx(tenantA), agentAId, appDb);
    expect(a.enabled).toBe(false);
  });
});

describe.skipIf(!dbUp)("agents paged list with inbox associations", () => {
  let tenantId = 0n;
  let agentWith = 0n;
  let agentOther = 0n;
  let agentNone = 0n;
  let instanceId = 0n;

  beforeAll(async () => {
    const tnt = await suDb.tenant.create({
      data: { name: "AgInbox", slug: `ag-inbox-${process.pid}` },
    });
    tenantId = tnt.id;
    const mk = (name: string) =>
      suDb.agent.create({
        data: {
          tenantId,
          name,
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
      });
    agentWith = (await mk("With")).id;
    agentOther = (await mk("Other")).id;
    agentNone = (await mk("None")).id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://chat.example.com",
      adminToken: "enc",
    });
    instanceId = inst.id;
    const mkInbox = (cwId: number, name: string, agentId: bigint | null) =>
      suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: cwId,
          name,
          agentId,
        },
      });
    await mkInbox(1, "Sales WA", agentWith);
    await mkInbox(2, "Support WA", agentWith);
    await mkInbox(3, "Other WA", agentOther);
    await mkInbox(4, "Loose WA", null);
  });

  afterAll(async () => {
    if (!tenantId) return;
    await suDb.$executeRawUnsafe(
      `DELETE FROM inboxes WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM chatwoot_instances WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
  });

  test("each agent carries the inboxes it answers (sorted), [] when none", async () => {
    const { agents } = await listAgentsPaged(
      ctx(tenantId),
      { limit: 100 },
      appDb,
    );
    const byId = new Map(agents.map((a) => [a.id, a]));
    const withA = byId.get(String(agentWith));
    expect(withA?.inboxes.map((i) => i.name)).toEqual([
      "Sales WA",
      "Support WA",
    ]);
    expect(byId.get(String(agentOther))?.inboxes.map((i) => i.name)).toEqual([
      "Other WA",
    ]);
    expect(byId.get(String(agentNone))?.inboxes).toEqual([]);
    // The inbox ids are serialized as strings (BigInt → string).
    expect(typeof withA?.inboxes[0]?.id).toBe("string");
  });
});

describe.skipIf(!dbUp)("agents create/clone/delete/tool-selections", () => {
  let tenantC = 0n;
  let other = 0n;
  let toolDefId = 0n;
  let kbId = 0n;
  let otherKbId = 0n;

  beforeAll(async () => {
    const c = await suDb.tenant.create({
      data: { name: "AgC", slug: `ag-c-${process.pid}` },
    });
    tenantC = c.id;
    const o = await suDb.tenant.create({
      data: { name: "AgO", slug: `ag-o-${process.pid}` },
    });
    other = o.id;
    const td = await suDb.toolDefinition.create({
      data: {
        tenantId: tenantC,
        name: "lookup",
        label: "Lookup",
        urlTemplate: "https://api.example.com/x",
        allowedHosts: ["api.example.com"],
      },
    });
    toolDefId = td.id;
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: tenantC, name: "Docs" },
    });
    kbId = kb.id;
    const okb = await suDb.knowledgeBase.create({
      data: { tenantId: other, name: "OtherDocs" },
    });
    otherKbId = okb.id;
  });

  afterAll(async () => {
    for (const tid of [tenantC, other]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tool_definitions WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM knowledge_bases WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM business_hours WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
  });

  test("create validates modelConfig and persists", async () => {
    expect(
      createAgent(
        ctx(tenantC),
        { name: "Bad", modelConfig: { provider: "nope" } },
        appDb,
      ),
    ).rejects.toThrow();
    const a = await createAgent(
      ctx(tenantC),
      {
        name: "New",
        systemPrompt: "Hi",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
      appDb,
    );
    expect(a.name).toBe("New");
    expect(a.enabled).toBe(true);
    // New agents are born in test mode (operator opt-in before going live).
    expect(a.mode).toBe("test");
  });

  // The same storage invariant on the CREATE path: an agent can be born with a host list, and the
  // promise that only the host is kept has to hold there too.
  test("a pasted image URL is reduced to its host on creation as well", async () => {
    const a = await createAgent(
      ctx(tenantC),
      {
        name: "Com imagem",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {
          sendImage: {
            allowedHosts: [
              "https://usuario:senha-secreta@cdn.loja.com.br/x.png?sig=deadbeef",
            ],
          },
        },
      },
      appDb,
    );
    const row = await suDb.agent.findFirstOrThrow({
      where: { id: BigInt(a.id) },
      select: { settings: true },
    });
    expect(
      (
        (row.settings as Record<string, unknown>).sendImage as {
          allowedHosts: string[];
        }
      ).allowedHosts,
    ).toEqual(["cdn.loja.com.br"]);
    expect(JSON.stringify(row.settings)).not.toContain("senha-secreta");
  });

  test("create without modelConfig applies the default model config", async () => {
    const a = await createAgent(ctx(tenantC), { name: "Defaulted" }, appDb);
    expect(a.modelConfig).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      temperature: 0.7,
    });
    expect(a.mode).toBe("test");
  });

  test("create accepts an explicit production mode; update can flip it", async () => {
    const a = await createAgent(
      ctx(tenantC),
      { name: "Live", mode: "production" },
      appDb,
    );
    expect(a.mode).toBe("production");
    const updated = await updateAgent(
      ctx(tenantC),
      BigInt(a.id),
      { mode: "test" },
      appDb,
    );
    expect(updated.mode).toBe("test");
  });

  test("replace tool-selections validates ownership + enum; get returns them", async () => {
    const a = await createAgent(ctx(tenantC), { name: "ToolUser" }, appDb);
    const id = BigInt(a.id);
    // unknown native tool rejected
    expect(
      replaceAgentToolSelections(
        ctx(tenantC),
        id,
        [{ source: "NATIVE", enabledTools: ["nope"] }],
        appDb,
      ),
    ).rejects.toThrow();
    // cross-tenant KB rejected
    expect(
      replaceAgentToolSelections(
        ctx(tenantC),
        id,
        [
          {
            source: "RAG",
            enabledTools: ["search_knowledge"],
            knowledgeBaseIds: [String(otherKbId)],
          },
        ],
        appDb,
      ),
    ).rejects.toThrow();
    // valid set
    const view = await replaceAgentToolSelections(
      ctx(tenantC),
      id,
      [
        { source: "NATIVE", enabledTools: ["handoff_to_human"] },
        {
          source: "RAG",
          enabledTools: ["search_knowledge"],
          knowledgeBaseIds: [String(kbId)],
        },
        { source: "HTTP", toolDefinitionId: String(toolDefId) },
      ],
      appDb,
    );
    expect(view.grants).toHaveLength(3);
    const got = await getAgentToolSelections(ctx(tenantC), id, appDb);
    expect(got.grants.map((g) => g.source).sort()).toEqual([
      "HTTP",
      "NATIVE",
      "RAG",
    ]);
    expect(
      got.catalog.toolDefinitions.some((t) => t.id === String(toolDefId)),
    ).toBe(true);
    // replace-set semantics: a new full set supersedes the old one
    const view2 = await replaceAgentToolSelections(
      ctx(tenantC),
      id,
      [{ source: "NATIVE", enabledTools: [] }],
      appDb,
    );
    expect(view2.grants).toHaveLength(1);
  });

  test("a RAG grant naming knowledge bases but no tools defaults to search_knowledge", async () => {
    const a = await createAgent(ctx(tenantC), { name: "KbOnly" }, appDb);
    const id = BigInt(a.id);
    // Grant the KB WITHOUT listing enabledTools (the MCP footgun): the normalizer fills in
    // search_knowledge so the grant is actually reachable instead of a silent no-op.
    const view = await replaceAgentToolSelections(
      ctx(tenantC),
      id,
      [{ source: "RAG", knowledgeBaseIds: [String(kbId)] }],
      appDb,
    );
    expect(view.grants.find((g) => g.source === "RAG")?.enabledTools).toEqual([
      "search_knowledge",
    ]);
    const got = await getAgentToolSelections(ctx(tenantC), id, appDb);
    expect(got.grants.find((g) => g.source === "RAG")?.enabledTools).toEqual([
      "search_knowledge",
    ]);
  });

  // The catalog is what the editor and the capability map read to answer "what can this agent
  // call". Assembly skips a document template for TWO reasons — the operator disabled it, or this
  // build cannot parse its content — and a catalog that reports only the stored flag makes the map
  // draw a tool that is not in the graph. `available` is the question the assembly asks.
  test("catalog reports a template the runtime would skip as unavailable", async () => {
    const a = await createAgent(
      ctx(tenantC),
      { name: "Disponibilidade" },
      appDb,
    );
    const id = BigInt(a.id);
    const ok = await suDb.documentTemplate.create({
      data: {
        tenantId: tenantC,
        name: "Legível",
        slug: `legivel_${process.pid}`,
        blocks: [{ id: "t", type: "text", text: "Olá." }],
        fields: [],
        style: {},
      },
      select: { id: true },
    });
    // ENABLED, and unreadable: a block type a newer version wrote, seen after a downgrade.
    const future = await suDb.documentTemplate.create({
      data: {
        tenantId: tenantC,
        name: "Do futuro",
        slug: `do_futuro_${process.pid}`,
        blocks: [{ id: "a", type: "signature", label: "Assine" }],
        fields: [],
        style: {},
      },
      select: { id: true },
    });
    const off = await suDb.documentTemplate.create({
      data: {
        tenantId: tenantC,
        name: "Desligado",
        slug: `desligado_${process.pid}`,
        blocks: [{ id: "t", type: "text", text: "Olá." }],
        fields: [],
        style: {},
        enabled: false,
      },
      select: { id: true },
    });
    try {
      const got = await getAgentToolSelections(ctx(tenantC), id, appDb);
      const by = (tid: bigint) =>
        got.catalog.documentTemplates.find((d) => d.id === String(tid));
      expect(by(ok.id)?.available).toBe(true);
      // Both skipped, and only one of them by the stored flag — which is the whole reason this is
      // not just `enabled`.
      expect(by(future.id)).toMatchObject({ enabled: true, available: false });
      expect(by(off.id)).toMatchObject({ enabled: false, available: false });
    } finally {
      await suDb.documentTemplate.deleteMany({
        where: { id: { in: [ok.id, future.id, off.id] } },
      });
    }
  });

  test("catalog knowledgeBases carry the unindexed document count", async () => {
    const a = await createAgent(ctx(tenantC), { name: "KbCount" }, appDb);
    const id = BigInt(a.id);
    const freshKb = await suDb.knowledgeBase.create({
      data: { tenantId: tenantC, name: `CountKB-${process.pid}` },
      select: { id: true },
    });
    // No documents yet → count 0.
    const before = await getAgentToolSelections(ctx(tenantC), id, appDb);
    expect(
      before.catalog.knowledgeBases.find((k) => k.id === String(freshKb.id))
        ?.unindexedCount,
    ).toBe(0);
    // An UNINDEXED document (what an agent import leaves behind) bumps the count.
    await suDb.knowledgeDocument.create({
      data: {
        tenantId: tenantC,
        knowledgeBaseId: freshKb.id,
        title: "Imported",
        sourceType: "text",
        content: "x",
        status: "UNINDEXED",
      },
    });
    const after = await getAgentToolSelections(ctx(tenantC), id, appDb);
    expect(
      after.catalog.knowledgeBases.find((k) => k.id === String(freshKb.id))
        ?.unindexedCount,
    ).toBe(1);
  });

  test("optimistic concurrency: stale expectedUpdatedAt is 409; fresh applies; grant replace bumps the token", async () => {
    const a = await createAgent(ctx(tenantC), { name: "Concurrent" }, appDb);
    const id = BigInt(a.id);
    // A stale token (epoch) is a conflict on BOTH write paths (PATCH + grant replace).
    await expect(
      updateAgent(ctx(tenantC), id, { systemPrompt: "x" }, appDb, {
        expectedUpdatedAt: new Date(0),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      replaceAgentToolSelections(ctx(tenantC), id, [], appDb, {
        expectedUpdatedAt: new Date(0),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // The current token applies.
    const fresh = await getAgent(ctx(tenantC), id, appDb);
    const updated = await updateAgent(
      ctx(tenantC),
      id,
      { systemPrompt: "Concurrency-safe." },
      appDb,
      { expectedUpdatedAt: fresh.updatedAt },
    );
    expect(updated.systemPrompt).toBe("Concurrency-safe.");
    // A grants-only change advances the agent's version token (single token covers the editor).
    const view = await replaceAgentToolSelections(
      ctx(tenantC),
      id,
      [{ source: "NATIVE", enabledTools: ["calculator"] }],
      appDb,
    );
    expect(view.agentUpdatedAt).not.toBeNull();
    expect((view.agentUpdatedAt as Date).getTime()).toBeGreaterThanOrEqual(
      updated.updatedAt.getTime(),
    );
  });

  test("every config-write path publishes an agent-config realtime event (metadata only)", async () => {
    const a = await createAgent(ctx(tenantC), { name: "Realtime" }, appDb);
    const id = BigInt(a.id);
    const events: Array<{ topic: string; data: string }> = [];
    // Capture publishes; restore the no-op default afterwards so no global state leaks across files.
    setPublisher((topic, data) => {
      events.push({ topic, data: String(data) });
      return undefined;
    });
    try {
      const patched = await updateAgent(
        ctx(tenantC),
        id,
        { systemPrompt: "PROMPT-SECRET-MARKER" },
        appDb,
      );
      const patchEvents = events.filter(
        (e) => e.topic === TOPICS.tenant(tenantC),
      );
      expect(patchEvents.length).toBeGreaterThanOrEqual(1);
      const ev = JSON.parse(patchEvents.at(-1)?.data ?? "{}");
      expect(ev).toMatchObject({
        type: "agent-config",
        agentId: a.id,
        updatedAt: patched.updatedAt.toISOString(),
      });
      // Metadata only: no prompt/settings body leaks into the realtime payload.
      expect(JSON.stringify(ev)).not.toContain("PROMPT-SECRET-MARKER");

      const before = events.length;
      const view = await replaceAgentToolSelections(
        ctx(tenantC),
        id,
        [{ source: "NATIVE", enabledTools: ["calculator"] }],
        appDb,
      );
      const grantEvents = events
        .slice(before)
        .filter((e) => e.topic === TOPICS.tenant(tenantC));
      expect(grantEvents.length).toBeGreaterThanOrEqual(1);
      const gev = JSON.parse(grantEvents.at(-1)?.data ?? "{}");
      expect(gev).toMatchObject({
        type: "agent-config",
        agentId: a.id,
        updatedAt: (view.agentUpdatedAt as Date).toISOString(),
      });

      // A Behavior-tab save writes ONLY settings (debounce/stt/tts/split/serviceWindow). It must
      // emit the same agent-config event and advance updatedAt so a second editor tab is warned,
      // exactly like a General-tab save (item 26).
      const beforeSettings = events.length;
      const settingsPatched = await updateAgent(
        ctx(tenantC),
        id,
        { settings: { debounce: { enabled: true, windowSeconds: 8 } } },
        appDb,
      );
      const settingsEvents = events
        .slice(beforeSettings)
        .filter((e) => e.topic === TOPICS.tenant(tenantC));
      expect(settingsEvents.length).toBeGreaterThanOrEqual(1);
      const sev = JSON.parse(settingsEvents.at(-1)?.data ?? "{}");
      expect(sev).toMatchObject({
        type: "agent-config",
        agentId: a.id,
        updatedAt: settingsPatched.updatedAt.toISOString(),
      });
      // updatedAt actually advanced past the previous write (so the second tab's `>` check fires).
      expect(settingsPatched.updatedAt.getTime()).toBeGreaterThan(
        patched.updatedAt.getTime(),
      );
    } finally {
      setPublisher(() => {});
    }
  });

  test("operator guidance round-trips through the DB into the tool descriptions", async () => {
    const a = await createAgent(ctx(tenantC), { name: "Guided" }, appDb);
    const id = BigInt(a.id);
    const dto = await updateAgent(
      ctx(tenantC),
      id,
      {
        settings: {
          handoff: { instructions: "Transfira só após 2 tentativas." },
          kanban: { instructions: "Mova para Ganho com pagamento confirmado." },
        },
      },
      appDb,
    );
    // Parses back from the write echo...
    expect(readHandoffConfig(dto.settings).instructions).toBe(
      "Transfira só após 2 tentativas.",
    );
    expect(readKanbanConfig(dto.settings).instructions).toBe(
      "Mova para Ganho com pagamento confirmado.",
    );
    // ...and from an independent re-read (the bytes really landed in the DB).
    const fresh = await getAgent(ctx(tenantC), id, appDb);
    const handoffCfg = readHandoffConfig(fresh.settings);
    const kanbanCfg = readKanbanConfig(fresh.settings);
    // The seam the agent actually sees: the persisted guidance reaches the tool descriptions.
    const tools = buildNativeTools({
      client: {} as unknown as ChatwootClient,
      conversationId: 1,
      toolInstructions: {
        handoff_to_human: handoffCfg.instructions ?? undefined,
        kanban_move_card: kanbanCfg.instructions ?? undefined,
      },
    });
    const handoffDesc =
      tools.find((t) => t.name === "handoff_to_human")?.description ?? "";
    const kanbanDesc =
      tools.find((t) => t.name === "kanban_move_card")?.description ?? "";
    expect(handoffDesc).toContain("Transfira só após 2 tentativas.");
    expect(kanbanDesc).toContain("Mova para Ganho com pagamento confirmado.");
  });

  test("single version token: a write on one path invalidates a stale token held for the other (409)", async () => {
    const a = await createAgent(ctx(tenantC), { name: "TwoEditors" }, appDb);
    const id = BigInt(a.id);
    // Editor 1 loads the agent at token T0.
    const t0 = (await getAgent(ctx(tenantC), id, appDb)).updatedAt;
    // Distinct millisecond so the advance is observable (updatedAt is ms-resolution).
    await Bun.sleep(5);
    // Editor 2 (or the API/MCP) replaces the grant set with no precondition → the single token advances.
    const view = await replaceAgentToolSelections(
      ctx(tenantC),
      id,
      [{ source: "NATIVE", enabledTools: ["private_note"] }],
      appDb,
    );
    const t1 = view.agentUpdatedAt as Date;
    expect(t1.getTime()).toBeGreaterThan(t0.getTime());
    // Editor 1's held PATCH now carries a stale token → 409 (a grant change moved the shared token).
    await expect(
      updateAgent(ctx(tenantC), id, { systemPrompt: "stale" }, appDb, {
        expectedUpdatedAt: t0,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Reverse direction: a fresh PATCH advances the token, invalidating a held grant token → 409.
    await Bun.sleep(5);
    const patched = await updateAgent(
      ctx(tenantC),
      id,
      { systemPrompt: "fresh" },
      appDb,
      { expectedUpdatedAt: t1 },
    );
    await expect(
      replaceAgentToolSelections(ctx(tenantC), id, [], appDb, {
        expectedUpdatedAt: t1,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // The current token still applies — the lock is precise, not a blanket refusal.
    const ok = await replaceAgentToolSelections(ctx(tenantC), id, [], appDb, {
      expectedUpdatedAt: patched.updatedAt,
    });
    expect(ok.grants).toHaveLength(0);
  });

  test("clone copies grants and starts disabled", async () => {
    const a = await createAgent(ctx(tenantC), { name: "Src" }, appDb);
    const id = BigInt(a.id);
    await replaceAgentToolSelections(
      ctx(tenantC),
      id,
      [{ source: "HTTP", toolDefinitionId: String(toolDefId) }],
      appDb,
    );
    const clone = await cloneAgent(ctx(tenantC), id, "Cloned", appDb);
    expect(clone.name).toBe("Cloned");
    expect(clone.enabled).toBe(false);
    const cloneGrants = await getAgentToolSelections(
      ctx(tenantC),
      BigInt(clone.id),
      appDb,
    );
    expect(cloneGrants.grants).toHaveLength(1);
    expect(cloneGrants.grants[0]?.source).toBe("HTTP");
  });

  test("delete removes the agent", async () => {
    const a = await createAgent(ctx(tenantC), { name: "Doomed" }, appDb);
    await deleteAgent(ctx(tenantC), BigInt(a.id), appDb);
    expect(getAgent(ctx(tenantC), BigInt(a.id), appDb)).rejects.toThrow();
  });

  test("update can (re)assign and detach businessHoursId/followUpHoursId, scoped", async () => {
    const bh = await suDb.businessHours.create({
      data: { tenantId: tenantC, name: "Hrs" },
    });
    const followUpBh = await suDb.businessHours.create({
      data: { tenantId: tenantC, name: "FollowUpHrs" },
    });
    const otherBh = await suDb.businessHours.create({
      data: { tenantId: other, name: "OtherHrs" },
    });
    const a = await createAgent(ctx(tenantC), { name: "Behaved" }, appDb);
    const id = BigInt(a.id);

    const assigned = await updateAgent(
      ctx(tenantC),
      id,
      {
        businessHoursId: String(bh.id),
        followUpHoursId: String(followUpBh.id),
      },
      appDb,
    );
    expect(assigned.businessHoursId).toBe(String(bh.id));
    expect(assigned.followUpHoursId).toBe(String(followUpBh.id));

    // Detaching one leaves the other untouched.
    const detached = await updateAgent(
      ctx(tenantC),
      id,
      { businessHoursId: null },
      appDb,
    );
    expect(detached.businessHoursId).toBeNull();
    expect(detached.followUpHoursId).toBe(String(followUpBh.id));

    // A cross-tenant schedule id is invisible under RLS → NotFound, never assigned.
    expect(
      updateAgent(
        ctx(tenantC),
        id,
        { businessHoursId: String(otherBh.id) },
        appDb,
      ),
    ).rejects.toThrow();
  });

  test("cannot grant another tenant's tool definition", async () => {
    const a = await createAgent(ctx(tenantC), { name: "X" }, appDb);
    const otherTd = await suDb.toolDefinition.create({
      data: {
        tenantId: other,
        name: "other",
        label: "Other",
        urlTemplate: "https://x.example.com",
        allowedHosts: ["x.example.com"],
      },
    });
    expect(
      replaceAgentToolSelections(
        ctx(tenantC),
        BigInt(a.id),
        [{ source: "HTTP", toolDefinitionId: String(otherTd.id) }],
        appDb,
      ),
    ).rejects.toThrow();
  });

  test("create/update reject a system prompt over the cap with the localized error", async () => {
    const boom = "p".repeat(config.agent.promptMaxChars + 1);
    try {
      await createAgent(
        ctx(tenantC),
        { name: "TooBig", systemPrompt: boom },
        appDb,
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PromptTooLongError);
      expect((e as PromptTooLongError).statusCode).toBe(400);
      expect((e as PromptTooLongError).translationKey).toBe(
        "errors.promptTooLong",
      );
    }
    const a = await createAgent(ctx(tenantC), { name: "CapProbe" }, appDb);
    await expect(
      updateAgent(ctx(tenantC), BigInt(a.id), { systemPrompt: boom }, appDb),
    ).rejects.toThrow(/system prompt is too long/);
  });

  test("a system prompt exactly at the cap is accepted", async () => {
    const max = "p".repeat(config.agent.promptMaxChars);
    const a = await createAgent(
      ctx(tenantC),
      { name: "AtCap", systemPrompt: max },
      appDb,
    );
    expect(a.systemPrompt).toHaveLength(config.agent.promptMaxChars);
  });

  // Operator prose inside `settings` is clamped by the READERS (readToolInstructions and friends), so
  // an over-cap note used to save with a 200 and reach the model cut in half, with the console still
  // showing the whole text it had hydrated from the row. The write boundary is where the operator can
  // still act on it, and it is the only one every transport (console, REST, MCP) goes through.
  test("update rejects over-cap tool guidance and leaves the stored value alone", async () => {
    const a = await createAgent(
      ctx(tenantC),
      {
        name: "GuidanceCap",
        settings: { handoff: { mode: "route", instructions: "short" } },
      },
      appDb,
    );
    const boom = "g".repeat(TOOL_INSTRUCTIONS_MAX + 1);
    try {
      await updateAgent(
        ctx(tenantC),
        BigInt(a.id),
        { settings: { handoff: { mode: "route", instructions: boom } } },
        appDb,
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsTextTooLongError);
      expect((e as SettingsTextTooLongError).statusCode).toBe(400);
      expect((e as SettingsTextTooLongError).translationKey).toBe(
        "errors.settingsTextTooLong",
      );
      expect((e as SettingsTextTooLongError).message).toContain(
        "handoff.instructions",
      );
    }
    const after = await getAgent(ctx(tenantC), BigInt(a.id), appDb);
    expect(readHandoffConfig(after.settings).instructions).toBe("short");
  });

  test("the refusal covers every capped field, not just the handoff one", async () => {
    const a = await createAgent(ctx(tenantC), { name: "GuidanceCap2" }, appDb);
    const cases: Record<string, unknown>[] = [
      { kanban: { instructions: "k".repeat(TOOL_INSTRUCTIONS_MAX + 1) } },
      {
        toolGuidance: {
          assign_label: "l".repeat(TOOL_INSTRUCTIONS_MAX + 1),
        },
      },
      { guardrails: { customPolicy: "p".repeat(CUSTOM_POLICY_MAX + 1) } },
      {
        vision: {
          extractionPrompt: "v".repeat(EXTRACTION_PROMPT_MAX + 1),
        },
      },
      {
        followUp: {
          steps: [{ instructions: "f".repeat(FOLLOW_UP_INSTRUCTIONS_MAX + 1) }],
        },
      },
    ];
    for (const settings of cases) {
      expect(
        updateAgent(ctx(tenantC), BigInt(a.id), { settings }, appDb),
      ).rejects.toBeInstanceOf(SettingsTextTooLongError);
    }
  });

  // Only text the write introduces or changes is refused. A value stored before the caps existed
  // cannot be one: several of these fields have no control in the editor at all (a note for a native
  // tool like private_note) or only render once their section is switched on, so refusing it would
  // block every save on every tab with nothing the operator could shorten.
  test("a stored over-cap value does not block a save that leaves it alone", async () => {
    const a = await createAgent(ctx(tenantC), { name: "LegacyCap" }, appDb);
    const legacy = "c".repeat(TOOL_INSTRUCTIONS_MAX + 1);
    await suDb.agent.update({
      where: { id: BigInt(a.id) },
      data: { settings: { handoff: { instructions: legacy } } },
    });

    const saved = await updateAgent(
      ctx(tenantC),
      BigInt(a.id),
      {
        settings: {
          handoff: { instructions: legacy },
          kanban: { instructions: "move it" },
        },
      },
      appDb,
    );
    const bag = saved.settings as Record<
      string,
      Record<string, string> | undefined
    >;
    expect(bag.kanban?.instructions).toBe("move it");
    // Untouched means untouched: the row keeps every character, and the reader is what keeps the
    // model-facing copy short.
    expect(bag.handoff?.instructions).toBe(legacy);

    // Editing that same field is a write like any other, even to a shorter value that is still over.
    expect(
      updateAgent(
        ctx(tenantC),
        BigInt(a.id),
        { settings: { handoff: { instructions: `${legacy}!` } } },
        appDb,
      ),
    ).rejects.toBeInstanceOf(SettingsTextTooLongError);
  });

  // A stale editor resends the settings it loaded. If the other writer edited a capped field, our
  // copy of that field is an edit too — so validating before the version check would answer 400
  // "text too long" to what is really a conflict, and the editor's reload-or-overwrite flow would
  // never run for it.
  test("a stale write gets the conflict, not the cap error", async () => {
    const a = await createAgent(ctx(tenantC), { name: "StaleCap" }, appDb);
    const legacy = "s".repeat(TOOL_INSTRUCTIONS_MAX + 1);
    const seeded = await suDb.agent.update({
      where: { id: BigInt(a.id) },
      data: { settings: { handoff: { instructions: legacy } } },
      select: { updatedAt: true },
    });
    // Someone else shortens it while this editor holds the old bag. The stamp is set explicitly
    // because `updatedAt` is client-side and ms-resolution: two back-to-back writes land in the
    // same millisecond often enough to matter (3 in 40 here), and when they do the held token
    // still matches, no conflict is raised, and the cap check answers the 400 this test forbids.
    await suDb.agent.update({
      where: { id: BigInt(a.id) },
      data: {
        settings: { handoff: { instructions: "short now" } },
        updatedAt: new Date(seeded.updatedAt.getTime() + 1000),
      },
    });
    try {
      await updateAgent(
        ctx(tenantC),
        BigInt(a.id),
        { settings: { handoff: { instructions: legacy } } },
        appDb,
        { expectedUpdatedAt: seeded.updatedAt },
      );
      expect.unreachable();
    } catch (e) {
      expect(e).not.toBeInstanceOf(SettingsTextTooLongError);
      expect((e as AppError).statusCode).toBe(409);
      expect((e as AppError).translationKey).toBe(
        "errors.agentModifiedElsewhere",
      );
    }
    // The overwrite carries no precondition, and IS validated: this bag re-introduces the long note.
    expect(
      updateAgent(
        ctx(tenantC),
        BigInt(a.id),
        { settings: { handoff: { instructions: legacy } } },
        appDb,
      ),
    ).rejects.toBeInstanceOf(SettingsTextTooLongError);
  });

  // A clone authors nothing — it replicates a row that already exists in this tenant. Refusing it
  // would leave a legacy agent unclonable while its own saves go through.
  test("cloning carries a stored over-cap value forward verbatim", async () => {
    const a = await createAgent(ctx(tenantC), { name: "CloneSrc" }, appDb);
    const legacy = "c".repeat(TOOL_INSTRUCTIONS_MAX + 1);
    await suDb.agent.update({
      where: { id: BigInt(a.id) },
      data: { settings: { handoff: { instructions: legacy } } },
    });
    const clone = await cloneAgent(
      ctx(tenantC),
      BigInt(a.id),
      "CloneDst",
      appDb,
    );
    const bag = clone.settings as Record<
      string,
      Record<string, string> | undefined
    >;
    expect(bag.handoff?.instructions).toBe(legacy);
  });

  test("create rejects it too, and a value exactly at the cap is accepted", async () => {
    expect(
      createAgent(
        ctx(tenantC),
        {
          name: "CreateTooBig",
          settings: {
            handoff: { instructions: "g".repeat(TOOL_INSTRUCTIONS_MAX + 1) },
          },
        },
        appDb,
      ),
    ).rejects.toBeInstanceOf(SettingsTextTooLongError);
    const ok = await createAgent(
      ctx(tenantC),
      {
        name: "CreateAtCap",
        settings: {
          handoff: { instructions: "g".repeat(TOOL_INSTRUCTIONS_MAX) },
        },
      },
      appDb,
    );
    expect(readHandoffConfig(ok.settings).instructions).toHaveLength(
      TOOL_INSTRUCTIONS_MAX,
    );
  });
});
