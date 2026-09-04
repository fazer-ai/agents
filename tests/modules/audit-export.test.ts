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
  test("the rows are the rows the page shows, for the same filter", async () => {
    const { listAudit } = await import("@/modules/audit/service");
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
