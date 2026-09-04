import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import type { AuditScope } from "@/lib/audit/scope";
import { assertUsableCount } from "@/lib/query-param";
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

// How many rows to pull per round trip. The byte budget has to bound what is FETCHED and not only
// what is written: reading `AUDIT_EXPORT_MAX_ROWS` up front to then throw most of it away would
// materialize those same 77 MB in the server before deciding to cut. Sized so an ordinary trail
// (161 bytes a row) finishes in a couple of trips and a fat one stops after the first.
const BATCH = 500;

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
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toLine(r: Row): string {
  return [
    r.id,
    r.createdAt.toISOString(),
    r.action,
    r.actorType,
    r.actorId,
    r.target,
    r.tenantId,
    r.before,
    r.after,
  ]
    .map(cell)
    .join(",");
}

// Filename-safe ISO instant (colons dropped): agents-audit-2026-05-09T13-45-09.csv.
function timestampSlug(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/:/g, "-");
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
  const lines: string[] = [];
  // BYTES AND NOT `.length`, which counts UTF-16 code units. The budget exists to bound a DOWNLOAD,
  // and the file goes out as UTF-8: a trail written in Portuguese measures 1.18x its code-unit count
  // (measured on an ordinary projection), and one carrying emoji or CJK measures up to 3x -- so a
  // budget spent in code units is a budget silently overrun by everyone whose data is not ASCII.
  // `Buffer.byteLength` costs ~104ns on a 4,000-character line, which against a per-row database read
  // is nothing.
  let bytes = Buffer.byteLength(header, "utf8");
  let truncatedBy: "rows" | "bytes" | null = null;
  // Newest first, walked by the same keyset the page uses, so "the newest `count` win" is the same
  // sentence for both readers.
  let cursor: bigint | null = null;

  while (truncatedBy === null) {
    const want = Math.min(BATCH, maxRows - lines.length);
    // One extra row per trip answers "is there more?" without a second count over a growing table.
    const rows: Row[] = await readInScope(base, ctx, scope, (db) =>
      db.auditLog.findMany({
        where: {
          ...trail,
          ...where,
          ...(cursor !== null ? { id: { lt: cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: want + 1,
        select: SELECT,
      }),
    );
    const more = rows.length > want;
    for (const r of rows.slice(0, want)) {
      const line = toLine(r);
      // +2 for the CRLF this line will be joined with. Checked BEFORE appending, so the file never
      // exceeds the budget it reports having respected -- and a row is kept whole or not at all,
      // which is also why nothing here cuts a string and no character can be split in half.
      const size = Buffer.byteLength(line, "utf8") + 2;
      if (bytes + size > maxBytes) {
        truncatedBy = "bytes";
        break;
      }
      lines.push(line);
      bytes += size;
    }
    if (truncatedBy) break;
    if (lines.length >= maxRows) {
      if (more) truncatedBy = "rows";
      break;
    }
    if (!more) break;
    cursor = rows[want - 1]?.id ?? null;
    if (cursor === null) break;
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
