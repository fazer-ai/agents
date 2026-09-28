import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { MAX_DB_ID, parseDbId } from "@/lib/db-id";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";
import {
  markUndisclosed,
  redactEndpoint,
  undisclosedMoved,
} from "@/modules/audit/projection";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
import {
  runSecretTest,
  type SecretTestDeps,
  type SecretTestResult,
} from "./secret-test";
import {
  BASE_URL_KIND_IDS,
  type CredentialUse,
  credentialServes,
  getSecretTypeFields,
  isManagedOAuthKind,
  isSecretTypeId,
  PARAM_NAME_KIND_IDS,
  readsPlainKey,
  secretTypeFits,
  secretTypeIsManagedBlob,
  secretTypeNeedsParamName,
  secretTypeRefusesBaseUrl,
  secretTypeRefusesParamName,
  secretTypeRequiresBaseUrl,
  secretValueFitsKind,
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

// The id a STORED ref names, by the reader's rule rather than the writer's. `requireVaultRef`
// accepts only the canonical spelling on the way IN, but older rows exist, and `canonicalVaultRef`
// (src/client/lib/credentialRef.ts) is the contract every resolver keeps: `vault:0007`, `vault: 7`
// and `vault:7` are the same entry. Lenient about SPELLING, bounded by RANGE: a value past a bigint
// column's range would reach Postgres as a bind error instead of "no such entry". Every reader of a
// stored ref goes through this one function.
export function readVaultRefId(ref: string): bigint | null {
  if (!ref.startsWith(VAULT_REF_PREFIX)) return null;
  const raw = ref.slice(VAULT_REF_PREFIX.length);
  // NOTE: `BigInt("")` is `0n`, so a bare `vault:` named row zero rather than nothing. No column
  // ever holds that id, so nothing observable turned on it — but "a prefix with no id after it
  // names an entry" is not a rule this file should be able to be read as having.
  if (raw.trim() === "") return null;
  let id: bigint;
  try {
    id = BigInt(raw);
  } catch {
    return null;
  }
  return id < 0n || id > MAX_DB_ID ? null : id;
}

// The one form of a STORED ref that is safe to hand to a reader, or null when it names no entry. A
// ref column can hold arbitrary text written before `requireVaultRef` guarded it (even a raw secret),
// and echoing it would publish that. The output is never the stored string: `vault:` plus the
// decimal of an in-range id, so anything a secret looks like (hex, base64, `sha256=…`) reads as null,
// and a canonical form `requireVaultRef` accepts is echoed back. It proves the value IS a reference,
// not that the entry exists: a deleted entry still lets the picker say "Credential unavailable".
export function readableVaultRef(stored: string | null): string | null {
  if (stored === null) return null;
  const id = readVaultRefId(stored);
  return id === null ? null : formatVaultRef(id);
}

export function vaultRefWhere(ref: string): { id: bigint } {
  return { id: readVaultRefId(ref) ?? -1n };
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

// A ref resolved WITH the reason it failed, for callers that turn the failure into operator advice:
// telling someone to fill a credential that was deleted sends them looking for a missing row. One
// query on purpose: a second read can see a moved database, and state and value must come from the
// same read.
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

// The state of MANY refs in one query, for a projection that renders a list, so a screen does not
// call a channel "Signed" on the strength of the column alone. Keyed by the CANONICAL ref, which is
// what `readableVaultRef` publishes. A ref that does not parse or whose entry is gone is ABSENT from
// the map; it holds only the two states an existing entry can be in.
export async function vaultRefStates(
  db: ScopedDb,
  refs: readonly (string | null)[],
): Promise<Map<string, "filled" | "pending">> {
  const byId = new Map<bigint, string>();
  for (const ref of refs) {
    if (ref === null) continue;
    const id = readVaultRefId(ref);
    if (id !== null) byId.set(id, formatVaultRef(id));
  }
  const out = new Map<string, "filled" | "pending">();
  if (byId.size === 0) return out;
  const rows = await db.vaultEntry.findMany({
    where: { id: { in: [...byId.keys()] } },
    select: { id: true, status: true },
  });
  for (const row of rows) {
    const canonical = byId.get(row.id);
    if (canonical === undefined) continue;
    out.set(canonical, row.status === "pending" ? "pending" : "filled");
  }
  return out;
}

// Whether what this ref names can actually sign, for a screen rather than a delivery. `none` is not
// a problem (unsigned by design). The other three all mean deliveries go out unsigned and differ only
// in the errand: `unreadable` is an old column holding text that names no entry, `missing` a deleted
// credential, `pending` one never filled.
export type SigningState =
  | "none"
  | "signed"
  | "unreadable"
  | "missing"
  | "pending";

// The rule the workers run, read off the row plus a batch of vault states. It lives here, with
// `resolveSigningSecret`, because it IS that function's question asked without decrypting anything,
// so the console and the worker cannot disagree.
export function signingStateFor(
  stored: string | null,
  readable: string | null,
  states: Map<string, "filled" | "pending">,
): SigningState {
  if (stored === null) return "none";
  if (readable === null) return "unreadable";
  const state = states.get(readable);
  if (state === "filled") return "signed";
  if (state === "pending") return "pending";
  // Absent: the entry is gone. Same wire behaviour as `pending`, different errand — recreate the
  // credential rather than fill it in.
  return "missing";
}

export interface SigningSecret {
  secret: string | null;
  // Null in the two cases nobody needs to hear about: it signed, or no secret was ever configured.
  unsignedReason: string | null;
}

// A signing ref that stopped resolving (deleted, or never filled) makes the alert and outbound
// webhook workers POST UNSIGNED rather than hold the payload, but never silently: the answer carries
// advice per state, since a deleted credential cannot be filled in. Prose, not a code: a person reads
// it next to the row, and it names the receiver-side symptom (a verifying receiver rejects it).
export async function resolveSigningSecret(
  db: ScopedDb,
  ref: string | null | undefined,
): Promise<SigningSecret> {
  if (!ref) return { secret: null, unsignedReason: null };
  const res = await resolveVaultRefState<string>(db, ref);
  if (res.state === "filled")
    return { secret: res.value, unsignedReason: null };
  return {
    secret: null,
    unsignedReason:
      res.state === "not_found"
        ? "sent UNSIGNED: the signing credential this points at is no longer in the vault, so the request went out with no signature and a receiver that verifies will reject it. Recreate the credential and point this at it, or clear the signing secret if the receiver does not check."
        : "sent UNSIGNED: the signing credential this points at has no value yet, so the request went out with no signature and a receiver that verifies will reject it. Fill the credential in on the vault page, or clear the signing secret if the receiver does not check.",
  };
}

// Resolved vault entry including metadata needed at the call site (secret, kind, baseUrl, paramName).
export interface ResolvedVaultEntry<T = unknown> {
  secret: T;
  kind: string;
  baseUrl: string | null;
  paramName: string | null;
  name: string;
}

export type VaultEntryResolution<T> =
  | { state: "filled"; entry: ResolvedVaultEntry<T> }
  | { state: "pending" }
  | { state: "not_found" };

// The base URL a consumer may DIAL, which is not always the one in the row. The write boundary
// refuses a base URL on a kind with no use for one, but rows written before that still carry one,
// and the model path, vision, STT, TTS, HTTP tools and MCP read it without asking the kind. The row
// is not touched: `listVaultInfos` still reports it, and nothing dials it.
export function dialableBaseUrl(
  kind: string | null,
  baseUrl: string | null,
): string | null {
  return secretTypeRefusesBaseUrl(kind) ? null : baseUrl;
}

// State-aware variant for callers that need both operator-facing pending/not-found diagnostics and
// active-entry metadata such as baseUrl. Keeping this separate avoids changing the generic
// resolveVaultRefState value contract used by existing secret-only consumers.
export async function resolveVaultEntryState<T = unknown>(
  db: ScopedDb,
  ref: string,
): Promise<VaultEntryResolution<T>> {
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
  if (!entry) return { state: "not_found" };
  if (entry.status === "pending") return { state: "pending" };
  return {
    state: "filled",
    entry: {
      secret: decryptJson<T>(entry.secret),
      kind: entry.kind,
      baseUrl: dialableBaseUrl(entry.kind, entry.baseUrl),
      paramName: entry.paramName,
      name: entry.name,
    },
  };
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
    baseUrl: dialableBaseUrl(entry.kind, entry.baseUrl),
    paramName: entry.paramName,
    name: entry.name,
  };
}

// The secret comes back as `unknown`, with no generic parameter, ON PURPOSE: `decryptJson<T>` casts,
// so a `<string>` at the call site was an assertion, not a check. Callers that need a string go
// through `tryResolveApiKeyEntry` or narrow it themselves.
export async function tryResolveVaultEntry(
  db: ScopedDb,
  ref: string,
): Promise<ResolvedVaultEntry | null> {
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
    secret: decryptJson(entry.secret),
    kind: entry.kind,
    baseUrl: dialableBaseUrl(entry.kind, entry.baseUrl),
    paramName: entry.paramName,
    name: entry.name,
  };
}

// The same resolution for a field that reads a PLAIN API KEY and hands it to somebody else's SDK (the
// agent's model and its overrides, STT, TTS, vision). Three outcomes, because the operator's move
// differs: re-pick or fill a ref that no longer resolves, move one of the wrong KIND to another
// field. The shape check backs the kind check: a legacy entry or an unconnected managed blob can
// disagree with its kind.
export type ApiKeyResolution =
  | { state: "ok"; secret: string; baseUrl: string | null }
  // Deleted, never resolvable, or referenced with its secret not filled in yet.
  | { state: "unresolved" }
  // Present and filled, and this is not a credential this field can use.
  | { state: "unusable"; kind: string };

export async function tryResolveApiKeyEntry(
  db: ScopedDb,
  ref: string,
): Promise<ApiKeyResolution> {
  const entry = await tryResolveVaultEntry(db, ref);
  if (!entry) return { state: "unresolved" };
  // The same two predicates the write boundary and config-health use, and `secretValueFitsKind`
  // rather than a local `typeof`: the local one accepted an empty string, so an active legacy row
  // holding `""` was refused on the way IN and handed to the provider as a blank key on the way OUT.
  // The two readings of "unfit" have one source now, which is the only way they stay one answer.
  if (
    !secretTypeFits(entry.kind, "apiKey") ||
    !secretValueFitsKind(entry.kind, entry.secret) ||
    typeof entry.secret !== "string"
  ) {
    return { state: "unusable", kind: entry.kind };
  }
  return {
    state: "ok",
    secret: entry.secret,
    baseUrl: dialableBaseUrl(entry.kind, entry.baseUrl),
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
  return runScopedOn(base, ctx, (db) =>
    resolveVaultRefByNameOn(db, name, kind),
  );
}

// The same lookup, on a transaction the caller already opened — the read half of the pair whose
// write half is `ensurePendingVaultEntryOn`. The agent import asks this question once per credential
// the bundle names and then creates what it did not find, so a lookup on a separate connection
// cannot see the rows the import has already written: a bundle referencing the same missing
// credential twice under trim-equivalent spellings resolved the second one as missing too, and the
// insert then collided with the row from the first. Same transaction, same answer.
export async function resolveVaultRefByNameOn(
  db: ScopedDb,
  name: string,
  kind?: string | null,
): Promise<VaultNameResolution> {
  {
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
  }
}

// A ref on its way INTO a column, checked against the tenant's vault and returned canonical. Refused:
// anything not `vault:<id>` (a bare NAME makes a filter that matches nothing, so the feature behaves
// as unconfigured; MCP resolves names first), and a ref whose row is not in this tenant. PENDING
// passes on purpose (the point of credential_create). Canonical because `vault:007` resolves but
// compares unequal in the picker's id list (canonicalVaultRef in src/client/lib/credentialRef.ts).
// Deleting an entry still strands its refs; the vault list and the picker answer that.
export async function requireVaultRef(
  db: ScopedDb,
  ref: string,
  // The server's own name for the input this ref arrived in: a column (`credentialRef`) or a dotted
  // path into a bag it owns (`settings.tts.normalizeCredentialRef`). See src/api/lib/refusal.ts.
  // REQUIRED: what the client SENT and what the server REFUSED differ (one body can carry several
  // refs), a refusal with no field is unplaceable by any form, and only the type sees an omission.
  field: string,
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

// Decrypts a stored blob far enough to answer "is this the shape its kind declares?", and no further:
// the value is judged and dropped, never returned or logged. THREE answers: a blob nobody can decrypt
// (rotated `ENCRYPTION_KEY`, truncated row) is `unreadable`, never `unfit`, or a key rotation would
// refuse every agent write while blaming the credential's type. `unreadable` never refuses or warns.
type ValueVerdict = "fits" | "unfit" | "unreadable";

function vaultValueVerdict(
  kind: string | null,
  encrypted: string,
): ValueVerdict {
  let value: unknown;
  try {
    value = decryptJson(encrypted);
  } catch {
    return "unreadable";
  }
  return secretValueFitsKind(kind, value) ? "fits" : "unfit";
}

// The permissive projection every caller here wants: only a value that was READ and judged wrong
// counts against the credential.
function vaultValueFits(kind: string | null, encrypted: string): boolean {
  return vaultValueVerdict(kind, encrypted) !== "unfit";
}

// What the vault says about one ref beyond its existence, for the two callers that judge a PAIRING
// without being the write boundary: the import warning and (through listVaultInfos) config-health.
// One function so the three surfaces cannot end up asking different halves of the same question,
// which is the defect this whole change is about. Null when the ref names no row in this tenant.
export interface VaultEntryFacts {
  kind: string;
  valueFitsKind: boolean;
  // The operator-supplied header/query name, for the two kinds that read one, and the base URL a
  // relative tool template is resolved against (placeholders included): WHERE the credential lands
  // is as much a property of the entry as whether it fits.
  paramName: string | null;
  baseUrl: string | null;
}

export async function readVaultRefFacts(
  db: ScopedDb,
  ref: string,
): Promise<VaultEntryFacts | null> {
  const row = await db.vaultEntry.findFirst({
    where: vaultRefWhere(ref),
    select: {
      kind: true,
      status: true,
      secret: true,
      paramName: true,
      baseUrl: true,
    },
  });
  if (!row) return null;
  return {
    kind: row.kind,
    valueFitsKind:
      row.status === "pending" || vaultValueFits(row.kind, row.secret),
    paramName: row.paramName,
    baseUrl: row.baseUrl,
  };
}

// `requireVaultRef` plus: can an entry of THIS KIND supply what the field reads? Separate because it
// covers only fields with a declared `CredentialUse` (the agent's nine and the embedding key); the
// fixed-kind or local-only refs (langfuse, integration credentials, signing secrets) do not have one.
// The field is in the sentence too: MCP hands `message` over verbatim. Refused rather than reported:
// what is ALREADY stored is left to config-health, so one bad pairing cannot freeze other edits.
export async function requireVaultRefFor(
  db: ScopedDb,
  ref: string,
  field: string,
  use: CredentialUse,
): Promise<string> {
  const canonical = await requireVaultRef(db, ref, field);
  const entry = await db.vaultEntry.findFirst({
    where: vaultRefWhere(canonical),
    select: { kind: true, status: true, secret: true },
  });
  // Gone between the two reads: `requireVaultRef` has already answered for existence, and inventing
  // a second refusal here would report a race as a shape problem.
  if (!entry) return canonical;
  // NOTE: TWO questions (kind and value), because the runtime asks two, and a boundary that asks
  // fewer accepts what the turn then refuses. A PENDING entry has no value yet by design
  // (`credential_create`), so it is judged on its KIND alone; refusing it would break the
  // reference-first flow.
  if (
    credentialServes(
      {
        kind: entry.kind,
        valueFitsKind:
          entry.status === "pending" ||
          vaultValueFits(entry.kind, entry.secret),
      },
      use,
    )
  ) {
    return canonical;
  }
  // Two spellings of one refusal, written out rather than ternaried into one `new AppError`. The
  // error-catalog fence reads the key and its interpolation values out of the SOURCE, and a key
  // computed in the argument position is invisible to it: it reported the outbound sentence as a key
  // nothing throws and the API-key one as thrown without its `{{kind}}`. Both readings were right
  // about the text and wrong about the code, which is the fence doing its job.
  if (readsPlainKey(use)) {
    throw new AppError(
      `${field}: credential "${ref}" (kind "${entry.kind}") cannot serve a field that reads a plain API key`,
      400,
      "errors.credentialKindUnusableAsKey",
      { kind: entry.kind },
      field,
    );
  }
  throw new AppError(
    `${field}: credential "${ref}" (kind "${entry.kind}") is never sent outbound and cannot authenticate a request`,
    400,
    "errors.credentialKindUnusableOutbound",
    { kind: entry.kind },
    field,
  );
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

export function validateBaseUrl(raw: string): string {
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

// The catalog declares WHICH kinds read a param name (`needsParamName`), and only
// `resolveSecretInjection` reads it, so a name on any other kind would be accepted and never sent:
// the request goes out with no credential. Refused, naming a kind that injects. Empty stays empty:
// "" means "no param name", and refusing it would break clients that always send the field.
function validateParamName(raw: string, kind: string): string {
  const trimmed = raw.trim();
  if (secretTypeNeedsParamName(kind) && !trimmed) {
    throw new AppError(
      "paramName is required for this credential type",
      400,
      "errors.vaultParamNameRequired",
    );
  }
  if (trimmed && secretTypeRefusesParamName(kind)) {
    const kinds = PARAM_NAME_KIND_IDS.join(", ");
    throw new AppError(
      `the "${kind}" credential type does not use a param name. The types that do are: ${kinds}.`,
      400,
      "errors.vaultParamNameNotApplicable",
      { kind, kinds },
      "paramName",
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

// A credential is stored as its exact bytes, and an HTTP field value arrives with surrounding
// whitespace stripped, so a padded stored token can never match. REFUSED rather than trimmed: an HMAC
// key is shared, not sent, and `createHmac` uses it verbatim, so trimming ours would fail every
// signature at the provider. The sentence names the field, because `AppError.field` is dropped by
// the MCP writer and the console's save-error path.
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
  // Whether the stored value is the shape this kind declares. A VERDICT, never the value: it is
  // computed server-side and crosses the wire as a boolean, so the console can judge a pairing the
  // way the runtime does without the secret ever leaving the process. Always true for a `pending`
  // entry, which has no value yet and is reported through `status` instead.
  valueFitsKind: boolean;
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
      secret: true,
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
    valueFitsKind: r.status === "pending" || vaultValueFits(r.kind, r.secret),
  }));
}

// ── ctx-based wrappers for the REST surface (the secret value is write-only: never returned) ──

// Name rule: trim first; reject empty (after trim), > 128 chars, or any control character
// (codepoint < 32 or == 127). Uses RegExp constructor to avoid Biome's noControlCharactersInRegex.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting control chars
const VAULT_NAME_CTRL_RE = /[\x00-\x1f\x7f]/;

// The name a row is STORED under, or null when it could never be stored. A caller that looks a
// credential up BEFORE deciding to create it has to ask about the same string the write will use,
// and the write trims: the agent import resolved a bundle's ` cred ` as missing, reached the insert,
// and collided with the row it had just failed to find. `validateVaultName` is this function plus
// the throw, so the rule has one spelling rather than two.
export function storedVaultName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0 || name.length > 128 || VAULT_NAME_CTRL_RE.test(name)) {
    return null;
  }
  return name;
}

function validateVaultName(raw: string): string {
  const name = storedVaultName(raw);
  if (name === null) {
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

// The base URL a write would STORE, refusing both ways the kind can disagree with it: required and
// absent, and present on a kind with no use for one (the runtime reads it without asking the kind,
// so an `openai` credential would send its key to a host the console never shows; the refusal names
// `openai_compatible`). Checked AFTER normalization, which turns "   " into empty. Empty stays empty
// on a kind with no input, since the console submits the field on every kind.
function normalizeBaseUrlForKind(
  raw: string | null | undefined,
  kind: string,
): string | null {
  const normalized =
    raw == null || raw === "" ? null : validateBaseUrl(raw) || null;
  if (normalized === null) {
    if (secretTypeRequiresBaseUrl(kind)) {
      throw new AppError(
        "baseUrl is required for this credential type",
        400,
        "errors.vaultBaseUrlRequired",
      );
    }
    return null;
  }
  if (secretTypeRefusesBaseUrl(kind)) {
    const kinds = BASE_URL_KIND_IDS.join(", ");
    throw new AppError(
      `the "${kind}" credential type does not use a base URL. The types that do are: ${kinds}.`,
      400,
      "errors.vaultBaseUrlNotApplicable",
      { kind, kinds },
      "baseUrl",
    );
  }
  return normalized;
}

// Everything `createVaultEntry` decides about its input before any database is involved (name, kind,
// the VALUE against the kind's fields, base URL, param name), so a caller can ask first. Its RETURN
// is part of the verdict: `kind` defaults to "generic" and `baseUrl` normalizes.
export function assertVaultEntryCreatable(input: CreateVaultEntryInput): {
  name: string;
  kind: string;
  baseUrl: string | null;
  paramName: string | null;
} {
  const name = validateVaultName(input.name);
  if (input.kind != null && !isSecretTypeId(input.kind)) {
    throw new AppError("invalid secret type", 400, "errors.invalidSecretType");
  }
  const kind = input.kind ?? "generic";
  validateVaultValue(kind, input.value);

  const baseUrl = normalizeBaseUrlForKind(input.baseUrl, kind);

  const paramName =
    input.paramName != null
      ? validateParamName(input.paramName, kind)
      : secretTypeNeedsParamName(kind)
        ? (() => {
            throw new AppError(
              "paramName is required for this credential type",
              400,
              "errors.vaultParamNameRequired",
            );
          })()
        : null;

  return { name, kind, baseUrl, paramName };
}

// What a credential's audit row carries, and what it only compares. PROJECTED: `id`, `name`, the
// type, the lifecycle and how it is used; `baseUrl` only as its ORIGIN (`redactEndpoint`), since a
// self-hosted root can carry a token in its path and this row is append-only. UNDISCLOSED, compared
// and never carried: the `secret`, and the whole `baseUrl`, so a path change still counts.
type VaultAuditRow = {
  id: bigint;
  name: string;
  kind: string;
  status: string;
  baseUrl: string | null;
  paramName: string | null;
  secret: string;
};

function auditProjection(r: VaultAuditRow) {
  return {
    id: String(r.id),
    name: r.name,
    kind: r.kind,
    status: r.status,
    baseUrl: r.baseUrl === null ? null : redactEndpoint(r.baseUrl),
    paramName: r.paramName,
  };
}

const VAULT_AUDIT_SELECT = {
  id: true,
  name: true,
  kind: true,
  status: true,
  baseUrl: true,
  paramName: true,
  secret: true,
} as const;

const UNDISCLOSED = ["secret", "baseUrl"] as const;

// Whether the credential BEHIND the reference moved, asked of the plaintext.
//
// The ciphertext cannot answer it: `encryptJson` randomizes, so re-submitting the value already
// stored produces a different blob every time, and a comparison on the column would report a
// rotation on every save of an unchanged credential. A blob that cannot be read counts as moved:
// the write replaces it, and an unreadable secret becoming a readable one is a change.
function secretMoved(before: string, after: string): boolean {
  // The column UNCHANGED is the one answer the ciphertext can give: a metadata-only save leaves the
  // blob byte-identical, and asking anything else about it (including whether it can be read) would
  // report a rotation on every edit of a row whose key has since changed.
  if (before === after) return false;
  let a: unknown;
  let b: unknown;
  try {
    a = decryptJson(before);
  } catch {
    return true;
  }
  try {
    b = decryptJson(after);
  } catch {
    return true;
  }
  return stableJson(a) !== stableJson(b);
}

// Key order is not part of a credential. A multi-field secret is stored as an object and read by
// key, so `{publicKey, secretKey}` and `{secretKey, publicKey}` are the same credential and a
// comparison that says otherwise reports a rotation nobody performed.
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([x], [y]) =>
            x < y ? -1 : x > y ? 1 : 0,
          ),
        )
      : val,
  );
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

  const {
    name: validName,
    kind: normalizedKind,
    baseUrl: normalizedBaseUrl,
    paramName: normalizedParamName,
  } = assertVaultEntryCreatable({
    name: rawName,
    value: rawValue,
    kind: rawKind,
    baseUrl: rawBaseUrl,
    paramName: rawParamName,
  });

  return runScopedOn(base, ctx, async (db) => {
    const existing = await db.vaultEntry.findFirst({
      where: { name: validName, kind: normalizedKind },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(
        "vault entry name and type already in use",
        "errors.vaultNameInUse",
        "name",
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
        select: VAULT_AUDIT_SELECT,
      });
      await auditMutation(db, ctx, {
        action: "credential.create",
        target: formatVaultRef(created.id),
        after: auditProjection(created),
      });
      return { id: created.id, ref: formatVaultRef(created.id) };
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictError(
          "vault entry name and type already in use",
          "errors.vaultNameInUse",
          "name",
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

// The database half of `createPendingVaultEntry`'s verdict, ADVISORY: it reads outside the write's
// transaction; the pre-read inside the write and the unique index stay the authority. Takes the
// NORMALIZED pair, since `kind` defaults to "generic" and uniqueness is on the stored value.
export async function assertVaultNameAvailable(
  ctx: TenantContext,
  name: string,
  kind: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const taken = await runScopedOn(base, ctx, (db) =>
    db.vaultEntry.findFirst({ where: { name, kind }, select: { id: true } }),
  );
  if (taken) {
    throw new ConflictError(
      "vault entry name and type already in use",
      "errors.vaultNameInUse",
      "name",
    );
  }
}

// Everything `createPendingVaultEntry` decides about its INPUT before any database is involved (name,
// kind, the connect-flow-only kinds, base URL, param name), so the MCP preview asks what the apply
// asks. Returns the normalized fields the caller goes on to store.
export function assertPendingVaultEntryCreatable(
  input: CreatePendingVaultEntryInput,
): {
  name: string;
  kind: string;
  baseUrl: string | null;
  paramName: string | null;
} {
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

  // NOTE: the SAME helper the create path uses, not a second spelling of it.
  const normalizedBaseUrl = normalizeBaseUrlForKind(
    input.baseUrl,
    normalizedKind,
  );
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

  return {
    name: validName,
    kind: normalizedKind,
    baseUrl: normalizedBaseUrl,
    paramName: normalizedParamName || null,
  };
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
  return runScopedOn(base, ctx, async (db) => {
    const entry = await ensurePendingVaultEntryOn(db, ctx, input);
    if (!entry.created) {
      throw new ConflictError(
        "vault entry name and type already in use",
        "errors.vaultNameInUse",
        "name",
      );
    }
    return { id: entry.id, ref: entry.ref };
  });
}

// The same write, on a transaction the caller already opened, and conflict-free. The agent import
// calls it from inside its own transaction, so an unwound import leaves no entries behind, and
// `ON CONFLICT DO NOTHING` plus a read turns a concurrent import into a fact instead of an aborted
// transaction. What a pre-existing row MEANS is the caller's: MCP `credential_create` answers 409,
// the import reuses the row.
export async function ensurePendingVaultEntryOn(
  db: ScopedDb,
  ctx: TenantContext,
  input: CreatePendingVaultEntryInput,
): Promise<{ id: bigint; ref: string; created: boolean }> {
  // NOTE: not re-asked here. A `ScopedDb` only comes out of `runScopedOn`, which refuses a null
  // tenant before it opens the transaction, so by the time this holds one the question is answered.
  const tenantId = ctx.tenantId as bigint;
  const {
    name: validName,
    kind: normalizedKind,
    baseUrl: normalizedBaseUrl,
    paramName: normalizedParamName,
  } = assertPendingVaultEntryCreatable(input);

  // Placeholder blob: an empty object, never a real secret. `status` discriminates it from active.
  const blob = encryptJson({});
  const { count } = await db.vaultEntry.createMany({
    data: [
      {
        tenantId,
        name: validName,
        secret: blob,
        kind: normalizedKind,
        baseUrl: normalizedBaseUrl,
        paramName: normalizedParamName || null,
        status: "pending",
      },
    ],
    skipDuplicates: true,
  });
  const row = await db.vaultEntry.findFirstOrThrow({
    where: { name: validName, kind: normalizedKind },
    select: VAULT_AUDIT_SELECT,
  });
  const created = count === 1;
  if (created) {
    // NOTE: The same action as a filled create, because it is the same act: a credential now
    // exists under this name. `status` is what tells the two apart, and it is on the row.
    //
    // This is also where the agent import starts leaving a trail. It creates one reference-only
    // entry per credential the bundle names and the tenant does not have, and its own `agent.import`
    // row projects the AGENT, so six pending credentials used to appear in the vault with nothing
    // naming where they came from. One row each, under the operator who ran the import. A row that
    // was already there is not this operator's act and files nothing.
    await auditMutation(db, ctx, {
      action: "credential.create",
      target: formatVaultRef(row.id),
      after: auditProjection(row),
    });
  }
  return { id: row.id, ref: formatVaultRef(row.id), created };
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
    // NOTE: LOCKED before it is read, because this snapshot is what the row's `before` reports. Two
    // overlapping saves both read the same entry otherwise, and the second wakes to an `after` that
    // includes the first one's changes: its row then claims a transition, or a rotation, that its
    // actor never performed.
    await db.$queryRaw`SELECT id FROM vault_entries WHERE id = ${id} FOR UPDATE`;
    const entry = await db.vaultEntry.findFirst({
      where: { id },
      select: VAULT_AUDIT_SELECT,
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
          "name",
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
      data.baseUrl = normalizeBaseUrlForKind(patch.baseUrl, entry.kind);
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
          "name",
        );
      }
      throw e;
    }
    const after = await db.vaultEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: VAULT_AUDIT_SELECT,
    });
    const beforeProj = auditProjection(entry);
    const afterProj = auditProjection(after);
    // NOTE: Over the declared list, so a column added to it later is compared without anyone having
    // to remember this line; `secret` is the one whose comparison cannot be a column comparison.
    const undisclosed = UNDISCLOSED.some((c) =>
      c === "secret"
        ? secretMoved(entry.secret, after.secret)
        : undisclosedMoved(entry, after, [c]),
    );
    // NOTE: replacing the value behind a live reference changes what every consumer authenticates
    // with, so it is recorded (as the marker, not the value). Gated on `undisclosedMoved`, not only
    // on `projectionMoved`: identical markers would drop the save whose ONLY change was the secret.
    if (undisclosed || projectionMoved(beforeProj, afterProj)) {
      await auditMutation(db, ctx, {
        action: "credential.update",
        target: formatVaultRef(entry.id),
        before: undisclosed ? markUndisclosed(beforeProj) : beforeProj,
        after: undisclosed ? markUndisclosed(afterProj) : afterProj,
      });
    }
    return entry.id;
  });
}

// Replace the secret behind an existing entry, recording it like any other credential edit. The
// OAuth connect and disconnect flows write through here so they reach the audit trail; the value is
// never projected (`credential.update` carries the marker and the metadata).
export async function replaceVaultSecret(
  ctx: TenantContext,
  id: bigint,
  value: unknown,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    await db.$queryRaw`SELECT id FROM vault_entries WHERE id = ${id} FOR UPDATE`;
    const before = await db.vaultEntry.findFirst({
      where: { id },
      select: VAULT_AUDIT_SELECT,
    });
    if (!before) throw new NotFoundError(`vault entry ${id} not found`);
    const blob = encryptJson(value);
    await db.vaultEntry.updateMany({ where: { id }, data: { secret: blob } });
    if (secretMoved(before.secret, blob)) {
      const proj = auditProjection(before);
      await auditMutation(db, ctx, {
        action: "credential.update",
        target: formatVaultRef(id),
        before: markUndisclosed(proj),
        after: markUndisclosed(proj),
      });
    }
  });
}

// The refresh path's write, audited only when the CREDENTIAL moved: an access token renews hourly by
// use and would drown the operator's edits, while a rotated refresh token or changed scopes are the
// credential itself. Compared against the value read HERE under `FOR UPDATE` (the module's lock mode
// on this table), not the caller's pre-network snapshot, so two overlapping refreshes record one
// rotation. `system` with a null actor: nobody decided the refresh.
export async function persistRefreshedOAuthSecret<
  T extends { refreshToken?: string | null; scopes?: string[] | null },
>(
  ctx: TenantContext,
  id: bigint,
  after: T,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const scopeKey = (v: string[] | null | undefined) =>
    JSON.stringify([...(v ?? [])].sort());
  await runScopedOn(base, ctx, async (db) => {
    await db.$queryRaw`SELECT id FROM vault_entries WHERE id = ${id} FOR UPDATE`;
    const row = await db.vaultEntry.findFirst({
      where: { id },
      select: VAULT_AUDIT_SELECT,
    });
    // Deleted under us: there is nothing to refresh and nothing to record. The caller already has
    // its access token and the next use will fail on the missing reference, which is the truth.
    if (!row) return;
    // A blob that will not decrypt into the shape (a pending placeholder, a hand-edited row) is
    // treated as MOVED rather than as equal: recording a rotation that may not have happened is the
    // side that keeps the trail honest, and staying silent is the side that loses one.
    let stored: T | null = null;
    try {
      stored = decryptJson<T>(row.secret);
    } catch {
      stored = null;
    }
    await db.vaultEntry.updateMany({
      where: { id },
      data: { secret: encryptJson(after) },
    });
    const durableMoved =
      stored === null ||
      (stored.refreshToken ?? null) !== (after.refreshToken ?? null) ||
      scopeKey(stored.scopes) !== scopeKey(after.scopes);
    if (!durableMoved) return;
    const proj = auditProjection(row);
    await auditMutation(
      db,
      { ...ctx, userId: null, actorType: "system" },
      {
        action: "credential.update",
        target: formatVaultRef(id),
        before: markUndisclosed(proj),
        after: markUndisclosed(proj),
      },
    );
  });
}

export async function deleteVaultEntry(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    // NOTE: read before the delete with the row LOCKED, so the audit row describes the version
    // actually removed, and recorded only when this call removed it (`deleteMany` is idempotent, and
    // a retry must not repeat the removal on the trail).
    await db.$queryRaw`SELECT id FROM vault_entries WHERE id = ${id} FOR UPDATE`;
    const entry = await db.vaultEntry.findFirst({
      where: { id },
      select: VAULT_AUDIT_SELECT,
    });
    const { count } = await db.vaultEntry.deleteMany({ where: { id } });
    if (entry && count > 0) {
      await auditMutation(db, ctx, {
        action: "credential.delete",
        target: formatVaultRef(entry.id),
        before: auditProjection(entry),
      });
    }
  });
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
