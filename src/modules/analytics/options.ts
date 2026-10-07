import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// WHAT THE DASHBOARD'S FILTER OFFERS: every agent and every inbox of the tenant, id and name only.
// Whole, not paged, because the page checks a shared link's agent and inbox against this list and
// drops what is not on it; a page of it would drop a real one. Readable by anyone who can read the
// dashboard, as the conversation list's own agent options are, without the admin-only inbox route.

export interface FilterOption {
  id: string;
  name: string;
}

export async function getFilterOptions(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<{ agents: FilterOption[]; inboxes: FilterOption[] }> {
  return runScopedOn(base, ctx, async (db) => {
    const agents = await db.agent.findMany({
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const inboxes = await db.inbox.findMany({
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return {
      agents: agents.map((a) => ({ id: String(a.id), name: a.name })),
      inboxes: inboxes.map((i) => ({ id: String(i.id), name: i.name })),
    };
  });
}
