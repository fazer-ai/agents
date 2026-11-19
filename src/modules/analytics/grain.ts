import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { addDays, dayCount, localDay } from "./days";
import type { DashboardFilter } from "./filter";

// HOW LONG WINDOWS ARE GROUPED. A series of the dashboard has one point per local day up to 92 days,
// one per local week (Monday to Sunday) up to 730 days, and one per local month past that. The route
// takes the grouping from the window, never from the caller, and answers it as `grain`, so the API,
// the MCP tools and the console draw the same groups. A point's key is the first local day of its
// group (the Monday, the first of the month), even when the window starts after it: the group holds
// only the days of the window, and the console names the days it covers.

export const GRAINS = ["day", "week", "month"] as const;
export type Grain = (typeof GRAINS)[number];

export const WEEK_ABOVE_DAYS = 92;
export const MONTH_ABOVE_DAYS = 730;

export function grainOfDays(days: number): Grain {
  if (days > MONTH_ABOVE_DAYS) return "month";
  if (days > WEEK_ABOVE_DAYS) return "week";
  return "day";
}

// The local days a half-open window covers, first and last inclusive.
export function windowDays(since: Date, until: Date, tz: string): number {
  if (until.getTime() <= since.getTime()) return 0;
  return dayCount(localDay(since, tz), localDay(until.getTime() - 1, tz));
}

// The tenant's first conversation or ledger row, whichever is earlier: where an all-time view starts.
// One row each through their (tenant, created_at) index.
export async function firstRecordAt(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<Date | null> {
  const firstConversation = await db.conversation.findFirst({
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const firstUsage = await db.llmUsage.findFirst({
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const starts = [firstConversation?.createdAt, firstUsage?.createdAt]
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());
  return starts[0] ?? null;
}

// The grouping of a request's window. A window with no start begins at the tenant's first record,
// and one with no end ends now; a tenant with no record yet has nothing to group.
export async function windowGrain(
  db: PrismaClient | Prisma.TransactionClient,
  f: DashboardFilter,
  tz: string,
  now: number = Date.now(),
): Promise<Grain> {
  const since = f.since ?? (await firstRecordAt(db));
  if (!since) return "day";
  return grainOfDays(windowDays(since, f.until ?? new Date(now), tz));
}

// The group a local day falls in, by its first day.
export function groupOf(day: string, grain: Grain): string {
  if (grain === "month") {
    const [y, m] = day.split("-");
    return `${y}-${m}-01`;
  }
  if (grain === "week") {
    const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return addDays(day, -((weekday + 6) % 7));
  }
  return day;
}

// A read grouped by local week or month, as the day-level sums see it.
export interface DayGroup {
  tz: string;
  grain: Grain;
}

// Whether the UTC day starting at `day` lies wholly inside one local group: its first and last instant
// fall in the same local week or month. Only such a day can stand for its quarters in a grouped read,
// whose key is worked out from a row's start.
export function insideOneGroupSql(g: DayGroup, day: Prisma.Sql): Prisma.Sql {
  const unit = Prisma.raw(`'${g.grain === "month" ? "month" : "week"}'`);
  const local = (at: Prisma.Sql) =>
    Prisma.sql`date_trunc(${unit}, ${at} AT TIME ZONE 'UTC' AT TIME ZONE ${g.tz}::text)`;
  return Prisma.sql`${local(day)} = ${local(Prisma.sql`(${day} + interval '1 day' - interval '1 microsecond')`)}`;
}
