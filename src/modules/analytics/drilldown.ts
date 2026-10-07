import { Prisma } from "@/../generated/prisma/client";
import type { ScopedDb } from "@/lib/tenancy";
import {
  agentRanSql,
  cohortWhereSql,
  type DashboardFilter,
  outcomeSql,
} from "./filter";

// FROM A DASHBOARD NUMBER TO THE CONVERSATIONS BEHIND IT. The list is asked with the dashboard's own
// view (window of creation, inbox, agent) plus the outcome the clicked figure counts, and answers
// with the conversations `outcomeCountsSql` counted for it: same predicate, so the list's length is
// the number that was clicked. Paged in SQL, in the list's own order (lastEventAt desc nulls last,
// id desc), because the set is defined by an EXISTS over the ledger that the Prisma builder cannot
// express, and an id list of a 90-day window would not fit in a query.

export const DRILL_OUTCOMES = [
  "all",
  "involved",
  "resolved_by_agent",
  "handoff",
] as const;
export type DrillOutcome = (typeof DRILL_OUTCOMES)[number];

export interface DrillDown {
  view: DashboardFilter;
  outcome: DrillOutcome;
}

function outcomeFilterSql(d: DrillDown): Prisma.Sql {
  if (d.outcome === "all") return Prisma.sql`TRUE`;
  const ran = agentRanSql("c", d.view.agentId);
  if (d.outcome === "involved") return ran;
  return Prisma.sql`${ran} AND ${outcomeSql("c")} = ${d.outcome}`;
}

// `%` and `_` are literal in a contact name the operator types.
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function drillDownPageIds(
  db: ScopedDb,
  d: DrillDown,
  opts: { status?: string; q?: string; cursor?: bigint; take: number },
): Promise<bigint[]> {
  const status = opts.status ?? null;
  const term = opts.q?.trim() || null;
  const digits =
    term && /^\d+$/.test(term) && Number.isSafeInteger(Number(term))
      ? Number(term)
      : null;
  let keyset = Prisma.sql`TRUE`;
  if (opts.cursor !== undefined) {
    const cur = await db.conversation.findUnique({
      where: { id: opts.cursor },
      select: { id: true, lastEventAt: true },
    });
    // A cursor this scope cannot see is the end of the list, not its start.
    if (!cur) return [];
    keyset =
      cur.lastEventAt === null
        ? Prisma.sql`(c.last_event_at IS NULL AND c.id < ${cur.id})`
        : Prisma.sql`(c.last_event_at < ${cur.lastEventAt}
                     OR (c.last_event_at = ${cur.lastEventAt} AND c.id < ${cur.id})
                     OR c.last_event_at IS NULL)`;
  }
  const rows = await db.$queryRaw<{ id: bigint }[]>(Prisma.sql`
    SELECT c.id
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id
     WHERE ${cohortWhereSql("c", d.view)}
       AND ${outcomeFilterSql(d)}
       AND (${status}::text IS NULL OR c.status = ${status})
       AND (${term}::text IS NULL
            OR ct.name ILIKE '%' || ${term ? likeEscape(term) : null}::text || '%'
            OR (${digits}::int IS NOT NULL AND c.chatwoot_conversation_id = ${digits}))
       AND ${keyset}
     ORDER BY c.last_event_at DESC NULLS LAST, c.id DESC
     LIMIT ${opts.take}`);
  return rows.map((r) => r.id);
}
