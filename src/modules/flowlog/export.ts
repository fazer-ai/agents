import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  buildLogWhere,
  type ExecutionLogItem,
  type ListLogsOpts,
  LOG_SELECT,
  mapExecutionLogRow,
} from "./read";

// Bulk export of the execution-flow log — the shared core the Logs-page "Export" button, the REST
// endpoint, and the MCP `logs_export` tool all project over. Reuses the SAME filter surface as
// `listExecutionLogs` (`buildLogWhere`), so an export matches exactly what the operator sees, then
// serializes newest-first up to a hard row cap. RLS-scoped; rows were already PII-scrubbed at write.

export const LOG_EXPORT_FORMATS = ["csv", "json"] as const;
export type LogExportFormat = (typeof LOG_EXPORT_FORMATS)[number];

// Hard ceiling on a single export. Logs are high-write + retention-bounded; a few MB of CSV/JSON is
// fine for a browser blob or an MCP response, an unbounded dump is not. Truncation is surfaced, never
// silent (the newest `count` rows win).
export const MAX_LOG_EXPORT_ROWS = 10000;

const CONTENT_TYPE: Record<LogExportFormat, string> = {
  csv: "text/csv;charset=utf-8",
  json: "application/json",
};

// `limit`/`cursor` are pagination knobs that make no sense for a one-shot dump; `maxRows` (clamped to
// the hard cap) bounds the export instead.
export interface ExportLogsOpts extends Omit<ListLogsOpts, "limit" | "cursor"> {
  format: LogExportFormat;
  maxRows?: number;
}

export interface ExportLogsResult {
  format: LogExportFormat;
  filename: string;
  contentType: string;
  content: string;
  count: number;
  // True when more rows matched than the cap returned (the file holds the newest `count`).
  truncated: boolean;
}

// Column order for the CSV. `detail` is a nested JSON object, so it lands as one JSON-string cell
// (lossless, if not spreadsheet-pretty); JSON export keeps it structured.
const CSV_COLUMNS: (keyof ExecutionLogItem)[] = [
  "id",
  "createdAt",
  "source",
  "turnId",
  "stage",
  "level",
  "status",
  "provider",
  "model",
  "durationMs",
  "conversationId",
  "agentId",
  "inboxId",
  "threadId",
  "errorMessage",
  "detail",
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Quote only when the cell holds a delimiter, quote, or newline; double embedded quotes (RFC 4180).
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function logsToCsv(items: ExecutionLogItem[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = items.map((it) =>
    CSV_COLUMNS.map((c) => csvCell(it[c])).join(","),
  );
  return [header, ...rows].join("\r\n");
}

export function serializeLogItems(
  items: ExecutionLogItem[],
  format: LogExportFormat,
): string {
  return format === "csv" ? logsToCsv(items) : JSON.stringify(items, null, 2);
}

// Filename-safe ISO instant (colons dropped): agents-logs-2026-07-01T13-45-09.csv.
function timestampSlug(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/:/g, "-");
}

export async function exportExecutionLogs(
  ctx: TenantContext,
  opts: ExportLogsOpts,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<ExportLogsResult> {
  assertUsableCount(opts.maxRows, "maxRows");
  const cap = Math.min(
    opts.maxRows ?? MAX_LOG_EXPORT_ROWS,
    MAX_LOG_EXPORT_ROWS,
  );
  const where = buildLogWhere(opts);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.executionLog.findMany({
      where,
      orderBy: { id: "desc" },
      take: cap + 1, // one extra row tells us whether the export was truncated
      select: LOG_SELECT,
    }),
  );
  const truncated = rows.length > cap;
  const page = truncated ? rows.slice(0, cap) : rows;
  const items = page.map(mapExecutionLogRow);
  return {
    format: opts.format,
    filename: `agents-logs-${timestampSlug(now)}.${opts.format}`,
    contentType: CONTENT_TYPE[opts.format],
    content: serializeLogItems(items, opts.format),
    count: items.length,
    truncated,
  };
}
