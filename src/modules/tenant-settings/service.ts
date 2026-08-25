import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { unprintableProblem } from "@/modules/documents/printable";
import { requireVaultRef, vaultRefWhere } from "@/modules/vault/service";

// Per-tenant settings live in the Tenant.settings JSON column. RLS scopes the row to the active
// tenant (the runtime role may read/update its own row), so the same reader works at runtime
// (rag/observability) and behind the TENANT_ADMIN REST surface. Each feature owns a named block;
// readers tolerate an absent/invalid block by falling back to defaults so a missing block never
// throws. Credentials are referenced by `vault:<id>` here too — secret VALUES never enter settings
// (that JSON column is not encrypted); only the vault reference does.

export const embeddingSettingsSchema = z.object({
  // NOTE: provider/model/baseURL are currently PINNED to EMBEDDING_DEFAULTS (OpenAI +
  // text-embedding-3-small) by updateEmbeddingSettings — only the credential is configurable. The
  // fields stay in the schema so unlocking later (flexible dimensions + provider registry) is
  // purely additive. Dimensionality is the pgvector column width (1536).
  provider: z.enum(["openai", "openai_compatible"]),
  model: z.string().min(1).max(200),
  credentialRef: z.string().min(1).max(200).nullable(),
  baseURL: z.string().url().nullable(),
});
export type EmbeddingSettings = z.infer<typeof embeddingSettingsSchema>;

export const EMBEDDING_DEFAULTS: EmbeddingSettings = {
  provider: "openai",
  model: "text-embedding-3-small",
  credentialRef: null,
  baseURL: null,
};

export const langfuseSettingsSchema = z.object({
  enabled: z.boolean(),
  // Vault ref of a `langfuse`-kind secret holding { publicKey, secretKey } (never inline here).
  // The baseUrl is stored on the vault entry itself, not in this settings block.
  credentialRef: z.string().min(1).max(200).nullable(),
  // Opt-in to sending raw prompt/completion content to Langfuse (default redacts it).
  sendContent: z.boolean(),
  // Debug mode: also send the full tool schemas to every trace (heavy; off by default). Tool names
  // always travel regardless of this flag.
  debug: z.boolean(),
});
export type LangfuseSettings = z.infer<typeof langfuseSettingsSchema>;

export const LANGFUSE_DEFAULTS: LangfuseSettings = {
  enabled: false,
  credentialRef: null,
  sendContent: false,
  debug: false,
};

// The tenant's own identity as it appears on a document it issues: the letterhead. Lives here
// rather than in a table of its own because it is a singleton per tenant — the exact shape
// Tenant.settings exists for — and because the render path already reads the tenant row, so a
// letterhead costs no extra query. It holds no secret, so the vault rule above does not apply.
//
// The logo is the one part that is NOT here: bytes do not belong in a JSON column, so this keeps the
// file name and the bytes live on disk. Same split as branding.
export const companySettingsSchema = z.object({
  name: z.string().max(200),
  document: z.string().max(40),
  address: z.string().max(300),
  phone: z.string().max(40),
  email: z.string().max(200),
  website: z.string().max(200),
  logoKey: z.string().max(200).nullable(),
  // Bumped on every logo write. The key alone cannot say the logo CHANGED: it is derived from the
  // tenant id and the file extension, so replacing a PNG with another PNG produces the same key —
  // and everything downstream that keys off it (the console's blob, the browser's own cache of a
  // response served with max-age) goes on showing the old letterhead while new documents render the
  // new one.
  logoVersion: z.number().int().nonnegative(),
});
export type CompanySettings = z.infer<typeof companySettingsSchema>;

export const COMPANY_DEFAULTS: CompanySettings = {
  name: "",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: null,
  logoVersion: 0,
};

export function parseCompanySettings(settings: unknown): CompanySettings {
  const block = (settings as Record<string, unknown> | null | undefined)
    ?.company;
  const parsed = companySettingsSchema.partial().safeParse(block ?? {});
  return { ...COMPANY_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

export function parseEmbeddingSettings(settings: unknown): EmbeddingSettings {
  const block = (settings as Record<string, unknown> | null | undefined)
    ?.embedding;
  const parsed = embeddingSettingsSchema.partial().safeParse(block ?? {});
  return { ...EMBEDDING_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

export function parseLangfuseSettings(settings: unknown): LangfuseSettings {
  const block = (settings as Record<string, unknown> | null | undefined)
    ?.langfuse;
  const parsed = langfuseSettingsSchema.partial().safeParse(block ?? {});
  return { ...LANGFUSE_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

function requireTenantId(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  return ctx.tenantId;
}

async function readRawSettings(
  db: ScopedDb,
  tenantId: bigint,
): Promise<Record<string, unknown>> {
  const row = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  return (row?.settings ?? {}) as Record<string, unknown>;
}

// ── in-scope readers (callers already inside runScopedOn with the tenant's role) ──

export async function readEmbeddingSettings(
  db: ScopedDb,
  tenantId: bigint,
): Promise<EmbeddingSettings> {
  return parseEmbeddingSettings(await readRawSettings(db, tenantId));
}

export async function readLangfuseSettings(
  db: ScopedDb,
  tenantId: bigint,
): Promise<LangfuseSettings> {
  return parseLangfuseSettings(await readRawSettings(db, tenantId));
}

export async function readCompanySettings(
  db: ScopedDb,
  tenantId: bigint,
): Promise<CompanySettings> {
  return parseCompanySettings(await readRawSettings(db, tenantId));
}

// ── ctx-based REST surface (TENANT_ADMIN) ──

export interface TenantSettingsDto {
  embedding: EmbeddingSettings;
  langfuse: LangfuseSettings;
  company: CompanySettings;
}

export async function getTenantSettings(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<TenantSettingsDto> {
  const tenantId = requireTenantId(ctx);
  return runScopedOn(base, ctx, async (db) => {
    const raw = await readRawSettings(db, tenantId);
    return {
      embedding: parseEmbeddingSettings(raw),
      langfuse: parseLangfuseSettings(raw),
      company: parseCompanySettings(raw),
    };
  });
}

// Read, merge and write in ONE transaction, with the tenant row locked.
//
// Every settings block lives in a single JSON column, so this is a read-modify-write of a value
// several writers share — the two halves of the company profile most visibly, since the console
// edits its text fields and uploads its logo through different routes. Reading in one transaction
// and writing in another lets two writers each merge into the value they read and the later commit
// discard the earlier one: a profile save that erases the logo which finished uploading a moment
// before, with both requests answering success.
//
// The merge runs INSIDE the lock and is handed the raw settings, so what it merges into is what is
// about to be written and never a snapshot from before someone else's write.
async function patchBlock<
  T extends EmbeddingSettings | LangfuseSettings | CompanySettings,
>(
  ctx: TenantContext,
  base: PrismaClient,
  key: "embedding" | "langfuse" | "company",
  // May be async, so a caller that has to read or do something UNDER THE LOCK, before the commit,
  // can do it here. The logo upload is the one: it needs the key it is about to supersede, and the
  // block it reads outside the lock is already stale by the time it writes.
  merge: (raw: Record<string, unknown>) => T | Promise<T>,
): Promise<T> {
  const tenantId = requireTenantId(ctx);
  return runScopedOn(base, ctx, async (db) => {
    await db.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${tenantId} FOR UPDATE`;
    const raw = await readRawSettings(db, tenantId);
    const value = await merge(raw);
    await db.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...raw, [key]: value } as Prisma.InputJsonValue },
    });
    return value;
  });
}

export async function updateEmbeddingSettings(
  ctx: TenantContext,
  patch: Partial<EmbeddingSettings>,
  base: PrismaClient = basePrisma,
): Promise<EmbeddingSettings> {
  // The same boundary every other ref column has been held to since #124: `vault:<id>`, in this
  // tenant, canonically spelled. Nothing checked this one, so a PATCH carrying a vault entry NAME
  // stored it and indexing then failed with no credential the operator could see was wrong (#254).
  // The block holds one field, so naming it IS changing it — there is no unrelated save to protect
  // here, unlike the agent's bags.
  const incoming = patch.credentialRef;
  const credentialRef =
    incoming == null
      ? incoming
      : await runScopedOn(base, ctx, (db) =>
          requireVaultRef(db, incoming, "embedding.credentialRef"),
        );
  return patchBlock(ctx, base, "embedding", (raw) => {
    const current = parseEmbeddingSettings(raw);
    // LOCKED to EMBEDDING_DEFAULTS (OpenAI + text-embedding-3-small) until the flexible-embeddings
    // feature ships (configurable dimension + provider registry). Only the
    // credential is honored; provider/model/baseURL from the patch are ignored. Unlocking = restore
    // the `{ ...current, ...patch }` merge.
    // not-caller-input: the STORED block merged with the patch, so a failure here is not necessarily the caller's
    return embeddingSettingsSchema.parse({
      ...EMBEDDING_DEFAULTS,
      credentialRef:
        credentialRef !== undefined ? credentialRef : current.credentialRef,
    });
  });
}

export interface LangfuseUpdateInput {
  enabled?: boolean;
  // When provided as a non-null string, must be a `vault:<id>` ref resolving to a `langfuse`-kind
  // entry. null clears the credential (disabling tracing even if enabled=true). Absent = keep current.
  credentialRef?: string | null;
  sendContent?: boolean;
  debug?: boolean;
}

// Updates the langfuse block. credentialRef, when provided non-null, is validated against the vault
// (must exist and be kind "langfuse"). null clears it.
export async function updateLangfuse(
  ctx: TenantContext,
  input: LangfuseUpdateInput,
  base: PrismaClient = basePrisma,
): Promise<LangfuseSettings> {
  requireTenantId(ctx);
  // Only to VALIDATE the incoming ref; the value that gets written is chosen inside the lock below.
  // Read here and written back, an omitted credentialRef would carry a pre-lock snapshot over a
  // credential someone else changed in between — undoing a successful update with a request that
  // never mentioned it.
  let credentialRef: string | null = null;
  if (input.credentialRef !== undefined) {
    if (input.credentialRef === null) {
      credentialRef = null;
    } else {
      // Validate: ref must resolve, in this tenant, and be a langfuse-kind entry.
      // NOTE: requireVaultRef rather than tryResolveVaultEntry, which answered "not found" for two
      // values that are something else. A lenient spelling (`vault:007`) resolved and was then
      // stored verbatim, where it compares unequal against the id list the credential picker builds
      // and reports a working credential as unavailable; and an entry created empty on purpose
      // (credential_create) was refused for having no secret yet, which is the one case the write
      // boundary admits deliberately. Both are the ref rule, so both answer to the ref check (#254).
      const ref = input.credentialRef;
      credentialRef = await runScopedOn(base, ctx, async (db) => {
        const canonical = await requireVaultRef(
          db,
          ref,
          "langfuse.credentialRef",
        );
        const entry = await db.vaultEntry.findFirst({
          where: vaultRefWhere(canonical),
          select: { kind: true },
        });
        if (entry?.kind !== "langfuse") {
          throw new AppError(
            "credential must be of kind 'langfuse'",
            400,
            "errors.invalidCredentialKind",
            { kind: "langfuse" },
            "langfuse.credentialRef",
          );
        }
        return canonical;
      });
    }
  }

  return patchBlock(ctx, base, "langfuse", (raw) => {
    const live = parseLangfuseSettings(raw);
    // not-caller-input: the STORED block merged with the patch, so a failure here is not necessarily the caller's
    return langfuseSettingsSchema.parse({
      enabled: input.enabled ?? live.enabled,
      // The live value when this request did not mention one, like every other field here.
      credentialRef:
        input.credentialRef !== undefined ? credentialRef : live.credentialRef,
      sendContent: input.sendContent ?? live.sendContent,
      debug: input.debug ?? live.debug,
    });
  });
}

export type CompanyUpdateInput = Partial<
  Omit<CompanySettings, "logoKey" | "logoVersion">
>;

// Patch-merged, never replaced: the console edits one field at a time and the MCP write sends only
// what changed. logoKey is deliberately not settable here — it is written by the upload path, which
// is the only place that knows a file with that name actually exists.
export async function updateCompanySettings(
  ctx: TenantContext,
  patch: CompanyUpdateInput,
  base: PrismaClient = basePrisma,
): Promise<CompanySettings> {
  // This block is the letterhead every issued document carries — it exists for no other purpose —
  // so it is held to what a document can print. The PDF fonts cover Latin text, and a character
  // outside that comes out as a DIFFERENT one (see documents/printable.ts): a trade name would be
  // misspelled on every document the tenant ever issues, and nobody would see it happen.
  for (const [field, value] of Object.entries(patch)) {
    if (typeof value !== "string") continue;
    const problem = unprintableProblem(value, field);
    if (problem)
      throw new AppError(
        problem,
        400,
        "errors.invalidCompanyField",
        { reason: problem },
        // NOTE: the key of the patch, which is the name the console's company form uses for the input.
        field,
      );
  }
  return patchBlock(ctx, base, "company", (raw) =>
    // not-caller-input: the STORED block merged with the patch; the patch's own fields are refused above with errors.invalidCompanyField
    companySettingsSchema.parse({ ...parseCompanySettings(raw), ...patch }),
  );
}

// Run work under the same per-tenant lock the writers take, with the current company block in hand.
//
// For DELETING A LOGO FILE, which is the one thing that happens after its own transaction is over:
// by then the lock is gone and the key that looked unreferenced may have been re-adopted — two
// cross-format uploads racing, or a clear followed immediately by an upload. Under this lock, the
// committed block answers "is anything pointing at this file?" without a write landing between the
// answer and the delete.
export async function withCompanyLock<T>(
  ctx: TenantContext,
  base: PrismaClient,
  fn: (current: CompanySettings) => Promise<T>,
): Promise<T> {
  const tenantId = requireTenantId(ctx);
  return runScopedOn(base, ctx, async (db) => {
    await db.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${tenantId} FOR UPDATE`;
    return fn(await readCompanySettings(db, tenantId));
  });
}

// Written only by the logo upload/clear path, after the bytes are on disk (or gone from it). The
// version moves with every write, including a replacement that lands on the same key.
export async function setCompanyLogoKey(
  ctx: TenantContext,
  logoKey: string | null,
  base: PrismaClient = basePrisma,
  now: number = Date.now(),
  // Runs INSIDE the per-tenant lock, before the row is written, and is handed the block as it stands
  // there — the only reading of it that is not already stale. The logo upload uses it to learn which
  // file this write supersedes, so it can drop that file once the row commits. Throwing from it
  // aborts the write.
  publish?: (current: CompanySettings) => Promise<void>,
): Promise<CompanySettings> {
  return patchBlock(ctx, base, "company", async (raw) => {
    const current = parseCompanySettings(raw);
    await publish?.(current);
    // not-caller-input: the STORED block merged with the patch, so a failure here is not necessarily the caller's
    return companySettingsSchema.parse({
      ...current,
      logoKey,
      // Strictly increasing even if two writes land in the same millisecond, which is what a cache
      // buster has to be to mean anything.
      logoVersion: Math.max(now, current.logoVersion + 1),
    });
  });
}
