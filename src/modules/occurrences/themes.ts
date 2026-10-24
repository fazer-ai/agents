import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type ScopedDb } from "@/lib/tenancy";
import { clipText, makeStorable } from "@/lib/text";
import { sysCtx } from "./config";
import type { RoundModels } from "./model";
import type { MonitorKey } from "./monitors";
import type { OccurrencesConfig } from "./settings";

// THEMES (docs/occurrences.md, "Themes"). Every round a model assigns the reason sentences that are
// new since the last one to an open theme, or proposes a new theme; every consolidation cadence a
// model merges, splits and renames the open themes. Similarity is always the model's judgment: this
// code counts, stores and moves what it decided.

// Sentences per assignment call, and calls per round: a backlog drains over a few rounds instead of
// one round sending everything.
const SENTENCES_PER_CALL = 100;
const CALLS_PER_ROUND = 5;
// Open themes shown to the assignment model, and the sample sentences of each. Samples are the
// newest distinct sentences of the theme: a theme of 30 conversations is shown by a few of them.
const THEMES_SHOWN = 200;
export const SAMPLES_PER_THEME = 3;
const CONSOLIDATION_SAMPLES = 5;
// The sentences a split's partition call sees.
const SPLIT_SENTENCES_MAX = 300;
export const THEME_TITLE_MAX = 120;
// The consolidation's one sentence on why it merged, split or renamed, kept with the event.
export const CONSOLIDATION_REASON_MAX = 200;

const ASSIGN_ANSWER = z.object({
  assignments: z.array(
    z.union([
      z.object({ i: z.number().int(), theme: z.string() }),
      z.object({ i: z.number().int(), new: z.string() }),
    ]),
  ),
});

// A reason that is missing or not a string leaves the decision as it was: the decision is applied
// either way, only without its why.
const reasonSchema = z.string().nullish().catch(null);
const CONSOLIDATE_ANSWER = z.object({
  merges: z
    .array(
      z.object({
        absorbed: z.string(),
        into: z.string(),
        reason: reasonSchema,
      }),
    )
    .default([]),
  splits: z
    .array(
      z.object({
        theme: z.string(),
        into: z.array(z.string()).min(2),
        reason: reasonSchema,
      }),
    )
    .default([]),
  renames: z
    .array(
      z.object({ theme: z.string(), title: z.string(), reason: reasonSchema }),
    )
    .default([]),
});

const PARTITION_ANSWER = z.object({
  parts: z.array(z.object({ i: z.number().int(), part: z.number().int() })),
});

// What a theme is, said the same way to the three calls that make and remake themes: a split that
// names broad parts cuts one concrete reason in two, which is the miss this monitor exists to avoid.
export const THEME_IS =
  "A theme is one concrete reason customers came for (one specific request, question or failure), not a broad category.";

const ASSIGN_SYSTEM = `You group the reasons customers contact customer service into themes.
You get the open themes (id, title and a few of their sentences) and a numbered list of new reason sentences, each from a different conversation.
For each sentence, decide whether it is the same reason as an open theme, or a reason no open theme covers.
Answer only JSON: {"assignments":[{"i":0,"theme":"<an open theme id, exactly as listed>"},{"i":1,"new":"<a short title for a new theme>"}]}.
${THEME_IS} Sentences that are the same new reason get the same new title. Write titles in the language of the sentences.`;

const CONSOLIDATE_SYSTEM = `You review the open themes of the reasons customers contact customer service: id, title, how many conversations, and some of their sentences.
Merge themes that are the same reason (into the one that should remain), split a theme that mixes different reasons, and settle a title that does not say what the reason is.
${THEME_IS} A split gives one part per concrete reason the theme mixes, as many as there are, each titled by that reason; it never cuts one reason across two parts. A theme whose sentences are all one reason is not split, even when its title is broad: rename it instead.
Give each decision a reason: one sentence saying what makes the themes the same reason (merge), what separates the parts (split), or what the old title failed to say (rename).
Answer only JSON: {"merges":[{"absorbed":"<id>","into":"<id>","reason":"<sentence>"}],"splits":[{"theme":"<id>","into":["<title>","<title>"],"reason":"<sentence>"}],"renames":[{"theme":"<id>","title":"<title>","reason":"<sentence>"}]}.
Empty lists are valid. Use only listed ids. Write titles and reasons in the language of the sentences.`;

const PARTITION_SYSTEM = `A theme of customer contact reasons is being split into parts. You get the parts (numbered titles) and the theme's numbered sentences.
${THEME_IS} Put each sentence in the part whose reason it states; sentences that state the same reason go to the same part.
Answer only JSON: {"parts":[{"i":0,"part":0}]}.`;

const themeRef = (id: bigint) => `T${id}`;
function parseThemeRef(ref: string): bigint | null {
  const t = ref.trim();
  return parseDbId(t.startsWith("T") ? t.slice(1) : t);
}
// Storable first: a model's title can carry a NUL or half of a surrogate pair, which a `text` column
// or the events' JSON refuses, and one refused title would roll back the whole step.
const titleOf = (raw: string) =>
  clipText(makeStorable(raw.replace(/\s+/g, " ").trim()), THEME_TITLE_MAX);
// The same cleaning for a decision's reason, clipped instead of refused; empty reads as none.
const reasonOf = (raw: string | null | undefined): string | null =>
  raw
    ? clipText(
        makeStorable(raw.replace(/\s+/g, " ").trim()),
        CONSOLIDATION_REASON_MAX,
      ) || null
    : null;

const withReason = (raw: string | null | undefined) => {
  const reason = reasonOf(raw);
  return reason === null ? {} : { reason };
};

// The newest distinct sentences of each theme, read from its newest members only (the index on
// tenant, theme and read_at), so a theme's whole history is never loaded to show a few lines.
const SAMPLE_SCAN = 100;

async function samplesOf(
  db: ScopedDb,
  monitorId: bigint,
  themeIds: bigint[],
  per: number,
): Promise<Map<bigint, string[]>> {
  const out = new Map<bigint, string[]>();
  if (themeIds.length === 0) return out;
  const rows = await db.$queryRaw<{ theme_id: bigint; sentence: string }[]>`
    SELECT t.id AS theme_id, s.sentence
    FROM unnest(${themeIds.map(String)}::bigint[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT recent.sentence
      FROM (
        SELECT m.sentence, m.read_at
        FROM occurrence_theme_members m
        WHERE m.monitor_id = ${monitorId} AND m.theme_id = t.id
        ORDER BY m.read_at DESC
        LIMIT ${SAMPLE_SCAN}
      ) recent
      GROUP BY recent.sentence
      ORDER BY max(recent.read_at) DESC
      LIMIT ${per}
    ) s`;
  // An int8 column comes back from the raw query as a bigint already.
  for (const r of rows)
    out.set(r.theme_id, [...(out.get(r.theme_id) ?? []), r.sentence]);
  return out;
}

// First and last seen follow the members, recomputed for the themes a step touched: two statements,
// whatever the number of themes, so a large step stays inside its transaction's budget.
async function refreshSeen(db: ScopedDb, themeIds: bigint[]): Promise<void> {
  const ids = [...new Set(themeIds)].map(String);
  if (ids.length === 0) return;
  await db.$executeRaw`
    UPDATE occurrence_themes t
       SET first_seen_at = a.first_seen, last_seen_at = a.last_seen
      FROM (SELECT theme_id, min(read_at) AS first_seen, max(read_at) AS last_seen
              FROM occurrence_theme_members
             WHERE theme_id = ANY(${ids}::bigint[])
             GROUP BY theme_id) a
     WHERE t.id = a.theme_id`;
  await db.$executeRaw`
    UPDATE occurrence_themes t
       SET first_seen_at = NULL, last_seen_at = NULL
     WHERE t.id = ANY(${ids}::bigint[])
       AND NOT EXISTS (SELECT 1 FROM occurrence_theme_members m WHERE m.theme_id = t.id)`;
}

export interface AssignmentSummary {
  sent: number;
  assigned: number;
  newThemes: number;
  // Conversations that left their theme: their reason now reads empty, or the reason field changed
  // and they have no reading of the new one.
  removed: number;
}

interface PendingSentence {
  conversationId: bigint;
  sentence: string;
  readAt: Date;
}

// The reason readings no theme holds yet with that sentence: never assigned, or assigned with a
// sentence the reading has since replaced, or from another reading (a reason field switched since,
// whose same words were read at another time). A conversation read again with the same sentence is
// not pending, so it is never sent twice nor counted twice.
async function pendingSentences(
  db: ScopedDb,
  monitorId: bigint,
  reasonField: string,
  inboxIds: string[],
  limit: number,
): Promise<PendingSentence[]> {
  const rows = await db.$queryRaw<
    Array<{ conversation_id: bigint; value: string; first_read_at: Date }>
  >`
    SELECT r.conversation_id, r.value, r.first_read_at
      FROM conversation_readings r
      JOIN conversations c ON c.id = r.conversation_id
      LEFT JOIN occurrence_theme_members m ON m.conversation_id = r.conversation_id
                                          AND m.monitor_id = r.monitor_id
     WHERE r.monitor_id = ${monitorId}
       AND c.inbox_id = ANY(${inboxIds}::bigint[])
       AND r.field = ${reasonField}
       AND r.value <> ''
       AND (m.id IS NULL OR m.sentence <> r.value OR m.read_at <> r.first_read_at)
     ORDER BY r.last_read_at ASC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    sentence: r.value,
    readAt: r.first_read_at,
  }));
}

export async function runAssignmentStep(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  cfg: OccurrencesConfig,
  models: RoundModels,
): Promise<AssignmentSummary> {
  const summary: AssignmentSummary = {
    sent: 0,
    assigned: 0,
    newThemes: 0,
    removed: 0,
  };
  const reason = cfg.reasonField;
  if (reason === null) return summary;
  // A conversation with no reason in the current field has nothing to group: one now read as empty,
  // or one read only for a reason field switched since. Nor does one of an inbox the monitor
  // does not read (taken off the list, or read before the monitor named its inboxes). It leaves its
  // theme, so its old sentence is neither shown nor counted; its readings stay, and it is placed again
  // if its inbox comes back.
  summary.removed = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const emptied = await db.$queryRaw<Array<{ id: bigint; theme_id: bigint }>>`
      SELECT m.id, m.theme_id
        FROM occurrence_theme_members m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE m.monitor_id = ${monitorId}
         AND (
           c.inbox_id IS NULL
           OR NOT (c.inbox_id = ANY(${cfg.inboxIds}::bigint[]))
           OR NOT EXISTS (
             SELECT 1 FROM conversation_readings r
              WHERE r.conversation_id = m.conversation_id
                AND r.monitor_id = m.monitor_id
                AND r.field = ${reason}
                AND r.value <> ''))`;
    if (emptied.length === 0) return 0;
    await db.occurrenceThemeMember.deleteMany({
      where: { id: { in: emptied.map((e) => e.id) } },
    });
    await refreshSeen(
      db,
      emptied.map((e) => e.theme_id),
    );
    return emptied.length;
  });
  for (let call = 0; call < CALLS_PER_ROUND; call += 1) {
    const { pending, themes, samples } = await runScopedOn(
      base,
      sysCtx(tenantId),
      async (db) => {
        const pending = await pendingSentences(
          db,
          monitorId,
          reason,
          cfg.inboxIds,
          SENTENCES_PER_CALL,
        );
        const themes = pending.length
          ? await db.occurrenceTheme.findMany({
              where: { monitorId, status: "open" },
              select: { id: true, title: true },
              orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } },
              take: THEMES_SHOWN,
            })
          : [];
        const samples = await samplesOf(
          db,
          monitorId,
          themes.map((t) => t.id),
          SAMPLES_PER_THEME,
        );
        return { pending, themes, samples };
      },
    );
    if (pending.length === 0) break;
    const user = [
      "Open themes:",
      ...(themes.length > 0
        ? themes.flatMap((t) => [
            `${themeRef(t.id)}: ${t.title}`,
            ...(samples.get(t.id) ?? []).map((s) => `  - ${s}`),
          ])
        : ["(none yet)"]),
      "",
      "New sentences:",
      ...pending.map((p, i) => `${i}. ${p.sentence}`),
    ].join("\n");
    const asked = await models.tryAsk(
      "assignment",
      ASSIGN_SYSTEM,
      user,
      ASSIGN_ANSWER,
    );
    // Sent only when the request reached the model (see canonicals.ts, the same count).
    if (asked.ok || asked.called) summary.sent += pending.length;
    if (!asked.ok) break;
    const answer = asked.value;
    const open = new Set(themes.map((t) => t.id));
    const applied = await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const touched: bigint[] = [];
      // Read once for the whole answer, so the batch is a handful of statements and not a few per
      // sentence: a reading may have changed or cleared a reason while the model ran, and that
      // reading is the next round's.
      const current = new Map(
        (
          await db.conversationReading.findMany({
            where: {
              monitorId,
              conversationId: { in: pending.map((p) => p.conversationId) },
              field: reason,
            },
            select: { conversationId: true, value: true },
          })
        ).map((r) => [r.conversationId, r.value]),
      );
      const placed = new Map<
        number,
        { p: PendingSentence; theme: bigint | string }
      >();
      for (const a of answer.assignments) {
        const p = pending[a.i];
        if (!p || placed.has(a.i)) continue;
        if (current.get(p.conversationId) !== p.sentence) continue;
        if ("theme" in a) {
          const id = parseThemeRef(a.theme);
          if (id !== null && open.has(id)) placed.set(a.i, { p, theme: id });
        } else {
          const title = titleOf(a.new);
          if (title) placed.set(a.i, { p, theme: title });
        }
      }
      const titles = [
        ...new Set(
          [...placed.values()]
            .map((v) => v.theme)
            .filter((t): t is string => typeof t === "string"),
        ),
      ];
      const created = new Map(
        titles.length
          ? (
              await db.occurrenceTheme.createManyAndReturn({
                data: titles.map((title) => ({ tenantId, monitorId, title })),
                select: { id: true, title: true },
              })
            ).map((t) => [t.title, t.id])
          : [],
      );
      const rows = [...placed.values()].map(({ p, theme }) => ({
        p,
        themeId: typeof theme === "string" ? created.get(theme) : theme,
      }));
      const convs = rows.map((r) => r.p.conversationId);
      const before = convs.length
        ? await db.occurrenceThemeMember.findMany({
            where: { monitorId, conversationId: { in: convs } },
            select: { themeId: true },
          })
        : [];
      if (convs.length) {
        await db.occurrenceThemeMember.deleteMany({
          where: { monitorId, conversationId: { in: convs } },
        });
        await db.occurrenceThemeMember.createMany({
          data: rows.flatMap(({ p, themeId }) =>
            themeId === undefined
              ? []
              : [
                  {
                    tenantId,
                    monitorId,
                    themeId,
                    conversationId: p.conversationId,
                    sentence: p.sentence,
                    readAt: p.readAt,
                  },
                ],
          ),
        });
      }
      for (const b of before) touched.push(b.themeId);
      for (const r of rows)
        if (r.themeId !== undefined) touched.push(r.themeId);
      const assigned = rows.filter((r) => r.themeId !== undefined).length;
      const newThemes = created.size;
      await refreshSeen(db, touched);
      return { assigned, newThemes };
    });
    summary.assigned += applied.assigned;
    summary.newThemes += applied.newThemes;
    // A call that placed nothing would be asked the same sentences again.
    if (applied.assigned === 0) break;
  }
  return summary;
}

export interface ConsolidationSummary {
  merges: number;
  splits: number;
  renames: number;
  // The model answered (or there was nothing to ask): the consolidation cadence counts this pass.
  // False when the call was skipped or unreadable, so the next round tries again.
  completed: boolean;
}

// Moves every member of `absorbed` to `survivor` and points every redirect at the survivor, so a
// redirect is always one step: A into B and then B into C leaves A and B both pointing at C.
async function mergeTheme(
  db: ScopedDb,
  { tenantId, monitorId }: MonitorKey,
  absorbed: bigint,
  survivor: bigint,
  runId: bigint | null,
  reason: string | null,
): Promise<void> {
  await db.occurrenceThemeMember.updateMany({
    where: { themeId: absorbed },
    data: { themeId: survivor },
  });
  await db.occurrenceTheme.update({
    where: { id: absorbed },
    data: { status: "merged", mergedIntoId: survivor, flags: [] },
  });
  await db.occurrenceTheme.updateMany({
    where: { monitorId, mergedIntoId: absorbed },
    data: { mergedIntoId: survivor },
  });
  await db.occurrenceThemeEvent.create({
    data: {
      tenantId,
      monitorId,
      kind: "merge",
      themeId: absorbed,
      intoId: survivor,
      runId,
      ...(reason === null ? {} : { detail: { reason } }),
    },
  });
  await refreshSeen(db, [survivor]);
}

export async function runConsolidationStep(
  base: PrismaClient,
  m: MonitorKey,
  models: RoundModels,
  runId: bigint | null,
): Promise<ConsolidationSummary> {
  const summary: ConsolidationSummary = {
    merges: 0,
    splits: 0,
    renames: 0,
    completed: true,
  };
  const { tenantId, monitorId } = m;
  const { themes, counts, samples } = await runScopedOn(
    base,
    sysCtx(tenantId),
    async (db) => {
      const themes = await db.occurrenceTheme.findMany({
        where: { monitorId, status: "open" },
        select: { id: true, title: true },
        orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } },
        take: THEMES_SHOWN,
      });
      const grouped = await db.occurrenceThemeMember.groupBy({
        by: ["themeId"],
        where: { themeId: { in: themes.map((t) => t.id) } },
        _count: { _all: true },
      });
      const counts = new Map(grouped.map((g) => [g.themeId, g._count._all]));
      const samples = await samplesOf(
        db,
        monitorId,
        themes.map((t) => t.id),
        CONSOLIDATION_SAMPLES,
      );
      return { themes, counts, samples };
    },
  );
  if (themes.length === 0) return summary;
  const user = themes
    .flatMap((t) => [
      `${themeRef(t.id)}: ${t.title} (${counts.get(t.id) ?? 0} conversations)`,
      ...(samples.get(t.id) ?? []).map((s) => `  - ${s}`),
    ])
    .join("\n");
  const answer = await models.ask(
    "consolidation",
    CONSOLIDATE_SYSTEM,
    user,
    CONSOLIDATE_ANSWER,
  );
  if (!answer) return { ...summary, completed: false };
  const open = new Set(themes.map((t) => t.id));
  const titles = new Map(themes.map((t) => [t.id, t.title]));

  // Merges, with the answer's own chains flattened first.
  const into = new Map<bigint, bigint>();
  // Each absorbed theme keeps the reason of its own merge, also when a chain sends it further.
  const mergeReason = new Map<bigint, string | null>();
  for (const merge of answer.merges) {
    const a = parseThemeRef(merge.absorbed);
    const b = parseThemeRef(merge.into);
    if (a === null || b === null || a === b || !open.has(a) || !open.has(b))
      continue;
    into.set(a, b);
    mergeReason.set(a, reasonOf(merge.reason));
  }
  const final = (id: bigint): bigint => {
    const seen = new Set<bigint>();
    let cur = id;
    while (into.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = into.get(cur) as bigint;
    }
    return cur;
  };
  const gone = new Set<bigint>();
  for (const absorbed of into.keys()) {
    const survivor = final(absorbed);
    if (survivor === absorbed) continue;
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      mergeTheme(
        db,
        m,
        absorbed,
        survivor,
        runId,
        mergeReason.get(absorbed) ?? null,
      ),
    );
    gone.add(absorbed);
    summary.merges += 1;
  }

  // Splits: the decision names the parts; a second call places each sentence in one.
  for (const s of answer.splits) {
    const id = parseThemeRef(s.theme);
    if (id === null || !open.has(id) || gone.has(id)) continue;
    const parts = s.into.map(titleOf).filter((t) => t !== "");
    if (parts.length < 2) continue;
    const members = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.occurrenceThemeMember.findMany({
        where: { themeId: id },
        select: { id: true, sentence: true },
        orderBy: { readAt: "asc" },
        take: SPLIT_SENTENCES_MAX,
      }),
    );
    if (members.length === 0) continue;
    const partition = await models.ask(
      "consolidation",
      PARTITION_SYSTEM,
      [
        "Parts:",
        ...parts.map((p, i) => `${i}. ${p}`),
        "",
        "Sentences:",
        ...members.map((member, i) => `${i}. ${member.sentence}`),
      ].join("\n"),
      PARTITION_ANSWER,
    );
    // The split was decided and not made: the pass did not complete, and is asked again next round.
    if (!partition) {
      summary.completed = false;
      continue;
    }
    await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const ids: bigint[] = [];
      for (const title of parts)
        ids.push(
          (
            await db.occurrenceTheme.create({
              data: { tenantId, monitorId, title },
              select: { id: true },
            })
          ).id,
        );
      // A sentence the answer left out goes to the first part: a member is never dropped.
      const placed = new Map<number, number>();
      for (const p of partition.parts)
        if (p.part >= 0 && p.part < parts.length) placed.set(p.i, p.part);
      // One update per part, not per member, so a split at the cap stays inside the transaction.
      const byPart = new Map<number, bigint[]>();
      for (const [i, member] of members.entries()) {
        const part = placed.get(i) ?? 0;
        byPart.set(part, [...(byPart.get(part) ?? []), member.id]);
      }
      for (const [part, memberIds] of byPart)
        await db.occurrenceThemeMember.updateMany({
          where: { id: { in: memberIds } },
          data: { themeId: ids[part] as bigint },
        });
      // Members past the cap the partition saw go to the first part too.
      await db.occurrenceThemeMember.updateMany({
        where: { themeId: id },
        data: { themeId: ids[0] as bigint },
      });
      await db.occurrenceTheme.update({
        where: { id },
        data: { status: "split", flags: [] },
      });
      await db.occurrenceThemeEvent.create({
        data: {
          tenantId,
          monitorId,
          kind: "split",
          themeId: id,
          runId,
          detail: {
            into: ids.map(String),
            titles: parts,
            ...withReason(s.reason),
          },
        },
      });
      await refreshSeen(db, ids);
    });
    gone.add(id);
    summary.splits += 1;
  }

  for (const r of answer.renames) {
    const id = parseThemeRef(r.theme);
    const title = titleOf(r.title);
    if (id === null || !open.has(id) || gone.has(id) || !title) continue;
    if (titles.get(id) === title) continue;
    await runScopedOn(base, sysCtx(tenantId), async (db) => {
      await db.occurrenceTheme.update({ where: { id }, data: { title } });
      await db.occurrenceThemeEvent.create({
        data: {
          tenantId,
          monitorId,
          kind: "rename",
          themeId: id,
          runId,
          detail: {
            from: titles.get(id) ?? null,
            to: title,
            ...withReason(r.reason),
          },
        },
      });
    });
    summary.renames += 1;
  }
  return summary;
}
