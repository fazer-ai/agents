import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { listAudit, recordAudit } from "@/modules/audit/service";

// THE READ HALF (issue #401). The trail is append-only and the console page is the only door most
// operators have to it, so what the read surface can ANSWER is what the trail is worth to them.
//
// Before this, `listAudit` took a limit (capped at 500) and an action, and nothing else: no way to
// reach row 501, and no way to arrive the way an operator actually arrives, with a date and no idea
// which action to look for. The issue calls the endpoint "keyset by id"; it was ordered by id and
// paged by nothing, which is the same shape a caller cannot tell apart until the trail outgrows one
// page.
//
// The seeding here is `recordAudit` itself rather than a family service: this file is about the
// read, and a family's own rows are measured by its own file.

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
const USER = 9401n;
const OTHER_USER = 9402n;

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

// Stamps a row at a chosen instant. `created_at` defaults to now(), and a date filter cannot be
// tested against rows that all landed in the same millisecond.
async function seed(
  action: string,
  at: string,
  over: { actorType?: string; actorId?: bigint | null; target?: string } = {},
) {
  await runScopedOn(appDb, ctx(), (db) =>
    recordAudit(db, tenantId, {
      action,
      target: over.target ?? `t:${action}`,
      actorId: over.actorId === undefined ? USER : over.actorId,
      actorType: (over.actorType ?? "user") as "user",
      after: { a: 1 },
    }),
  );
  await suDb.$executeRawUnsafe(
    `UPDATE audit_logs SET created_at = '${at}'::timestamptz
      WHERE tenant_id = ${tenantId} AND id = (
        SELECT max(id) FROM audit_logs WHERE tenant_id = ${tenantId})`,
  );
}

describe.skipIf(!dbUp)("reading the trail", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "AUD401", slug: `aud401-${process.pid}` },
    });
    tenantId = t.id;
    // Six rows, oldest first, so id order and time order agree and a boundary can be named.
    await seed("a.one", "2026-01-01T00:00:00Z");
    await seed("a.two", "2026-01-02T00:00:00Z", { actorType: "mcp" });
    await seed("b.three", "2026-01-03T00:00:00Z", { actorId: OTHER_USER });
    await seed("b.four", "2026-01-04T00:00:00Z", {
      actorType: "system",
      actorId: null,
    });
    await seed("b.five", "2026-01-05T00:00:00Z");
    await seed("c.six", "2026-01-06T00:00:00Z", { actorType: "api_key" });
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the newest row comes first, and the page says there is more", async () => {
    const page = await listAudit(ctx(), { limit: 2 }, appDb);
    expect(page.entries.map((e) => e.action)).toEqual(["c.six", "b.five"]);
    expect(page.nextCursor).toBe(page.entries[1]?.id ?? "");
  });

  // The whole point of a cursor: every row exactly once, over a walk that outlives one page.
  test("walking the cursor to the end yields every row once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: Awaited<ReturnType<typeof listAudit>> = await listAudit(
        ctx(),
        { limit: 2, ...(cursor ? { cursor: BigInt(cursor) } : {}) },
        appDb,
      );
      seen.push(...page.entries.map((e) => e.action));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([
      "c.six",
      "b.five",
      "b.four",
      "b.three",
      "a.two",
      "a.one",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(cursor).toBeNull();
  });

  // Two rows the clock cannot tell apart, which is the case a cursor has to survive and the reason
  // it is keyed on the id. `created_at` here is written by the CLIENT and not by the database —
  // three rows appended inside one transaction come back with stamps later than that transaction's
  // own now(), and at millisecond resolution two of them landing on the same value is ordinary
  // (measured). So the column is neither unique nor guaranteed to agree with insertion order, and a
  // page cut on it would repeat one of a tied pair or skip it. Stamped equal here on purpose rather
  // than raced into a tie, so the case is exercised every run instead of on a fast machine.
  test("a page boundary between two rows sharing one timestamp repeats nothing", async () => {
    try {
      await seed("tie.one", "2026-02-01T12:00:00Z");
      await seed("tie.two", "2026-02-01T12:00:00Z");
      await seed("tie.three", "2026-02-01T12:00:00Z");
      const first = await listAudit(ctx(), { limit: 2 }, appDb);
      expect(first.entries.map((e) => e.action)).toEqual([
        "tie.three",
        "tie.two",
      ]);
      expect(new Set(first.entries.map((e) => e.createdAt)).size).toBe(1);
      // The cursor is the ID of the last row shown, and the three stamps are identical, so nothing
      // but the id can place the boundary.
      expect(first.nextCursor).toBe(first.entries[1]?.id ?? "");
      const second = await listAudit(
        ctx(),
        { limit: 2, cursor: BigInt(first.nextCursor ?? "0") },
        appDb,
      );
      expect(second.entries[0]?.action).toBe("tie.one");
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId} AND action LIKE 'tie.%'`,
      );
    }
  });

  test("a date range answers the question an operator arrives with", async () => {
    const page = await listAudit(
      ctx(),
      {
        since: new Date("2026-01-02T00:00:00Z"),
        until: new Date("2026-01-04T00:00:00Z"),
      },
      appDb,
    );
    // Both bounds inclusive, matching the Logs page's own since/until.
    expect(page.entries.map((e) => e.action)).toEqual([
      "b.four",
      "b.three",
      "a.two",
    ]);
  });

  test("filtering by how the actor authenticated, and by which actor", async () => {
    expect(
      (await listAudit(ctx(), { actorType: "mcp" }, appDb)).entries.map(
        (e) => e.action,
      ),
    ).toEqual(["a.two"]);
    expect(
      (await listAudit(ctx(), { actorId: OTHER_USER }, appDb)).entries.map(
        (e) => e.action,
      ),
    ).toEqual(["b.three"]);
    expect(
      (await listAudit(ctx(), { action: "b.five" }, appDb)).entries.map(
        (e) => e.action,
      ),
    ).toEqual(["b.five"]);
  });

  // The detector. Until every family records, comparing this against a record's own updatedAt is
  // the only way an operator learns that a write happened which the trail cannot describe — and it
  // keeps working afterwards, as how a family that was missed shows up. It therefore answers for the
  // WHOLE trail and never for the filter: narrowed to the filter it would report the newest row the
  // operator happens to be looking at, which is a number that can only mislead.
  test("the newest row of the trail is reported past any filter that hides it", async () => {
    const narrowed = await listAudit(
      ctx(),
      { action: "a.one", limit: 1 },
      appDb,
    );
    expect(narrowed.entries.map((e) => e.action)).toEqual(["a.one"]);
    expect(narrowed.latestAt).toBe(
      (await listAudit(ctx(), { limit: 1 }, appDb)).entries[0]?.createdAt ?? "",
    );
    expect(narrowed.latestAt).toBe("2026-01-06T00:00:00.000Z");
  });

  // The greatest TIME, not the time of the greatest id, and the two really do disagree here:
  // `created_at` is written by the client, so a row that commits later can carry an earlier stamp
  // than one already in the table. This number is compared against a record's own `updatedAt`, and a
  // comparison between times answered by "whichever row has the biggest id" reports a covered record
  // as newer than the trail — the exact false alarm the field exists to avoid raising.
  test("the newest row is the newest by TIME, even when the ids disagree", async () => {
    try {
      // Written last, stamped earliest: the highest id is not the latest row.
      await seed("skew.older", "2026-01-04T00:00:00Z");
      const page = await listAudit(ctx(), { limit: 1 }, appDb);
      expect(page.entries[0]?.action).toBe("skew.older");
      expect(page.latestAt).toBe("2026-01-06T00:00:00.000Z");
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId} AND action LIKE 'skew.%'`,
      );
    }
  });

  test("an empty trail reports no newest row rather than a wrong one", async () => {
    const other = await suDb.tenant.create({
      data: { name: "AUD401B", slug: `aud401b-${process.pid}` },
    });
    const page = await listAudit(
      { tenantId: other.id, userId: USER, role: "TENANT_ADMIN" },
      {},
      appDb,
    );
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.latestAt).toBeNull();
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${other.id}`);
  });
});
