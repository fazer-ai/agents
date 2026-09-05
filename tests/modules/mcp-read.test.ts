import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  CODE_TOOL_CONTEXT_MAX_CHARS,
  SANDBOX_CODE_MAX_CHARS,
  SANDBOX_TIMEOUT_MS,
} from "@/graph/tools/code-sandbox-limits";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  agentGet,
  apiKeyList,
  codeToolGet,
  codeToolList,
  codeToolSchema,
  instanceList,
  toolList,
  vaultList,
} from "@/modules/mcp/read";
import { seedChatwootInstance } from "../utils/chatwoot";

// MCP read tools: the read gate (mcp:read scope + tenant target) is DB-free and always runs; the
// projections + tenant fencing + secret redaction need a real Postgres (skipIf).

function principal(over: Partial<VerifiedToken>): VerifiedToken {
  return {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

describe("MCP read gate (no DB)", () => {
  test("missing mcp:read scope → insufficient_scope before any DB access", async () => {
    const r = await agentGet(principal({ scopes: [] }), { agent_id: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("tenant-less SUPER_ADMIN → no tenant target", async () => {
    const r = await toolList(
      principal({ tenantId: null, role: "SUPER_ADMIN" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no tenant target");
  });

  test("invalid agent_id → error", async () => {
    const r = await agentGet(principal({}), { agent_id: "not-a-number" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid agent_id");
  });

  // `code_tool_schema` is a CONSTANT, not tenant data, and it still goes through the read gate: a
  // surface that answers before the fence is one more thing to remember, and the answer costs the
  // same either way (issue #538).
  test("code_tool_schema is behind the gate like every other read", () => {
    const r = codeToolSchema(principal({ scopes: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  // What it answers, and the assertions are about the two things the description cannot carry: the
  // `context` keys WITH their absent-when, and the limits read off the modules that enforce them
  // rather than restated here.
  test("code_tool_schema serves the vocabulary and the enforced limits", () => {
    const r = codeToolSchema(principal({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.data as {
      context: Array<{ name: string; type: string; always: boolean }>;
      limits: Record<string, number>;
      result: string;
      failure: string;
    };
    const names = body.context.map((v) => v.name);
    expect(names).toContain("contact_email");
    expect(names).toContain("conversationAttributes");
    // The three that are always there, and the rest that are not: the field a body acts on.
    expect(
      body.context
        .filter((v) => v.always)
        .map((v) => v.name)
        .sort(),
    ).toEqual(["agent_name", "contactAttributes", "conversationAttributes"]);
    expect(body.limits.timeoutMs).toBe(SANDBOX_TIMEOUT_MS);
    expect(body.limits.codeMaxChars).toBe(SANDBOX_CODE_MAX_CHARS);
    expect(body.limits.contextMaxChars).toBe(CODE_TOOL_CONTEXT_MAX_CHARS);
    // The two semantics an agent cannot discover by trying without breaking a live turn.
    expect(body.result).toContain("promise");
    expect(body.failure).toContain("OPERATOR");
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

describe.skipIf(!dbUp)("MCP read tools (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let agentA = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "RA", slug: `r-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "RB", slug: `r-b-${process.pid}` },
    });
    tenantB = b.id;
    const ag = await suDb.agent.create({
      data: { tenantId: tenantA, name: "Reader", systemPrompt: "hi" },
    });
    agentA = ag.id;
    await suDb.vaultEntry.create({
      data: {
        tenantId: tenantA,
        name: "openai-key",
        kind: "generic",
        secret: encryptJson("sk-super-secret"),
      },
    });
    await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      accountId: 7,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("cw-admin-token"),
      accountName: "Acct",
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM code_tool_definitions WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("agent_get returns the agent for its tenant", async () => {
    const r = await agentGet(
      principal({ tenantId: tenantA }),
      { agent_id: String(agentA) },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const agent = r.data.agent as { id: string; name: string };
      expect(agent.id).toBe(String(agentA));
      expect(agent.name).toBe("Reader");
    }
  });

  test("agent_get is tenant-fenced (other tenant → not found)", async () => {
    const r = await agentGet(
      principal({ tenantId: tenantB }),
      { agent_id: String(agentA) },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });

  test("instance_list redacts the admin token (hasAdminToken, never adminToken)", async () => {
    const r = await instanceList(principal({ tenantId: tenantA }), {
      base: appDb,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Token presence is deployment-level now (one deployment, N accounts); accounts carry no token.
      const deployment = r.data.deployment as Record<string, unknown>;
      expect(deployment.hasAdminToken).toBe(true);
      expect(deployment.adminToken).toBeUndefined();
      const accounts = r.data.accounts as Record<string, unknown>[];
      expect(accounts.length).toBe(1);
      // The plaintext token must not leak anywhere in the payload.
      expect(JSON.stringify(r.data)).not.toContain("cw-admin-token");
    }
  });

  test("vault_list returns names/kinds but never the secret value", async () => {
    const r = await vaultList(principal({ tenantId: tenantA }), {
      base: appDb,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const entries = r.data.entries as Record<string, unknown>[];
      const mine = entries.find((e) => e.name === "openai-key");
      expect(mine).toBeDefined();
      expect(mine?.kind).toBe("generic");
      expect(JSON.stringify(r.data)).not.toContain("sk-super-secret");
    }
  });

  test("tool_list is empty + tenant-fenced for a fresh tenant", async () => {
    const r = await toolList(principal({ tenantId: tenantB }), { base: appDb });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data.tools as unknown[]).length).toBe(0);
  });

  test("code_tool_list / code_tool_get answer an mcp:read principal, tenant-fenced", async () => {
    const created = await suDb.codeToolDefinition.create({
      data: {
        tenantId: tenantA,
        name: "validar_cpf",
        label: "Validar CPF",
        description: "Valida um CPF.",
        inputSchema: { cpf: { type: "string", required: true } },
        code: "return { valid: input.cpf.length === 11 };",
      },
      select: { id: true },
    });
    const readOnly = { tenantId: tenantA, scopes: ["mcp:read"] };
    const list = await codeToolList(principal(readOnly), { base: appDb });
    expect(list.ok).toBe(true);
    if (list.ok) {
      const tools = list.data.tools as Record<string, unknown>[];
      expect(tools.map((t) => t.name)).toEqual(["validar_cpf"]);
      // The body is code_tool_get's to return.
      expect("code" in (tools[0] ?? {})).toBe(false);
    }
    const got = await codeToolGet(
      principal(readOnly),
      { code_tool_id: String(created.id) },
      { base: appDb },
    );
    expect(got.ok).toBe(true);
    if (got.ok) {
      const tool = got.data.tool as { id: string; code: string };
      expect(tool.id).toBe(String(created.id));
      expect(tool.code).toBe("return { valid: input.cpf.length === 11 };");
    }
    const fenced = await codeToolGet(
      principal({ tenantId: tenantB, scopes: ["mcp:read"] }),
      { code_tool_id: String(created.id) },
      { base: appDb },
    );
    expect(fenced.ok).toBe(false);
    if (!fenced.ok) expect(fenced.error).toContain("not found");
  });

  // Round 24. An invalid body is SAVED on purpose and answered with a warning, so the warning is
  // the only record that the tool is known-broken — and it is written once, at the save. An MCP
  // operator reading the tool afterwards had no way to that fact: `code_tool_get` returned the
  // source and ran no check, so the problem surfaced when an agent called it. The update preview
  // makes it worse by pointing here: it reports `[]` for a patch that leaves the body alone,
  // "the stored body's own warnings are code_tool_get's to show" (write-code-tools.ts).
  test("code_tool_get reports the stored body's own warnings", async () => {
    const broken = await suDb.codeToolDefinition.create({
      data: {
        tenantId: tenantA,
        name: "quebrada",
        label: "Quebrada",
        description: "Um corpo que nao compila.",
        inputSchema: {},
        code: "const x = ;",
      },
      select: { id: true },
    });
    const got = await codeToolGet(
      principal({ tenantId: tenantA, scopes: ["mcp:read"] }),
      { code_tool_id: String(broken.id) },
      { base: appDb },
    );
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.data.warnings).toMatchObject([{ kind: "syntax", line: 1 }]);
    }
    // ...and a body that parses answers with none, rather than an absent key the caller has to
    // tell apart from "not checked".
    const clean = await suDb.codeToolDefinition.create({
      data: {
        tenantId: tenantA,
        name: "inteira",
        label: "Inteira",
        description: "Um corpo que compila.",
        inputSchema: {},
        code: "return 1;",
      },
      select: { id: true },
    });
    const fine = await codeToolGet(
      principal({ tenantId: tenantA, scopes: ["mcp:read"] }),
      { code_tool_id: String(clean.id) },
      { base: appDb },
    );
    expect(fine.ok).toBe(true);
    if (fine.ok) expect(fine.data.warnings).toEqual([]);
  });

  test("api_key_list returns no secrets for a fresh tenant", async () => {
    const r = await apiKeyList(principal({ tenantId: tenantB }), {
      base: appDb,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data.apiKeys)).toBe(true);
  });
});
