import { z } from "zod";
import type { PrismaClient, UserRole } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { recordAudit } from "@/modules/audit/service";
import { generateApiKey } from "./verify";

// CRUD for ApiKey — Bearer credentials for the REST v1 API and the MCP transport, in two scopes.
// ctx-based (mirrors the webhooks/vault services); the controller is a thin projection. A TENANT key
// is RLS-fenced to the active tenant on every read/write and TENANT_ADMIN-gated at the controller. A
// FLEET key (the `*FleetApiKey` half below) has no tenant. The plaintext token is returned ONLY by
// the create (once); listing exposes neither the hash nor the plaintext.
//
// NOTE: the AppError translationKeys thrown here (errors.apiKeyNotFound) are registered for the i18n
// extractor via a translate() magic comment in the controller (api-keys.controller.ts), since the API
// extractor only scans src/api.

// A tenant key's authority is fixed at TENANT_ADMIN, a fleet key's at SUPER_ADMIN (fine-grained
// scopes deferred); see docs.
const FIXED_ROLE: UserRole = "TENANT_ADMIN";
const FLEET_ROLE: UserRole = "SUPER_ADMIN";

export interface ApiKeyDto {
  id: string;
  displayName: string;
  keyPrefix: string;
  role: UserRole;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  // null for a key that predates the password rule: it still answers the step-up with its
  // creator's password, and the console marks it so the operator knows which key to rotate.
  stepUpAt: Date | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  displayName: true,
  keyPrefix: true,
  role: true,
  lastUsedAt: true,
  revokedAt: true,
  stepUpAt: true,
  createdAt: true,
} as const;

function toDto(row: {
  id: bigint;
  displayName: string;
  keyPrefix: string;
  role: UserRole;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  stepUpAt: Date | null;
  createdAt: Date;
}): ApiKeyDto {
  return {
    id: row.id.toString(),
    displayName: row.displayName,
    keyPrefix: row.keyPrefix,
    role: row.role,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    stepUpAt: row.stepUpAt,
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

// The caller has answered the password step-up before calling here (the two minting routes do, and
// they are the only callers): the row records the moment, and that record is what lets the key
// answer every later step-up by itself (`confirmStepUp`). A row written without it is a key that
// predates the rule, and keeps answering with its creator's password.
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
        stepUpAt: new Date(),
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

// The half of `revokeApiKey` that decides whether there is anything to revoke: a key this tenant
// can see, not already revoked. Same rule as the `updateMany` below, asked ahead of the write so
// the MCP preview refuses exactly where the apply refuses (#490).
export async function assertApiKeyRevocable(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const found = await runScopedOn(base, ctx, (db) =>
    db.apiKey.findFirst({
      where: { id, revokedAt: null },
      select: { id: true },
    }),
  );
  if (!found)
    throw new NotFoundError("api key not found", "errors.apiKeyNotFound");
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

// ── fleet-scoped keys (issue #308) ──
//
// A fleet key is the same row with no tenant and SUPER_ADMIN, the shape `users` gives a SUPER_ADMIN,
// which is what lets the request boundary treat the principal it resolves to exactly like a
// SUPER_ADMIN session (the tenant is chosen per request). Everything below follows from the NULL:
// the row is never in a tenant's list and never reachable by the tenant revoke, because RLS hides it
// from tenant scope; the fleet functions run cross-tenant and gate on the caller's ROLE, ignoring
// whatever tenant the caller has selected (a SUPER_ADMIN in the console always has one, and the key
// is not its); and the trail is fleet-level (tenant NULL), like `tenant.create`, because a row keyed
// on the selected tenant would file the deployment's master credential under a stranger's history.

function requireFleet(ctx: TenantContext): void {
  if (ctx.role !== "SUPER_ADMIN") throw new ForbiddenError();
}

export async function listFleetApiKeys(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<ApiKeyDto[]> {
  requireFleet(ctx);
  const rows = await asSuperAdminOn(base, (db) =>
    db.apiKey.findMany({
      where: { tenantId: null },
      select: SELECT,
      orderBy: { id: "desc" },
    }),
  );
  return rows.map(toDto);
}

export async function createFleetApiKey(
  ctx: TenantContext,
  input: ApiKeyCreate,
  base: PrismaClient = basePrisma,
): Promise<CreatedApiKey> {
  requireFleet(ctx);
  const parsed = parseInput(apiKeyCreateSchema, input);
  const gen = generateApiKey();
  const row = await asSuperAdminOn(base, async (db) => {
    const created = await db.apiKey.create({
      data: {
        tenantId: null,
        displayName: parsed.displayName,
        keyHash: gen.hash,
        keyPrefix: gen.prefix,
        role: FLEET_ROLE,
        createdByUserId: ctx.userId,
        // Under step-up, like the tenant mint: see `createApiKey`.
        stepUpAt: new Date(),
      },
      select: SELECT,
    });
    await recordAudit(db, null, {
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

// `tenantId: null` in the where is the fence: a tenant key keeps its tenant's revoke and its
// tenant's trail, so the fleet path answers NotFound for it the way the tenant path does for a
// fleet key.
export async function revokeFleetApiKey(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  requireFleet(ctx);
  const count = await asSuperAdminOn(base, async (db) => {
    const res = await db.apiKey.updateMany({
      where: { id, tenantId: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count > 0) {
      await recordAudit(db, null, {
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
