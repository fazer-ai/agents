import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Shared by the live delivery (./webhook.ts) and the human-reply recovery (./recover-human-reply.ts),
// which both arm the one contact-inbox thread's ingest job on a watcher's behalf. One list, so the
// two paths cannot file the same message under different owners.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The switched-on watchers of an inbox, Chatwoot-confirmed, in agent order: every route reads the
// same list, so the first one is the same memory owner and media config on all of them. Null when
// unreadable; callers then keep the route's own agent, as a lone watcher does.
export async function inboxWatchers(
  tenantId: bigint,
  inboxId: bigint,
  base: PrismaClient,
): Promise<{ agentId: bigint; settings: unknown }[] | null> {
  try {
    const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.inboxObserver.findMany({
        where: { inboxId, attachedAt: { not: null }, agent: { enabled: true } },
        select: { agentId: true, agent: { select: { settings: true } } },
        orderBy: { agentId: "asc" },
      }),
    );
    return rows.map((r) => ({
      agentId: r.agentId,
      settings: r.agent.settings,
    }));
  } catch (err) {
    logger.warn(
      "chatwoot: could not read the inbox's watchers (inbox row=%s): %s",
      String(inboxId),
      errMsg(err),
    );
    return null;
  }
}

// Whose memory a watcher's route files the shared thread's append under: the first of the inbox's
// watchers, the same answer on every route, so delivery or recovery order cannot change who
// summarises the attendance. Only when the route is among them: a route the list does not name (its
// row taken back since, or unreadable) keeps its own agent, as a lone watcher does.
export function watcherMemoryOwner<
  R extends { agentId: bigint; settings: unknown },
>(
  watchers: { agentId: bigint; settings: unknown }[] | null,
  route: R,
): { agentId: bigint; settings: unknown } {
  const first = watchers?.[0];
  return first && watchers?.some((w) => w.agentId === route.agentId)
    ? first
    : route;
}
