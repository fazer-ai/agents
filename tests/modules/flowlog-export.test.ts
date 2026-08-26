import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  exportExecutionLogs,
  MAX_LOG_EXPORT_ROWS,
  serializeLogItems,
} from "@/modules/flowlog/export";
import type { ExecutionLogItem } from "@/modules/flowlog/read";
import { clearFlowLog } from "@/tests/utils/flowlog";

// ── pure serialization (no DB) ──

function item(over: Partial<ExecutionLogItem> = {}): ExecutionLogItem {
  return {
    id: "1",
    turnId: "t1",
    conversationId: null,
    agentId: null,
    inboxId: null,
    threadId: null,
    stage: "generate",
    level: "info",
    status: "ok",
    provider: null,
    model: null,
    durationMs: null,
    source: "inbox",
    detail: null,
    errorMessage: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

describe("serializeLogItems", () => {
  test("json round-trips the items losslessly", () => {
    const items = [item({ id: "2", detail: { a: 1, b: ["x", "y"] } })];
    expect(JSON.parse(serializeLogItems(items, "json"))).toEqual(items);
  });

  test("json of an empty export is an empty array", () => {
    expect(serializeLogItems([], "json")).toBe("[]");
  });

  test("csv starts with the header row and one line per item", () => {
    const csv = serializeLogItems([item(), item({ id: "2" })], "csv");
    const [header] = csv.split("\r\n");
    expect(header).toBe(
      "id,createdAt,source,turnId,stage,level,status,provider,model,durationMs,conversationId,agentId,inboxId,threadId,errorMessage,detail",
    );
    // header + 2 rows (rows never contain a bare newline here).
    expect(csv.split("\r\n")).toHaveLength(3);
  });

  test("csv of an empty export is header-only", () => {
    expect(serializeLogItems([], "csv")).not.toContain("\r\n");
  });

  test("csv quotes cells with commas, quotes or newlines (RFC 4180)", () => {
    const csv = serializeLogItems(
      [
        item({
          errorMessage: 'he said "hi", then\nleft',
          detail: { note: "x,y" },
        }),
      ],
      "csv",
    );
    // Embedded quotes are doubled and the whole cell wrapped.
    expect(csv).toContain('"he said ""hi"", then\nleft"');
    // The nested detail object lands as one JSON-string cell, quoted for its comma.
    expect(csv).toContain('"{""note"":""x,y""}"');
  });
});

// ── DB-backed: filter reuse, truncation, RLS (skipped when the test DB is down) ──

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

let tenantA = 0n;
let tenantB = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("exportExecutionLogs", () => {
  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "ExpA", slug: `exp-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "ExpB", slug: `exp-b-${process.pid}` },
      })
    ).id;
    await suDb.executionLog.createMany({
      data: [
        {
          tenantId: tenantA,
          turnId: "e1",
          stage: "generate",
          level: "info",
          source: "inbox",
        },
        {
          tenantId: tenantA,
          turnId: "e1",
          stage: "tts",
          level: "error",
          source: "inbox",
          errorMessage: "boom",
        },
        {
          tenantId: tenantA,
          turnId: "e2",
          stage: "generate",
          level: "info",
          source: "playground",
        },
        {
          tenantId: tenantB,
          turnId: "b1",
          stage: "generate",
          level: "info",
          source: "inbox",
        },
      ],
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await clearFlowLog(suDb, { tenantId: tid });
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("reuses the list filters: source defaults to inbox (playground excluded)", async () => {
    const res = await exportExecutionLogs(
      ctx(tenantA),
      { format: "json" },
      appDb,
    );
    const items = JSON.parse(res.content) as ExecutionLogItem[];
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.source === "inbox")).toBe(true);
    expect(res.count).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.filename).toMatch(/^agents-logs-.*\.json$/);
    expect(res.contentType).toBe("application/json");
  });

  test("stage filter narrows the export", async () => {
    const res = await exportExecutionLogs(
      ctx(tenantA),
      { format: "json", stage: "tts" },
      appDb,
    );
    const items = JSON.parse(res.content) as ExecutionLogItem[];
    expect(items).toHaveLength(1);
    expect(items[0]?.stage).toBe("tts");
  });

  test("maxRows caps the dump and flags truncation (newest first)", async () => {
    const res = await exportExecutionLogs(
      ctx(tenantA),
      { format: "json", maxRows: 1 },
      appDb,
    );
    expect(res.count).toBe(1);
    expect(res.truncated).toBe(true);
  });

  test("maxRows is clamped to the hard cap", async () => {
    const res = await exportExecutionLogs(
      ctx(tenantA),
      { format: "json", maxRows: MAX_LOG_EXPORT_ROWS * 10 },
      appDb,
    );
    // Everything fits under the cap, so nothing is truncated.
    expect(res.truncated).toBe(false);
  });

  test("RLS: a tenant's export never leaks another tenant's rows", async () => {
    const res = await exportExecutionLogs(
      ctx(tenantB),
      { format: "json", source: "all" },
      appDb,
    );
    const items = JSON.parse(res.content) as ExecutionLogItem[];
    expect(items.every((i) => i.turnId === "b1")).toBe(true);
  });
});
