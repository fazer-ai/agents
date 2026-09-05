import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
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
  // An experiment names the agent it applies to, so every row this describe writes needs one.
  let target = 0n;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ABC", slug: `abc-${process.pid}` },
    });
    tnt = t.id;
    const a = await suDb.agent.create({
      data: {
        tenantId: tnt,
        name: "target",
        systemPrompt: "BASE",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
      select: { id: true },
    });
    target = a.id;
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
      agentId: target,
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

  test("an experiment names the agent it applies to, on the create and on the update", async () => {
    const variants: Variant[] = [{ key: "a", weight: 1 }];

    // Absent is what a caller reading "or null for any agent" sends, and the row it would write is
    // one `resolveVariantOverride` can never match: that lookup is by exact id, so the experiment
    // reads `enabled: true` everywhere and overrides no turn, ever.
    const loose = await createExperiment({
      ctx: ctxOf(tnt),
      name: "loose",
      variants,
      base: appDb,
    }).catch((e: unknown) => e);
    expect(loose).toBeInstanceOf(AppError);
    const l = loose as AppError;
    expect({
      status: l.statusCode,
      key: l.translationKey,
      field: l.field,
    }).toEqual({
      status: 400,
      key: "errors.experimentAgentRequired",
      field: "agentId",
    });
    expect(
      await suDb.experiment.count({ where: { tenantId: tnt, name: "loose" } }),
    ).toBe(0);

    // And the PATCH, which is the half that costs: clearing the agent of an experiment that works
    // reads as "widen it to every agent" and silences it instead.
    const { id } = await createExperiment({
      ctx: ctxOf(tnt),
      name: "bound",
      agentId: target,
      variants,
      base: appDb,
    });
    const cleared = await updateExperiment({
      ctx: ctxOf(tnt),
      id,
      agentId: null,
      base: appDb,
    }).catch((e: unknown) => e);
    expect(cleared).toBeInstanceOf(AppError);
    expect((cleared as AppError).translationKey).toBe(
      "errors.experimentAgentRequired",
    );
    expect(
      (
        await suDb.experiment.findUniqueOrThrow({
          where: { id },
          select: { agentId: true },
        })
      ).agentId,
    ).toBe(target);

    // The positive control the two refusals are FOR: a row stored before this rule existed is
    // exactly what they now prevent, and it still overrides nobody. `bound` goes first, so the
    // agent-less row is the only enabled experiment left and a null answer can only be about it.
    await deleteExperiment(ctxOf(tnt), id, appDb);
    expect(
      await suDb.experiment.count({
        where: { tenantId: tnt, agentId: target, enabled: true },
      }),
    ).toBe(0);
    const legacy = await suDb.experiment.create({
      data: {
        tenantId: tnt,
        name: "legacy",
        agentId: null,
        variants: [{ key: "a", weight: 1, systemPrompt: "LEGACY" }],
        enabled: true,
      },
      select: { id: true },
    });
    expect(
      await runScopedOn(appDb, ctxOf(tnt), (db) =>
        resolveVariantOverride(db, {
          tenantId: tnt,
          agentId: target,
          threadId: `${tnt}:1:547`,
        }),
      ),
    ).toBeNull();

    // The PR says such a row "stays inert, and naming an agent is what repairs it". The first half
    // is the assertion above; this is the second, which was prose until it was run. The patch names
    // only the agent, which is the whole repair an operator has, and the same resolver then answers
    // with the variant on a thread that has no assignment yet.
    await updateExperiment({
      ctx: ctxOf(tnt),
      id: legacy.id,
      agentId: target,
      base: appDb,
    });
    expect(
      await runScopedOn(appDb, ctxOf(tnt), (db) =>
        resolveVariantOverride(db, {
          tenantId: tnt,
          agentId: target,
          threadId: `${tnt}:1:547-repaired`,
        }),
      ),
    ).toBe("LEGACY");
    await suDb.experiment.delete({ where: { id: legacy.id } });
  });
});
