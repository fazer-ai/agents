import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { mcpResourceId } from "./metadata";
import { issueAccessToken } from "./tokens";

// OAuth 2.1 grant logic (authorization_code + refresh_token). Security invariants (hardened spec):
//   - the authorization code is HASHED at rest (never a PK in clear) and SINGLE-USE (CAS consume);
//   - PKCE S256 is required and verified; redirect_uri + client_id are bound to the code;
//   - refresh rotation with REUSE DETECTION: presenting an already-rotated/revoked refresh token
//     revokes the whole family (a leaked token can't be replayed for a new access token).
// The mcp_oauth_* tables are GLOBAL (outside RLS) — accessed via the base client.

const CODE_TTL_MS = 10 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// The base client OR a scoped transaction, for the mint alone. What the code needs from its client
// is not a role but a TRANSACTION: the consent decision, the code it mints and the row that records
// the decision commit together or not at all (#497). Deliberately NOT applied to the rest of this
// module — `/token` mints from its own request and shares no transaction with anything.
type CodeDb = Prisma.TransactionClient;

export interface CreateCodeParams {
  clientId: string;
  userId: bigint;
  tenantId: bigint | null;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  resource?: string | null;
  base?: CodeDb;
}

// Mints an authorization code (returned once, in clear). Requires PKCE S256.
export async function createAuthorizationCode(
  params: CreateCodeParams,
): Promise<string> {
  if (params.codeChallengeMethod !== "S256") {
    throw new AppError("only PKCE S256 is supported", 400);
  }
  const base = params.base ?? basePrisma;
  const code = randomBytes(32).toString("base64url");
  await base.mcpOAuthAuthorizationCode.create({
    data: {
      codeHash: sha256(code),
      clientId: params.clientId,
      userId: params.userId,
      tenantId: params.tenantId,
      redirectUri: params.redirectUri,
      scopes: params.scopes,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      resource: params.resource ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return code;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
  tokenType: "Bearer";
}

async function issuePair(
  base: PrismaClient,
  args: {
    clientId: string;
    userId: bigint;
    tenantId: bigint | null;
    scopes: string[];
    resource: string | null;
    familyId: string;
  },
): Promise<TokenResponse> {
  // Re-resolve the user's CURRENT role (a code/refresh issued before a role change must not grant
  // stale privileges).
  const user = await base.user.findUnique({
    where: { id: args.userId },
    select: { role: true, tenantId: true },
  });
  if (!user) throw new AppError("user no longer exists", 400);
  const access = await issueAccessToken({
    clientId: args.clientId,
    userId: args.userId,
    tenantId: args.tenantId,
    role: user.role,
    scopes: args.scopes,
    resource: args.resource,
    base,
  });
  const refreshToken = randomBytes(32).toString("base64url");
  await base.mcpOAuthRefreshToken.create({
    data: {
      tokenHash: sha256(refreshToken),
      jti: access.jti,
      clientId: args.clientId,
      userId: args.userId,
      tenantId: args.tenantId,
      scopes: args.scopes,
      familyId: args.familyId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return {
    accessToken: access.token,
    refreshToken,
    expiresIn: access.expiresIn,
    scopes: args.scopes,
    tokenType: "Bearer",
  };
}

export interface ExchangeCodeParams {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
  base?: PrismaClient;
}

export async function exchangeAuthorizationCode(
  params: ExchangeCodeParams,
): Promise<TokenResponse> {
  const base = params.base ?? basePrisma;
  const codeHash = sha256(params.code);
  const row = await base.mcpOAuthAuthorizationCode.findUnique({
    where: { codeHash },
  });
  if (!row) throw new AppError("invalid_grant", 400);
  if (row.consumedAt) throw new AppError("invalid_grant", 400);
  if (row.expiresAt.getTime() < Date.now())
    throw new AppError("invalid_grant", 400);
  if (row.clientId !== params.clientId)
    throw new AppError("invalid_grant", 400);
  if (row.redirectUri !== params.redirectUri)
    throw new AppError("invalid_grant", 400);
  if (
    !row.codeChallenge ||
    !constantTimeEqual(pkceS256(params.codeVerifier), row.codeChallenge)
  ) {
    throw new AppError("invalid_grant", 400);
  }

  // Single-use: CAS consume. A concurrent/replayed exchange sees count 0 → reject.
  const consumed = await base.mcpOAuthAuthorizationCode.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) throw new AppError("invalid_grant", 400);

  return issuePair(base, {
    clientId: row.clientId,
    userId: row.userId,
    tenantId: row.tenantId,
    scopes: row.scopes,
    resource: row.resource ?? params.resource ?? null,
    familyId: randomBytes(16).toString("hex"),
  });
}

export interface RefreshParams {
  refreshToken: string;
  clientId: string;
  base?: PrismaClient;
}

export async function refreshAccessToken(
  params: RefreshParams,
): Promise<TokenResponse> {
  const base = params.base ?? basePrisma;
  const tokenHash = sha256(params.refreshToken);
  const row = await base.mcpOAuthRefreshToken.findUnique({
    where: { tokenHash },
  });
  if (!row || row.clientId !== params.clientId)
    throw new AppError("invalid_grant", 400);

  // REUSE DETECTION: an already-rotated or revoked refresh token is a leak signal → revoke the
  // whole family (every token sharing familyId), forcing re-authorization.
  if (row.rotatedTo || row.revokedAt) {
    await base.mcpOAuthRefreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new AppError("invalid_grant", 400);
  }
  if (row.expiresAt.getTime() < Date.now())
    throw new AppError("invalid_grant", 400);

  const pair = await issuePair(base, {
    clientId: row.clientId,
    userId: row.userId,
    tenantId: row.tenantId,
    scopes: row.scopes,
    // The token's aud is always our canonical resource id; persist it here too so a refreshed
    // token's audit row stays coherent (the old code dropped this to null).
    resource: mcpResourceId(),
    familyId: row.familyId,
  });
  // Atomically rotate: mark this token rotated. CAS guards against a concurrent double-refresh.
  const rotated = await base.mcpOAuthRefreshToken.updateMany({
    where: { id: row.id, rotatedTo: null, revokedAt: null },
    data: { rotatedTo: sha256(pair.refreshToken), revokedAt: new Date() },
  });
  if (rotated.count === 0) throw new AppError("invalid_grant", 400);
  return pair;
}
