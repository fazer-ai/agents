import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import logger from "@/api/lib/logger";
import { failableTool, ToolFailure, toolFailure } from "@/graph/tools/failure";
import { fetchBounded } from "@/lib/outbound";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { clipText } from "@/lib/text";
import {
  type IntegrationSelection,
  registerToolpack,
  type Toolpack,
  type ToolpackCtx,
  type ToolSpec,
} from "./types";

// Google Sheets OUTBOUND toolpack: append a row, find rows, update a found row, all on ONE tab the
// operator picked. The spreadsheet id and the tab's numeric `sheetId` are bound to the INSTANCE
// CONFIG, never a tool arg, and the tab is resolved to its title on every call, so a renamed tab keeps
// working and no argument can reach another tab. Columns are addressed by the header in row 1, never
// by position. Writes go as RAW, so a customer's text that starts with `=` is stored as text and never
// evaluated as a formula. The vault OAuth bearer (`google_oauth`, refreshed by prepare.ts) goes only
// into the Authorization header; fixed origin, SSRF-asserted, no redirects, bounded time and read.

const SHEETS_ORIGIN = "https://sheets.googleapis.com/v4/spreadsheets";
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 1_000_000;
// Data rows a find scans. One more is requested than is used, which is how a longer tab is told
// apart from one that ends exactly here.
const MAX_SCAN_ROWS = 2_000;
const DEFAULT_FIND_LIMIT = 10;
const MAX_FIND_LIMIT = 50;
// What one find hands the model, in characters of JSON; past it the page is cut short and
// `nextOffset` continues where it stopped.
const MAX_FIND_OUTPUT_CHARS = 30_000;
const MAX_CELL_CHARS = 1_000;

// A spreadsheet id is the segment between `/d/` and `/edit` in its URL. Anything else (a URL, a path)
// is refused before it is put into one.
export const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

export function readSheetsConfig(config: Record<string, unknown>): {
  spreadsheetId: string | null;
  sheetId: number | null;
} {
  const id =
    typeof config.spreadsheetId === "string" ? config.spreadsheetId.trim() : "";
  const sheetId = config.sheetId;
  return {
    spreadsheetId: SPREADSHEET_ID_PATTERN.test(id) ? id : null,
    sheetId:
      typeof sheetId === "number" && Number.isInteger(sheetId) && sheetId >= 0
        ? sheetId
        : null,
  };
}

const NOT_CONNECTED =
  "Google Sheets is not connected for this integration. Connect a Google account (Sheets scope) in the integration's credential.";
const NO_SPREADSHEET =
  "No spreadsheet is configured for this integration. The operator picks it in the integration's settings.";
const NO_TAB =
  "No tab is configured for this integration. The operator picks the tab in the integration's settings.";

interface SheetsResponse {
  status: number;
  json: unknown;
  truncated: boolean;
}

async function sheetsFetch(
  url: string,
  init: { method: string; token: string; body?: unknown },
  ctx: ToolpackCtx,
): Promise<SheetsResponse> {
  const assertSafe = ctx.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(url);
  const { res, body } = await fetchBounded(
    url,
    {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        "Content-Type": "application/json",
        "User-Agent": "agents",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "error",
    },
    {
      timeoutMs: TIMEOUT_MS,
      cap: MAX_RESPONSE_CHARS,
      fetchImpl: ctx.fetchImpl ?? fetch,
    },
  );
  const truncated = body.chars > body.text.length;
  let json: unknown = null;
  if (!truncated) {
    try {
      json = JSON.parse(body.text);
    } catch {
      // NOTE: a non-JSON body stays null; the caller reports the status.
    }
  }
  return { status: res.status, json, truncated };
}

// A1 notation quotes a tab title in single quotes, doubling any quote inside it.
function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function rawCell(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function cellText(v: unknown): string {
  const s = rawCell(v);
  return s.length > MAX_CELL_CHARS ? `${clipText(s, MAX_CELL_CHARS)}…` : s;
}

// Header names compare trimmed and case-insensitively; an empty header cell names no column.
function headerKey(name: string): string {
  return name.trim().toLocaleLowerCase("pt-BR");
}

export interface Header {
  names: string[];
  // The positions of the first and last named header cells: the table Google appends to.
  first: number;
  last: number;
  index: Map<string, number>;
  duplicated: Set<string>;
}

export function readHeader(row: unknown[] | undefined): Header {
  const names: string[] = [];
  const index = new Map<string, number>();
  const duplicated = new Set<string>();
  let first = -1;
  let last = -1;
  (row ?? []).forEach((cell, i) => {
    const name = rawCell(cell).trim();
    if (!name) return;
    if (first < 0) first = i;
    last = i;
    const key = headerKey(name);
    if (index.has(key)) duplicated.add(key);
    else index.set(key, i);
    names.push(name);
  });
  return { names, index, duplicated, first, last };
}

// The header position of a column the model named, or the sentence that tells it why not.
function locateColumn(header: Header, column: string): number | string {
  const key = headerKey(column);
  if (header.duplicated.has(key))
    return `The column "${column}" appears more than once in the header row, so it is ambiguous. Ask the operator to rename one of them.`;
  const i = header.index.get(key);
  if (i === undefined)
    return `There is no column "${column}" in this tab. The columns are: ${header.names.join(", ")}.`;
  return i;
}

type Located = { token: string; base: string; range: string };

// Resolves token, config and the tab's CURRENT title. A string is the reply to give the model.
async function locateTab(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): Promise<Located | ToolFailure> {
  const token = sel.credentialRef
    ? await ctx.resolveCredential(sel.credentialRef)
    : null;
  if (!token) return toolFailure(NOT_CONNECTED);
  const { spreadsheetId, sheetId } = readSheetsConfig(sel.config);
  if (!spreadsheetId) return toolFailure(NO_SPREADSHEET);
  if (sheetId === null) return toolFailure(NO_TAB);
  const base = `${SHEETS_ORIGIN}/${encodeURIComponent(spreadsheetId)}`;
  const meta = await sheetsFetch(
    `${base}?${new URLSearchParams({ fields: "sheets.properties(sheetId,title)" })}`,
    { method: "GET", token },
    ctx,
  );
  if (meta.status < 200 || meta.status >= 300)
    return toolFailure(httpMessage(meta.status));
  const sheets = (meta.json as { sheets?: unknown } | null)?.sheets;
  const tab = (Array.isArray(sheets) ? sheets : [])
    .map((s) => (s as { properties?: Record<string, unknown> })?.properties)
    .find((p) => p?.sheetId === sheetId);
  if (!tab || typeof tab.title !== "string")
    return toolFailure(
      "The tab configured for this integration no longer exists in the spreadsheet. The operator has to pick the tab again in the integration's settings.",
    );
  return { token, base, range: quoteTitle(tab.title) };
}

function httpMessage(status: number): string {
  if (status === 401 || status === 403)
    return `Google Sheets refused access (HTTP ${status}). The connected Google account needs the Sheets scope and access to this spreadsheet.`;
  if (status === 404)
    return "Google Sheets did not find the configured spreadsheet (HTTP 404).";
  return `Google Sheets returned HTTP ${status}.`;
}

// Reads rows 1..last of the tab: the header and up to `dataRows` data rows (one extra to tell a
// longer tab apart).
async function readRows(
  loc: Located,
  dataRows: number,
  ctx: ToolpackCtx,
): Promise<{ rows: unknown[][] } | ToolFailure> {
  const params = new URLSearchParams({
    majorDimension: "ROWS",
    valueRenderOption: "FORMATTED_VALUE",
  });
  const res = await sheetsFetch(
    `${loc.base}/values/${encodeURIComponent(`${loc.range}!1:${dataRows + 1}`)}?${params}`,
    { method: "GET", token: loc.token },
    ctx,
  );
  if (res.truncated)
    return toolFailure(
      "The tab is too large to read in one request. Ask the operator to move old rows to another tab.",
    );
  if (res.status < 200 || res.status >= 300)
    return toolFailure(httpMessage(res.status));
  const values = (res.json as { values?: unknown } | null)?.values;
  return {
    rows: (Array.isArray(values) ? values : []).map((r) =>
      Array.isArray(r) ? r : [],
    ),
  };
}

const NO_HEADER =
  "This tab has no header row. Row 1 must name the columns before the agent can use it.";

const CELL_VALUE = z
  .string()
  .max(MAX_CELL_CHARS)
  .describe("The value, written as text exactly as given.");

const VALUES = z
  .array(
    z.object({
      column: z
        .string()
        .min(1)
        .describe("A column name from the tab's header row."),
      value: CELL_VALUE,
    }),
  )
  .min(1)
  .max(50);

const APPEND_SCHEMA = z.object({
  values: VALUES.describe(
    "The new row, as column/value pairs. Columns not listed are left blank.",
  ),
});

const FIND_SCHEMA = z.object({
  column: z
    .string()
    .optional()
    .describe(
      "Column to filter by (a header name). Omit, with value, to list every row.",
    ),
  value: z
    .string()
    .optional()
    .describe("Value to look for in that column. Case-insensitive."),
  match: z
    .enum(["equals", "contains"])
    .optional()
    .describe("equals (default): the whole cell; contains: part of the cell."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Max rows to return (default ${DEFAULT_FIND_LIMIT}, max ${MAX_FIND_LIMIT}).`,
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Matches to skip, to continue from a previous call's nextOffset.",
    ),
});

const UPDATE_SCHEMA = z.object({
  column: z
    .string()
    .min(1)
    .describe("Column that identifies the row (a header name)."),
  value: z
    .string()
    .min(1)
    .describe(
      "Value that identifies the row in that column. Case-insensitive.",
    ),
  row: z
    .number()
    .int()
    .min(2)
    .optional()
    .describe(
      "Row number from sheets_find_rows, to pick one when the value matches several rows.",
    ),
  values: VALUES.describe("The cells to change, as column/value pairs."),
});

const SHEETS_TOOL_SPECS: ToolSpec[] = [
  { name: "sheets_append_row", schema: APPEND_SCHEMA },
  { name: "sheets_find_rows", schema: FIND_SCHEMA },
  { name: "sheets_update_row", schema: UPDATE_SCHEMA },
];

function norm(s: string): string {
  return s.trim().toLocaleLowerCase("pt-BR");
}

function rowMatches(
  row: unknown[],
  col: number,
  value: string,
  match: "equals" | "contains",
): boolean {
  const cell = norm(rawCell(row[col]));
  const want = norm(value);
  return match === "contains" ? cell.includes(want) : cell === want;
}

function asObject(header: Header, row: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of header.names) {
    const i = header.index.get(headerKey(name));
    if (i === undefined || header.duplicated.has(headerKey(name))) continue;
    out[name] = cellText(row[i]);
  }
  return out;
}

// Maps the model's column/value pairs onto header positions, or the sentence refusing them.
function placeValues(
  header: Header,
  values: Array<{ column: string; value: string }>,
): Map<number, string> | string {
  const placed = new Map<number, string>();
  for (const { column, value } of values) {
    const at = locateColumn(header, column);
    if (typeof at === "string") return at;
    placed.set(at, value);
  }
  return placed;
}

function unreachable(err: unknown, what: string): ToolFailure {
  logger.warn({ err }, `sheets: ${what} request failed`);
  return toolFailure("Failed to reach Google Sheets. Try again shortly.");
}

function buildAppendTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: { values: Array<{ column: string; value: string }> }) => {
      try {
        const loc = await locateTab(sel, ctx);
        if (loc instanceof ToolFailure) return loc;
        const read = await readRows(loc, 0, ctx);
        if (read instanceof ToolFailure) return read;
        const header = readHeader(read.rows[0]);
        if (header.names.length === 0) return NO_HEADER;
        const placed = placeValues(header, input.values);
        if (typeof placed === "string") return placed;
        // `values:append` starts the new row at the first column of the table it finds, so the
        // range is the header's own span and the row is laid out from its first column, not from A.
        const span = `${columnLetter(header.first)}1:${columnLetter(header.last)}1`;
        const row = Array.from(
          { length: header.last - header.first + 1 },
          (_, i) => placed.get(header.first + i) ?? "",
        );
        const params = new URLSearchParams({
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
        });
        const res = await sheetsFetch(
          `${loc.base}/values/${encodeURIComponent(`${loc.range}!${span}`)}:append?${params}`,
          { method: "POST", token: loc.token, body: { values: [row] } },
          ctx,
        );
        if (res.status < 200 || res.status >= 300)
          return toolFailure(httpMessage(res.status));
        const updated = (res.json as { updates?: { updatedRange?: unknown } })
          ?.updates?.updatedRange;
        const m =
          typeof updated === "string"
            ? /!\$?([A-Z]+)\$?(\d+)/.exec(updated)
            : null;
        const at = m?.[2];
        if (m && m[1] !== columnLetter(header.first))
          return toolFailure(
            `The row was added at ${m[1]}${at}, but the table's first column is ${columnLetter(header.first)}, so its values may sit under the wrong columns. Ask the operator to check row ${at}.`,
          );
        return at
          ? `Added the row to the spreadsheet (row ${at}).`
          : "Added the row to the spreadsheet.";
      } catch (err) {
        return unreachable(err, "append");
      }
    },
    {
      name: "sheets_append_row",
      description:
        "Add a new row at the end of the configured spreadsheet tab. Give each value with the name of its column (as written in the tab's header row); columns you do not list stay blank.",
      schema: APPEND_SCHEMA,
    },
  );
}

function buildFindTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: {
      column?: string;
      value?: string;
      match?: "equals" | "contains";
      limit?: number;
      offset?: number;
    }) => {
      const filtering = input.column !== undefined || input.value !== undefined;
      if (filtering && (!input.column?.trim() || input.value === undefined))
        return "To filter, give both column and value; omit both to list every row.";
      try {
        const loc = await locateTab(sel, ctx);
        if (loc instanceof ToolFailure) return loc;
        const read = await readRows(loc, MAX_SCAN_ROWS + 1, ctx);
        if (read instanceof ToolFailure) return read;
        const header = readHeader(read.rows[0]);
        if (header.names.length === 0) return NO_HEADER;
        let col = -1;
        if (filtering) {
          const at = locateColumn(header, input.column as string);
          if (typeof at === "string") return at;
          col = at;
        }
        const data = read.rows.slice(1);
        const incomplete = data.length > MAX_SCAN_ROWS;
        const scanned = data.slice(0, MAX_SCAN_ROWS);
        const matches: Array<{ row: number; values: Record<string, string> }> =
          [];
        scanned.forEach((r, i) => {
          if (r.every((c) => rawCell(c).trim() === "")) return;
          if (
            filtering &&
            !rowMatches(r, col, input.value as string, input.match ?? "equals")
          )
            return;
          matches.push({ row: i + 2, values: asObject(header, r) });
        });
        const limit = Math.min(
          input.limit ?? DEFAULT_FIND_LIMIT,
          MAX_FIND_LIMIT,
        );
        const offset = input.offset ?? 0;
        const page = matches.slice(offset, offset + limit);
        const reply = () => {
          const next = offset + page.length;
          return JSON.stringify({
            columns: header.names,
            matched: matches.length,
            rows: page,
            ...(next < matches.length ? { nextOffset: next } : {}),
            ...(incomplete
              ? {
                  incomplete: true,
                  note: `Only the first ${MAX_SCAN_ROWS} rows of the tab were searched.`,
                }
              : {}),
          });
        };
        let out = reply();
        while (page.length > 1 && out.length > MAX_FIND_OUTPUT_CHARS) {
          page.pop();
          out = reply();
        }
        if (out.length > MAX_FIND_OUTPUT_CHARS)
          return "The matching row is too wide to return in full. Filter by a more specific value, or ask the operator to move long text out of this tab.";
        return out;
      } catch (err) {
        return unreachable(err, "find");
      }
    },
    {
      name: "sheets_find_rows",
      description:
        "Read rows from the configured spreadsheet tab. Filter by a column and a value to find specific rows, or omit both to list the table. Each row comes with its row number and its values by column name.",
      schema: FIND_SCHEMA,
    },
  );
}

function buildUpdateTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: {
      column: string;
      value: string;
      row?: number;
      values: Array<{ column: string; value: string }>;
    }) => {
      try {
        const loc = await locateTab(sel, ctx);
        if (loc instanceof ToolFailure) return loc;
        const read = await readRows(loc, MAX_SCAN_ROWS + 1, ctx);
        if (read instanceof ToolFailure) return read;
        const header = readHeader(read.rows[0]);
        if (header.names.length === 0) return NO_HEADER;
        const key = locateColumn(header, input.column);
        if (typeof key === "string") return key;
        const placed = placeValues(header, input.values);
        if (typeof placed === "string") return placed;
        const incomplete = read.rows.length - 1 > MAX_SCAN_ROWS;
        const data = read.rows.slice(1, MAX_SCAN_ROWS + 1);
        const hits: number[] = [];
        data.forEach((r, i) => {
          if (rowMatches(r, key, input.value, "equals")) hits.push(i + 2);
        });
        if (hits.length === 0)
          return incomplete
            ? `No row among the first ${MAX_SCAN_ROWS} of the tab has "${input.value}" in the column "${input.column}", and the rows after them are not searched. Nothing was changed.`
            : `No row has "${input.value}" in the column "${input.column}". Nothing was changed.`;
        if (incomplete && input.row === undefined)
          return `The tab has more than ${MAX_SCAN_ROWS} rows and only the first ${MAX_SCAN_ROWS} are searched, so a match there may not be the only one. Rows found: ${hits.join(", ")}. Call again with the row number of the one to change. Nothing was changed.`;
        let target: number;
        if (input.row !== undefined) {
          if (!hits.includes(input.row))
            return `Row ${input.row} does not have "${input.value}" in the column "${input.column}" (the rows that do: ${hits.join(", ")}). Nothing was changed.`;
          target = input.row;
        } else if (hits.length > 1) {
          return `Several rows have "${input.value}" in the column "${input.column}": rows ${hits.join(", ")}. Call again with the row number of the one to change. Nothing was changed.`;
        } else {
          target = hits[0] as number;
        }
        const res = await sheetsFetch(
          `${loc.base}/values:batchUpdate`,
          {
            method: "POST",
            token: loc.token,
            body: {
              valueInputOption: "RAW",
              data: [...placed].map(([i, v]) => ({
                range: `${loc.range}!${columnLetter(i)}${target}`,
                values: [[v]],
              })),
            },
          },
          ctx,
        );
        if (res.status < 200 || res.status >= 300)
          return toolFailure(httpMessage(res.status));
        return `Updated row ${target} of the spreadsheet.`;
      } catch (err) {
        return unreachable(err, "update");
      }
    },
    {
      name: "sheets_update_row",
      description:
        "Change cells of an existing row in the configured spreadsheet tab. The row is the one whose given column has the given value; when several rows match, pass the row number from sheets_find_rows. Only the columns you list are changed.",
      schema: UPDATE_SCHEMA,
    },
  );
}

const TOOL_BUILDERS: Record<
  string,
  (sel: IntegrationSelection, ctx: ToolpackCtx) => StructuredToolInterface
> = {
  sheets_append_row: buildAppendTool,
  sheets_find_rows: buildFindTool,
  sheets_update_row: buildUpdateTool,
};

export const googleSheetsToolpack: Toolpack = {
  catalogType: "GOOGLE_SHEETS",
  toolSpecs: SHEETS_TOOL_SPECS,
  build(sel, ctx) {
    const out: StructuredToolInterface[] = [];
    for (const name of sel.enabledTools) {
      const builder = TOOL_BUILDERS[name];
      if (builder) out.push(builder(sel, ctx));
    }
    return out;
  },
};

registerToolpack(googleSheetsToolpack);
