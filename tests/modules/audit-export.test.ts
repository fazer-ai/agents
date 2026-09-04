import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { ForbiddenError } from "@/lib/errors";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  AUDIT_EXPORT_MAX_BYTES,
  AUDIT_EXPORT_MAX_ROWS,
  clampAuditExportCeilings,
  exportAudit,
} from "@/modules/audit/export";
import { recordAudit } from "@/modules/audit/service";
import { syntheticAction } from "../utils/audit-action";

// TAKING THE TRAIL OUT OF THE BROWSER (issue #521).
//
// The export answers the question the operator is already looking at, so the thing worth testing is
// not that it produces a CSV -- it is that it produces the SAME ROWS the page does. Hence the shared
// `buildAuditWhere`, and hence the assertions here run the list and the export against one filter and
// compare, rather than restating the expected rows by hand: a test that spells out both sides can go
// on passing while the two readers drift apart, which is the only failure this feature really has.
//
// The scope comes with it, and the issue did not ask for that -- it was written before #520. An
// export that ignored the scope would either dump the wrong trail or repeat the omission #520 closed,
// so `fleet`/`all` are refused to the same callers and read under the same role.
//
// THE CAP IS BYTES AND NOT ONLY ROWS, and that is measured rather than chosen. `truncForAudit` bounds
// each STRING at 4000 but nothing bounds the object, and `agent.prompt_set` writes two prompts: a
// worst-case row serializes to 8,120 bytes of CSV, so the Logs module's 10,000-row cap would permit a
// 77 MB download. A month of ordinary rows (161 bytes measured on a dev trail) still comes out whole;
// the month carrying prompts is the one that cuts.

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

const TAG = `x521-${process.pid}`;
const USER = 9522n;
const OTHER = 9523n;

let mine = 0n;

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId: mine,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

async function seed(
  tenantId: bigint | null,
  action: string,
  target: string,
  over: {
    actorId?: bigint;
    actorType?: string;
    at?: string;
    after?: unknown;
  } = {},
) {
  const entry = {
    action: syntheticAction(action),
    target,
    actorId: over.actorId ?? USER,
    actorType: (over.actorType ?? "user") as "user",
    after: (over.after ?? { a: 1 }) as Record<string, unknown>,
  };
  if (tenantId === null) {
    await asSuperAdminOn(appDb, (db) => recordAudit(db, null, entry));
  } else {
    await runScopedOn(appDb, ctx({ tenantId, role: "SUPER_ADMIN" }), (db) =>
      recordAudit(db, tenantId, entry),
    );
  }
  if (over.at) {
    await suDb.$executeRawUnsafe(
      `UPDATE audit_logs SET created_at = '${over.at}'::timestamptz WHERE target = '${target}'`,
    );
  }
}

// Parses an RFC 4180 CSV into rows of cells, honouring quoted cells that hold commas, quotes and
// newlines. Written out rather than split(",") on purpose: EVERY audit row needs quoting (measured:
// 72 of 72 on a dev trail, because a JSON cell always carries `"`), so a naive split would agree with
// a broken writer.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r") continue;
    else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const col = (rows: string[][], name: string) => {
  const i = (rows[0] ?? []).indexOf(name);
  return rows.slice(1).map((r) => r[i] ?? "");
};

describe.skipIf(!dbUp)("exporting the trail", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "X521", slug: `x521-${process.pid}` },
    });
    mine = t.id;
    await seed(mine, "agent.create", `${TAG}:a`, {
      at: "2026-05-01T00:00:00Z",
    });
    await seed(mine, "agent.update", `${TAG}:b`, {
      at: "2026-05-02T00:00:00Z",
      actorType: "mcp",
    });
    await seed(mine, "agent.delete", `${TAG}:c`, {
      at: "2026-05-03T00:00:00Z",
      actorId: OTHER,
    });
    await seed(null, "mcp_client.create", `${TAG}:fleet`, {
      at: "2026-05-04T00:00:00Z",
    });
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE target LIKE '${TAG}:%'`,
    );
    if (mine)
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${mine}`);
    await su?.$disconnect();
    await app?.$disconnect();
  });

  const ours = (rows: string[][]) =>
    col(rows, "target").filter((t) => t.startsWith(TAG));

  test("the header names the scalars, and before/after are one column each", async () => {
    const r = await exportAudit(ctx(), {}, appDb);
    expect(parseCsv(r.content)[0]).toEqual([
      "id",
      "created_at",
      "action",
      "actor_type",
      "actor_id",
      "target",
      "tenant_id",
      "before",
      "after",
    ]);
  });

  // THE ONE ASSERTION THIS FEATURE IS ABOUT. Not "the filter works" -- that the export and the page
  // answer the same question, compared against each other rather than against a hand-written list.
  // A ROW WHOSE ID AND STAMP DISAGREE, seeded for the whole comparison below. Without it the two
  // orders coincide on this trail -- rows are appended stamp-ascending -- so the assertion would
  // hold against an export still walking by `id` alone, which is exactly what it must not do since
  // #530. Measured: dropping this row lets the comparison pass with the two readers ordered
  // differently.
  test("the rows are the rows the page shows, for the same filter", async () => {
    const { listAudit } = await import("@/modules/audit/service");
    await seed(mine, "agent.update", `${TAG}:skew`, {
      at: "2026-04-01T00:00:00Z",
      actorType: "mcp",
      actorId: OTHER,
    });
    for (const filter of [
      {},
      { action: "agent.update" },
      { actorType: "mcp" as const },
      { actorId: OTHER },
      { since: new Date("2026-05-02T00:00:00Z") },
      { until: new Date("2026-05-02T00:00:00Z") },
    ]) {
      const page = await listAudit(ctx(), { ...filter, limit: 500 }, appDb);
      const csv = parseCsv((await exportAudit(ctx(), filter, appDb)).content);
      expect(col(csv, "id")).toEqual(page.entries.map((e) => e.id));
      // ...and the shared order really is the time's, not the id's. The skew row was written last
      // and stamped earliest, so it carries the HIGHEST id and the OLDEST instant: ordered by id it
      // would come first, ordered by time it comes last. Asserted wherever the filter admits it.
      const targets = col(csv, "target");
      const at = targets.indexOf(`${TAG}:skew`);
      if (at >= 0) {
        expect(at).toBe(targets.length - 1);
        const ids = col(csv, "id").map(BigInt);
        expect(ids[at]).toBe(ids.reduce((a, b) => (a > b ? a : b)));
      }
    }
  });

  // A JSON cell always holds `"`, so the quoting path is every row rather than an edge case, and a
  // value carrying the delimiter is what tells a correct writer from one that only looks correct.
  test("a value holding a comma, a quote and a newline survives the round trip", async () => {
    const nasty = { note: 'a,b "quoted" \n second line', n: 1 };
    await seed(mine, "agent.update", `${TAG}:nasty`, { after: nasty });
    try {
      const csv = parseCsv((await exportAudit(ctx(), {}, appDb)).content);
      const i = col(csv, "target").indexOf(`${TAG}:nasty`);
      expect(JSON.parse(col(csv, "after")[i] ?? "")).toEqual(nasty);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target = '${TAG}:nasty'`,
      );
    }
  });

  test("the fleet trail exports its own rows, and the tenant's export never reaches them", async () => {
    const fleet = parseCsv(
      (
        await exportAudit(
          ctx({ role: "SUPER_ADMIN" }),
          { scope: "fleet" },
          appDb,
        )
      ).content,
    );
    expect(ours(fleet)).toEqual([`${TAG}:fleet`]);
    const own = parseCsv((await exportAudit(ctx(), {}, appDb)).content);
    expect(ours(own)).not.toContain(`${TAG}:fleet`);
  });

  for (const scope of ["fleet", "all"] as const) {
    test(`a tenant admin exporting ${scope} is refused, not narrowed`, async () => {
      await expect(exportAudit(ctx(), { scope }, appDb)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  }

  test("the cap is surfaced, and the newest rows are the ones kept", async () => {
    const r = await exportAudit(ctx(), { maxRows: 2 }, appDb);
    const csv = parseCsv(r.content);
    expect(r.truncated).toBe(true);
    expect(r.count).toBe(2);
    const page = await listAudit2(ctx(), appDb);
    expect(col(csv, "id")).toEqual(page.slice(0, 2));
  });

  test("an export that fits reports no truncation", async () => {
    const r = await exportAudit(ctx(), {}, appDb);
    expect(r.truncated).toBe(false);
    expect(r.count).toBe(parseCsv(r.content).length - 1);
  });

  // The cap the issue did not ask for. A row is bounded per STRING and not per object, so rows fat
  // enough to blow a download can still be far under the row cap: the byte budget is what stops it,
  // and it has to stop it by FETCHING less, not by trimming what it already pulled into memory.
  test("a fat trail is cut by bytes long before it reaches the row cap", async () => {
    const fat = { prompt: "x".repeat(4000), other: "y".repeat(4000) };
    const made: string[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        const target = `${TAG}:fat${i}`;
        await seed(mine, "agent.prompt_set", target, { after: fat });
        made.push(target);
      }
      const r = await exportAudit(ctx(), { maxBytes: 20_000 }, appDb);
      expect(r.truncated).toBe(true);
      expect(r.count).toBeLessThan(6);
      expect(r.content.length).toBeLessThanOrEqual(20_000);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}:fat%'`,
      );
    }
  });

  // BOTH DIRECTIONS, and on the function rather than through a result. A caller asking for LESS is
  // visible in an export (the truncation tests above); a caller asking for MORE than the module allows
  // is not, because telling the two apart would need a trail longer than the ceiling itself -- so a
  // test written against `exportAudit` here passes whether or not the clamp exists. Measured: removing
  // the `Math.min` left this whole file green.
  test("a caller may lower the ceilings and may not raise them", () => {
    expect(clampAuditExportCeilings({ maxRows: 5, maxBytes: 100 })).toEqual({
      maxRows: 5,
      maxBytes: 100,
    });
    expect(
      clampAuditExportCeilings({
        maxRows: AUDIT_EXPORT_MAX_ROWS * 10,
        maxBytes: AUDIT_EXPORT_MAX_BYTES * 10,
      }),
    ).toEqual({
      maxRows: AUDIT_EXPORT_MAX_ROWS,
      maxBytes: AUDIT_EXPORT_MAX_BYTES,
    });
    expect(clampAuditExportCeilings({})).toEqual({
      maxRows: AUDIT_EXPORT_MAX_ROWS,
      maxBytes: AUDIT_EXPORT_MAX_BYTES,
    });
  });

  // The numbers themselves, because the ceiling is the feature: a row cap alone would permit a 77 MB
  // download on the fat trail measured in this module's header.
  test("the ceilings are the ones a browser can hold", () => {
    expect(AUDIT_EXPORT_MAX_ROWS).toBeLessThanOrEqual(10_000);
    expect(AUDIT_EXPORT_MAX_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  // THE BUDGET IS IN BYTES, and the two only agree on ASCII. A trail written in Portuguese measures
  // 1.18x its code-unit count and one carrying emoji up to 3x, so a budget spent in `.length` is one
  // that everybody outside ASCII silently overruns -- which is the whole population this product
  // serves. Asserted on the UTF-8 size of the file, never on its character count.
  test("the budget bounds the file's real UTF-8 size, not its character count", async () => {
    const wide = { nota: "coração 😀 ação — três".repeat(60) };
    try {
      for (let i = 0; i < 6; i++) {
        await seed(mine, "agent.update", `${TAG}:wide${i}`, { after: wide });
      }
      const budget = 6000;
      const r = await exportAudit(ctx(), { maxBytes: budget }, appDb);
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.content, "utf8")).toBeLessThanOrEqual(budget);
      // And the cut lands between rows, so the file never ends on half a character.
      expect(r.content).not.toMatch(/[\uD800-\uDBFF]$/);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}:wide%'`,
      );
    }
  });

  // WHAT IS FETCHED, and not only what is written. The byte budget bounds the file, and a fixed row
  // batch bounds nothing: `truncForAudit` clips each STRING at 4,000 and clips neither the number of
  // fields nor the depth, so a row has no structural ceiling at all. Measured on this projection, a
  // batch of 500 materializes 8 MB at two fields per row, 191 MB at fifty, 765 MB at two hundred --
  // all of it read to then be thrown away by a ceiling of 8 MB. So the trip has to be sized by the
  // budget that is left and by the width already observed, and the assertion is on the `take` the
  // database actually received.
  test("a trip is sized by the budget left, so a fat trail is not materialized whole", async () => {
    const fat = {
      um: "x".repeat(3900),
      dois: "y".repeat(3900),
      tres: "z".repeat(3900),
    };
    try {
      for (let i = 0; i < 14; i++) {
        await seed(mine, "agent.update", `${TAG}:fat${i}`, { after: fat });
      }
      // One row's real size on this projection, measured rather than assumed.
      const one = await exportAudit(ctx(), { maxRows: 1 }, appDb);
      const rowBytes = Buffer.byteLength(one.content, "utf8");
      const budget = rowBytes * 5;

      const takes: number[] = [];
      const spy = appDb.$extends({
        query: {
          auditLog: {
            findMany({ args, query }) {
              takes.push(Number(args.take ?? 0));
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;

      const r = await exportAudit(ctx(), { maxBytes: budget }, spy);
      expect(r.truncated).toBe(true);
      expect(takes.length).toBeGreaterThan(0);
      // No single trip may read several times the whole budget it is spending.
      expect(Math.max(...takes) * rowBytes).toBeLessThanOrEqual(budget * 4);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}:fat%'`,
      );
    }
  });

  // The other half of the same rule: sizing the trip by the width observed must not turn an ordinary
  // trail into one round trip per handful of rows. The first trip knows nothing, so it is small; each
  // one after it is allowed to grow.
  test("an ordinary trail widens its trips instead of crawling", async () => {
    try {
      for (let i = 0; i < 24; i++) {
        await seed(mine, "agent.update", `${TAG}:thin${i}`);
      }
      const takes: number[] = [];
      const spy = appDb.$extends({
        query: {
          auditLog: {
            findMany({ args, query }) {
              takes.push(Number(args.take ?? 0));
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;

      await exportAudit(ctx(), {}, spy);
      expect(takes.length).toBeGreaterThan(1);
      expect(takes[1] ?? 0).toBeGreaterThan(takes[0] ?? 0);
      // ...and grows by DOUBLING, not by jumping straight to the cap. The estimate that sizes a trip
      // is only as good as the rows it has already seen, so the ceiling it may reach is bounded by
      // how much has already fit inside the budget. Without this bound the second trip would ask for
      // the whole cap on the strength of eight thin rows.
      expect(takes[1] ?? 0).toBeLessThanOrEqual((takes[0] ?? 0) * 2);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}:thin%'`,
      );
    }
  });

  // THE WIDEST ROW SEEN, NOT THE AVERAGE, and the difference is the whole point of the estimate. An
  // average is dragged down by every thin row around a fat one, so a trail that opens thin and turns
  // fat -- which is the ordinary shape, since one `agent.settings` write sits among a hundred logins
  // -- would keep asking for trips sized as if the fat row had never appeared. The widest row is a
  // fact already measured; the average is a guess about rows not yet read.
  test("one fat row shrinks the next trip, instead of being averaged away", async () => {
    try {
      const fat = {
        um: "x".repeat(3900),
        dois: "y".repeat(3900),
        tres: "z".repeat(3900),
      };
      for (let i = 0; i < 10; i++) {
        await seed(mine, "agent.create", `${TAG}:mixf${i}`, { after: fat });
      }
      const oneFat = await exportAudit(ctx(), { maxRows: 1 }, appDb);
      const head = (oneFat.content.split("\r\n")[0] ?? "") as string;
      const headBytes = Buffer.byteLength(head, "utf8");
      const fatBytes = Buffer.byteLength(oneFat.content, "utf8") - headBytes;

      // Seven thin rows, so the probe trip ends on its eighth row being the first fat one.
      for (let i = 0; i < 7; i++) {
        await seed(mine, "agent.update", `${TAG}:mixt${i}`);
      }
      const oneThin = await exportAudit(ctx(), { maxRows: 1 }, appDb);
      const thinBytes = Buffer.byteLength(oneThin.content, "utf8") - headBytes;

      const spent = headBytes + 7 * thinBytes + fatBytes;
      const fits = 7;
      const takes: number[] = [];
      const spy = appDb.$extends({
        query: {
          auditLog: {
            findMany({ args, query }) {
              takes.push(Number(args.take ?? 0));
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;

      await exportAudit(ctx(), { maxBytes: spent + fits * fatBytes }, spy);
      expect(takes.length).toBeGreaterThan(1);
      // The trip after the fat row asks for what is left divided by THAT row, and no more. Sized by
      // the average instead, it would ask for the doubling cap -- more than twice as many.
      expect((takes[1] ?? 0) - 1).toBeLessThanOrEqual(fits);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}:mix%'`,
      );
    }
  });

  // AND THE ESTIMATE RECOVERS. The widest row is a fact, but it is a fact about rows already behind
  // us, and one 400 KB `agent.settings` write sits in a trail of logins that are 161 bytes each. Kept
  // as a running maximum it would pin every later trip to what that one row cost -- roughly 19 rows
  // against the default budget -- and turn a 10,000-row export into five hundred sequential
  // transactions. So it decays by half per trip while the batch is allowed to double per trip: the
  // two move at the same rate, which keeps the product (what a trip may materialize) near the budget
  // the whole way instead of only at the moment the fat row was read.
  test("a single fat row does not pin every later trip to its size", async () => {
    try {
      const huge: Record<string, string> = {};
      for (let i = 0; i < 100; i++) huge[`c${i}`] = "x".repeat(3900);
      for (let i = 0; i < 55; i++) {
        await seed(mine, "agent.update", `${TAG}:rec${i}`);
      }
      // Newest, so it lands inside the very first trip.
      await seed(mine, "agent.create", `${TAG}:recfat`, { after: huge });

      const takes: number[] = [];
      const spy = appDb.$extends({
        query: {
          auditLog: {
            findMany({ args, query }) {
              takes.push(Number(args.take ?? 0));
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;

      await exportAudit(ctx(), {}, spy);
      expect(takes.length).toBeGreaterThan(2);
      // Two thin trips after the fat row, the batch is governed by the doubling cap again and not by
      // what that row cost -- it is exactly twice the trip before it. Pinned to the running maximum
      // instead, the third trip stays at the ~19 rows the 400 KB row bought and never moves.
      expect((takes[2] ?? 0) - 1).toBe(2 * ((takes[1] ?? 0) - 1));
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}:rec%'`,
      );
    }
  });

  // THE TWO JSON COLUMNS CARRY JSON, INCLUDING WHEN THE JSON IS NOT AN OBJECT. `before`/`after` are
  // `unknown` on the way in and jsonb on the way out, and jsonb holds primitives: a stored `"abc"`
  // comes back as a JS string, and stringifying it as text drops the quotes -- so `"abc"` and `abc`
  // become the same cell, `""` becomes indistinguishable from SQL NULL, and `42`/`true` collide with
  // the strings spelled the same way. The promise this file makes about those two columns is that
  // whatever parses them gets the value back, so they are serialized as JSON literals, always.
  test("a JSON column round-trips a primitive, not just an object", async () => {
    try {
      const cases: [string, unknown][] = [
        ["str", "abc"],
        ["empty", ""],
        ["num", 42],
        ["bool", true],
        ["arr", [1, "dois"]],
      ];
      for (const [name, value] of cases) {
        await seed(mine, "agent.update", `${TAG}:json-${name}`, {
          after: value,
        });
      }
      const r = await exportAudit(ctx(), {}, appDb);
      const rows = parseCsv(r.content);
      const targets = col(rows, "target");
      const afters = col(rows, "after");
      const befores = col(rows, "before");
      for (const [name, value] of cases) {
        const i = targets.indexOf(`${TAG}:json-${name}`);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(JSON.parse(afters[i] as string)).toEqual(value);
        // ...and the column that holds no JSON at all stays empty, so the empty string above is
        // still readable as a value rather than as an absence.
        expect(befores[i]).toBe("");
      }
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}:json-%'`,
      );
    }
  });

  // A TIE THAT CROSSES A TRIP BOUNDARY. The export walks in trips, and the first is deliberately
  // small, so a run of rows sharing one instant is split across two round trips as a matter of
  // course. The keyset carries the id for exactly this: on the time alone, `created_at < t` would
  // drop the rest of the tied run and `<=` would repeat the whole of it. Twelve rows on one stamp,
  // which is more than the probe trip holds.
  test("a run of rows sharing one instant is neither repeated nor dropped", async () => {
    try {
      for (let i = 0; i < 12; i++) {
        await seed(mine, "agent.update", `${TAG}:tie${i}`, {
          at: "2026-06-01T09:00:00Z",
        });
      }
      const r = await exportAudit(ctx(), {}, appDb);
      const targets = parseCsv(r.content)
        .slice(1)
        .map((row) => row[5] ?? "")
        .filter((t) => t.startsWith(`${TAG}:tie`));
      expect(targets).toHaveLength(12);
      expect(new Set(targets).size).toBe(12);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}:tie%'`,
      );
    }
  });

  // A CUT IS ALWAYS ANNOUNCED, including the one that happens between two trips. When a trip ends
  // with the budget spent to the last row and more rows still match, the next trip is sized down to
  // its floor of one row -- which then does not fit, and truncates. Sizing it down to ZERO instead
  // ends the walk with `truncated: false`: a file quietly missing rows while reporting it respected
  // every ceiling, which is the worst answer this module can give.
  test("a budget spent exactly at a trip boundary still reports the cut", async () => {
    try {
      for (let i = 0; i < 14; i++) {
        await seed(mine, "agent.update", `${TAG}:edge${i}`);
      }
      const eight = await exportAudit(ctx(), { maxRows: 8 }, appDb);
      const budget = Buffer.byteLength(eight.content, "utf8");
      const r = await exportAudit(ctx(), { maxBytes: budget }, appDb);
      expect(r.count).toBe(8);
      expect(r.truncated).toBe(true);
      expect(r.truncatedBy).toBe("bytes");
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}:edge%'`,
      );
    }
  });

  // A ceiling the FORMAT cannot respect is a ceiling the caller has to hear about. Below the header
  // there is no answer at all: the file would be over budget before a single row is considered, and
  // `truncated` would still be false because nothing was cut. Refused with the same 400 the rest of
  // the range checks raise, rather than silently answered with a file that breaks the promise.
  test("a byte ceiling the header alone cannot respect is refused", async () => {
    await expect(exportAudit(ctx(), { maxBytes: 10 }, appDb)).rejects.toThrow(
      /maxBytes/,
    );
  });

  test("a ceiling of exactly the header is honoured, and says it cut", async () => {
    const header = (
      await exportAudit(ctx(), { maxRows: 1 }, appDb)
    ).content.split("\r\n")[0] as string;
    const r = await exportAudit(
      ctx(),
      { maxBytes: Buffer.byteLength(header, "utf8") },
      appDb,
    );
    expect(r.content).toBe(header);
    expect(r.count).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("bytes");
  });

  test("the filename carries the instant, and the content type is CSV", async () => {
    const r = await exportAudit(
      ctx(),
      {},
      appDb,
      new Date("2026-05-09T13:45:09Z"),
    );
    expect(r.filename).toBe("agents-audit-2026-05-09T13-45-09.csv");
    expect(r.contentType).toBe("text/csv;charset=utf-8");
  });
});

// The page's own id order, for the truncation assertion.
async function listAudit2(c: TenantContext, db: PrismaClient) {
  const { listAudit } = await import("@/modules/audit/service");
  return (await listAudit(c, { limit: 500 }, db)).entries.map((e) => e.id);
}
