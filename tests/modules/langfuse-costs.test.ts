import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { getLangfuseCosts } from "@/modules/analytics/langfuse-costs";
import { updateLangfuse } from "@/modules/tenant-settings/service";
import { formatVaultRef } from "@/modules/vault/service";

// Helper: minimal fake fetch that returns sequential JSON bodies.
function makeFetch(responses: unknown[]): typeof fetch {
  let callIndex = 0;
  return (async () => {
    const body = responses[callIndex++] ?? { data: [] };
    return {
      ok: true,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

// Captures the URLs asked, so a test can assert WHAT was asked and not only what came back: the
// fence this module owes the tenant lives in the query string, and a response stub cannot show it.
function capturingFetch(responses: unknown[]): {
  fetchFn: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  let callIndex = 0;
  const fetchFn = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const body = responses[callIndex++] ?? { data: [] };
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
}

// The metrics query travels as a JSON blob in `?query=`; this is the filter list out of it.
function filtersOf(url: string): Record<string, unknown>[] {
  const raw = new URL(url).searchParams.get("query");
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { filters?: Record<string, unknown>[] };
  return parsed.filters ?? [];
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network error");
  }) as unknown as typeof fetch;
}

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

let tenantId = 0n;
const slug = `cost-${process.pid}`;

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("getLangfuseCosts (DB)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CostTest", slug },
    });
    tenantId = t.id;
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "lf-cost",
        kind: "langfuse",
        secret: encryptJson({ publicKey: "pk-test", secretKey: "sk-test" }),
        baseUrl: "https://cloud.langfuse.com",
      },
      select: { id: true },
    });
    await updateLangfuse(
      ctx(),
      { enabled: true, credentialRef: formatVaultRef(entry.id) },
      appDb,
    );
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("ok: parses daily series + byModel, string sum_totalCost", async () => {
    const dailyData = [
      { time_dimension: "2026-06-01T00:00:00Z", sum_totalCost: "0.5" },
      { time_dimension: "2026-06-02T00:00:00Z", sum_totalCost: "1.25" },
    ];
    const modelData = [
      { providedModelName: "gpt-4o", sum_totalCost: "1.0" },
      { providedModelName: "gpt-4o-mini", sum_totalCost: "0.75" },
      { providedModelName: null, sum_totalCost: "0" },
    ];
    const result = await getLangfuseCosts(
      ctx(),
      {},
      appDb,
      makeFetch([{ data: dailyData }, { data: modelData }]),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.totalCostUsd).toBeCloseTo(1.75, 6);
    expect(result.days).toHaveLength(2);
    expect(result.days[0]).toEqual({ date: "2026-06-01", costUsd: 0.5 });
    expect(result.days[1]).toEqual({ date: "2026-06-02", costUsd: 1.25 });
    // byModel sorted by cost desc; null model becomes "unknown"
    expect(result.byModel[0]).toEqual({ model: "gpt-4o", costUsd: 1.0 });
    expect(result.byModel[1]).toEqual({ model: "gpt-4o-mini", costUsd: 0.75 });
    expect(result.byModel[2]).toEqual({ model: "unknown", costUsd: 0 });
  });

  // THE FIGURE ON THE DASHBOARD IS THIS TENANT'S, NOT THE PROJECT'S (issue #427). Every trace we
  // write carries the tenant slug as the Langfuse `userId` and one of our two environments; without
  // those filters the query returns whatever else shares the project. Measured on a local Langfuse
  // during this rodada: the unfenced 30-day total was $7.71, of which $2.70 belonged to two OTHER
  // tenants (`live-426-r4`, `live-426-r2`) and was being shown to `local-demo` as its own cost.
  // The type filter is the ceiling's own, so the two numbers on the same screen are the same query.
  test("the cost is fenced to the tenant and to the segment's environment", async () => {
    const { fetchFn, urls } = capturingFetch([{ data: [] }, { data: [] }]);
    await getLangfuseCosts(ctx(), { source: "playground" }, appDb, fetchFn);
    const metricUrls = urls.filter((u) => u.includes("/api/public/metrics"));
    expect(metricUrls).toHaveLength(2);
    for (const url of metricUrls) {
      const filters = filtersOf(url);
      expect(filters).toContainEqual({
        column: "environment",
        operator: "=",
        value: `${config.env}-playground`,
        type: "string",
      });
      expect(filters).toContainEqual({
        column: "userId",
        operator: "=",
        value: slug,
        type: "string",
      });
      expect(filters).toContainEqual({
        column: "type",
        operator: "=",
        value: "GENERATION",
        type: "string",
      });
    }
  });

  // "ALL" IS OUR TWO ENVIRONMENTS, NOT EVERYTHING IN THE PROJECT (issue #427). The segment means
  // "real and playground together", and a project an operator also points something else at would
  // otherwise land in the console's headline figure. Measured: the `any of` operator takes the pair
  // under `type: "stringOptions"`; asked as `type: "string"` Langfuse refuses the request outright.
  test("no segment asks for our two environments, not for the whole project", async () => {
    const { fetchFn, urls } = capturingFetch([{ data: [] }, { data: [] }]);
    await getLangfuseCosts(ctx(), {}, appDb, fetchFn);
    const filters = filtersOf(
      urls.filter((u) => u.includes("/api/public/metrics"))[0] as string,
    );
    expect(filters).toContainEqual({
      column: "environment",
      operator: "any of",
      value: [config.env, `${config.env}-playground`],
      type: "stringOptions",
    });
  });

  // A QUERY THAT CANNOT NAME THE TENANT IS NOT ASKED (issue #427). Without the slug there is no
  // fence, and the project's total is not this tenant's: the read fails instead of answering with
  // someone else's spend. The poll takes the same road for the same reason.
  test("a tenant the query cannot be fenced by is an error, not an unfenced read", async () => {
    // `tenants.slug` is NOT NULL and carries no check constraint, so the empty string is a state the
    // database accepts and this guard is reachable, not decorative.
    await suDb.$executeRawUnsafe(
      `UPDATE tenants SET slug = '' WHERE id = ${tenantId}`,
    );
    try {
      const { fetchFn, urls } = capturingFetch([{ data: [] }, { data: [] }]);
      const result = await getLangfuseCosts(ctx(), {}, appDb, fetchFn);
      expect(result.status).toBe("error");
      expect(
        urls.filter((u) => u.includes("/api/public/metrics")),
      ).toHaveLength(0);
    } finally {
      await suDb.$executeRawUnsafe(
        `UPDATE tenants SET slug = '${slug}' WHERE id = ${tenantId}`,
      );
    }
  });

  // THE LOCAL PRICE TABLE CHECKED AGAINST LANGFUSE'S (issue #868). The ledger is read over the
  // Langfuse query's own tenant, window and sources, so the two figures beside each model are two
  // prices for the same calls: a row of another tenant, of the other segment or from before the
  // window would put a difference on screen that no price table caused.
  describe("the cost check", () => {
    const DAY = 24 * 60 * 60 * 1000;
    let otherTenant = 0n;

    async function seed(
      tenant: bigint,
      model: string,
      source: string,
      costs: (number | null)[],
      at = new Date(Date.now() - 60 * 60 * 1000),
    ) {
      await suDb.llmUsage.createMany({
        data: costs.map((c) => ({
          tenantId: tenant,
          model,
          source,
          costUsd: c ?? undefined,
          createdAt: at,
        })),
      });
    }

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "CostOther", slug: `cost-other-${process.pid}` },
      });
      otherTenant = t.id;
      // Diverges: $3 locally against $6 in Langfuse, under the dated name OpenAI answers with.
      await seed(tenantId, "gpt-4o-mini", "inbox", [1, 1, 1]);
      // Incomplete: one of its calls has no local price.
      await seed(tenantId, "claude-x", "inbox", [2, null]);
      // Agrees within the thresholds.
      await seed(tenantId, "agrees", "inbox", [5]);
      // Only in the ledger.
      await seed(tenantId, "local-only", "inbox", [0.5]);
      // The playground's own model, and a playground call on a shared one.
      await seed(tenantId, "gemini-play", "playground", [4]);
      await seed(tenantId, "gpt-4o-mini", "playground", [2]);
      // Before `since`, and inside the 90 days the query reads when no `since` is given.
      await seed(
        tenantId,
        "gpt-4o-mini",
        "inbox",
        [100],
        new Date(Date.now() - 60 * DAY),
      );
      // After the query's `toTimestamp`: a call Langfuse was not asked about.
      await seed(
        tenantId,
        "gpt-4o-mini",
        "inbox",
        [1000],
        new Date(Date.now() + DAY),
      );
      // Another tenant's calls on the same model: RLS keeps them out.
      await seed(otherTenant, "gpt-4o-mini", "inbox", [100]);
    });

    afterAll(async () => {
      await suDb.$executeRawUnsafe(
        `DELETE FROM llm_usage WHERE tenant_id IN (${tenantId}, ${otherTenant})`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${otherTenant}`,
      );
    });

    const langfuseModels = [
      { providedModelName: "gpt-4o-mini-2024-07-18", sum_totalCost: "6" },
      { providedModelName: "claude-x", sum_totalCost: "9" },
      { providedModelName: "agrees", sum_totalCost: "5.5" },
      { providedModelName: "gemini-play", sum_totalCost: "4" },
      { providedModelName: "langfuse-only", sum_totalCost: "3" },
    ];

    test("one segment: that segment's calls in the window, this tenant's only", async () => {
      const result = await getLangfuseCosts(
        ctx(),
        { since: new Date(Date.now() - DAY), source: "inbox" },
        appDb,
        makeFetch([{ data: [] }, { data: langfuseModels }]),
      );
      if (result.status !== "ok") throw new Error(result.status);
      expect(result.costCheck).toEqual({
        models: [
          {
            model: "claude-x",
            ledgerModels: ["claude-x"],
            langfuseModels: ["claude-x"],
            localUsd: 2,
            langfuseUsd: 9,
            calls: 2,
            localUnpricedCalls: 1,
            status: "incomplete",
          },
          {
            model: "gpt-4o-mini",
            ledgerModels: ["gpt-4o-mini"],
            langfuseModels: ["gpt-4o-mini-2024-07-18"],
            localUsd: 3,
            langfuseUsd: 6,
            calls: 3,
            localUnpricedCalls: 0,
            status: "diverges",
          },
          {
            model: "agrees",
            ledgerModels: ["agrees"],
            langfuseModels: ["agrees"],
            localUsd: 5,
            langfuseUsd: 5.5,
            calls: 1,
            localUnpricedCalls: 0,
            status: "match",
          },
        ],
        onlyInLangfuse: ["gemini-play", "langfuse-only"],
        onlyLocal: ["local-only"],
      });
    });

    test("no segment: both of ours, the way the Langfuse query asks for both environments", async () => {
      const result = await getLangfuseCosts(
        ctx(),
        { since: new Date(Date.now() - DAY) },
        appDb,
        makeFetch([{ data: [] }, { data: langfuseModels }]),
      );
      if (result.status !== "ok") throw new Error(result.status);
      const byName = Object.fromEntries(
        (result.costCheck?.models ?? []).map((m) => [m.model, m]),
      );
      // $3 inbox + $2 playground against $6: within a fifth of the larger, so it agrees.
      expect(byName["gpt-4o-mini"]).toMatchObject({
        localUsd: 5,
        calls: 4,
        status: "match",
      });
      expect(byName["gemini-play"]).toMatchObject({
        localUsd: 4,
        langfuseUsd: 4,
        status: "match",
      });
      expect(result.costCheck?.onlyInLangfuse).toEqual(["langfuse-only"]);
    });

    test("a model the tenant priced itself is not flagged, however far it is from Langfuse", async () => {
      const at = new Date(Date.now() - 60 * 60 * 1000);
      await suDb.llmUsage.createMany({
        data: [
          {
            model: "own-priced",
            priceTable: "tenant-override@2026-09-25T00:00:00.000Z",
            costUsd: 20,
          },
          {
            model: "own-priced",
            priceTable: "litellm@e106dbd8ba9b",
            costUsd: 1,
          },
          {
            model: "table-priced",
            priceTable: "litellm@e106dbd8ba9b",
            costUsd: 21,
          },
        ].map((r) => ({ tenantId, source: "inbox", createdAt: at, ...r })),
      });
      try {
        const result = await getLangfuseCosts(
          ctx(),
          { since: new Date(Date.now() - DAY), source: "inbox" },
          appDb,
          makeFetch([
            { data: [] },
            {
              data: [
                ...langfuseModels,
                { providedModelName: "own-priced", sum_totalCost: "2" },
                { providedModelName: "table-priced", sum_totalCost: "2" },
              ],
            },
          ]),
        );
        if (result.status !== "ok") throw new Error(result.status);
        const own = result.costCheck?.models.find(
          (m) => m.model === "own-priced",
        );
        // $21 against $2 would diverge; one call on the tenant's own price makes it `own`.
        expect(own).toMatchObject({
          localUsd: 21,
          langfuseUsd: 2,
          status: "own",
        });
        // The same gap priced by the table alone still diverges: the count is per model, and only
        // the tenant's own stamp counts.
        expect(
          result.costCheck?.models.find((m) => m.model === "table-priced")
            ?.status,
        ).toBe("diverges");
      } finally {
        await suDb.$executeRawUnsafe(
          `DELETE FROM llm_usage WHERE tenant_id = ${tenantId} AND model IN ('own-priced', 'table-priced')`,
        );
      }
    });

    test("no since: the window is the Langfuse query's default, which reaches the older call", async () => {
      const result = await getLangfuseCosts(
        ctx(),
        { source: "inbox" },
        appDb,
        makeFetch([{ data: [] }, { data: langfuseModels }]),
      );
      if (result.status !== "ok") throw new Error(result.status);
      const gpt = result.costCheck?.models.find(
        (m) => m.model === "gpt-4o-mini",
      );
      expect(gpt).toMatchObject({ localUsd: 103, calls: 4 });
    });
  });

  test("error: fetch failure → { status: 'error' }", async () => {
    const result = await getLangfuseCosts(ctx(), {}, appDb, failingFetch());
    expect(result.status).toBe("error");
  });

  test("disabled: tenant without Langfuse config → { status: 'disabled' }", async () => {
    const t2 = await suDb.tenant.create({
      data: { name: "NoCost", slug: `no-cost-${process.pid}` },
    });
    const noCtx: TenantContext = {
      tenantId: t2.id,
      userId: null,
      role: "TENANT_ADMIN",
    };
    try {
      const result = await getLangfuseCosts(noCtx, {}, appDb);
      expect(result.status).toBe("disabled");
    } finally {
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t2.id}`);
    }
  });
});
