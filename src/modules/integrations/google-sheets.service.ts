import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { fetchBounded } from "@/lib/outbound";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ensureFreshGoogleAccessToken } from "@/modules/vault/google-oauth";
import { readVaultRefId, tryResolveVaultEntry } from "@/modules/vault/service";
import { readHeader, SPREADSHEET_ID_PATTERN } from "./toolpacks/google-sheets";

// The two lists the Sheets integration editor picks from: the account's spreadsheets (through Drive,
// which needs a Drive read scope; without one the operator pastes the URL instead) and one
// spreadsheet's tabs with the columns of each header row (through Sheets). Read-only against Google,
// the bearer resolved by reference from the vault, tenant-scoped via RLS, like the Drive folder list.

const DRIVE_SPREADSHEET_LIST_URL = `https://www.googleapis.com/drive/v3/files?${new URLSearchParams(
  {
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: "files(id,name)",
    orderBy: "modifiedTime desc",
    pageSize: "200",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  },
).toString()}`;
const SHEETS_ORIGIN = "https://sheets.googleapis.com/v4/spreadsheets";
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 400_000;
// Tabs whose header is read in the one batchGet; a spreadsheet with more lists the rest without
// columns.
const MAX_TABS_WITH_HEADER = 50;

export interface SpreadsheetListItem {
  id: string;
  name: string;
}

export interface SpreadsheetTab {
  sheetId: number;
  title: string;
  // Null when the header was not read (past MAX_TABS_WITH_HEADER), which is not "no header row".
  columns: string[] | null;
}

export interface SheetsListDeps {
  resolveEntry?: (ref: string) => Promise<{ kind: string } | null>;
  resolveToken?: (entryId: bigint) => Promise<string>;
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<unknown>;
}

async function credentialToken(
  ctx: TenantContext,
  credentialRef: string,
  base: PrismaClient,
  deps: SheetsListDeps,
): Promise<string> {
  const resolveEntry =
    deps.resolveEntry ??
    ((ref: string) =>
      runScopedOn(base, ctx, (db) => tryResolveVaultEntry(db, ref)));
  const entry = await resolveEntry(credentialRef);
  if (!entry)
    throw new NotFoundError(
      "Credential not found.",
      "errors.googleCredentialNotFound",
    );
  if (entry.kind !== "google_oauth") {
    throw new AppError(
      "Credential is not a connected Google account.",
      400,
      "errors.googleCredentialNotConnected",
    );
  }
  const entryId = readVaultRefId(credentialRef);
  if (entryId === null) {
    throw new AppError(
      "Invalid credential reference.",
      400,
      "errors.invalidCredentialRef",
    );
  }
  return deps.resolveToken
    ? await deps.resolveToken(entryId)
    : await ensureFreshGoogleAccessToken(ctx, entryId, base);
}

async function getJson(
  url: string,
  token: string,
  deps: SheetsListDeps,
): Promise<{ status: number; json: unknown }> {
  await (deps.assertSafe ?? assertSafeOutboundUrl)(url);
  const { res, body } = await fetchBounded(
    url,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "agents" },
      redirect: "error",
    },
    {
      timeoutMs: TIMEOUT_MS,
      cap: MAX_RESPONSE_CHARS,
      fetchImpl: deps.fetchImpl ?? fetch,
    },
  );
  let json: unknown = null;
  try {
    json = JSON.parse(body.text);
  } catch {
    // NOTE: non-JSON (or a capped body) is handled by the caller through the status and a null.
  }
  return { status: res.status, json };
}

export function mapSpreadsheetListResponse(
  json: unknown,
): SpreadsheetListItem[] {
  const files = (json as { files?: unknown } | null)?.files;
  const out: SpreadsheetListItem[] = [];
  for (const raw of Array.isArray(files) ? files : []) {
    const f = (raw ?? {}) as Record<string, unknown>;
    if (typeof f.id !== "string" || typeof f.name !== "string") continue;
    if (!f.name.trim()) continue;
    out.push({ id: f.id, name: f.name });
  }
  return out;
}

export async function listCredentialSpreadsheets(
  ctx: TenantContext,
  credentialRef: string,
  base: PrismaClient = basePrisma,
  deps: SheetsListDeps = {},
): Promise<SpreadsheetListItem[]> {
  const token = await credentialToken(ctx, credentialRef, base, deps);
  const { status, json } = await getJson(
    DRIVE_SPREADSHEET_LIST_URL,
    token,
    deps,
  );
  if (status === 403) {
    throw new AppError(
      "Google Drive denied the spreadsheet list. Reconnect the credential with the 'Drive (read-only)' scope, or paste the spreadsheet's URL instead.",
      502,
      "errors.googleSheetsListScopeDenied",
    );
  }
  if (status < 200 || status >= 300) {
    throw new AppError(
      `Google Drive returned HTTP ${status}.`,
      502,
      "errors.integrationHttpError",
      { provider: "Google Drive", status },
    );
  }
  return mapSpreadsheetListResponse(json);
}

export async function listSpreadsheetTabs(
  ctx: TenantContext,
  credentialRef: string,
  spreadsheetId: string,
  base: PrismaClient = basePrisma,
  deps: SheetsListDeps = {},
): Promise<{ title: string; tabs: SpreadsheetTab[] }> {
  const id = spreadsheetId.trim();
  if (!SPREADSHEET_ID_PATTERN.test(id)) {
    throw new AppError(
      "That is not a spreadsheet id.",
      400,
      "errors.googleSpreadsheetIdInvalid",
    );
  }
  const token = await credentialToken(ctx, credentialRef, base, deps);
  const root = `${SHEETS_ORIGIN}/${encodeURIComponent(id)}`;
  const meta = await getJson(
    `${root}?${new URLSearchParams({ fields: "properties.title,sheets.properties(sheetId,title)" })}`,
    token,
    deps,
  );
  if (meta.status === 403 || meta.status === 401) {
    throw new AppError(
      "Google Sheets denied the request. Reconnect the credential granting the 'Google Sheets' scope, with an account that can open this spreadsheet.",
      502,
      "errors.googleSheetsScopeDenied",
    );
  }
  if (meta.status === 404) {
    throw new NotFoundError(
      "Spreadsheet not found.",
      "errors.googleSpreadsheetNotFound",
    );
  }
  if (meta.status < 200 || meta.status >= 300) {
    throw new AppError(
      `Google Sheets returned HTTP ${meta.status}.`,
      502,
      "errors.integrationHttpError",
      { provider: "Google Sheets", status: meta.status },
    );
  }
  const m = (meta.json ?? {}) as {
    properties?: { title?: unknown };
    sheets?: unknown;
  };
  const tabs: SpreadsheetTab[] = [];
  for (const s of Array.isArray(m.sheets) ? m.sheets : []) {
    const p = (s as { properties?: Record<string, unknown> })?.properties;
    if (typeof p?.sheetId !== "number" || typeof p.title !== "string") continue;
    tabs.push({ sheetId: p.sheetId, title: p.title, columns: null });
  }
  const withHeader = tabs.slice(0, MAX_TABS_WITH_HEADER);
  if (withHeader.length) {
    const params = new URLSearchParams({ majorDimension: "ROWS" });
    for (const t of withHeader)
      params.append("ranges", `'${t.title.replace(/'/g, "''")}'!1:1`);
    const heads = await getJson(
      `${root}/values:batchGet?${params}`,
      token,
      deps,
    );
    const ranges = (heads.json as { valueRanges?: unknown } | null)
      ?.valueRanges;
    // A failed header read is an error, not a spreadsheet whose tabs all lack a header row.
    if (heads.status < 200 || heads.status >= 300 || !Array.isArray(ranges)) {
      throw new AppError(
        `Google Sheets returned HTTP ${heads.status} reading the header rows.`,
        502,
        "errors.integrationHttpError",
        { provider: "Google Sheets", status: heads.status },
      );
    }
    withHeader.forEach((t, i) => {
      const values = (ranges[i] as { values?: unknown } | undefined)?.values;
      const row = Array.isArray(values) ? values[0] : undefined;
      t.columns = readHeader(Array.isArray(row) ? row : []).names;
    });
  }
  return {
    title: typeof m.properties?.title === "string" ? m.properties.title : "",
    tabs,
  };
}
