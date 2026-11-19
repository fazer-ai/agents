import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { parseDbId } from "@/lib/db-id";
import type { TenantContext } from "@/lib/tenancy";
import { runMetricsScoped } from "./budget";
import {
  funnelCountsSql,
  funnelSeriesSql,
  withRunsMark,
} from "./conversation-sums";
import { type DashboardFilter, localDaySql } from "./filter";
import { sumsBounds } from "./ledger-sums";
import {
  normalizeTimeZone,
  type OutcomeCounts,
  type OutcomeRow,
  toCounts,
} from "./service";

// THE FUNNEL AS A TREND. One point per local day of the conversations' creation, each point the
// funnel tile of a one-day window over the same conversations (`funnelCountsSql`), so a single-day
// view reads the same number on the tile and on the line. A breakdown repeats the funnel once per
// agent or inbox, with that agent or inbox as the filter, which is exactly what clicking it applies
// (`funnelSeriesSql` computes all of them at once).

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

export async function getOutcomeTrend(
  ctx: TenantContext,
  filter: DashboardFilter,
  breakdown?: OutcomeBreakdown,
  base: PrismaClient = metricsPrisma,
): Promise<OutcomeTrend> {
  const tz = normalizeTimeZone(filter.tz);
  return runMetricsScoped(base, ctx, async (db) => {
    // Every count from the conversation counts (./conversation-sums.ts).
    const view = await withRunsMark(db, filter);
    const bounds = await sumsBounds(db, view);
    const [total] = await db.$queryRaw<OutcomeRow[]>(
      funnelCountsSql(view, bounds),
    );
    const days = (
      await db.$queryRaw<OutcomeRow[]>(
        funnelCountsSql(view, bounds, localDaySql(Prisma.sql`v.quarter`, tz)),
      )
    )
      .map((r) => ({ date: String(r.key), ...toCounts(r) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!breakdown) return { totals: toCounts(total), days };
    const rows = await db.$queryRaw<(OutcomeRow & { member: string })[]>(
      funnelSeriesSql(
        view,
        bounds,
        breakdown,
        localDaySql(Prisma.sql`r.quarter`, tz),
      ),
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
    series.sort(
      (a, b) => b.totals.total - a.totals.total || a.key.localeCompare(b.key),
    );
    return { totals: toCounts(total), days, series };
  });
}
