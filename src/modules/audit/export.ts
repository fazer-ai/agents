import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import type { AuditScope } from "@/lib/audit/scope";
import { assertUsableCount, badQueryParam } from "@/lib/query-param";
import type { TenantContext } from "@/lib/tenancy";
import {
  type AuditFilterOpts,
  auditTrailFor,
  buildAuditWhere,
  readInScope,
} from "./service";

// Bulk export of the audit trail (#521) -- the shared core the console's Export button and the REST
// endpoint project over, the same shape `flowlog/export.ts` gave the Logs page.
//
// It reuses `buildAuditWhere`, which is the whole point: an export is quoted to a customer, an
// auditor or an incident review, so rows that do not match what the operator was looking at are worse
// than no export at all. Sharing the predicate makes that structural instead of a promise -- and the
// scope comes with it, refused to the same callers and read under the same role as the list, because
// a dump that ignored it would either answer for the wrong trail or repeat the omission #520 closed.

export const AUDIT_EXPORT_FORMAT = "csv" as const;

// TWO CEILINGS, WHICHEVER COMES FIRST, and the second one is why this does not just copy
// `MAX_LOG_EXPORT_ROWS`. A log row is small (249 bytes on average, 2,614 at its measured peak) so a
// row count bounds the file well enough. An audit row is not bounded the same way: `truncForAudit`
// clips each STRING at 4,000 and nothing clips the object, and `agent.prompt_set` writes a prompt on
// each side -- a worst-case row serializes to 8,120 bytes of CSV (measured), which at 10,000 rows is a
// 77 MB download. Rows alone would therefore be a cap that is either useless for the fat trail or
// needlessly tight for the ordinary one, where a row measures 161 bytes and a whole month fits.
export const AUDIT_EXPORT_MAX_ROWS = 10_000;
export const AUDIT_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

// HOW MANY ROWS PER TRIP, and this is the one number a fixed value gets wrong in both directions.
//
// The budget has to bound what is FETCHED and not only what is written, and a row has no structural
// ceiling to bound it with: `truncForAudit` clips each STRING at 4,000 and clips neither the number
// of fields nor the depth, so `agent.settings` -- an open-ended bag -- is as wide as the tenant made
// it. Measured on this projection, a fixed batch of 500 materializes 8 MB at two fields per row,
// 191 MB at fifty and 765 MB at two hundred, all of it read only to be discarded by a ceiling of
// 8 MB. A batch small enough to be safe there would then walk an ordinary trail (161 bytes a row) in
// a thousand round trips.
//
// So the trip is sized instead of chosen: the FIRST one is small, because nothing is known yet, and
// each one after it is sized by the budget still unspent divided by the WIDEST row seen so far --
// the widest and not the average, so one fat row shrinks the next trip immediately instead of being
// averaged away by the thin ones around it. Doubling caps how fast it may grow, which is what keeps
// the estimate honest: reaching a wide trip costs several trips that already fit inside the budget.
//
// THE WIDEST ROW OF THE LAST TRIP, and not of the walk. A running maximum never comes back down, so
// one 400 KB `agent.settings` write in a trail of 161-byte logins would pin every later trip to what
// that row cost -- about 19 rows against the default budget, turning a 10,000-row export into five
// hundred sequential transactions. Forgetting it after one trip is safe here because the doubling
// cap, not the estimate, is what bounds the recovery: a trip may only ever ask for twice the last
// one, so an estimate that turns optimistic buys a single doubling and not a jump to the cap.
// (Measured as a mutation: halving the remembered maximum each trip instead of dropping it produces
// the identical sequence of trips, because whenever the two disagree the doubling cap is already the
// smaller bound. The half-life was dead code.)
//
// What this does NOT promise: a trail whose first rows are thin and whose next ones are enormous can
// still overshoot one trip, because no row count can bound bytes that are not known until they are
// read. Bounding it exactly would mean asking the database for the sizes first, in SQL, which means
// spelling the predicate a second time -- and a predicate that can drift from the list's is the one
// failure this module exists to make structurally impossible.
const BATCH_PROBE = 8;
const BATCH_MAX = 500;

// The ceilings a call actually runs under. Split out as a function because it is the one part of the
// bounding that CANNOT be observed from a result: a caller asking for more than the module allows is
// answered by the module's number, and telling that apart from the caller's own would take a trail
// longer than the ceiling itself. So it is asserted here, in both directions, rather than through an
// export nobody can seed.
export function clampAuditExportCeilings(opts: {
  maxRows?: number;
  maxBytes?: number;
}): { maxRows: number; maxBytes: number } {
  return {
    maxRows: Math.min(
      opts.maxRows ?? AUDIT_EXPORT_MAX_ROWS,
      AUDIT_EXPORT_MAX_ROWS,
    ),
    maxBytes: Math.min(
      opts.maxBytes ?? AUDIT_EXPORT_MAX_BYTES,
      AUDIT_EXPORT_MAX_BYTES,
    ),
  };
}

export interface ExportAuditOpts extends AuditFilterOpts {
  scope?: AuditScope;
  maxRows?: number;
  maxBytes?: number;
}

export interface ExportAuditResult {
  format: typeof AUDIT_EXPORT_FORMAT;
  filename: string;
  contentType: string;
  content: string;
  count: number;
  // True when more rows matched than the file holds (it holds the newest `count`). Surfaced to the
  // operator, never silent: a truncated export that does not say so is a wrong answer with a
  // filename.
  truncated: boolean;
  // Which ceiling did the cutting, so the message can say what to narrow. `null` when nothing was cut.
  truncatedBy: "rows" | "bytes" | null;
}

// FLAT COLUMNS FOR THE SCALARS, ONE JSON CELL EACH FOR THE REST. The vocabulary spans 93 actions with
// a different field set per action, so a projection flattened per field would either explode the
// header or drop what did not fit; one cell keeps the value intact for anything that parses and keeps
// the sheet readable for anyone who does not.
const COLUMNS = [
  "id",
  "created_at",
  "action",
  "actor_type",
  "actor_id",
  "target",
  "tenant_id",
  "before",
  "after",
] as const;

const SELECT = {
  id: true,
  tenantId: true,
  actorId: true,
  actorType: true,
  action: true,
  target: true,
  before: true,
  after: true,
  createdAt: true,
} as const;

type Row = Prisma.AuditLogGetPayload<{ select: typeof SELECT }>;

// RFC 4180. Quote only when the cell holds a delimiter, a quote or a newline, and double the embedded
// quotes -- which for this table is EVERY row with a projection, since a JSON cell always carries `"`
// (measured: 72 of 72 on a dev trail). So this is the ordinary path here, not the edge case it is in
// a log export, and the tests round-trip a value carrying all three characters through a real parser.
//
// Split in two, because the columns are not one kind: seven of them are text and two of them are
// JSON, and only the JSON pair may be re-parsed by whoever opens the file.
function quote(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The scalar columns, which are text and are written as text.
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return quote(String(value));
}

// The two JSON columns, WHICH ALSO HOLD PRIMITIVES. `before`/`after` are `unknown` on the way in and
// jsonb on the way out, and jsonb holds strings, numbers and booleans as happily as objects. Writing
// those as text is lossy in a way that is invisible: a stored `"abc"` becomes the cell `abc`, `""`
// becomes indistinguishable from SQL NULL, and `42`/`true` collide with the strings spelled the same
// way. So the value is serialized as a JSON literal whatever its shape -- an empty cell then means
// the column held nothing, and only that.
function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return quote(JSON.stringify(value));
}

function toLine(r: Row): string {
  return [
    ...[
      r.id,
      r.createdAt.toISOString(),
      r.action,
      r.actorType,
      r.actorId,
      r.target,
      r.tenantId,
    ].map(cell),
    ...[r.before, r.after].map(jsonCell),
  ].join(",");
}

// Filename-safe ISO instant (colons dropped): agents-audit-2026-05-09T13-45-09.csv.
function timestampSlug(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/:/g, "-");
}

// THE BOUND A SEQUENCE ROW MEANS, and `is_called` is half of it rather than a detail. A sequence
// never called reports `last_value = 1` -- the value it WILL hand out -- and one that has handed out
// exactly one row reports 1 as well; only this flag separates them (measured). Taking 1 in the first
// case puts the bound one id ABOVE an empty trail, so the very first row ever written, landing
// between the read and the first trip, would arrive inside a file that started before it existed.
// Uncalled means the bound sits below the sequence's start.
//
// Split out because it is the one part of the bound a test can reach: the sequence behind a real
// trail has always been called, so the branch that matters is not reproducible through `exportAudit`
// without resetting shared state under every other suite.
export function highWaterFrom(row: {
  last_value: bigint;
  is_called: boolean;
}): bigint {
  return row.is_called ? row.last_value : row.last_value - 1n;
}

export async function exportAudit(
  ctx: TenantContext,
  opts: ExportAuditOpts = {},
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<ExportAuditResult> {
  assertUsableCount(opts.maxRows, "maxRows");
  assertUsableCount(opts.maxBytes, "maxBytes");
  const { maxRows, maxBytes } = clampAuditExportCeilings(opts);
  const scope = opts.scope ?? "tenant";
  const trail = auditTrailFor(ctx, scope);
  const where = buildAuditWhere(opts);

  const header = COLUMNS.join(",");
  const headerBytes = Buffer.byteLength(header, "utf8");
  // NOTE: A CEILING THE FORMAT CANNOT MEET IS REFUSED, not quietly exceeded. Below the header there is no
  // answer to give: the file is already over budget before a single row is weighed, and it would come
  // back with `truncated: false` because nothing was cut -- a result that breaks the promise and
  // reports having kept it. Same 400 the rest of the range checks raise.
  if (maxBytes < headerBytes) badQueryParam("maxBytes");
  const lines: string[] = [];
  // NOTE: BYTES AND NOT `.length`, which counts UTF-16 code units. The budget exists to bound a DOWNLOAD,
  // and the file goes out as UTF-8: a trail written in Portuguese measures 1.18x its code-unit count
  // (measured on an ordinary projection), and one carrying emoji or CJK measures up to 3x -- so a
  // budget spent in code units is a budget silently overrun by everyone whose data is not ASCII.
  // `Buffer.byteLength` costs ~104ns on a 4,000-character line, which against a per-row database read
  // is nothing.
  let bytes = Buffer.byteLength(header, "utf8");
  let truncatedBy: "rows" | "bytes" | null = null;
  // NOTE: newest first, walked by the same keyset the page uses, so "the newest `count` win" is the
  // same sentence for both readers. Since #530 that keyset is `(created_at, id)` -- and it has to
  // move here in the same commit, because the promise this module exists to keep is that the file
  // holds the rows the screen holds, in the screen's order. A walk still ordered by `id` would keep
  // returning the same SET for most trails and a different ORDER for any trail whose stamps and ids
  // disagree, which is the quietest way for the two readers to drift apart.
  let cursor: { createdAt: Date; id: bigint } | null = null;
  // NOTE: the widest row of the last trip, which is what sizes the next one (see BATCH_PROBE above).
  let widest = 0;
  let batch = BATCH_PROBE;
  // WHERE THE TRAIL ENDED WHEN THE EXPORT STARTED, held across every trip so the file is ONE
  // snapshot. The walk takes several round trips and rows keep arriving between them; the old
  // id-ordered walk excluded them for free, because a new row carries a higher id than any the
  // descending walk will ever reach again. Ordered by `(created_at, id)` that stops being true:
  // `created_at` comes from the writing process's clock, so a row appended by a replica running
  // behind lands BELOW the cursor and gets picked up by a later trip, while one stamped ahead of it
  // does not -- a file mixing two snapshots, under a filename claiming one. The id is the only
  // monotonic thing here, so it is what bounds the walk.
  //
  // AND IT IS A BOUND, NOT AN MVCC SNAPSHOT, which is a narrower promise and the one this makes. A
  // sequence hands out ids at INSERT time and the row becomes visible at COMMIT, so a transaction
  // that had already taken an id below this bound can commit after the aggregate ran and be read by
  // a later trip. What closed is the wide case -- any write during the whole export -- and what is
  // left is the width of a transaction already open when the walk started. Closing that too would
  // mean holding one REPEATABLE READ transaction across every trip, which is `readInScope`'s shape
  // for the list as well; deliberately not done here (issue #530, review round 5).
  //
  // TAKEN FROM THE SEQUENCE, not from a `max(id)` over anything. A `max` needs an index led by `id`
  // to answer in one row, and after this change no audit index is: over the operator's window it
  // reads the window out (7,947 buffers, 23.0 ms for 30 days, 80 days back), and over the trail
  // alone it degrades on an INACTIVE one -- a tenant whose rows are all old makes the planner walk
  // the primary key backwards past every newer row belonging to somebody else (8,900 buffers,
  // 21.6 ms measured on a trail of 500 old rows inside 500k). The sequence answers in 0.05 ms
  // whatever the trail looks like, needs no index, and is readable by the runtime role.
  //
  // It is a LOOSER bound than `max(id)` -- it counts ids already handed out to transactions that
  // have not committed -- which widens the gap named above rather than opening a new one: those are
  // exactly the writes an id bound cannot separate either way. What it buys is that no export pays
  // for the shape of the trail it is reading.
  const seq = await readInScope(
    base,
    ctx,
    scope,
    (db) =>
      db.$queryRaw<
        { last_value: bigint; is_called: boolean }[]
      >`SELECT last_value, is_called FROM audit_logs_id_seq`,
  );
  const row = seq[0];
  if (row === undefined) {
    throw new Error("audit export: the id sequence returned no row");
  }
  const highWater = highWaterFrom(row);
  while (truncatedBy === null) {
    const want = Math.min(batch, maxRows - lines.length);
    // NOTE: one extra row per trip answers "is there more?" without a second count over a growing table.
    const rows: Row[] = await readInScope(base, ctx, scope, (db) =>
      db.auditLog.findMany({
        where: {
          ...trail,
          ...where,
          id: { lte: highWater },
          ...(cursor !== null
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: want + 1,
        select: SELECT,
      }),
    );
    const more = rows.length > want;
    widest = 0;
    for (const r of rows.slice(0, want)) {
      const line = toLine(r);
      // NOTE: +2 for the CRLF this line will be joined with. Checked BEFORE appending, so the file never
      // exceeds the budget it reports having respected -- and a row is kept whole or not at all,
      // which is also why nothing here cuts a string and no character can be split in half.
      const size = Buffer.byteLength(line, "utf8") + 2;
      if (bytes + size > maxBytes) {
        truncatedBy = "bytes";
        break;
      }
      lines.push(line);
      bytes += size;
      if (size > widest) widest = size;
    }
    if (truncatedBy) break;
    batch = Math.min(
      BATCH_MAX,
      batch * 2,
      Math.max(1, Math.floor((maxBytes - bytes) / Math.max(widest, 1))),
    );
    if (lines.length >= maxRows) {
      if (more) truncatedBy = "rows";
      break;
    }
    if (!more) break;
    const last = rows[want - 1];
    if (!last) break;
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  return {
    format: AUDIT_EXPORT_FORMAT,
    filename: `agents-audit-${timestampSlug(now)}.csv`,
    contentType: "text/csv;charset=utf-8",
    content: [header, ...lines].join("\r\n"),
    count: lines.length,
    truncated: truncatedBy !== null,
    truncatedBy,
  };
}
