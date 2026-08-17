import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, UserRole } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn } from "@/lib/tenancy";

// Bearer API key for the REST v1 API and the MCP transport. The plaintext is `fazerai_<base64url>`
// (256-bit); only its SHA-256 hash is stored (ApiKey.keyHash, unique), so a DB dump never yields a
// usable key and lookup is a constant-time B-tree probe on the hash. Verified BEFORE the tenant is
// known, so the hash lookup runs as super admin (the key row carries its own tenantId; RLS still
// fences every downstream tenant query). `role` is fixed on the key (NOT re-derived from the
// creator's current role); revocation is the soft `revokedAt`. Never log the plaintext.

export const API_KEY_PREFIX = "fazerai_";
// Compatibility window for the brand rename: keys minted before it carry `secv4_`. The stored hash
// covers the WHOLE token, so an already-issued key keeps verifying byte for byte — only this
// startsWith guard has to know the old marker. Dropped at 2.0.
export const LEGACY_API_KEY_PREFIX = "secv4_";
const LAST_USED_THROTTLE_MS = 60_000;

// A token that carries neither marker cannot be one of ours: reject before touching the DB.
export function hasApiKeyPrefix(token: string): boolean {
  return (
    token.startsWith(API_KEY_PREFIX) || token.startsWith(LEGACY_API_KEY_PREFIX)
  );
}

export interface GeneratedApiKey {
  token: string;
  hash: string;
  prefix: string;
}

export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const token = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  // Display prefix: the brand marker + the first 6 random chars — enough to disambiguate a key in a
  // list without revealing the secret.
  return {
    token,
    hash: hashApiKey(token),
    prefix: token.slice(0, API_KEY_PREFIX.length + 6),
  };
}

export interface ApiKeyPrincipal {
  apiKeyId: bigint;
  // The creator's user id, used as the principal's userId for audit attribution.
  userId: bigint;
  tenantId: bigint;
  role: UserRole;
}

// Resolves a Bearer API key to its principal, or null (caller maps null → 401). Never throws on a
// bad key. Touches lastUsedAt at most once per throttle window (fire-and-forget, never blocking).
export async function verifyApiKey(
  token: string,
  base: PrismaClient = basePrisma,
): Promise<ApiKeyPrincipal | null> {
  if (!hasApiKeyPrefix(token)) return null;
  const keyHash = hashApiKey(token);
  const resolved = await asSuperAdminOn(base, async (db) => {
    const k = await db.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        tenantId: true,
        role: true,
        createdByUserId: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    });
    // Reject: unknown hash, revoked, or no recorded creator (always set at create → a row without
    // one is malformed). createdByUserId becomes the principal's userId for audit attribution.
    if (!k || k.revokedAt || k.createdByUserId === null) return null;
    // Reject keys whose tenant no longer exists (deleted tenant → 401, not a silent empty result).
    const tenant = await db.tenant.findUnique({
      where: { id: k.tenantId },
      select: { id: true },
    });
    if (!tenant) return null;
    return {
      id: k.id,
      tenantId: k.tenantId,
      role: k.role,
      createdByUserId: k.createdByUserId,
      lastUsedAt: k.lastUsedAt,
    };
  });
  if (!resolved) return null;

  const now = Date.now();
  if (
    !resolved.lastUsedAt ||
    now - resolved.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS
  ) {
    void asSuperAdminOn(base, (db) =>
      db.apiKey.updateMany({
        where: { id: resolved.id, revokedAt: null },
        data: { lastUsedAt: new Date(now) },
      }),
    ).catch((error) =>
      logger.debug({ error }, "apiKey lastUsedAt update failed"),
    );
  }

  return {
    apiKeyId: resolved.id,
    userId: resolved.createdByUserId,
    tenantId: resolved.tenantId,
    role: resolved.role,
  };
}
