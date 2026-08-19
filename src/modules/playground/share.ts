import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  generateRouteToken,
  hashRouteToken,
} from "@/modules/webhooks/inbound/route-token";

// Operator-minted, no-login public link that lets a customer chat with an agent in an isolated
// playground thread (no Chatwoot, no real conversation). Mirrors the Chatwoot webhook route-token
// pattern: only the SHA-256 hash is stored, the plaintext is shown once at mint time.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 48;
export const DEFAULT_TTL_HOURS = 48;
export const MIN_MAX_MESSAGES = 1;
export const MAX_MAX_MESSAGES = 500;
export const DEFAULT_MAX_MESSAGES = 60;

export interface PlaygroundShareLinkRow {
  id: bigint;
  agentId: bigint;
  messageCount: number;
  maxMessages: number;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface MintShareLinkParams {
  tenantId: bigint;
  agentId: bigint;
  ttlHours?: number;
  maxMessages?: number;
  base?: PrismaClient;
}

export interface MintedShareLink {
  id: bigint;
  token: string;
  expiresAt: Date;
  maxMessages: number;
}

export async function mintPlaygroundShareLink(
  params: MintShareLinkParams,
): Promise<MintedShareLink> {
  const base = params.base ?? basePrisma;
  const ttlHours = Math.min(
    Math.max(params.ttlHours ?? DEFAULT_TTL_HOURS, MIN_TTL_HOURS),
    MAX_TTL_HOURS,
  );
  const maxMessages = Math.min(
    Math.max(params.maxMessages ?? DEFAULT_MAX_MESSAGES, MIN_MAX_MESSAGES),
    MAX_MAX_MESSAGES,
  );
  const { token, hash } = generateRouteToken();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const row = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.playgroundShareLink.create({
      data: {
        tenantId: params.tenantId,
        agentId: params.agentId,
        tokenHash: hash,
        maxMessages,
        expiresAt,
      },
      select: { id: true },
    }),
  );
  return { id: row.id, token, expiresAt, maxMessages };
}

export async function listPlaygroundShareLinks(
  tenantId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<PlaygroundShareLinkRow[]> {
  return runScopedOn(base, sysCtx(tenantId), (db) =>
    db.playgroundShareLink.findMany({
      where: { agentId },
      orderBy: { createdAt: "desc" },
    }),
  );
}

export async function revokePlaygroundShareLink(
  tenantId: bigint,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.playgroundShareLink.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );
}

export type ResolvedShareLinkStatus =
  | "ok"
  | "not_found"
  | "expired"
  | "exhausted";

export interface ResolvedShareLink {
  status: ResolvedShareLinkStatus;
  link?: { id: bigint; tenantId: bigint; agentId: bigint; agentName: string };
}

// Resolves a share link by its opaque token. No tenant context exists yet (the token itself
// resolves the tenant), so this runs as super-admin, mirroring resolveBotByRouteToken (Chatwoot).
export async function resolvePlaygroundShareLink(
  token: string,
  base: PrismaClient = basePrisma,
): Promise<ResolvedShareLink> {
  const tokenHash = hashRouteToken(token);
  const row = await asSuperAdminOn(base, (db) =>
    db.playgroundShareLink.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        agentId: true,
        messageCount: true,
        maxMessages: true,
        expiresAt: true,
        revokedAt: true,
        agent: { select: { name: true } },
      },
    }),
  );
  if (!row) return { status: "not_found" };
  if (row.revokedAt !== null || row.expiresAt.getTime() <= Date.now())
    return { status: "expired" };
  if (row.messageCount >= row.maxMessages) return { status: "exhausted" };
  return {
    status: "ok",
    link: {
      id: row.id,
      tenantId: row.tenantId,
      agentId: row.agentId,
      agentName: row.agent.name,
    },
  };
}

// Atomically claims one message slot. Returns false if another concurrent request already
// exhausted the link between resolve and here (CAS on messageCount < maxMessages, re-read fresh so
// the check is against the current count, not the one seen at resolve time).
export async function claimPlaygroundShareLinkMessage(
  tenantId: bigint,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<boolean> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const row = await db.playgroundShareLink.findUnique({
      where: { id },
      select: { maxMessages: true },
    });
    if (!row) return false;
    const result = await db.playgroundShareLink.updateMany({
      where: {
        id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        messageCount: { lt: row.maxMessages },
      },
      data: { messageCount: { increment: 1 } },
    });
    return result.count > 0;
  });
}
