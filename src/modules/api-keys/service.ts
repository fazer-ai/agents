import { z } from "zod";
import type { PrismaClient, UserRole } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { recordAudit } from "@/modules/audit/service";
import { generateApiKey } from "./verify";

// CRUD for ApiKey — per-tenant Bearer credentials for the REST v1 API and the MCP transport.
// ctx-based (mirrors the webhooks/vault services); the controller is a thin projection. RLS fences
// every read/write to the active tenant. The plaintext token is returned ONLY by createApiKey (once,
// at creation); listing exposes neither the hash nor the plaintext. TENANT_ADMIN-gated at the
// controller.
//
// NOTE: the AppError translationKeys thrown here (errors.apiKeyNotFound) are registered for the i18n
// extractor via a translate() magic comment in the controller (api-keys.controller.ts), since the API
// extractor only scans src/api.

// The key's authority is fixed at TENANT_ADMIN (fine-grained scopes deferred); see docs.
const FIXED_ROLE: UserRole = "TENANT_ADMIN";

export interface ApiKeyDto {
  id: string;
  displayName: string;
  keyPrefix: string;
  role: UserRole;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  displayName: true,
  keyPrefix: true,
  role: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

function toDto(row: {
  id: bigint;
  displayName: string;
  keyPrefix: string;
  role: UserRole;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): ApiKeyDto {
  return {
    id: row.id.toString(),
    displayName: row.displayName,
    keyPrefix: row.keyPrefix,
    role: row.role,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export async function listApiKeys(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<ApiKeyDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.apiKey.findMany({ select: SELECT, orderBy: { id: "desc" } }),
  );
  return rows.map(toDto);
}

export const apiKeyCreateSchema = z
  .object({ displayName: z.string().trim().min(1).max(120) })
  .strict();

export type ApiKeyCreate = z.infer<typeof apiKeyCreateSchema>;

// Returns the DTO plus the plaintext token, which is shown to the operator exactly once.
export interface CreatedApiKey {
  apiKey: ApiKeyDto;
  token: string;
}

export async function createApiKey(
  ctx: TenantContext,
  input: ApiKeyCreate,
  base: PrismaClient = basePrisma,
): Promise<CreatedApiKey> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const parsed = parseInput(apiKeyCreateSchema, input);
  const gen = generateApiKey();
  const row = await runScopedOn(base, ctx, async (db) => {
    const created = await db.apiKey.create({
      data: {
        tenantId,
        displayName: parsed.displayName,
        keyHash: gen.hash,
        keyPrefix: gen.prefix,
        role: FIXED_ROLE,
        createdByUserId: ctx.userId,
      },
      select: SELECT,
    });
    await recordAudit(db, tenantId, {
      actorId: ctx.userId,
      actorType: ctx.actorType,
      action: "api_key.create",
      target: created.id.toString(),
      after: {
        displayName: created.displayName,
        keyPrefix: created.keyPrefix,
        role: created.role,
      },
    });
    return created;
  });
  return { apiKey: toDto(row), token: gen.token };
}

// Soft-revoke (sets revokedAt). updateMany → count 0 for a foreign/missing id under RLS → NotFound
// (never a cross-tenant write). Re-revoking an already-revoked key is a no-op NotFound.
export async function revokeApiKey(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const count = await runScopedOn(base, ctx, async (db) => {
    const res = await db.apiKey.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count > 0) {
      await recordAudit(db, ctx.tenantId, {
        actorId: ctx.userId,
        actorType: ctx.actorType,
        action: "api_key.revoke",
        target: id.toString(),
      });
    }
    return res.count;
  });
  if (count === 0)
    throw new NotFoundError("api key not found", "errors.apiKeyNotFound");
}
