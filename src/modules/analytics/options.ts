import type { PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import type { TenantContext } from "@/lib/tenancy";
import { runMetricsScoped } from "./budget";

// WHAT THE DASHBOARD'S FILTER OFFERS: every agent and every inbox of the tenant, by id and name, with
// the account of an inbox whose name repeats. Whole, not paged, because the page checks a shared link's agent and inbox against this list and
// drops what is not on it; a page of it would drop a real one. Readable by anyone who can read the
// dashboard, as the conversation list's own agent options are, without the admin-only inbox route.

export interface FilterOption {
  id: string;
  name: string;
}

// An inbox whose name another inbox of the tenant also has (two connected Chatwoot accounts with a
// "SAC WhatsApp" each) carries its account, so a picker can tell the two apart. `name` is null while
// the account's name has not synced.
export interface InboxOption extends FilterOption {
  account?: { id: number; name: string | null };
}

export async function getFilterOptions(
  ctx: TenantContext,
  base: PrismaClient = metricsPrisma,
): Promise<{ agents: FilterOption[]; inboxes: InboxOption[] }> {
  return runMetricsScoped(base, ctx, async (db) => {
    const agents = await db.agent.findMany({
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const inboxes = await db.inbox.findMany({
      select: {
        id: true,
        name: true,
        instance: { select: { accountId: true, accountName: true } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const seen = new Map<string, number>();
    for (const i of inboxes) seen.set(i.name, (seen.get(i.name) ?? 0) + 1);
    return {
      agents: agents.map((a) => ({ id: String(a.id), name: a.name })),
      inboxes: inboxes.map((i) => ({
        id: String(i.id),
        name: i.name,
        ...((seen.get(i.name) ?? 0) > 1
          ? {
              account: {
                id: i.instance.accountId,
                name: i.instance.accountName,
              },
            }
          : {}),
      })),
    };
  });
}
