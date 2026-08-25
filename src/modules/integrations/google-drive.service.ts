import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ensureFreshGoogleAccessToken } from "@/modules/vault/google-oauth";
import { tryResolveVaultEntry } from "@/modules/vault/service";

// Lists the folders a connected google_oauth credential can see, so the Drive integration modal lets
// the operator SEARCH and PICK a folder to scope file search to (instead of pasting an opaque folder
// id). Mirrors google-calendar.service.ts: read-only against Google, the bearer resolved by reference
// from the vault (never the secret to the client), tenant-scoped via RLS. Capped at 200 folders
// (ordered by name); the modal keeps a manual "by id" fallback for shared/Team-drive folders beyond it.

const GDRIVE_FOLDER_LIST_URL = `https://www.googleapis.com/drive/v3/files?${new URLSearchParams(
  {
    q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: "files(id,name)",
    orderBy: "name",
    pageSize: "200",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  },
).toString()}`;
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 200_000;

export interface DriveFolderListItem {
  id: string;
  name: string;
}

// Pure projection of the Google Drive files.list response → the slim shape the UI consumes. Drops
// entries without a string id and a non-empty name. Exported for hermetic tests.
export function mapDriveFolderListResponse(
  json: unknown,
): DriveFolderListItem[] {
  const files =
    json &&
    typeof json === "object" &&
    Array.isArray((json as { files?: unknown }).files)
      ? ((json as { files: unknown[] }).files as unknown[])
      : [];
  const out: DriveFolderListItem[] = [];
  for (const raw of files) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    if (typeof f.id !== "string") continue;
    if (typeof f.name !== "string" || !f.name.trim()) continue;
    out.push({ id: f.id, name: f.name });
  }
  return out;
}

export interface DriveFolderListDeps {
  // Resolves the credential entry (default: tenant-scoped vault read). Returns { kind } | null.
  resolveEntry?: (ref: string) => Promise<{ kind: string } | null>;
  // Returns a fresh google_oauth access token for the entry id (default: ensureFreshGoogleAccessToken).
  resolveToken?: (entryId: bigint) => Promise<string>;
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<unknown>;
}

// Resolves and lists the folders for a credential ref. Throws when the ref is missing, not this
// tenant's (RLS → null), not a google_oauth entry, or malformed. The deps make it hermetically testable.
export async function listCredentialDriveFolders(
  ctx: TenantContext,
  credentialRef: string,
  base: PrismaClient = basePrisma,
  deps: DriveFolderListDeps = {},
): Promise<DriveFolderListItem[]> {
  const resolveEntry =
    deps.resolveEntry ??
    ((ref: string) =>
      runScopedOn(base, ctx, (db) => tryResolveVaultEntry<unknown>(db, ref)));
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
  const entryId = credentialRef.startsWith("vault:")
    ? BigInt(credentialRef.slice("vault:".length))
    : null;
  if (entryId === null) {
    throw new AppError(
      "Invalid credential reference.",
      400,
      "errors.invalidCredentialRef",
    );
  }
  const token = deps.resolveToken
    ? await deps.resolveToken(entryId)
    : await ensureFreshGoogleAccessToken(ctx, entryId, base);

  const assertSafe = deps.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(GDRIVE_FOLDER_LIST_URL);
  const doFetch = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let status: number;
  let json: unknown = null;
  try {
    const res = await doFetch(GDRIVE_FOLDER_LIST_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "agents",
      },
      redirect: "error",
      signal: ctrl.signal,
    });
    status = res.status;
    const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON → handled below
    }
  } finally {
    clearTimeout(timer);
  }
  if (status < 200 || status >= 300) {
    // 403 here is almost always an insufficient OAuth scope: the connected account lacks Drive read
    // access. (The subtler symptom is a 200 with an EMPTY list under the drive.file scope, which the
    // app file only sees its own files — the modal hints at that case on a zero-length result.)
    if (status === 403) {
      throw new AppError(
        "Google Drive denied the request. Reconnect the credential granting the 'Drive (read-only)' or 'Drive (full access)' scope (the 'Drive (app files)' scope cannot list existing folders).",
        502,
        "errors.googleDriveScopeDenied",
      );
    }
    throw new AppError(
      `Google Drive returned HTTP ${status}.`,
      502,
      "errors.integrationHttpError",
      { provider: "Google Drive", status },
    );
  }
  return mapDriveFolderListResponse(json);
}
