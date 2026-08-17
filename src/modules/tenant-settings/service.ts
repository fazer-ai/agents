import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { tryResolveVaultEntry } from "@/modules/vault/service";

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

// ── ctx-based REST surface (TENANT_ADMIN) ──

export interface TenantSettingsDto {
  embedding: EmbeddingSettings;
  langfuse: LangfuseSettings;
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
    };
  });
}

async function writeBlock(
  ctx: TenantContext,
  base: PrismaClient,
  key: "embedding" | "langfuse",
  value: EmbeddingSettings | LangfuseSettings,
): Promise<void> {
  const tenantId = requireTenantId(ctx);
  await runScopedOn(base, ctx, async (db) => {
    const raw = await readRawSettings(db, tenantId);
    const next = { ...raw, [key]: value };
    await db.tenant.update({
      where: { id: tenantId },
      data: { settings: next as Prisma.InputJsonValue },
    });
  });
}

export async function updateEmbeddingSettings(
  ctx: TenantContext,
  patch: Partial<EmbeddingSettings>,
  base: PrismaClient = basePrisma,
): Promise<EmbeddingSettings> {
  const tenantId = requireTenantId(ctx);
  const current = await runScopedOn(base, ctx, (db) =>
    readEmbeddingSettings(db, tenantId),
  );
  // LOCKED to EMBEDDING_DEFAULTS (OpenAI + text-embedding-3-small) until the flexible-embeddings
  // feature ships (configurable dimension + provider registry). Only the
  // credential is honored; provider/model/baseURL from the patch are ignored. Unlocking = restore
  // the `{ ...current, ...patch }` merge.
  const merged = embeddingSettingsSchema.parse({
    ...EMBEDDING_DEFAULTS,
    credentialRef:
      patch.credentialRef !== undefined
        ? patch.credentialRef
        : current.credentialRef,
  });
  await writeBlock(ctx, base, "embedding", merged);
  return merged;
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
  const tenantId = requireTenantId(ctx);
  const current = await runScopedOn(base, ctx, (db) =>
    readLangfuseSettings(db, tenantId),
  );

  let credentialRef = current.credentialRef;
  if (input.credentialRef !== undefined) {
    if (input.credentialRef === null) {
      credentialRef = null;
    } else {
      // Validate: ref must resolve and be a langfuse-kind entry.
      const entry = await runScopedOn(base, ctx, (db) =>
        tryResolveVaultEntry(db, input.credentialRef as string),
      );
      if (!entry) {
        throw new AppError(
          "credential ref not found in the vault",
          400,
          "errors.vaultRefNotFound",
        );
      }
      if (entry.kind !== "langfuse") {
        throw new AppError(
          "credential must be of kind 'langfuse'",
          400,
          "errors.invalidCredentialKind",
        );
      }
      credentialRef = input.credentialRef;
    }
  }

  const merged = langfuseSettingsSchema.parse({
    enabled: input.enabled ?? current.enabled,
    credentialRef,
    sendContent: input.sendContent ?? current.sendContent,
    debug: input.debug ?? current.debug,
  });
  await writeBlock(ctx, base, "langfuse", merged);
  return merged;
}
