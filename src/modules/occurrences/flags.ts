import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import { sysCtx } from "./config";
import type { MonitorKey } from "./monitors";
import { type OccurrencesConfig, readMonitorConfig } from "./settings";

// THE FLAGS, counted exactly from the members of each open theme (docs/occurrences.md, "Flags": new,
// above its usual, concentrated, and the hold). A conversation counts at the customer message its first
// reading covered, else at the read, so a round that reads late does not move it into the window. Every
// flag needs at least N conversations in the window; concentrated needs a reference field. A theme is
// new while its first conversation is within `newWithinMinutes` with none in the `previousDays` before
// it. A flagged theme that meets no rule is held, its flags kept, until `flagHoldMinutes` have passed
// since the first round it met none.

export type FlagKind = "new" | "above_usual" | "concentrated";

export interface ThemeCounts {
  window: number;
  before: number;
  // Its first conversation since `newWithinMinutes` ago has none of it in the `previousDays` before.
  fresh: boolean;
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
  if (c.fresh) kinds.push("new");
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
  // Flagged themes, the held ones included.
  flagged: number;
}

// What a round writes on one theme, given what it counted and what the theme holds now.
export type FlagWrite =
  // A rule is met: these flags, and the instant first flagged kept or set now.
  | {
      kind: "met";
      flags: FlagKind[];
      referenceId: bigint | null;
      since: "keep" | "now";
    }
  // Flagged and no rule met, inside the hold: the flags stay; `start` when this round is the first.
  | { kind: "held"; start: boolean }
  // Not flagged, or the hold has passed: no flags.
  | { kind: "none"; referenceId: bigint | null };

export function flagWriteOf(
  counted: { kinds: FlagKind[]; referenceId: bigint | null },
  theme: { flags: string[]; flagUnmetSince: Date | null },
  now: Date,
  holdMs: number,
): FlagWrite {
  const flagged = theme.flags.length > 0;
  if (counted.kinds.length > 0)
    return {
      kind: "met",
      flags: counted.kinds,
      referenceId: counted.referenceId,
      since: flagged ? "keep" : "now",
    };
  if (flagged) {
    const unmet = theme.flagUnmetSince ?? now;
    if (now.getTime() - unmet.getTime() < holdMs)
      return { kind: "held", start: theme.flagUnmetSince === null };
  }
  return { kind: "none", referenceId: counted.referenceId };
}

// Recomputes every open theme's flags at `now`. A theme keeps `flaggedAt` while it stays flagged (held
// included), so "flagged since" survives the rounds in between.
export async function runFlagsStep(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  now: Date,
  // A save that changed which conversations count: a held theme's flags were raised over others.
  opts: { releaseHeld?: boolean } = {},
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
    const previousMs = cfg.previousDays * 86_400_000;
    const horizon = new Date(windowStart.getTime() - previousMs);
    // "new" looks back to its first conversation since `newWithinMinutes`, and the days before it.
    const newFrom = new Date(now.getTime() - cfg.newWithinMinutes * 60_000);
    const from = new Date(
      Math.min(horizon.getTime(), newFrom.getTime() - previousMs),
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
           AND m.read_at >= ${from}
           AND m.read_at <= ${now}
      ) counted
       WHERE at >= ${from}`;
    const timesOf = new Map<bigint, number[]>();
    for (const r of rows) {
      const list = timesOf.get(r.theme_id) ?? [];
      list.push(r.at.getTime());
      timesOf.set(r.theme_id, list);
    }
    const counts = new Map<bigint, ThemeCounts>();
    for (const r of rows) {
      const c = counts.get(r.theme_id) ?? {
        window: 0,
        before: 0,
        fresh: isFresh(timesOf.get(r.theme_id) ?? [], newFrom, previousMs),
        byReference: new Map<bigint, number>(),
      };
      if (r.at < horizon) {
        counts.set(r.theme_id, c);
        continue;
      }
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
      select: { id: true, flags: true, flagUnmetSince: true },
    });
    const holdMs = opts.releaseHeld ? 0 : cfg.flagHoldMinutes * 60_000;
    // Grouped by what each theme gets, one update per group: almost every theme gets "no flag", and a
    // round over hundreds of themes stays a handful of statements inside its transaction. A held theme
    // already held writes nothing: its flags, reference and first instants stay as they are.
    let flagged = 0;
    const groups = new Map<string, { ids: bigint[]; data: object }>();
    for (const t of open) {
      const c = counts.get(t.id);
      const counted = c
        ? flagsOf(c, input)
        : { kinds: [] as FlagKind[], referenceId: null };
      const w = flagWriteOf(counted, t, now, holdMs);
      if (w.kind !== "none") flagged += 1;
      if (w.kind === "held" && !w.start) continue;
      const data =
        w.kind === "met"
          ? {
              flags: w.flags,
              flagReferenceId: w.referenceId,
              flagUnmetSince: null,
              ...(w.since === "now" ? { flaggedAt: now } : {}),
            }
          : w.kind === "held"
            ? { flagUnmetSince: now }
            : {
                flags: [],
                flagReferenceId: w.referenceId,
                flaggedAt: null,
                flagUnmetSince: null,
              };
      const key = JSON.stringify(data, (_, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      const g = groups.get(key) ?? { ids: [], data };
      g.ids.push(t.id);
      groups.set(key, g);
    }
    for (const g of groups.values())
      await db.occurrenceTheme.updateMany({
        where: { id: { in: g.ids } },
        data: g.data,
      });
    return { flagged };
  });
}

// New: its first conversation since `newFrom` has none of the theme in the `previousMs` before it.
export function isFresh(
  times: number[],
  newFrom: Date,
  previousMs: number,
): boolean {
  let first = Number.POSITIVE_INFINITY;
  for (const at of times) if (at >= newFrom.getTime() && at < first) first = at;
  if (first === Number.POSITIVE_INFINITY) return false;
  return !times.some((at) => at < first && at >= first - previousMs);
}
