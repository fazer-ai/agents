import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { BEHAVIOR_PATCH_ARGS_SHAPE } from "@/modules/agents/settings-schema";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentSettingsSet } from "@/modules/mcp/write";
import { dbProbeFailed } from "@/tests/db-gate";

// A delay's ceiling depends on its unit, and an MCP patch may name only the value while the unit is
// stored. The merge reads the block through the reader, which clamps, so a check after it would see
// 30 and answer ok: the pair is asked raw, before the merge, and nothing is written.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

describe.skipIf(!dbUp)("a delay value patched under a stored unit", () => {
  let tenantId = 0n;
  let agentId = 0n;
  const principal = (): VerifiedToken => ({
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  });
  const stored = async () =>
    (
      await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings as Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MCP1524", slug: `mcp1524-${process.pid}` },
    });
    tenantId = t.id;
    const a = await suDb.agent.create({
      data: {
        tenantId,
        name: "Bot",
        systemPrompt: "p",
        settings: {
          channelRedirect: { resendDelayValue: 2, resendDelayUnit: "days" },
        },
      },
    });
    agentId = a.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("40 under a stored `days` is refused, and the stored delay is untouched", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        channelRedirect: { resendDelayValue: 40 },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    expect((await stored()).channelRedirect?.resendDelayValue).toBe(2);
  });

  test("a value inside the stored unit's range is written", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        channelRedirect: { resendDelayValue: 30 },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    expect((await stored()).channelRedirect?.resendDelayValue).toBe(30);
  });
});

// What tools/list publishes for a delay is what the SDK enforces before the handler: the value's own
// range, 1-43200. The unit-aware ceiling is the handler's, so a schema-valid call reaches it and is
// refused there with the field named, instead of failing a check the published schema never showed.
test("the MCP arguments take 31 days, which the handler then refuses", () => {
  const args = z.object(BEHAVIOR_PATCH_ARGS_SHAPE);
  const patch = {
    channelRedirect: { resendDelayValue: 31, resendDelayUnit: "days" },
    followUp: { steps: [{ delayValue: 31, delayUnit: "days" }] },
  };
  expect(args.safeParse(patch).success).toBe(true);
});
