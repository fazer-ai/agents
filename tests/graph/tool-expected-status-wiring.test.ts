import { afterAll, describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildHttpTools, loadToolSelections } from "@/graph/tools/assemble";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { outboundUrl } from "../utils/outbound";

const OUTBOUND_HOST = new URL(outboundUrl()).hostname;

// Issue #59, review finding of round 1. The declaration is stored by three transports and read by
// the HTTP tool, but a real agent turn does not use any of those paths to get it: it goes through
// `loadToolSelections`, whose Prisma `select` enumerates the columns it wants. A column missing from
// that list is silently `undefined`, so the whole feature would be configurable everywhere and dead
// in the one place it exists for — a 404 declared as a result would still be a warn on every turn.
//
// This walks the real path: a row in `tool_definitions`, loaded the way a turn loads it, built into
// the tool a turn builds, answered with a 404.

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

const tenants: bigint[] = [];

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function seedAgentWithTool(expectedStatuses: number[]) {
  const tenant = await suDb.tenant.create({
    data: { name: "es-wiring", slug: `es-wiring-${process.pid}-${Date.now()}` },
  });
  tenants.push(tenant.id);
  const agent = await suDb.agent.create({
    data: { tenantId: tenant.id, name: "A", systemPrompt: "p" },
  });
  const tool = await suDb.toolDefinition.create({
    data: {
      tenantId: tenant.id,
      name: "lookup",
      label: "Lookup",
      method: "GET",
      // An IP literal, not a hostname: the SSRF guard resolves names through node:dns, which would
      // make this database test also need working egress (tests/utils/outbound.ts).
      urlTemplate: outboundUrl("/v1/records/1"),
      allowedHosts: [OUTBOUND_HOST],
      expectedStatuses,
    },
  });
  await suDb.agentToolSelection.create({
    data: {
      tenantId: tenant.id,
      agentId: agent.id,
      source: "HTTP",
      toolDefinitionId: tool.id,
      // Both array columns are NOT NULL with no default.
      enabledTools: [],
      knowledgeBaseIds: [],
    },
  });
  return { tenantId: tenant.id, agentId: agent.id };
}

// Answers every request with the given status, the way the tool's own suite stubs it.
function stubFetch(status: number) {
  return async () =>
    new Response('{"found":false}', {
      status,
      headers: { "content-type": "application/json" },
    });
}

async function invokeLoadedTool(tenantId: bigint, agentId: bigint) {
  const sel = await runScopedOn(appDb, ctx(tenantId), (db) =>
    loadToolSelections(db, agentId),
  );
  // `buildHttpTools` (the plural form a turn uses) takes no fetch injection — that seam exists only
  // on the singular builder, and going through the singular one would skip the very mapping the
  // finding was about. So the global is swapped for the call and restored right after.
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(404) as unknown as typeof fetch;
  try {
    const [tool] = buildHttpTools(sel.httpToolDefs, {
      resolveCredential: async () => null,
    });
    if (!tool) throw new Error("the HTTP tool was not assembled");
    return {
      loaded: sel.httpToolDefs[0],
      message: (await tool.invoke({
        type: "tool_call",
        id: "call_wiring",
        name: "lookup",
        args: {},
      })) as ToolMessage,
    };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe.skipIf(!dbUp)(
  "expected statuses survive the path a real turn takes",
  () => {
    afterAll(async () => {
      for (const t of tenants) {
        await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("a declared status reaches the assembled tool and stops being a failure", async () => {
      const { tenantId, agentId } = await seedAgentWithTool([404]);
      const { loaded, message } = await invokeLoadedTool(tenantId, agentId);
      expect(loaded?.expectedStatuses).toEqual([404]);
      expect(message.status).toBe("success");
      // The model-facing text does not depend on the declaration; only the marking moves.
      expect(String(message.content)).toContain("HTTP 404");
    });

    test("a tool that declares nothing keeps issue #40's behavior", async () => {
      const { tenantId, agentId } = await seedAgentWithTool([]);
      const { loaded, message } = await invokeLoadedTool(tenantId, agentId);
      expect(loaded?.expectedStatuses).toEqual([]);
      expect(message.status).toBe("error");
    });
  },
);
