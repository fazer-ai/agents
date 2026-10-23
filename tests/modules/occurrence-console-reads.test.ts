import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { STEP_NODE } from "@/modules/occurrences/model";
import {
  MONITOR_NODES,
  occurrenceCost,
  pageOccurrenceRuns,
  parseSkipped,
  runSteps,
} from "@/modules/occurrences/runs";
import { OCCURRENCE_STEPS } from "@/modules/occurrences/settings";
import { countThemes, getTheme, listThemes } from "@/modules/occurrences/views";
import { dbProbeFailed } from "@/tests/db-gate";

// What the occurrence console reads (docs/occurrences.md, "Console"): the rounds a page at a time,
// keyed on the last round shown so a round that starts meanwhile shifts nothing; what each step did,
// in fields a screen can say in words; the monitor's cost over 7 and 30 days, from the ledger lines
// the dashboard shows; and the themes' total past the list's limit.

describe("a round's steps as stored", () => {
  test("a skip line is read back as its step, its reason and its count", () => {
    expect(parseSkipped("reading: round budget (3x)")).toEqual({
      step: "reading",
      reason: "round_budget",
      message: null,
      inbox: null,
      count: 3,
    });
    expect(parseSkipped("consolidation: unreadable answer")).toEqual({
      step: "consolidation",
      reason: "unreadable_answer",
      message: null,
      inbox: null,
      count: 1,
    });
    expect(parseSkipped("canonical: spend ceiling")).toMatchObject({
      reason: "spend_ceiling",
    });
    expect(parseSkipped("assignment: no model is set")).toMatchObject({
      step: "assignment",
      reason: "no_model",
    });
    // A provider's error keeps its text, colons included, under the code it most likely means.
    expect(parseSkipped("reading: 401: invalid key: sk-*** (2x)")).toEqual({
      step: "reading",
      reason: "credential_refused",
      message: "401: invalid key: sk-***",
      inbox: null,
      count: 2,
    });
    expect(parseSkipped("something else")).toEqual({
      step: null,
      reason: "error",
      message: "something else",
      inbox: null,
      count: 1,
    });
  });

  test("the monitor's own reasons and a provider's common errors come back as codes, never as English text", () => {
    const reason = (line: string) => parseSkipped(line).reason;
    expect(reason("reading: the credential does not resolve")).toBe(
      "credential_unresolved",
    );
    expect(reason("reading: the credential (oauth) is not an API key")).toBe(
      "credential_not_key",
    );
    expect(
      reason("reading: an openai-compatible model needs an endpoint"),
    ).toBe("endpoint_missing");
    expect(reason("reading: a anthropic model does not take an endpoint")).toBe(
      "endpoint_not_taken",
    );
    expect(
      reason(
        "reading: the credential carries an endpoint a google model does not take",
      ),
    ).toBe("endpoint_not_taken");
    expect(reason("canonical: no model id")).toBe("no_model");
    expect(reason("assignment: 404 The model `gpt-9` does not exist")).toBe(
      "model_refused",
    );
    expect(reason("assignment: 429 Rate limit reached")).toBe("rate_limited");
    expect(reason("reading: Request timed out.")).toBe("timeout");
    expect(reason("reading: fetch failed: ECONNREFUSED 127.0.0.1:9")).toBe(
      "endpoint_unreachable",
    );
    expect(reason("reading: 500 Internal Server Error")).toBe("error");
    // What the provider boundary leaves: a closed vocabulary, and the round's own connection check.
    expect(reason("reading: HTTP 401")).toBe("credential_refused");
    expect(reason("reading: HTTP 404")).toBe("model_refused");
    expect(reason("reading: HTTP 429")).toBe("rate_limited");
    expect(reason("reading: timeout")).toBe("timeout");
    expect(reason("reading: endpoint unreachable")).toBe(
      "endpoint_unreachable",
    );
    expect(reason("reading: provider error")).toBe("error");
    expect(reason("reading: HTTP 500")).toBe("error");
    expect(
      parseSkipped('reading: no agent receives the inbox "E-mail Financeiro"'),
    ).toEqual({
      step: "reading",
      reason: "inbox_unreceived",
      message: null,
      inbox: "E-mail Financeiro",
      count: 1,
    });
  });

  test("each step's counts come out by name, a step the round never reached is null", () => {
    const steps = runSteps({
      reading: { read: 4, failed: 1, withdrawn: 0, pending: 7 },
      canonical: { asked: 3, fitted: 1, created: 2, fromAliases: 0, copied: 1 },
      assignment: { sent: 4, assigned: 2, newThemes: 2, removed: 1 },
      flags: { flagged: 1 },
      skipped: ["consolidation: round budget"],
    });
    expect(steps.reading).toEqual({
      read: 4,
      failed: 1,
      withdrawn: 0,
      pending: 7,
    });
    expect(steps.canonical).toEqual({ asked: 3, created: 2, copied: 1 });
    expect(steps.assignment).toEqual({
      sent: 4,
      assigned: 2,
      newThemes: 2,
      removed: 1,
    });
    expect(steps.consolidation).toBeNull();
    expect(steps.flags).toEqual({ flagged: 1 });
    expect(steps.skipped).toHaveLength(1);
    const consolidated = runSteps({
      consolidation: { merges: 2, splits: 1, renames: 0, completed: true },
      canonicalMerges: { merges: 3, completed: true },
    }).consolidation;
    expect(consolidated).toEqual({
      merges: 2,
      splits: 1,
      renames: 0,
      referenceMerges: 3,
      completed: true,
    });
    // Either half unfinished is an unfinished consolidation.
    expect(
      runSteps({
        consolidation: { merges: 0, splits: 0, renames: 0, completed: true },
        canonicalMerges: { merges: 0, completed: false },
      }).consolidation?.completed,
    ).toBe(false);
    expect(runSteps({}).reading).toBeNull();
  });

  test("the cost reads the ledger lines each step is billed under, and the media recovery's", () => {
    expect([...MONITOR_NODES].sort()).toEqual(
      [
        ...OCCURRENCE_STEPS.map((s) => STEP_NODE[s]),
        "occurrence_transcription",
        "occurrence_vision",
      ].sort(),
    );
  });
});

let appDb: PrismaClient;
let suDb: PrismaClient;
let dbUp = true;

if (!process.env.TEST_APP_DATABASE_URL) {
  dbUp = false;
} else {
  appDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_APP_DATABASE_URL,
    }),
  });
  suDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_MIGRATION_DATABASE_URL,
    }),
  });
  try {
    await suDb.$queryRaw`SELECT 1`;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

describe.skipIf(!dbUp)("against the database", () => {
  let tenantId = 0n;
  let otherTenantId = 0n;
  const ctx = (id = tenantId): TenantContext => ({
    tenantId: id,
    userId: null,
    role: "TENANT_ADMIN",
  });
  const base = new Date("2026-10-19T12:00:00.000Z");
  const minute = 60_000;

  beforeAll(async () => {
    const mk = async (slug: string) =>
      (
        await suDb.tenant.create({
          data: { name: slug, slug: `${slug}-${process.pid}` },
        })
      ).id;
    tenantId = await mk("occ-console");
    otherTenantId = await mk("occ-console-other");
  });

  afterAll(async () => {
    await suDb.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("rounds page by the last one shown: a round that starts between pages shifts nothing", async () => {
    for (let i = 0; i < 5; i += 1)
      await suDb.occurrenceRun.create({
        data: {
          tenantId,
          startedAt: new Date(base.getTime() - i * 15 * minute),
          status: "ok",
          detail: { reading: { read: i, failed: 0, withdrawn: 0, pending: 0 } },
        },
      });
    // Another account's rounds are neither listed nor counted.
    await suDb.occurrenceRun.create({
      data: { tenantId: otherTenantId, startedAt: base, status: "ok" },
    });
    const first = await pageOccurrenceRuns(ctx(), { limit: 2 }, appDb);
    expect(first.total).toBe(5);
    expect(first.runs.map((r) => r.steps.reading?.read)).toEqual([0, 1]);
    expect(first.nextBefore).not.toBeNull();
    // A new round starts while the first page is on screen.
    await suDb.occurrenceRun.create({
      data: {
        tenantId,
        startedAt: new Date(base.getTime() + 15 * minute),
        status: "running",
      },
    });
    const second = await pageOccurrenceRuns(
      ctx(),
      { limit: 2, before: first.nextBefore },
      appDb,
    );
    expect(second.runs.map((r) => r.steps.reading?.read)).toEqual([2, 3]);
    expect(second.total).toBe(6);
    const third = await pageOccurrenceRuns(
      ctx(),
      { limit: 2, before: second.nextBefore },
      appDb,
    );
    expect(third.runs.map((r) => r.steps.reading?.read)).toEqual([4]);
    expect(third.nextBefore).toBeNull();
    // A cursor from another account names no round here.
    const theirs = await suDb.occurrenceRun.findFirstOrThrow({
      where: { tenantId: otherTenantId },
    });
    const foreign = await pageOccurrenceRuns(
      ctx(),
      { limit: 2, before: String(theirs.id) },
      appDb,
    );
    expect(foreign.runs).toEqual([]);
    await expect(
      pageOccurrenceRuns(ctx(), { before: "abc" }, appDb),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  test("two rounds that started at the same instant are both listed, once", async () => {
    const at = new Date(base.getTime() - 100 * 24 * 60 * minute);
    const tied = await suDb.tenant.create({
      data: { name: "occ-tied", slug: `occ-tied-${process.pid}` },
    });
    try {
      for (let i = 0; i < 3; i += 1)
        await suDb.occurrenceRun.create({
          data: { tenantId: tied.id, startedAt: at, status: "ok" },
        });
      const ids: string[] = [];
      let before: string | null = null;
      for (let n = 0; n < 4; n += 1) {
        const page = await pageOccurrenceRuns(
          ctx(tied.id),
          { limit: 1, before },
          appDb,
        );
        ids.push(...page.runs.map((r) => r.id));
        before = page.nextBefore;
        if (before === null) break;
      }
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    } finally {
      await suDb.tenant.delete({ where: { id: tied.id } });
    }
  });

  test("the monitor's cost sums its steps' and its media recovery's ledger lines over 7 and 30 days, nothing else", async () => {
    const now = new Date();
    const day = 24 * 60 * minute;
    const row = (node: string | null, ago: number, cost: number | null) =>
      suDb.llmUsage.create({
        data: {
          tenantId,
          model: "m",
          node,
          createdAt: new Date(now.getTime() - ago),
          costUsd: cost,
        },
      });
    await row("occurrence_reading", day, 0.01);
    await row("occurrence_assignment", 2 * day, 0.02);
    await row("occurrence_consolidation", 10 * day, 0.1);
    await row("occurrence_canonical", 3 * day, null);
    // The reading's media recovery: an image priced, a voice note with no price.
    await row("occurrence_vision", 4 * day, 0.005);
    await row("occurrence_transcription", 5 * day, null);
    // Not the monitor's: an agent turn and an observer.
    await row(null, day, 5);
    await row("observer", day, 5);
    // Older than 30 days.
    await row("occurrence_reading", 40 * day, 9);
    const cost = await occurrenceCost(ctx(), now, appDb);
    expect(cost.last7Days.calls).toBe(5);
    expect(cost.last7Days.unpricedCalls).toBe(2);
    expect(cost.last7Days.costUsd).toBeCloseTo(0.035, 10);
    expect(cost.last30Days.calls).toBe(6);
    expect(cost.last30Days.costUsd).toBeCloseTo(0.135, 10);
    const none = await occurrenceCost(ctx(otherTenantId), now, appDb);
    expect(none.last30Days).toEqual({
      calls: 0,
      unpricedCalls: 0,
      costUsd: null,
    });
  });

  test("the themes' total counts every open theme with a conversation of a monitored inbox, past the limit", async () => {
    const inst = await suDb.chatwootDeployment.create({
      data: {
        tenantId,
        baseUrl: `https://chat.occ-console-${process.pid}.example.com`,
        adminToken: "x",
      },
    });
    const instance = await suDb.chatwootInstance.create({
      data: {
        tenantId,
        deploymentId: inst.id,
        accountId: 1,
        serverKey: `https://chat.occ-console-${process.pid}.example.com`,
        accountName: "a",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instance.id,
        chatwootInboxId: 1,
        name: "SAC",
      },
    });
    for (let i = 0; i < 4; i += 1) {
      const conv = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instance.id,
          chatwootConversationId: 100 + i,
          inboxId: inbox.id,
          threadId: `occ-console-${process.pid}-${i}`,
          status: "open",
        },
      });
      const theme = await suDb.occurrenceTheme.create({
        data: { tenantId, title: `Tema ${i}` },
      });
      // The last theme has no conversation, so no list shows it.
      if (i < 3)
        await suDb.occurrenceThemeMember.create({
          data: {
            tenantId,
            themeId: theme.id,
            conversationId: conv.id,
            sentence: "x",
            readAt: base,
          },
        });
    }
    // Only the monitored inboxes' conversations count: before the inbox is on the list, none does.
    expect(await countThemes(ctx(), {}, appDb)).toBe(0);
    await suDb.tenant.update({
      where: { id: tenantId },
      data: { settings: { occurrences: { inboxIds: [String(inbox.id)] } } },
    });
    const listed = await listThemes(ctx(), { limit: 2 }, appDb);
    expect(listed).toHaveLength(2);
    expect(await countThemes(ctx(), {}, appDb)).toBe(3);
    expect(await countThemes(ctx(otherTenantId), {}, appDb)).toBe(0);
    // Two reads list the same themes in the same order.
    const again = await listThemes(ctx(), { limit: 3 }, appDb);
    const twice = await listThemes(ctx(), { limit: 3 }, appDb);
    expect(again.map((t) => t.id)).toEqual(twice.map((t) => t.id));
  });
  test("a theme's first and last seen and its place in the list follow the monitored inboxes only", async () => {
    // One deployment per account: the earlier test's, when it ran.
    const inst =
      (await suDb.chatwootDeployment.findFirst({ where: { tenantId } })) ??
      (await suDb.chatwootDeployment.create({
        data: {
          tenantId,
          baseUrl: `https://chat.occ-span-${process.pid}.example.com`,
          adminToken: "x",
        },
      }));
    const instance =
      (await suDb.chatwootInstance.findFirst({
        where: { tenantId, deploymentId: inst.id },
      })) ??
      (await suDb.chatwootInstance.create({
        data: {
          tenantId,
          deploymentId: inst.id,
          accountId: 1,
          serverKey: inst.baseUrl,
          accountName: "a",
        },
      }));
    const inboxOf = (n: number) =>
      suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instance.id,
          chatwootInboxId: 200 + n,
          name: `Caixa ${n}`,
        },
      });
    const kept = await inboxOf(1);
    const dropped = await inboxOf(2);
    const hour = 3_600_000;
    let n = 0;
    const member = async (themeId: bigint, inboxId: bigint, at: number) => {
      n += 1;
      const conv = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instance.id,
          chatwootConversationId: 300 + n,
          inboxId,
          threadId: `occ-span-${process.pid}-${n}`,
          status: "open",
        },
      });
      await suDb.occurrenceThemeMember.create({
        data: {
          tenantId,
          themeId,
          conversationId: conv.id,
          sentence: "x",
          readAt: new Date(base.getTime() + at),
        },
      });
    };
    // As stored, `wide` was last seen through the inbox about to be taken off.
    const wide = await suDb.occurrenceTheme.create({
      data: {
        tenantId,
        title: "Largo",
        firstSeenAt: base,
        lastSeenAt: new Date(base.getTime() + 2 * hour),
      },
    });
    const narrow = await suDb.occurrenceTheme.create({
      data: {
        tenantId,
        title: "Estreito",
        firstSeenAt: new Date(base.getTime() + hour),
        lastSeenAt: new Date(base.getTime() + hour),
      },
    });
    await member(wide.id, kept.id, 0);
    await member(wide.id, dropped.id, 2 * hour);
    await member(narrow.id, kept.id, hour);
    await suDb.tenant.update({
      where: { id: tenantId },
      data: { settings: { occurrences: { inboxIds: [String(kept.id)] } } },
    });
    const listed = (await listThemes(ctx(), { limit: 100 }, appDb)).filter(
      (t) => t.id === String(wide.id) || t.id === String(narrow.id),
    );
    expect(listed.map((t) => t.title)).toEqual(["Estreito", "Largo"]);
    const shown = listed.find((t) => t.id === String(wide.id));
    expect(shown?.firstSeenAt).toBe(base.toISOString());
    expect(shown?.lastSeenAt).toBe(base.toISOString());
    expect(shown?.conversations).toBe(1);
    const detail = await getTheme(ctx(), wide.id, appDb);
    expect(detail.lastSeenAt).toBe(base.toISOString());
    expect(detail.conversations).toBe(1);
  });
});
