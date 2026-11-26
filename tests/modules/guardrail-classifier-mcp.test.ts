import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentSettingsSet } from "@/modules/mcp/write";
import { dbProbeFailed } from "@/tests/db-gate";

// The MCP patch is merged before it is whole: a patch naming only the classifier meets the stored
// action, and the default dry run must refuse what the apply would.

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

describe.skipIf(!dbUp)("the guardrails classifier through MCP", () => {
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
  const storedGuardrails = async () =>
    (
      (
        await suDb.agent.findUniqueOrThrow({
          where: { id: agentId },
          select: { settings: true },
        })
      ).settings as Record<string, Record<string, unknown>> | null
    )?.guardrails;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "GRCLS", slug: `grcls-${process.pid}` },
    });
    tenantId = t.id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Gr",
          systemPrompt: "p",
          settings: {
            guardrails: {
              enabled: true,
              output: { enabled: true, action: "generated" },
            },
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.agent.deleteMany({ where: { tenantId } }).catch(() => {});
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a patch naming only the classifier is refused in the preview, as in the apply", async () => {
    const before = await storedGuardrails();
    for (const dry_run of [undefined, false]) {
      const r = await agentSettingsSet(
        principal(),
        {
          agent_id: String(agentId),
          dry_run,
          guardrails: { classifier: "decisions" },
        } as never,
        { base: appDb },
      );
      expect(r.ok, String(dry_run)).toBe(false);
      expect(JSON.stringify(r)).toContain("action");
    }
    expect(await storedGuardrails()).toEqual(before);
  });

  test("with the action moved off generated in the same patch, the preview passes", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        guardrails: {
          classifier: "decisions",
          output: { action: "template" },
        },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(true);
  });
});
