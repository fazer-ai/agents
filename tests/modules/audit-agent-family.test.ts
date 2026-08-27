import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  cloneAgent,
  createAgent,
  deleteAgent,
  getAgentToolSelections,
  replaceAgentToolSelections,
  updateAgent,
} from "@/modules/agents/service";
import { exportAgent, importAgent } from "@/modules/agents/transfer";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentSettingsSet, promptSet } from "@/modules/mcp/write";
import { agentUpdate } from "@/modules/mcp/write-agents";

// The agent-configuration trail, recorded by the service instead of by the MCP transport.
//
// Eight actions were audited (`agent.create`, `.update`, `.delete`, `.clone`, `.import`,
// `.tools_set`, `.prompt_set`, `.settings_set`) and all eight were written by `write-agents.ts` /
// `write.ts` after the service had committed. The six REST routes of `agents.controller.ts` reach
// the SAME service functions and wrote nothing, so the console — which speaks REST — left no trace
// of a config change at all.
//
// Three of those actions (`agent.update`, `.prompt_set`, `.settings_set`) funnel into ONE function,
// `updateAgent`. So the move is not a transcription: the service has to decide which of the three a
// call is, and it cannot ask the caller. It decides from the DIFF, which is what `docs/mcp.md`
// already promises ("the same change leaves the same row whichever of the three transports made
// it") — and the console makes that the only workable rule, because its General tab PATCHes `name`,
// `systemPrompt`, `enabled`, `mode` and `modelConfig` together on every save, changed or not.

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
let tenantId = 0n;

const USER = 9391n;

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

const principal = (over: Partial<VerifiedToken> = {}): VerifiedToken => ({
  userId: USER,
  tenantId,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
  ...over,
});

async function rows(action?: string) {
  return (
    (await su?.auditLog.findMany({
      where: { tenantId, ...(action ? { action } : {}) },
      orderBy: { id: "asc" },
    })) ?? []
  );
}

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
  );
}

async function seedAgent(over: Record<string, unknown> = {}) {
  return createAgent(
    ctx(),
    {
      name: `A-${Math.floor(Number(process.pid))}`,
      systemPrompt: "you answer politely",
      ...over,
    },
    appDb,
  );
}

describe.skipIf(!dbUp)("the agent family records its own changes", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "AUDAG", slug: `audag-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      for (const table of [
        "audit_logs",
        "agent_tool_selections",
        "agents",
        "business_hours",
      ]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // ── the console's door, which today leaves nothing ──

  test("a change made through the service — the door the console speaks — leaves a row", async () => {
    const agent = await seedAgent();
    await clearAudit();

    await updateAgent(ctx(), BigInt(agent.id), { name: "renamed" }, appDb);

    const got = await rows("agent.update");
    expect(got.length).toBe(1);
    expect(got[0]?.target).toBe(`agent:${agent.id}`);
    expect(got[0]?.actorId).toBe(USER);
    expect(got[0]?.actorType).toBe("user");
    expect(got[0]?.before).toEqual({ name: agent.name });
    expect(got[0]?.after).toEqual({ name: "renamed" });
  });

  test("creating, cloning and deleting through the service each leave the row the tool used to write", async () => {
    await clearAudit();
    const agent = await seedAgent({ name: `seed-${process.pid}` });
    const clone = await cloneAgent(ctx(), BigInt(agent.id), "the copy", appDb);
    await deleteAgent(ctx(), BigInt(clone.id), appDb);

    expect((await rows()).map((r) => r.action)).toEqual([
      "agent.create",
      "agent.clone",
      "agent.delete",
    ]);
    const [created, cloned, deleted] = await rows();
    expect(created?.after).toEqual({
      id: agent.id,
      name: `seed-${process.pid}`,
      enabled: agent.enabled,
    });
    expect(cloned?.after).toEqual({
      id: clone.id,
      name: "the copy",
      clonedFrom: agent.id,
    });
    expect(deleted?.before).toEqual({ id: clone.id, name: "the copy" });
    expect(deleted?.after).toBeNull();
  });

  test("replacing the tool grants through the service leaves the grants, before and after", async () => {
    const agent = await seedAgent();
    await clearAudit();
    const before = await getAgentToolSelections(ctx(), BigInt(agent.id), appDb);

    const view = await replaceAgentToolSelections(
      ctx(),
      BigInt(agent.id),
      [{ source: "NATIVE", enabledTools: ["handoff_to_human"] }],
      appDb,
    );

    const got = await rows("agent.tools_set");
    expect(got.length).toBe(1);
    expect(got[0]?.before).toEqual(
      JSON.parse(JSON.stringify({ grants: before.grants })),
    );
    expect(got[0]?.after).toEqual(
      JSON.parse(JSON.stringify({ grants: view.grants })),
    );
  });

  test("importing an agent through the service leaves the import row", async () => {
    const source = await seedAgent({ name: `exp-${process.pid}` });
    const doc = await exportAgent(ctx(), BigInt(source.id), appDb);
    await clearAudit();

    const { agent } = await importAgent(ctx(), doc, appDb);

    const got = await rows("agent.import");
    expect(got.length).toBe(1);
    expect(got[0]?.after).toEqual({
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      mode: agent.mode,
    });
  });

  // ── which of the three actions a call to updateAgent is, decided by the diff ──

  test("the console's General save records the prompt rewrite as prompt_set, not as a generic update", async () => {
    // The editor's General tab always sends these five fields, changed or not (AgentEditorPage:
    // `saveAgent({ name, systemPrompt, enabled, mode, modelConfig }, "general")`). Reading the
    // action off the fields the patch NAMES would file every console prompt edit as `agent.update`,
    // while the same edit over MCP files as `agent.prompt_set` — which is exactly the divergence
    // `docs/mcp.md` says the seam removes.
    const agent = await seedAgent();
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        name: agent.name,
        systemPrompt: "a different prompt",
        enabled: agent.enabled,
        mode: agent.mode,
        modelConfig: agent.modelConfig,
      },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.prompt_set"]);
    expect(got[0]?.before).toEqual({ systemPrompt: "you answer politely" });
    expect(got[0]?.after).toEqual({ systemPrompt: "a different prompt" });
  });

  test("the same prompt rewrite through MCP and through the service leaves the same action and the same projection", async () => {
    const viaService = await seedAgent();
    const viaMcp = await seedAgent();
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(viaService.id),
      { systemPrompt: "the new text" },
      appDb,
    );
    await promptSet(
      principal(),
      {
        agent_id: viaMcp.id,
        system_prompt: "the new text",
        dry_run: false,
      },
      { base: appDb },
    );

    const got = await rows("agent.prompt_set");
    expect(got.length).toBe(2);
    expect(got[0]?.before).toEqual(got[1]?.before);
    expect(got[0]?.after).toEqual(got[1]?.after);
    // The door is `actorType`, and it is the ONLY thing that separates the two rows.
    expect(got.map((r) => r.actorType)).toEqual(["user", "mcp"]);
  });

  test("a change that spans two fields is an update, and carries both", async () => {
    const agent = await seedAgent();
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { name: "two things", systemPrompt: "and a new prompt" },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.update"]);
    expect(got[0]?.before).toEqual({
      name: agent.name,
      systemPrompt: "you answer politely",
    });
    expect(got[0]?.after).toEqual({
      name: "two things",
      systemPrompt: "and a new prompt",
    });
  });

  test("the Behavior tab's own shape is an update, because it moves more than the bag", async () => {
    // `saveAgent({ businessHoursId, followUpHoursId, settings: buildSettings() }, "behavior")`.
    // `settings` sorts BEFORE `followUpHoursId` in the audited field list, so an action read off
    // the FIRST changed field — rather than off the only one — would file this as
    // `agent.settings_set` and lose the schedule change from the row it is named after.
    const hours = await runScopedOn(appDb, ctx(), (db) =>
      db.businessHours.create({
        data: {
          tenantId,
          name: `h-${process.pid}`,
          timezone: "America/Sao_Paulo",
          windows: [],
          exceptions: [],
        },
        select: { id: true },
      }),
    );
    const agent = await seedAgent({
      settings: { debounce: { enabled: true, windowSeconds: 15 } },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        followUpHoursId: String(hours.id),
        settings: { debounce: { enabled: true, windowSeconds: 90 } },
      },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.update"]);
    expect(
      Object.keys(got[0]?.after as Record<string, unknown>).sort(),
    ).toEqual(["followUpHoursId", "settings"]);
  });

  test("a prompt rewrite alongside a toggle is an update, not a prompt_set", async () => {
    const agent = await seedAgent();
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { systemPrompt: "rewritten", enabled: !agent.enabled },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.update"]);
  });

  test("an apply that changes nothing leaves no row", async () => {
    const agent = await seedAgent();
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        enabled: agent.enabled,
        mode: agent.mode,
      },
      appDb,
    );

    expect(await rows()).toEqual([]);
  });

  test("settings project the blocks that changed, never the whole bag", async () => {
    const agent = await seedAgent({
      settings: {
        debounce: { enabled: true, windowSeconds: 15 },
        split: { enabled: true, maxChars: 300 },
      },
    });
    await clearAudit();

    // The console sends the bag whole (`buildSettings()` spreads it), so what says "the operator
    // touched debounce" is the comparison, not the payload.
    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          debounce: { enabled: true, windowSeconds: 40 },
          split: { enabled: true, maxChars: 300 },
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.settings_set"]);
    const before = got[0]?.before as Record<string, unknown>;
    const after = got[0]?.after as Record<string, unknown>;
    expect(Object.keys(before)).toEqual(["debounce"]);
    expect(Object.keys(after)).toEqual(["debounce"]);
    expect((after.debounce as Record<string, unknown>).windowSeconds).toBe(40);
  });

  test("the MCP settings tool still writes its own action, and exactly one row", async () => {
    const agent = await seedAgent({
      settings: { debounce: { enabled: true, windowSeconds: 15 } },
    });
    await clearAudit();

    await agentSettingsSet(
      principal(),
      {
        agent_id: agent.id,
        debounce: { windowSeconds: 25 },
        dry_run: false,
      },
      { base: appDb },
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.settings_set"]);
    expect(got[0]?.actorType).toBe("mcp");
  });

  test("a first settings write also names guardrails, because the reader is not idempotent there", async () => {
    // Pinning an artifact, not endorsing it. `readGuardrailsConfig` resolves an empty `model` to the
    // provider default only when the block is PRESENT; absent, it returns `model: ""`. Every
    // settings write goes through `mergeBehaviorSettings`, which materializes the block, so the
    // first one moves `guardrails.model` from "" to the default without an operator asking.
    // Harmless at runtime (an absent block is `enabled: false`), true of the column, and this test
    // is what fails the day the reader is fixed.
    const agent = await seedAgent({
      settings: { debounce: { enabled: true, windowSeconds: 15 } },
    });
    await clearAudit();

    await agentSettingsSet(
      principal(),
      { agent_id: agent.id, debounce: { windowSeconds: 25 }, dry_run: false },
      { base: appDb },
    );

    const after = (await rows())[0]?.after as Record<string, unknown>;
    expect(Object.keys(after).sort()).toEqual(["debounce", "guardrails"]);
    expect((after.guardrails as Record<string, unknown>).model).not.toBe("");
  });

  test("the MCP update tool writes one row, not one per layer", async () => {
    const agent = await seedAgent();
    await clearAudit();

    await agentUpdate(
      principal(),
      { agent_id: agent.id, name: "via mcp", dry_run: false },
      { base: appDb },
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.update"]);
    expect(got[0]?.actorType).toBe("mcp");
  });

  // ── the row shares the mutation's transaction ──

  test("a refused update leaves neither the change nor a row", async () => {
    const agent = await seedAgent();
    await clearAudit();

    await expect(
      updateAgent(
        ctx(),
        BigInt(agent.id),
        { businessHoursId: "999999999" },
        appDb,
      ),
    ).rejects.toThrow();

    expect(await rows()).toEqual([]);
    const still = await runScopedOn(appDb, ctx(), (db) =>
      db.agent.findUnique({
        where: { id: BigInt(agent.id) },
        select: { businessHoursId: true },
      }),
    );
    expect(still?.businessHoursId).toBeNull();
  });

  test("a dry run applies nothing and records nothing", async () => {
    const agent = await seedAgent();
    await clearAudit();

    await promptSet(
      principal(),
      { agent_id: agent.id, system_prompt: "never applied" },
      { base: appDb },
    );

    expect(await rows()).toEqual([]);
  });
});
