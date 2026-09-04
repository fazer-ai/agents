import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import type { AuditAction } from "@/lib/audit/actions";
import { AppError, NotFoundError } from "@/lib/errors";
import {
  asSuperAdminOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { auditMutationOn, projectionMoved } from "@/modules/audit/service";
import { validateRedirectUris } from "@/modules/mcp/oauth/dcr";
import { MCP_SCOPES, revokeAccessToken } from "@/modules/mcp/oauth/tokens";

// Admin management of OUR MCP server (the third transport) — OAuth clients + active tokens. The
// mcp_oauth_* tables are GLOBAL (no RLS), so every query uses basePrisma and the SUPER_ADMIN gate at
// the controller is the only fence; tenant filtering here is MANUAL (a `where: { tenantId }`). The
// client_secret hash is never returned. MVP registers PUBLIC clients only (PKCE; no client_secret),
// since the /token endpoint does not verify a client_secret yet.

const FIXED_GRANT_TYPES = ["authorization_code", "refresh_token"];

export interface McpClientDto {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[];
  // true when a client_secret hash is set (confidential client); false = public (PKCE).
  isConfidential: boolean;
  // true = trusted client that skips the consent screen at /authorize.
  firstParty: boolean;
  // true = self-registered via DCR (provenance). Surfaced as an "auto-registered/unverified" badge.
  dynamicallyRegistered: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toClientDto(row: {
  id: bigint;
  clientId: string;
  clientSecretHash: string | null;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[];
  firstParty: boolean;
  dynamicallyRegistered: boolean;
  createdAt: Date;
  updatedAt: Date;
}): McpClientDto {
  return {
    id: row.id.toString(),
    clientId: row.clientId,
    name: row.name,
    redirectUris: row.redirectUris,
    grantTypes: row.grantTypes,
    scopes: row.scopes,
    isConfidential: row.clientSecretHash !== null,
    firstParty: row.firstParty,
    dynamicallyRegistered: row.dynamicallyRegistered,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const CLIENT_SELECT = {
  id: true,
  clientId: true,
  clientSecretHash: true,
  name: true,
  redirectUris: true,
  grantTypes: true,
  scopes: true,
  firstParty: true,
  dynamicallyRegistered: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Every row this module writes is FLEET-level (`tenant_id NULL`), and that is a property of the
// tables and not a default. An OAuth client is registered once for the whole deployment, a consent
// approval belongs to a person rather than to a tenant, and an access token names the tenant it was
// minted FOR — filing the revocation under that one would say a tenant admin can read who revoked
// their colleague's token, which is a fleet decision made by a SUPER_ADMIN. `asSuperAdminOn` is also
// the only mode that can write `tenant_id NULL` at all.
//
// These functions take the actor as their FIRST argument for the same reason the seam does: the row
// names how the request authenticated, and a caller that could pass its own actor could attribute a
// revocation to somebody else.
async function fleetAudit(
  db: ScopedDb,
  ctx: TenantContext,
  entry: {
    action: AuditAction;
    target: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await auditMutationOn(db, ctx, null, entry);
}

// What a client's row carries. Everything this surface already returns to a SUPER_ADMIN, minus the
// secret: `clientSecretHash` is reduced to the boolean the DTO shows (`isConfidential`), never the
// digest, because these rows outlive the client they describe and an unsalted hash is an offline
// verifier for whatever produced it. The redirect URIs are carried WHOLE and not reduced to their
// origins like an operator-typed URL elsewhere: here the exact path IS the security control
// (`validateRedirectUris` demands an exact match), so an origin would hide the change worth
// recording.
function clientAuditProjection(row: {
  clientId: string;
  clientSecretHash: string | null;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[];
  firstParty: boolean;
  dynamicallyRegistered: boolean;
}) {
  return {
    clientId: row.clientId,
    name: row.name,
    redirectUris: row.redirectUris,
    grantTypes: row.grantTypes,
    scopes: row.scopes,
    confidential: row.clientSecretHash !== null,
    firstParty: row.firstParty,
    dynamicallyRegistered: row.dynamicallyRegistered,
  };
}

export async function listClients(
  base: PrismaClient = basePrisma,
): Promise<McpClientDto[]> {
  const rows = await base.mcpOAuthClient.findMany({
    select: CLIENT_SELECT,
    orderBy: { id: "desc" },
  });
  return rows.map(toClientDto);
}

function sanitizeScopes(scopes: string[] | undefined): string[] {
  const allowed = new Set<string>(MCP_SCOPES);
  const out = (scopes ?? ["mcp:read"]).filter((s) => allowed.has(s));
  if (out.length === 0)
    throw new AppError("at least one valid scope is required", 400);
  return [...new Set(out)];
}

export interface CreateClientInput {
  name: string;
  redirectUris: string[];
  scopes?: string[];
  firstParty?: boolean;
}

export async function createClient(
  ctx: TenantContext,
  input: CreateClientInput,
  base: PrismaClient = basePrisma,
): Promise<McpClientDto> {
  const name = input.name.trim();
  if (!name) throw new AppError("name is required", 400);
  const reason = validateRedirectUris(input.redirectUris);
  if (reason) throw new AppError(reason, 400);
  const scopes = sanitizeScopes(input.scopes);
  const clientId = randomBytes(16).toString("hex");
  return asSuperAdminOn(base, async (db) => {
    const row = await db.mcpOAuthClient.create({
      data: {
        clientId,
        // Public (PKCE) client — no client_secret in the MVP.
        clientSecretHash: null,
        name,
        redirectUris: input.redirectUris,
        grantTypes: FIXED_GRANT_TYPES,
        scopes,
        firstParty: input.firstParty ?? false,
      },
      select: CLIENT_SELECT,
    });
    await fleetAudit(db, ctx, {
      action: "mcp_client.create",
      target: `client:${row.clientId}`,
      after: clientAuditProjection(row),
    });
    return toClientDto(row);
  });
}

export interface UpdateClientInput {
  name?: string;
  redirectUris?: string[];
  scopes?: string[];
  firstParty?: boolean;
}

export async function updateClient(
  ctx: TenantContext,
  clientId: string,
  patch: UpdateClientInput,
  base: PrismaClient = basePrisma,
): Promise<McpClientDto> {
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new AppError("name is required", 400);
    data.name = name;
  }
  if (patch.redirectUris !== undefined) {
    const reason = validateRedirectUris(patch.redirectUris);
    if (reason) throw new AppError(reason, 400);
    data.redirectUris = patch.redirectUris;
  }
  if (patch.scopes !== undefined) data.scopes = sanitizeScopes(patch.scopes);
  if (patch.firstParty !== undefined) data.firstParty = patch.firstParty;
  if (Object.keys(data).length === 0)
    throw new AppError("no updatable fields provided", 400);
  return asSuperAdminOn(base, async (db) => {
    // The row is locked before it is read, and the read is what the recorded `before` comes from.
    // Two admins editing the same client otherwise both read the same value and both record the same
    // transition, so the trail shows one of the two edits twice and the other not at all. The
    // update-then-read this replaced had the same gap in the other direction: it read back a row a
    // concurrent write could already have moved, and reported that as its own result.
    const [locked] = await db.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM mcp_oauth_clients WHERE client_id = ${clientId} FOR UPDATE`;
    if (!locked)
      throw new NotFoundError(
        "mcp client not found",
        "errors.mcpClientNotFound",
      );
    const before = await db.mcpOAuthClient.findUniqueOrThrow({
      where: { clientId },
      select: CLIENT_SELECT,
    });
    const row = await db.mcpOAuthClient.update({
      where: { clientId },
      data,
      select: CLIENT_SELECT,
    });
    const beforeProj = clientAuditProjection(before);
    const afterProj = clientAuditProjection(row);
    if (projectionMoved(beforeProj, afterProj)) {
      await fleetAudit(db, ctx, {
        action: "mcp_client.update",
        target: `client:${clientId}`,
        before: beforeProj,
        after: afterProj,
      });
    }
    return toClientDto(row);
  });
}

// Deleting a client cascades to its tokens: revoke every access + refresh token first (a denylisted
// access jti 401s at once; revoked refresh tokens can't mint new ones), then remove the client row.
export async function deleteClient(
  ctx: TenantContext,
  clientId: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await asSuperAdminOn(base, async (db) => {
    await db.$queryRaw`
      SELECT id FROM mcp_oauth_clients WHERE client_id = ${clientId} FOR UPDATE`;
    const before = await db.mcpOAuthClient.findUnique({
      where: { clientId },
      select: CLIENT_SELECT,
    });
    if (!before)
      throw new NotFoundError(
        "mcp client not found",
        "errors.mcpClientNotFound",
      );
    const now = new Date();
    const access = await db.mcpOAuthAccessToken.updateMany({
      where: { clientId, revokedAt: null },
      data: { revokedAt: now },
    });
    const refresh = await db.mcpOAuthRefreshToken.updateMany({
      where: { clientId, revokedAt: null },
      data: { revokedAt: now },
    });
    const res = await db.mcpOAuthClient.deleteMany({ where: { clientId } });
    if (res.count === 0)
      throw new NotFoundError(
        "mcp client not found",
        "errors.mcpClientNotFound",
      );
    // The row COUNTS what the delete just killed, in the same transaction and after the writes that
    // did it. A registration going away takes every session held under it with no separate act
    // naming them, so "how many people were signed out" is only answerable from here (same shape as
    // `deployment.disconnect`, which counts what it is about to destroy).
    await fleetAudit(db, ctx, {
      action: "mcp_client.delete",
      target: `client:${clientId}`,
      before: {
        ...clientAuditProjection(before),
        revokedAccessTokens: access.count,
        revokedRefreshTokens: refresh.count,
      },
    });
  });
}

export interface ActiveTokenDto {
  jti: string;
  clientId: string;
  clientName: string | null;
  userId: string;
  userEmail: string | null;
  tenantId: string | null;
  scopes: string[];
  expiresAt: Date;
  createdAt: Date;
}

// Lists the currently valid access tokens (not revoked, not expired), optionally fenced to one
// tenant, enriched with the client name and the user's email for a readable admin view.
export async function listActiveTokens(
  opts: { tenantId?: bigint | null } = {},
  base: PrismaClient = basePrisma,
): Promise<ActiveTokenDto[]> {
  const rows = await base.mcpOAuthAccessToken.findMany({
    where: {
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(opts.tenantId != null ? { tenantId: opts.tenantId } : {}),
    },
    orderBy: { id: "desc" },
    take: 500,
  });
  if (rows.length === 0) return [];
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const [clients, users] = await Promise.all([
    base.mcpOAuthClient.findMany({
      where: { clientId: { in: clientIds } },
      select: { clientId: true, name: true },
    }),
    base.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true },
    }),
  ]);
  const clientName = new Map(clients.map((c) => [c.clientId, c.name]));
  const userEmail = new Map(users.map((u) => [u.id.toString(), u.email]));
  return rows.map((r) => ({
    jti: r.jti,
    clientId: r.clientId,
    clientName: clientName.get(r.clientId) ?? null,
    userId: r.userId.toString(),
    userEmail: userEmail.get(r.userId.toString()) ?? null,
    tenantId: r.tenantId === null ? null : r.tenantId.toString(),
    scopes: r.scopes,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}

// Revokes an active access token by jti (immediate denylist) AND every non-revoked refresh token for
// the same client+user, so the client cannot simply mint a fresh access token from a live refresh.
export async function revokeToken(
  ctx: TenantContext,
  jti: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await asSuperAdminOn(base, async (db) => {
    // ONE transaction, which this path did not have. The two writes are halves of a single act: a
    // failure between them left the access token denylisted and every refresh token of the same
    // client+user alive, so the client mints a fresh access token on the spot and the revocation the
    // whole token design rests on is undone by the retry it looks like it needs.
    const [locked] = await db.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM mcp_oauth_access_tokens WHERE jti = ${jti} FOR UPDATE`;
    if (!locked)
      throw new NotFoundError("mcp token not found", "errors.mcpTokenNotFound");
    const row = await db.mcpOAuthAccessToken.findUniqueOrThrow({
      where: { jti },
      select: {
        clientId: true,
        userId: true,
        tenantId: true,
        scopes: true,
        revokedAt: true,
      },
    });
    await revokeAccessToken(jti, db);
    const refresh = await db.mcpOAuthRefreshToken.updateMany({
      where: { clientId: row.clientId, userId: row.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Recorded on every apply, including the token that was already revoked. Revoking is an operator
    // reaching for a live session, not a form being saved, and the same reasoning the conversation
    // family states applies: "already revoked" is the answer to the act, not a reason to leave it
    // off the trail. `alreadyRevoked` says which it was.
    await fleetAudit(db, ctx, {
      action: "mcp_token.revoke",
      target: `mcp_token:${jti}`,
      before: {
        clientId: row.clientId,
        userId: String(row.userId),
        tenantId: row.tenantId === null ? null : String(row.tenantId),
        scopes: row.scopes,
        alreadyRevoked: row.revokedAt !== null,
      },
      after: { revokedRefreshTokens: refresh.count },
    });
  });
}

export interface ClientApprovalDto {
  id: string;
  userId: string;
  userEmail: string | null;
  clientId: string;
  clientName: string | null;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Lists the remembered per-user-per-client consent approvals (what lets /authorize skip the consent
// screen), enriched with the client name and user email for a readable admin view. Revoking one
// (deleteClientApproval) makes the next /authorize prompt again.
export async function listClientApprovals(
  base: PrismaClient = basePrisma,
): Promise<ClientApprovalDto[]> {
  const rows = await base.mcpOAuthClientApproval.findMany({
    orderBy: { id: "desc" },
    take: 500,
  });
  if (rows.length === 0) return [];
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const [clients, users] = await Promise.all([
    base.mcpOAuthClient.findMany({
      where: { clientId: { in: clientIds } },
      select: { clientId: true, name: true },
    }),
    base.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true },
    }),
  ]);
  const clientName = new Map(clients.map((c) => [c.clientId, c.name]));
  const userEmail = new Map(users.map((u) => [u.id.toString(), u.email]));
  return rows.map((r) => ({
    id: r.id.toString(),
    userId: r.userId.toString(),
    userEmail: userEmail.get(r.userId.toString()) ?? null,
    clientId: r.clientId,
    clientName: clientName.get(r.clientId) ?? null,
    scopes: r.scopes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function deleteClientApproval(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await asSuperAdminOn(base, async (db) => {
    await db.$queryRaw`
      SELECT id FROM mcp_oauth_client_approvals WHERE id = ${id} FOR UPDATE`;
    const before = await db.mcpOAuthClientApproval.findUnique({
      where: { id },
      select: { userId: true, clientId: true, scopes: true },
    });
    if (!before)
      throw new NotFoundError(
        "mcp approval not found",
        "errors.mcpApprovalNotFound",
      );
    const res = await db.mcpOAuthClientApproval.deleteMany({ where: { id } });
    if (res.count === 0)
      throw new NotFoundError(
        "mcp approval not found",
        "errors.mcpApprovalNotFound",
      );
    // NOTE: this forgets the remembered consent and nothing else — the user's live tokens keep
    // working until they expire, which is what the route does and why its row cannot be read as a
    // disconnect. `mcp_client.disconnect` (the user's own, in `connections.ts`) is the one that also
    // kills the sessions, and it says so by carrying the counts.
    await fleetAudit(db, ctx, {
      action: "mcp_approval.revoke",
      target: `mcp_approval:${id}`,
      before: {
        userId: String(before.userId),
        clientId: before.clientId,
        scopes: before.scopes,
      },
    });
  });
}
