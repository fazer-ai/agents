import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  createBusinessHours,
  updateBusinessHours,
} from "@/modules/business-hours/service";
import {
  createIntegrationInstance,
  deleteIntegrationInstance,
  getIntegrationInstance,
  listIntegrationInstances,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import { createMcpConnection } from "@/modules/mcp-connections/service";
import {
  createToolDefinition,
  deleteToolDefinition,
  getToolDefinition,
  listToolDefinitions,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import {
  createVaultEntry,
  deleteVaultEntry,
  listVaultEntries,
  vaultReferences,
} from "@/modules/vault/service";

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN — the role that tells `runScopedOn` the id never came from outside (issue #280).
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
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

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("tier-1 pools CRUD", () => {
  let tenant = 0n;
  let other = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "PoolA", slug: `pool-a-${process.pid}` },
    });
    tenant = a.id;
    const b = await suDb.tenant.create({
      data: { name: "PoolB", slug: `pool-b-${process.pid}` },
    });
    other = b.id;
  });

  afterAll(async () => {
    for (const tid of [tenant, other]) {
      if (!tid) continue;
      for (const tbl of [
        "tool_definitions",
        "business_hours",
        "vault_entries",
        "integration_instances",
        "mcp_server_connections",
        "scheduler_jobs",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("tool definitions: CRUD + name conflict + cross-tenant isolation", async () => {
    const td = await createToolDefinition(
      ctx(tenant),
      {
        name: "lookup",
        label: "Lookup",
        urlTemplate: "https://api.example.com/{{id}}",
        allowedHosts: ["api.example.com"],
        method: "GET",
      },
      appDb,
    );
    expect(td.method).toBe("GET");
    // label is required (the editor derives `name` from it, so it can never be blank)
    expect(
      createToolDefinition(
        ctx(tenant),
        {
          name: "no_label",
          label: "",
          urlTemplate: "https://api.example.com/x",
          allowedHosts: ["api.example.com"],
        },
        appDb,
      ),
    ).rejects.toThrow();
    // duplicate name → conflict
    expect(
      createToolDefinition(
        ctx(tenant),
        {
          name: "lookup",
          label: "Lookup again",
          urlTemplate: "https://api.example.com/x",
          allowedHosts: ["api.example.com"],
        },
        appDb,
      ),
    ).rejects.toThrow();
    const list = await listToolDefinitions(ctx(tenant), appDb);
    expect(list).toHaveLength(1);
    const updated = await updateToolDefinition(
      ctx(tenant),
      BigInt(td.id),
      { enabled: false },
      appDb,
    );
    expect(updated.enabled).toBe(false);
    // label persists; name (identifier) is renamable in place
    expect(td.label).toBe("Lookup");
    const labeled = await updateToolDefinition(
      ctx(tenant),
      BigInt(td.id),
      { label: "Busca por pedido", name: "buscar_pedido" },
      appDb,
    );
    expect(labeled.label).toBe("Busca por pedido");
    expect(labeled.name).toBe("buscar_pedido");
    // the new identifier is the one persisted + listed
    const afterRename = await getToolDefinition(
      ctx(tenant),
      BigInt(td.id),
      appDb,
    );
    expect(afterRename.name).toBe("buscar_pedido");
    expect(afterRename.label).toBe("Busca por pedido");
    // another tenant cannot see or fetch it
    expect(await listToolDefinitions(ctx(other), appDb)).toHaveLength(0);
    expect(
      getToolDefinition(ctx(other), BigInt(td.id), appDb),
    ).rejects.toThrow();
    await deleteToolDefinition(ctx(tenant), BigInt(td.id), appDb);
    expect(await listToolDefinitions(ctx(tenant), appDb)).toHaveLength(0);
  });

  test("tool definitions: programmatic authoring shapes are stored canonical", async () => {
    // NOTE: JSON-Schema input + OpenAPI-style single-brace path param (what an API/MCP author writes).
    const td = await createToolDefinition(
      ctx(tenant),
      {
        name: "consultar_cnpj",
        label: "Consultar CNPJ",
        urlTemplate: "https://api.example.com/v1/cnpj/{cnpj}",
        allowedHosts: ["api.example.com"],
        method: "GET",
        inputSchema: {
          required: ["cnpj"],
          properties: { cnpj: { type: "string", description: "CNPJ digits" } },
        },
      },
      appDb,
    );
    expect(td.inputSchema).toEqual({
      cnpj: { type: "string", description: "CNPJ digits", required: true },
    });
    expect(td.urlTemplate).toBe("https://api.example.com/v1/cnpj/{{cnpj}}");

    // NOTE: a partial update normalizes against the row's existing field set.
    const updated = await updateToolDefinition(
      ctx(tenant),
      BigInt(td.id),
      { urlTemplate: "https://api.example.com/v2/cnpj/{cnpj}" },
      appDb,
    );
    expect(updated.urlTemplate).toBe(
      "https://api.example.com/v2/cnpj/{{cnpj}}",
    );
    await deleteToolDefinition(ctx(tenant), BigInt(td.id), appDb);
  });

  test("vault: write-only secret, list names, references, delete", async () => {
    const { id: openaiId } = await createVaultEntry(
      ctx(tenant),
      "openai",
      "sk-secret-value",
      null,
      appDb,
    );
    const names = await listVaultEntries(ctx(tenant), appDb);
    expect(names).toContain("openai");
    // the list never returns the secret value
    expect(JSON.stringify(names)).not.toContain("sk-secret-value");
    // invalid name rejected: empty string after trim
    expect(
      createVaultEntry(ctx(tenant), "   ", "x", null, appDb),
    ).rejects.toThrow();
    // invalid name rejected: control character
    expect(
      createVaultEntry(ctx(tenant), "bad\x01name", "x", null, appDb),
    ).rejects.toThrow();
    // an unknown secret type is rejected
    expect(
      createVaultEntry(ctx(tenant), "typed", "x", "not-a-real-kind", appDb),
    ).rejects.toThrow();
    // a tool definition that references it shows up in references
    await createToolDefinition(
      ctx(tenant),
      {
        name: "paid",
        label: "Paid",
        urlTemplate: "https://api.example.com/p",
        allowedHosts: ["api.example.com"],
        credentialRef: `vault:${openaiId}`,
      },
      appDb,
    );
    const refs = await vaultReferences(ctx(tenant), openaiId, appDb);
    expect(refs.toolDefinitions).toContain("paid");
    await deleteVaultEntry(ctx(tenant), openaiId, appDb);
    expect(await listVaultEntries(ctx(tenant), appDb)).not.toContain("openai");
  });

  test("business hours: invalid timezone rejected, valid persists + updates", async () => {
    expect(
      createBusinessHours(
        ctx(tenant),
        { name: "BH", timezone: "Mars/Phobos" },
        appDb,
      ),
    ).rejects.toThrow();
    const bh = await createBusinessHours(
      ctx(tenant),
      {
        name: "Comercial",
        timezone: "America/Sao_Paulo",
        windows: [{ day: 1, start: "09:00", end: "18:00" }],
      },
      appDb,
    );
    expect(bh.windows).toHaveLength(1);
    const upd = await updateBusinessHours(
      ctx(tenant),
      BigInt(bh.id),
      { windows: [] },
      appDb,
    );
    expect(upd.windows).toHaveLength(0);
  });

  test("integrations: routeToken once, unknown catalogType rejected, CRUD", async () => {
    expect(
      createIntegrationInstance(
        ctxOf(tenant),
        { catalogType: "NOPE", name: "x" },
        appDb,
      ),
    ).rejects.toThrow();
    const created = await createIntegrationInstance(
      ctxOf(tenant),
      {
        catalogType: "ASAAS",
        name: "Payments",
        inboundAuthStrategy: "STATIC_HEADER",
      },
      appDb,
    );
    expect(created.routeToken).toBeTruthy();
    const list = await listIntegrationInstances(ctx(tenant), appDb);
    expect(list).toHaveLength(1);
    const got = await getIntegrationInstance(ctx(tenant), created.id, appDb);
    expect(got.catalogType).toBe("ASAAS");
    const upd = await updateIntegrationInstance(
      ctx(tenant),
      created.id,
      { enabled: false },
      appDb,
    );
    expect(upd.enabled).toBe(false);
    // cross-tenant cannot see it
    expect(await listIntegrationInstances(ctx(other), appDb)).toHaveLength(0);
    await deleteIntegrationInstance(ctx(tenant), created.id, appDb);
    expect(await listIntegrationInstances(ctx(tenant), appDb)).toHaveLength(0);
  });

  test("mcp connections: SSRF-blocked url + disabled stdio are rejected", async () => {
    // a private/loopback IP literal is rejected without any DNS lookup
    expect(
      createMcpConnection(
        ctx(tenant),
        {
          name: "local",
          transport: "streamableHttp",
          url: "https://127.0.0.1/mcp",
        },
        appDb,
      ),
    ).rejects.toThrow();
    // stdio is gated by config.mcpStdioEnabled (off by default in tests)
    expect(
      createMcpConnection(
        ctx(tenant),
        { name: "proc", transport: "stdio", command: "node server.js" },
        appDb,
      ),
    ).rejects.toThrow();
  });
});
