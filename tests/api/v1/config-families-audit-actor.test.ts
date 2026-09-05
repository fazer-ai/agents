import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { outboundUrl } from "@/tests/utils/outbound";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The five configuration families' trail, driven through real requests to the console's own doors.
//
// `tests/modules/audit-config-families.test.ts` proves the SERVICES record. It cannot see the half
// issue #399 is about: whether the REST routes reach those services with a principal at all. None
// of the five controllers contains the string `audit`, and a row can only name who wrote it if the
// transport hands the context down — so the assertion here is on `actorId` and `actorType`, over
// requests carrying a real session cookie.
//
// The services are WRAPPED and the wrappers call through, for the reason `mock.module` always
// demands here: it is global to the process and outlives this file for every other one in the same
// worker, so a stub that swallowed the real behaviour would turn somebody else's file green for the
// wrong reason. All a wrapper does is give the write the test database, which the controller has no
// way to inject.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

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

setupPrismaMock();

const tools = await import("@/modules/tool-definitions/service");
const conns = await import("@/modules/mcp-connections/service");
const integrations = await import("@/modules/integrations/service");
const experiments = await import("@/modules/experiments/service");
const templates = await import("@/modules/documents/templates");
// COPIES taken before the mocks are installed: Bun updates the imported namespace in place, so a
// wrapper that called the module by name would call itself.
const realTools = { ...tools };
const realConns = { ...conns };
const realIntegrations = { ...integrations };
const realExperiments = { ...experiments };
const realTemplates = { ...templates };

mock.module("@/modules/tool-definitions/service", () => ({
  ...realTools,
  createToolDefinition: mock(
    (
      ctx: TenantContext,
      input: Parameters<typeof tools.createToolDefinition>[1],
    ) => realTools.createToolDefinition(ctx, input, app),
  ),
  updateToolDefinition: mock(
    (
      ctx: TenantContext,
      id: bigint,
      patch: Parameters<typeof tools.updateToolDefinition>[2],
    ) => realTools.updateToolDefinition(ctx, id, patch, app),
  ),
  deleteToolDefinition: mock((ctx: TenantContext, id: bigint) =>
    realTools.deleteToolDefinition(ctx, id, app),
  ),
  listToolDefinitions: (ctx: TenantContext) =>
    realTools.listToolDefinitions(ctx, app),
  getToolDefinition: (ctx: TenantContext, id: bigint) =>
    realTools.getToolDefinition(ctx, id, app),
}));

mock.module("@/modules/mcp-connections/service", () => ({
  ...realConns,
  createMcpConnection: mock(
    (
      ctx: TenantContext,
      input: Parameters<typeof conns.createMcpConnection>[1],
    ) => realConns.createMcpConnection(ctx, input, app),
  ),
  updateMcpConnection: mock(
    (
      ctx: TenantContext,
      id: bigint,
      patch: Parameters<typeof conns.updateMcpConnection>[2],
    ) => realConns.updateMcpConnection(ctx, id, patch, app),
  ),
  deleteMcpConnection: mock((ctx: TenantContext, id: bigint) =>
    realConns.deleteMcpConnection(ctx, id, app),
  ),
  listMcpConnections: (ctx: TenantContext) =>
    realConns.listMcpConnections(ctx, app),
  getMcpConnection: (ctx: TenantContext, id: bigint) =>
    realConns.getMcpConnection(ctx, id, app),
  // Wrapped like the writers, and it is the wrapping that makes the discover assertion mean
  // anything: without it the route reaches the MOCKED base client and 500s on a missing delegate,
  // so the row count would be zero because the probe never arrived rather than because the read
  // records nothing.
  discoverMcpTools: mock((ctx: TenantContext, id: bigint) =>
    realConns.discoverMcpTools(ctx, id, app),
  ),
}));

mock.module("@/modules/integrations/service", () => ({
  ...realIntegrations,
  createIntegrationInstance: mock(
    (
      ctx: TenantContext,
      params: Parameters<typeof integrations.createIntegrationInstance>[1],
    ) => realIntegrations.createIntegrationInstance(ctx, params, app),
  ),
  updateIntegrationInstance: mock(
    (
      ctx: TenantContext,
      id: bigint,
      params: Parameters<typeof integrations.updateIntegrationInstance>[2],
    ) => realIntegrations.updateIntegrationInstance(ctx, id, params, app),
  ),
  rotateIntegrationRouteToken: mock((ctx: TenantContext, id: bigint) =>
    realIntegrations.rotateIntegrationRouteToken(ctx, id, app),
  ),
  deleteIntegrationInstance: mock((ctx: TenantContext, id: bigint) =>
    realIntegrations.deleteIntegrationInstance(ctx, id, app),
  ),
  listIntegrationInstances: (ctx: TenantContext) =>
    realIntegrations.listIntegrationInstances(ctx, app),
  getIntegrationInstance: (ctx: TenantContext, id: bigint) =>
    realIntegrations.getIntegrationInstance(ctx, id, app),
}));

mock.module("@/modules/experiments/service", () => ({
  ...realExperiments,
  createExperiment: mock(
    (params: Parameters<typeof experiments.createExperiment>[0]) =>
      realExperiments.createExperiment({ ...params, base: app }),
  ),
  updateExperiment: mock(
    (params: Parameters<typeof experiments.updateExperiment>[0]) =>
      realExperiments.updateExperiment({ ...params, base: app }),
  ),
  deleteExperiment: mock((ctx: TenantContext, id: bigint) =>
    realExperiments.deleteExperiment(ctx, id, app),
  ),
  listExperiments: (ctx: TenantContext) =>
    realExperiments.listExperiments(ctx, app),
  getExperiment: (ctx: TenantContext, id: bigint) =>
    realExperiments.getExperiment(ctx, id, app),
}));

mock.module("@/modules/documents/templates", () => ({
  ...realTemplates,
  createDocumentTemplate: mock(
    (
      ctx: TenantContext,
      input: Parameters<typeof templates.createDocumentTemplate>[1],
    ) => realTemplates.createDocumentTemplate(ctx, input, app),
  ),
  updateDocumentTemplate: mock(
    (
      ctx: TenantContext,
      id: bigint,
      patch: Parameters<typeof templates.updateDocumentTemplate>[2],
    ) => realTemplates.updateDocumentTemplate(ctx, id, patch, app),
  ),
  deleteDocumentTemplate: mock((ctx: TenantContext, id: bigint) =>
    realTemplates.deleteDocumentTemplate(ctx, id, app),
  ),
  listDocumentTemplates: (ctx: TenantContext) =>
    realTemplates.listDocumentTemplates(ctx, app),
  getDocumentTemplate: (ctx: TenantContext, id: bigint) =>
    realTemplates.getDocumentTemplate(ctx, id, app),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe below: an `afterAll` inside a `describe.skipIf(...)` that skips
// does NOT run, while this one does. `mock.module` already installed the wrappers globally for the
// whole worker by the time `dbUp` was decided.
afterAll(() => {
  mock.module("@/modules/tool-definitions/service", () => realTools);
  mock.module("@/modules/mcp-connections/service", () => realConns);
  mock.module("@/modules/integrations/service", () => realIntegrations);
  mock.module("@/modules/experiments/service", () => realExperiments);
  mock.module("@/modules/documents/templates", () => realTemplates);
});

const ADMIN_ID = 9398n;
let tenantId = 0n;
// An experiment names the agent it applies to, so the family below needs one to exist.
let experimentAgentId = 0n;
let cookie = "";

const rows = async () =>
  (await su?.auditLog.findMany({
    where: { actorId: ADMIN_ID },
    orderBy: { id: "asc" },
  })) ?? [];

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE actor_id = ${ADMIN_ID}`,
  );
}

function req(path: string, init: RequestInit = {}): Request {
  return new BunRequest(`http://localhost/api/v1${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...init.headers },
  });
}

const uniq = () => `${process.pid}${Math.floor(Math.random() * 1e6)}`;

// One family = the three console doors, as PATHS and BODIES rather than as function calls. What is
// under test is the transport, so nothing here may reach a service by name.
interface RestFamily {
  key: string;
  entity: string;
  createPath: string;
  createBody: () => Record<string, unknown>;
  idOf: (json: Record<string, unknown>) => string;
  itemPath: (id: string) => string;
  patchBody: Record<string, unknown>;
}

const REST: RestFamily[] = [
  {
    key: "tool",
    entity: "tool",
    createPath: "/tools",
    createBody: () => ({
      name: `rt${uniq()}`,
      label: "l",
      urlTemplate: outboundUrl("/x"),
      allowedHosts: ["203.0.113.10"],
    }),
    idOf: (j) => String((j.tool as { id: string }).id),
    itemPath: (id) => `/tools/${id}`,
    patchBody: { enabled: false },
  },
  {
    key: "mcp_connection",
    entity: "mcp_connection",
    createPath: "/mcp-connections",
    createBody: () => ({
      name: `rm${uniq()}`,
      transport: "streamableHttp",
      url: outboundUrl("/mcp"),
    }),
    idOf: (j) => String((j.connection as { id: string }).id),
    itemPath: (id) => `/mcp-connections/${id}`,
    patchBody: { enabled: false },
  },
  {
    key: "integration",
    entity: "integration",
    createPath: "/integrations/instances",
    createBody: () => ({ catalogType: "ASAAS", name: `ri${uniq()}` }),
    idOf: (j) => String(j.id),
    itemPath: (id) => `/integrations/instances/${id}`,
    patchBody: { enabled: false },
  },
  {
    key: "experiment",
    entity: "experiment",
    createPath: "/experiments",
    createBody: () => ({
      name: `re${uniq()}`,
      agentId: String(experimentAgentId),
      variants: [
        { key: "a", systemPrompt: "A" },
        { key: "b", systemPrompt: "B" },
      ],
    }),
    idOf: (j) => String(j.id),
    itemPath: (id) => `/experiments/${id}`,
    patchBody: { enabled: false },
  },
  {
    key: "document_template",
    entity: "document_template",
    createPath: "/document-templates",
    createBody: () => ({
      name: `rd${uniq()}`,
      blocks: [{ id: "t", type: "text", text: "x" }],
      fields: [],
    }),
    idOf: (j) => String((j.template as { id: string }).id),
    itemPath: (id) => `/document-templates/${id}`,
    patchBody: { enabled: false },
  },
];

describe.skipIf(!dbUp)("the console's own doors name who wrote", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    const t = await su.tenant.create({
      data: { name: "CFGREST", slug: `cfgrest-${process.pid}` },
    });
    tenantId = t.id;
    const a = await su.agent.create({
      data: { tenantId, name: "CFGREST target", systemPrompt: "" },
      select: { id: true },
    });
    experimentAgentId = a.id;
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: ADMIN_ID,
        tenantId,
        email: "admin@example.com",
        passwordHash: null,
        googleId: null,
        name: null,
        role: "TENANT_ADMIN" as const,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const token = await new SignJWT({
      userId: ADMIN_ID.toString(),
      email: "admin@example.com",
      role: "TENANT_ADMIN",
      tenantId: tenantId.toString(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret));
    cookie = `fazerai_auth_token=${token}`;
    await clearAudit();
  });

  afterAll(async () => {
    // `dbUp`, not `su`: the probe assigns the client and only then checks the connection, so a
    // configured-but-unreachable database leaves `su` truthy while the suite skips.
    if (dbUp && su && tenantId) {
      for (const table of [
        "audit_logs",
        "tool_definitions",
        "mcp_server_connections",
        "integration_instances",
        "experiments",
        "document_templates",
      ]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  for (const f of REST) {
    test(`${f.key}: create, update and delete from the console each leave a row naming the operator`, async () => {
      await clearAudit();

      const created = await server.handle(
        req(f.createPath, {
          method: "POST",
          body: JSON.stringify(f.createBody()),
        }),
      );
      expect(created.status).toBe(200);
      const id = f.idOf((await created.json()) as Record<string, unknown>);

      const patched = await server.handle(
        req(f.itemPath(id), {
          method: "PATCH",
          body: JSON.stringify(f.patchBody),
        }),
      );
      expect(patched.status).toBe(200);

      const removed = await server.handle(
        req(f.itemPath(id), { method: "DELETE" }),
      );
      expect(removed.status).toBe(200);

      const r = await rows();
      expect(r.map((x) => x.action)).toEqual([
        `${f.entity}.create`,
        `${f.entity}.update`,
        `${f.entity}.delete`,
      ]);
      // The door is a browser session, so every row is attributed to one — and to the operator
      // behind it, which is the half no transport-written row could ever have covered for REST.
      expect(r.every((x) => x.actorType === "user")).toBe(true);
      expect(r.every((x) => x.actorId === ADMIN_ID)).toBe(true);
      expect(r.every((x) => x.tenantId === tenantId)).toBe(true);
      expect(r.map((x) => x.target)).toEqual([
        `${f.entity}:${id}`,
        `${f.entity}:${id}`,
        `${f.entity}:${id}`,
      ]);
    });

    test(`${f.key}: a create with no session is refused before anything is recorded`, async () => {
      await clearAudit();
      const res = await server.handle(
        new BunRequest(`http://localhost/api/v1${f.createPath}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(f.createBody()),
        }),
      );
      expect(res.status).toBe(401);
      expect(await rows()).toEqual([]);
    });
  }

  test("rotating a route token from the console leaves a row, and the token is not in it", async () => {
    await clearAudit();
    const created = await server.handle(
      req("/integrations/instances", {
        method: "POST",
        body: JSON.stringify({ catalogType: "ASAAS", name: `rr${uniq()}` }),
      }),
    );
    const id = String(((await created.json()) as { id: string }).id);
    await clearAudit();

    const rotated = await server.handle(
      req(`/integrations/instances/${id}/route-token`, { method: "POST" }),
    );
    expect(rotated.status).toBe(200);
    const { routeToken } = (await rotated.json()) as { routeToken: string };

    const r = await rows();
    expect(r.map((x) => x.action)).toEqual(["integration.rotate_token"]);
    expect(r[0]?.target).toBe(`integration:${id}`);
    expect(r[0]?.actorId).toBe(ADMIN_ID);
    expect(
      JSON.stringify(r[0], (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toContain(routeToken);

    await server.handle(
      req(`/integrations/instances/${id}`, { method: "DELETE" }),
    );
  });
});
