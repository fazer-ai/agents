import { z } from "zod";
import { AppError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { LEAD_PLATFORMS } from "@/modules/merchant/leads";

// file_import scanner input: pasted or uploaded exports turned into the raw
// records normalizeScannedPost validates. Three spellings, sniffed by content
// when `format` is "auto": JSONL (one JSON object per line), a JSON array, or
// CSV with a header row naming columns (aliases match posts.ts FIELD_ALIASES).

export type ImportFormat = "auto" | "jsonl" | "csv";

export const fileImportConfigSchema = z
  .object({
    format: z.enum(["auto", "jsonl", "csv"]).optional(),
    // Default platform for rows that do not name one (a CSV of TikTok comments
    // rarely carries a platform column).
    platform: z.enum(LEAD_PLATFORMS).optional(),
    // The pasted export itself. A run can override it per call, so this field
    // is optional on the row and required only when a run has nothing else.
    content: z.string().min(1).max(2_000_000).optional(),
  })
  .strict();
export type FileImportConfig = z.infer<typeof fileImportConfigSchema>;

// One scan of a file_import source: the content the run carried wins, else the
// stored config.content; neither means there is nothing to scan, which is a
// config error the operator fixes (422), not a failed run.
export function scanFileImport(
  source: { name: string; config: unknown },
  run: { content?: string; format?: ImportFormat },
): unknown[] {
  const cfg = parseInput(fileImportConfigSchema, source.config, "config");
  const content = run.content ?? cfg.content;
  if (content === undefined || content.trim() === "") {
    throw new AppError(
      `source "${source.name}" has no content to import - pass it in the run request or store it in config.content`,
      422,
      "errors.merchantSourceContentMissing",
      { name: source.name },
    );
  }
  const records = parseImport(content, run.format ?? cfg.format ?? "auto");
  if (!cfg.platform) return records;
  // Inject the source's default platform where a row did not carry one.
  return records.map((r) =>
    typeof r === "object" && r !== null && !Array.isArray(r)
      ? { platform: cfg.platform, ...(r as Record<string, unknown>) }
      : r,
  );
}

function sniffFormat(content: string): Exclude<ImportFormat, "auto"> {
  const first = content.trimStart()[0];
  // A `{` line is JSONL, `[` a JSON array; anything else reads as CSV.
  return first === "{" || first === "[" ? "jsonl" : "csv";
}

// Minimal RFC-4180 CSV: quoted fields, "" escapes, commas and newlines inside
// quotes. Returns rows of string cells (no coercion - normalize owns that).
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let inQuotes = false;
  let i = 0;
  const pushCell = () => {
    row.push(cell);
    cell = "";
    quoted = false;
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };
  while (i < content.length) {
    const ch = content[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      inQuotes = true;
      quoted = true;
    } else if (ch === ",") {
      pushCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && content[i + 1] === "\n") i++;
      pushRow();
    } else {
      cell += ch;
    }
    i++;
  }
  // Trailing row (file may not end with a newline); quoted tells an empty row
  // apart from a legit empty trailing line only when cells exist.
  if (cell !== "" || quoted || row.length > 0) pushRow();
  return rows;
}

// Header row -> records. Column names are matched case-insensitively and
// raw values left as strings for normalizeScannedPost's alias/coercion pass.
function csvToRecords(rows: string[][]): unknown[] {
  const header = rows[0];
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  const out: unknown[] = [];
  for (const cells of rows.slice(1)) {
    if (cells.every((c) => c.trim() === "")) continue;
    const rec: Record<string, unknown> = {};
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j] as string;
      const v = cells[j];
      if (key !== "" && v !== undefined) rec[key] = v;
    }
    out.push(rec);
  }
  return out;
}

function jsonlToRecords(content: string): unknown[] {
  const trimmed = content.trim();
  // A top-level array is just JSONL spelled differently; normalize gets the
  // same records either way.
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr : [];
    } catch {
      // Fall through to line mode: a malformed array may still be good lines.
    }
  }
  const out: unknown[] = [];
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (s === "") continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // A line that is not JSON still counts: normalize drops it as skipped,
      // so a partly-bad file reports its bad rows instead of dying on them.
      out.push(s);
    }
  }
  return out;
}

export function parseImport(
  content: string,
  format: ImportFormat = "auto",
): unknown[] {
  const fmt = format === "auto" ? sniffFormat(content) : format;
  return fmt === "jsonl"
    ? jsonlToRecords(content)
    : csvToRecords(parseCsv(content));
}
