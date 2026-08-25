import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";
import {
  runSecretTest,
  type SecretTestDeps,
  type SecretTestResult,
} from "./secret-test";
import {
  getSecretTypeFields,
  isManagedOAuthKind,
  isSecretTypeId,
  secretTypeIsManagedBlob,
  secretTypeNeedsParamName,
  secretTypeRequiresBaseUrl,
} from "./secret-types";

// Tenant-scoped secret vault. Secrets are encryptJson() base64 blobs in a String column
// (never Json, never logged). Reads/writes go through a ScopedDb so RLS scopes them to the
// active tenant; entries are referenced by the stable `vault:<id>` ref elsewhere
// (credentialRef, secretRef), and the REST surface manages them by id.

// A stored credential reference is always the stable `vault:<id>` form (the agent export/import
// JSON uses the entry NAME as its portable form, but it is translated to `vault:<id>` on import —
// see agents/transfer.ts). `vaultRefWhere` parses a ref to a Prisma filter; RLS scopes the row to
// the active tenant, so a foreign id reads back null (never cross-tenant). A value that is not a
// well-formed `vault:<id>` yields a never-matching filter (resolves to null).
export const VAULT_REF_PREFIX = "vault:";

export function formatVaultRef(id: bigint | string): string {
  return `${VAULT_REF_PREFIX}${id}`;
}

export function isVaultIdRef(ref: string): boolean {
  return ref.startsWith(VAULT_REF_PREFIX);
}

export function vaultRefWhere(ref: string): { id: bigint } {
  if (ref.startsWith(VAULT_REF_PREFIX)) {
    try {
      return { id: BigInt(ref.slice(VAULT_REF_PREFIX.length)) };
    } catch {
      // malformed → fall through to a never-matching id
    }
  }
  return { id: -1n };
}

// A "pending" entry holds only encryptJson({}) as a placeholder — its secret was never filled. Strict
// resolvers throw this (409) so the caller surfaces a clear "fill the credential" error; the try*
// variants instead return null, reusing the "missing credential" path callers already handle (e.g.
// a deleted ref). NEVER decryptJson a pending entry (the {} blob is not the expected shape).
function pendingCredentialError(ref: string): AppError {
  return new AppError(
    `vault secret "${ref}" has not been filled yet`,
    409,
    "errors.credentialPending",
    { ref },
  );
}

export async function resolveVaultSecret<T = unknown>(
  db: ScopedDb,
  ref: string,
): Promise<T> {
  // RLS scopes to the active tenant, so the lookup is unambiguous within it.
  const entry = await db.vaultEntry.findFirst({
    where: vaultRefWhere(ref),
    select: { secret: true, status: true },
  });
  if (!entry) {
    throw new NotFoundError(`vault secret "${ref}" not found`);
  }
  if (entry.status === "pending") throw pendingCredentialError(ref);
  return decryptJson<T>(entry.secret);
}

export async function tryResolveVaultSecret<T = unknown>(
  db: ScopedDb,
  ref: string,
): Promise<T | null> {
  const entry = await db.vaultEntry.findFirst({
    where: vaultRefWhere(ref),
    select: { secret: true, status: true },
  });
  if (!entry || entry.status === "pending") return null;
  return decryptJson<T>(entry.secret);
}

// A ref resolved WITH the reason it failed, for callers that turn the failure into operator-facing
// advice. `tryResolveVaultSecret` collapses "no such row" and "row not filled yet" into the same
// null, which is right for "can I use this?" and wrong for "what should the operator do?": telling
// someone to fill a credential that was deleted sends them looking for a row that is not there.
//
// One query on purpose. Asking a second time whether the row exists reads a database that may have
// moved (a pending entry filled in between), and it cannot tell an ACTIVE row holding an empty
// secret from a row that is gone — both would answer "not filled". The state and the value have to
// come from the same read.
export type VaultRefResolution<T> =
  | { state: "filled"; value: T }
  | { state: "pending" }
  | { state: "not_found" };

export async function resolveVaultRefState<T = unknown>(
  db: ScopedDb,
  ref: string,
): Promise<VaultRefResolution<T>> {
  const entry = await db.vaultEntry.findFirst({
    where: vaultRefWhere(ref),
    select: { secret: true, status: true },
  });
  if (!entry) return { state: "not_found" };
  if (entry.status === "pending") return { state: "pending" };
  return { state: "filled", value: decryptJson<T>(entry.secret) };
}

// Resolved vault entry including metadata needed at the call site (secret, kind, baseUrl, paramName).
export interface ResolvedVaultEntry<T = unknown> {
  secret: T;
  kind: string;
  baseUrl: string | null;
  paramName: string | null;
  name: string;
}

export async function resolveVaultEntry<T = unknown>(
  db: ScopedDb,
  ref: string,
): Promise<ResolvedVaultEntry<T>> {
  const entry = await db.vaultEntry.findFirst({
    where: vaultRefWhere(ref),
    select: {
      secret: true,
      kind: true,
      baseUrl: true,
      paramName: true,
      name: true,
      status: true,
    },
  });
  if (!entry) throw new NotFoundError(`vault secret "${ref}" not found`);
  if (entry.status === "pending") throw pendingCredentialError(ref);
  return {
    secret: decryptJson<T>(entry.secret),
    kind: entry.kind,
    baseUrl: entry.baseUrl,
    paramName: entry.paramName,
    name: entry.name,
  };
}

export async function tryResolveVaultEntry<T = unknown>(
  db: ScopedDb,
  ref: string,
): Promise<ResolvedVaultEntry<T> | null> {
  const entry = await db.vaultEntry.findFirst({
    where: vaultRefWhere(ref),
    select: {
      secret: true,
      kind: true,
      baseUrl: true,
      paramName: true,
      name: true,
      status: true,
    },
  });
  if (!entry || entry.status === "pending") return null;
  return {
    secret: decryptJson<T>(entry.secret),
    kind: entry.kind,
    baseUrl: entry.baseUrl,
    paramName: entry.paramName,
    name: entry.name,
  };
}

// The MCP surface speaks vault entry NAMES (agent-friendly: the operator tells the agent a name);
// storage uses `vault:<id>`. These translate at that boundary, tenant-scoped (RLS).
// Use `resolveVaultRefByName` for new callers — it signals ambiguity explicitly instead of
// silently falling back to the oldest entry.

// Typed resolution of a vault entry by name, with explicit ambiguity signaling.
// With `kind` supplied: matches exactly (name, kind) — never ambiguous.
// Without `kind`: 0 rows → not_found; 1 → found; >1 → ambiguous (returns sorted kinds list).
export type VaultNameResolution =
  | { status: "found"; ref: string; kind: string; pending: boolean }
  | { status: "ambiguous"; kinds: string[] }
  | { status: "not_found" };

export async function resolveVaultRefByName(
  ctx: TenantContext,
  name: string,
  kind?: string | null,
  base: PrismaClient = basePrisma,
): Promise<VaultNameResolution> {
  return runScopedOn(base, ctx, async (db) => {
    const where = kind != null ? { name, kind } : { name };
    const rows = await db.vaultEntry.findMany({
      where,
      select: { id: true, kind: true, status: true },
    });
    if (rows.length === 0) return { status: "not_found" } as const;
    if (rows.length === 1) {
      const row = rows[0];
      if (!row) return { status: "not_found" } as const;
      return {
        status: "found",
        ref: formatVaultRef(row.id),
        kind: row.kind,
        // Informative: the ref still resolves (so config can be wired), but the secret is unfilled.
        pending: row.status === "pending",
      } as const;
    }
    // Multiple entries share the name with different kinds.
    const kinds = [...new Set(rows.map((r) => r.kind))].sort();
    return { status: "ambiguous", kinds } as const;
  });
}

// A ref on its way INTO a column, checked against the tenant's vault and returned in the one
// spelling every resolver agrees on. Two values are refused here rather than stored:
//
//   * anything that is not `vault:<id>`. A bare NAME is the one that happens (the REST schemas
//     asked for one in so many words), and `vaultRefWhere` turns it into a filter that matches
//     nothing, so the column holds a value no resolver can ever answer and the feature behaves as
//     if nothing were configured (issue #124: an inbound webhook 401s with the token correct on
//     both ends). MCP never hits this because it resolves names to refs before it gets here.
//   * a well-formed ref whose row is not in this tenant.
//
// A PENDING entry passes on purpose: wiring config to a reference whose secret is not filled yet is
// the point of credential_create, and the picker is where that gets surfaced.
//
// Canonicalizing is not cosmetic. `vault:007` resolves server-side (BigInt tolerates padding) but
// compares unequal against a list built from ids, so the picker reports a working credential as
// unavailable. See canonicalVaultRef in src/client/lib/credentialRef.ts.
//
// Deleting an entry still strands every ref that named it. That is a different cause for the same
// state, answered by the vault list and the picker, not here.

export async function requireVaultRef(
  db: ScopedDb,
  ref: string,
  // The server's own name for the input this ref arrived in, when the caller has one — a dotted path
  // into a bag it owns (`settings.tts.normalizeCredentialRef`). Optional because most callers refuse
  // a column the client already named in the patch it sent; the agent's two bags are the ones that
  // need it, where a ref can be any of eight fields across three editor tabs and the sentence alone
  // would leave the console guessing which input to mark. See src/api/lib/refusal.ts.
  field?: string,
): Promise<string> {
  const malformed = () =>
    new AppError(
      `"${ref}" is not a vault reference (expected vault:<id>)`,
      400,
      "errors.invalidVaultRef",
      { ref },
      field,
    );
  if (!ref.startsWith(VAULT_REF_PREFIX)) throw malformed();
  const raw = ref.slice(VAULT_REF_PREFIX.length);
  // Decimal digits only, within what a Postgres `bigint` column holds. BigInt is arbitrary precision
  // and lenient: `0x7`, `+7` and ` 7 ` all parse, and an id past 2^63-1 parses too and is refused by
  // the DATABASE instead, as a 500 for what is plainly a malformed field. Readers tolerate the
  // lenient spellings on purpose (canonicalVaultRef); a column takes ONE, so the rest are refused
  // here rather than normalized, and "stored canonically" stops depending on the writer.
  const id = parseDbId(raw);
  if (id === null) throw malformed();
  const entry = await db.vaultEntry.findFirst({
    where: { id },
    select: { id: true },
  });
  if (!entry) {
    throw new AppError(
      `vault secret "${ref}" not found`,
      400,
      "errors.vaultRefNotFound",
      { ref },
      field,
    );
  }
  return formatVaultRef(entry.id);
}

export async function vaultNameByRef(
  ctx: TenantContext,
  ref: string,
  base: PrismaClient = basePrisma,
): Promise<string | null> {
  return runScopedOn(base, ctx, async (db) => {
    const e = await db.vaultEntry.findFirst({
      where: vaultRefWhere(ref),
      select: { name: true },
    });
    return e ? e.name : null;
  });
}

// ── baseUrl / paramName validation helpers ──

const HTTPS_RE = /^https?:\/\//i;
const PARAM_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function validateBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!HTTPS_RE.test(trimmed)) {
    throw new AppError(
      "baseUrl must be a valid http(s) URL",
      400,
      "errors.invalidVaultBaseUrl",
    );
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AppError(
        "baseUrl must be a valid http(s) URL",
        400,
        "errors.invalidVaultBaseUrl",
      );
    }
    // Normalize: strip trailing slash from the path root.
    return trimmed.replace(/\/+$/, "");
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      "baseUrl must be a valid http(s) URL",
      400,
      "errors.invalidVaultBaseUrl",
    );
  }
}

function validateParamName(raw: string, kind: string): string {
  const trimmed = raw.trim();
  if (secretTypeNeedsParamName(kind) && !trimmed) {
    throw new AppError(
      "paramName is required for this credential type",
      400,
      "errors.vaultParamNameRequired",
    );
  }
  if (trimmed && !PARAM_NAME_RE.test(trimmed)) {
    throw new AppError(
      "paramName contains invalid characters",
      400,
      "errors.invalidVaultParamName",
    );
  }
  return trimmed;
}

// A credential is stored as its exact bytes, so a paste artifact is not a detail: an HTTP field
// value has its surrounding whitespace stripped before any handler sees it, so a token stored with a
// trailing newline can never be matched by the one that arrives, and the refusal that follows is
// byte-identical to a wrong token (issue #338).
//
// This REFUSES rather than trimming, and the difference is the whole point. Trimming would repair
// the header case silently while breaking the one where the bytes are shared rather than sent: an
// HMAC key never travels, both sides hold it, and `createHmac` uses it verbatim — so rewriting ours
// would fail every signature at the provider instead of here. Refusing changes no secret, needs no
// per-kind exception, and hands the operator the one fact they could not see.
// The sentence names the field when there is one, because that is the only place the name survives:
// `AppError.field` is dropped by the MCP writer (`failOf` sends `e.message`) and by the console's
// save-error path, so a padded Langfuse key would otherwise refuse with a sentence that cannot say
// WHICH of the two is padded — for whitespace, of all things, which the operator cannot see.
function assertNoSurroundingWhitespace(value: string, field?: string): void {
  if (value === value.trim()) return;
  if (field !== undefined) {
    throw new AppError(
      `value.${field} must not begin or end with whitespace`,
      400,
      "errors.vaultFieldWhitespace",
      { field },
      field,
    );
  }
  throw new AppError(
    "vault secret must not begin or end with whitespace",
    400,
    "errors.vaultSecretWhitespace",
  );
}

// Validates the secret value against the kind's declared shape.
// - kinds with `fields` declared: must be a Record<string, string> with exactly those keys, all non-empty.
// - all other kinds: must be a non-empty string.
function validateVaultValue(kind: string, value: unknown): void {
  // Managed-blob kinds (e.g. mcp_oauth) store a server-managed JSON object created empty: the
  // operator supplies no value fields (clientId comes from DCR, tokens from the consent flow). Accept
  // any object (including {}), reject non-objects.
  if (secretTypeIsManagedBlob(kind)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AppError(
        "value must be an object for this credential type",
        400,
        "errors.invalidVaultValue",
      );
    }
    return;
  }
  const fields = getSecretTypeFields(kind);
  if (fields) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AppError(
        "value must be an object for this credential type",
        400,
        "errors.invalidVaultValue",
      );
    }
    const rec = value as Record<string, unknown>;
    for (const { key } of fields) {
      const v = rec[key];
      if (typeof v !== "string" || v.length === 0) {
        throw new AppError(
          `value.${key} must be a non-empty string`,
          400,
          "errors.vaultFieldRequired",
          { field: key },
          // NOTE: the credential form renders one input per declared field and keys it by exactly this
          // (`fieldValues[f.key]`, src/client/components/CredentialForm.tsx), so the key IS the
          // console's name for the input that was refused.
          key,
        );
      }
      assertNoSurroundingWhitespace(v, key);
    }
    // Reject extra keys not in the declared field list.
    const declaredKeys = new Set(fields.map((f) => f.key));
    for (const k of Object.keys(rec)) {
      if (!declaredKeys.has(k)) {
        throw new AppError(
          `value has unexpected key: ${k}`,
          400,
          "errors.vaultFieldUnknown",
          { field: k },
        );
      }
    }
  } else {
    if (typeof value !== "string" || value.length === 0) {
      throw new AppError(
        "vault secret must not be empty",
        400,
        "errors.emptyVaultSecret",
      );
    }
    assertNoSurroundingWhitespace(value);
  }
}

export async function listVaultNames(db: ScopedDb): Promise<string[]> {
  const rows = await db.vaultEntry.findMany({
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => r.name);
}

export interface VaultEntryInfo {
  // BigInt id serialized as string; the client builds `vault:<id>` references from it.
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  paramName: string | null;
  // "active" = a real secret is stored; "pending" = only the reference exists (not filled yet).
  status: string;
}

export async function listVaultInfos(db: ScopedDb): Promise<VaultEntryInfo[]> {
  const rows = await db.vaultEntry.findMany({
    select: {
      id: true,
      name: true,
      kind: true,
      baseUrl: true,
      paramName: true,
      status: true,
    },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    kind: r.kind,
    baseUrl: r.baseUrl,
    paramName: r.paramName,
    status: r.status,
  }));
}

// ── ctx-based wrappers for the REST surface (the secret value is write-only: never returned) ──

// Name rule: trim first; reject empty (after trim), > 128 chars, or any control character
// (codepoint < 32 or == 127). Uses RegExp constructor to avoid Biome's noControlCharactersInRegex.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting control chars
const VAULT_NAME_CTRL_RE = /[\x00-\x1f\x7f]/;

function validateVaultName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > 128 || VAULT_NAME_CTRL_RE.test(name)) {
    throw new AppError(
      "invalid vault entry name",
      400,
      "errors.invalidVaultName",
    );
  }
  return name;
}

export async function listVaultEntries(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<string[]> {
  return runScopedOn(base, ctx, (db) => listVaultNames(db));
}

export async function listVaultEntryInfos(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<VaultEntryInfo[]> {
  return runScopedOn(base, ctx, (db) => listVaultInfos(db));
}

export interface CreateVaultEntryInput {
  name: string;
  value: string | Record<string, string>;
  kind?: string | null;
  baseUrl?: string | null;
  paramName?: string | null;
}

// INSERT-only create: 409 if both name and kind already exist in the tenant.
export async function createVaultEntry(
  ctx: TenantContext,
  nameOrInput: string | CreateVaultEntryInput,
  value?: string | Record<string, string>,
  kind?: string | null,
  base: PrismaClient = basePrisma,
): Promise<{ id: bigint; ref: string }> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;

  let rawName: string;
  let rawValue: string | Record<string, string>;
  let rawKind: string | null | undefined;
  let rawBaseUrl: string | null | undefined;
  let rawParamName: string | null | undefined;

  if (typeof nameOrInput === "object") {
    rawName = nameOrInput.name;
    rawValue = nameOrInput.value;
    rawKind = nameOrInput.kind;
    rawBaseUrl = nameOrInput.baseUrl;
    rawParamName = nameOrInput.paramName;
  } else {
    rawName = nameOrInput;
    rawValue = value as string | Record<string, string>;
    rawKind = kind;
    rawBaseUrl = undefined;
    rawParamName = undefined;
  }

  const validName = validateVaultName(rawName);
  if (rawKind != null && !isSecretTypeId(rawKind)) {
    throw new AppError("invalid secret type", 400, "errors.invalidSecretType");
  }

  const normalizedKind = rawKind ?? "generic";

  // Validate value shape for the kind.
  validateVaultValue(normalizedKind, rawValue);

  // Validate and normalize baseUrl.
  let normalizedBaseUrl: string | null = null;
  if (rawBaseUrl != null && rawBaseUrl !== "") {
    const validated = validateBaseUrl(rawBaseUrl);
    normalizedBaseUrl = validated || null;
  }

  if (secretTypeRequiresBaseUrl(normalizedKind) && !normalizedBaseUrl) {
    throw new AppError(
      "baseUrl is required for this credential type",
      400,
      "errors.vaultBaseUrlRequired",
    );
  }

  // Validate paramName.
  const normalizedParamName =
    rawParamName != null
      ? validateParamName(rawParamName, normalizedKind)
      : secretTypeNeedsParamName(normalizedKind)
        ? (() => {
            throw new AppError(
              "paramName is required for this credential type",
              400,
              "errors.vaultParamNameRequired",
            );
          })()
        : null;

  return runScopedOn(base, ctx, async (db) => {
    const existing = await db.vaultEntry.findFirst({
      where: { name: validName, kind: normalizedKind },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(
        "vault entry name and type already in use",
        "errors.vaultNameInUse",
      );
    }
    const blob = encryptJson(rawValue);
    try {
      const created = await db.vaultEntry.create({
        data: {
          tenantId,
          name: validName,
          secret: blob,
          kind: normalizedKind,
          baseUrl: normalizedBaseUrl,
          paramName: normalizedParamName || null,
        },
        select: { id: true },
      });
      return { id: created.id, ref: formatVaultRef(created.id) };
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictError(
          "vault entry name and type already in use",
          "errors.vaultNameInUse",
        );
      }
      throw e;
    }
  });
}

export interface CreatePendingVaultEntryInput {
  name: string;
  kind?: string | null;
  baseUrl?: string | null;
  paramName?: string | null;
}

// Creates a reference-only ("pending") vault entry: NO secret is supplied. Stores encryptJson({}) as
// a placeholder with status="pending"; resolution treats it as missing (resolve* throw
// errors.credentialPending, try* return null) until the operator fills it in the UI — updateVaultEntry
// with a real value promotes it to "active". Used by the MCP `credential_create` tool, which by design
// never receives a secret. INSERT-only: 409 if (name, kind) already exists in the tenant. baseUrl /
// paramName are not secrets, so they are validated/required up front to keep the entry coherent.
export async function createPendingVaultEntry(
  ctx: TenantContext,
  input: CreatePendingVaultEntryInput,
  base: PrismaClient = basePrisma,
): Promise<{ id: bigint; ref: string }> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;

  const validName = validateVaultName(input.name);
  if (input.kind != null && !isSecretTypeId(input.kind)) {
    throw new AppError("invalid secret type", 400, "errors.invalidSecretType");
  }
  const normalizedKind = input.kind ?? "generic";

  // OAuth/managed-blob kinds (google_oauth, mcp_oauth) get their secret from a connect/OAuth flow, not
  // a typed value, and that flow needs config (client id/secret) the empty placeholder lacks — so a
  // reference-only "pending" entry can never be completed for them. Reject up front with a clear error.
  if (
    isManagedOAuthKind(normalizedKind) ||
    secretTypeIsManagedBlob(normalizedKind)
  ) {
    throw new AppError(
      "this credential type is set up via a connect flow and cannot be created as a pending reference",
      400,
      "errors.credentialPendingUnsupportedKind",
    );
  }

  let normalizedBaseUrl: string | null = null;
  if (input.baseUrl != null && input.baseUrl !== "") {
    normalizedBaseUrl = validateBaseUrl(input.baseUrl) || null;
  }
  if (secretTypeRequiresBaseUrl(normalizedKind) && !normalizedBaseUrl) {
    throw new AppError(
      "baseUrl is required for this credential type",
      400,
      "errors.vaultBaseUrlRequired",
    );
  }
  const normalizedParamName =
    input.paramName != null
      ? validateParamName(input.paramName, normalizedKind)
      : secretTypeNeedsParamName(normalizedKind)
        ? (() => {
            throw new AppError(
              "paramName is required for this credential type",
              400,
              "errors.vaultParamNameRequired",
            );
          })()
        : null;

  return runScopedOn(base, ctx, async (db) => {
    const existing = await db.vaultEntry.findFirst({
      where: { name: validName, kind: normalizedKind },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(
        "vault entry name and type already in use",
        "errors.vaultNameInUse",
      );
    }
    // Placeholder blob: an empty object, never a real secret. `status` discriminates it from active.
    const blob = encryptJson({});
    try {
      const created = await db.vaultEntry.create({
        data: {
          tenantId,
          name: validName,
          secret: blob,
          kind: normalizedKind,
          baseUrl: normalizedBaseUrl,
          paramName: normalizedParamName || null,
          status: "pending",
        },
        select: { id: true },
      });
      return { id: created.id, ref: formatVaultRef(created.id) };
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictError(
          "vault entry name and type already in use",
          "errors.vaultNameInUse",
        );
      }
      throw e;
    }
  });
}

export interface UpdateVaultEntryPatch {
  name?: string;
  value?: string | Record<string, string>;
  baseUrl?: string | null;
  paramName?: string;
}

// Patch by id: name, value, baseUrl, paramName may be updated; kind is immutable.
// 404 if id not in tenant (RLS). A rename only conflicts when another entry with the SAME kind
// uses the target name. baseUrl: undefined = keep, null/"" = clear, string = validate+set.
// paramName: undefined = keep; string = validate (kind stays immutable, needsParamName is
// evaluated against the stored kind).
export async function updateVaultEntry(
  ctx: TenantContext,
  id: bigint,
  patch: UpdateVaultEntryPatch,
  base: PrismaClient = basePrisma,
): Promise<bigint> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  return runScopedOn(base, ctx, async (db) => {
    const entry = await db.vaultEntry.findFirst({
      where: { id },
      select: { id: true, kind: true },
    });
    if (!entry) throw new NotFoundError(`vault entry ${id} not found`);

    const data: {
      name?: string;
      secret?: string;
      baseUrl?: string | null;
      paramName?: string | null;
      status?: string;
    } = {};

    if (patch.name !== undefined) {
      const newName = validateVaultName(patch.name);
      // Clash check: same name + same kind as this entry (kind is immutable, so entry.kind
      // is the relevant constraint dimension).
      const clash = await db.vaultEntry.findFirst({
        where: { name: newName, kind: entry.kind },
        select: { id: true },
      });
      if (clash && clash.id !== id) {
        throw new ConflictError(
          "vault entry name and type already in use",
          "errors.vaultNameInUse",
        );
      }
      data.name = newName;
    }

    if (patch.value !== undefined) {
      validateVaultValue(entry.kind, patch.value);
      data.secret = encryptJson(patch.value);
      // Writing a real value promotes a pending entry (reference-only) to active. No-op for entries
      // already active. This is how "filling" a pending credential in the UI completes it.
      data.status = "active";
    }

    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl === null || patch.baseUrl === "") {
        if (secretTypeRequiresBaseUrl(entry.kind)) {
          throw new AppError(
            "baseUrl is required for this credential type",
            400,
            "errors.vaultBaseUrlRequired",
          );
        }
        data.baseUrl = null;
      } else {
        const validated = validateBaseUrl(patch.baseUrl);
        data.baseUrl = validated || null;
      }
    }

    if (patch.paramName !== undefined) {
      const validated = validateParamName(patch.paramName, entry.kind);
      data.paramName = validated || null;
    }

    if (Object.keys(data).length === 0) return entry.id;

    try {
      await db.vaultEntry.update({ where: { id: entry.id }, data });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictError(
          "vault entry name and type already in use",
          "errors.vaultNameInUse",
        );
      }
      throw e;
    }
    return entry.id;
  });
}

export async function deleteVaultEntry(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, (db) =>
    db.vaultEntry.deleteMany({ where: { id } }),
  );
}

// ── credential connectivity test (test-on-save) ──

// Tests a credential VALUE the operator just typed (pre-save), without touching the DB. Validates
// the kind, then delegates to the SSRF-guarded runner. The value never lands in a log.
export async function testVaultValue(
  kind: string,
  value: string,
  baseURL: string | null | undefined,
  deps: SecretTestDeps = {},
  paramName?: string | null,
): Promise<SecretTestResult> {
  if (kind && !isSecretTypeId(kind)) {
    throw new AppError("invalid secret type", 400, "errors.invalidSecretType");
  }
  // A value the write would refuse is not a connectivity question, and probing it answers the wrong
  // one: fetch strips the padding out of a header, so a fixed-header kind reports "Connection OK"
  // and the save then refuses the same bytes.
  if (value !== value.trim()) {
    return { testable: true, ok: false, code: "surrounding_whitespace" };
  }
  return runSecretTest({ kind, value, baseURL, paramName }, deps);
}

// Tests an ALREADY-stored credential by its `vault:<id>` ref (decrypts server-side; the value is
// never returned). baseURL is supplied by the caller for self-hosted types (not persisted).
export async function testStoredVaultEntry(
  ctx: TenantContext,
  ref: string,
  baseURL: string | null | undefined,
  deps: SecretTestDeps = {},
  base: PrismaClient = basePrisma,
): Promise<SecretTestResult> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.vaultEntry.findFirst({
      where: vaultRefWhere(ref),
      select: { secret: true, kind: true, baseUrl: true, paramName: true },
    }),
  );
  if (!row) throw new NotFoundError(`vault secret "${ref}" not found`);

  // Multi-field types (e.g. langfuse) are not testable; behave as not-testable.
  const fields = getSecretTypeFields(row.kind);
  if (fields) return { testable: false };

  const decrypted = decryptJson<unknown>(row.secret);
  const value = typeof decrypted === "string" ? decrypted : "";
  // Prefer caller-supplied baseURL; fall back to the stored baseUrl.
  const effectiveBase = baseURL ?? row.baseUrl;
  return runSecretTest(
    { kind: row.kind, value, baseURL: effectiveBase, paramName: row.paramName },
    deps,
  );
}

export interface VaultReferences {
  toolDefinitions: string[];
  mcpConnections: string[];
  integrations: string[];
  webhooks: string[];
  // Alert channels sign their deliveries with a vault secret too. This one was missing, so the
  // vault offered to delete a key an alert channel was using without a word about it.
  alertChannels: string[];
  // Agents carry their id so the UI can deep-link to the editor (/agents/:id); the others have no
  // per-item route and link to their closest panel.
  agents: { id: string; name: string }[];
  tenantSettings: string[];
}

// Reverse index: which entities reference a vault entry, so the UI can warn before deletion.
// Accepts the entry id directly; stored references are always `vault:<id>`.
// Covers the 5 String columns AND the JSON-embedded refs (Agent modelConfig/stt/tts) a column
// query cannot see — deleting an entry referenced only from JSON would otherwise break the agent
// silently. Returns an empty object when the id is not found in the tenant.
export async function vaultReferences(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<VaultReferences> {
  const empty: VaultReferences = {
    toolDefinitions: [],
    mcpConnections: [],
    integrations: [],
    webhooks: [],
    alertChannels: [],
    agents: [],
    tenantSettings: [],
  };
  return runScopedOn(base, ctx, async (db) => {
    const entry = await db.vaultEntry.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!entry) return empty;
    const idRef = formatVaultRef(entry.id);

    const [tds, mcps, ints, whs, alerts, agentRows, tenantRow] =
      await Promise.all([
        db.toolDefinition.findMany({
          where: { credentialRef: idRef },
          select: { name: true },
        }),
        db.mcpServerConnection.findMany({
          where: { credentialRef: idRef },
          select: { name: true },
        }),
        db.integrationInstance.findMany({
          where: {
            OR: [{ credentialRef: idRef }, { inboundSecretRef: idRef }],
          },
          select: { name: true },
        }),
        db.webhookSubscription.findMany({
          where: { secretRef: idRef },
          select: { url: true },
        }),
        db.alertChannel.findMany({
          where: { secretRef: idRef },
          select: { name: true },
        }),
        db.agent.findMany({
          where: {
            // NOTE: every settings path that can hold a credential, from the one list all three
            // consumers of that fact share. A path absent here reads as "this key is unused", and the
            // vault UI then offers to delete a key the runtime is about to need.
            OR: [
              { modelConfig: { path: ["credentialRef"], equals: idRef } },
              ...SETTINGS_CREDENTIAL_PATHS.map(({ path }) => ({
                settings: { path: [...path], equals: idRef },
              })),
            ],
          },
          select: { id: true, name: true },
        }),
        // Tenant settings (embedding/langfuse) are JSON-embedded singletons. Read the raw JSON and
        // compare the path directly — importing tenant-settings parsers here would cycle (that module
        // imports from this one).
        db.tenant.findFirst({ select: { settings: true } }),
      ]);
    const tenantSettings: string[] = [];
    const settings = (tenantRow?.settings ?? {}) as {
      embedding?: { credentialRef?: unknown };
      langfuse?: { credentialRef?: unknown };
    };
    if (settings.embedding?.credentialRef === idRef)
      tenantSettings.push("embedding");
    if (settings.langfuse?.credentialRef === idRef)
      tenantSettings.push("langfuse");
    return {
      toolDefinitions: tds.map((t) => t.name),
      mcpConnections: mcps.map((m) => m.name),
      integrations: ints.map((i) => i.name),
      webhooks: whs.map((w) => w.url),
      alertChannels: alerts.map((a) => a.name),
      agents: agentRows.map((a) => ({ id: String(a.id), name: a.name })),
      tenantSettings,
    };
  });
}
