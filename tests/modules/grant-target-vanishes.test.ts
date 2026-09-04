import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  cloneAgent,
  replaceAgentToolSelections,
} from "@/modules/agents/service";
import { deleteCodeTool } from "@/modules/code-tools/service";

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
// A SECOND app connection, because the deadlock below needs two transactions open at once and one
// client's transaction is one connection.
let app2: PrismaClient | undefined;
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
    app2 = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app2.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const appDb2 = app2 as PrismaClient;
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
    await app2?.$disconnect();
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

  // The other half of the same window, and the one a not-found cannot answer. The delete takes the
  // namespace lock, then the tool row FOR UPDATE, then cascades into the selection rows. This path
  // used to take the agent row, delete the selection rows and only then ask the foreign key for the
  // tool row -- so each transaction held what the other needed next, and PostgreSQL resolved it by
  // killing one: `40P01 deadlock detected`, a 500 on whichever lost, and no P2003 for the mapping
  // above to catch (round 34). Ordering both behind the namespace lock is what removes the cycle.
  //
  // The interleaving is forced, not waited for: the delete starts INSIDE the save's insert, and the
  // pause is long enough for it to reach the lock it will wait on.
  test("a delete racing a save deadlocks with neither", async () => {
    const ag = await agent();
    const doomed = await suDb.codeToolDefinition.create({
      data: {
        tenantId,
        name: `deadlock-${process.pid}`,
        label: "l",
        description: "d",
        code: "return 1",
      },
    });
    const kept = await suDb.codeToolDefinition.create({
      data: {
        tenantId,
        name: `deadlock-kept-${process.pid}`,
        label: "l",
        description: "d",
        code: "return 1",
      },
    });
    // The row the delete's cascade has to take out, and the reason the two transactions meet.
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: ag.id,
        source: "CODE",
        codeToolDefinitionId: doomed.id,
        knowledgeBaseIds: [],
        enabledTools: [],
      },
    });

    let deleting: Promise<unknown> | undefined;
    const interleaved = appDb.$extends({
      query: {
        agentToolSelection: {
          async createMany({ args, query }) {
            deleting = deleteCodeTool(ctx, doomed.id, appDb2).then(
              () => undefined,
              (e: unknown) => e,
            );
            await new Promise((r) => setTimeout(r, 400));
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const saved = await replaceAgentToolSelections(
      ctx,
      ag.id,
      [
        { source: "CODE", codeToolDefinitionId: String(kept.id) },
        { source: "CODE", codeToolDefinitionId: String(doomed.id) },
      ] as never,
      interleaved,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    const deleted = await deleting;
    // 40P01 is the database's, and Prisma wraps it as P2039 with the code in the message, so the
    // assertion reads the text rather than a code that would pass on any other failure.
    const deadlocked = (e: unknown) =>
      e instanceof Error && /40P01|deadlock/i.test(e.message);
    expect([saved && String(saved), deadlocked(saved)]).toEqual([
      saved && String(saved),
      false,
    ]);
    expect([deleted && String(deleted), deadlocked(deleted)]).toEqual([
      deleted && String(deleted),
      false,
    ]);
  }, 30_000);

  // The third path that writes selection rows, and the one whose ids come from ANOTHER agent: a
  // clone reads the source's grants and writes them under a new agent. A tool deleted between the
  // two leaves the copy pointing at a row that is gone, the foreign key refuses it, and because the
  // clone is one transaction the operator loses the agent and not the grant (round 35). The same
  // lock orders it: the delete either goes first, and its cascade takes the source grant with it so
  // there is nothing to copy, or it waits.
  test("a clone racing a delete of what it copies still produces an agent", async () => {
    const src = await agent();
    const tool = await suDb.codeToolDefinition.create({
      data: {
        tenantId,
        name: `cloned-${process.pid}`,
        label: "l",
        description: "d",
        code: "return 1",
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: src.id,
        source: "CODE",
        codeToolDefinitionId: tool.id,
        knowledgeBaseIds: [],
        enabledTools: [],
      },
    });

    let deleting: Promise<unknown> | undefined;
    const interleaved = appDb.$extends({
      query: {
        agentToolSelection: {
          async createMany({ args, query }) {
            deleting = deleteCodeTool(ctx, tool.id, appDb2).then(
              () => undefined,
              (e: unknown) => e,
            );
            await new Promise((r) => setTimeout(r, 400));
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const cloned = await cloneAgent(ctx, src.id, "copy", interleaved).then(
      (a) => a,
      (e: unknown) => e,
    );
    await deleting;
    expect([
      cloned instanceof Error ? String(cloned) : "ok",
      cloned instanceof Error,
    ]).toEqual([cloned instanceof Error ? String(cloned) : "ok", false]);
  }, 30_000);

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
