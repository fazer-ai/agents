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
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";

// The gap between "this grant names a tool that exists" and the insert that points at it.
// `replaceAgentToolSelections` reads every target, then rewrites the selection rows, and nothing
// cheap holds the targets still in between: the sources span five tables, and the tool services'
// namespace lock covers two. So the race is ANSWERED, not closed: a target deleted in the gap is the
// same event as one that was never there, and the caller gets the read's not-found instead of a 500
// from an unmapped P2003 (`agent_tool_selections_code_tool_definition_id_fkey`). The race is REAL: the
// delete commits on a second connection inside the window, held open by a query extension on the
// writer's client, which supplies only the TIMING.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
// A SECOND app connection, because the deadlock below needs two transactions open at once and one
// client's transaction is one connection.
let app2: PrismaClient | undefined;
// The racing delete's connections carry this name, so a case can see that delete waiting on a lock.
const DELETER = `grant-target-delete-${process.pid}`;
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
      adapter: new PrismaPg({
        connectionString: appUrl,
        application_name: DELETER,
      }),
    });
    await app2.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const appDb2 = app2 as PrismaClient;

const suDb = su as PrismaClient;

// Lets the racing delete reach the lock it will wait on: parked on a lock, as the ordering has it, or
// over (refused or done) without waiting, which the assertions then read.
async function deleteWaitsOrEnds(deleting: Promise<unknown>): Promise<void> {
  let over = false;
  void deleting.finally(() => {
    over = true;
  });
  await until("the delete parked on a lock, or over", async () => {
    if (over) return true;
    const [row] = await suDb.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = ${DELETER}
         AND wait_event_type = 'Lock'`;
    return Number(row?.n ?? 0) > 0;
  });
}

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

  // NOTE: The same answer for a source that has nothing to do with code tools, because the answer is one
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

  // NOTE: The other half of the same window, which a not-found cannot answer. The delete takes the namespace
  // lock, then the tool row FOR UPDATE, then cascades into the selection rows. A save that took the
  // agent row and deleted selection rows before its foreign key asked for the tool row would hold what
  // the delete needs next, and PostgreSQL would kill one (`40P01 deadlock detected`, a 500 with no
  // P2003 to map). Ordering both behind the namespace lock removes the cycle. Forced, not waited for:
  // the delete starts INSIDE the save's insert, and the pause lets it reach the lock it will wait on.
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
            await deleteWaitsOrEnds(deleting);
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
    // The save holds the lock, so it lands whole; the delete then goes, and its cascade takes the
    // doomed grant. Neither fails, so a 40P01 (or any other error) shows here as its own text.
    expect(saved === undefined ? "saved" : String(saved)).toBe("saved");
    expect(deleted === undefined ? "deleted" : String(deleted)).toBe("deleted");
    const grants = await suDb.agentToolSelection.findMany({
      where: { agentId: ag.id },
      select: { codeToolDefinitionId: true },
    });
    expect(grants.map((g) => g.codeToolDefinitionId)).toEqual([kept.id]);
    expect(
      await suDb.codeToolDefinition.findUnique({ where: { id: doomed.id } }),
    ).toBeNull();
  }, 30_000);

  // NOTE: The third path that writes selection rows, and the one whose ids come from ANOTHER agent: a clone
  // reads the source's grants and writes them under a new agent. A tool deleted between the two would
  // leave the copy pointing at a row that is gone, and because the clone is one transaction the
  // operator would lose the agent, not just the grant. The same lock orders it: the delete either goes
  // first, and its cascade takes the source grant with it, or it waits.
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
            await deleteWaitsOrEnds(deleting);
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const cloned = await cloneAgent(ctx, src.id, "copy", interleaved).then(
      (a) => a,
      (e: unknown) => e,
    );
    const deleted = await deleting;
    expect(cloned instanceof Error ? String(cloned) : "cloned").toBe("cloned");
    expect(deleted === undefined ? "deleted" : String(deleted)).toBe("deleted");
    // The copy exists under its new name, and the delete's cascade left it no grant to the tool.
    const copy = await suDb.agent.findUnique({
      where: { id: BigInt((cloned as { id: string }).id) },
      select: { name: true },
    });
    expect(copy?.name).toBe("copy");
    expect(
      await suDb.agentToolSelection.count({
        where: { codeToolDefinitionId: tool.id },
      }),
    ).toBe(0);
    expect(
      await suDb.codeToolDefinition.findUnique({ where: { id: tool.id } }),
    ).toBeNull();
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
