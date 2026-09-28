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

// Bulk export of the audit trail, the shared core the console's Export button and the REST endpoint
// project over. It reuses `buildAuditWhere` and the list's scope rules: an export is quoted to
// auditors, so rows that do not match what the operator was looking at are worse than no export.

export const AUDIT_EXPORT_FORMAT = "csv" as const;

// Two ceilings, whichever comes first. A row count alone bounds a log export, but not an audit one:
// `truncForAudit` clips each string, not the object, and `agent.prompt_set` carries a prompt on each
// side, so a worst-case row is ~8 KB of CSV. Rows alone would be useless for the fat trail or
// needlessly tight for the ordinary one.
export const AUDIT_EXPORT_MAX_ROWS = 10_000;
export const AUDIT_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

// Rows per trip, sized rather than fixed: an audit row has no structural ceiling (`truncForAudit`
// clips strings, not field count or depth), so a fixed batch either materializes hundreds of MB to
// discard or walks an ordinary trail in a thousand trips. The first trip is small; each next one is
// the unspent budget over the widest row of the LAST trip (a running max would pin every later trip
// to one fat row), capped at doubling the previous trip, which is what bounds recovery. A thin-then-
// enormous trail can still overshoot one trip; bounding it exactly would spell the predicate a second
// time in SQL, and a predicate that can drift from the list's is what this module exists to prevent.
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
// quotes -- which for this table is EVERY row with a projection, since a JSON cell always carries `"`.
// So this is the ordinary path here, not the edge case it is in a log export, and the tests
// round-trip a value carrying all three characters through a real parser.
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

// The bound a sequence row means. An uncalled sequence reports `last_value = 1` (the value it WILL
// hand out), same as one that handed out exactly one id; only `is_called` separates them, and taking
// 1 when uncalled would admit a first-ever row written mid-export. Split out because a real trail's
// sequence has always been called, so this branch is unreachable through `exportAudit` in tests.
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
  // NOTE: a ceiling below the header is refused (400), not quietly exceeded: the file would be over
  // budget before any row and still report `truncated: false`.
  if (maxBytes < headerBytes) badQueryParam("maxBytes");
  const lines: string[] = [];
  // NOTE: bytes, not `.length` (UTF-16 code units): the budget bounds a UTF-8 download, and non-ASCII
  // text runs up to 3x its code-unit count.
  let bytes = Buffer.byteLength(header, "utf8");
  let truncatedBy: "rows" | "bytes" | null = null;
  // NOTE: newest first, walked by the same `(created_at, id)` keyset the page uses, so the file holds
  // the rows the screen holds in the screen's order; an `id`-ordered walk would drift from it.
  let cursor: { createdAt: Date; id: bigint } | null = null;
  // NOTE: the widest row of the last trip, which is what sizes the next one (see BATCH_PROBE above).
  let widest = 0;
  let batch = BATCH_PROBE;
  // NOTE: where the trail ended when the export started, so the file is one snapshot. `created_at`
  // comes from the writer's clock, so a lagging replica's row can land below the cursor; the id is the
  // only monotonic thing. It is a bound, not an MVCC snapshot: a transaction already open with a lower
  // id can still commit into a later trip (closing that means one REPEATABLE READ across every trip,
  // deliberately not done). Read from the sequence, not `max(id)`: no audit index is led by `id`, so a
  // `max` degrades on an inactive trail, and the sequence answers in constant time for the runtime role.
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
