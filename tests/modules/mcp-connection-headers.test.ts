import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import en from "@/client/locales/en.json";
import type { TenantContext } from "@/lib/tenancy";
import { exportAgent, importAgent } from "@/modules/agents/transfer";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  mcpConnectionCreate,
  mcpConnectionUpdate,
} from "@/modules/mcp/write-agents";
import {
  credentialHeaderName,
  MCP_HEADERS_DESCRIPTION,
  mcpHeadersProblem,
  renderMcpHeaders,
} from "@/modules/mcp-connections/headers";
import {
  createMcpConnection,
  getMcpConnection,
  updateMcpConnection,
} from "@/modules/mcp-connections/service";
import { createVaultEntry } from "@/modules/vault/service";
import { outboundUrl } from "../utils/outbound";

describe("mcpHeadersProblem", () => {
  const ok = (
    h: Record<string, string>,
    transport = "streamableHttp",
    cred: string | null = null,
  ) => mcpHeadersProblem(h, transport, cred);

  test("accepts literal values and conversation variables", () => {
    expect(ok({})).toBeNull();
    expect(
      ok({
        "X-Contact": "{{contact_phone}}",
        "X-Id": "cli-{{ contact_identifier }}",
        "X-Static": "fixed",
      }),
    ).toBeNull();
  });

  test("refuses what the request could not carry, or should not", () => {
    expect(ok({ "x bad": "v" })).toContain("not a valid header name");
    expect(ok({ "x-a:b": "v" })).toContain("not a valid header name");
    expect(ok({ "X-A": "a\r\nInjected: 1" })).toContain("cannot carry");
    expect(ok({ "X-A": "José {{contact_id}}" })).toContain("cannot carry");
    expect(ok({ "X-A": "a\tb {{contact_id}}" })).toBeNull();
    expect(ok({ "X-A": "{{secret}}" })).toContain("{{secret}}");
    expect(ok({ "X-A": "{{conversation_ref}}" })).toContain(
      "{{conversation_ref}}",
    );
    expect(ok({ "X-A": "1", "x-a": "2" })).toContain("declared twice");
    expect(ok({ "Mcp-Session-Id": "x" })).toContain("MCP transport");
    expect(ok({ "Content-Type": "x" })).toContain("MCP transport");
    expect(ok({ "X-A": "1" }, "stdio")).toContain("network transports");
    expect(
      ok(
        Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [`X-${i}`, "v"]),
        ),
      ),
    ).toContain("at most 20");
  });

  test("a __proto__ name and a value that is not text are refused, not dropped", () => {
    expect(
      mcpHeadersProblem(JSON.parse('{"__proto__":"x"}'), "sse", null),
    ).toContain("not a valid header name");
    expect(mcpHeadersProblem({ "X-A": 1 }, "sse", null)).toContain(
      "must be text",
    );
  });

  test("refuses the header the credential is sent in, whatever its case", () => {
    expect(ok({ authorization: "x" }, "sse", "authorization")).toContain(
      "credential",
    );
    expect(ok({ "X-Api-Key": "x" }, "sse", "x-api-key")).toContain(
      "credential",
    );
    expect(ok({ "X-Api-Key": "x" }, "sse", "authorization")).toBeNull();
  });
});

describe("credentialHeaderName", () => {
  test("names the header each kind is sent in, and none for a query credential", () => {
    expect(credentialHeaderName(false, "bearer_token", null)).toBeNull();
    expect(credentialHeaderName(true, "bearer_token", null)).toBe(
      "authorization",
    );
    expect(credentialHeaderName(true, "basic_auth", null)).toBe(
      "authorization",
    );
    expect(credentialHeaderName(true, "header", "X-Api-Key")).toBe("x-api-key");
    expect(credentialHeaderName(true, "mcp_oauth", null)).toBe("authorization");
    expect(credentialHeaderName(true, null, null)).toBe("authorization");
    expect(credentialHeaderName(true, "query", "key")).toBeNull();
  });
});

describe("renderMcpHeaders", () => {
  test("fills each placeholder, empty when the conversation has none, and flattens control characters", () => {
    expect(
      renderMcpHeaders(
        {
          "X-Contact": "{{contact_phone}}",
          "X-Both": "{{inbox_id}}/{{contact_email}}",
          "X-Name": "{{contact_name}}",
        },
        {
          contact_phone: "+55",
          inbox_id: "7",
          contact_name: "Ana\r\nX-Evil: 1",
        },
      ),
    ).toEqual({
      "X-Contact": "+55",
      "X-Both": "7/",
      "X-Name": "Ana%0D%0AX-Evil: 1",
    });
  });

  test("a value outside printable ASCII goes out percent-encoded, and decodes back", () => {
    const out = renderMcpHeaders(
      { "X-Name": "{{contact_name}}" },
      { contact_name: "José 李明 100% 😀" },
    );
    expect(out["X-Name"]).toBe(
      "Jos%C3%A9 %E6%9D%8E%E6%98%8E 100%25 %F0%9F%98%80",
    );
    expect(decodeURIComponent(out["X-Name"] ?? "")).toBe("José 李明 100% 😀");
    expect(() => new Headers(out)).not.toThrow();
    expect(
      renderMcpHeaders(
        { "X-A": "{{contact_name}}" },
        { contact_name: "a\uD800b" },
      ),
    ).toEqual({
      "X-A": "a%EF%BF%BDb",
    });
  });

  test("a name on the prototype is not a value", () => {
    expect(renderMcpHeaders({ "X-A": "{{toString}}" }, {})).toEqual({
      "X-A": "",
    });
  });
});

describe("the field says the same thing everywhere it is described", () => {
  test("the console help in English is the API description", () => {
    expect(en.mcp.headersHelp).toBe(MCP_HEADERS_DESCRIPTION);
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

describe.skipIf(!dbUp)("an MCP connection's headers, stored", () => {
  let tenant = 0n;
  let other = 0n;
  let bearerRef = "";
  let headerRef = "";
  const ctx = (t = tenant): TenantContext => ({
    tenantId: t,
    userId: null,
    role: "TENANT_ADMIN",
  });
  const principal = (): VerifiedToken => ({
    userId: null as unknown as bigint,
    tenantId: tenant,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  });

  beforeAll(async () => {
    tenant = (
      await suDb.tenant.create({
        data: { name: "MH", slug: `mh-${process.pid}` },
      })
    ).id;
    other = (
      await suDb.tenant.create({
        data: { name: "MH2", slug: `mh2-${process.pid}` },
      })
    ).id;
    bearerRef = (
      await createVaultEntry(ctx(), "mh-bearer", "tok", "bearer_token", appDb)
    ).ref;
    headerRef = (
      await createVaultEntry(
        ctx(),
        {
          name: "mh-header",
          value: "k",
          kind: "header",
          paramName: "X-Api-Key",
        },
        undefined,
        undefined,
        appDb,
      )
    ).ref;
  });

  afterAll(async () => {
    for (const t of [tenant, other])
      if (t) await suDb.tenant.delete({ where: { id: t } });
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("create stores the templates; update keeps them unless it sends new ones", async () => {
    const c = await createMcpConnection(
      ctx(),
      {
        name: "with-headers",
        transport: "streamableHttp",
        url: outboundUrl("/mcp"),
        headers: { "X-Contact": "{{contact_phone}}" },
      },
      appDb,
    );
    expect(c.headers).toEqual({ "X-Contact": "{{contact_phone}}" });
    await updateMcpConnection(ctx(), BigInt(c.id), { enabled: false }, appDb);
    expect(
      (await getMcpConnection(ctx(), BigInt(c.id), appDb)).headers,
    ).toEqual({
      "X-Contact": "{{contact_phone}}",
    });
    await updateMcpConnection(
      ctx(),
      BigInt(c.id),
      { headers: { "X-Inbox": "{{inbox_id}}" } },
      appDb,
    );
    expect(
      (await getMcpConnection(ctx(), BigInt(c.id), appDb)).headers,
    ).toEqual({
      "X-Inbox": "{{inbox_id}}",
    });
  });

  test("a header that is invalid, or collides with the credential, is refused and nothing is written", async () => {
    const before = await suDb.mcpServerConnection.count({
      where: { tenantId: tenant },
    });
    await expect(
      createMcpConnection(
        ctx(),
        {
          name: "bad-name",
          transport: "sse",
          url: outboundUrl("/sse"),
          headers: { "x bad": "v" },
        },
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400, field: "headers" });
    await expect(
      createMcpConnection(
        ctx(),
        {
          name: "collides",
          transport: "sse",
          url: outboundUrl("/sse"),
          credentialRef: bearerRef,
          headers: { Authorization: "{{contact_id}}" },
        },
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400, field: "headers" });
    expect(
      await suDb.mcpServerConnection.count({ where: { tenantId: tenant } }),
    ).toBe(before);
  });

  test("a body carrying a __proto__ header is refused, not stored without it", async () => {
    await expect(
      createMcpConnection(
        ctx(),
        JSON.parse(
          `{"name":"proto","transport":"sse","url":"${outboundUrl("/sse")}","headers":{"__proto__":"x","X-A":"1"}}`,
        ),
        appDb,
      ),
    ).rejects.toMatchObject({ field: "headers" });
    expect(
      await suDb.mcpServerConnection.count({
        where: { tenantId: tenant, name: "proto" },
      }),
    ).toBe(0);
  });

  test("a later write that would make a stored header collide, or turn the server into stdio, is refused", async () => {
    const c = await createMcpConnection(
      ctx(),
      {
        name: "later",
        transport: "streamableHttp",
        url: outboundUrl("/mcp"),
        credentialRef: bearerRef,
        headers: { "X-Api-Key": "{{contact_id}}" },
      },
      appDb,
    );
    await expect(
      updateMcpConnection(
        ctx(),
        BigInt(c.id),
        { credentialRef: headerRef },
        appDb,
      ),
    ).rejects.toMatchObject({ field: "headers" });
    await expect(
      updateMcpConnection(
        ctx(),
        BigInt(c.id),
        { transport: "stdio", command: "bunx x" },
        appDb,
      ),
    ).rejects.toThrow();
    const row = await getMcpConnection(ctx(), BigInt(c.id), appDb);
    expect([row.credentialRef, row.transport]).toEqual([
      bearerRef,
      "streamableHttp",
    ]);
  });

  test("the MCP dry run refuses what the write refuses", async () => {
    const create = await mcpConnectionCreate(
      principal(),
      {
        name: "dry",
        transport: "sse",
        url: outboundUrl("/sse"),
        credential_ref: "mh-bearer",
        headers: { authorization: "x" },
      },
      { base: appDb },
    );
    expect(JSON.stringify(create)).toContain(
      "carries the connection's credential",
    );
    const c = await createMcpConnection(
      ctx(),
      {
        name: "dry-update",
        transport: "sse",
        url: outboundUrl("/sse"),
        headers: { "X-Api-Key": "{{contact_id}}" },
      },
      appDb,
    );
    const update = await mcpConnectionUpdate(
      principal(),
      { connection_id: c.id, credential_ref: "mh-header" },
      { base: appDb },
    );
    expect(JSON.stringify(update)).toContain(
      "carries the connection's credential",
    );
    expect(
      (await getMcpConnection(ctx(), BigInt(c.id), appDb)).credentialRef,
    ).toBeNull();
  });

  test("the audit row names the headers and says a value moved without carrying it", async () => {
    const c = await createMcpConnection(
      ctx(),
      {
        name: "audited",
        transport: "sse",
        url: outboundUrl("/sse"),
        headers: { "X-Key": "literal-value-1" },
      },
      appDb,
    );
    await updateMcpConnection(
      ctx(),
      BigInt(c.id),
      { headers: { "X-Key": "literal-value-2" } },
      appDb,
    );
    const rows = await suDb.auditLog.findMany({
      where: { tenantId: tenant, target: `mcp_connection:${c.id}` },
      orderBy: { id: "asc" },
    });
    expect(rows.map((r) => r.action)).toEqual([
      "mcp_connection.create",
      "mcp_connection.update",
    ]);
    const text = JSON.stringify(rows.map((r) => [r.before, r.after]));
    expect(text).not.toContain("literal-value");
    const after = (rows[1]?.after ?? {}) as {
      headerNames?: string[];
      undisclosedChanged?: boolean;
    };
    expect(after.headerNames).toEqual(["X-Key"]);
    expect(after.undisclosedChanged).toBe(true);
  });

  test("export carries the templates, and import refuses a bundle whose headers it would refuse", async () => {
    const conn = await createMcpConnection(
      ctx(),
      {
        name: "exported",
        transport: "streamableHttp",
        url: outboundUrl("/mcp"),
        headers: { "X-Contact": "{{contact_phone}}" },
      },
      appDb,
    );
    const keyId = (
      await suDb.vaultEntry.create({
        data: { tenantId: tenant, name: "mh-llm", secret: encryptJson("sk") },
        select: { id: true },
      })
    ).id;
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Exporta",
        systemPrompt: "p",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${keyId}`,
        },
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId: tenant,
        agentId: agent.id,
        source: "MCP",
        mcpServerConnectionId: BigInt(conn.id),
        enabledTools: ["whoami"],
        knowledgeBaseIds: [],
      },
    });
    const exp = await exportAgent(ctx(), agent.id, appDb, {
      includeComponents: true,
    });
    const bundled = exp.components?.mcpServers.find(
      (m) => m.name === "exported",
    );
    expect(bundled?.headers).toEqual({ "X-Contact": "{{contact_phone}}" });

    await importAgent(ctx(other), exp, appDb);
    const landed = await suDb.mcpServerConnection.findFirst({
      where: { tenantId: other, name: "exported" },
    });
    expect(landed?.headers).toEqual({ "X-Contact": "{{contact_phone}}" });

    const tampered = structuredClone(exp);
    const t = tampered.components?.mcpServers.find(
      (m) => m.name === "exported",
    );
    if (!t) throw new Error("bundle missing the connection");
    t.name = "tampered";
    t.headers = { "X-A": "{{secret}}" };
    tampered.agent.name = "Exporta 2";
    const { warnings } = await importAgent(ctx(other), tampered, appDb);
    expect(warnings.some((w) => w.code === "mcpInvalidHeaders")).toBe(true);
    expect(
      await suDb.mcpServerConnection.count({
        where: { tenantId: other, name: "tampered" },
      }),
    ).toBe(0);
  });
});
