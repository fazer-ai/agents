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
