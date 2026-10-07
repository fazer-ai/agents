import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { listExecutionLogs } from "@/modules/flowlog/read";
import { clearFlowLog } from "../utils/flowlog";

// The dashboard's health block opens the Logs page on one tool's failures in one inbox,
// so the reader filters by the tool a line names and by the inbox it carries.

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

describe.skipIf(!dbUp)("the Logs reader filters by tool and inbox", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "LOGTOOL", slug: `logtool-${process.pid}` },
    });
    tenantId = t.id;
    const line = (tool: string, inboxId: bigint | null, level = "warn") => ({
      tenantId,
      turnId: crypto.randomUUID(),
      stage: "tool",
      level,
      status: "error",
      source: "inbox",
      inboxId,
      detail: { tool, args: {} },
    });
    await suDb.executionLog.createMany({
      data: [
        line("consultar_pedido", 1n),
        line("consultar_pedido", 1n),
        line("consultar_pedido", 2n),
        line("buscar_evento", 1n),
        // A tool warning written before any tool was known: no `detail.tool` at all.
        {
          ...line("x", 1n),
          detail: { server: "crm", error: "listing failed" },
        },
      ],
    });
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  const ctx = () => ({ tenantId, userId: null, role: "TENANT_ADMIN" as const });

  test("one tool's lines, and only them", async () => {
    const r = await listExecutionLogs(
      ctx(),
      { tool: "consultar_pedido" },
      appDb,
    );
    expect(r.items).toHaveLength(3);
    expect(
      r.items.every(
        (i) => (i.detail as { tool?: string }).tool === "consultar_pedido",
      ),
    ).toBe(true);
  });

  test("one inbox, alone and with the tool", async () => {
    expect(
      (await listExecutionLogs(ctx(), { inboxId: 1n }, appDb)).items,
    ).toHaveLength(4);
    expect(
      (
        await listExecutionLogs(
          ctx(),
          { inboxId: 1n, tool: "consultar_pedido" },
          appDb,
        )
      ).items,
    ).toHaveLength(2);
  });

  test("the lines that name no tool, and only them", async () => {
    const r = await listExecutionLogs(
      ctx(),
      { stage: "tool", noTool: true },
      appDb,
    );
    expect(r.items).toHaveLength(1);
    expect(
      (r.items[0]?.detail as { server?: string } | undefined)?.server,
    ).toBe("crm");
  });
});
