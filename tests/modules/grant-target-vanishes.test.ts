import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { replaceAgentToolSelections } from "@/modules/agents/service";

// The gap between "this grant names a tool that exists" and the insert that points at it.
//
// `replaceAgentToolSelections` reads every target, then deletes the old selection rows and writes
// the new ones. Nothing holds the targets still across those two steps, and nothing can cheaply:
// the sources span five tables, and the namespace lock the tool services take is keyed to the tool
// NAMESPACE, so it would cover two of them and leave MCP connections, integrations and knowledge
// bases exactly as they are. So the race is not closed here; it is ANSWERED. A target deleted in
// the gap is the same event as a target that was never there, and the caller gets the not-found the
// read itself would have given a moment earlier instead of a 500 (round 31).
//
// Measured before the fix, on a real insert: PrismaClientKnownRequestError, code P2003, constraint
// `agent_tool_selections_code_tool_definition_id_fkey`. Nothing in the API maps P2003, so it left
// the console with a generic failure and the operator with no idea which tool went away.
//
// The race here is REAL, not simulated: the delete commits on a second connection, in the window
// between the check and the insert, held open by a query extension on the writer's own client. What
// the extension supplies is the TIMING; every row and every statement is the production path's.

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

describe.skipIf(!dbUp)("a grant target deleted mid-save", () => {
  let tenantId = 0n;
  let ctx: TenantContext;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Vanish", slug: `vanish-${process.pid}` },
    });
    tenantId = t.id;
    ctx = { tenantId, role: "TENANT_ADMIN", userId: 1n } as TenantContext;
  });

  afterAll(async () => {
    if (!su || !tenantId) return;
    await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await su.$disconnect();
    await app?.$disconnect();
  });

  const agent = () =>
    suDb.agent.create({
      data: {
        tenantId,
        name: "A",
        systemPrompt: "p",
        modelConfig: {},
        settings: {},
      },
    });

  // The client the write runs on, with the concurrent delete wired into the exact instant the
  // insert happens. `$extends` composes: `runScopedOn` layers the tenant scoping on top of this, so
  // the hook still fires, and `deleteBy` runs on a DIFFERENT connection and COMMITS, which is what
  // makes the writer's already-read row disappear under it.
  const racing = (deleteIt: () => Promise<unknown>) =>
    appDb.$extends({
      query: {
        agentToolSelection: {
          async createMany({ args, query }) {
            await deleteIt();
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

  test("a code tool deleted between the check and the insert is a not-found", async () => {
    const ag = await agent();
    const tool = await suDb.codeToolDefinition.create({
      data: {
        tenantId,
        name: `vanish-code-${process.pid}`,
        label: "l",
        description: "d",
        code: "return 1",
      },
    });
    const err = await replaceAgentToolSelections(
      ctx,
      ag.id,
      [{ source: "CODE", codeToolDefinitionId: String(tool.id) }] as never,
      racing(() => suDb.codeToolDefinition.delete({ where: { id: tool.id } })),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(404);
    expect((err as AppError).translationKey).toBe("errors.codeToolNotFound");
  });

  // The same answer for a source that has nothing to do with code tools, because the fix is one
  // rule over the whole insert and not a code-tool special case.
  test("an HTTP tool deleted in the same window answers for ITS source", async () => {
    const ag = await agent();
    const tool = await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: `vanish-http-${process.pid}`,
        label: "l",
        urlTemplate: "https://example.com/x",
        allowedHosts: ["example.com"],
      },
    });
    const err = await replaceAgentToolSelections(
      ctx,
      ag.id,
      [{ source: "HTTP", toolDefinitionId: String(tool.id) }] as never,
      racing(() => suDb.toolDefinition.delete({ where: { id: tool.id } })),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(404);
    expect((err as AppError).translationKey).toBe(
      "errors.toolDefinitionNotFound",
    );
  });

  // The control, and it is what keeps the catch from becoming "answer not-found whenever the write
  // fails": nothing was deleted, so the save applies and the grant is there to read.
  test("no deletion, no refusal", async () => {
    const ag = await agent();
    const tool = await suDb.codeToolDefinition.create({
      data: {
        tenantId,
        name: `stays-${process.pid}`,
        label: "l",
        description: "d",
        code: "return 1",
      },
    });
    const view = await replaceAgentToolSelections(
      ctx,
      ag.id,
      [{ source: "CODE", codeToolDefinitionId: String(tool.id) }] as never,
      appDb,
    );
    expect(view.grants).toHaveLength(1);
    expect(view.grants[0]?.source).toBe("CODE");
  });
});
