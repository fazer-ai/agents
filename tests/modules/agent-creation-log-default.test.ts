import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { createAgent } from "@/modules/agents/service";
import { exportAgent, importAgent } from "@/modules/agents/transfer";

// An agent created while the server runs in development logs tool values from birth, so a fresh
// local database does not start every test round by switching it on, agent by agent. Created
// anywhere else it starts off. The export carries no logging switches, so a development agent
// does not arrive elsewhere with them on.

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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const originalEnv = config.env;

async function storedObservability(id: string | bigint) {
  const row = await suDb.agent.findFirstOrThrow({
    where: { id: BigInt(id) },
    select: { settings: true },
  });
  return (row.settings as Record<string, unknown>).observability as
    | Record<string, unknown>
    | undefined;
}

describe.skipIf(!dbUp)("the tool-values switch an agent is born with", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "LOGDEF", slug: `logdef-${process.pid}` },
      })
    ).id;
  });

  afterEach(() => {
    config.env = originalEnv;
  });

  afterAll(async () => {
    config.env = originalEnv;
    if (dbUp && tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("created in development, it logs tool values", async () => {
    config.env = "development";
    const a = await createAgent(ctx(), { name: "dev" }, appDb);
    expect((await storedObservability(a.id))?.logToolValues).toBe(true);
  });

  test("created in development with the switch off, it stays off", async () => {
    config.env = "development";
    const a = await createAgent(
      ctx(),
      {
        name: "dev-off",
        settings: { observability: { logToolValues: false } },
      },
      appDb,
    );
    expect((await storedObservability(a.id))?.logToolValues).toBe(false);
  });

  test("created in production, it does not", async () => {
    config.env = "production";
    const a = await createAgent(ctx(), { name: "prod" }, appDb);
    expect((await storedObservability(a.id))?.logToolValues ?? false).toBe(
      false,
    );
  });

  test("the export carries no logging switches, and a development import logs values", async () => {
    config.env = "production";
    const source = await createAgent(
      ctx(),
      {
        name: "source",
        settings: { observability: { logToolValues: true } },
      },
      appDb,
    );
    const exp = await exportAgent(ctx(), BigInt(source.id), appDb);
    expect("observability" in (exp.agent.settings ?? {})).toBe(false);

    config.env = "development";
    const { agent } = await importAgent(
      ctx(),
      { ...exp, agent: { ...exp.agent, name: "imported-dev" } },
      appDb,
    );
    expect((await storedObservability(agent.id))?.logToolValues).toBe(true);
  });

  test("an older export that still carries the switch keeps what it says", async () => {
    config.env = "development";
    const source = await createAgent(ctx(), { name: "older" }, appDb);
    const exp = await exportAgent(ctx(), BigInt(source.id), appDb);
    const { agent } = await importAgent(
      ctx(),
      {
        ...exp,
        agent: {
          ...exp.agent,
          name: "older-import",
          settings: {
            ...exp.agent.settings,
            observability: { logToolValues: false },
          },
        },
      },
      appDb,
    );
    expect((await storedObservability(agent.id))?.logToolValues).toBe(false);
  });
});
