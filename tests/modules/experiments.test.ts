import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  chooseVariant,
  createExperiment,
  deleteExperiment,
  experimentResults,
  getExperiment,
  listExperiments,
  resolveVariantOverride,
  updateExperiment,
  type Variant,
} from "@/modules/experiments/service";

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN — the role that tells `runScopedOn` the id never came from outside (issue #280).
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

describe("chooseVariant (deterministic)", () => {
  const variants: Variant[] = [
    { key: "a", systemPrompt: "PA" },
    { key: "b", systemPrompt: "PB" },
  ];
  test("same thread → same variant", () => {
    expect(chooseVariant("t:1:42", variants)).toBe(
      chooseVariant("t:1:42", variants),
    );
  });
  test("a zero-weight variant is never chosen", () => {
    const v: Variant[] = [
      { key: "a", weight: 0 },
      { key: "b", weight: 1 },
    ];
    for (const tid of ["x", "y", "z", "thread-123", "abc"]) {
      expect(chooseVariant(tid, v)).toBe("b");
    }
  });
});

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let agentId = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("resolveVariantOverride", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "AB", slug: `ab-${process.pid}` },
    });
    tenantId = t.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "A",
        systemPrompt: "BASE",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    agentId = agent.id;
    await createExperiment({
      ctx: ctxOf(tenantId),
      name: "prompts",
      agentId,
      variants: [
        { key: "a", weight: 1, systemPrompt: "VARIANT-A" },
        { key: "b", weight: 1, systemPrompt: "VARIANT-B" },
      ],
      base: appDb,
    });
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM prompt_variant_assignments WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM experiments WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("assigns a variant prompt and is stable + idempotent across calls", async () => {
    const thread = `${tenantId}:1:900`;
    const first = await runScopedOn(appDb, ctx(tenantId), (db) =>
      resolveVariantOverride(db, { tenantId, agentId, threadId: thread }),
    );
    expect(first).not.toBeNull();
    expect(["VARIANT-A", "VARIANT-B"]).toContain(first as string);
    const second = await runScopedOn(appDb, ctx(tenantId), (db) =>
      resolveVariantOverride(db, { tenantId, agentId, threadId: thread }),
    );
    expect(second).toBe(first as string);
    const count = await suDb.promptVariantAssignment.count({
      where: { tenantId, threadId: thread },
    });
    expect(count).toBe(1); // exactly one assignment row
  });

  test("no active experiment → null (base prompt used)", async () => {
    const override = await runScopedOn(appDb, ctx(tenantId), (db) =>
      resolveVariantOverride(db, {
        tenantId,
        agentId: agentId + 9999n,
        threadId: `${tenantId}:1:901`,
      }),
    );
    expect(override).toBeNull();
  });
});

describe.skipIf(!dbUp)("experiments CRUD + results", () => {
  let tnt = 0n;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ABC", slug: `abc-${process.pid}` },
    });
    tnt = t.id;
  });

  afterAll(async () => {
    if (!tnt) return;
    for (const tbl of [
      "prompt_variant_assignments",
      "conversion_events",
      "experiments",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${tbl} WHERE tenant_id = ${tnt}`,
      );
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tnt}`);
  });

  test("CRUD + results reflect conversions per variant", async () => {
    const { id } = await createExperiment({
      ctx: ctxOf(tnt),
      name: "x",
      variants: [
        { key: "a", weight: 1 },
        { key: "b", weight: 1 },
      ],
      base: appDb,
    });
    expect((await getExperiment(ctxOf(tnt), id, appDb)).name).toBe("x");
    expect(
      (await listExperiments(ctxOf(tnt), appDb)).length,
    ).toBeGreaterThanOrEqual(1);
    const upd = await updateExperiment({
      ctx: ctxOf(tnt),
      id,
      enabled: false,
      base: appDb,
    });
    expect(upd.enabled).toBe(false);

    // Two threads on variant "a"; only one converts.
    await suDb.promptVariantAssignment.create({
      data: {
        tenantId: tnt,
        experimentId: id,
        threadId: "th-1",
        variantKey: "a",
      },
    });
    await suDb.promptVariantAssignment.create({
      data: {
        tenantId: tnt,
        experimentId: id,
        threadId: "th-2",
        variantKey: "a",
      },
    });
    await suDb.conversionEvent.create({
      data: { tenantId: tnt, threadId: "th-1", source: "test" },
    });
    const res = await experimentResults(ctxOf(tnt), id, appDb);
    const a = res.variants.find((v) => v.key === "a");
    expect(a?.assigned).toBe(2);
    expect(a?.converted).toBe(1);
    expect(a?.conversionRate).toBe(0.5);

    await deleteExperiment(ctxOf(tnt), id, appDb);
    expect(getExperiment(ctxOf(tnt), id, appDb)).rejects.toThrow();
  });
});
