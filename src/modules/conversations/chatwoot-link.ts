import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import type { Membership } from "@/lib/tenancy/membership";

// A conversation as Chatwoot names it (account, the `display_id` in its URL, inbox), resolved to the
// page that shows it here: the link the Chatwoot fork puts in its contact panel. Account and inbox
// ids repeat across the servers of a fleet, so the link also names its server through the Agent Bot
// it came from (`botHash`, the key `webhookRouteTokenHash` already stores; the token never travels).
// Without it a number recorded only on another server would be a false single match. Whatever is
// still ambiguous is returned whole for the caller to choose from, never guessed. See docs/chatwoot.md.

export interface ChatwootConversationRef {
  accountId: number;
  conversationId: number;
  inboxId?: number;
  // SHA-256 (hex) of the route token of the Agent Bot the link came through.
  botHash?: string;
}

export interface ChatwootConversationMatch {
  id: string;
  tenantId: string;
}

// More than this many matches is not a link anyone can use; the page lists what it has.
const MAX_MATCHES = 10;

function findIn(db: ScopedDb, ref: ChatwootConversationRef) {
  return db.conversation.findMany({
    where: {
      chatwootConversationId: ref.conversationId,
      instance: {
        accountId: ref.accountId,
        ...(ref.botHash !== undefined
          ? { agentBots: { some: { webhookRouteTokenHash: ref.botHash } } }
          : {}),
      },
      ...(ref.inboxId !== undefined
        ? { inbox: { chatwootInboxId: ref.inboxId } }
        : {}),
    },
    select: { id: true, tenantId: true },
    orderBy: { id: "asc" },
    take: MAX_MATCHES,
  });
}

export type LinkSearch = { scopes: TenantContext[] } | { fleet: true };

// The tenants the caller can open, which are the ones searched: a Chatwoot account belongs to one
// tenant, and it need not be the one the console has selected. A person gets every membership (with
// the role held there), an API key the one tenant it is bound to, a SUPER_ADMIN the fleet.
export function linkSearchFor(
  ctx: TenantContext,
  user: { isApiKey?: boolean; memberships?: readonly Membership[] } | null,
): LinkSearch {
  if (ctx.role === "SUPER_ADMIN") return { fleet: true };
  const memberships = user?.isApiKey ? [] : (user?.memberships ?? []);
  if (memberships.length === 0) return { scopes: [ctx] };
  return {
    scopes: memberships.map((m) => ({
      ...ctx,
      tenantId: m.tenantId,
      role: m.role,
    })),
  };
}

// `scopes` is every tenant the caller may read: one per membership for a person, the request's own
// for an API key. A fleet session (SUPER_ADMIN) passes `fleet: true` instead and is answered from
// the whole fleet, the way its console reads any tenant.
export async function resolveChatwootConversation(
  who: LinkSearch,
  ref: ChatwootConversationRef,
  base: PrismaClient = basePrisma,
): Promise<ChatwootConversationMatch[]> {
  const rows =
    "fleet" in who
      ? await asSuperAdminOn(base, (db) => findIn(db, ref))
      : (
          await Promise.all(
            who.scopes.map((ctx) =>
              runScopedOn(base, ctx, (db) => findIn(db, ref)),
            ),
          )
        ).flat();
  // NOTE: each scope is capped on its own, so the union can pass the cap; trimmed as a list.
  rows.length = Math.min(rows.length, MAX_MATCHES);
  return rows.map((r) => ({ id: String(r.id), tenantId: String(r.tenantId) }));
}
