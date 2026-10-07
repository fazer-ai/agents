import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  agentRanSql,
  agentTurnSql,
  cohortWhereSql,
  type DashboardFilter,
  localDaySql,
  outcomeSql,
} from "./filter";
import {
  normalizeTimeZone,
  type OutcomeCounts,
  type OutcomeRow,
  outcomeCountsSql,
  toCounts,
} from "./service";

// THE FUNNEL AS A TREND. One point per local day of the conversations' creation, each point the
// funnel tile of a one-day window over the same conversations (outcomeCountsSql), so a single-day
// view reads the same number on the tile and on the line. A breakdown repeats the funnel once per
// agent or inbox, with that agent or inbox as the filter, which is exactly what clicking it applies
// (`seriesSql` computes all of them at once).

export type OutcomeBreakdown = "agent" | "inbox";

export interface OutcomeDay extends OutcomeCounts {
  date: string;
}

export interface OutcomeSeries {
  key: string;
  label: string;
  totals: OutcomeCounts;
  days: OutcomeDay[];
}

export interface OutcomeTrend {
  totals: OutcomeCounts;
  days: OutcomeDay[];
  // Present when a breakdown was asked: one funnel per agent or inbox that has a conversation in the
  // view, largest first.
  series?: OutcomeSeries[];
}

async function daysFor(
  db: PrismaClient | Prisma.TransactionClient,
  f: DashboardFilter,
  tz: string,
): Promise<OutcomeDay[]> {
  const rows = await db.$queryRaw<OutcomeRow[]>(
    outcomeCountsSql(f, { key: localDaySql(Prisma.sql`c.created_at`, tz) }),
  );
  return rows
    .map((r) => ({ date: String(r.key), ...toCounts(r) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Every series of a breakdown in ONE grouped query, totals and days together (GROUPING SETS): the
// series is the funnel the same view would show with that agent or inbox as its filter, so a
// conversation belongs to an agent's series when its inbox is bound to that agent or that agent ran
// on it (`cohortWhereSql`), and is involved when that agent ran on it (`agentRanSql`). An inbox's
// series is plainer: the conversation's own inbox, involvement as the view counts it.
function seriesSql(
  filter: DashboardFilter,
  breakdown: OutcomeBreakdown,
  tz: string,
): Prisma.Sql {
  const members =
    breakdown === "agent"
      ? Prisma.sql`
        ran AS (
          SELECT DISTINCT ar.conversation_id AS id, ar.agent_id AS member
            FROM llm_usage ar
            JOIN base b ON b.id = ar.conversation_id
           WHERE ar.source = 'inbox' AND ${agentTurnSql("ar")} AND ar.agent_id IS NOT NULL
        ),
        members AS (
          SELECT b.id, i.agent_id AS member
            FROM base b JOIN inboxes i ON i.id = b.inbox_id
           WHERE i.agent_id IS NOT NULL
          UNION
          SELECT id, member FROM ran
        ),
        rated AS (
          SELECT m.id, m.member, (r.id IS NOT NULL) AS ran
            FROM members m
            LEFT JOIN ran r ON r.id = m.id AND r.member = m.member
           WHERE (${filter.agentId ?? null}::bigint IS NULL OR m.member = ${filter.agentId ?? null})
        )`
      : Prisma.sql`
        rated AS (
          SELECT b.id, b.inbox_id AS member, b.ran FROM base b
        )`;
  return Prisma.sql`
    WITH base AS (
      SELECT c.id, c.inbox_id,
             ${localDaySql(Prisma.sql`c.created_at`, tz)} AS day,
             ${outcomeSql("c")} AS outcome,
             ${agentRanSql("c", filter.agentId)} AS ran
        FROM conversations c
       WHERE ${cohortWhereSql("c", filter)}
    ),
    ${members}
    SELECT rt.member::text AS member,
           CASE WHEN GROUPING(b.day) = 1 THEN NULL ELSE b.day END AS key,
           COUNT(DISTINCT b.id)::int AS total,
           COUNT(DISTINCT b.id) FILTER (WHERE rt.ran)::int AS involved,
           COUNT(DISTINCT b.id) FILTER (WHERE rt.ran AND b.outcome = 'resolved_by_agent')::int AS resolved,
           COUNT(DISTINCT b.id) FILTER (WHERE rt.ran AND b.outcome = 'handoff')::int AS handoff,
           COUNT(DISTINCT b.id) FILTER (WHERE rt.ran AND b.outcome = 'resolved_before_tracking')::int AS untracked
      FROM rated rt JOIN base b ON b.id = rt.id
     GROUP BY GROUPING SETS ((rt.member), (rt.member, b.day))`;
}

export async function getOutcomeTrend(
  ctx: TenantContext,
  filter: DashboardFilter,
  breakdown?: OutcomeBreakdown,
  base: PrismaClient = basePrisma,
): Promise<OutcomeTrend> {
  const tz = normalizeTimeZone(filter.tz);
  return runScopedOn(base, ctx, async (db) => {
    const [total] = await db.$queryRaw<OutcomeRow[]>(outcomeCountsSql(filter));
    const days = await daysFor(db, filter, tz);
    if (!breakdown) return { totals: toCounts(total), days };
    const rows = await db.$queryRaw<(OutcomeRow & { member: string })[]>(
      seriesSql(filter, breakdown, tz),
    );
    const ids = [...new Set(rows.map((r) => r.member))]
      .map((m) => parseDbId(m))
      .filter((id): id is bigint => id !== null);
    const names = new Map(
      (breakdown === "agent"
        ? await db.agent.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
        : await db.inbox.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
      ).map((r) => [String(r.id), r.name]),
    );
    const byMember = new Map<string, OutcomeSeries>();
    for (const r of rows) {
      const label = names.get(r.member);
      // A member this scope cannot name (an agent of another tenant never reaches here under RLS).
      if (label === undefined) continue;
      const s = byMember.get(r.member) ?? {
        key: r.member,
        label,
        totals: toCounts(undefined),
        days: [],
      };
      if (r.key == null) s.totals = toCounts(r);
      else s.days.push({ date: String(r.key), ...toCounts(r) });
      byMember.set(r.member, s);
    }
    const series = [...byMember.values()];
    for (const s of series) s.days.sort((a, b) => a.date.localeCompare(b.date));
    series.sort((a, b) => b.totals.total - a.totals.total);
    return { totals: toCounts(total), days, series };
  });
}
