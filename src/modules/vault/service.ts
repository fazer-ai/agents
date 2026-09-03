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

// The id a STORED ref names, by the reader's rule rather than the writer's.
//
// The two rules are deliberately different and this is the one place that says why. `requireVaultRef`
// refuses everything but the canonical spelling on the way IN, so a column holds one form. A reader
// still has to resolve what is already there: refs predate that rule, and `canonicalVaultRef`
// (src/client/lib/credentialRef.ts) states the contract every resolver keeps — `vault:0007`,
// `vault: 7` and `vault:7` are the same entry. Reading strictly would report a working credential as
// missing and silently switch a model or an integration off after an upgrade.
//
// What it does NOT tolerate is a value no `bigint` column can hold. `BigInt` is arbitrary precision,
// so `vault:<digits past 2^63-1>` converts and reaches Postgres as a bind error — a 500 out of a
// resolver whose contract is to answer "no such entry". Lenient about SPELLING, bounded by RANGE.
//
// One function because it was eight, and none of them agreed: four spelled the prefix as a literal
// `"vault:"`, three could throw where their caller expected a null, and every one of them was
// missing the bound. Issue #407.
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

// The one form of a STORED ref that is safe to hand to a reader, or null when the stored value does
// not name an entry at all.
//
// Every ref column was guarded by `requireVaultRef` on all of its writers in one commit (#126, and
// the two `secretRef` columns are the measured case); before it the schema was
// `z.string().min(1).max(128)` and the value went in verbatim. So a row can hold arbitrary text — an
// API caller who read the field name as "the secret" and typed one in put it there — and a projection
// that echoes the column publishes it to every reader of that projection, which is exactly what the
// promise "the signing secret never leaves the vault" says cannot happen.
//
// What it proves is that the value IS a reference — the prefix plus an in-range integer — and not that
// the entry exists. That distinction is deliberate, and it is why the guard can stay a pure function.
// A ref whose entry was DELETED still comes back, so the picker can say "Credential unavailable" and
// the operator learns what happened; verifying existence would replace that with silence and put a
// tenant-scoped query inside every projection, including the ones that run in an audit transaction.
//
// The bound is what makes that safe rather than merely cheap: the output is never the stored string.
// It is `vault:` plus the DECIMAL rendering of a parsed BigInt in [0, MAX_DB_ID], so `vault:0x1F4`
// leaves as `vault:500` and everything an HMAC secret actually looks like — hex, base64, `sha256=…`,
// any bare name — reads as null. Reaching the remaining sliver takes a stored value of the form
// `vault:<digits>`, which is reference syntax: someone writing a raw secret writes the secret, not the
// prefix. (Review round 5 read this as a secret-disclosure path; the table in
// `tests/modules/alert-channel-secret-roundtrip.test.ts` is the measurement.)
//
// Canonical rather than verbatim for the values it DOES read: `vault: 7`, `vault:0007` and `vault:0x7`
// all name entry 7, and echoing the stored spelling would hand a client back something
// `requireVaultRef` refuses on the way in — a rename turned into an unsavable form.
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

export type VaultEntryResolution<T> =
  | { state: "filled"; entry: ResolvedVaultEntry<T> }
  | { state: "pending" }
  | { state: "not_found" };

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
      baseUrl: entry.baseUrl,
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
    baseUrl: entry.baseUrl,
    paramName: entry.paramName,
    name: entry.name,
  };
}

// The secret comes back as `unknown` and the generic parameter is gone ON PURPOSE. It used to
// default to `unknown` and be spelled `<string>` at ten call sites, where it was not a check but an
// assertion: `decryptJson<T>` casts, so a `google_oauth` entry's `{ clientId, clientSecret }` was
// typed `string` all the way into `createChatModel` (issue #471). Callers that need a string now say
// so through `tryResolveApiKeyEntry`, or narrow it themselves; the six that already narrowed keep
// compiling unchanged, and the ten that did not could not be missed, because the compiler is what
// found them.
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
    baseUrl: entry.baseUrl,
    paramName: entry.paramName,
    name: entry.name,
  };
}

// The same resolution for a field that reads a PLAIN API KEY and hands it to somebody else's SDK —
// the agent's model and its four model overrides, STT, TTS and vision. Three outcomes rather than
// two, because the operator's move differs and the log line that names it is the only trace any of
// these leave: a ref that no longer resolves is a credential to re-pick or fill, and one that
// resolves to the wrong KIND is a credential that belongs on another field.
//
// The shape check is belt AND braces on the kind check, and neither is redundant. The kind is the
// catalog's declaration; the value is what is actually stored, and the two can disagree — a legacy
// entry created before the kind existed, or a managed blob whose connect flow never ran.
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
  return { state: "ok", secret: entry.secret, baseUrl: entry.baseUrl };
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
  // The server's own name for the input this ref arrived in — a column (`credentialRef`) or a dotted
  // path into a bag it owns (`settings.tts.normalizeCredentialRef`). See src/api/lib/refusal.ts.
  //
  // REQUIRED, and that is the whole guard: every caller here already holds the name, and eleven of
  // the thirteen were still omitting it. The argument for optional was that most callers "refuse a
  // column the client already named in the patch it sent" — but what the client SENT and what the
  // server REFUSED are different questions, which is the premise of #231. An integrations write
  // carries `credentialRef` and `inboundSecretRef` in one body; a tool write carries `credentialRef`
  // among sixteen keys. A refusal with no field is unplaceable by any form, however well wired.
  //
  // A required parameter and not a sweep: the omission is invisible at every call site, so the type
  // is the only reader that sees the next one. Issue #320.
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

// `requireVaultRef` plus the question it never asked: can an entry of THIS KIND supply what the
// field reads? The two are separate functions rather than one parameter because the ref rule reaches
// thirteen call sites and this one does not: four of them (langfuse, the two integration credentials,
// and the webhook/alert signing secrets) answer a THIRD question — a fixed kind, or a string consumed
// locally and never sent anywhere — and folding those into the two-value `CredentialUse` would have
// meant inventing a use for each just to satisfy a required parameter. What this covers is the fields
// whose use is already declared: the agent's nine (SETTINGS_CREDENTIAL_PATHS + modelConfig) and the
// tenant's embedding key. Issue #471.
//
// The field is in the English sentence as well as in `AppError.field`, which is a duplication the
// other vault refusals do not carry. MCP hands `message` to the caller verbatim on a surface with no
// structured error channel, and `agent_settings_set` patches several credentialled blocks in one
// call: without the path, "credential vault:32 cannot serve this field" names no field to fix.
//
// Refused rather than reported, and that is the split `credential-paths.ts` already documents: the
// operator is at the keyboard and the reference is the thing they just picked. What is ALREADY stored
// is left alone and reported by config-health, so one unusable pairing cannot freeze every other
// edit of the agent that holds it.
// Decrypts a stored blob far enough to answer "is this the shape its kind declares?", and never
// further: the value is judged and dropped, never returned or logged.
//
// THREE answers, not two, and the third is the one that matters. A blob that cannot be decrypted at
// all — a rotated `ENCRYPTION_KEY`, a truncated row — is not a malformed value, it is a value nobody
// can read, and collapsing it into "unfit" would make a key rotation refuse every agent write in the
// workspace while blaming the credential's TYPE for it. That is a real problem with a different
// cause, a different fix and no verdict here today; this change is about shape, and inventing an
// answer for it would be inventing a diagnosis. So `unreadable` never refuses and never warns, and
// the runtime keeps failing on it exactly as it did before.
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
}

export async function readVaultRefFacts(
  db: ScopedDb,
  ref: string,
): Promise<VaultEntryFacts | null> {
  const row = await db.vaultEntry.findFirst({
    where: vaultRefWhere(ref),
    select: { kind: true, status: true, secret: true },
  });
  if (!row) return null;
  return {
    kind: row.kind,
    valueFitsKind:
      row.status === "pending" || vaultValueFits(row.kind, row.secret),
  };
}

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
  // TWO questions, because the runtime asks two and a boundary that asks fewer accepts a
  // configuration the turn then refuses — with config-health calling it healthy in between, which is
  // the exact asymmetry this change exists to remove. The kind is the catalog's declaration; the
  // value is what is in the row, and `validateVaultValue` is not the only way one gets written.
  //
  // A PENDING entry is exempt from the value half and only from that half: it has no secret yet by
  // design (`credential_create` writes exactly that), and refusing it would break the reference-first
  // flow the write boundary admits deliberately. Its KIND is already knowable and is still checked.
  // A PENDING entry has no value yet by design (`credential_create` writes exactly that), so it is
  // reported as `valueFitsKind` and judged on its KIND alone — the one exemption, and only on the
  // value half. Refusing it would break the reference-first flow the write boundary admits on purpose.
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

// The catalog declares WHICH kinds read a param name (`needsParamName`), and until issue #488 this
// only enforced half of that: required where declared, and accepted-then-ignored everywhere else.
// The field is read in exactly one place (`resolveSecretInjection`, off a `needsParamName` entry),
// so a name stored on any other kind is a name nothing will ever send — the operator configures an
// `Authorization` header, the write answers 200, the console reads it back, and the request goes
// out with no credential on it. Refusing is the only half that reaches them: whoever gets this
// picked the kind, and the fix is to pick one that injects (that is what the sentence names).
//
// Empty stays empty: "" has always meant "no param name", and refusing it would break a client that
// sends the field unconditionally.
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
// What a credential's audit row carries, and what it only compares.
//
// This is the family where the metadata and the thing that authenticates are adjacent columns, so
// the two halves are drawn tightly. PROJECTED: the identity (`id`, `name`), the type, the lifecycle
// and the two fields that say how the credential is used. `baseUrl` is an operator-typed URL and
// reaches the row as its ORIGIN, by the same rule every such URL answers to (`redactEndpoint`): a
// self-hosted API root is exactly the kind of destination that carries a token in its path, and this
// row is append-only and outlives the entry.
//
// UNDISCLOSED, compared and never carried: the `secret` itself, and the whole `baseUrl` so a change
// living in the path is still recorded as a change.
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
        "name",
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
        select: VAULT_AUDIT_SELECT,
      });
      // NOTE: The same action as a filled create, because it is the same act: a credential now
      // exists under this name. `status` is what tells the two apart, and it is on the row.
      //
      // This is also where the agent import starts leaving a trail. It creates one reference-only
      // entry per credential the bundle names and the tenant does not have, and its own `agent.import`
      // row projects the AGENT, so six pending credentials used to appear in the vault with nothing
      // naming where they came from. One row each, under the operator who ran the import.
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
    // NOTE: The action with no name on any transport before #444: replacing the value behind a live
    // reference. Every consumer of that reference starts authenticating with something else on the
    // next call, and nothing said so.
    //
    // The marker rather than the value, on both sides, because what a reader needs is that the
    // secret moved. `undisclosedMoved` is what the write is gated on, never the marker: two
    // identical markers move nothing, so gating on `projectionMoved` alone would drop the one row
    // that matters most here, the save whose ONLY change was the credential itself.
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

// Replace the secret behind an existing entry, recording it like any other credential edit.
//
// The OAuth flows write `vaultEntry.secret` themselves — connecting merges the tokens in,
// disconnecting strips them back out — and they are operator actions on a credential like any
// other. Reaching the column directly is what left them off the trail: this is the same write, with
// the seam around it, so the row says a credential moved without saying what it moved to.
//
// The value is never projected. `credential.update` carries the marker and the metadata, exactly as
// the console's own edit does.
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

// The refresh path's write, with the seam around it and a gate the other secret writes do not have.
//
// A token refresh IS a write to `vault_entries.secret`, so `replaceVaultSecret` above would take it
// unchanged, and that is exactly what must not happen: an access token expires hourly and is renewed
// by USE, not by a decision, so routing it through there puts a row into an append-only table every
// hour per connected credential, and the operator's own edits drown in machine bookkeeping. This
// family already answered that question once in the other direction (#395: the Channels page
// auto-syncs on load, so an unconditional `instance.sync_inboxes` recorded a row per account per
// visit, and the fix was to record only what actually moved).
//
// What moved is the line. An access token is a DERIVED, short-lived artifact of the credential; the
// refresh token and the granted scopes ARE the credential. A refresh token rotating replaces the
// durable secret and revokes the old one, and scopes changing under a refresh means the grant itself
// changed upstream — both are things an operator would want to find in the trail, and neither is
// hourly. The access token moving on its own is not, and gets no row.
//
// `system` and a null actor, for the same reason /reset's rows are (#398): the refresh is triggered
// by a clock and a use, and the principal whose request happened to notice the expiry did not rotate
// anything. Left on `ctx` the row would name a person who did not act.
export async function persistRefreshedOAuthSecret<
  T extends { refreshToken?: string | null; scopes?: string[] | null },
>(
  ctx: TenantContext,
  id: bigint,
  before: T,
  after: T,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const scopeKey = (v: string[] | null | undefined) =>
    JSON.stringify([...(v ?? [])].sort());
  const durableMoved =
    (before.refreshToken ?? null) !== (after.refreshToken ?? null) ||
    scopeKey(before.scopes) !== scopeKey(after.scopes);
  await runScopedOn(base, ctx, async (db) => {
    const row = durableMoved
      ? await db.vaultEntry.findFirst({
          where: { id },
          select: VAULT_AUDIT_SELECT,
        })
      : null;
    await db.vaultEntry.updateMany({
      where: { id },
      data: { secret: encryptJson(after) },
    });
    if (!row) return;
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
    // NOTE: Read before the delete with the row LOCKED, so the row describes the version actually
    // removed: an update committing between the read and the delete would otherwise leave the trail
    // describing the credential as it was two saves ago. And only recorded when this call is the one
    // that removed it:
    // `deleteMany` is idempotent by design, and a row per attempt would put the same removal on the
    // trail as many times as it was retried. Creating a credential was audited and removing one was
    // not, which is the asymmetry #444 opened with.
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
