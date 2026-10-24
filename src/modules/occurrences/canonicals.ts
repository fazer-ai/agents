import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type ScopedDb } from "@/lib/tenancy";
import { ChatwootCalledOffError } from "@/modules/chatwoot/client";
import {
  type LoadChatwootClientDeps,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import { copyStillSaved, sysCtx } from "./config";
import type { RoundModels } from "./model";
import type { MonitorKey } from "./monitors";
import { REMOTE_BEFORE_MAX, readingValue } from "./readings";
import type { OccurrencesConfig } from "./settings";

// CANONICAL REFERENCES (docs/occurrences.md, "Canonical references"). The reference field's free spellings
// are fitted by a model to canonical names; the alias dictionary remembers each decision by the exact
// spelling, so the same spelling is never asked again. This code never judges two spellings alike:
// an unseen spelling, however close to a known one, goes to the model.

// Spellings per call, and canonical names shown per call.
const RAWS_PER_CALL = 100;
const CANONICALS_SHOWN = 300;

export interface CanonicalStepSummary {
  asked: number;
  fitted: number;
  created: number;
  fromAliases: number;
  // Chatwoot attributes that now hold their canonical name.
  copied: number;
}

const FIT_ANSWER = z.object({
  fits: z.array(
    z.union([
      z.object({ i: z.number().int(), canonical: z.string() }),
      z.object({ i: z.number().int(), new: z.string() }),
    ]),
  ),
});

const MERGE_ANSWER = z.object({
  merges: z.array(z.object({ absorbed: z.string(), into: z.string() })),
});

const FIT_SYSTEM = `You unify the free spellings of one field of customer-service conversations into canonical names.
You get the canonical names that exist and a numbered list of spellings. For each spelling, decide whether it names the same thing as an existing canonical name, or something new.
Answer only JSON: {"fits":[{"i":0,"canonical":"<an existing name, exactly as listed>"},{"i":1,"new":"<a short canonical name>"}]}.
Give a new name only when no existing one is the same thing. Write a new name the way the conversations would, without inventing details. Spellings that are the same new thing get the same new name.`;

const MERGE_SYSTEM = `You review the canonical names of one field of customer-service conversations, each with how many conversations use it.
Find names that are the same thing and should be one. Merge only into a name that exists; never invent or rename one.
Answer only JSON: {"merges":[{"absorbed":"<existing name>","into":"<existing name>"}]}. An empty list is a valid answer.`;

// A canonical's final survivor, following the redirect, which is always one step.
async function survivorOf(
  db: ScopedDb,
  id: bigint,
): Promise<{ id: bigint; name: string } | null> {
  const row = await db.occurrenceCanonical.findUnique({
    where: { id },
    select: { id: true, name: true, mergedIntoId: true },
  });
  if (!row) return null;
  if (row.mergedIntoId === null) return { id: row.id, name: row.name };
  return db.occurrenceCanonical.findUnique({
    where: { id: row.mergedIntoId },
    select: { id: true, name: true },
  });
}

// Each canonical's final survivor, for many at once: two reads whatever their number, so a backlog
// of known spellings resolves inside its transaction's budget.
async function survivorsOf(
  db: ScopedDb,
  ids: bigint[],
): Promise<Map<bigint, { id: bigint; name: string }>> {
  const out = new Map<bigint, { id: bigint; name: string }>();
  if (ids.length === 0) return out;
  const rows = await db.occurrenceCanonical.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true, mergedIntoId: true },
  });
  const into = rows
    .map((r) => r.mergedIntoId)
    .filter((id): id is bigint => id !== null);
  const targets = new Map(
    (into.length
      ? await db.occurrenceCanonical.findMany({
          where: { id: { in: [...new Set(into)] } },
          select: { id: true, name: true },
        })
      : []
    ).map((t) => [t.id, t]),
  );
  for (const r of rows) {
    const s =
      r.mergedIntoId === null
        ? { id: r.id, name: r.name }
        : targets.get(r.mergedIntoId);
    if (s) out.set(r.id, s);
  }
  return out;
}

interface Pending {
  readingId: bigint;
  conversationId: bigint;
  value: string;
}

// Copies per round. Newest readings first, so a conversation Chatwoot keeps refusing never holds
// back the ones a folder is waiting for.
const COPIES_PER_ROUND = 200;

export async function rememberPosted(
  base: PrismaClient,
  tenantId: bigint,
  id: bigint,
  name: string,
): Promise<void> {
  // One statement, so a correction holding the row is waited for and its leftovers are appended to,
  // not overwritten with the array as it stood before it.
  await runScopedOn(
    base,
    sysCtx(tenantId),
    (db) =>
      db.$executeRaw`
      UPDATE conversation_readings
      SET remote_before = (remote_before || ARRAY[${name}]::text[])[
        greatest(cardinality(remote_before) + 2 - ${REMOTE_BEFORE_MAX}, 1):]
      WHERE id = ${id} AND NOT (${name} = ANY (remote_before))`,
  );
}

// Writes the canonical name to the conversation's Chatwoot attribute, replacing the raw spelling the
// observer wrote, so a folder filters by the canonical. Every write of a reading clears
// `canonical_written` (the observer has just written its spelling there), and a copy that did not
// happen (a failure, the round's budget) is tried again next round.
async function copyCanonicalAttributes(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  key: string,
  inboxIds: string[],
  budget: AbortSignal,
  makeClient?: LoadChatwootClientDeps["makeClient"],
  limit = COPIES_PER_ROUND,
): Promise<number> {
  const due = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversationReading.findMany({
      where: {
        monitorId,
        field: key,
        canonicalId: { not: null },
        canonicalWritten: false,
        // A conversation of an inbox the monitor no longer reads is left as Chatwoot has it.
        conversation: { inboxId: { in: inboxIds.map(BigInt) } },
      },
      select: {
        id: true,
        value: true,
        lastReadAt: true,
        canonicalId: true,
        writtenName: true,
        remoteBefore: true,
        conversation: {
          select: {
            chatwootInstanceId: true,
            chatwootConversationId: true,
            inboxId: true,
          },
        },
      },
      // Never tried first, then the ones that failed longest ago, so one that keeps failing cannot
      // hold the batch; newest readings first within each.
      orderBy: [
        { copyTriedAt: { sort: "asc", nulls: "first" } },
        { lastReadAt: "desc" },
      ],
      take: limit,
    }),
  );
  // The reading as it was chosen: one the observer wrote since is its own value again.
  // Still pending, too: a `/reset` withdraws the copy (`withdrawReadingCopies`).
  const unchanged = (r: (typeof due)[number]) => ({
    id: r.id,
    canonicalId: r.canonicalId,
    lastReadAt: r.lastReadAt,
    canonicalWritten: false,
  });
  const names = new Map<bigint, string | null>();
  const clients = new Map<
    bigint,
    Awaited<ReturnType<typeof loadChatwootClient>>
  >();
  let copied = 0;
  for (const r of due) {
    if (budget.aborted) break;
    const canonicalId = r.canonicalId as bigint;
    if (!names.has(canonicalId))
      names.set(
        canonicalId,
        (
          await runScopedOn(base, sysCtx(tenantId), (db) =>
            survivorOf(db, canonicalId),
          )
        )?.name ?? null,
      );
    // The name this conversation was given before, when it was: a merge since moves the reading to
    // the survivor for counting, and a folder built on the old name keeps the conversation.
    const name = r.writtenName ?? names.get(canonicalId);
    if (!name) continue;
    try {
      // Written even when the canonical is the spelling itself, unless Chatwoot is seen holding it:
      // the reading's own write of it may have failed.
      const inst = r.conversation.chatwootInstanceId;
      let client = clients.get(inst);
      if (!client) {
        client = await loadChatwootClient(tenantId, inst, {
          base,
          expiresOn: budget,
          ...(makeClient ? { makeClient } : {}),
        });
        clients.set(inst, client);
      }
      // Asked inside the conversation's write queue, right before the POST: the reading is still the
      // one chosen, and Chatwoot holds that spelling, nothing, the canonical, or what it held before
      // this spelling (the observer's own write failed). Anything else is a newer observer write,
      // which can land before its reading is stored and from another process; whatever slips past
      // this read is rewritten next round, since that reading clears `canonical_written`.
      const cw = r.conversation.chatwootConversationId;
      const mark = () =>
        runScopedOn(base, sysCtx(tenantId), (db) =>
          db.conversationReading.updateMany({
            where: unchanged(r),
            data: { canonicalWritten: true, writtenName: name },
          }),
        );
      // Chatwoot already holds the name (the reading wrote this spelling earlier in the round, and it
      // is its own canonical): marked written with no second POST of the same value. Unreadable, it
      // fails closed as the fence below does: nothing posted, tried next round.
      let held: unknown;
      try {
        held = (
          (await client.getConversation(cw)) as {
            custom_attributes?: Record<string, unknown>;
          } | null
        )?.custom_attributes?.[key];
      } catch {
        await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.conversationReading.updateMany({
            where: { id: r.id },
            data: { copyTriedAt: new Date() },
          }),
        ).catch(() => undefined);
        continue;
      }
      if (held === name) {
        copied += (await mark()).count;
        continue;
      }
      await client.setConversationCustomAttributes(
        cw,
        { [key]: name },
        {
          asAdmin: true,
          // Fails closed: the client reads a fence that throws as wanted, and a copy written without
          // knowing what Chatwoot holds could overwrite a newer value. Not written, it is tried next
          // round.
          stillWanted: async () => {
            try {
              // The monitor as saved now still copies the reference on this inbox (config.ts).
              if (
                !(await copyStillSaved(
                  base,
                  { tenantId, monitorId },
                  r.conversation.inboxId,
                  [key],
                ))
              )
                return false;
              const still = await runScopedOn(base, sysCtx(tenantId), (db) =>
                db.conversationReading.count({ where: unchanged(r) }),
              );
              if (still === 0) return false;
              const remote = (
                (await client.getConversation(cw)) as {
                  custom_attributes?: Record<string, unknown>;
                } | null
              )?.custom_attributes?.[key];
              return (
                remote === undefined ||
                remote === null ||
                remote === "" ||
                remote === r.value ||
                remote === name ||
                (typeof remote === "string" && r.remoteBefore.includes(remote))
              );
            } catch {
              return false;
            }
          },
        },
      );
      const marked = await mark();
      copied += marked.count;
      // A reading that changed after the check: Chatwoot may now hold the name just posted, so it is
      // one the next copy accepts as a leftover rather than a newer write.
      if (marked.count === 0) await rememberPosted(base, tenantId, r.id, name);
    } catch (err) {
      logger.warn(
        { tenantId: String(tenantId), readingId: String(r.id), err },
        "occurrences: canonical attribute write failed",
      );
      // A write that got past its fence may have landed with its answer lost: the name is kept among
      // the leftovers, so a reading corrected meanwhile can still have it replaced.
      if (!(err instanceof ChatwootCalledOffError))
        await rememberPosted(base, tenantId, r.id, name).catch(() => undefined);
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversationReading.updateMany({
          where: { id: r.id },
          data: { copyTriedAt: new Date() },
        }),
      ).catch(() => undefined);
    }
  }
  return copied;
}

// Fits every reference reading that has no canonical yet: from the alias dictionary when the exact
// spelling was decided before, from the model otherwise. An empty reference is the no-reference
// bucket and is never sent nor given a canonical. A monitor with no reference field has nothing to fit.
export async function runCanonicalStep(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  cfg: OccurrencesConfig,
  models: RoundModels,
): Promise<CanonicalStepSummary> {
  const summary: CanonicalStepSummary = {
    asked: 0,
    fitted: 0,
    created: 0,
    fromAliases: 0,
    copied: 0,
  };
  const reference = cfg.referenceField;
  if (reference === null) return summary;
  const pending: Pending[] = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversationReading
      .findMany({
        where: {
          monitorId,
          field: reference,
          canonicalId: null,
          value: { not: "" },
          conversation: { inboxId: { in: cfg.inboxIds.map(BigInt) } },
        },
        select: { id: true, conversationId: true, value: true },
        orderBy: { lastReadAt: "asc" },
        take: 2_000,
      })
      .then((rows) =>
        rows.map((r) => ({
          readingId: r.id,
          conversationId: r.conversationId,
          value: r.value,
        })),
      ),
  );

  // From the dictionary: exact spellings decided before.
  const raws = [...new Set(pending.map((p) => p.value))];
  const known = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const aliases = await db.occurrenceAlias.findMany({
      where: { monitorId, field: reference, raw: { in: raws } },
      select: { raw: true, canonicalId: true },
    });
    const survivors = await survivorsOf(
      db,
      aliases.map((a) => a.canonicalId),
    );
    const out = new Map<string, { id: bigint; name: string }>();
    for (const a of aliases) {
      const s = survivors.get(a.canonicalId);
      if (s) out.set(a.raw, s);
    }
    return out;
  });
  // Binds the canonical to the readings that still hold `raw`: a reading the observer changed
  // meanwhile keeps its new value and its own fit. The copy flag is left as it stands: every reading
  // write cleared it, and a reset since then set it to withdraw the copy.
  const apply = async (
    raw: string,
    canonical: { id: bigint; name: string },
  ) => {
    const ids = pending.filter((p) => p.value === raw).map((p) => p.readingId);
    const bound = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversationReading.updateMany({
        where: { id: { in: ids }, value: raw, canonicalId: null },
        data: { canonicalId: canonical.id },
      }),
    );
    return bound.count;
  };
  for (const [raw, canonical] of known)
    summary.fromAliases += await apply(raw, canonical);

  // From the model: every spelling the dictionary has never seen.
  const unseen = raws.filter((r) => !known.has(r));
  for (let at = 0; at < unseen.length; at += RAWS_PER_CALL) {
    const batch = unseen.slice(at, at + RAWS_PER_CALL);
    const names = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.occurrenceCanonical.findMany({
        where: { monitorId, field: reference, mergedIntoId: null },
        select: { id: true, name: true },
        orderBy: { createdAt: "desc" },
        take: CANONICALS_SHOWN,
      }),
    );
    const asked = await models.tryAsk(
      "canonical",
      FIT_SYSTEM,
      [
        "Existing canonical names:",
        ...(names.length > 0
          ? names.map((n) => `- ${n.name}`)
          : ["(none yet)"]),
        "",
        "Spellings:",
        ...batch.map((raw, i) => `${i}. ${raw}`),
      ].join("\n"),
      FIT_ANSWER,
    );
    // Counted as sent only when the request reached the model, so the detail never says spellings
    // went to a model the round made no call to.
    if (asked.ok || asked.called) summary.asked += batch.length;
    if (!asked.ok) break;
    const answer = asked.value;
    const byName = new Map(names.map((n) => [n.name, n]));
    // A spelling the answer fits twice keeps its first fit, so its alias and its readings agree.
    const fitted = new Set<number>();
    for (const fit of answer.fits) {
      const raw = batch[fit.i];
      if (raw === undefined || fitted.has(fit.i)) continue;
      fitted.add(fit.i);
      // Stored as a reading is: a model's text can carry what a `text` column refuses.
      const wanted = readingValue("canonical" in fit ? fit.canonical : fit.new);
      if (!wanted) continue;
      const canonical = await runScopedOn(
        base,
        sysCtx(tenantId),
        async (db) => {
          let target = byName.get(wanted) ?? null;
          if (!target) {
            // A name the model calls existing but that is not, or a new one: the row by that exact
            // name, created when absent. Two spellings given the same new name share it.
            const existing = await db.occurrenceCanonical.findUnique({
              where: {
                monitorId_field_name: {
                  monitorId,
                  field: reference,
                  name: wanted,
                },
              },
              select: { id: true },
            });
            if (existing) {
              target = await survivorOf(db, existing.id);
            } else {
              const created = await db.occurrenceCanonical.create({
                data: { tenantId, monitorId, field: reference, name: wanted },
                select: { id: true, name: true },
              });
              summary.created += 1;
              target = created;
            }
            if (target) byName.set(wanted, target);
          }
          if (!target) return null;
          await db.occurrenceAlias.upsert({
            where: {
              monitorId_field_raw: { monitorId, field: reference, raw },
            },
            create: {
              tenantId,
              monitorId,
              field: reference,
              raw,
              canonicalId: target.id,
            },
            update: { canonicalId: target.id },
          });
          return target;
        },
      );
      if (canonical) summary.fitted += await apply(raw, canonical);
    }
  }
  return summary;
}

// The copies of the canonical names to Chatwoot, the round's last step: an optional side effect, so
// a slow or unreachable Chatwoot spends only what the analytical steps left.
export async function runCanonicalCopy(
  base: PrismaClient,
  m: MonitorKey,
  cfg: OccurrencesConfig,
  budget: AbortSignal,
  makeClient?: LoadChatwootClientDeps["makeClient"],
  limit?: number,
): Promise<number> {
  const field = cfg.fields.find((f) => f.key === cfg.referenceField);
  if (!field?.attribute) return 0;
  return copyCanonicalAttributes(
    base,
    m,
    field.key,
    cfg.inboxIds,
    budget,
    makeClient,
    limit,
  );
}

export interface CanonicalMergeSummary {
  merges: number;
  // As a theme consolidation's: false when the call was skipped or unreadable.
  completed: boolean;
}

// Canonical consolidation: merges a canonical into another that exists, never renames one. The
// absorbed name's aliases and readings follow the survivor; conversations already written to Chatwoot
// keep the name they have, so a folder built on it keeps its conversations.
export async function runCanonicalConsolidation(
  base: PrismaClient,
  { tenantId, monitorId }: MonitorKey,
  cfg: OccurrencesConfig,
  models: RoundModels,
): Promise<CanonicalMergeSummary> {
  const summary: CanonicalMergeSummary = { merges: 0, completed: true };
  const reference = cfg.referenceField;
  if (reference === null) return summary;
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.occurrenceCanonical.findMany({
      where: { monitorId, field: reference, mergedIntoId: null },
      select: { id: true, name: true, _count: { select: { readings: true } } },
      orderBy: { createdAt: "desc" },
      take: CANONICALS_SHOWN,
    }),
  );
  if (rows.length < 2) return summary;
  // The canonicals' own model: the merge is the same judgment the fit makes, over names instead of
  // spellings.
  const answer = await models.ask(
    "canonical",
    MERGE_SYSTEM,
    rows.map((r) => `- ${r.name} (${r._count.readings})`).join("\n"),
    MERGE_ANSWER,
  );
  if (!answer) return { ...summary, completed: false };
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  // The answer's own chains are flattened before anything is written: A into B and B into C is A
  // and B into C.
  const into = new Map<bigint, bigint>();
  for (const m of answer.merges) {
    const a = byName.get(m.absorbed);
    const b = byName.get(m.into);
    if (a === undefined || b === undefined || a === b) continue;
    into.set(a, b);
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
  for (const absorbed of into.keys()) {
    const survivor = final(absorbed);
    if (survivor === absorbed) continue;
    await runScopedOn(base, sysCtx(tenantId), async (db) => {
      await db.occurrenceCanonical.update({
        where: { id: absorbed },
        data: { mergedIntoId: survivor },
      });
      await db.occurrenceCanonical.updateMany({
        where: { monitorId, mergedIntoId: absorbed },
        data: { mergedIntoId: survivor },
      });
      await db.occurrenceAlias.updateMany({
        where: { monitorId, canonicalId: absorbed },
        data: { canonicalId: survivor },
      });
      await db.conversationReading.updateMany({
        where: { monitorId, canonicalId: absorbed },
        data: { canonicalId: survivor },
      });
    });
    summary.merges += 1;
  }
  return summary;
}
