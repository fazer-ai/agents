import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { parseRepriceArgs, UsageError } from "@/../scripts/reprice-usage";
import { callCostUsd, priceCall } from "@/modules/pricing/price";
import {
  capturePricer,
  planReprice,
  runReprice,
} from "@/modules/pricing/reprice";
import { PRICE_TABLE_VERSION } from "@/modules/pricing/version";

// Issue #867: an operator re-prices ledger rows with the table in the tree now, when the table that
// priced them was wrong. Dry run by default; `apply` writes only the rows whose figure changes and
// stamps them with the current table; a row the table cannot price is left as it was and counted;
// each row is priced at its own `created_at`; and the tenant, period and `price_table` filters hold.

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

const MODEL = "deepseek-chat";
const OLD = "litellm@0000000old";
const PEAK = "2026-09-24T07:30:00Z"; // Thursday, inside DeepSeek's peak
const OFF = "2026-09-24T12:00:00Z"; // Thursday noon, off-peak
const WRONG = "0.9000000000";

let tA = 0n;
let tB = 0n;
const tenants: bigint[] = [];

interface Seed {
  tenant?: bigint;
  model?: string;
  input?: number;
  cached?: number;
  written?: number;
  output?: number;
  cost?: string | null;
  table?: string | null;
  at?: string;
}

async function seed(s: Seed = {}) {
  const row = await suDb.llmUsage.create({
    data: {
      tenantId: s.tenant ?? tA,
      model: s.model ?? MODEL,
      promptTokens: s.input ?? 10_000,
      cachedReadTokens: s.cached ?? 4_000,
      cacheCreationTokens: s.written ?? 0,
      completionTokens: s.output ?? 2_000,
      costUsd: s.cost === undefined ? WRONG : s.cost,
      priceTable: s.table === undefined ? OLD : s.table,
      createdAt: new Date(s.at ?? PEAK),
    },
  });
  return row.id;
}

async function read(id: bigint) {
  const r = await suDb.llmUsage.findUniqueOrThrow({ where: { id } });
  return {
    cost: r.costUsd === null ? null : r.costUsd.toFixed(10),
    table: r.priceTable,
  };
}

// What the table in the tree prices the default seed at a given instant, as the column stores it.
const priced = (at: string, provider = "deepseek") =>
  (
    callCostUsd(
      provider,
      MODEL,
      {
        promptTokens: 10_000,
        cachedReadTokens: 4_000,
        cacheCreationTokens: 0,
        completionTokens: 2_000,
      },
      new Date(at),
    ) as number
  ).toFixed(10);

describe("arguments", () => {
  const base = ["--tenant", "all", "--provider", "deepseek", "--model", MODEL];

  test("the provider is required, because the ledger does not record it", () => {
    expect(() =>
      parseRepriceArgs(["--tenant", "all", "--model", MODEL]),
    ).toThrow(/--provider is required/);
  });

  test("an empty model is a real target only for an openai-compatible server", () => {
    expect(
      parseRepriceArgs([
        "--tenant",
        "1",
        "--provider",
        "openai-compatible",
        "--model",
        "",
      ]).model,
    ).toBe("");
    expect(() =>
      parseRepriceArgs([
        "--tenant",
        "1",
        "--provider",
        "openai",
        "--model",
        "",
      ]),
    ).toThrow(/only an openai-compatible server/);
    expect(() =>
      parseRepriceArgs(["--tenant", "1", "--provider", "openai"]),
    ).toThrow(/--model is required/);
  });

  test("an unknown provider is refused up front", () => {
    expect(() =>
      parseRepriceArgs([
        "--tenant",
        "1",
        "--provider",
        "opnai",
        "--model",
        MODEL,
      ]),
    ).toThrow(/--provider must be one of/);
  });

  // The table has no price for an openai-compatible server, but a tenant's own price does, and
  // pricing those rows after the price is saved is one of the reasons the command exists (review).
  test("a model only a tenant's own price covers is accepted", () => {
    expect(
      parseRepriceArgs([
        "--tenant",
        "1",
        "--provider",
        "openai-compatible",
        "--model",
        "local-model",
      ]).provider,
    ).toBe("openai-compatible");
  });

  test("any stamp targets the rows it wrote: a tenant's own price, OpenRouter's figure", () => {
    for (const stamp of [
      "tenant-override@2026-09-25T12:00:00.000Z",
      "openrouter:reported",
    ])
      expect(
        parseRepriceArgs([...base, "--price-table", stamp]).priceTable,
      ).toBe(stamp);
  });

  test("dry run unless --apply; `none` targets the rows no table priced", () => {
    const dry = parseRepriceArgs(base);
    expect(dry.apply).toBe(false);
    expect(dry.tenant).toBe("all");
    expect(dry.priceTable).toBeUndefined();
    const wet = parseRepriceArgs([
      ...base,
      "--apply",
      "--price-table",
      "none",
      "--from",
      "2026-09-01",
      "--to",
      "2026-10-01",
    ]);
    expect(wet.apply).toBe(true);
    expect(wet.priceTable).toBeNull();
    expect(wet.from?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(() => parseRepriceArgs([...base, "--from", "yesterday"])).toThrow(
      UsageError,
    );
    expect(() =>
      parseRepriceArgs(["--tenant", "x1", ...base.slice(2)]),
    ).toThrow(UsageError);
  });
});

describe("the plan", () => {
  test("the provider decides the figure: the same row priced as openai is not DeepSeek's off-peak half", () => {
    const row = {
      id: 1n,
      tenantId: 1n,
      model: MODEL,
      promptTokens: 10_000,
      cachedReadTokens: 4_000,
      cacheCreationTokens: 0,
      completionTokens: 2_000,
      costUsd: null,
      priceTable: null,
      createdAt: new Date(OFF),
    };
    const ds = planReprice(
      [row],
      capturePricer("deepseek", () => null),
    ).updates[0]?.costUsd;
    const oa = planReprice(
      [row],
      capturePricer("openai", () => null),
    ).updates[0]?.costUsd;
    expect(ds).toBe(priced(OFF));
    expect(oa).toBe(priced(OFF, "openai"));
    expect(ds).not.toBe(oa);
  });
});

describe.skipIf(!dbUp)("re-pricing the ledger (issue #867)", () => {
  beforeAll(async () => {
    for (const slug of ["r867-a", "r867-b"]) {
      const t = await suDb.tenant.create({
        data: { name: slug, slug: `${slug}-${process.pid}` },
      });
      tenants.push(t.id);
    }
    [tA, tB] = tenants as [bigint, bigint];
  });

  afterAll(async () => {
    for (const t of tenants) {
      await suDb.$executeRaw`DELETE FROM llm_usage WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${t}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  async function clear() {
    for (const t of tenants)
      await suDb.$executeRaw`DELETE FROM llm_usage WHERE tenant_id = ${t}`;
  }

  test("a dry run reports the change and writes nothing", async () => {
    await clear();
    const id = await seed();
    const report = await runReprice(suDb, {
      tenant: tA,
      provider: "deepseek",
      model: MODEL,
      apply: false,
    });
    expect(report.groups).toHaveLength(1);
    const g = report.groups[0];
    expect(g?.matched).toBe(1);
    expect(g?.changed).toBe(1);
    expect(g?.beforeUsd.toFixed(10)).toBe(WRONG);
    expect(g?.afterUsd.toFixed(10)).toBe(priced(PEAK));
    expect(report.written).toBe(0);
    expect(await read(id)).toEqual({ cost: WRONG, table: OLD });
  });

  test("apply rewrites the matching rows, stamps them, and touches nothing else", async () => {
    await clear();
    const hit = await seed();
    const hit2 = await seed({ at: OFF });
    const otherModel = await seed({ model: "deepseek-reasoner" });
    const outside = await seed({ at: "2026-08-01T07:30:00Z" });
    const after = await seed({ at: "2026-10-01T00:00:00Z" });
    // Already right under the new table: its figure does not move, so it keeps the stamp it has.
    const right = await seed({ cost: priced(PEAK) });
    const report = await runReprice(suDb, {
      tenant: tA,
      provider: "deepseek",
      model: MODEL,
      from: new Date("2026-09-01"),
      to: new Date("2026-10-01"),
      apply: true,
      // Two per batch, so the walk has to page to see all of them.
      batchSize: 2,
    });
    expect(report.written).toBe(2);
    expect(report.groups[0]).toMatchObject({
      matched: 3,
      changed: 2,
      unchanged: 1,
      unpriceable: 0,
    });
    expect(await read(hit)).toEqual({
      cost: priced(PEAK),
      table: PRICE_TABLE_VERSION,
    });
    expect(await read(hit2)).toEqual({
      cost: priced(OFF),
      table: PRICE_TABLE_VERSION,
    });
    expect(await read(right)).toEqual({ cost: priced(PEAK), table: OLD });
    expect(await read(otherModel)).toEqual({ cost: WRONG, table: OLD });
    expect(await read(outside)).toEqual({ cost: WRONG, table: OLD });
    // `to` is exclusive.
    expect(await read(after)).toEqual({ cost: WRONG, table: OLD });
  });

  // Issues #865 and #866: a figure the table never gave is not the table's to correct.
  // Issues #865 and #866: each row is priced as the capture would price it now. A tenant's price
  // saved after the fact comes first, OpenRouter's figure included; without one, what OpenRouter
  // charged stands and the table re-prices only what it priced.
  test("a tenant's price saved after the fact re-prices its rows, and OpenRouter's figure stands without one", async () => {
    await clear();
    const block = {
      overrides: [
        {
          provider: "deepseek" as const,
          model: MODEL,
          input: 1,
          cachedInput: 0.5,
          output: 2,
        },
      ],
      updatedAt: "2026-09-26T00:00:00.000Z",
    };
    await suDb.tenant.update({
      where: { id: tA },
      data: { settings: { priceOverrides: block } },
    });
    try {
      const tableRow = await seed();
      const reportedA = await seed({ table: "openrouter:reported" });
      const oldOwn = await seed({
        table: "tenant-override@2026-09-25T12:00:00.000Z",
      });
      const reportedB = await seed({
        tenant: tB,
        table: "openrouter:reported",
      });
      const tableB = await seed({ tenant: tB });
      await runReprice(suDb, {
        tenant: "all",
        provider: "deepseek",
        model: MODEL,
        apply: true,
      });
      const own = priceCall(
        "deepseek",
        MODEL,
        {
          promptTokens: 10_000,
          cachedReadTokens: 4_000,
          cacheCreationTokens: 0,
          completionTokens: 2_000,
        },
        new Date(PEAK),
        block,
      );
      const ownRow = {
        cost: (own.costUsd as number).toFixed(10),
        table: "tenant-override@2026-09-26T00:00:00.000Z",
      };
      expect(await read(tableRow)).toEqual(ownRow);
      expect(await read(reportedA)).toEqual(ownRow);
      expect(await read(oldOwn)).toEqual(ownRow);
      expect(await read(reportedB)).toEqual({
        cost: WRONG,
        table: "openrouter:reported",
      });
      expect(await read(tableB)).toEqual({
        cost: priced(PEAK),
        table: PRICE_TABLE_VERSION,
      });
    } finally {
      await suDb.tenant.update({ where: { id: tA }, data: { settings: {} } });
    }
  });

  test("an openai-compatible model the table lacks is priced by the tenant's own price", async () => {
    await clear();
    const block = {
      overrides: [
        {
          provider: "openai-compatible" as const,
          model: "local-model",
          input: 1,
          output: 2,
        },
      ],
      updatedAt: "2026-09-26T00:00:00.000Z",
    };
    await suDb.tenant.update({
      where: { id: tA },
      data: { settings: { priceOverrides: block } },
    });
    try {
      const unpricedA = await seed({ model: "local-model", cost: null });
      const namelessA = await seed({ model: "", cost: null });
      const unpricedB = await seed({
        tenant: tB,
        model: "local-model",
        cost: null,
      });
      const opts = parseRepriceArgs([
        "--tenant",
        "all",
        "--provider",
        "openai-compatible",
        "--model",
        "local-model",
        "--apply",
      ]);
      await runReprice(suDb, opts);
      // 6,000 fresh and 4,000 cached input at the input rate (no cache rate stated), 2,000 output.
      expect(await read(unpricedA)).toEqual({
        cost: (0.01 + 0.004).toFixed(10),
        table: "tenant-override@2026-09-26T00:00:00.000Z",
      });
      expect(await read(unpricedB)).toEqual({ cost: null, table: OLD });
      // A server with no model name: the ledger's empty model, priced by a price for "".
      await suDb.tenant.update({
        where: { id: tA },
        data: {
          settings: {
            priceOverrides: {
              ...block,
              overrides: [{ ...block.overrides[0], model: "" }],
            },
          },
        },
      });
      await runReprice(
        suDb,
        parseRepriceArgs([
          "--tenant",
          "all",
          "--provider",
          "openai-compatible",
          "--model",
          "",
          "--apply",
        ]),
      );
      expect(await read(namelessA)).toEqual({
        cost: (0.01 + 0.004).toFixed(10),
        table: "tenant-override@2026-09-26T00:00:00.000Z",
      });
    } finally {
      await suDb.tenant.update({ where: { id: tA }, data: { settings: {} } });
    }
  });

  test("a row the table cannot price is left as it was and counted, priced or null", async () => {
    await clear();
    // deepseek-chat carries no cache-write rate, so a call that wrote to the cache has no price.
    const pricedRow = await seed({ written: 1_000, cost: "0.5000000000" });
    const nullRow = await seed({ written: 1_000, cost: null });
    const report = await runReprice(suDb, {
      tenant: tA,
      provider: "deepseek",
      model: MODEL,
      apply: true,
    });
    expect(report.written).toBe(0);
    expect(report.groups[0]).toMatchObject({
      matched: 2,
      changed: 0,
      unpriceable: 2,
      unpricedBefore: 1,
      unpricedAfter: 1,
    });
    expect(report.groups[0]?.afterUsd.toFixed(10)).toBe("0.5000000000");
    expect(await read(pricedRow)).toEqual({ cost: "0.5000000000", table: OLD });
    expect(await read(nullRow)).toEqual({ cost: null, table: OLD });
  });

  test("the price_table filter targets only the rows that table wrote", async () => {
    await clear();
    const fromA = await seed({ table: "litellm@aaaaaaaaaaaa" });
    const fromB = await seed({ table: "litellm@bbbbbbbbbbbb" });
    const noTable = await seed({ table: null, cost: null });
    await runReprice(suDb, {
      tenant: tA,
      provider: "deepseek",
      model: MODEL,
      priceTable: "litellm@aaaaaaaaaaaa",
      apply: true,
    });
    expect(await read(fromA)).toEqual({
      cost: priced(PEAK),
      table: PRICE_TABLE_VERSION,
    });
    expect(await read(fromB)).toEqual({
      cost: WRONG,
      table: "litellm@bbbbbbbbbbbb",
    });
    // Without the filter, the rows no table priced stay out.
    const all = await runReprice(suDb, {
      tenant: tA,
      provider: "deepseek",
      model: MODEL,
      apply: true,
    });
    expect(all.groups[0]?.matched).toBe(2);
    expect(await read(noTable)).toEqual({ cost: null, table: null });
    // And they are reached only by asking for them.
    await runReprice(suDb, {
      tenant: tA,
      provider: "deepseek",
      model: MODEL,
      priceTable: null,
      apply: true,
    });
    expect(await read(noTable)).toEqual({
      cost: priced(PEAK),
      table: PRICE_TABLE_VERSION,
    });
  });

  test("each row is priced at its own created_at: DeepSeek's off-peak half", async () => {
    await clear();
    const peak = await seed({ at: PEAK });
    const off = await seed({ at: OFF });
    await runReprice(suDb, {
      tenant: tA,
      provider: "deepseek",
      model: MODEL,
      apply: true,
    });
    const p = await read(peak);
    const o = await read(off);
    expect(p.cost).toBe("0.0026320000");
    expect(o.cost).toBe("0.0013160000");
  });

  test("a tenant run leaves the other tenant alone; `all` reaches both, on the runtime role too", async () => {
    await clear();
    // A period nothing else in the suite writes into, so `all` sees only these two.
    const at = "2001-03-01T07:30:00Z";
    const a = await seed({ tenant: tA, at });
    const b = await seed({ tenant: tB, at });
    await runReprice(suDb, {
      tenant: tA,
      provider: "deepseek",
      model: MODEL,
      apply: true,
    });
    expect((await read(a)).table).toBe(PRICE_TABLE_VERSION);
    expect(await read(b)).toEqual({ cost: WRONG, table: OLD });

    await suDb.$executeRaw`UPDATE llm_usage SET cost_usd = ${WRONG}::numeric, price_table = ${OLD} WHERE id = ${a}`;
    // The runtime role sees no tenant's rows without a scope; the runner enters the fleet role.
    const report = await runReprice(appDb, {
      tenant: "all",
      provider: "deepseek",
      model: MODEL,
      from: new Date("2001-03-01"),
      to: new Date("2001-03-02"),
      apply: true,
    });
    expect(report.groups.map((g) => g.tenantId)).toEqual([tA, tB]);
    expect(report.written).toBe(2);
    expect(await read(a)).toEqual({
      cost: priced(at),
      table: PRICE_TABLE_VERSION,
    });
    expect(await read(b)).toEqual({
      cost: priced(at),
      table: PRICE_TABLE_VERSION,
    });
  });
});
