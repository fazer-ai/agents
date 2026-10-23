import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import { sysCtx } from "./config";
import { type OccurrencesConfig, readOccurrencesConfig } from "./settings";

// THE FLAGS, counted exactly from the members of each open theme (docs/occurrences.md, "Flags": new,
// above its usual, concentrated). A conversation counts at the instant it was first read, and every
// flag needs at least N conversations in the recent window. Concentrated needs a reference field;
// without one it is never raised.

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
  tenantId: bigint,
  given: OccurrencesConfig,
  now: Date,
): Promise<FlagsSummary> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    // Counted over the block saved NOW, read under a share lock on the account's row: a save that
    // takes an inbox off the list (and recounts) waits for this, or this waits for it, so a round
    // that started with the old list never writes back flags from an inbox already taken off.
    const [row] = await db.$queryRaw<{ settings: unknown }[]>`
      SELECT settings FROM tenants WHERE id = ${tenantId} FOR SHARE`;
    const cfg = row ? readOccurrencesConfig(row.settings) : given;
    const windowMs = cfg.windowMinutes * 60_000;
    const windowStart = new Date(now.getTime() - windowMs);
    const horizon = new Date(
      windowStart.getTime() - cfg.previousDays * 86_400_000,
    );
    const earliest = cfg.reasonField
      ? await db.conversationReading.aggregate({
          where: {
            tenantId,
            field: cfg.reasonField,
            conversation: { inboxId: { in: cfg.inboxIds.map(BigInt) } },
          },
          _min: { firstReadAt: true },
        })
      : null;
    const coveredFrom = new Date(
      Math.max(
        horizon.getTime(),
        earliest?._min.firstReadAt?.getTime() ?? windowStart.getTime(),
      ),
    );
    const rows = await db.$queryRaw<
      Array<{ theme_id: bigint; read_at: Date; reference_id: bigint | null }>
    >`
      SELECT m.theme_id, m.read_at,
             COALESCE(c.merged_into_id, c.id) AS reference_id
        FROM occurrence_theme_members m
        JOIN occurrence_themes t ON t.id = m.theme_id AND t.status = 'open'
        JOIN conversations cv ON cv.id = m.conversation_id
                             AND cv.inbox_id = ANY(${cfg.inboxIds}::bigint[])
        LEFT JOIN conversation_readings s
               ON s.conversation_id = m.conversation_id AND s.field = ${cfg.referenceField ?? ""}
        LEFT JOIN occurrence_canonicals c ON c.id = s.canonical_id
       WHERE m.tenant_id = ${tenantId}
         AND m.read_at >= ${horizon}
         AND m.read_at <= ${now}`;
    const counts = new Map<bigint, ThemeCounts>();
    for (const r of rows) {
      const c = counts.get(r.theme_id) ?? {
        window: 0,
        before: 0,
        byReference: new Map<bigint, number>(),
      };
      if (r.read_at >= windowStart) {
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
      where: { tenantId, status: "open" },
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
