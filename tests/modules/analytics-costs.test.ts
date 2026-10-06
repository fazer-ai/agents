import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { getDashboardCosts } from "@/modules/analytics/costs";
import { getInstanceMetrics } from "@/modules/analytics/service";
import { updateLangfuse } from "@/modules/tenant-settings/service";
import { formatVaultRef } from "@/modules/vault/service";

// THE DASHBOARD'S MONEY COMES FROM THE LEDGER: the same rows, tenant and filters as
// the requests beside it. Langfuse sampled traces on the client and never re-priced, so its sum was a
// fraction of the bill next to an exact request count; it stays only as a link.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const DAY = 24 * 60 * 60 * 1000;
let bare = 0n; // no Langfuse
let traced = 0n; // Langfuse configured
let other = 0n;

const ctx = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Fails the test if Langfuse is asked for anything: no figure may depend on it.
const noFetch = (async () => {
  throw new Error("Langfuse must not be asked for a figure");
}) as unknown as typeof fetch;

async function seed(
  tenantId: bigint,
  model: string,
  source: string,
  costs: (number | null)[],
  at: Date,
) {
  await suDb.llmUsage.createMany({
    data: costs.map((c) => ({
      tenantId,
      model,
      source,
      costUsd: c ?? undefined,
      createdAt: at,
    })),
  });
}

describe.skipIf(!dbUp)("getDashboardCosts (DB)", () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000);
  const old = new Date(Date.now() - 60 * DAY);

  beforeAll(async () => {
    const mk = async (name: string) =>
      (
        await suDb.tenant.create({
          data: { name, slug: `${name.toLowerCase()}-${process.pid}` },
        })
      ).id;
    bare = await mk("CostBare");
    traced = await mk("CostTraced");
    other = await mk("CostOther");
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId: traced,
        name: "lf-cost",
        kind: "langfuse",
        secret: encryptJson({ publicKey: "pk-test", secretKey: "sk-test" }),
        baseUrl: "https://langfuse.example.test",
      },
      select: { id: true },
    });
    await updateLangfuse(
      ctx(traced),
      { enabled: true, credentialRef: formatVaultRef(entry.id) },
      appDb,
    );
    for (const tenantId of [bare, traced]) {
      await seed(tenantId, "gpt-a", "inbox", [1, 0.5], recent);
      await seed(tenantId, "gpt-b", "inbox", [2], recent);
      await seed(tenantId, "gpt-a", "playground", [4], recent);
      // No price: counted as such, never as zero inside a figure.
      await seed(tenantId, "mystery", "inbox", [null, null], recent);
      await seed(tenantId, "gpt-b", "inbox", [null], recent);
      // Outside a 30-day window.
      await seed(tenantId, "gpt-a", "inbox", [100], old);
    }
    await seed(other, "gpt-a", "inbox", [999], recent);
  });

  afterAll(async () => {
    for (const id of [bare, traced, other]) {
      if (!id) continue;
      for (const table of ["llm_usage", "vault_entries"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${id}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a tenant without Langfuse gets its cost, from the same rows as its requests", async () => {
    const since = new Date(Date.now() - 30 * DAY);
    const costs = await getDashboardCosts(
      ctx(bare),
      { since, source: "inbox" },
      appDb,
      noFetch,
    );
    expect(costs.totalCostUsd).toBeCloseTo(3.5, 6);
    expect(costs.byModel).toEqual([
      { model: "gpt-b", costUsd: 2 },
      { model: "gpt-a", costUsd: 1.5 },
    ]);
    expect(costs.unpriced).toEqual({ calls: 3, models: ["gpt-b", "mystery"] });
    expect(costs.langfuse).toBeNull();
    // The request count beside it reads the same window and segment.
    const metrics = await getInstanceMetrics(
      ctx(bare),
      { since, source: "inbox" },
      appDb,
    );
    expect(metrics.llm.calls).toBe(6);
  });

  test("the segment and the window move the cost with the requests", async () => {
    const all = await getDashboardCosts(ctx(bare), {}, appDb, noFetch);
    expect(all.totalCostUsd).toBeCloseTo(107.5, 6);
    const play = await getDashboardCosts(
      ctx(bare),
      { source: "playground" },
      appDb,
      noFetch,
    );
    expect(play.totalCostUsd).toBeCloseTo(4, 6);
    expect(play.unpriced).toEqual({ calls: 0, models: [] });
  });

  // Days are the operator's, as on the calls series: a call at 01:00 UTC is the previous day in
  // São Paulo.
  test("days are bucketed in the request's timezone", async () => {
    const t = (
      await suDb.tenant.create({
        data: { name: "CostTz", slug: `costtz-${process.pid}` },
      })
    ).id;
    try {
      await seed(t, "gpt-a", "inbox", [3], new Date("2026-09-10T01:00:00Z"));
      const utc = await getDashboardCosts(ctx(t), {}, appDb, noFetch);
      expect(utc.days).toEqual([{ date: "2026-09-10", costUsd: 3 }]);
      const sp = await getDashboardCosts(
        ctx(t),
        { tz: "America/Sao_Paulo" },
        appDb,
        noFetch,
      );
      expect(sp.days).toEqual([{ date: "2026-09-09", costUsd: 3 }]);
    } finally {
      await suDb.$executeRawUnsafe(
        `DELETE FROM llm_usage WHERE tenant_id = ${t}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
    }
  });

  // The link stays where Langfuse is configured, and asking for it never holds the figures: on a
  // miss the base URL is answered now and the project id is resolved in the background.
  test("a tenant with Langfuse gets the link, and the same figures however Langfuse answers", async () => {
    let asked = 0;
    const hanging = (async () => {
      asked += 1;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const started = Date.now();
    const costs = await getDashboardCosts(
      ctx(traced),
      { since: new Date(Date.now() - 30 * DAY), source: "inbox" },
      appDb,
      hanging,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(costs.langfuse).toEqual({
      baseUrl: "https://langfuse.example.test",
    });
    expect(asked).toBe(1);
    expect(costs.totalCostUsd).toBeCloseTo(3.5, 6);
  });

  test("the project link is used once Langfuse has named the project", async () => {
    const answering = (async () =>
      new Response(JSON.stringify({ data: [{ id: "proj-9" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    // The first load resolves in the background, the next one reads the cache.
    await getDashboardCosts(ctx(traced), {}, appDb, answering);
    await new Promise((r) => setTimeout(r, 50));
    const costs = await getDashboardCosts(ctx(traced), {}, appDb, noFetch);
    expect(costs.langfuse).toEqual({
      baseUrl: "https://langfuse.example.test",
      projectUrl: "https://langfuse.example.test/project/proj-9",
    });
  });
});
