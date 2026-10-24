import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import { sysCtx } from "./config";
import type { MonitorKey } from "./monitors";
import { type OccurrencesConfig, readMonitorConfig } from "./settings";

// THE FLAGS, counted exactly from the members of each open theme (docs/occurrences.md, "Flags": new,
// above its usual, concentrated). A conversation counts at the customer message its first reading
// covered, not at the read: a round that reads late (the per-round cap, the budget, the spend
// ceiling) does not move it into the window, nor keep it there after its message has left. A reading
// stored before that time was kept, or with no customer message, counts at the read. Every flag needs
// at least N conversations in the recent window. Concentrated needs a reference field; without one it
// is never raised.

export type FlagKind = "new" | "above_usual" | "concentrated";

export interface ThemeCounts {
  window: number;
  before: number;
  // Window conversations per canonical reference (the survivor's id); those without one are not here.
  byReference: Map<bigint, number>;
}

export interface FlagInput {
  windowMs: number;
  // The covered time before the window; zero or less when the readings start inside it.
  coveredBeforeMs: number;
  cfg: Pick<
    OccurrencesConfig,
    "newMinConversations" | "aboveUsualRatio" | "concentrationShare"
  >;
}

export function flagsOf(
  c: ThemeCounts,
  input: FlagInput,
): { kinds: FlagKind[]; referenceId: bigint | null } {
  let referenceId: bigint | null = null;
  let top = 0;
  for (const [id, n] of c.byReference)
    if (n > top || (n === top && referenceId !== null && id < referenceId)) {
      top = n;
      referenceId = id;
    }
  const kinds: FlagKind[] = [];
  if (c.window < input.cfg.newMinConversations) return { kinds, referenceId };
  if (c.before === 0) kinds.push("new");
  else if (input.coveredBeforeMs > 0) {
    const windowRate = c.window / input.windowMs;
    const usualRate = c.before / input.coveredBeforeMs;
    if (windowRate >= input.cfg.aboveUsualRatio * usualRate)
      kinds.push("above_usual");
  }
  if (referenceId !== null && top / c.window >= input.cfg.concentrationShare)
    kinds.push("concentrated");
  return { kinds, referenceId };
}

export interface FlagsSummary {
  flagged: number;
}

// Recomputes every open theme's flags at `now`. A theme keeps `flaggedAt` while it stays flagged, so
// "flagged since" survives the rounds in between.
export async function runFlagsStep(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  now: Date,
): Promise<FlagsSummary> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    // Counted over the block saved NOW, read under a share lock on the monitor's row: a save that
    // takes an inbox off the list (and recounts) waits for this, or this waits for it, so a round
    // that started with the old list never writes back flags from an inbox already taken off. A
    // monitor deleted meanwhile has no themes left to flag.
    const [row] = await db.$queryRaw<{ config: unknown }[]>`
      SELECT config FROM occurrence_monitors WHERE id = ${monitorId} FOR SHARE`;
    if (!row) return { flagged: 0 };
    const cfg = readMonitorConfig(row.config);
    const windowMs = cfg.windowMinutes * 60_000;
    const windowStart = new Date(now.getTime() - windowMs);
    const horizon = new Date(
      windowStart.getTime() - cfg.previousDays * 86_400_000,
    );
    // The history covered starts at the earliest conversation counted, by the same time it counts at.
    const [earliest] = cfg.reasonField
      ? await db.$queryRaw<{ at: Date | null }[]>`
          SELECT min(COALESCE(r.first_inbound_at, r.first_read_at)) AS at
            FROM conversation_readings r
            JOIN conversations cv ON cv.id = r.conversation_id
                                 AND cv.inbox_id = ANY(${cfg.inboxIds}::bigint[])
           WHERE r.monitor_id = ${monitorId}
             AND r.field = ${cfg.reasonField}`
      : [];
    const coveredFrom = new Date(
      Math.max(
        horizon.getTime(),
        earliest?.at?.getTime() ?? windowStart.getTime(),
      ),
    );
    // A member counts at the customer message of the reading it was placed from, which it keeps (a
    // reason field switched since does not move it back to its read), else at the read. Only members
    // read by `now` count. A covered message precedes its read, so a member read before the horizon
    // cannot count, and the read's bound keeps the recount on its index as the membership grows.
    const rows = await db.$queryRaw<
      Array<{ theme_id: bigint; at: Date; reference_id: bigint | null }>
    >`
      SELECT theme_id, at, reference_id FROM (
        SELECT m.theme_id, m.read_at,
               COALESCE(m.inbound_at, m.read_at) AS at,
               COALESCE(c.merged_into_id, c.id) AS reference_id
          FROM occurrence_theme_members m
          JOIN occurrence_themes t ON t.id = m.theme_id AND t.status = 'open'
          JOIN conversations cv ON cv.id = m.conversation_id
                               AND cv.inbox_id = ANY(${cfg.inboxIds}::bigint[])
          LEFT JOIN conversation_readings s
                 ON s.conversation_id = m.conversation_id AND s.monitor_id = m.monitor_id
                AND s.field = ${cfg.referenceField ?? ""}
          LEFT JOIN occurrence_canonicals c ON c.id = s.canonical_id
         WHERE m.monitor_id = ${monitorId}
           AND m.read_at >= ${horizon}
           AND m.read_at <= ${now}
      ) counted
       WHERE at >= ${horizon}`;
    const counts = new Map<bigint, ThemeCounts>();
    for (const r of rows) {
      const c = counts.get(r.theme_id) ?? {
        window: 0,
        before: 0,
        byReference: new Map<bigint, number>(),
      };
      if (r.at >= windowStart) {
        c.window += 1;
        if (r.reference_id !== null)
          c.byReference.set(
            r.reference_id,
            (c.byReference.get(r.reference_id) ?? 0) + 1,
          );
      } else c.before += 1;
      counts.set(r.theme_id, c);
    }
    const input: FlagInput = {
      windowMs,
      coveredBeforeMs: windowStart.getTime() - coveredFrom.getTime(),
      cfg,
    };
    const open = await db.occurrenceTheme.findMany({
      where: { monitorId, status: "open" },
      select: { id: true, flags: true, flaggedAt: true },
    });
    // Grouped by what each theme gets, one update per group: almost every theme gets "no flag", and a
    // round over hundreds of themes stays a handful of statements inside its transaction.
    let flagged = 0;
    const groups = new Map<
      string,
      {
        ids: bigint[];
        flags: FlagKind[];
        referenceId: bigint | null;
        flaggedAt: Date | null | "keep";
      }
    >();
    for (const t of open) {
      const c = counts.get(t.id);
      const { kinds, referenceId } = c
        ? flagsOf(c, input)
        : { kinds: [] as FlagKind[], referenceId: null };
      if (kinds.length > 0) flagged += 1;
      // A theme already flagged keeps the instant it was first flagged.
      const flaggedAt =
        kinds.length === 0 ? null : t.flags.length > 0 ? "keep" : now;
      const key = JSON.stringify([
        kinds,
        referenceId === null ? null : String(referenceId),
        flaggedAt === null ? null : flaggedAt === "keep" ? "keep" : "now",
      ]);
      const g = groups.get(key) ?? {
        ids: [],
        flags: kinds,
        referenceId,
        flaggedAt,
      };
      g.ids.push(t.id);
      groups.set(key, g);
    }
    for (const g of groups.values())
      await db.occurrenceTheme.updateMany({
        where: { id: { in: g.ids } },
        data: {
          flags: g.flags,
          flagReferenceId: g.referenceId,
          ...(g.flaggedAt === "keep" ? {} : { flaggedAt: g.flaggedAt }),
        },
      });
    return { flagged };
  });
}
