import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { type AgentConfig, buildToolset } from "@/graph/prepare";
import { buildHttpTools, loadToolSelections } from "@/graph/tools/assemble";
import { buildCodeTool, type CodeToolDeps } from "@/graph/tools/code";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { exportAgent, importAgent } from "@/modules/agents/transfer";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { createCodeTool, updateCodeTool } from "@/modules/code-tools/service";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { toolCreate, toolUpdate } from "@/modules/mcp/write-agents";
import { codeToolCreate, codeToolUpdate } from "@/modules/mcp/write-code-tools";
import { MODEL_RESPONSE_CHAR_LIMIT } from "@/modules/tool-definitions/response-template";
import {
  createToolDefinition,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// A tool whose response is expected to be cut can stop paging about it: the clip line is still
// written, at info, and the tool's other warnings still alert.

const PUBLIC = "8.8.8.8";
const LIMIT = MODEL_RESPONSE_CHAR_LIMIT;
const LONG = "x".repeat(LIMIT + 1000);

type Note = Parameters<NonNullable<CodeToolDeps["onSideEffectError"]>>[0];

function httpDef(over: Partial<HttpToolDef> = {}): HttpToolDef {
  return {
    name: "busca",
    method: "GET",
    urlTemplate: `https://${PUBLIC}/v1/busca`,
    allowedHosts: [PUBLIC],
    headers: {},
    inputSchema: {},
    credentialRef: null,
    ...over,
  };
}

async function callHttp(
  over: Partial<HttpToolDef>,
  body: string,
  headers: Record<string, string> = {},
  status = 200,
) {
  const notes: Note[] = [];
  const tool = buildHttpTool(httpDef(over), {
    resolveCredential: async () => null,
    fetchImpl: (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json", ...headers },
      })) as unknown as typeof fetch,
    onSideEffectError: (e) => notes.push(e),
  });
  const out = (await tool.invoke({})) as unknown as ToolMessage | string;
  const text =
    typeof out === "string" ? out : String((out as ToolMessage).content);
  return { notes, text };
}

async function callCode(code: string, silenceTruncationAlert?: boolean) {
  const notes: Note[] = [];
  const tool = buildCodeTool(
    {
      name: "relatorio",
      description: "d",
      inputSchema: {},
      code,
      ...(silenceTruncationAlert !== undefined
        ? { silenceTruncationAlert }
        : {}),
    },
    { onSideEffectError: (n) => notes.push(n) },
  );
  const text = String(await tool.invoke({}));
  return { notes, text };
}

describe("an HTTP tool's clip, silenced or not", () => {
  test("by default the clip line carries no level, which the turn writes as warn", async () => {
    const { notes } = await callHttp({}, LONG);
    expect(notes.map((n) => [n.phase, n.level])).toEqual([
      ["response_clipped", undefined],
    ]);
    expect(notes[0]?.detail).not.toHaveProperty("silenced");
  });

  test("silenced, the platform's clip is written at info and marked, with the same detail otherwise", async () => {
    const loud = await callHttp({}, LONG);
    const quiet = await callHttp({ silenceTruncationAlert: true }, LONG);
    expect(quiet.notes).toHaveLength(1);
    expect(quiet.notes[0]?.level).toBe("info");
    expect(quiet.notes[0]?.phase).toBe("response_clipped");
    expect(quiet.notes[0]?.detail).toEqual({
      ...loud.notes[0]?.detail,
      silenced: true,
    });
    expect(String((quiet.notes[0]?.err as Error | undefined)?.message)).toBe(
      String((loud.notes[0]?.err as Error | undefined)?.message),
    );
  });

  test("silenced, a trim the server declares is written at info too", async () => {
    const { notes } = await callHttp(
      { silenceTruncationAlert: true },
      "curto",
      { "X-Tool-Truncated": "18234" },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      phase: "response_clipped",
      level: "info",
      detail: { declared: true, chars: 18234, silenced: true },
    });
  });

  test("what the model reads is the same either way", async () => {
    const loud = await callHttp({}, LONG);
    const quiet = await callHttp({ silenceTruncationAlert: true }, LONG);
    expect(quiet.text).toBe(loud.text);
  });

  test("silenced, the tool's other warnings still carry no level", async () => {
    const { notes } = await callHttp(
      {
        silenceTruncationAlert: true,
        outputSchema: { mode: "template", template: "Nome: {{nome}}" },
      },
      JSON.stringify({ outro: 1 }),
    );
    expect(notes.map((n) => [n.phase, n.level])).toEqual([
      ["response_template", undefined],
    ]);
  });

  test("silenced with nothing cut, nothing is written", async () => {
    const { notes } = await callHttp({ silenceTruncationAlert: true }, "ok");
    expect(notes).toEqual([]);
  });
});

describe("the turn's HTTP builder", () => {
  test("hands each loaded row's switch to its tool", async () => {
    const real = globalThis.fetch;
    // NOTE: the builder takes no fetch of its own, and the tool binds the global one when it is built.
    globalThis.fetch = (async () =>
      new Response(LONG, { status: 200 })) as unknown as typeof fetch;
    try {
      const notes: Note[] = [];
      const [tool] = buildHttpTools(
        [
          {
            name: "busca",
            description: null,
            method: "GET",
            urlTemplate: `https://${PUBLIC}/busca`,
            allowedHosts: [PUBLIC],
            headers: {},
            inputSchema: {},
            expectedStatuses: [],
            maxResponseChars: null,
            silenceTruncationAlert: true,
            appointment: null,
            conversationRefIntegrationId: null,
            outputSchema: {},
            credentialRef: null,
            credentialKind: null,
            credentialParamName: null,
            credentialBaseUrl: null,
            ackEnabled: false,
            ackMessage: null,
            query: {},
            body: {},
          },
        ],
        {
          resolveCredential: async () => null,
          onSideEffectError: (e) => notes.push(e),
        },
      );
      await tool?.invoke({});
      expect(notes.map((n) => [n.phase, n.level])).toEqual([
        ["response_clipped", "info"],
      ]);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("a code tool's clip, silenced or not", () => {
  const BIG = `return "x".repeat(${LIMIT + 500})`;

  test("by default the clip line carries no level", async () => {
    const { notes } = await callCode(BIG);
    expect(notes.map((n) => [n.phase, n.level])).toEqual([
      ["response_clipped", undefined],
    ]);
    expect(notes[0]?.detail).not.toHaveProperty("silenced");
  });

  test("silenced, the clip is written at info and marked, and the model text is unchanged", async () => {
    const loud = await callCode(BIG, false);
    const quiet = await callCode(BIG, true);
    expect(quiet.text).toBe(loud.text);
    expect(quiet.notes).toHaveLength(1);
    expect(quiet.notes[0]?.level).toBe("info");
    expect(quiet.notes[0]?.detail).toEqual({
      ...loud.notes[0]?.detail,
      silenced: true,
    });
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let app: PrismaClient | undefined;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const tenants: bigint[] = [];
let tenantId = 0n;
let otherTenant = 0n;

const ctxFor = (id: bigint): TenantContext => ({
  tenantId: id,
  userId: null,
  role: "TENANT_ADMIN",
});
const ctx = () => ctxFor(tenantId);

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

function httpInput(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    label: name,
    method: "GET" as const,
    urlTemplate: `https://${PUBLIC}/busca`,
    allowedHosts: [PUBLIC],
    ...extra,
  };
}

function codeInput(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    label: name,
    description: "d",
    code: "return 1",
    ...extra,
  };
}

function config(over: Partial<AgentConfig>): AgentConfig {
  return {
    agentId: 1n,
    contactDbId: null,
    conversationDbId: null,
    contactVoiceReply: null,
    documentSelections: [],
    handoffConfig: HANDOFF_DEFAULTS,
    kanbanConfig: KANBAN_DEFAULTS,
    contactAuth: CONTACT_AUTH_DEFAULTS,
    sendImageConfig: SEND_IMAGE_DEFAULTS,
    crossInboxCaseConfig: CROSS_INBOX_CASE_DEFAULTS,
    chatwootContactId: null,
    httpToolContext: {},
    codeToolDefs: [],
    httpToolDefs: [],
    integrationSelections: [],
    mcpSelections: [],
    nativeToolsAllow: [],
    ragConfig: undefined,
    timezone: "America/Sao_Paulo",
    toolGuidance: {},
    toolPreconditions: {},
    transferWithSummary: true,
    protectedLabels: [],
    allowedLabels: [],
    outsideAllowedLabels: "accept",
    ...over,
  } as unknown as AgentConfig;
}

async function grant(
  agentId: bigint,
  kind: "HTTP" | "CODE",
  id: string,
): Promise<void> {
  await suDb.agentToolSelection.create({
    data: {
      agentId,
      tenantId,
      source: kind,
      ...(kind === "HTTP"
        ? { toolDefinitionId: BigInt(id) }
        : { codeToolDefinitionId: BigInt(id) }),
      knowledgeBaseIds: [],
      enabledTools: [],
    },
  });
}

async function newAgent(name: string) {
  return suDb.agent.create({
    data: {
      tenantId,
      name,
      systemPrompt: "x",
      modelConfig: { provider: "openai", model: "gpt-4o-mini" },
    },
  });
}

describe.skipIf(!dbUp)("the switch, stored and read back", () => {
  beforeAll(async () => {
    for (const slug of ["sta", "sta-dst"]) {
      const t = await suDb.tenant.create({
        data: { name: slug, slug: `${slug}-${process.pid}` },
      });
      tenants.push(t.id);
    }
    [tenantId, otherTenant] = tenants as [bigint, bigint];
  });

  afterAll(async () => {
    for (const id of tenants) {
      await clearFlowLog(suDb, { tenantId: id });
      await suDb.tenant.delete({ where: { id } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("created without it, both kinds store false", async () => {
    const http = await createToolDefinition(
      ctx(),
      httpInput("sem_http"),
      appDb,
    );
    const code = await createCodeTool(ctx(), codeInput("sem_code"), appDb);
    expect(http.silenceTruncationAlert).toBe(false);
    expect(code.tool.silenceTruncationAlert).toBe(false);
    const rows = await Promise.all([
      suDb.toolDefinition.findUnique({ where: { id: BigInt(http.id) } }),
      suDb.codeToolDefinition.findUnique({
        where: { id: BigInt(code.tool.id) },
      }),
    ]);
    expect(rows.map((r) => r?.silenceTruncationAlert)).toEqual([false, false]);
  });

  test("set, it reads back, a patch without it keeps it, and it can be turned off", async () => {
    const http = await createToolDefinition(
      ctx(),
      httpInput("liga_http", { silenceTruncationAlert: true }),
      appDb,
    );
    expect(http.silenceTruncationAlert).toBe(true);
    const relabeled = await updateToolDefinition(
      ctx(),
      BigInt(http.id),
      { label: "outro" },
      appDb,
    );
    expect(relabeled.silenceTruncationAlert).toBe(true);
    const off = await updateToolDefinition(
      ctx(),
      BigInt(http.id),
      { silenceTruncationAlert: false },
      appDb,
    );
    expect(off.silenceTruncationAlert).toBe(false);

    const code = await createCodeTool(
      ctx(),
      codeInput("liga_code", { silenceTruncationAlert: true }),
      appDb,
    );
    expect(code.tool.silenceTruncationAlert).toBe(true);
    const recoded = await updateCodeTool(
      ctx(),
      BigInt(code.tool.id),
      { code: "return 2" },
      appDb,
    );
    expect(recoded.tool.silenceTruncationAlert).toBe(true);
    const codeOff = await updateCodeTool(
      ctx(),
      BigInt(code.tool.id),
      { silenceTruncationAlert: false },
      appDb,
    );
    expect(codeOff.tool.silenceTruncationAlert).toBe(false);
  });

  test("a value that is not a boolean is refused", async () => {
    const bad = await createToolDefinition(
      ctx(),
      httpInput("ruim_http", { silenceTruncationAlert: "yes" }),
      appDb,
    ).then(
      () => null,
      (e: { statusCode?: number }) => e,
    );
    expect(bad?.statusCode).toBe(422);
    const badCode = await createCodeTool(
      ctx(),
      codeInput("ruim_code", { silenceTruncationAlert: 1 }),
      appDb,
    ).then(
      () => null,
      (e: { statusCode?: number }) => e,
    );
    expect(badCode?.statusCode).toBe(422);
  });

  test("MCP: created without the argument, both kinds store false", async () => {
    const http = await toolCreate(
      principal(),
      {
        name: "mcp_http_sem",
        url_template: `https://${PUBLIC}/busca`,
        allowed_hosts: [PUBLIC],
        dry_run: false,
      },
      { base: appDb },
    );
    const code = await codeToolCreate(
      principal(),
      {
        name: "mcp_code_sem",
        description: "d",
        code: "return 1",
        dry_run: false,
      },
      { base: appDb },
    );
    expect([http.ok, code.ok]).toEqual([true, true]);
    if (!http.ok || !code.ok) return;
    expect([
      (http.data.tool as { silenceTruncationAlert: boolean })
        .silenceTruncationAlert,
      (code.data.tool as { silenceTruncationAlert: boolean })
        .silenceTruncationAlert,
    ]).toEqual([false, false]);
  });

  test("MCP: the HTTP and code create tools store it, and the update tools turn it off", async () => {
    const http = await toolCreate(
      principal(),
      {
        name: "mcp_http",
        url_template: `https://${PUBLIC}/busca`,
        allowed_hosts: [PUBLIC],
        silence_truncation_alert: true,
        dry_run: false,
      },
      { base: appDb },
    );
    const code = await codeToolCreate(
      principal(),
      {
        name: "mcp_code",
        description: "d",
        code: "return 1",
        silence_truncation_alert: true,
        dry_run: false,
      },
      { base: appDb },
    );
    expect([http.ok, code.ok]).toEqual([true, true]);
    if (!http.ok || !code.ok) return;
    const httpTool = http.data.tool as {
      id: string;
      silenceTruncationAlert: boolean;
    };
    const codeTool = code.data.tool as {
      id: string;
      silenceTruncationAlert: boolean;
    };
    expect(httpTool.silenceTruncationAlert).toBe(true);
    expect(codeTool.silenceTruncationAlert).toBe(true);
    const preview = await toolUpdate(
      principal(),
      { tool_id: httpTool.id, silence_truncation_alert: false },
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.data.diff).toMatchObject({
        silenceTruncationAlert: { before: true, after: false },
      });
    }
    await toolUpdate(
      principal(),
      {
        tool_id: httpTool.id,
        silence_truncation_alert: false,
        dry_run: false,
      },
      { base: appDb },
    );
    await codeToolUpdate(
      principal(),
      {
        code_tool_id: codeTool.id,
        silence_truncation_alert: false,
        dry_run: false,
      },
      { base: appDb },
    );
    const rows = await Promise.all([
      suDb.toolDefinition.findUnique({ where: { id: BigInt(httpTool.id) } }),
      suDb.codeToolDefinition.findUnique({
        where: { id: BigInt(codeTool.id) },
      }),
    ]);
    expect(rows.map((r) => r?.silenceTruncationAlert)).toEqual([false, false]);
  });

  test("the turn's loader hands the stored switch to both kinds", async () => {
    const http = await createToolDefinition(
      ctx(),
      httpInput("turno_http", { silenceTruncationAlert: true }),
      appDb,
    );
    const code = await createCodeTool(
      ctx(),
      codeInput("turno_code", { silenceTruncationAlert: true }),
      appDb,
    );
    const agent = await newAgent("sta-turn");
    await grant(agent.id, "HTTP", http.id);
    await grant(agent.id, "CODE", code.tool.id);
    const sel = await runScopedOn(appDb, ctx(), (db) =>
      loadToolSelections(db, agent.id),
    );
    expect(
      sel.httpToolDefs.find((d) => d.name === "turno_http")
        ?.silenceTruncationAlert,
    ).toBe(true);
    expect(
      sel.codeToolDefs.find((d) => d.name === "turno_code")
        ?.silenceTruncationAlert,
    ).toBe(true);
  });

  test("on the turn's flow log, a silenced clip is info and an unsilenced one is warn", async () => {
    const turnId = `sta-${process.pid}`;
    const code = (name: string, silenceTruncationAlert: boolean) => ({
      name,
      description: "d",
      inputSchema: {},
      code: `return "x".repeat(${LIMIT + 1})`,
      silenceTruncationAlert,
    });
    const tools = await buildToolset(
      config({
        codeToolDefs: [code("quieto", true), code("alto", false)],
      } as unknown as Partial<AgentConfig>),
      {
        tenantId,
        instanceId: 1n,
        base: appDb,
        client: {} as unknown as ChatwootClient,
        conversationId: 0,
        threadId: `t-${process.pid}`,
      },
      {
        flow: { tenantId, turnId, source: "inbox", base: appDb },
        buildNativeTools: () => [],
      },
    );
    await tools.find((t) => t.name === "quieto")?.invoke({});
    await tools.find((t) => t.name === "alto")?.invoke({});
    const rows = await flowLogRows(suDb, { where: { tenantId, turnId } });
    const byTool = Object.fromEntries(
      rows.map((r) => [(r.detail as { tool: string }).tool, r]),
    );
    expect(byTool.quieto).toMatchObject({
      stage: "tool",
      level: "info",
      detail: { phase: "response_clipped", silenced: true },
    });
    expect(byTool.alto).toMatchObject({
      stage: "tool",
      level: "warn",
      detail: { phase: "response_clipped" },
    });
    expect(byTool.alto?.detail).not.toHaveProperty("silenced");
  });

  test("export carries it, import keeps it, and a bundle without it imports as off", async () => {
    const agent = await newAgent("sta-transfer");
    const httpOn = await createToolDefinition(
      ctx(),
      httpInput("tr_http_on", { silenceTruncationAlert: true }),
      appDb,
    );
    const httpOld = await createToolDefinition(
      ctx(),
      httpInput("tr_http_old", { silenceTruncationAlert: true }),
      appDb,
    );
    const codeOn = await createCodeTool(
      ctx(),
      codeInput("tr_code_on", { silenceTruncationAlert: true }),
      appDb,
    );
    const codeOld = await createCodeTool(
      ctx(),
      codeInput("tr_code_old", { silenceTruncationAlert: true }),
      appDb,
    );
    await grant(agent.id, "HTTP", httpOn.id);
    await grant(agent.id, "HTTP", httpOld.id);
    await grant(agent.id, "CODE", codeOn.tool.id);
    await grant(agent.id, "CODE", codeOld.tool.id);
    const payload = (await exportAgent(ctx(), agent.id, appDb, {
      includeComponents: true,
    })) as unknown as {
      components: {
        httpTools: { name: string; silenceTruncationAlert?: boolean }[];
        codeTools: { name: string; silenceTruncationAlert?: boolean }[];
      };
    };
    const http = new Map(payload.components.httpTools.map((h) => [h.name, h]));
    const codeT = new Map(payload.components.codeTools.map((c) => [c.name, c]));
    expect(http.get("tr_http_on")?.silenceTruncationAlert).toBe(true);
    expect(codeT.get("tr_code_on")?.silenceTruncationAlert).toBe(true);
    // NOTE: an older bundle, written before the field existed.
    delete http.get("tr_http_old")?.silenceTruncationAlert;
    delete codeT.get("tr_code_old")?.silenceTruncationAlert;
    await importAgent(ctxFor(otherTenant), payload, appDb);
    const httpRows = await suDb.toolDefinition.findMany({
      where: { tenantId: otherTenant, name: { startsWith: "tr_http" } },
      select: { name: true, silenceTruncationAlert: true },
    });
    const codeRows = await suDb.codeToolDefinition.findMany({
      where: { tenantId: otherTenant, name: { startsWith: "tr_code" } },
      select: { name: true, silenceTruncationAlert: true },
    });
    expect(
      Object.fromEntries(
        [...httpRows, ...codeRows].map((r) => [
          r.name,
          r.silenceTruncationAlert,
        ]),
      ),
    ).toEqual({
      tr_http_on: true,
      tr_http_old: false,
      tr_code_on: true,
      tr_code_old: false,
    });
  });
});
