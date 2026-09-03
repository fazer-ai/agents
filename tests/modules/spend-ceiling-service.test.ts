import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  readSpendSnapshot,
  readTenantSpendCeiling,
  SPEND_SNAPSHOT_STALE_AFTER_MS,
  spendCeilingUsage,
  spendCeilingVerdict,
  spendUsedInMonth,
} from "@/modules/spend-ceiling/service";
import {
  updateLangfuse,
  updateSpendCeiling,
} from "@/modules/tenant-settings/service";
import { formatVaultRef } from "@/modules/vault/service";

// What the gate READS (issue #426): the month's cost as the Langfuse poll last wrote it, one row per
// (tenant, source, month), never Langfuse itself. The rule is proved without a database in
// ./spend-ceiling-decide.test.ts; the poll that writes the row in ./spend-ceiling-poll.test.ts.

let appDb: PrismaClient;
let suDb: PrismaClient;
let dbUp = true;
let tenantId = 0n;

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
  } catch {
    dbUp = false;
  }
}

const AUG = new Date("2026-08-15T12:00:00Z");
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

async function seedSnapshot(row: {
  source: string;
  month: string;
  costUsd: number;
  polledAt?: string | null;
  pollError?: string | null;
  tracedCalls?: number;
  costedCalls?: number;
  unpricedModels?: string[];
  tenant?: bigint;
}) {
  await suDb.spendCostSnapshot.create({
    data: {
      tenantId: row.tenant ?? tenantId,
      source: row.source,
      monthStart: new Date(row.month),
      costUsd: row.costUsd,
      polledAt:
        row.polledAt === undefined
          ? new Date("2026-08-15T11:58:00Z")
          : row.polledAt === null
            ? null
            : new Date(row.polledAt),
      pollError: row.pollError ?? null,
      tracedCalls: row.tracedCalls ?? 0,
      costedCalls: row.costedCalls ?? 0,
      unpricedModels: row.unpricedModels ?? [],
    },
  });
}

describe.skipIf(!dbUp)("the spend ceiling against the cost snapshot", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SC", slug: `sc-${process.pid}` },
    });
    tenantId = t.id;
    await seedSnapshot({
      source: "inbox",
      month: "2026-08-01T00:00:00Z",
      costUsd: 22.5,
      tracedCalls: 40,
      costedCalls: 38,
      unpricedModels: ["openrouter/free-model"],
    });
    await seedSnapshot({
      source: "playground",
      month: "2026-08-01T00:00:00Z",
      costUsd: 9.9,
    });
    // Last month, which this month must not inherit.
    await seedSnapshot({
      source: "inbox",
      month: "2026-07-01T00:00:00Z",
      costUsd: 9000.01,
    });
    // NEXT month, which this month must not inherit either: the verdict carries the instant it was
    // evaluated at, and "the month asked about" is that instant's month.
    await seedSnapshot({
      source: "inbox",
      month: "2026-09-01T00:00:00Z",
      costUsd: 7000.01,
    });
    // The local ledger keeps counting calls; the console shows how many of them Langfuse costed.
    await suDb.llmUsage.createMany({
      data: [
        {
          tenantId,
          model: "gpt-5.4-mini",
          source: "inbox",
          promptTokens: 10,
          completionTokens: 1,
          createdAt: new Date("2026-08-02T10:00:00Z"),
        },
        {
          tenantId,
          model: "gpt-5.4-mini",
          source: "inbox",
          promptTokens: 10,
          completionTokens: 1,
          createdAt: new Date("2026-08-14T10:00:00Z"),
        },
        {
          tenantId,
          model: "gpt-5.4-mini",
          source: "inbox",
          promptTokens: 10,
          completionTokens: 1,
          createdAt: new Date("2026-07-31T23:59:59Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    if (!dbUp || tenantId === 0n) return;
    await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
    await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  describe("reading the month's cost", () => {
    test("answers the source asked about, in dollars", async () => {
      expect(await spendUsedInMonth(tenantId, "inbox", AUG, appDb)).toBe(22.5);
      expect(await spendUsedInMonth(tenantId, "playground", AUG, appDb)).toBe(
        9.9,
      );
    });

    // The calendar month is the window, so a bad July cannot silence August, and the row for a
    // month that has not been polled yet reads as nothing spent rather than as last month's figure.
    test("neither last month nor next month counts against this one", async () => {
      expect(await spendUsedInMonth(tenantId, "inbox", AUG, appDb)).toBe(22.5);
      expect(
        await spendUsedInMonth(
          tenantId,
          "inbox",
          new Date("2026-07-15T00:00:00Z"),
          appDb,
        ),
      ).toBe(9000.01);
      expect(
        await spendUsedInMonth(
          tenantId,
          "inbox",
          new Date("2026-09-15T00:00:00Z"),
          appDb,
        ),
      ).toBe(7000.01);
    });

    test("the last instant of the month is the month's, the first of the next is not", async () => {
      expect(
        await spendUsedInMonth(
          tenantId,
          "inbox",
          new Date("2026-08-31T23:59:59.999Z"),
          appDb,
        ),
      ).toBe(22.5);
      expect(
        await spendUsedInMonth(
          tenantId,
          "inbox",
          new Date("2026-09-01T00:00:00.000Z"),
          appDb,
        ),
      ).toBe(7000.01);
    });

    test("a tenant with no row at all reads zero, and no snapshot", async () => {
      const other = await suDb.tenant.create({
        data: { name: "SC2", slug: `sc2-${process.pid}` },
      });
      try {
        expect(await spendUsedInMonth(other.id, "inbox", AUG, appDb)).toBe(0);
        expect(
          await readSpendSnapshot(other.id, "inbox", AUG, appDb),
        ).toBeNull();
      } finally {
        await suDb.tenant.deleteMany({ where: { id: other.id } });
      }
    });

    test("the snapshot carries what the poll knew", async () => {
      const row = await readSpendSnapshot(tenantId, "inbox", AUG, appDb);
      expect(row).toMatchObject({
        costUsd: 22.5,
        tracedCalls: 40,
        costedCalls: 38,
        unpricedModels: ["openrouter/free-model"],
        pollError: null,
      });
      expect(row?.polledAt?.toISOString()).toBe("2026-08-15T11:58:00.000Z");
    });
  });

  describe("the verdict, end to end", () => {
    test("a tenant that never configured a ceiling is allowed, and is not queried for one", async () => {
      const v = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: appDb,
        now: AUG,
      });
      expect(v.state).toBe("allowed");
      expect(v.ceilingUsd).toBeNull();
      expect(v.snapshot).toBeNull();
    });

    // THE HALF WITH NO CEILING IS NOT READ. `0` is the operator saying this source is unbounded,
    // and the common configuration is exactly one bounded half. Counted at the seam rather than
    // timed, because a timing assertion would pass on a machine that is merely fast.
    test("the source with no ceiling of its own never reads the snapshot", async () => {
      let reads = 0;
      const counted = appDb.$extends({
        query: {
          spendCostSnapshot: {
            async $allOperations({ args, query }) {
              reads += 1;
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const cfg = {
        ...(await readTenantSpendCeiling(tenantId, appDb)),
        enabled: true,
        monthlyInboxUsd: 0,
        monthlyPlaygroundUsd: 5,
      };
      const inbox = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: counted,
        now: AUG,
        cfg,
      });
      expect(inbox.state).toBe("allowed");
      expect(inbox.ceilingUsd).toBeNull();
      expect(reads).toBe(0);
      // The positive control, on the same client.
      const play = await spendCeilingVerdict({
        tenantId,
        source: "playground",
        base: counted,
        now: AUG,
        cfg,
      });
      expect(play.state).toBe("over");
      expect(reads).toBe(1);
    });

    test("over the ceiling the verdict carries the real numbers, and the snapshot's health", async () => {
      const v = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: appDb,
        now: AUG,
        cfg: {
          ...(await readTenantSpendCeiling(tenantId, appDb)),
          enabled: true,
          monthlyInboxUsd: 20,
        },
      });
      expect(v.state).toBe("over");
      expect(v.usedUsd).toBe(22.5);
      expect(v.ceilingUsd).toBe(20);
      expect(v.snapshot).toEqual({
        polledAt: new Date("2026-08-15T11:58:00Z"),
        pollError: null,
        pollFailedAt: null,
        stale: false,
      });
    });

    // A ROW NOBODY HAS REFRESHED IS STILL THE FLOOR OF THE TRUTH. Spend only grows inside a month,
    // so the last good figure under-counts by the lag and never over-refuses; the verdict stands on
    // it and SAYS it is stale, which is what the console and the alert line read (issue #426).
    test("a stale snapshot still decides, and is reported as stale", async () => {
      const polledAt = new Date("2026-08-15T11:58:00Z").getTime();
      const later = new Date(polledAt + SPEND_SNAPSHOT_STALE_AFTER_MS + 1);
      const v = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: appDb,
        now: later,
        cfg: {
          ...(await readTenantSpendCeiling(tenantId, appDb)),
          enabled: true,
          monthlyInboxUsd: 20,
        },
      });
      expect(v.state).toBe("over");
      expect(v.usedUsd).toBe(22.5);
      expect(v.snapshot?.stale).toBe(true);
      const fresh = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: appDb,
        now: new Date(polledAt + SPEND_SNAPSHOT_STALE_AFTER_MS - 1),
        cfg: {
          ...(await readTenantSpendCeiling(tenantId, appDb)),
          enabled: true,
          monthlyInboxUsd: 20,
        },
      });
      expect(fresh.snapshot?.stale).toBe(false);
    });

    // A month nobody has polled yet: nothing is known, and nothing known is nothing spent. The
    // poll's first pass writes the row; until then the ceiling cannot refuse on a figure it does
    // not have, which is the same direction the unreadable-ceiling rule takes.
    test("a month with no snapshot yet is allowed, with no health to report", async () => {
      const v = await spendCeilingVerdict({
        tenantId,
        source: "playground",
        base: appDb,
        now: new Date("2026-10-15T00:00:00Z"),
        cfg: {
          ...(await readTenantSpendCeiling(tenantId, appDb)),
          enabled: true,
          monthlyPlaygroundUsd: 1,
        },
      });
      expect(v.state).toBe("allowed");
      expect(v.usedUsd).toBe(0);
      expect(v.snapshot).toBeNull();
    });

    test("the month asked about is the month read, not the month it is run in", async () => {
      const cfg = {
        ...(await readTenantSpendCeiling(tenantId, appDb)),
        enabled: true,
        monthlyInboxUsd: 20,
      };
      const july = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: appDb,
        now: new Date("2026-07-15T00:00:00.000Z"),
        cfg,
      });
      expect(july.usedUsd).toBe(9000.01);
      expect(july.evaluatedAt.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    });

    test("the playground's own spending does not close the inbox", async () => {
      const cfg = {
        ...(await readTenantSpendCeiling(tenantId, appDb)),
        enabled: true,
        monthlyInboxUsd: 100,
        monthlyPlaygroundUsd: 5,
      };
      const play = await spendCeilingVerdict({
        tenantId,
        source: "playground",
        base: appDb,
        now: AUG,
        cfg,
      });
      const inbox = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: appDb,
        now: AUG,
        cfg,
      });
      expect(play.state).toBe("over");
      expect(inbox.state).toBe("allowed");
    });

    // An unreadable ceiling ALLOWS the call, as before: a snapshot table that cannot be read is our
    // own database failing, and no customer is silenced for that.
    test("a snapshot that cannot be read lets the call through", async () => {
      const broken = appDb.$extends({
        query: {
          spendCostSnapshot: {
            async $allOperations() {
              throw new Error("pool exhausted");
            },
          },
        },
      }) as unknown as PrismaClient;
      const v = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: broken,
        now: AUG,
        cfg: {
          ...(await readTenantSpendCeiling(tenantId, appDb)),
          enabled: true,
          monthlyInboxUsd: 1,
        },
      });
      expect(v.state).toBe("allowed");
    });
  });

  // WHAT THE CONSOLE SHOWS: both halves, always, with the health of the figure beside it, and the
  // reconciliation against the local ledger, because a ceiling that undercounts has to say so on
  // the same screen that shows the bar.
  describe("the console's read", () => {
    test("carries cost, health, coverage and the ledger's own count per source", async () => {
      const usage = await spendCeilingUsage({
        ctx: ctx(),
        base: appDb,
        now: AUG,
        cfg: {
          ...(await readTenantSpendCeiling(tenantId, appDb)),
          enabled: true,
          monthlyInboxUsd: 20,
        },
      });
      expect(usage.periodStart).toBe("2026-08-01T00:00:00.000Z");
      expect(usage.langfuseConfigured).toBe(false);
      expect(usage.legacyTokens).toBeNull();
      expect(usage.pollIntervalMs).toBeGreaterThan(0);
      const inbox = usage.entries.find((e) => e.source === "inbox");
      expect(inbox).toEqual({
        source: "inbox",
        usedUsd: 22.5,
        ceilingUsd: 20,
        state: "over",
        polledAt: "2026-08-15T11:58:00.000Z",
        pollError: null,
        pollFailedAt: null,
        stale: false,
        tracedCalls: 40,
        costedCalls: 38,
        // Two August rows in the ledger; July's is not this month's.
        ledgerCalls: 2,
        unpricedModels: ["openrouter/free-model"],
      });
      const play = usage.entries.find((e) => e.source === "playground");
      expect(play).toMatchObject({
        usedUsd: 9.9,
        ceilingUsd: null,
        state: "allowed",
        ledgerCalls: 0,
      });
    });

    test("a month with no snapshot shows zero and no health", async () => {
      const usage = await spendCeilingUsage({
        ctx: ctx(),
        base: appDb,
        now: new Date("2026-10-15T00:00:00Z"),
      });
      const inbox = usage.entries.find((e) => e.source === "inbox");
      expect(inbox).toMatchObject({
        usedUsd: 0,
        polledAt: null,
        stale: false,
        tracedCalls: 0,
        costedCalls: 0,
        ledgerCalls: 0,
        unpricedModels: [],
      });
    });

    // "CONFIGURED" MEANS THE POLL CAN USE IT (review round 1). A block that is switched on with a
    // credential reference whose vault entry is gone, or holds no usable keys, is what the poll
    // reports as `langfuse-not-configured`; the console must not call the same tenant configured on
    // the strength of the reference alone, or the screen shows $0 with no sentence saying why.
    test("langfuse is configured only when its credential resolves", async () => {
      const usable = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: "lf-usable",
          kind: "langfuse",
          secret: encryptJson({ publicKey: "pk", secretKey: "sk" }),
          baseUrl: "https://langfuse.example.test",
        },
        select: { id: true },
      });
      const broken = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: "lf-broken",
          kind: "langfuse",
          secret: encryptJson({ token: "not-a-key-pair" }),
        },
        select: { id: true },
      });
      try {
        await updateLangfuse(
          ctx(),
          { enabled: true, credentialRef: formatVaultRef(usable.id) },
          appDb,
        );
        expect(
          (await spendCeilingUsage({ ctx: ctx(), base: appDb, now: AUG }))
            .langfuseConfigured,
        ).toBe(true);
        await updateLangfuse(
          ctx(),
          { enabled: true, credentialRef: formatVaultRef(broken.id) },
          appDb,
        );
        expect(
          (await spendCeilingUsage({ ctx: ctx(), base: appDb, now: AUG }))
            .langfuseConfigured,
        ).toBe(false);
        await updateLangfuse(
          ctx(),
          { enabled: true, credentialRef: formatVaultRef(usable.id) },
          appDb,
        );
        await suDb.vaultEntry.delete({ where: { id: usable.id } });
        expect(
          (await spendCeilingUsage({ ctx: ctx(), base: appDb, now: AUG }))
            .langfuseConfigured,
        ).toBe(false);
      } finally {
        await suDb.vaultEntry.deleteMany({ where: { tenantId } });
        await updateLangfuse(
          ctx(),
          { enabled: false, credentialRef: null },
          appDb,
        );
      }
    });

    test("a block written in tokens is reported as such", async () => {
      const usage = await spendCeilingUsage({
        ctx: ctx(),
        base: appDb,
        now: AUG,
        cfg: {
          ...(await readTenantSpendCeiling(tenantId, appDb)),
          enabled: true,
          legacyTokens: { inbox: 250_000, playground: 0 },
        },
      });
      expect(usage.legacyTokens).toEqual({ inbox: 250_000, playground: 0 });
    });
  });

  // A PATCH THAT NAMES NO DOLLAR FIGURE LEAVES A TOKEN BLOCK IN TOKENS (review round 1). The console
  // saves the whole block on every change, but the API takes partial patches, and an operator who
  // only changes the customer's sentence has not seen the new unit: merging that against the
  // synthesized zeroes would store a dollar block and drop the one warning that the old ceiling is
  // no longer enforced. The first patch that names a dollar field is what retires the token keys.
  describe("saving over a block written in tokens", () => {
    const stored = async () =>
      (
        (
          await suDb.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { settings: true },
          })
        ).settings as { spendCeiling?: Record<string, unknown> }
      ).spendCeiling;

    beforeEach(async () => {
      const t = await suDb.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { settings: true },
      });
      await suDb.tenant.update({
        where: { id: tenantId },
        data: {
          settings: {
            ...(t.settings as object),
            spendCeiling: {
              enabled: true,
              monthlyInboxTokens: 250_000,
              monthlyPlaygroundTokens: 0,
            },
          },
        },
      });
    });

    test("a patch with no dollar field keeps the token keys and the marker", async () => {
      const next = await updateSpendCeiling(
        ctx(),
        { overCeilingMessage: "Volto amanhã." },
        appDb,
      );
      expect(next.legacyTokens).toEqual({ inbox: 250_000, playground: 0 });
      expect(next.overCeilingMessage).toBe("Volto amanhã.");
      const raw = await stored();
      expect(raw?.monthlyInboxTokens).toBe(250_000);
      expect(raw).not.toHaveProperty("monthlyInboxUsd");
      expect(raw).not.toHaveProperty("legacyTokens");
    });

    test("a patch that names a dollar field retires them", async () => {
      const next = await updateSpendCeiling(
        ctx(),
        { monthlyInboxUsd: 40 },
        appDb,
      );
      expect(next.legacyTokens).toBeNull();
      expect(next.monthlyInboxUsd).toBe(40);
      const raw = await stored();
      expect(raw).not.toHaveProperty("monthlyInboxTokens");
      expect(raw?.monthlyPlaygroundUsd).toBe(0);
    });
  });
});
