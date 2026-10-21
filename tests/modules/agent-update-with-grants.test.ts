import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  createAgent,
  getAgent,
  getAgentToolSelections,
  replaceAgentToolSelections,
  updateAgentAndGrants,
} from "@/modules/agents/service";
import { TOOL_INSTRUCTIONS_MAX } from "@/modules/agents/text-caps";
import { dbProbeFailed } from "@/tests/db-gate";

// The editor's Save writes the agent's fields and its whole grant set in one request, so the two
// halves are one transaction under one version token: either both land or neither does.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const NOTE = [{ source: "NATIVE" as const, enabledTools: ["private_note"] }];
const NOTE_AND_LABELS = [
  {
    source: "NATIVE" as const,
    enabledTools: ["private_note", "set_labels"],
  },
];

async function seed(name: string) {
  const a = await createAgent(ctx(), { name }, appDb);
  const id = BigInt(a.id);
  await replaceAgentToolSelections(ctx(), id, NOTE, appDb);
  return { id, loaded: (await getAgent(ctx(), id, appDb)).updatedAt };
}

const enabledTools = async (id: bigint) =>
  (await getAgentToolSelections(ctx(), id, appDb)).grants.flatMap(
    (g) => g.enabledTools,
  );

const audit = (id: bigint, action: string) =>
  suDb.auditLog.count({
    where: { tenantId, target: `agent:${id}`, action },
  });

describe.skipIf(!dbUp)("an agent update that also writes the grants", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Whole", slug: `whole-save-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("writes the fields and the set together, under one token", async () => {
    const { id, loaded } = await seed("Both");
    await Bun.sleep(5);
    const { agent, toolSelection } = await updateAgentAndGrants(
      ctx(),
      id,
      { name: "Both renamed" },
      NOTE_AND_LABELS,
      appDb,
      { expectedUpdatedAt: loaded },
    );
    expect(agent.name).toBe("Both renamed");
    expect(agent.updatedAt.getTime()).toBeGreaterThan(loaded.getTime());
    expect(toolSelection?.agentUpdatedAt?.getTime()).toBe(
      agent.updatedAt.getTime(),
    );
    expect(await enabledTools(id)).toEqual(["private_note", "set_labels"]);
    expect((await getAgent(ctx(), id, appDb)).updatedAt.getTime()).toBe(
      agent.updatedAt.getTime(),
    );
    // The seed's own set, then this one.
    expect(await audit(id, "agent.tools_set")).toBe(2);
  });

  test("a refused settings bag leaves the grants as they were", async () => {
    const { id, loaded } = await seed("Settings refused");
    await expect(
      updateAgentAndGrants(
        ctx(),
        id,
        {
          name: "Not this",
          settings: {
            handoff: {
              mode: "route",
              instructions: "g".repeat(TOOL_INSTRUCTIONS_MAX + 1),
            },
          },
        },
        NOTE_AND_LABELS,
        appDb,
        { expectedUpdatedAt: loaded },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await enabledTools(id)).toEqual(["private_note"]);
    const after = await getAgent(ctx(), id, appDb);
    expect(after.name).toBe("Settings refused");
    expect(after.updatedAt.getTime()).toBe(loaded.getTime());
  });

  test("a refused grant leaves the fields as they were", async () => {
    const { id, loaded } = await seed("Grant refused");
    await expect(
      updateAgentAndGrants(
        ctx(),
        id,
        { name: "Not this" },
        [{ source: "HTTP", toolDefinitionId: "999999999" }],
        appDb,
        { expectedUpdatedAt: loaded },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    const after = await getAgent(ctx(), id, appDb);
    expect(after.name).toBe("Grant refused");
    expect(after.updatedAt.getTime()).toBe(loaded.getTime());
    expect(await enabledTools(id)).toEqual(["private_note"]);
  });

  test("a stale token writes neither half (409)", async () => {
    const { id, loaded } = await seed("Stale");
    await Bun.sleep(5);
    await replaceAgentToolSelections(ctx(), id, NOTE, appDb);
    await expect(
      updateAgentAndGrants(
        ctx(),
        id,
        { name: "Not this" },
        NOTE_AND_LABELS,
        appDb,
        { expectedUpdatedAt: loaded },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await getAgent(ctx(), id, appDb)).name).toBe("Stale");
    expect(await enabledTools(id)).toEqual(["private_note"]);
  });

  test("the grants alone are a write, and advance the token", async () => {
    const { id, loaded } = await seed("Grants only");
    await Bun.sleep(5);
    const { agent, toolSelection } = await updateAgentAndGrants(
      ctx(),
      id,
      {},
      NOTE_AND_LABELS,
      appDb,
      { expectedUpdatedAt: loaded },
    );
    expect(agent.updatedAt.getTime()).toBeGreaterThan(loaded.getTime());
    expect(toolSelection?.grants).toHaveLength(1);
    expect(await enabledTools(id)).toEqual(["private_note", "set_labels"]);
  });

  test("without grants the set is untouched and no selection is answered", async () => {
    const { id, loaded } = await seed("No grants");
    const { toolSelection } = await updateAgentAndGrants(
      ctx(),
      id,
      { name: "Renamed only" },
      null,
      appDb,
      { expectedUpdatedAt: loaded },
    );
    expect(toolSelection).toBeNull();
    expect(await enabledTools(id)).toEqual(["private_note"]);
    expect(await audit(id, "agent.tools_set")).toBe(1);
  });

  test("an empty set is a set: it clears the grants", async () => {
    const { id, loaded } = await seed("Cleared");
    const { toolSelection } = await updateAgentAndGrants(
      ctx(),
      id,
      {},
      [],
      appDb,
      { expectedUpdatedAt: loaded },
    );
    expect(toolSelection?.grants).toEqual([]);
    expect(await enabledTools(id)).toEqual([]);
  });
});
