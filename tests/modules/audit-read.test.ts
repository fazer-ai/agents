import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  encodeAuditCursor,
  listAudit,
  parseAuditCursor,
  recordAudit,
} from "@/modules/audit/service";
import { syntheticAction } from "../utils/audit-action";

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
      action: syntheticAction(action),
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
    // The cursor names the row it stopped on, in both of the columns the page is ordered by.
    expect(parseAuditCursor(page.nextCursor ?? "")).toEqual({
      at: {
        createdAt: new Date(page.entries[1]?.createdAt ?? ""),
        id: BigInt(page.entries[1]?.id ?? "0"),
      },
      // No pre-#530 bound: this walk began under this release.
      beforeId: null,
    });
  });

  // The whole point of a cursor: every row exactly once, over a walk that outlives one page.
  test("walking the cursor to the end yields every row once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: Awaited<ReturnType<typeof listAudit>> = await listAudit(
        ctx(),
        {
          limit: 2,
          ...(cursor ? { cursor: parseAuditCursor(cursor) ?? undefined } : {}),
        },
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

  // A CURSOR THAT IS NEITHER SHAPE IS REFUSED, NOT READ. It still looks like a perfectly good
  // string, and read as the new key it would answer from a different place in the trail while the
  // pager goes on saying "Page 2", which is the one failure a cursor has. Refused, the operator gets
  // an error they can recover from by starting the walk again.
  //
  // A BARE ID IS NOT IN THIS LIST: it is the previous release's own cursor and is read as that
  // release's `id <` bound, which is the one reading of it that answers from the same place. The
  // test above walks it.
  test("a cursor that is not one of ours is refused rather than read", () => {
    for (const raw of [
      "",
      "|",
      "abc|1",
      "2026-02-01T12:00:00.000Z|",
      "2026-02-01T12:00:00.000Z|0",
      "2026-02-01T12:00:00.000Z|-1",
      "2026-02-01T12:00:00.000Z|1x",
      "not-a-date|7",
      // A DATE THAT DOES NOT EXIST, which `new Date` does not refuse -- it rolls it forward, so
      // February 30th becomes March 2nd and the walk continues from an instant nobody asked for,
      // quietly skipping whatever lies between.
      "2026-02-30T00:00:00.000Z|7",
      // Forms this codec never emits. Each one parses, and two of them parse in the SERVER'S OWN
      // ZONE: `Sep 4 2026` and `…T12:00` (no offset) resolved three hours off on the machine that
      // measured this, so one cursor would name different instants on two deployments.
      "2026-09-04|7",
      "Sep 4 2026|7",
      "2026-09-04T12:00|7",
      "2026-09-04T12:00:00.000+00:00|7",
      "2026-09-04T12:00:00.0000Z|7",
      // EXPANDED YEARS, which are canonical JavaScript and outside what the column can hold.
      // `toISOString` emits the `±YYYYYY` form beyond four digits, so these survive the round trip
      // above -- and the negative one is refused by Postgres at bind time, which turns a malformed
      // cursor into a 500 where the endpoint promises a 400 (measured: the positive extreme binds
      // fine, so this is about the spelling and not about probing the server's exact range).
      "-100000-01-01T00:00:00.000Z|1",
      "+275760-09-13T00:00:00.000Z|1",
    ]) {
      expect(parseAuditCursor(raw)).toBeNull();
    }
    // ...and every cursor the codec itself emits survives its own round trip, which is the rule the
    // refusals above are the other side of: canonical or nothing.
    for (const d of [
      new Date("2026-02-01T12:00:00.000Z"),
      new Date(0),
      new Date("1999-12-31T23:59:59.999Z"),
    ]) {
      const at = { createdAt: d, id: 7n };
      expect(parseAuditCursor(encodeAuditCursor(at))).toEqual({
        at,
        beforeId: null,
      });
    }
    // ...and a real one still reads back to the pair it names.
    expect(parseAuditCursor("2026-02-01T12:00:00.000Z|7")).toEqual({
      at: { createdAt: new Date("2026-02-01T12:00:00.000Z"), id: 7n },
      beforeId: null,
    });
  });

  // THE WHOLE SET, SWEPT, and this is what three review rounds of one-more-bad-spelling argue for.
  // The instant a cursor may carry is exactly: a four-digit year that is not `0000`, spelled the way
  // `toISOString` spells it, naming a date that exists. This walks every one of the 10,000
  // four-digit years and asserts the codec agrees with the database about each -- so a spelling
  // nobody thought of is a failing test rather than a later finding.
  test("the codec accepts exactly the instants the column can hold", async () => {
    const refusedByCodec: string[] = [];
    for (let y = 0; y <= 9999; y++) {
      const iso = `${String(y).padStart(4, "0")}-01-01T00:00:00.000Z`;
      if (parseAuditCursor(`${iso}|1`) === null) refusedByCodec.push(iso);
    }
    // Only year zero, and the reason is the calendar rather than a range: Postgres has no year 0.
    expect(refusedByCodec).toEqual(["0000-01-01T00:00:00.000Z"]);

    // ...and the database agrees, asked directly. Sampled at the two ends plus the refused year,
    // because binding ten thousand values is the sweep that produced this list, not a unit test.
    for (const iso of [
      "0000-01-01T00:00:00.000Z",
      "0001-01-01T00:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ]) {
      const bound = await suDb
        .$queryRawUnsafe("SELECT $1::timestamptz AS t", new Date(iso))
        .then(() => true)
        .catch(() => false);
      expect(bound).toBe(parseAuditCursor(`${iso}|1`) !== null);
      if (iso.startsWith("0000")) expect(bound).toBe(false);
    }
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
      // The three stamps are identical, so nothing but the id can place the boundary -- which is
      // exactly why the id stayed in the key when #530 put `created_at` in front of it.
      expect(parseAuditCursor(first.nextCursor ?? "")?.at?.id).toBe(
        BigInt(first.entries[1]?.id ?? "0"),
      );
      const second = await listAudit(
        ctx(),
        {
          limit: 2,
          cursor: parseAuditCursor(first.nextCursor ?? "") ?? undefined,
        },
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
      // AND THE PAGE AGREES WITH IT SINCE #530. Ordered by id this row came first, because it was
      // written last -- so the trail's own first line disagreed with the `latestAt` printed beside
      // it. Ordered by `(created_at, id)` the two answer the same question, which is the one the
      // operator is asking: what happened most recently.
      expect(page.entries[0]?.action).toBe("c.six");
      expect(page.latestAt).toBe("2026-01-06T00:00:00.000Z");
      expect(page.entries[0]?.createdAt).toBe(page.latestAt ?? "");
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId} AND action LIKE 'skew.%'`,
      );
    }
  });

  // A WALK THAT STARTED UNDER THE OLD ORDERING FINISHES UNDER THE NEW ONE, LOSING NOTHING.
  //
  // A cursor from before #530 is a bare id, and the previous release handed it out meaning `id <
  // X` under `ORDER BY id`. Translating it into the `(created_at, id)` of row X -- which is what
  // this PR did until round 9 -- is NOT the same position, because the two orders are not the same
  // order: `created_at` is written by the client, so a row can carry a stamp older than a row with
  // a smaller id. Every unseen row stamped AHEAD of X then sits ahead of the translated tuple and
  // is never returned. Measured on the dev trail, which is written by one process and still holds
  // two such inversions in 75 rows: from id 88 the old walk owed 19 rows and the translated cursor
  // returned 2, skipping all 19.
  //
  // So the id stays an ID BOUND and is carried to the end of the walk. The page is ordered the new
  // way and bounded the old way, which enumerates exactly the set the old walk still owed -- no row
  // skipped, and no row already shown repeated.
  test("a walk resumed from a pre-#530 cursor loses no row and repeats none", async () => {
    try {
      // Stamped so id order and time order DISAGREE, which is the whole case: `inv.old` has the
      // largest id of the three and the oldest stamp, so a cursor translated to its instant would
      // put the other two behind it.
      await seed("inv.newest", "2026-03-03T00:00:00Z");
      await seed("inv.middle", "2026-03-02T00:00:00Z");
      await seed("inv.old", "2026-01-15T12:00:00Z");
      const all = await listAudit(ctx(), { limit: 500 }, appDb);
      const boundary = all.entries.find(
        (e) => e.action === syntheticAction("inv.old"),
      );
      const bound = BigInt(boundary?.id ?? "0");

      // What the previous release still owed this caller: every row with a smaller id, which is
      // what `id < bound` under `ORDER BY id DESC` would have returned.
      const owed = new Set(
        all.entries.filter((e) => BigInt(e.id) < bound).map((e) => e.id),
      );
      expect(owed.size).toBeGreaterThan(0);

      const seen: string[] = [];
      let cursor: string | null = String(bound);
      for (let i = 0; i < 20 && cursor; i++) {
        const page: Awaited<ReturnType<typeof listAudit>> = await listAudit(
          ctx(),
          { limit: 2, cursor: parseAuditCursor(cursor) ?? undefined },
          appDb,
        );
        seen.push(...page.entries.map((e) => e.id));
        cursor = page.nextCursor;
      }
      // Every row exactly once, and exactly the rows that were owed.
      expect(new Set(seen)).toEqual(owed);
      expect(seen.length).toBe(owed.size);
      // ...and the two rows stamped AFTER the boundary row are in there, which is the half the
      // translated cursor dropped.
      expect(seen).toContain(
        all.entries.find((e) => e.action === syntheticAction("inv.newest"))
          ?.id ?? "",
      );
      expect(seen).toContain(
        all.entries.find((e) => e.action === syntheticAction("inv.middle"))
          ?.id ?? "",
      );
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId} AND action LIKE 'inv.%'`,
      );
    }
  });

  // The bound has to SURVIVE the walk, not just its first page: dropped after page one, the pages
  // that follow are keyed on the tuple alone and start handing back rows the caller already saw.
  test("the pre-#530 bound rides along in every cursor the walk emits", () => {
    const c = parseAuditCursor("2026-02-01T12:00:00.000Z|7|99");
    expect(c).toEqual({
      at: { createdAt: new Date("2026-02-01T12:00:00.000Z"), id: 7n },
      beforeId: 99n,
    });
    expect(
      encodeAuditCursor(
        { createdAt: new Date("2026-02-01T12:00:00.000Z"), id: 7n },
        99n,
      ),
    ).toBe("2026-02-01T12:00:00.000Z|7|99");
    // A bare id is a bound and NOT a position: there is no page behind it yet.
    expect(parseAuditCursor("115")).toEqual({ at: null, beforeId: 115n });
    // ...and the same bounded parse every id gets, so a 40-digit string is still not a cursor.
    expect(parseAuditCursor("9".repeat(40))).toBeNull();
    expect(parseAuditCursor("0")).toBeNull();
    expect(parseAuditCursor("2026-02-01T12:00:00.000Z|7|0")).toBeNull();
    expect(parseAuditCursor("2026-02-01T12:00:00.000Z|7|8|9")).toBeNull();
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
