import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { readOccurrencesConfig, THEMES_LIMIT_RANGE } from "./settings";

// The themes as the console, REST and MCP read them (docs/occurrences.md). A theme's conversations
// are its members, which a merge moved to the survivor, so an absorbed theme's conversations count
// under the survivor and the absorbed one is not listed.

export { THEMES_LIMIT_RANGE };

// Conversations shown with one theme, newest first; the count is always the whole theme's.
const THEME_CONVERSATIONS_MAX = 200;

export interface ThemeListItem {
  id: string;
  title: string;
  flags: string[];
  // The canonical reference most of its conversations in the recent window share, as the last round
  // counted; null when none of them has a reference, the monitor has no reference field, or the
  // window is empty.
  reference: string | null;
  conversations: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  flaggedAt: string | null;
}

export interface ThemeConversation {
  conversationId: string;
  chatwootConversationId: number;
  url: string;
  sentence: string;
  readAt: string;
  reference: string | null;
  referenceRaw: string | null;
}

export interface ThemeEventView {
  kind: string;
  themeId: string;
  themeTitle: string;
  intoId: string | null;
  at: string;
  detail: unknown;
}

export interface ThemeDetail extends ThemeListItem {
  status: string;
  conversationsShown: ThemeConversation[];
  // The merges into this theme, what consolidation did to it and the split it came from, newest
  // first. A consolidation event's `detail.reason` is the model's sentence on why, when it gave one.
  events: ThemeEventView[];
}

function tenantOf(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  return ctx.tenantId;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export interface ThemeLink {
  chatwootConversationId: number;
  url: string;
}

// The inboxes the monitor reads NOW, from the saved block: every read path filters a theme's
// conversations by them, so taking an inbox off the list takes its conversations off at once, not
// at the next round's assignment (which prunes the memberships for good).
async function monitoredInboxes(
  db: ScopedDb,
  tenantId: bigint,
): Promise<bigint[]> {
  const row = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  return readOccurrencesConfig(row?.settings).inboxIds.map(BigInt);
}

const memberOf = (inboxIds: bigint[]) => ({
  conversation: { inboxId: { in: inboxIds } },
});

const conversationUrl = (c: {
  chatwootConversationId: number;
  instance: { accountId: number; deployment: { baseUrl: string } };
}) =>
  `${c.instance.deployment.baseUrl.replace(/\/+$/, "")}/app/accounts/${c.instance.accountId}/conversations/${c.chatwootConversationId}`;

// The themes a list shows: open, with at least one conversation of a monitored inbox. A theme whose every conversation
// left it (its inbox taken off the monitor, its reason cleared) has nothing to show until one is
// placed in it again.
function openThemesWhere(
  tenantId: bigint,
  inboxIds: bigint[],
  flaggedOnly?: boolean,
) {
  return {
    tenantId,
    status: "open",
    members: { some: memberOf(inboxIds) },
    ...(flaggedOnly ? { NOT: { flags: { isEmpty: true } } } : {}),
  };
}

// How many themes the list has in all, whatever its limit.
export async function countThemes(
  ctx: TenantContext,
  opts: { flaggedOnly?: boolean } = {},
  base: PrismaClient = basePrisma,
): Promise<number> {
  const tenantId = tenantOf(ctx);
  return runScopedOn(base, ctx, async (db) =>
    db.occurrenceTheme.count({
      where: openThemesWhere(
        tenantId,
        await monitoredInboxes(db, tenantId),
        opts.flaggedOnly,
      ),
    }),
  );
}

// Each open theme's conversations of the monitored inboxes: how many, and the first and last read.
async function themeSpans(
  db: ScopedDb,
  tenantId: bigint,
  inboxIds: bigint[],
  flaggedOnly?: boolean,
) {
  const open = await db.occurrenceTheme.findMany({
    where: openThemesWhere(tenantId, inboxIds, flaggedOnly),
    select: { id: true, flaggedAt: true },
  });
  const stats = open.length
    ? await db.occurrenceThemeMember.groupBy({
        by: ["themeId"],
        where: {
          themeId: { in: open.map((t) => t.id) },
          ...memberOf(inboxIds),
        },
        _count: { _all: true },
        _min: { readAt: true },
        _max: { readAt: true },
      })
    : [];
  const statOf = new Map(stats.map((x) => [x.themeId, x]));
  return new Map(
    open.map((t) => {
      const x = statOf.get(t.id);
      return [
        t.id,
        {
          id: t.id,
          flaggedAt: t.flaggedAt,
          count: x?._count._all ?? 0,
          first: x?._min.readAt ?? null,
          last: x?._max.readAt ?? null,
        },
      ];
    }),
  );
}

// The open themes, flagged first, inside a scope the caller holds (the console's, or a dashboard
// panel's metrics read). `links` adds each theme's first conversations, oldest first.
export async function themeRowsOn(
  db: ScopedDb,
  tenantId: bigint,
  opts: { flaggedOnly?: boolean; limit?: number; links?: number } = {},
): Promise<(ThemeListItem & { links?: ThemeLink[] })[]> {
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? 100)),
    THEMES_LIMIT_RANGE.max,
  );
  const inboxIds = await monitoredInboxes(db, tenantId);
  // Counted, dated and ordered over the conversations of the inboxes monitored now: the stored first
  // and last seen still hold an inbox taken off the list until the next assignment prunes it.
  const spans = await themeSpans(db, tenantId, inboxIds, opts.flaggedOnly);
  const time = (d: Date | null) => d?.getTime() ?? -Infinity;
  const order = [...spans.values()]
    .sort(
      (a, b) =>
        time(b.flaggedAt) - time(a.flaggedAt) ||
        time(b.last) - time(a.last) ||
        // Ties broken by the row, so two reads of the same themes list them in the same order.
        (b.id > a.id ? 1 : b.id < a.id ? -1 : 0),
    )
    .filter((_, i) => i < limit);
  const ids = order.map((x) => x.id);
  const rows = ids.length
    ? await db.occurrenceTheme.findMany({ where: { id: { in: ids } } })
    : [];
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const themes = ids
    .map((id) => rowOf.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const referenceIds = themes
    .map((t) => t.flagReferenceId)
    .filter((s): s is bigint => s !== null);
  const names = referenceIds.length
    ? await db.occurrenceCanonical.findMany({
        where: { id: { in: referenceIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const linksOf = new Map<bigint, ThemeLink[]>();
  if (opts.links && ids.length) {
    // One query for every theme's first conversations, then one for their addresses.
    const firsts = await db.$queryRaw<
      { theme_id: bigint; conversation_id: bigint }[]
    >`
      SELECT t.id AS theme_id, f.conversation_id
      FROM unnest(${ids.map(String)}::bigint[]) AS t(id)
      CROSS JOIN LATERAL (
        SELECT m.conversation_id
        FROM occurrence_theme_members m
        JOIN conversations cv ON cv.id = m.conversation_id
                             AND cv.inbox_id = ANY(${inboxIds.map(String)}::bigint[])
        WHERE m.tenant_id = ${tenantId} AND m.theme_id = t.id
        ORDER BY m.read_at ASC, m.id ASC
        LIMIT ${opts.links}
      ) f`;
    const conversations = firsts.length
      ? await db.conversation.findMany({
          where: { id: { in: firsts.map((f) => f.conversation_id) } },
          select: {
            id: true,
            chatwootConversationId: true,
            instance: {
              select: {
                accountId: true,
                deployment: { select: { baseUrl: true } },
              },
            },
          },
        })
      : [];
    const conversationOf = new Map(conversations.map((c) => [c.id, c]));
    for (const f of firsts) {
      const c = conversationOf.get(f.conversation_id);
      if (!c) continue;
      const list = linksOf.get(f.theme_id) ?? [];
      list.push({
        chatwootConversationId: c.chatwootConversationId,
        url: conversationUrl(c),
      });
      linksOf.set(f.theme_id, list);
    }
  }
  return themes.map((t) => ({
    id: String(t.id),
    title: t.title,
    flags: t.flags,
    reference:
      t.flagReferenceId === null
        ? null
        : (nameOf.get(t.flagReferenceId) ?? null),
    conversations: spans.get(t.id)?.count ?? 0,
    firstSeenAt: iso(spans.get(t.id)?.first ?? null),
    lastSeenAt: iso(spans.get(t.id)?.last ?? null),
    flaggedAt: iso(t.flaggedAt),
    ...(opts.links ? { links: linksOf.get(t.id) ?? [] } : {}),
  }));
}

export async function listThemes(
  ctx: TenantContext,
  opts: { flaggedOnly?: boolean; limit?: number } = {},
  base: PrismaClient = basePrisma,
): Promise<ThemeListItem[]> {
  const tenantId = tenantOf(ctx);
  return runScopedOn(base, ctx, (db) => themeRowsOn(db, tenantId, opts));
}

export async function getTheme(
  ctx: TenantContext,
  themeId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ThemeDetail> {
  const tenantId = tenantOf(ctx);
  return runScopedOn(base, ctx, async (db) => {
    const found = await db.occurrenceTheme.findFirst({
      where: { id: themeId, tenantId },
    });
    if (!found) throw new AppError("theme not found", 404);
    // An absorbed theme answers as its survivor: its conversations are there now.
    const t =
      found.mergedIntoId === null
        ? found
        : ((await db.occurrenceTheme.findFirst({
            where: { id: found.mergedIntoId, tenantId },
          })) ?? found);
    const inboxIds = await monitoredInboxes(db, tenantId);
    const span = await db.occurrenceThemeMember.aggregate({
      where: { themeId: t.id, ...memberOf(inboxIds) },
      _count: { _all: true },
      _min: { readAt: true },
      _max: { readAt: true },
    });
    const conversations = span._count._all;
    const members = await db.occurrenceThemeMember.findMany({
      where: { themeId: t.id, ...memberOf(inboxIds) },
      orderBy: { readAt: "desc" },
      take: THEME_CONVERSATIONS_MAX,
      select: {
        conversationId: true,
        sentence: true,
        readAt: true,
        conversation: {
          select: {
            chatwootConversationId: true,
            instance: {
              select: {
                accountId: true,
                deployment: { select: { baseUrl: true } },
              },
            },
          },
        },
      },
    });
    const referenceField = readOccurrencesConfig(
      (
        await db.tenant.findUnique({
          where: { id: tenantId },
          select: { settings: true },
        })
      )?.settings,
    ).referenceField;
    const readings = referenceField
      ? await db.conversationReading.findMany({
          where: {
            conversationId: { in: members.map((m) => m.conversationId) },
            field: referenceField,
          },
          select: {
            conversationId: true,
            value: true,
            canonical: { select: { name: true, mergedIntoId: true } },
          },
        })
      : [];
    const mergedIds = readings
      .map((r) => r.canonical?.mergedIntoId)
      .filter((x): x is bigint => x != null);
    const survivors = mergedIds.length
      ? new Map(
          (
            await db.occurrenceCanonical.findMany({
              where: { id: { in: mergedIds } },
              select: { id: true, name: true },
            })
          ).map((c) => [c.id, c.name]),
        )
      : new Map<bigint, string>();
    const referenceOf = new Map(
      readings.map((r) => [
        r.conversationId,
        {
          raw: r.value === "" ? null : r.value,
          canonical: r.canonical
            ? r.canonical.mergedIntoId === null
              ? r.canonical.name
              : (survivors.get(r.canonical.mergedIntoId) ?? r.canonical.name)
            : null,
        },
      ]),
    );
    const flagReference =
      t.flagReferenceId === null
        ? null
        : await db.occurrenceCanonical.findUnique({
            where: { id: t.flagReferenceId },
            select: { name: true },
          });
    const absorbed = await db.occurrenceTheme.findMany({
      where: { tenantId, mergedIntoId: t.id },
      select: { id: true },
    });
    const lineage = [t.id, ...absorbed.map((a) => a.id)];
    const eventRows = await db.occurrenceThemeEvent.findMany({
      where: {
        tenantId,
        OR: [
          { themeId: { in: lineage } },
          { intoId: t.id },
          // The split that made this theme, or a theme merged into it, one of its parts: the split
          // theme itself is closed and off the list, so its part is where the operator finds why.
          ...lineage.map((id) => ({
            kind: "split",
            detail: { path: ["into"], array_contains: [String(id)] },
          })),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { theme: { select: { title: true } } },
    });
    return {
      id: String(t.id),
      title: t.title,
      status: t.status,
      flags: t.flags,
      reference: flagReference?.name ?? null,
      conversations,
      firstSeenAt: iso(span._min.readAt),
      lastSeenAt: iso(span._max.readAt),
      flaggedAt: iso(t.flaggedAt),
      conversationsShown: members.map((m) => {
        const s = referenceOf.get(m.conversationId);
        return {
          conversationId: String(m.conversationId),
          chatwootConversationId: m.conversation.chatwootConversationId,
          url: conversationUrl(m.conversation),
          sentence: m.sentence,
          readAt: m.readAt.toISOString(),
          reference: s?.canonical ?? null,
          referenceRaw: s?.raw ?? null,
        };
      }),
      events: eventRows.map((e) => ({
        kind: e.kind,
        themeId: String(e.themeId),
        themeTitle: e.theme.title,
        intoId: e.intoId === null ? null : String(e.intoId),
        at: e.createdAt.toISOString(),
        detail: e.detail,
      })),
    };
  });
}
