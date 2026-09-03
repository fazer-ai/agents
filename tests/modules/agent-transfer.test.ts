import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { normalizeToolName } from "@/graph/tools/toolName";
import type { TenantContext } from "@/lib/tenancy";
import { TOOL_INSTRUCTIONS_MAX } from "@/modules/agents/text-caps";
import {
  type AgentExport,
  configBusinessHoursId,
  EXPORTED_COMPONENT_KEYS,
  exportAgent,
  importAgent,
  remapConfigBusinessHoursIdToName,
} from "@/modules/agents/transfer";
import { documentStarter } from "@/modules/documents/starters";
import { createDocumentTemplate } from "@/modules/documents/templates";

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
let agentId = 0n;

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Which schedule an integration config points at, decided in one place because the export asks it
// twice — once to BUNDLE the schedule and once to rewrite the id to a portable NAME — and the two
// answering differently is a bundle whose config still carries a destination-invalid id.
//
// The padded row is the one that matters. `resolveBusinessHoursId` in the Calendar toolpack trims
// before reading, so `" 7 "` is a WORKING configuration pointing at schedule 7; a reader here that
// refused it would drop from the export a schedule the tool actually uses. Trimmed, then bounded.
describe("the schedule an integration config references", () => {
  test("a plain id, and the padded spelling the runtime already accepts", () => {
    expect(configBusinessHoursId({ businessHoursId: "7" })).toBe(7n);
    expect(configBusinessHoursId({ businessHoursId: " 7 " })).toBe(7n);
    expect(configBusinessHoursId({ businessHoursId: "007" })).toBe(7n);
  });

  test("no reference at all", () => {
    for (const config of [
      null,
      {},
      { businessHoursId: "" },
      { businessHoursId: "   " },
      { businessHoursId: null },
      { businessHoursId: 7 },
    ]) {
      expect(configBusinessHoursId(config)).toBeNull();
    }
  });

  test("a value BigInt would convert but a bigint column would not", () => {
    for (const raw of ["99999999999999999999", "0x7", "+7", "1e3", "-7"]) {
      expect(configBusinessHoursId({ businessHoursId: raw })).toBeNull();
    }
  });

  // …and the rewrite reads the SAME answer, so a padded ref leaves as a name like any other.
  test("the id→name rewrite resolves what the bundling resolves", () => {
    const names = new Map([["7", "Clinic hours"]]);
    expect(
      remapConfigBusinessHoursIdToName({ businessHoursId: " 7 " }, names),
    ).toEqual({ businessHoursId: "Clinic hours" });
    expect(
      remapConfigBusinessHoursIdToName({ businessHoursId: "7" }, names),
    ).toEqual({ businessHoursId: "Clinic hours" });
    // An id no bundled schedule matches is left exactly as it was, config and all.
    const untouched = { businessHoursId: "9", timeZone: "UTC" };
    expect(remapConfigBusinessHoursIdToName(untouched, names)).toBe(untouched);
  });
});

// A dry run discloses every component array a bundle can carry, and the list is read off the
// schema so it cannot forget one. Code tools (issue #363) are one of them.
describe("the component arrays a bundle can carry", () => {
  test("include code tools", () => {
    expect(EXPORTED_COMPONENT_KEYS).toContain("codeTools");
  });
});

describe.skipIf(!dbUp)("agent export/import", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "XF", slug: `xf-${process.pid}` },
    });
    tenantId = t.id;
    const td = await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: "lookup_order",
        label: "Lookup order",
        method: "GET",
        urlTemplate: "https://api.example.com/o/{{id}}",
        allowedHosts: ["api.example.com"],
        credentialRef: "shop-key",
      },
    });
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "FAQ" },
    });
    // The agent stores credentialRefs in the real `vault:<id>` form; export translates id → name
    // (portable) and import translates name → id in the target tenant.
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: "x" },
      select: { id: true },
    });
    const ttsKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "tts-key", secret: "x" },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Vendedora",
        systemPrompt: "Você vende bem.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          // TWO credentials in one block: the voice engine's and the speech rewrite's own model.
          // The second one is the one a per-block loop misses, and then export refuses the whole
          // agent (a tenant-local vault:<id> survives into the file) while import cannot rewire it.
          tts: {
            mode: "never",
            credentialRef: `vault:${ttsKey.id}`,
            normalize: true,
            normalizeProvider: "openai",
            normalizeCredentialRef: `vault:${llmKey.id}`,
          },
          // And the block that three private copies of the credential-path list did not know: with it
          // out of the list, this same export threw 500 ("unresolved vault reference"), because the
          // id survived translation and the leak defense caught it.
          guardrails: {
            enabled: true,
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
        },
      },
    });
    agentId = agent.id;
    await suDb.agentToolSelection.createMany({
      data: [
        {
          tenantId,
          agentId,
          source: "HTTP",
          toolDefinitionId: td.id,
          enabledTools: [],
          knowledgeBaseIds: [],
        },
        {
          tenantId,
          agentId,
          source: "RAG",
          enabledTools: ["search_knowledge"],
          knowledgeBaseIds: [kb.id],
        },
      ],
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "agent_tool_selections",
        "agents",
        "tool_definitions",
        "knowledge_bases",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("export references by name and carries no secret value", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    expect(exp.kind).toBe("fazer-ai.agent");
    expect(exp.agent.name).toBe("Vendedora");
    // credentialRef is a NAME, not a secret
    expect(exp.agent.modelConfig.credentialRef).toBe("llm-key");
    const http = exp.agent.tools.find((g) => g?.source === "HTTP");
    expect(http && "tool" in http && http.tool).toBe("lookup_order");
    const rag = exp.agent.tools.find((g) => g?.source === "RAG");
    expect(rag && "knowledgeBases" in rag && rag.knowledgeBases).toEqual([
      "FAQ",
    ]);
    // No raw vault names leak as secrets; serialized form has no sk- material.
    expect(JSON.stringify(exp)).not.toMatch(/sk-[A-Za-z0-9]{16}/);
    // And no tenant-local `vault:<id>` survives translation (the export guard backstops this).
    expect(JSON.stringify(exp)).not.toContain("vault:");
    // Both credentials of the tts block, by name.
    const tts = (exp.agent.settings as Record<string, Record<string, unknown>>)
      .tts;
    expect(tts?.credentialRef).toBe("tts-key");
    expect(tts?.normalizeCredentialRef).toBe("llm-key");
    const guardrails = (
      exp.agent.settings as Record<string, Record<string, unknown>>
    ).guardrails;
    expect(guardrails?.credentialRef).toBe("llm-key");
  });

  // A hand-written export is operator input like any other, and it lands through a third write path.
  // The host list is reduced to hosts there too, or an imported bundle reintroduces exactly what the
  // editor and the update path were taught not to store.
  test("an imported host list is reduced to hosts before it is stored", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const imported = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora importada",
        settings: {
          ...exp.agent.settings,
          sendImage: {
            allowedHosts: [
              "https://usuario:senha-secreta@cdn.loja.com.br/x.png?sig=deadbeef",
            ],
          },
        },
      },
    };
    const { agent } = await importAgent(ctx(), imported, appDb);
    const row = await suDb.agent.findFirstOrThrow({
      where: { id: BigInt(agent.id) },
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

  // Direct writes REFUSE over-cap operator prose so nobody loses text without being told. An import
  // is a payload authored somewhere else, and refusing the whole bundle over a long note would be a
  // worse trade than the one this path already makes everywhere else: normalize, and say what was
  // normalized. Clamping here is also what keeps the imported agent saveable afterwards.
  test("an imported note over the cap is clamped before storage, with a warning naming the field", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const imported = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora prolixa",
        settings: {
          ...exp.agent.settings,
          handoff: {
            mode: "route",
            instructions: "i".repeat(TOOL_INSTRUCTIONS_MAX + 40),
          },
        },
      },
    };
    const { agent, warnings } = await importAgent(ctx(), imported, appDb);
    const row = await suDb.agent.findFirstOrThrow({
      where: { id: BigInt(agent.id) },
      select: { settings: true },
    });
    const ho = (row.settings as Record<string, unknown>).handoff as Record<
      string,
      unknown
    >;
    expect((ho.instructions as string).length).toBe(TOOL_INSTRUCTIONS_MAX);
    expect(ho.mode).toBe("route");
    const w = warnings.find((x) => x.code === "guidanceClipped");
    expect(w?.params?.field).toBe("handoff.instructions");
    expect(w?.params?.max).toBe(TOOL_INSTRUCTIONS_MAX);
  });

  // THE HALF THAT DECIDES WHETHER `__proto__` IS A PROBLEM AT ALL, and it is measured here because
  // this is the only path that can carry the key that far. Import copies the settings bag verbatim
  // on purpose (a rule on a non-native tool name has to survive a transfer), and the bundle's
  // `settings` is a `z.record` whose values are `z.unknown()` — passed by reference, own keys intact.
  // So the key reaches the `agent.create` call, where REST and MCP would both have lost it.
  //
  // It still never reaches Postgres: Prisma rebuilds the JSON value, and the rebuild drops it. That
  // is what makes the whole question moot — `agent_settings_get` can never return an entry under this
  // name, so there is nothing for the MCP surface's ignored tombstone to fail to delete. Nothing in
  // src/ enforces this; the assertion below is the enforcement, and it reads the RAW jsonb rather
  // than the Prisma-decoded row, because a value stored and not decoded would look identical there.
  //
  // Note the payload is parsed, not written as a literal: `__proto__:` in an object literal sets the
  // prototype instead of creating the own key this is about. See tool-keyed-unwritable.test.ts.
  test("an imported tool rule named `__proto__` never reaches storage (Prisma drops it)", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const imported = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora proto",
        settings: {
          ...exp.agent.settings,
          toolPreconditions: JSON.parse(
            '{"__proto__":{"kind":"attribute","scope":"contact","key":"x"},"handoff_to_human":{"kind":"attribute","scope":"contact","key":"cpf"}}',
          ),
          toolGuidance: JSON.parse(
            '{"__proto__":"nunca","constructor":"sobrevive","handoff_to_human":"peça o CPF"}',
          ),
        },
      },
    };
    const { agent } = await importAgent(ctx(), imported, appDb);
    const raw = await suDb.$queryRaw<Array<{ j: string }>>`
      SELECT settings::text AS j FROM agents WHERE id = ${BigInt(agent.id)}`;
    expect(raw[0]?.j.includes("__proto__")).toBe(false);
    const stored = JSON.parse(raw[0]?.j ?? "{}") as Record<string, unknown>;
    // Everything else in both blocks is stored untouched: nothing here sanitizes, and `constructor`
    // is the control — every bit as prototype-ish, and it IS storable, because zod keeps it and both
    // runtime maps are null-prototype.
    const pre = stored.toolPreconditions as Record<string, unknown>;
    const gui = stored.toolGuidance as Record<string, unknown>;
    expect((pre.handoff_to_human as Record<string, unknown>).key).toBe("cpf");
    expect(gui.handoff_to_human).toBe("peça o CPF");
    // `getOwnPropertyDescriptor`, because `gui.constructor` reads the INHERITED one — which is also
    // the reason a name like this is worth a control: it is stored as an own key and only an own-key
    // read proves it.
    expect(Object.getOwnPropertyDescriptor(gui, "constructor")?.value).toBe(
      "sobrevive",
    );
  });

  // The sharp end of clipping by UTF-16 unit: an emoji straddling the cutoff leaves an unpaired
  // surrogate, which Postgres refuses in jsonb, so the whole import would fail on a note that merely
  // had an emoji at the wrong offset.
  test("an imported note clipped mid-emoji still stores (no unpaired surrogate)", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const imported = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora emoji",
        settings: {
          ...exp.agent.settings,
          handoff: {
            mode: "route",
            instructions: `${"i".repeat(TOOL_INSTRUCTIONS_MAX - 1)}😀 e mais texto`,
          },
        },
      },
    };
    const { agent } = await importAgent(ctx(), imported, appDb);
    const row = await suDb.agent.findFirstOrThrow({
      where: { id: BigInt(agent.id) },
      select: { settings: true },
    });
    const stored = (
      (row.settings as Record<string, unknown>).handoff as Record<
        string,
        unknown
      >
    ).instructions as string;
    expect(stored.length).toBe(TOOL_INSTRUCTIONS_MAX - 1);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(stored)).toBe(false);
  });

  test("round-trip import recreates the agent DISABLED with resolved refs", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const imported = { ...exp, agent: { ...exp.agent, name: "Vendedora 2" } };
    const { agent, warnings } = await importAgent(ctx(), imported, appDb);
    expect(agent.name).toBe("Vendedora 2");
    // Imported agents always land DISABLED and in TEST mode (never live by default), regardless of the
    // source agent's state.
    expect(agent.enabled).toBe(false);
    expect(agent.mode).toBe("test");
    expect(warnings).toEqual([]);
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id) },
      select: { source: true, toolDefinitionId: true, knowledgeBaseIds: true },
    });
    expect(
      grants.find((g) => g.source === "HTTP")?.toolDefinitionId,
    ).not.toBeNull();
    expect(
      grants.find((g) => g.source === "RAG")?.knowledgeBaseIds.length,
    ).toBe(1);
  });

  test("missing agent credentials become pending vault entries wired to the agent", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const dst = await suDb.tenant.create({
      data: { name: "XF Dst", slug: `xf-dst-${process.pid}` },
    });
    try {
      const dstCtx: TenantContext = {
        tenantId: dst.id,
        userId: null,
        role: "TENANT_ADMIN",
      };
      const { agent, warnings } = await importAgent(dstCtx, exp, appDb);
      // A credential absent in the target tenant is no longer dropped: a reference-only PENDING entry
      // is created (name + kind) and the ref stays wired, so the operator only fills the secret. The
      // warning deep-links to the vault (where the pending secret is filled), not the editor field.
      for (const name of ["llm-key", "tts-key"]) {
        const w = warnings.find(
          (x) => x.code === "credentialPending" && x.params?.name === name,
        );
        expect(w?.target).toEqual({ kind: "vault" });
        const entry = await suDb.vaultEntry.findFirst({
          where: { tenantId: dst.id, name },
        });
        expect(entry?.status).toBe("pending");
      }
      // The model credential ref is wired to the freshly-created pending entry (not left unset).
      const row = await suDb.agent.findUnique({
        where: { id: BigInt(agent.id) },
      });
      const mc = (row?.modelConfig ?? {}) as Record<string, unknown>;
      expect(mc.credentialRef as string).toMatch(/^vault:/);
    } finally {
      for (const table of [
        "agent_tool_selections",
        "agents",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${dst.id}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${dst.id}`);
    }
  });

  test("import warns (does not crash) on a missing reference", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const broken: AgentExport = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Broken",
        tools: [{ source: "HTTP", tool: "does_not_exist", enabledTools: [] }],
      },
    };
    const { agent, warnings } = await importAgent(ctx(), broken, appDb);
    expect(
      warnings.some(
        (w) =>
          w.code === "httpGrantNotFound" && w.params?.name === "does_not_exist",
      ),
    ).toBe(true);
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id) },
    });
    expect(grants).toHaveLength(0); // the unresolved grant was skipped, agent still created
  });

  test("export includes credentials metadata with name and kind", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    expect(exp.agent.credentials).toBeDefined();
    const creds = exp.agent.credentials ?? [];
    // The agent has two credential refs: llm-key (modelConfig) and tts-key (settings.tts).
    expect(creds).toHaveLength(2);
    expect(
      creds.every(
        (c) => typeof c.name === "string" && typeof c.kind === "string",
      ),
    ).toBe(true);
    const names = creds.map((c) => c.name).sort();
    expect(names).toEqual(["llm-key", "tts-key"]);
    // Default kind is "generic".
    expect(creds.every((c) => c.kind === "generic")).toBe(true);
  });

  test("import with metadata resolves by (name, kind) even when the same name exists under a different kind", async () => {
    // Create a duplicate-name entry under a different kind in the same tenant.
    await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", kind: "bearer", secret: "y" },
    });
    const exp = await exportAgent(ctx(), agentId, appDb);
    // The export carries credentials: [{name:"llm-key",kind:"generic"}, ...].
    // Import should resolve llm-key to the "generic" entry, not the "bearer" one.
    const imported = {
      ...exp,
      agent: { ...exp.agent, name: "Vendedora Kind" },
    };
    const { agent, warnings } = await importAgent(ctx(), imported, appDb);
    expect(warnings).toEqual([]);
    expect(agent.enabled).toBe(false);
    // modelConfig.credentialRef must point to the "generic" llm-key entry, not the "bearer" one.
    const row = await suDb.agent.findUnique({
      where: { id: BigInt(agent.id) },
    });
    const mc = (row?.modelConfig ?? {}) as Record<string, unknown>;
    const resolvedRef = mc.credentialRef as string;
    expect(resolvedRef).toMatch(/^vault:/);
    const resolvedId = BigInt(resolvedRef.replace("vault:", ""));
    const entry = await suDb.vaultEntry.findUnique({
      where: { id: resolvedId },
    });
    expect(entry?.kind).toBe("generic");
    // Cleanup: remove the bearer duplicate and the imported agent to keep test isolation.
    await suDb.agent.delete({ where: { id: BigInt(agent.id) } });
    await suDb.vaultEntry.deleteMany({
      where: { tenantId, name: "llm-key", kind: "bearer" },
    });
  });

  test("import REJECTS a payload without the credentials metadata", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    // The metadata is mandatory (no legacy fallback): stripping it fails schema validation.
    const { credentials: _c, ...agentWithoutCreds } = exp.agent;
    const stripped = {
      ...exp,
      agent: { ...agentWithoutCreds, name: "Vendedora SemMeta" },
    };
    await expect(importAgent(ctx(), stripped, appDb)).rejects.toThrow(
      /invalid agent export payload/,
    );
  });

  test("import REJECTS a system prompt over the cap with the specific error", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    const oversized = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora PromptGigante",
        systemPrompt: "p".repeat(config.agent.promptMaxChars + 1),
      },
    };
    await expect(importAgent(ctx(), oversized, appDb)).rejects.toThrow(
      /system prompt is too long/,
    );
  });

  test("import with CONFLICTING metadata (same name under two kinds) warns and leaves the ref unset", async () => {
    const exp = await exportAgent(ctx(), agentId, appDb);
    // Craft an export whose metadata lists llm-key under TWO kinds: the bare-name refs in the
    // JSON cannot tell which path meant which credential, so the import must refuse to guess.
    const conflicted = {
      ...exp,
      agent: {
        ...exp.agent,
        name: "Vendedora Conflito",
        credentials: [
          ...(exp.agent.credentials ?? []),
          { name: "llm-key", kind: "bearer_token" },
        ],
      },
    };
    const { agent, warnings } = await importAgent(ctx(), conflicted, appDb);
    expect(
      warnings.some(
        (w) => w.code === "credentialAmbiguous" && w.params?.name === "llm-key",
      ),
    ).toBe(true);
    const row = await suDb.agent.findUnique({
      where: { id: BigInt(agent.id) },
    });
    const mc = (row?.modelConfig ?? {}) as Record<string, unknown>;
    expect(mc.credentialRef).toBeUndefined();
    // Cleanup.
    await suDb.agent.delete({ where: { id: BigInt(agent.id) } });
  });

  test("export REFUSES when a concrete secret leaked into the config", async () => {
    const leaky = await suDb.agent.create({
      data: {
        tenantId,
        name: "Leaky",
        systemPrompt: "x",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "sk-abcdef0123456789abcdef",
        },
      },
    });
    await expect(exportAgent(ctx(), leaky.id, appDb)).rejects.toThrow();
  });
});

// Phase D: export with ?components=true bundles full component defs; import creates the missing ones
// (fresh integration route token, EMPTY KB) before resolving grants, reusing same-name components.
describe.skipIf(!dbUp)("agent export/import with components", () => {
  let srcTenant = 0n;
  let dstTenant = 0n;
  let srcAgentId = 0n;

  const srcCtx = (): TenantContext => ({
    tenantId: srcTenant,
    userId: null,
    role: "TENANT_ADMIN",
  });
  const dstCtx = (): TenantContext => ({
    tenantId: dstTenant,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    const s = await suDb.tenant.create({
      data: { name: "CompSrc", slug: `comp-src-${process.pid}` },
    });
    srcTenant = s.id;
    const d = await suDb.tenant.create({
      data: { name: "CompDst", slug: `comp-dst-${process.pid}` },
    });
    dstTenant = d.id;

    const key = await suDb.vaultEntry.create({
      data: { tenantId: srcTenant, name: "shop-key", secret: "x" },
      select: { id: true },
    });
    const td = await suDb.toolDefinition.create({
      data: {
        tenantId: srcTenant,
        name: "lookup_order",
        label: "Buscar pedido",
        method: "GET",
        urlTemplate: "https://api.example.com/o/{{id}}",
        allowedHosts: ["api.example.com"],
        credentialRef: `vault:${key.id}`,
        // A lookup that answers 404 for "no such order" is the canonical case of issue #59, and it
        // is exactly the sort of tool an operator moves between instances.
        expectedStatuses: [404],
        // Same shape of statement, one issue later (#352): what this tool's response says about an
        // appointment.
        appointment: {
          action: "book",
          idPath: "data.id",
          startPath: "data.start",
          reminderOffsetsHours: [24, 1],
          askConfirmationOnLast: true,
        },
        // And the same shape again, one issue later still (#456): what the response looks like by
        // the time it reaches the model.
        outputSchema: {
          mode: "template",
          template: "Pedido {{data.id}} — {{data.status}}",
        },
      },
    });
    const mcp = await suDb.mcpServerConnection.create({
      data: {
        tenantId: srcTenant,
        name: "tools-server",
        transport: "streamableHttp",
        url: "https://mcp.example.com",
      },
    });
    const integ = await suDb.integrationInstance.create({
      data: {
        tenantId: srcTenant,
        catalogType: "ASAAS",
        name: "Pagamentos",
        config: { foo: "bar" },
        inboundAuthStrategy: "STATIC_HEADER",
        inboundSecretRef: `vault:${key.id}`,
        routeTokenHash: `src-hash-${process.pid}`,
      },
    });
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: srcTenant, name: "Catálogo", chunkSize: 500 },
    });
    const bh = await suDb.businessHours.create({
      data: {
        tenantId: srcTenant,
        name: "Comercial",
        timezone: "America/Sao_Paulo",
        windows: [],
        // Date exceptions are part of the schedule, so they have to travel with it. Nothing in the
        // type system says so: the bundle carries the schedule as raw JSON, and a forgotten field
        // here would arrive at the destination as a schedule that quietly forgot its holidays.
        exceptions: [
          { date: "2026-09-07", label: "Independência", ranges: [] },
        ],
      },
    });
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      srcCtx(),
      {
        name: "Orçamento",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        numberPrefix: "ORC-",
      },
      appDb,
    );
    const agent = await suDb.agent.create({
      data: {
        tenantId: srcTenant,
        name: "Comp Agent",
        systemPrompt: "x",
        businessHoursId: bh.id,
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
      },
    });
    srcAgentId = agent.id;
    const offTpl = await createDocumentTemplate(
      srcCtx(),
      {
        name: "Desativado",
        slug: "desativado",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        enabled: false,
      },
      appDb,
    );
    // A code tool the agent is granted (issue #363). Its body is the "wiring", the way an HTTP
    // tool's request is, and it travels in the bundle for the same reason; the grant names it by
    // NAME, like every other component.
    const codeTool = await suDb.codeToolDefinition.create({
      data: {
        tenantId: srcTenant,
        name: "validar_cpf",
        label: "Validar CPF",
        description: "Valida o dígito verificador de um CPF.",
        inputSchema: { cpf: { type: "string", description: "CPF" } },
        code: "return { valid: /^\\d{11}$/.test(input.cpf) };",
      },
    });
    await suDb.agentToolSelection.createMany({
      data: [
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "HTTP",
          toolDefinitionId: td.id,
          enabledTools: [],
          knowledgeBaseIds: [],
        },
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "CODE",
          codeToolDefinitionId: codeTool.id,
          enabledTools: [],
          knowledgeBaseIds: [],
        },
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "MCP",
          mcpServerConnectionId: mcp.id,
          enabledTools: ["do_thing"],
          knowledgeBaseIds: [],
        },
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "INTEGRATION",
          integrationInstanceId: integ.id,
          enabledTools: [],
          knowledgeBaseIds: [],
        },
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "RAG",
          enabledTools: ["search_knowledge"],
          knowledgeBaseIds: [kb.id],
        },
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "DOCUMENT",
          documentTemplateId: BigInt(tpl.id),
          enabledTools: [],
          knowledgeBaseIds: [],
        },
        {
          tenantId: srcTenant,
          agentId: srcAgentId,
          source: "DOCUMENT",
          documentTemplateId: BigInt(offTpl.id),
          enabledTools: [],
          knowledgeBaseIds: [],
        },
      ],
    });
  });

  afterAll(async () => {
    for (const tid of [srcTenant, dstTenant]) {
      if (!tid) continue;
      for (const table of [
        "agent_tool_selections",
        "agents",
        "tool_definitions",
        "code_tool_definitions",
        "mcp_server_connections",
        "integration_instances",
        "knowledge_bases",
        "document_templates",
        "business_hours",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
  });

  test("export with components bundles full defs and leaks no secret/token", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    expect(exp.components).toBeDefined();
    const c = exp.components;
    expect(c?.httpTools.find((h) => h.name === "lookup_order")?.label).toBe(
      "Buscar pedido",
    );
    // credentialRef is a NAME, never a vault:<id>.
    expect(c?.httpTools[0]?.credentialRef).toBe("shop-key");
    expect(c?.mcpServers.find((m) => m.name === "tools-server")).toBeDefined();
    expect(c?.integrations.find((i) => i.name === "Pagamentos")).toBeDefined();
    expect(c?.knowledgeBases.find((k) => k.name === "Catálogo")).toBeDefined();
    // A DOCUMENT grant names a template by SLUG, so the template itself has to travel with it —
    // otherwise the import has a grant pointing at a component the destination never heard of, and
    // the only thing it can do is drop the grant with a warning.
    expect(
      c?.documentTemplates?.find((tpl) => tpl.slug === "orcamento")?.blocks
        ?.length,
    ).toBeGreaterThan(0);
    // A template the operator turned OFF is off for a reason: omitted from the bundle, the import
    // recreates it with the column default and the destination agent can issue a document the
    // source instance had deliberately made unavailable.
    expect(
      c?.documentTemplates?.find((tpl) => tpl.slug === "desativado")?.enabled,
    ).toBe(false);
    // Business hours are bundled so the import can recreate them.
    expect(c?.businessHours?.some((h) => h.name === "Comercial")).toBe(true);
    expect(
      c?.businessHours?.find((h) => h.name === "Comercial")?.exceptions,
    ).toEqual([{ date: "2026-09-07", label: "Independência", ranges: [] }]);
    const json = JSON.stringify(exp);
    // No inbound secret / route token hash / vault id ever travels.
    expect(json).not.toContain("vault:");
    expect(json).not.toContain("src-hash");
    expect(json).not.toContain("inboundSecretRef");
    expect(json).not.toContain("routeTokenHash");
    // meta block present (item 2).
    expect(exp.meta?.appVersion).toBeDefined();
  });

  // A template's prose is TENANT CONTENT, like a knowledge-base document's text. The scanner cannot
  // tell an operator writing "api_key=abcdef" into a quote's terms from a leaked credential, and
  // refusing there would make that operator's own agent unexportable — the guard blocking the thing
  // it exists to protect.
  test("exports a template whose prose looks like a secret", async () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      srcCtx(),
      {
        name: "Termos técnicos",
        slug: "termos_tecnicos",
        blocks: [
          {
            id: "t",
            type: "text",
            text: "Configure o webhook com api_key=abcdef0123456789abcdef e avise o time.",
          },
        ],
        // A field's DESCRIPTION is prose for the same reason: it is what the operator writes to tell
        // the model what belongs in the field, and an example is exactly where a credential-shaped
        // string appears. Its `name` and `type` are the tool contract and stay scanned.
        fields: [
          {
            name: "chave",
            label: "Chave",
            type: "text",
            description:
              "a chave do cliente, ex: api_key=abcdef0123456789abcdef",
          },
        ],
        style: starter.style,
      },
      appDb,
    );
    const agent = await suDb.agent.findUnique({ where: { id: srcAgentId } });
    if (!agent) throw new Error("no agent");
    await suDb.agentToolSelection.create({
      data: {
        tenantId: srcTenant,
        agentId: srcAgentId,
        source: "DOCUMENT",
        documentTemplateId: BigInt(tpl.id),
        enabledTools: [],
        knowledgeBaseIds: [],
      },
    });
    try {
      const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
        includeComponents: true,
      });
      const exported = exp.components?.documentTemplates?.find(
        (t) => t.slug === "termos_tecnicos",
      );
      // …and the prose is still THERE, in both halves: blanking happens on the scan clone, not on
      // the bundle a destination has to be able to import.
      expect(JSON.stringify(exported?.blocks)).toContain("api_key=");
      expect(JSON.stringify(exported?.fields)).toContain("api_key=");
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM agent_tool_selections WHERE document_template_id = ${BigInt(tpl.id)}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM document_templates WHERE id = ${BigInt(tpl.id)}`,
      );
    }
  });

  // Review round 1, finding 3, and its sibling. The import writes STRAIGHT to the DB, so every
  // field it copies has to pass through the reader the runtime uses — `expectedStatuses` and
  // `appointment` already did, `outputSchema` and `method` did not. A hand-edited bundle is the
  // only way to reach either, which is exactly why nothing caught them.
  test("a hand-edited bundle cannot plant a template the runtime would ignore", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const broken = JSON.parse(JSON.stringify(exp)) as AgentExport;
    const name = `edited_template_${process.pid}`;
    const tool = broken.components?.httpTools?.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = name;
    // Declared, and unusable: `{{data. status}}` is not a path, so the write schema refuses it.
    tool.outputSchema = {
      mode: "template",
      template: "Pedido {{data. status}}",
    };
    if (broken.agent.tools) {
      for (const g of broken.agent.tools) {
        if (g && "tool" in g && g.tool === "lookup_order") g.tool = name;
      }
    }
    broken.agent.name = `Edited template ${process.pid}`;
    const { agent } = await importAgent(dstCtx(), broken, appDb);
    const td = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name },
    });
    // DROPPED rather than stored: parked in the column it would read as "no template" at runtime
    // and as a legacy JSON Schema in the editor, with nothing anywhere saying why the projection
    // stopped. The import cannot refuse the way the service does — a bundle is handed over whole.
    expect(td?.outputSchema).toEqual({});
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM tool_definitions WHERE tenant_id = ${dstTenant} AND name = '${name}'`,
    );
  });

  test("a hand-edited bundle cannot plant an HTTP method the platform does not send", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const broken = JSON.parse(JSON.stringify(exp)) as AgentExport;
    const name = `edited_method_${process.pid}`;
    const tool = broken.components?.httpTools?.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = name;
    tool.method = "PURGE";
    if (broken.agent.tools) {
      for (const g of broken.agent.tools) {
        if (g && "tool" in g && g.tool === "lookup_order") g.tool = name;
      }
    }
    broken.agent.name = `Edited method ${process.pid}`;
    const { agent, warnings } = await importAgent(dstCtx(), broken, appDb);
    expect(
      warnings.some(
        (w) =>
          w.code === "httpToolMethodUnsupported" &&
          w.params?.method === "PURGE",
      ),
    ).toBe(true);
    // Skipped, not coerced: falling back to GET would change what the tool does, which is the
    // difference from the body shape two lines above it in the importer.
    expect(
      await suDb.toolDefinition.count({
        where: { tenantId: dstTenant, name },
      }),
    ).toBe(0);
    // And a lowercase method is the SAME request, so it imports.
    const lower = JSON.parse(JSON.stringify(broken)) as AgentExport;
    const lowerName = `edited_lower_${process.pid}`;
    const lt = lower.components?.httpTools?.find((h) => h.name === name);
    if (!lt) throw new Error("bundle missing the edited tool");
    lt.name = lowerName;
    lt.method = "get";
    if (lower.agent.tools) {
      for (const g of lower.agent.tools) {
        if (g && "tool" in g && g.tool === name) g.tool = lowerName;
      }
    }
    lower.agent.name = `Edited lower ${process.pid}`;
    const second = await importAgent(dstCtx(), lower, appDb);
    expect(
      (
        await suDb.toolDefinition.findFirst({
          where: { tenantId: dstTenant, name: lowerName },
        })
      )?.method,
    ).toBe("GET");
    for (const id of [agent.id, second.agent.id]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(id)}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE id = ${BigInt(id)}`,
      );
    }
    await suDb.$executeRawUnsafe(
      `DELETE FROM tool_definitions WHERE tenant_id = ${dstTenant} AND name = '${lowerName}'`,
    );
  });

  test("import into a fresh tenant creates the missing components (fresh token, empty KB) then grants", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const { agent, warnings } = await importAgent(dstCtx(), exp, appDb);
    // Components created on the destination tenant.
    const td = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "lookup_order" },
    });
    expect(td?.label).toBe("Buscar pedido");
    // Review finding, round 1: a declaration dropped in transfer makes the destination resume
    // alerting on a status the operator had already ruled a result, with nothing to point at.
    expect(td?.expectedStatuses).toEqual([404]);
    // (#352) And the appointment declaration, for the same reason one issue later: a bundle that
    // drops it re-imports a tool that books appointments the destination never hears about — no
    // follow-up pause, no reminder, nothing in the prompt, and nothing saying why.
    expect(td?.appointment).toEqual({
      action: "book",
      // The provider travels with it too: it is half the appointment identity, so a bundle that
      // drops it re-imports a tool whose bookings collide with another system's ids.
      provider: "declared",
      idPath: "data.id",
      startPath: "data.start",
      reminderOffsetsHours: [24, 1],
      askConfirmationOnLast: true,
    });
    // (#456) And the response template, for the third time the same reason: a bundle that drops it
    // re-imports a tool that hands the model the first 4000 characters of a response instead of the
    // four fields the operator picked, and nothing anywhere says the projection stopped.
    expect(td?.outputSchema).toEqual({
      mode: "template",
      template: "Pedido {{data.id}} — {{data.status}}",
    });
    // credential absent on the destination ⇒ re-created as a PENDING entry with the ref kept wired
    // (the operator only fills the secret), not dropped.
    expect(td?.credentialRef).toMatch(/^vault:/);
    const shopKey = await suDb.vaultEntry.findFirst({
      where: { tenantId: dstTenant, name: "shop-key" },
    });
    expect(shopKey?.status).toBe("pending");
    const mcp = await suDb.mcpServerConnection.findFirst({
      where: { tenantId: dstTenant, name: "tools-server" },
    });
    expect(mcp).not.toBeNull();
    const integ = await suDb.integrationInstance.findFirst({
      where: { tenantId: dstTenant, catalogType: "ASAAS", name: "Pagamentos" },
    });
    expect(integ).not.toBeNull();
    // Fresh route token (not the source's) + inbound auth reset.
    expect(integ?.routeTokenHash).not.toBe(`src-hash-${process.pid}`);
    expect(integ?.inboundSecretRef).toBeNull();
    expect(integ?.inboundAuthStrategy).toBe("NONE");
    const kb = await suDb.knowledgeBase.findFirst({
      where: { tenantId: dstTenant, name: "Catálogo" },
    });
    expect(kb?.chunkSize).toBe(500);
    // KB created empty (no bundled documents). Creation is SILENT now — only a reuse warns — so no
    // kbCreatedEmpty warning fires; the empty base just exists.
    expect(warnings.some((w) => w.code === "kbCreatedEmpty")).toBe(false);
    const kbDocCount = await suDb.knowledgeDocument.count({
      where: { tenantId: dstTenant, knowledgeBaseId: kb?.id },
    });
    expect(kbDocCount).toBe(0);
    // Business hours were recreated on the destination and linked to the agent — also silently.
    const bh = await suDb.businessHours.findFirst({
      where: { tenantId: dstTenant, name: "Comercial" },
    });
    expect(bh).not.toBeNull();
    expect(bh?.exceptions).toEqual([
      { date: "2026-09-07", label: "Independência", ranges: [] },
    ]);
    const agentRow = await suDb.agent.findUnique({
      where: { id: BigInt(agent.id) },
      select: { businessHoursId: true },
    });
    expect(agentRow?.businessHoursId).not.toBeNull();
    expect(warnings.some((w) => w.code === "hoursCreated")).toBe(false);
    // Grants resolved to the just-created components.
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id) },
      select: { source: true },
    });
    expect(grants.map((g) => g.source).sort()).toEqual([
      "CODE",
      "DOCUMENT",
      "DOCUMENT",
      "HTTP",
      "INTEGRATION",
      "MCP",
      "RAG",
    ]);
    // The template itself was recreated on the destination, and the grant points at THAT row —
    // a DOCUMENT grant carrying the source tenant's id would reach across the fence or resolve to
    // nothing at all.
    const dstTemplate = await suDb.documentTemplate.findFirst({
      where: { tenantId: dstTenant, slug: "orcamento" },
      select: { id: true, numberPrefix: true },
    });
    expect(dstTemplate?.numberPrefix).toBe("ORC-");
    // …and the disabled one arrives disabled.
    const dstOff = await suDb.documentTemplate.findFirst({
      where: { tenantId: dstTenant, slug: "desativado" },
      select: { enabled: true },
    });
    expect(dstOff?.enabled).toBe(false);
    const docGrant = await suDb.agentToolSelection.findFirst({
      where: { agentId: BigInt(agent.id), source: "DOCUMENT" },
      select: { documentTemplateId: true },
    });
    expect(docGrant?.documentTemplateId).toBe(dstTemplate?.id as bigint);
  });

  // A bundle is user-supplied, and a template's slug becomes a TOOL NAME. One reading `image`
  // produces `send_image`, which the assembly then drops as a duplicate of the built-in: the
  // operator would see a granted template whose tool never shows up, with nothing saying why. The
  // import applies the same slug gate a hand-written template passes.
  test("refuses an imported template whose slug would collide with a built-in", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp);
    const tpl = tampered.components?.documentTemplates?.find(
      (t) => t.slug === "orcamento",
    );
    if (!tpl) throw new Error("bundle missing the document template");
    tpl.slug = "image";
    const { agent, warnings } = await importAgent(dstCtx(), tampered, appDb);
    expect(warnings.some((w) => w.code === "documentTemplateInvalid")).toBe(
      true,
    );
    expect(
      await suDb.documentTemplate.count({
        where: { tenantId: dstTenant, slug: "image" },
      }),
    ).toBe(0);
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
  });

  // A bundle is hand-editable and this import writes to the table directly, so every rule the normal
  // write applies has to be applied here too. The description is the one that bites: it is appended
  // verbatim to the agent's tool description on every turn of the DESTINATION.
  test("refuses an imported template whose metadata breaks the write's own rules", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp);
    const tpl = tampered.components?.documentTemplates?.find(
      (t) => t.slug === "orcamento",
    );
    if (!tpl) throw new Error("bundle missing the document template");
    tpl.slug = "orcamento_importado";
    tpl.description = "x".repeat(2_001);
    const { agent, warnings } = await importAgent(dstCtx(), tampered, appDb);
    expect(warnings.some((w) => w.code === "documentTemplateInvalid")).toBe(
      true,
    );
    expect(
      await suDb.documentTemplate.count({
        where: { tenantId: dstTenant, slug: "orcamento_importado" },
      }),
    ).toBe(0);
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
  });

  // The gate and the WRITE have to agree on what the value is. `templateNameSchema` trims before it
  // measures, so a name padded with whitespace passes a check the raw string would fail — and this
  // path wrote the raw string. The name becomes the tool's title, which every granted agent carries
  // on every turn, so a hand-edited bundle could plant a huge one past a bound that had just
  // approved it.
  test("stores the name the metadata gate approved, not the raw one", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp);
    const tpl = tampered.components?.documentTemplates?.find(
      (t) => t.slug === "orcamento",
    );
    if (!tpl) throw new Error("bundle missing the document template");
    tpl.slug = "orcamento_espacado";
    // Under the 120-character bound once trimmed, far past it as written. The name is also distinct
    // from every template this destination holds: names are unique per tenant, so reusing "Orçamento"
    // here would be testing that constraint instead of the trim.
    tpl.name = `${" ".repeat(500)}Orçamento espaçado${" ".repeat(500)}`;
    const { agent, warnings } = await importAgent(dstCtx(), tampered, appDb);
    expect(warnings.some((w) => w.code === "documentTemplateInvalid")).toBe(
      false,
    );
    const row = await suDb.documentTemplate.findFirst({
      where: { tenantId: dstTenant, slug: "orcamento_espacado" },
      select: { name: true },
    });
    expect(row?.name).toBe("Orçamento espaçado");
    await suDb.$executeRawUnsafe(
      `DELETE FROM document_templates WHERE tenant_id = ${dstTenant} AND slug = 'orcamento_espacado'`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
  });

  // Names are unique per tenant, so a bundle can arrive with a free slug and a name this account
  // already uses. That has to be a WARNING: it used to reach the unique index and come back as a
  // driver error, which fails the whole import over one component.
  test("warns instead of failing when the bundle's template name is taken here", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp);
    const tpl = tampered.components?.documentTemplates?.find(
      (t) => t.slug === "orcamento",
    );
    if (!tpl) throw new Error("bundle missing the document template");
    const taken = await suDb.documentTemplate.findFirst({
      where: { tenantId: dstTenant },
      select: { name: true },
    });
    if (!taken) throw new Error("destination has no template to collide with");
    tpl.slug = "orcamento_outro_slug";
    tpl.name = taken.name;
    const { agent, warnings } = await importAgent(dstCtx(), tampered, appDb);
    expect(warnings.some((w) => w.code === "documentTemplateNameTaken")).toBe(
      true,
    );
    // Nothing was written under the free slug, and the import still produced an agent.
    const row = await suDb.documentTemplate.findFirst({
      where: { tenantId: dstTenant, slug: "orcamento_outro_slug" },
      select: { id: true },
    });
    expect(row).toBeNull();
    expect(agent.id).toBeTruthy();
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
  });

  // The pre-check above answers "free", and the whole import runs inside ONE transaction. So a writer
  // that commits in the window between that answer and the insert does not cost one template: the
  // P2002 aborts the transaction, every statement after it fails with "current transaction is
  // aborted", and the operator loses the entire import — agent, tools, knowledge bases — to a race.
  //
  // A `catch` around the insert cannot fix that, which is the trap here: it looks like the remedy and
  // makes the failure less legible, because the transaction is already dead when it runs. Only NOT
  // RAISING works, which is what `ON CONFLICT DO NOTHING` does.
  //
  // The race is produced rather than waited for: the interceptor below commits the colliding row on
  // the SUPERUSER connection — a different transaction — at the moment the pre-check answers.
  test("survives a writer that takes the name between the check and the insert", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp);
    const tpl = tampered.components?.documentTemplates?.find(
      (t) => t.slug === "orcamento",
    );
    if (!tpl) throw new Error("bundle missing the document template");
    tpl.slug = `corrida_${process.pid}`;
    tpl.name = `Corrida ${process.pid}`;

    let raced = false;
    const racing = appDb.$extends({
      query: {
        documentTemplate: {
          async findFirst({ args, query }) {
            const answer = await query(args);
            // Fired on the NAME pre-check specifically, and measured rather than assumed: the first
            // version fired on the SLUG one, so the name check that runs next found the row and took
            // the ordinary warning path. The test passed against the unfixed code — a race test that
            // never reaches the race, which is worse than no test.
            const asksByName =
              (args as { where?: { name?: unknown } }).where?.name !==
              undefined;
            if (!raced && asksByName && answer === null) {
              raced = true;
              await suDb.documentTemplate.create({
                data: {
                  tenantId: dstTenant,
                  name: tpl.name,
                  slug: `outro_${process.pid}`,
                  blocks: [],
                  fields: [],
                  style: {},
                },
              });
            }
            return answer;
          },
        },
      },
    });

    const { agent, warnings } = await importAgent(
      dstCtx(),
      tampered,
      racing as unknown as typeof appDb,
    );
    // The rendezvous actually happened. Without this the test passes just as well when the
    // interceptor never fired and no race was ever created.
    expect(raced).toBe(true);
    // The import completed, which is the whole point: an agent came back.
    expect(agent.id).toBeTruthy();
    expect(warnings.some((w) => w.code === "documentTemplateNameTaken")).toBe(
      true,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
    await suDb.documentTemplate.deleteMany({
      where: { tenantId: dstTenant, name: tpl.name },
    });
  });

  // Same race, three more call sites (issue #221). Each of the loops below pre-checks a DIFFERENT
  // unique index, so a note on the test above would prove nothing about them: `ON CONFLICT DO
  // NOTHING` has to be reached through each loop's own data. What a lost race costs is not the
  // component but the IMPORT: the P2002 aborts the enclosing transaction, every statement after it
  // fails with "current transaction is aborted", and the operator loses the agent, the grants and
  // the knowledge bases to a collision over one name.
  //
  // The component is renamed to a value unique to this run rather than reusing the fixture's: the
  // fresh-tenant import test above already created `lookup_order`, `tools-server` and `Pagamentos`
  // on the destination and left them there, so a pre-check against those answers "taken" and the
  // race never happens. The grant still names the fixture, which is why the import warns
  // `httpGrantNotFound` here and the assertions do not look at that one.
  test("survives a writer that takes the HTTP tool name between the check and the insert", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp);
    const tool = tampered.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing the http tool");
    tool.name = `corrida_http_${process.pid}`;
    // A body shape this version does not execute, so the loop has something to say about it. The
    // assertion below is that it says nothing: the warning describes a row that was never written.
    tool.body = { contact: { email: "{{email}}" } };

    let raced = false;
    const racing = appDb.$extends({
      query: {
        toolDefinition: {
          async findFirst({ args, query }) {
            const answer = await query(args);
            // Matched against the name under test, not just "the first miss": the import asks this
            // table again when it resolves the HTTP grant, and a looser guard would fire on that
            // call instead, which happens after the insert it is supposed to race.
            const asksForIt =
              (args as { where?: { name?: unknown } }).where?.name ===
              tool.name;
            if (!raced && asksForIt && answer === null) {
              raced = true;
              await suDb.toolDefinition.create({
                data: {
                  tenantId: dstTenant,
                  name: tool.name,
                  label: "Tomado por outro",
                  method: "GET",
                  urlTemplate: "https://api.example.com/x",
                  allowedHosts: ["api.example.com"],
                },
              });
            }
            return answer;
          },
        },
      },
    });

    const { agent, warnings } = await importAgent(
      dstCtx(),
      tampered,
      racing as unknown as typeof appDb,
    );
    // The rendezvous actually happened. Without this the test passes just as well when the
    // interceptor never fired and no race was ever created.
    expect(raced).toBe(true);
    expect(agent.id).toBeTruthy();
    expect(warnings.some((w) => w.code === "httpToolReused")).toBe(true);
    // The reuse the pre-check reports says nothing about the body, and neither does the reuse the
    // insert reports: the tool that survived is the one already there, with its own body.
    expect(warnings.some((w) => w.code === "httpToolBodyIgnored")).toBe(false);
    // What the issue is actually about: the statements AFTER the losing insert still ran. The grants
    // are written at the very end of the same transaction, so a count here is the proof that it was
    // never aborted.
    const grants = await suDb.agentToolSelection.count({
      where: { agentId: BigInt(agent.id) },
    });
    expect(grants).toBeGreaterThan(0);
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
    await suDb.toolDefinition.deleteMany({
      where: { tenantId: dstTenant, name: tool.name },
    });
  });

  test("survives a writer that takes the MCP connection name between the check and the insert", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp);
    const conn = tampered.components?.mcpServers.find(
      (m) => m.name === "tools-server",
    );
    if (!conn) throw new Error("bundle missing the mcp connection");
    conn.name = `corrida_mcp_${process.pid}`;

    let raced = false;
    const racing = appDb.$extends({
      query: {
        mcpServerConnection: {
          async findFirst({ args, query }) {
            const answer = await query(args);
            const asksForIt =
              (args as { where?: { name?: unknown } }).where?.name ===
              conn.name;
            if (!raced && asksForIt && answer === null) {
              raced = true;
              await suDb.mcpServerConnection.create({
                data: {
                  tenantId: dstTenant,
                  name: conn.name,
                  transport: "streamableHttp",
                  url: "https://outro.example.com",
                },
              });
            }
            return answer;
          },
        },
      },
    });

    const { agent, warnings } = await importAgent(
      dstCtx(),
      tampered,
      racing as unknown as typeof appDb,
    );
    expect(raced).toBe(true);
    expect(agent.id).toBeTruthy();
    expect(warnings.some((w) => w.code === "mcpReused")).toBe(true);
    const grants = await suDb.agentToolSelection.count({
      where: { agentId: BigInt(agent.id) },
    });
    expect(grants).toBeGreaterThan(0);
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
    await suDb.mcpServerConnection.deleteMany({
      where: { tenantId: dstTenant, name: conn.name },
    });
  });

  test("survives a writer that takes the integration name between the check and the insert", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp);
    const integ = tampered.components?.integrations.find(
      (i) => i.name === "Pagamentos",
    );
    if (!integ) throw new Error("bundle missing the integration");
    integ.name = `Corrida ${process.pid}`;
    // A schedule reference this destination cannot resolve, for the same reason as the body above:
    // it belongs to the config THIS iteration built, and that config is discarded on a reuse.
    integ.config = { businessHoursId: `Agenda ausente ${process.pid}` };

    let raced = false;
    const racing = appDb.$extends({
      query: {
        integrationInstance: {
          async findFirst({ args, query }) {
            const answer = await query(args);
            const asksForIt =
              (args as { where?: { name?: unknown } }).where?.name ===
              integ.name;
            if (!raced && asksForIt && answer === null) {
              raced = true;
              await suDb.integrationInstance.create({
                data: {
                  tenantId: dstTenant,
                  catalogType: integ.catalogType,
                  name: integ.name,
                  config: {},
                  routeTokenHash: `corrida-hash-${process.pid}`,
                },
              });
            }
            return answer;
          },
        },
      },
    });

    const { agent, warnings } = await importAgent(
      dstCtx(),
      tampered,
      racing as unknown as typeof appDb,
    );
    expect(raced).toBe(true);
    expect(agent.id).toBeTruthy();
    expect(warnings.some((w) => w.code === "integrationReused")).toBe(true);
    expect(warnings.some((w) => w.code === "hoursNotFound")).toBe(false);
    const grants = await suDb.agentToolSelection.count({
      where: { agentId: BigInt(agent.id) },
    });
    expect(grants).toBeGreaterThan(0);
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
    await suDb.integrationInstance.deleteMany({
      where: { tenantId: dstTenant, name: integ.name },
    });
  });

  // A discriminated union refuses the WHOLE array on one unknown arm, so a grant of a source a newer
  // release added would make an otherwise importable agent unimportable — and say nothing about
  // which part was the problem. Dropped with a count instead.
  test("skips a grant whose source this build does not know", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp) as unknown as {
      agent: { tools: unknown[] };
    };
    tampered.agent.tools.push({ source: "HOLOGRAM", projector: "x" });
    const { agent, warnings } = await importAgent(
      dstCtx(),
      tampered as never,
      appDb,
    );
    expect(warnings.some((w) => w.code === "unknownGrantSourceSkipped")).toBe(
      true,
    );
    // …and everything else still arrived.
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id) },
      select: { source: true },
    });
    expect(grants.length).toBeGreaterThan(3);
    await suDb.$executeRawUnsafe(
      `DELETE FROM agent_tool_selections WHERE agent_id = ${BigInt(agent.id)}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE id = ${BigInt(agent.id)}`,
    );
  });

  // The other side of the tolerant fallback: a grant from a source we DO know, missing its required
  // field, is a broken bundle — not a newer version's doing. Swallowing it would drop the grant in
  // silence and blame the wrong thing.
  test("refuses a malformed grant from a source it knows", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const tampered = structuredClone(exp) as unknown as {
      agent: { tools: unknown[] };
    };
    tampered.agent.tools.push({ source: "DOCUMENT" });
    await expect(
      importAgent(dstCtx(), tampered as never, appDb),
    ).rejects.toThrow();
  });

  test("import canonicalizes legacy authoring shapes (JSON-Schema inputSchema, single-brace {var})", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    // NOTE: simulate a bundle exported from a pre-normalization instance: rename the tool so the
    // import creates it fresh, and regress its shapes to the legacy authoring forms.
    const legacy = structuredClone(exp);
    const tool = legacy.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "legacy_lookup";
    tool.urlTemplate = "https://shop.example.com/orders/{order_id}";
    tool.inputSchema = {
      required: ["order_id"],
      properties: { order_id: { type: "string" } },
    };
    const grant = legacy.agent.tools.find(
      (g) => g?.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source === "HTTP") grant.tool = "legacy_lookup";
    await importAgent(dstCtx(), legacy, appDb);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "legacy_lookup" },
    });
    expect(row?.urlTemplate).toBe(
      "https://shop.example.com/orders/{{order_id}}",
    );
    expect(row?.inputSchema).toEqual({
      order_id: { type: "string", required: true },
    });
  });

  test("a bundle this build produces still carries riskTier, for an older importer (issues #137, #149)", async () => {
    // The other direction of the same compatibility, and the reason the KEY outlives the column.
    // The bundle format is versioned as a whole, so an instance one release behind parses OUR bundle
    // with a schema where `riskTier` is REQUIRED — dropping the key from the export would make every
    // bundle this build writes unimportable there. Since #149 the value is a constant rather than
    // the row's, because the schema `@ignore`s the column so this build never names it in SQL, which
    // is what lets the next release drop it. What this pins is the SHAPE the
    // older importer requires, which is all that stands between a bundle and a validation failure at
    // the destination. The literal below stands in for that older required-field check.
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const previousReleaseShape = z.object({ riskTier: z.string() });
    for (const tool of exp.components?.httpTools ?? []) {
      expect(previousReleaseShape.safeParse(tool).success).toBe(true);
    }
  });

  test("a bundle carrying the retired riskTier still imports (issue #137)", async () => {
    // Bundles exported before the risk tier was dropped carry `riskTier` on every HTTP tool. The
    // import schema is a plain z.object, which STRIPS unknown keys — the removal is only safe as
    // long as that holds, so pin it against a bundle from an older instance.
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const dated = structuredClone(exp);
    const tool = dated.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "retired_tier_lookup";
    (tool as unknown as Record<string, unknown>).riskTier = "high";
    const grant = dated.agent.tools.find(
      (g) => g?.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source === "HTTP") grant.tool = "retired_tier_lookup";
    await importAgent(dstCtx(), dated, appDb);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "retired_tier_lookup" },
    });
    expect(row?.name).toBe("retired_tier_lookup");
  });

  test("re-import reuses same-name components (never overwrites) and warns", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const before = await suDb.toolDefinition.count({
      where: { tenantId: dstTenant, name: "lookup_order" },
    });
    const { warnings } = await importAgent(dstCtx(), exp, appDb);
    const after = await suDb.toolDefinition.count({
      where: { tenantId: dstTenant, name: "lookup_order" },
    });
    expect(after).toBe(before); // not duplicated
    expect(
      warnings.some(
        (w) => w.code === "httpToolReused" && w.params?.name === "lookup_order",
      ),
    ).toBe(true);
  });

  // Round 15 of PR #485: a bundle authored before a native took the name. The assembly reserves
  // every native name (#457), so a tool imported under one would exist in the console and never
  // reach the model, and this path writes straight to the DB, past the service's refusal. Renamed
  // the way the migration renames a row already there — the first free `<name>_N` — and warned;
  // the grant follows the tool, not the name it had in the bundle.
  test("a bundled HTTP tool named after a native lands under a free name, warned, and its grant follows", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const tool = bundle.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "skip_reply";
    const grant = bundle.agent.tools.find(
      (g) => g?.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source === "HTTP") grant.tool = "skip_reply";
    // `skip_reply_2` already exists on the destination: it is REUSED, warned, the way any same-name
    // component is — a second import of the same bundle lands on the same row (round 17), and the
    // bundle's tool is not stored under a third name.
    const existing = await suDb.toolDefinition.create({
      data: {
        tenantId: dstTenant,
        name: "skip_reply_2",
        label: "Já existia",
        method: "GET",
        urlTemplate: "https://api.example.com/x",
        allowedHosts: ["api.example.com"],
      },
    });
    const { agent, warnings } = await importAgent(dstCtx(), bundle, appDb);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "skip_reply_2" },
    });
    expect(row?.id).toBe(existing.id);
    expect(row?.label).toBe("Já existia");
    expect(
      await suDb.toolDefinition.count({
        where: {
          tenantId: dstTenant,
          name: { in: ["skip_reply", "skip_reply_3"] },
        },
      }),
    ).toBe(0);
    expect(
      warnings.some(
        (w) =>
          w.code === "httpToolRenamed" &&
          w.params?.name === "skip_reply" &&
          w.params?.renamed === "skip_reply_2",
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (w) => w.code === "httpToolReused" && w.params?.name === "skip_reply_2",
      ),
    ).toBe(true);
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id), source: "HTTP" },
      select: { toolDefinitionId: true },
    });
    expect(grants.map((g) => g.toolDefinitionId)).toEqual([row?.id ?? null]);
  });

  // Round 16: the free name was chosen against the rows already stored, and a bundle can carry the
  // suffix itself — `calculator` and `calculator_2` side by side. The native one took `_2`, the
  // genuine `_2` was then "reused" onto it, and two grants for one row broke the unique index and
  // aborted the whole import. The bundle's own names are taken before any suffix is chosen.
  test("a bundle carrying both a native name and its suffix keeps two rows and two grants", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const tool = bundle.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool || !bundle.components)
      throw new Error("bundle missing lookup_order");
    tool.name = "calculator";
    bundle.components.httpTools.push({
      ...structuredClone(tool),
      name: "calculator_2",
      label: "Segunda",
    });
    const grant = bundle.agent.tools.find(
      (g) => g?.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source !== "HTTP")
      throw new Error("bundle missing the HTTP grant");
    grant.tool = "calculator";
    bundle.agent.tools.push({ ...grant, tool: "calculator_2" });
    const { agent, warnings } = await importAgent(dstCtx(), bundle, appDb);
    const rows = await suDb.toolDefinition.findMany({
      where: { tenantId: dstTenant, name: { startsWith: "calculator" } },
      select: { id: true, name: true, label: true },
      orderBy: { name: "asc" },
    });
    expect(rows.map((r) => [r.name, r.label])).toEqual([
      ["calculator_2", "Segunda"],
      ["calculator_3", "Buscar pedido"],
    ]);
    expect(
      warnings.some(
        (w) =>
          w.code === "httpToolRenamed" && w.params?.renamed === "calculator_3",
      ),
    ).toBe(true);
    expect(warnings.some((w) => w.code === "httpToolReused")).toBe(false);
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id), source: "HTTP" },
      select: { toolDefinitionId: true },
    });
    expect(new Set(grants.map((g) => g.toolDefinitionId))).toEqual(
      new Set(rows.map((r) => r.id)),
    );
  });

  // Round 17: the free name was chosen past the rows already stored, so importing the same bundle
  // twice stored its native-named tool twice (`_2`, then `_3`), each agent bound to its own copy.
  // The renamed name is decided by the bundle alone, and a row already under it is reused like
  // every other same-name component.
  test("importing the same bundle twice binds both agents to one renamed row", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const tool = bundle.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "handoff_to_human";
    const grant = bundle.agent.tools.find(
      (g) => g?.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source === "HTTP") grant.tool = "handoff_to_human";
    const first = await importAgent(dstCtx(), structuredClone(bundle), appDb);
    const second = await importAgent(dstCtx(), structuredClone(bundle), appDb);
    const rows = await suDb.toolDefinition.findMany({
      where: { tenantId: dstTenant, name: { startsWith: "handoff_to_human" } },
      select: { id: true, name: true },
    });
    expect(rows.map((r) => r.name)).toEqual(["handoff_to_human_2"]);
    expect(
      second.warnings.some(
        (w) =>
          w.code === "httpToolReused" &&
          w.params?.name === "handoff_to_human_2",
      ),
    ).toBe(true);
    for (const { agent } of [first, second]) {
      const grants = await suDb.agentToolSelection.findMany({
        where: { agentId: BigInt(agent.id), source: "HTTP" },
        select: { toolDefinitionId: true },
      });
      expect(grants.map((g) => g.toolDefinitionId)).toEqual([
        rows[0]?.id ?? null,
      ]);
    }
  });

  // Round 18: a bundle can carry the same native-named component twice (a hand-edited file). Each
  // occurrence chose a new suffix and the last one overwrote the grant mapping, so one grant went
  // to the last row and the two of them collided on the unique index and aborted the import. The
  // name is chosen once per bundle name, and two grants on one row are one grant.
  test("the same native-named tool twice in a bundle lands once, and its two grants collapse to one", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const tool = bundle.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool || !bundle.components)
      throw new Error("bundle missing lookup_order");
    tool.name = "set_custom_attribute";
    bundle.components.httpTools.push({
      ...structuredClone(tool),
      label: "Cópia",
    });
    const grant = bundle.agent.tools.find(
      (g) => g?.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source !== "HTTP")
      throw new Error("bundle missing the HTTP grant");
    grant.tool = "set_custom_attribute";
    bundle.agent.tools.push({ ...grant });
    const { agent, warnings } = await importAgent(dstCtx(), bundle, appDb);
    const rows = await suDb.toolDefinition.findMany({
      where: {
        tenantId: dstTenant,
        name: { startsWith: "set_custom_attribute" },
      },
      select: { id: true, name: true, label: true },
    });
    expect(rows.map((r) => [r.name, r.label])).toEqual([
      ["set_custom_attribute_2", "Buscar pedido"],
    ]);
    expect(warnings.filter((w) => w.code === "httpToolRenamed")).toHaveLength(
      1,
    );
    expect(
      warnings.some(
        (w) =>
          w.code === "httpToolReused" &&
          w.params?.name === "set_custom_attribute_2",
      ),
    ).toBe(true);
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id), source: "HTTP" },
      select: { toolDefinitionId: true },
    });
    expect(grants.map((g) => g.toolDefinitionId)).toEqual([
      rows[0]?.id ?? null,
    ]);
  });

  // Round 20: the console derives the name from the label on every save, so a renamed row whose
  // label still derived the reserved name could not be saved again from there. The label follows
  // the name where it derived the old one, and is the operator's own otherwise.
  test("a renamed tool's label follows the name where the console would derive the old one", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const tool = bundle.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "private_note";
    tool.label = "Private note";
    await importAgent(dstCtx(), bundle, appDb);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "private_note_2" },
      select: { label: true },
    });
    expect(row?.label).toBe("Private note 2");
    expect(normalizeToolName(row?.label ?? "")).toBe("private_note_2");
  });

  // Round 22: a label at the authoring limit (200) that derives the name cannot carry the suffix
  // without passing the limit, which would lock the row out of the console the other way; it
  // becomes the name itself, which derives to itself.
  test("a renamed tool's label at the authoring limit becomes the name", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const tool = bundle.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "react_to_message";
    tool.label = `react${" ".repeat(185)}to message`;
    await importAgent(dstCtx(), bundle, appDb);
    const row = await suDb.toolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "react_to_message_2" },
      select: { label: true },
    });
    expect(row?.label).toBe("react_to_message_2");
  });

  // Round 16: the rename was recorded and reported before the checks that can skip the component,
  // so a native-named tool with a method this version does not send was announced as imported
  // under a name no row carries, next to the warning that it was not imported.
  test("a native-named tool skipped for its method is not reported as renamed", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const tool = bundle.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "get_current_time";
    (tool as { method?: string }).method = "OPTIONS";
    const grant = bundle.agent.tools.find(
      (g) => g?.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source === "HTTP") grant.tool = "get_current_time";
    const { warnings } = await importAgent(dstCtx(), bundle, appDb);
    expect(
      warnings.some(
        (w) =>
          w.code === "httpToolMethodUnsupported" &&
          w.params?.name === "get_current_time",
      ),
    ).toBe(true);
    expect(warnings.some((w) => w.code === "httpToolRenamed")).toBe(false);
    expect(
      await suDb.toolDefinition.count({
        where: {
          tenantId: dstTenant,
          name: { startsWith: "get_current_time" },
        },
      }),
    ).toBe(0);
    expect(
      warnings.some(
        (w) =>
          w.code === "httpGrantNotFound" &&
          w.params?.name === "get_current_time",
      ),
    ).toBe(true);
  });

  // Issue #363: a code tool is a component like an HTTP tool. The body travels with the bundle
  // (it is the tool; a bundle without it imports a grant pointing at nothing) and the grant names
  // the tool by NAME. The body stays under the secret scanner: a key pasted into a comparison is
  // exactly what the scanner exists to catch, and there is no credential to name instead.
  test("export bundles the granted code tool, body included, and its grant by name", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const code = exp.components?.codeTools?.find(
      (c) => c.name === "validar_cpf",
    );
    expect(code?.code).toContain("input.cpf");
    expect(code?.label).toBe("Validar CPF");
    expect(code?.description).toBe("Valida o dígito verificador de um CPF.");
    expect(code?.enabled).toBe(true);
    expect(Object.keys(code?.inputSchema ?? {})).toEqual(["cpf"]);
    expect(exp.agent.tools).toContainEqual({
      source: "CODE",
      tool: "validar_cpf",
    });
    // The grant travels without the components too: it is a reference, and the component is what
    // makes the reference resolvable on a destination that never saw the tool.
    const bare = await exportAgent(srcCtx(), srcAgentId, appDb);
    expect(bare.agent.tools).toContainEqual({
      source: "CODE",
      tool: "validar_cpf",
    });
  });

  test("import creates the bundled code tool and its grant; a second import reuses the row, warned", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const code = bundle.components?.codeTools?.find(
      (c) => c.name === "validar_cpf",
    );
    if (!code) throw new Error("bundle missing validar_cpf");
    // NOTE: a name of its own, so this test owns the row it asserts on whatever imported before
    // it.
    code.name = "validar_cnpj";
    code.label = "Validar CNPJ";
    // NOTE: JSON-Schema-shaped, the way a hand-edited bundle spells it: the import writes past
    // the service, so it canonicalizes on the way in the way the service does.
    code.inputSchema = {
      type: "object",
      properties: { cnpj: { type: "string", description: "CNPJ" } },
      required: ["cnpj"],
    };
    const grant = bundle.agent.tools.find(
      (g) => g?.source === "CODE" && g.tool === "validar_cpf",
    );
    if (grant?.source !== "CODE") throw new Error("bundle missing the grant");
    grant.tool = "validar_cnpj";
    const first = await importAgent(dstCtx(), structuredClone(bundle), appDb);
    const row = await suDb.codeToolDefinition.findFirst({
      where: { tenantId: dstTenant, name: "validar_cnpj" },
    });
    expect(row?.label).toBe("Validar CNPJ");
    expect(row?.description).toBe("Valida o dígito verificador de um CPF.");
    expect(row?.code).toBe(code.code);
    expect(row?.enabled).toBe(true);
    expect(Object.keys(row?.inputSchema as object)).toEqual(["cnpj"]);
    expect(first.warnings.some((w) => w.code === "codeToolReused")).toBe(false);
    expect(first.warnings.some((w) => w.code === "codeGrantNotFound")).toBe(
      false,
    );
    const second = await importAgent(dstCtx(), structuredClone(bundle), appDb);
    expect(
      await suDb.codeToolDefinition.count({
        where: { tenantId: dstTenant, name: "validar_cnpj" },
      }),
    ).toBe(1);
    expect(second.warnings).toContainEqual({
      code: "codeToolReused",
      params: { name: "validar_cnpj" },
      target: { kind: "codeTool", name: "validar_cnpj" },
    });
    for (const { agent } of [first, second]) {
      const grants = await suDb.agentToolSelection.findMany({
        where: { agentId: BigInt(agent.id), source: "CODE" },
        select: { codeToolDefinitionId: true },
      });
      expect(grants.map((g) => g.codeToolDefinitionId)).toEqual([
        row?.id ?? null,
      ]);
    }
  });

  // The same two rules an HTTP tool answers to, and a third one of its own. A native's name is
  // reserved by the assembly (#457), so the tool moves to the first free `<name>_N`. And ONE
  // namespace reaches the model: the service refuses a code tool named like an HTTP tool where it
  // is typed (code-tools/service.ts), so a stored HTTP row under the name cannot be reused the way
  // a same-kind row is, and the tool moves to a free name too. Either way the grant follows.
  test("a bundled code tool named after a native, or like an HTTP tool the destination has, lands under a free name and its grant follows", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const code = bundle.components?.codeTools?.find(
      (c) => c.name === "validar_cpf",
    );
    if (!code || !bundle.components?.codeTools) {
      throw new Error("bundle missing validar_cpf");
    }
    code.name = "assign_label";
    code.label = "Assign label";
    bundle.components.codeTools.push({
      ...structuredClone(code),
      name: "consultar_cep",
      label: "Consultar CEP",
    });
    const grant = bundle.agent.tools.find(
      (g) => g?.source === "CODE" && g.tool === "validar_cpf",
    );
    if (grant?.source !== "CODE") throw new Error("bundle missing the grant");
    grant.tool = "assign_label";
    bundle.agent.tools.push({ source: "CODE", tool: "consultar_cep" });
    await suDb.toolDefinition.create({
      data: {
        tenantId: dstTenant,
        name: "consultar_cep",
        label: "Consultar CEP (HTTP)",
        method: "GET",
        urlTemplate: "https://api.example.com/cep",
        allowedHosts: ["api.example.com"],
      },
    });
    const { agent, warnings } = await importAgent(dstCtx(), bundle, appDb);
    const rows = await suDb.codeToolDefinition.findMany({
      where: {
        tenantId: dstTenant,
        OR: [
          { name: { startsWith: "assign_label" } },
          { name: { startsWith: "consultar_cep" } },
        ],
      },
      select: { id: true, name: true, label: true },
      orderBy: { name: "asc" },
    });
    // NOTE: the label follows the name where the console would derive the old one from it, the
    // same rule as an HTTP tool's (round 20 of PR #485).
    expect(rows.map((r) => [r.name, r.label])).toEqual([
      ["assign_label_2", "Assign label 2"],
      ["consultar_cep_2", "Consultar CEP 2"],
    ]);
    expect(warnings).toContainEqual({
      code: "codeToolRenamed",
      params: { name: "assign_label", renamed: "assign_label_2" },
      target: { kind: "codeTool", name: "assign_label_2" },
    });
    expect(warnings).toContainEqual({
      code: "codeToolRenamed",
      params: { name: "consultar_cep", renamed: "consultar_cep_2" },
      target: { kind: "codeTool", name: "consultar_cep_2" },
    });
    expect(warnings.some((w) => w.code === "codeToolReused")).toBe(false);
    expect(warnings.some((w) => w.code === "codeGrantNotFound")).toBe(false);
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: BigInt(agent.id), source: "CODE" },
      select: { codeToolDefinitionId: true },
    });
    expect(new Set(grants.map((g) => g.codeToolDefinitionId))).toEqual(
      new Set(rows.map((r) => r.id)),
    );
  });

  // The mirror of the cross-kind rule above. The HTTP service refuses a name a code tool holds
  // where it is typed (tool-definitions/service.ts asks the code table), and this path writes
  // past the service, so a bundled HTTP tool named like a code tool the destination stores would
  // land as a pair the assembly drops one of. It moves to the first free `<name>_N` instead, and
  // a second import of the same bundle lands on that row.
  test("a bundled HTTP tool named like a code tool the destination has lands under a free name, warned, and its grant follows", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const bundle = structuredClone(exp);
    const tool = bundle.components?.httpTools.find(
      (h) => h.name === "lookup_order",
    );
    if (!tool) throw new Error("bundle missing lookup_order");
    tool.name = "calcular_frete";
    tool.label = "Calcular frete";
    const grant = bundle.agent.tools.find(
      (g) => g?.source === "HTTP" && g.tool === "lookup_order",
    );
    if (grant?.source === "HTTP") grant.tool = "calcular_frete";
    const held = await suDb.codeToolDefinition.create({
      data: {
        tenantId: dstTenant,
        name: "calcular_frete",
        label: "Calcular frete (código)",
        description: "Calcula o frete.",
        code: "return 0;",
      },
    });
    const first = await importAgent(dstCtx(), structuredClone(bundle), appDb);
    const rows = await suDb.toolDefinition.findMany({
      where: { tenantId: dstTenant, name: { startsWith: "calcular_frete" } },
      select: { id: true, name: true, label: true },
    });
    expect(rows.map((r) => [r.name, r.label])).toEqual([
      ["calcular_frete_2", "Calcular frete 2"],
    ]);
    expect(first.warnings).toContainEqual({
      code: "httpToolRenamed",
      params: { name: "calcular_frete", renamed: "calcular_frete_2" },
      target: { kind: "tool", name: "calcular_frete_2" },
    });
    expect(first.warnings.some((w) => w.code === "httpToolReused")).toBe(false);
    // The code tool the destination had is untouched: the rename was the bundled tool's.
    expect(
      await suDb.codeToolDefinition.findUnique({
        where: { id: held.id },
        select: { name: true },
      }),
    ).toEqual({ name: "calcular_frete" });
    const second = await importAgent(dstCtx(), structuredClone(bundle), appDb);
    expect(
      second.warnings.some(
        (w) =>
          w.code === "httpToolReused" && w.params?.name === "calcular_frete_2",
      ),
    ).toBe(true);
    for (const { agent } of [first, second]) {
      const grants = await suDb.agentToolSelection.findMany({
        where: { agentId: BigInt(agent.id), source: "HTTP" },
        select: { toolDefinitionId: true },
      });
      expect(grants.map((g) => g.toolDefinitionId)).toEqual([
        rows[0]?.id ?? null,
      ]);
    }
  });

  // A grant naming a code tool the destination does not have (a bundle exported without
  // components) is dropped with a warning naming it, like an HTTP grant is.
  test("a CODE grant with no tool to land on is dropped, warned", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb);
    const bundle = structuredClone(exp);
    // NOTE: only the unresolvable grant, so the count below is about it and not about the
    // fixture's own code tool, which earlier imports already stored on the destination.
    bundle.agent.tools = bundle.agent.tools.filter((g) => g?.source !== "CODE");
    bundle.agent.tools.push({ source: "CODE", tool: "nunca_existiu" });
    const { agent, warnings } = await importAgent(dstCtx(), bundle, appDb);
    expect(warnings).toContainEqual({
      code: "codeGrantNotFound",
      params: { name: "nunca_existiu" },
      target: { kind: "codeTool", name: "nunca_existiu" },
    });
    expect(
      await suDb.agentToolSelection.count({
        where: { agentId: BigInt(agent.id), source: "CODE" },
      }),
    ).toBe(0);
  });

  // `run_code` was a native between PR #485 and issue #363, so a bundle exported in that window
  // names it in the NATIVE allowlist. The write boundary refuses an unknown native where it is
  // typed; here the name is dropped, said, and the rest of the allowlist lands.
  test("a NATIVE grant naming a tool this build does not have imports without it, warned", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb);
    const bundle = structuredClone(exp);
    bundle.agent.tools.push({
      source: "NATIVE",
      enabledTools: ["run_code", "calculator"],
    });
    const { agent, warnings } = await importAgent(dstCtx(), bundle, appDb);
    const native = await suDb.agentToolSelection.findFirst({
      where: { agentId: BigInt(agent.id), source: "NATIVE" },
      select: { enabledTools: true },
    });
    expect(native?.enabledTools).toEqual(["calculator"]);
    expect(warnings).toContainEqual({
      code: "nativeToolUnknown",
      params: { name: "run_code" },
    });
  });
});

// Phase 5: ?documents=true bundles the KB documents' SOURCE TEXT; import recreates them as UNINDEXED
// (no ingest job) for manual re-indexing; document content is exempt from the secret scan.
describe.skipIf(!dbUp)("agent export/import with KB documents", () => {
  let srcTenant = 0n;
  let dstTenant = 0n;
  let srcAgentId = 0n;

  const srcCtx = (): TenantContext => ({
    tenantId: srcTenant,
    userId: null,
    role: "TENANT_ADMIN",
  });
  const dstCtx = (): TenantContext => ({
    tenantId: dstTenant,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    const s = await suDb.tenant.create({
      data: { name: "DocsSrc", slug: `docs-src-${process.pid}` },
    });
    srcTenant = s.id;
    const d = await suDb.tenant.create({
      data: { name: "DocsDst", slug: `docs-dst-${process.pid}` },
    });
    dstTenant = d.id;

    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: srcTenant, name: "DocsKB", chunkSize: 700 },
    });
    await suDb.knowledgeDocument.createMany({
      data: [
        {
          tenantId: srcTenant,
          knowledgeBaseId: kb.id,
          title: "Guia",
          sourceType: "text",
          content: "Conteúdo do guia.",
          status: "READY",
          chunkCount: 1,
        },
        {
          tenantId: srcTenant,
          knowledgeBaseId: kb.id,
          title: "Chaves",
          sourceType: "file",
          fileName: "keys.txt",
          mimeType: "text/plain",
          // Secret-shaped string INSIDE a document: must NOT trip the export's secret scanner
          // (document content is tenant content, deliberately exempt).
          content: "A chave de exemplo é sk-abcdef0123456789abcdefghij.",
          status: "READY",
          chunkCount: 1,
        },
      ],
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: srcTenant,
        name: "Docs Agent",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
      },
    });
    srcAgentId = agent.id;
    await suDb.agentToolSelection.create({
      data: {
        tenantId: srcTenant,
        agentId: srcAgentId,
        source: "RAG",
        enabledTools: ["search_knowledge"],
        knowledgeBaseIds: [kb.id],
      },
    });
  });

  afterAll(async () => {
    for (const tid of [srcTenant, dstTenant]) {
      if (!tid) continue;
      for (const table of [
        "agent_tool_selections",
        "scheduler_jobs",
        "knowledge_chunks",
        "knowledge_documents",
        "knowledge_bases",
        "agents",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
  });

  test("export with ?documents bundles source text (last field) and exempts it from the scanner", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
      includeDocuments: true,
    });
    const kb = exp.components?.knowledgeBases.find((k) => k.name === "DocsKB");
    expect(kb?.documents).toHaveLength(2);
    expect(kb?.documents?.map((doc) => doc.title).sort()).toEqual([
      "Chaves",
      "Guia",
    ]);
    // The secret-shaped content survived (would have thrown if scanned).
    const keys = kb?.documents?.find((doc) => doc.title === "Chaves");
    expect(keys?.content).toContain("sk-abcdef0123456789abcdefghij");
    expect(keys?.fileName).toBe("keys.txt");
    // documents is appended LAST on each KB object.
    const kbKeys = Object.keys(kb ?? {});
    expect(kbKeys[kbKeys.length - 1]).toBe("documents");
  });

  test("export WITHOUT ?documents omits document text (back-compat)", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
    });
    const kb = exp.components?.knowledgeBases.find((k) => k.name === "DocsKB");
    expect(kb).toBeDefined();
    expect(kb?.documents).toBeUndefined();
  });

  test("import recreates documents as UNINDEXED with NO ingest job; content preserved", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
      includeDocuments: true,
    });
    const jobsBefore = await suDb.schedulerJob.count({
      where: { tenantId: dstTenant, kind: "RAG_INGEST" },
    });
    const { warnings } = await importAgent(dstCtx(), exp, appDb);
    const kb = await suDb.knowledgeBase.findFirst({
      where: { tenantId: dstTenant, name: "DocsKB" },
      select: { id: true },
    });
    const docs = await suDb.knowledgeDocument.findMany({
      where: { knowledgeBaseId: kb?.id },
      select: { title: true, status: true, content: true, chunkCount: true },
    });
    expect(docs).toHaveLength(2);
    expect(docs.every((doc) => doc.status === "UNINDEXED")).toBe(true);
    expect(docs.every((doc) => doc.chunkCount === 0)).toBe(true);
    expect(docs.find((doc) => doc.title === "Guia")?.content).toBe(
      "Conteúdo do guia.",
    );
    // Manual re-ingest: import must NOT enqueue any RAG_INGEST job.
    const jobsAfter = await suDb.schedulerJob.count({
      where: { tenantId: dstTenant, kind: "RAG_INGEST" },
    });
    expect(jobsAfter).toBe(jobsBefore);
    // Creating the docs is SILENT now (only reuse warns); the editor's live "needs indexing" alert
    // surfaces them instead. So no kbDocsImported warning — the UNINDEXED rows above are the contract.
    expect(warnings.some((w) => w.code === "kbDocsImported")).toBe(false);
  });

  test("re-import into a tenant that already has the base skips the bundled docs (no duplication)", async () => {
    const exp = await exportAgent(srcCtx(), srcAgentId, appDb, {
      includeComponents: true,
      includeDocuments: true,
    });
    const { warnings } = await importAgent(dstCtx(), exp, appDb);
    expect(
      warnings.some(
        (w) => w.code === "kbReusedDocsSkipped" && w.params?.name === "DocsKB",
      ),
    ).toBe(true);
    const kb = await suDb.knowledgeBase.findFirst({
      where: { tenantId: dstTenant, name: "DocsKB" },
      select: { id: true },
    });
    const docCount = await suDb.knowledgeDocument.count({
      where: { knowledgeBaseId: kb?.id },
    });
    expect(docCount).toBe(2);
  });
});
