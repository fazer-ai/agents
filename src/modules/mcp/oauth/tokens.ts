import { randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { PrismaClient, UserRole } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import type { ApiKeyPrincipal } from "@/modules/api-keys/verify";
import { mcpResourceId } from "./metadata";

// MCP OAuth access-token service — the security core. Hardened-spec invariants:
//   - signed with the MCP key (config.mcpJwtSecret), SEPARATE from the app cookie JWT, with a
//     FIXED algorithm (HS256) and issuer check → anti algorithm/key confusion;
//   - a jti DENYLIST (every token is persisted; revocation is immediate, not "expires in ≤15min")
//     — mandatory for cross-tenant write tools;
//   - verify RE-RESOLVES the user from the DB: a promotion/demotion/tenant-move/deletion
//     invalidates the token (a stale role/tenant in the token row → reject, force re-auth).
// The mcp_oauth_* tables are GLOBAL (outside RLS); accessed via the base client, never scoped.

const ALG = "HS256";
// NOTE: wire-format identifier (the MCP OAuth `iss` claim).
const ISSUER = "fazerai:mcp";
// Compatibility window for the brand rename: verify accepts the pre-rename issuer too, so access
// tokens minted by the previous image survive the deploy instead of 401-ing in flight. We only ever
// SIGN the new one. The window that has to be covered is the 15-minute access TTL, not the refresh
// TTL: refresh tokens are opaque random strings with no issuer (see grant.ts), so a rotation
// immediately mints under the new issuer. Dropped at 2.0.
const LEGACY_ISSUER = "secretaria-v4:mcp";
const ACCESS_TTL_S = 15 * 60;

export const MCP_SCOPES = ["mcp:read", "mcp:write", "mcp:admin"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

function secretKey(): Uint8Array {
  return new TextEncoder().encode(config.mcpJwtSecret);
}

export interface IssueAccessTokenParams {
  clientId: string;
  userId: bigint;
  tenantId: bigint | null;
  role: UserRole;
  scopes: string[];
  resource?: string | null;
  base?: PrismaClient;
  nowMs?: number;
}

export interface IssuedAccessToken {
  token: string;
  jti: string;
  expiresIn: number;
}

export async function issueAccessToken(
  params: IssueAccessTokenParams,
): Promise<IssuedAccessToken> {
  const base = params.base ?? basePrisma;
  const now = params.nowMs ?? Date.now();
  const jti = randomBytes(16).toString("hex");
  const expiresAt = new Date(now + ACCESS_TTL_S * 1000);

  const token = await new SignJWT({
    tenant_id: params.tenantId === null ? null : params.tenantId.toString(),
    role: params.role,
    scopes: params.scopes,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(params.userId.toString())
    .setJti(jti)
    .setIssuer(ISSUER)
    // RFC 8707 audience binding: every token we mint is bound to our canonical resource id, NOT to
    // whatever `resource` the client passed. verifyAccessToken enforces this `aud`, so a token can
    // only be presented to us. The raw `resource` is still persisted below for audit.
    .setAudience(mcpResourceId())
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey());

  await base.mcpOAuthAccessToken.create({
    data: {
      jti,
      clientId: params.clientId,
      userId: params.userId,
      tenantId: params.tenantId,
      role: params.role,
      scopes: params.scopes,
      resource: params.resource ?? null,
      expiresAt,
    },
  });
  return { token, jti, expiresIn: ACCESS_TTL_S };
}

export interface VerifiedToken {
  userId: bigint;
  tenantId: bigint | null;
  role: UserRole;
  scopes: string[];
  clientId: string;
  jti: string;
}

// Returns the verified principal or null (caller maps null → 401). Never throws on a bad token.
export async function verifyAccessToken(
  token: string,
  base: PrismaClient = basePrisma,
): Promise<VerifiedToken | null> {
  let jti: string | undefined;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: [ALG],
      issuer: [ISSUER, LEGACY_ISSUER],
      // RFC 8707: the token MUST have been issued for us (the MCP resource server). jose rejects a
      // missing or divergent `aud`, so an old token with aud=ISSUER no longer verifies (re-auth/refresh).
      audience: mcpResourceId(),
    });
    jti = payload.jti;
  } catch {
    return null; // bad signature / wrong alg / wrong issuer / wrong audience / expired (jose checks exp)
  }
  if (!jti) return null;

  const row = await base.mcpOAuthAccessToken.findUnique({ where: { jti } });
  if (!row || row.revokedAt) return null; // denylist / unknown jti
  if (row.expiresAt.getTime() < Date.now()) return null;

  // Re-resolve the user: any change since issuance (role, tenant, deletion) invalidates the token.
  const user = await base.user.findUnique({
    where: { id: row.userId },
    select: { role: true, tenantId: true },
  });
  if (!user) return null;
  const sameTenant =
    (user.tenantId?.toString() ?? null) === (row.tenantId?.toString() ?? null);
  if (user.role !== row.role || !sameTenant) return null;

  return {
    userId: row.userId,
    tenantId: row.tenantId,
    role: row.role,
    scopes: row.scopes,
    clientId: row.clientId,
    jti,
  };
}

export async function revokeAccessToken(
  jti: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await base.mcpOAuthAccessToken.updateMany({
    where: { jti, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function hasScope(verified: VerifiedToken, scope: McpScope): boolean {
  return verified.scopes.includes(scope);
}

// Scopes granted to an API-key principal on the MCP transport, derived from its fixed role. NEVER
// returns mcp:admin (SUPER_ADMIN-only; API keys are always TENANT_ADMIN). Stays within MCP_SCOPES, so
// the existing hasScope gate keeps working unchanged.
export function scopesForRole(role: UserRole): McpScope[] {
  switch (role) {
    case "SUPER_ADMIN":
      return ["mcp:read", "mcp:write", "mcp:admin"];
    case "TENANT_ADMIN":
      return ["mcp:read", "mcp:write"];
    default:
      return ["mcp:read"];
  }
}

// Adapts a verified API-key principal to the MCP VerifiedToken shape, so the transport can accept a
// per-tenant API key (Bearer) as an ALTERNATIVE to an OAuth access token (OAuth stays the default,
// discoverable path). clientId/jti are synthetic — there is no OAuth client or denylisted jti behind
// an API key; revocation happens at the key (verifyApiKey returns null once revoked).
export function mcpPrincipalFromApiKey(p: ApiKeyPrincipal): VerifiedToken {
  return {
    userId: p.userId,
    tenantId: p.tenantId,
    role: p.role,
    scopes: scopesForRole(p.role),
    clientId: "api-key",
    jti: `api-key:${p.apiKeyId.toString()}`,
  };
}
