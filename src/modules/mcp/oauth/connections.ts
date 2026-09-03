import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { asPrincipalOn, type TenantContext } from "@/lib/tenancy";
import { auditMutationOn } from "@/modules/audit/service";

// Self-service view of a user's OWN MCP connections (the apps they approved via OAuth) and the
// ability to disconnect them. The mcp_oauth_* tables are GLOBAL (no RLS), so every query runs on the
// base client and is fenced MANUALLY by userId — a user can only ever see or affect their own rows.
// Admin-wide management (every user, every client) lives in oauth/admin.ts (SUPER_ADMIN-only, Full);
// this surface is available to every authenticated role.

export interface MyConnectionDto {
  clientId: string;
  clientName: string;
  scopes: string[];
  // true = trusted client promoted by an admin (skips the consent screen).
  firstParty: boolean;
  // true = self-registered via DCR and not promoted to trusted → shown as "unverified" in the UI.
  unverified: boolean;
  // count of the caller's live (not revoked, not expired) access tokens for this client.
  activeTokenCount: number;
  connectedAt: Date;
  updatedAt: Date;
}

// Lists the caller's remembered approvals (one per connected app), enriched with the client name,
// trust/provenance flags and a live-token count. Ordered newest first.
export async function listMyConnections(
  userId: bigint,
  base: PrismaClient = basePrisma,
): Promise<MyConnectionDto[]> {
  const approvals = await base.mcpOAuthClientApproval.findMany({
    where: { userId },
    orderBy: { id: "desc" },
  });
  if (approvals.length === 0) return [];
  const clientIds = [...new Set(approvals.map((a) => a.clientId))];
  const [clients, activeTokens] = await Promise.all([
    base.mcpOAuthClient.findMany({
      where: { clientId: { in: clientIds } },
      select: {
        clientId: true,
        name: true,
        firstParty: true,
        dynamicallyRegistered: true,
      },
    }),
    base.mcpOAuthAccessToken.findMany({
      where: {
        userId,
        clientId: { in: clientIds },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { clientId: true },
    }),
  ]);
  const byClient = new Map(clients.map((c) => [c.clientId, c]));
  const activeCount = new Map<string, number>();
  for (const tk of activeTokens) {
    activeCount.set(tk.clientId, (activeCount.get(tk.clientId) ?? 0) + 1);
  }
  return approvals.map((a) => {
    const c = byClient.get(a.clientId);
    const firstParty = c?.firstParty ?? false;
    return {
      clientId: a.clientId,
      clientName: c?.name ?? a.clientId,
      scopes: a.scopes,
      firstParty,
      unverified: (c?.dynamicallyRegistered ?? false) && !firstParty,
      activeTokenCount: activeCount.get(a.clientId) ?? 0,
      connectedAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  });
}

export interface DisconnectResult {
  removedApproval: boolean;
  revokedAccessTokens: number;
  revokedRefreshTokens: number;
}

// Disconnects an app for THIS user: forgets the remembered approval (so the next /authorize prompts
// again) AND revokes the user's live access + refresh tokens for that client (so existing sessions
// die now, not only future consent). Idempotent and strictly userId-scoped — calling it for a client
// another user connected has no effect on that user.
export async function disconnectClient(
  ctx: TenantContext & { userId: bigint },
  clientId: string,
  base: PrismaClient = basePrisma,
): Promise<DisconnectResult> {
  const userId = ctx.userId;
  return asPrincipalOn(base, ctx, async (db) => {
    const now = new Date();
    const approval = await db.mcpOAuthClientApproval.deleteMany({
      where: { userId, clientId },
    });
    const access = await db.mcpOAuthAccessToken.updateMany({
      where: { userId, clientId, revokedAt: null },
      data: { revokedAt: now },
    });
    const refresh = await db.mcpOAuthRefreshToken.updateMany({
      where: { userId, clientId, revokedAt: null },
      data: { revokedAt: now },
    });
    // Recorded only when something actually went. The route is idempotent and the console offers it
    // on a connection the user may already have dropped elsewhere, so an unconditional row would
    // append one every time somebody clicks twice — the same answer #395 reached for the reconcile
    // that runs on every page load.
    if (approval.count > 0 || access.count > 0 || refresh.count > 0) {
      // The trail this joins is the ACTOR's own tenant, and `ctx.tenantId` is not that for the one
      // principal who has none: a SUPER_ADMIN carries whichever tenant the console had selected, so
      // keyed on it, a fleet admin disconnecting their own app would be filed under a tenant that
      // had nothing to do with it. `mcp_oauth_client_approvals` carries no tenant of its own to
      // follow, so the actor is the only thing that answers for which trail this belongs to.
      await auditMutationOn(
        db,
        ctx,
        ctx.role === "SUPER_ADMIN" ? null : ctx.tenantId,
        {
          action: "mcp_client.disconnect",
          target: `client:${clientId}`,
          after: {
            clientId,
            removedApproval: approval.count > 0,
            revokedAccessTokens: access.count,
            revokedRefreshTokens: refresh.count,
          },
        },
      );
    }
    return {
      removedApproval: approval.count > 0,
      revokedAccessTokens: access.count,
      revokedRefreshTokens: refresh.count,
    };
  });
}
