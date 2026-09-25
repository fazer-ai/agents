import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { getAgentToolSelections } from "@/modules/agents/service";
import { exportAgent, importAgent } from "@/modules/agents/transfer";
import { shouldBotHandle } from "@/modules/chatwoot/normalize";
import { getCatalogEntry } from "@/modules/integrations/catalog";
import {
  CONVERSATION_REF_KIND,
  ensureConversationRef,
} from "@/modules/integrations/conversation-ref";
import { getMapper } from "@/modules/integrations/mappers";
import {
  createIntegrationInstance,
  GENERIC_INSTRUCTIONS_MAX_CHARS,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import { GENERIC_TEXT_MAX_CHARS } from "@/modules/integrations/types";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { toolCreate } from "@/modules/mcp/write-agents";
import {
  integrationCreate,
  integrationUpdate,
} from "@/modules/mcp/write-webhooks";
import {
  createToolDefinition,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import { DEFAULT_SIGNATURE_HEADER } from "@/modules/webhooks/inbound/auth";
import {
  DISPATCH_DEADLINE_MS,
  PROCESSING_STALE_MS,
  processInboundDelivery,
  receiveInbound,
} from "@/modules/webhooks/inbound/service";

// Issue #818: an external system of the operator's own speaking back into a conversation it was
// handed, through the GENERIC integration and `{{conversation_ref}}`.

describe("the GENERIC mapper", () => {
  const map = (raw: unknown) => getMapper("GENERIC")?.map(raw);

  test("the documented body becomes an agent_nudge keyed by the ref, deduped by event_id", () => {
    expect(
      map({
        event_id: "ev-1",
        conversation_ref: "cr_x",
        text: "linha 1\nlinha 2",
        status: "ok",
        extra: "ignored",
      }),
    ).toEqual({
      ok: true,
      event: {
        kind: "agent_nudge",
        externalId: "cr_x",
        dedupeKey: "ev-1",
        text: "linha 1\nlinha 2",
        status: "ok",
      },
    });
  });

  test("a missing field, a blank text and a text past the cap are invalid, not clipped", () => {
    for (const bad of [
      { conversation_ref: "cr_x", text: "t" },
      { event_id: "e", text: "t" },
      { event_id: "e", conversation_ref: "cr_x", text: "   \n " },
      {
        event_id: "e",
        conversation_ref: "cr_x",
        text: "x".repeat(GENERIC_TEXT_MAX_CHARS + 1),
      },
    ]) {
      expect(map(bad)).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(
      map({
        event_id: "e",
        conversation_ref: "cr_x",
        text: "x".repeat(GENERIC_TEXT_MAX_CHARS),
      }),
    ).toMatchObject({ ok: true });
  });

  test("the catalog entry is inbound-only, authenticated by default and not optional", () => {
    expect(getCatalogEntry("GENERIC")).toMatchObject({
      kind: "WEBHOOK",
      supportsInbound: true,
      defaultInboundAuth: "HMAC_SHA256",
      requiresInboundAuth: true,
    });
  });
});

describe("shouldBotHandle alsoResolved", () => {
  const OURS = { ourAgentBotId: 9 };
  test("a conversation the bot resolved is ours only when the caller asks", () => {
    const resolved = {
      status: "resolved",
      assigneeType: null,
      assigneeId: null,
      resolvedBy: "agent",
    };
    expect(shouldBotHandle(resolved, OURS)).toBe(false);
    expect(shouldBotHandle(resolved, { ...OURS, alsoResolved: true })).toBe(
      true,
    );
    for (const resolvedBy of ["followup_abandonment", "redirect_closing"]) {
      expect(
        shouldBotHandle(
          {
            status: "resolved",
            assigneeType: "AgentBot",
            assigneeId: 9,
            resolvedBy,
          },
          { ...OURS, alsoResolved: true },
        ),
      ).toBe(true);
    }
  });
  test("a person's, another bot's and a handed-off conversation stay closed", () => {
    for (const e of [
      {
        status: "resolved",
        assigneeType: "User",
        assigneeId: 3,
        resolvedBy: "agent",
      },
      {
        status: "resolved",
        assigneeType: "AgentBot",
        assigneeId: 10,
        resolvedBy: "agent",
      },
      { status: "open", assigneeType: null, assigneeId: null },
      { status: "snoozed", assigneeType: null, assigneeId: null },
    ]) {
      expect(shouldBotHandle(e, { ...OURS, alsoResolved: true })).toBe(false);
    }
  });
  // An operator resolving in Chatwoot leaves our AgentBot assigned, so the assignee cannot tell that
  // close from the agent's. Only the recorded origin can, and a close without one is not ours.
  test("a close nobody on the agent's side recorded is not the bot's, whatever the assignee", () => {
    for (const resolvedBy of [null, undefined, "console", "legacy_unknown"]) {
      expect(
        shouldBotHandle(
          {
            status: "resolved",
            assigneeType: "AgentBot",
            assigneeId: 9,
            resolvedBy,
          },
          { ...OURS, alsoResolved: true },
        ),
      ).toBe(false);
    }
  });
});

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
let dstTenantId = 0n;
const ctxOf = (t: bigint): TenantContext => ({
  tenantId: t,
  userId: null,
  role: "TENANT_ADMIN",
});
const ctx = () => ctxOf(tenantId);
const SECRET = "generic-hmac-secret";
const sign = (body: string) =>
  createHmac("sha256", SECRET).update(body).digest("hex");
const signed = (body: string) => (name: string) =>
  name.toLowerCase() === DEFAULT_SIGNATURE_HEADER ? sign(body) : null;

function principal(): VerifiedToken {
  return {
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
}

describe.skipIf(!dbUp)("GENERIC inbound end to end", () => {
  let secretRef = "";
  let genericId = 0n;
  let genericRoute = "";
  let otherGenericId = 0n;
  let otherGenericRoute = "";
  let asaasId = 0n;
  let asaasRoute = "";
  let agentId = 0n;
  const THREAD = () => `${tenantId}:1:900`;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "GEN", slug: `gen-${process.pid}` },
    });
    tenantId = t.id;
    const d = await suDb.tenant.create({
      data: { name: "GENDST", slug: `gen-dst-${process.pid}` },
    });
    dstTenantId = d.id;
    const v = await suDb.vaultEntry.create({
      data: { tenantId, name: "gen-hmac", secret: encryptJson(SECRET) },
      select: { id: true },
    });
    secretRef = `vault:${v.id}`;
    const g = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "GENERIC",
        name: "Relatórios",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: secretRef,
        config: { instructions: "Mande o relatório como veio." },
      },
      appDb,
    );
    genericId = g.id;
    genericRoute = g.routeToken as string;
    const o = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "GENERIC",
        name: "Outro sistema",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: secretRef,
      },
      appDb,
    );
    otherGenericId = o.id;
    otherGenericRoute = o.routeToken as string;
    const a = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "ASAAS",
        name: "Pagamentos",
        inboundAuthStrategy: "NONE",
        config: { notifyOnPayment: true },
      },
      appDb,
    );
    asaasId = a.id;
    asaasRoute = a.routeToken as string;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
      },
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, dstTenantId]) {
      if (!t) continue;
      for (const table of [
        "agent_tool_selections",
        "tool_definitions",
        "agents",
        "conversion_events",
        "inbound_deliveries",
        "integration_external_refs",
        "integration_instances",
        "vault_entries",
        "audit_logs",
      ]) {
        await suDb
          .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${t}`)
          .catch(() => {});
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // ── the instance ──

  test("created without a strategy it is HMAC, and NONE is refused on create and on update", async () => {
    const { id } = await createIntegrationInstance(
      ctx(),
      { catalogType: "GENERIC", name: "Sem estratégia" },
      appDb,
    );
    const row = await suDb.integrationInstance.findUniqueOrThrow({
      where: { id },
    });
    expect(row.inboundAuthStrategy).toBe("HMAC_SHA256");
    await expect(
      createIntegrationInstance(
        ctx(),
        { catalogType: "GENERIC", name: "Aberta", inboundAuthStrategy: "NONE" },
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      updateIntegrationInstance(
        ctx(),
        id,
        { inboundAuthStrategy: "NONE" },
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("the operator's guidance must be storable text within the cap", async () => {
    for (const instructions of [
      42,
      "x".repeat(GENERIC_INSTRUCTIONS_MAX_CHARS + 1),
    ]) {
      await expect(
        updateIntegrationInstance(
          ctx(),
          genericId,
          { config: { instructions } },
          appDb,
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    await updateIntegrationInstance(
      ctx(),
      genericId,
      { config: { instructions: "Mande o relatório como veio." } },
      appDb,
    );
  });

  // ── the ref ──

  test("the ref is stable per (instance, conversation) and distinct across both", async () => {
    const mint = (inst: bigint, thread: string) =>
      ensureConversationRef({
        tenantId,
        integrationInstanceId: inst,
        threadId: thread,
        base: appDb,
      });
    const a = await mint(genericId, THREAD());
    const b = await mint(genericId, THREAD());
    const other = await mint(otherGenericId, THREAD());
    const otherConv = await mint(genericId, `${tenantId}:1:901`);
    expect(a.ok && b.ok && other.ok && otherConv.ok).toBe(true);
    if (!(a.ok && b.ok && other.ok && otherConv.ok)) return;
    expect(b.ref).toBe(a.ref);
    expect(other.ref).not.toBe(a.ref);
    expect(otherConv.ref).not.toBe(a.ref);
    expect(a.ref).toMatch(/^cr_[A-Za-z0-9_-]{32}$/);
    expect(await mint(asaasId, THREAD())).toEqual({
      ok: false,
      reason: "instance_not_generic",
    });
    expect(await mint(999_999_999n, THREAD())).toEqual({
      ok: false,
      reason: "instance_missing",
    });
  });

  // ── the receptor ──

  const post = (route: string, body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    return receiveInbound({
      routeToken: route,
      rawBody: raw,
      getHeader: signed(raw),
      base: appDb,
    });
  };
  const deliveries = () => suDb.inboundDelivery.count({ where: { tenantId } });

  test("an unknown ref is answered uncorrelated at once, and nothing is stored", async () => {
    const before = await deliveries();
    const r = await post(genericRoute, {
      event_id: "ev-unknown",
      conversation_ref: "cr_does_not_exist",
      text: "oi",
    });
    expect(r.outcome).toBe("uncorrelated");
    expect(r.deliveryId).toBeUndefined();
    expect(await deliveries()).toBe(before);
  });

  test("a ref minted for another instance does not correlate here", async () => {
    const minted = await ensureConversationRef({
      tenantId,
      integrationInstanceId: otherGenericId,
      threadId: THREAD(),
      base: appDb,
    });
    if (!minted.ok) throw new Error("mint");
    const r = await post(genericRoute, {
      event_id: "ev-cross",
      conversation_ref: minted.ref,
      text: "oi",
    });
    expect(r.outcome).toBe("uncorrelated");
    // And on its own instance it does.
    const own = await post(otherGenericRoute, {
      event_id: "ev-own",
      conversation_ref: minted.ref,
      text: "oi",
    });
    expect(own.outcome).toBe("queued");
  });

  test("a wrong signature is the uniform 401", async () => {
    const raw = JSON.stringify({
      event_id: "ev-sig",
      conversation_ref: "cr_x",
      text: "oi",
    });
    await expect(
      receiveInbound({
        routeToken: genericRoute,
        rawBody: raw,
        getHeader: (n) =>
          n.toLowerCase() === DEFAULT_SIGNATURE_HEADER ? "deadbeef" : null,
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("a correlated event is queued once and dispatched as a relay to the bot's conversation", async () => {
    const minted = await ensureConversationRef({
      tenantId,
      integrationInstanceId: genericId,
      threadId: THREAD(),
      base: appDb,
    });
    if (!minted.ok) throw new Error("mint");
    const body = {
      event_id: "ev-report-1",
      conversation_ref: minted.ref,
      text: "Entraram 120 de 400\nPróxima às 16:30",
    };
    const r = await post(genericRoute, body);
    expect(r.outcome).toBe("queued");
    expect((await post(genericRoute, body)).outcome).toBe("duplicate");

    const calls: Array<Record<string, unknown>> = [];
    const proc = await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
      deps: {
        runNudge: async (args) => {
          calls.push(args as unknown as Record<string, unknown>);
          return "messaged";
        },
      },
    });
    expect(proc).toBe("processed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.threadId).toBe(THREAD());
    expect(calls[0]?.deliverToResolved).toBe(true);
    expect(calls[0]?.nudge).toMatchObject({
      source: "GENERIC",
      kind: "agent_nudge",
      framing: "operator_event",
      text: "Entraram 120 de 400\nPróxima às 16:30",
      instructions: "Mande o relatório como veio.",
    });
  });

  // Issue #817, review round 2: a re-dispatch runs under a scheduler deadline, and the turn it starts
  // has to stop when that deadline fires, or it finishes beside the next attempt the sweep arms.
  test("the caller's deadline signal reaches the nudge turn", async () => {
    const minted = await ensureConversationRef({
      tenantId,
      integrationInstanceId: genericId,
      threadId: THREAD(),
      base: appDb,
    });
    if (!minted.ok) throw new Error("mint");
    const r = await post(genericRoute, {
      event_id: "ev-signal-817",
      conversation_ref: minted.ref,
      text: "sinal",
    });
    expect(r.outcome).toBe("queued");
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
      signal: controller.signal,
      deps: {
        runNudge: async (args) => {
          seen = args.signal;
          return "messaged";
        },
      },
    });
    expect(seen).toBe(controller.signal);
  });

  // Review round 3: the route runs this detached with no deadline, and once the sweep exists a claim
  // older than the stale window is dispatched again. So a caller that brings no signal gets one, and it
  // fires BEFORE the claim can go stale.
  test("with no caller deadline the nudge still gets one, shorter than the stale window", async () => {
    expect(DISPATCH_DEADLINE_MS).toBeLessThan(PROCESSING_STALE_MS);
    const minted = await ensureConversationRef({
      tenantId,
      integrationInstanceId: genericId,
      threadId: THREAD(),
      base: appDb,
    });
    if (!minted.ok) throw new Error("mint");
    const r = await post(genericRoute, {
      event_id: "ev-default-deadline-817",
      conversation_ref: minted.ref,
      text: "prazo",
    });
    let seen: AbortSignal | undefined;
    await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
      deps: {
        runNudge: async (args) => {
          seen = args.signal;
          return "messaged";
        },
      },
    });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  test("a payment carrying a conversation ref as its reference credits and nudges nothing", async () => {
    const minted = await ensureConversationRef({
      tenantId,
      integrationInstanceId: genericId,
      threadId: THREAD(),
      base: appDb,
    });
    if (!minted.ok) throw new Error("mint");
    const raw = JSON.stringify({
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_818",
        value: 10,
        status: "RECEIVED",
        externalReference: minted.ref,
      },
    });
    const r = await receiveInbound({
      routeToken: asaasRoute,
      rawBody: raw,
      getHeader: () => null,
      base: appDb,
    });
    // The Asaas path keeps its own answer: no synchronous `uncorrelated` there.
    expect(r.outcome).toBe("queued");
    const calls: unknown[] = [];
    await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
      deps: {
        runNudge: async (a) => {
          calls.push(a);
          return "messaged";
        },
      },
    });
    expect(calls).toEqual([]);
    expect(await suDb.conversionEvent.count({ where: { tenantId } })).toBe(0);
  });

  // ── the tool that hands the ref out ──

  const refTool = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    label: name,
    method: "POST" as const,
    urlTemplate: "https://jobs.example.com/schedule",
    allowedHosts: ["jobs.example.com"],
    body: {
      mode: "kv",
      rows: [{ key: "ref", value: "{{conversation_ref}}" }],
    },
    ...over,
  });

  test("a tool that sends {{conversation_ref}} must name a GENERIC instance of this workspace", async () => {
    await expect(
      createToolDefinition(ctx(), refTool("sem_integracao") as never, appDb),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createToolDefinition(
        ctx(),
        refTool("com_asaas", {
          conversationRefIntegrationId: String(asaasId),
        }) as never,
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    // A malformed id is the same field refusal, never a parse error surfacing as a 500.
    // "9999999999999999999" passes the schema's digit shape and is past the id range, so it is the
    // one that reaches the service's own parse.
    for (const bad of ["abc", "", "-1", "9999999999999999999"]) {
      const err = await createToolDefinition(
        ctx(),
        refTool("id_ruim", { conversationRefIntegrationId: bad }) as never,
        appDb,
      ).catch((e: unknown) => e);
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      expect(status >= 400 && status < 500).toBe(true);
      expect(String(err)).toContain("conversationRefIntegrationId");
    }
    // The name belongs to the minted ref, so a field that takes it is refused whatever else the tool
    // says (review round 1).
    await expect(
      createToolDefinition(
        ctx(),
        refTool("campo_reservado", {
          conversationRefIntegrationId: String(genericId),
          inputSchema: { conversation_ref: { type: "string", source: "ai" } },
        }) as never,
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400, field: "inputSchema" });
    const ok = await createToolDefinition(
      ctx(),
      refTool("agendar_relatorio", {
        conversationRefIntegrationId: String(genericId),
      }) as never,
      appDb,
    );
    expect(ok.conversationRefIntegrationId).toBe(String(genericId));
    // Clearing it while the template still sends the ref is refused too.
    await expect(
      updateToolDefinition(
        ctx(),
        BigInt(ok.id),
        { conversationRefIntegrationId: null } as never,
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // Review round 1: the integration previews read the same refusals as the write.
  test("the MCP integration previews refuse an open GENERIC route and unusable guidance", async () => {
    const openCreate = await integrationCreate(
      principal(),
      {
        catalog_type: "GENERIC",
        name: "aberta",
        inbound_auth_strategy: "NONE",
      } as never,
      { base: appDb },
    );
    expect(openCreate.ok).toBe(false);
    const openUpdate = await integrationUpdate(
      principal(),
      { integration_id: String(genericId), inbound_auth_strategy: "NONE" },
      { base: appDb },
    );
    expect(openUpdate.ok).toBe(false);
    const longGuidance = await integrationUpdate(
      principal(),
      {
        integration_id: String(genericId),
        config: {
          instructions: "x".repeat(GENERIC_INSTRUCTIONS_MAX_CHARS + 1),
        },
      },
      { base: appDb },
    );
    expect(longGuidance.ok).toBe(false);
    const fine = await integrationUpdate(
      principal(),
      { integration_id: String(genericId), config: { instructions: "ok" } },
      { base: appDb },
    );
    expect(fine.ok).toBe(true);
  });

  test("the MCP dry run refuses what the apply would refuse", async () => {
    const dry = await toolCreate(
      principal(),
      {
        name: "mcp_ref_sem_integracao",
        url_template: "https://jobs.example.com/schedule",
        allowed_hosts: ["jobs.example.com"],
        method: "POST",
        body: {
          mode: "kv",
          rows: [{ key: "ref", value: "{{conversation_ref}}" }],
        },
      } as never,
      { base: appDb },
    );
    expect(dry.ok).toBe(false);
    const good = await toolCreate(
      principal(),
      {
        name: "mcp_ref_ok",
        url_template: "https://jobs.example.com/schedule",
        allowed_hosts: ["jobs.example.com"],
        method: "POST",
        body: {
          mode: "kv",
          rows: [{ key: "ref", value: "{{conversation_ref}}" }],
        },
        conversation_ref_integration_id: String(genericId),
      } as never,
      { base: appDb },
    );
    expect(good.ok).toBe(true);
  });

  test("a GENERIC instance is not offered as a grantable integration", async () => {
    const view = await getAgentToolSelections(ctx(), agentId, appDb);
    const types = (
      view as unknown as {
        catalog: { integrationInstances: Array<{ catalogType: string }> };
      }
    ).catalog.integrationInstances.map((i) => i.catalogType);
    expect(types).toContain("ASAAS");
    expect(types).not.toContain("GENERIC");
  });

  test("an agent bundle carries the tool's GENERIC instance and the import rewires it", async () => {
    const tool = await suDb.toolDefinition.findFirstOrThrow({
      where: { tenantId, name: "agendar_relatorio" },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId,
        source: "HTTP",
        toolDefinitionId: tool.id,
        enabledTools: [],
        knowledgeBaseIds: [],
      },
    });
    const exp = await exportAgent(ctx(), agentId, appDb, {
      includeComponents: true,
    });
    const bundled = exp.components?.httpTools.find(
      (h) => h.name === "agendar_relatorio",
    );
    expect(bundled?.conversationRefIntegration).toBe("Relatórios");
    expect(
      exp.components?.integrations.some(
        (i) => i.catalogType === "GENERIC" && i.name === "Relatórios",
      ),
    ).toBe(true);

    const { warnings } = await importAgent(ctxOf(dstTenantId), exp, appDb);
    const dstInstance = await suDb.integrationInstance.findFirstOrThrow({
      where: {
        tenantId: dstTenantId,
        catalogType: "GENERIC",
        name: "Relatórios",
      },
    });
    expect(dstInstance.inboundAuthStrategy).toBe("HMAC_SHA256");
    const dstTool = await suDb.toolDefinition.findFirstOrThrow({
      where: { tenantId: dstTenantId, name: "agendar_relatorio" },
    });
    expect(dstTool.conversationRefIntegrationId).toBe(dstInstance.id);
    expect(
      warnings.some((w) => w.code === "httpToolConversationRefNotFound"),
    ).toBe(false);
  });

  test("refs of this kind are rows of the existing correlation table", async () => {
    const n = await suDb.integrationExternalRef.count({
      where: { tenantId, kind: CONVERSATION_REF_KIND },
    });
    expect(n).toBeGreaterThan(0);
  });
});
