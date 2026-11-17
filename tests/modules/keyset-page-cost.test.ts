import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { listConversations } from "@/modules/conversations/service";
import { listDecidedApprovals } from "@/modules/documents/approval";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// A page after a cursor costs the page, not the rest of the list. Both lists order on a nullable
// timestamp (nulls last) and the id, and every page past the first is read from a cursor, so what the
// database sends for that read is the cost of the request. Rows are counted at the driver, under the
// app's role, on a list long enough that "the rest of it" and "one page" cannot be confused.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;

let rowsPerStatement: number[] = [];
class CountingClient extends pg.Client {
  // biome-ignore lint/suspicious/noExplicitAny: the driver's overloads are not worth restating here
  override query(...args: any[]): any {
    // biome-ignore lint/suspicious/noExplicitAny: same
    const r: any = (super.query as any)(...args);
    if (r && typeof r.then === "function")
      return r.then((v: { rows?: unknown[] }) => {
        rowsPerStatement.push(v?.rows?.length ?? 0);
        return v;
      });
    return r;
  }
}

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
      adapter: new PrismaPg(
        new pg.Pool({ connectionString: appUrl, Client: CountingClient }),
      ),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

// Long enough that reading past the cursor without a limit is a thousand rows, not a handful.
const N = 1200;
let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// The list's own order, read from the table: recency descending with nulls last, id descending.
async function expectedConversationOrder(status?: string): Promise<string[]> {
  const rows = await suDb.$queryRawUnsafe<{ id: bigint }[]>(
    `SELECT id FROM conversations WHERE tenant_id = $1 AND NOT sweep_only
       ${status ? "AND status = $2" : ""}
     ORDER BY last_event_at DESC NULLS LAST, id DESC`,
    tenantId,
    ...(status ? [status] : []),
  );
  return rows.map((r) => String(r.id));
}

async function expectedApprovalOrder(): Promise<string[]> {
  const rows = await suDb.$queryRawUnsafe<{ id: bigint }[]>(
    `SELECT id FROM document_approval_requests WHERE tenant_id = $1 AND status <> 'PENDING'
     ORDER BY decided_at DESC NULLS LAST, id DESC`,
    tenantId,
  );
  return rows.map((r) => String(r.id));
}

describe.skipIf(!dbUp)("keyset pages read one page", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "KeysetCost", slug: `keyset-cost-${process.pid}` },
      })
    ).id;
    const inst = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 17601,
        baseUrl: "https://cw.example",
        adminToken: "enc",
      })
    ).id;
    const t = String(tenantId);
    // Ties in threes on the timestamp, and every seventh row without one, so a page boundary lands
    // inside a tie, at the edge of the null block and inside it.
    await suDb.$executeRawUnsafe(
      `INSERT INTO conversations (tenant_id, chatwoot_instance_id, chatwoot_conversation_id, status,
                                  thread_id, last_event_at, updated_at)
       SELECT ${t}, ${inst}, g, (ARRAY['open','pending','resolved'])[1 + g % 3], '${t}:${inst}:' || g,
              CASE WHEN g % 7 = 0 THEN NULL
                   ELSE timestamp '2026-11-01' - ((g / 3) || ' seconds')::interval END,
              now()
         FROM generate_series(1, ${N}) g`,
    );
    await suDb.$executeRawUnsafe(
      `INSERT INTO document_approval_requests (tenant_id, title, idempotency_key, status, expires_at,
                                               decided_at, updated_at)
       SELECT ${t}, 'doc ' || g, 'keyset-' || ${t} || '-' || g,
              CASE WHEN g % 11 = 0 THEN 'PENDING' ELSE 'APPROVED' END,
              timestamp '2027-01-01',
              CASE WHEN g % 5 = 0 THEN NULL
                   ELSE timestamp '2026-11-01' - ((g / 4) || ' seconds')::interval END,
              now()
         FROM generate_series(1, ${N}) g`,
    );
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM document_approval_requests WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM conversations WHERE tenant_id = ${tenantId}`,
    );
    await suDb.chatwootInstance.deleteMany({ where: { tenantId } });
    await suDb.chatwootDeployment.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
  });

  test("a conversations page after a cursor reads at most the page from the database", async () => {
    const first = await listConversations(ctx(), { limit: 10 }, appDb);
    expect(first.nextCursor).not.toBeNull();
    rowsPerStatement = [];
    const second = await listConversations(
      ctx(),
      { limit: 10, cursor: BigInt(first.nextCursor as string) },
      appDb,
    );
    expect(second.items).toHaveLength(10);
    expect(rowsPerStatement.length).toBeGreaterThan(0);
    expect(Math.max(...rowsPerStatement)).toBeLessThanOrEqual(10);
  });

  test("paging the whole conversations list returns every row once, in the list's order", async () => {
    for (const status of [undefined, "open"]) {
      const want = await expectedConversationOrder(status);
      const got: string[] = [];
      let cursor: bigint | undefined;
      for (let i = 0; i < N; i++) {
        const page = await listConversations(
          ctx(),
          { limit: 7, cursor, status },
          appDb,
        );
        got.push(...page.items.map((c) => c.id));
        if (!page.nextCursor) break;
        cursor = BigInt(page.nextCursor);
      }
      expect(got).toEqual(want);
    }
  });

  test("a cursor that is not a row of the list ends it", async () => {
    const all = await expectedConversationOrder();
    const open = new Set(await expectedConversationOrder("open"));
    const notOpen = all.find((id, i) => i > 300 && !open.has(id)) as string;
    for (const cursor of [BigInt(notOpen), 9_000_000_000n]) {
      const page = await listConversations(
        ctx(),
        { limit: 5, cursor, status: "open" },
        appDb,
      );
      expect(page).toEqual({ items: [], nextCursor: null });
    }
  });

  test("a decided-approvals page after a cursor reads at most the page from the database", async () => {
    const first = await listDecidedApprovals(ctx(), appDb, { limit: 10 });
    const last = first[first.length - 1];
    expect(last).toBeDefined();
    rowsPerStatement = [];
    const second = await listDecidedApprovals(ctx(), appDb, {
      limit: 10,
      cursor: BigInt((last as { id: string }).id),
    });
    expect(second).toHaveLength(10);
    expect(Math.max(...rowsPerStatement)).toBeLessThanOrEqual(10);
  });

  test("paging the whole decided-approvals list returns every row once, in its order", async () => {
    const want = await expectedApprovalOrder();
    const got: string[] = [];
    let cursor: bigint | undefined;
    for (let i = 0; i < N; i++) {
      const page = await listDecidedApprovals(ctx(), appDb, {
        limit: 9,
        cursor,
      });
      got.push(...page.map((r) => r.id));
      if (page.length < 9) break;
      cursor = BigInt((page[page.length - 1] as { id: string }).id);
    }
    expect(got).toEqual(want);
  });

  test("a cursor that is not a decided request ends that list", async () => {
    const pending = await suDb.documentApprovalRequest.findFirst({
      where: { tenantId, status: "PENDING" },
      select: { id: true },
    });
    for (const cursor of [pending?.id as bigint, 9_000_000_000n]) {
      expect(
        await listDecidedApprovals(ctx(), appDb, { limit: 5, cursor }),
      ).toEqual([]);
    }
  });
});

// At the route's cap, on a list long enough that the rest of it is a thousand pages, a page after a
// cursor costs the process what the first page costs. Process time is compared against the first page
// of the same list in the same run, so the bound holds on any machine: reading the rest of the list
// costs several times the first page, and reading one page costs about the same.
const LONG = 100_000;
const CAP = 100;
let longTenant = 0n;
const longCtx = (): TenantContext => ({
  tenantId: longTenant,
  userId: null,
  role: "TENANT_ADMIN",
});

async function processMs(read: () => Promise<unknown>): Promise<number> {
  const before = process.cpuUsage();
  await read();
  const spent = process.cpuUsage(before);
  return (spent.user + spent.system) / 1000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

describe.skipIf(!dbUp)("a page at the cap on a long list", () => {
  beforeAll(async () => {
    longTenant = (
      await suDb.tenant.create({
        data: { name: "KeysetLong", slug: `keyset-long-${process.pid}` },
      })
    ).id;
    const inst = (
      await seedChatwootInstance(suDb, {
        tenantId: longTenant,
        accountId: 17602,
        baseUrl: "https://cw.example",
        adminToken: "enc",
      })
    ).id;
    const t = String(longTenant);
    await suDb.$executeRawUnsafe(
      `INSERT INTO conversations (tenant_id, chatwoot_instance_id, chatwoot_conversation_id, status,
                                  thread_id, last_event_at, updated_at)
       SELECT ${t}, ${inst}, g, 'open', '${t}:${inst}:' || g,
              timestamp '2026-11-01' - (g || ' seconds')::interval, now()
         FROM generate_series(1, ${LONG}) g`,
    );
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM conversations WHERE tenant_id = ${longTenant}`,
    );
    await suDb.chatwootInstance.deleteMany({ where: { tenantId: longTenant } });
    await suDb.chatwootDeployment.deleteMany({
      where: { tenantId: longTenant },
    });
    await suDb.tenant.delete({ where: { id: longTenant } });
  });

  test("a page after a cursor costs the process about what the first page costs", async () => {
    const first = await listConversations(longCtx(), { limit: CAP }, appDb);
    expect(first.items).toHaveLength(CAP);
    const cursor = BigInt(first.nextCursor as string);
    const firstMs: number[] = [];
    const afterMs: number[] = [];
    const afterRows: number[] = [];
    for (let i = 0; i < 7; i++) {
      firstMs.push(
        await processMs(() =>
          listConversations(longCtx(), { limit: CAP }, appDb),
        ),
      );
      rowsPerStatement = [];
      afterMs.push(
        await processMs(() =>
          listConversations(longCtx(), { limit: CAP, cursor }, appDb),
        ),
      );
      afterRows.push(Math.max(...rowsPerStatement));
    }
    expect(median(afterMs)).toBeLessThan(3 * median(firstMs));
    expect(Math.max(...afterRows)).toBeLessThanOrEqual(CAP);
  });
});
