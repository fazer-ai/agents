import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type DashboardFilter, localDaySql } from "./filter";
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
// agent or inbox, with that agent or inbox as the filter, which is exactly what clicking it applies.

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
    // The candidates: every agent or inbox of the tenant, narrowed to the one already filtered.
    const candidates: { id: bigint; name: string }[] =
      breakdown === "agent"
        ? await db.agent.findMany({
            where: filter.agentId !== undefined ? { id: filter.agentId } : {},
            select: { id: true, name: true },
          })
        : await db.inbox.findMany({
            where: filter.inboxId !== undefined ? { id: filter.inboxId } : {},
            select: { id: true, name: true },
          });
    const series: OutcomeSeries[] = [];
    for (const c of candidates) {
      const f: DashboardFilter =
        breakdown === "agent"
          ? { ...filter, agentId: c.id }
          : { ...filter, inboxId: c.id };
      const [row] = await db.$queryRaw<OutcomeRow[]>(outcomeCountsSql(f));
      const totals = toCounts(row);
      if (totals.total === 0) continue;
      series.push({
        key: String(c.id),
        label: c.name,
        totals,
        days: await daysFor(db, f, tz),
      });
    }
    series.sort((a, b) => b.totals.total - a.totals.total);
    return { totals: toCounts(total), days, series };
  });
}
