import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentSettingsGet, agentSettingsSet } from "@/modules/mcp/write";

// Issue #402, end to end: the five blocks that MCP could not reach are WRITTEN through it and read
// back. Asserted against the stored bag and against agent_settings_get, not against the return value
// of the write — a set that answers ok and stores nothing is exactly the failure this is about, and
// it looks identical from the caller's side.
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
    // The APP role, passed explicitly: the preload points the default client at a placeholder URL on
    // purpose, so a test that forgets to hand the client in fails loudly instead of reaching a real
    // database it did not name.
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

describe.skipIf(!dbUp)("the five blocks reach the agent through MCP", () => {
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

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MCP402", slug: `mcp402-${process.pid}` },
    });
    tenantId = t.id;
    const a = await suDb.agent.create({
      data: { tenantId, name: "Bot", systemPrompt: "p" },
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

  test("all five apply in one call, and land in the stored bag", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        guardrails: {
          enabled: true,
          input: { enabled: true, action: "silent" },
        },
        kanban: { instructions: "move on a signed quote" },
        appointmentReminders: { enabled: true, offsetsHours: [48, 2] },
        toolGuidance: { handoff_to_human: "only after the quote" },
        toolPreconditions: {
          handoff_to_human: {
            kind: "attribute",
            scope: "conversation",
            key: "article_url",
          },
        },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(true);

    const stored = (
      await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings as Record<string, Record<string, unknown>>;

    expect(stored.guardrails?.enabled).toBe(true);
    expect(stored.kanban?.instructions).toBe("move on a signed quote");
    expect(stored.appointmentReminders?.offsetsHours).toEqual([48, 2]);
    expect(stored.toolGuidance?.handoff_to_human).toBe("only after the quote");
    expect(stored.toolPreconditions?.handoff_to_human).toEqual({
      kind: "attribute",
      scope: "conversation",
      key: "article_url",
    });
  });

  test("and agent_settings_get gives them back", async () => {
    const r = await agentSettingsGet(
      principal(),
      { agent_id: String(agentId) },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = (r.data as { settings: Record<string, Record<string, unknown>> })
      .settings;
    expect(s.guardrails?.enabled).toBe(true);
    expect(s.kanban?.instructions).toBe("move on a signed quote");
    // Read back through the READER, so this also pins the reader's own normalization: the offsets
    // come back sorted far→near whatever order they went in as.
    expect(s.appointmentReminders?.offsetsHours).toEqual([48, 2]);
    expect(s.toolGuidance?.handoff_to_human).toBe("only after the quote");
    expect(s.toolPreconditions?.handoff_to_human).toBeDefined();
  });

  test("a precondition on a tool name the runtime cannot guard is REFUSED, not stored", async () => {
    // The write boundary of #378 restricts these keys to the native catalog, and MCP must not be the
    // way around it: a rule on an MCP-namespaced name reads as protection and guards nothing.
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        toolPreconditions: {
          mcp__crm__create_deal: {
            kind: "attribute",
            scope: "conversation",
            key: "cpf",
          },
        },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(false);

    const stored = (
      await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings as Record<string, Record<string, unknown>>;
    expect(stored.toolPreconditions?.mcp__crm__create_deal).toBeUndefined();
    // The rule that WAS there is untouched by the refused write.
    expect(stored.toolPreconditions?.handoff_to_human).toBeDefined();
  });

  test("a dry run previews and stores nothing", async () => {
    const before = (
      await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings;
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        kanban: { instructions: "SHOULD NOT PERSIST" },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const after = (
      await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings;
    expect(after).toEqual(before);
  });
});
