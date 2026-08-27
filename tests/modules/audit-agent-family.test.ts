import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { agentUpdateAudit } from "@/modules/agents/audit-projection";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
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

// The snapshot a row is built from has to be read UNDER the lock that serializes the write, and the
// window that opens otherwise is not one a behavioural test can pin: it needs two transactions to
// interleave at one instant, and a passing run would prove nothing about the next. So the rule is
// asserted structurally, on the source, the way an ordering the engine is merely ALLOWED to break
// has to be. `lockedBeforeSnapshot` is extracted so the fixtures below can prove it catches the
// order this PR was reviewed for, which a scan over a clean tree never would.
export function lockedBeforeSnapshot(
  body: string,
  snapshot: string,
): "locked" | "unlocked" | "not found" {
  // Comment lines are dropped FIRST, and that is not tidiness. `updateAgent` explains its lock in a
  // NOTE three lines above taking it, so a scan of the raw text finds "FOR UPDATE" in the prose and
  // reports every order as locked — measured: this fence passed with the reviewed defect restored.
  const code = body
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const lock = code.indexOf("FOR UPDATE");
  const snap = code.indexOf(snapshot);
  if (lock < 0 || snap < 0) return "not found";
  return lock < snap ? "locked" : "unlocked";
}

function bodyOf(src: string, fn: string): string {
  // Both spellings: the functions this file reads are a mix of `export function` and
  // `export async function`, and anchoring on one of them threw rather than failing an assertion.
  const start = [`export async function ${fn}(`, `export function ${fn}(`]
    .map((a) => src.indexOf(a))
    .find((i) => i >= 0);
  if (start === undefined) throw new Error(`${fn} not found`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

describe("the audit snapshot is read under the write's lock", () => {
  test("the predicate catches the order this PR was reviewed for", () => {
    // Positive control: the shape the review found, and the shape that replaced it.
    const wrong = "const before = read(SNAP);\nawait sql`… FOR UPDATE`;";
    const right = "await sql`… FOR UPDATE`;\nconst before = read(SNAP);";
    expect(lockedBeforeSnapshot(wrong, "SNAP")).toBe("unlocked");
    expect(lockedBeforeSnapshot(right, "SNAP")).toBe("locked");
    expect(lockedBeforeSnapshot("nothing here", "SNAP")).toBe("not found");
    // And the prose that broke the first version of this fence.
    const commented = `// the FOR UPDATE below serializes it\n${wrong}`;
    expect(lockedBeforeSnapshot(commented, "SNAP")).toBe("unlocked");
  });

  test("updateAgent locks the row before reading the row the trail compares", async () => {
    const src = await Bun.file("src/modules/agents/service.ts").text();
    expect(
      lockedBeforeSnapshot(bodyOf(src, "updateAgent"), "select: AGENT_SELECT"),
    ).toBe("locked");
  });

  test("deleteAgent locks the row before reading the name it records", async () => {
    const src = await Bun.file("src/modules/agents/service.ts").text();
    expect(
      lockedBeforeSnapshot(bodyOf(src, "deleteAgent"), "doomedRows[0]"),
    ).toBe("locked");
  });

  test("replaceAgentToolSelections locks the agent before reading the grants it records", async () => {
    const src = await Bun.file("src/modules/agents/service.ts").text();
    expect(
      lockedBeforeSnapshot(
        bodyOf(src, "replaceAgentToolSelections"),
        "readGrantSet(db, agentId)",
      ),
    ).toBe("locked");
  });
});

describe("the two snapshots are canonicalized at ONE instant", () => {
  // The phantom row this prevents is a race — the window is the gap between two synchronous calls —
  // so what is asserted here is the MECHANISM it rests on, deterministically: that the reader really
  // does resolve one stored bag two ways across a deadline, and that giving it a single instant is
  // what makes the two sides agree.
  const bag = {
    observability: {
      logToolValues: true,
      fullDetailUntil: new Date(1_700_000_000_000).toISOString(),
    },
  };
  const open = new Date(1_699_999_999_000);
  const closed = new Date(1_700_000_001_000);

  test("one stored bag resolves two ways across the expiry", () => {
    const a = JSON.stringify(readBehaviorSettings(bag, open).observability);
    const b = JSON.stringify(readBehaviorSettings(bag, closed).observability);
    expect(a).not.toBe(b);
    // Two fields move, not one: the reader nulls the deadline as well as flipping the derived flag.
    expect(readBehaviorSettings(bag, open).observability.fullDetail).toBe(true);
    expect(
      readBehaviorSettings(bag, closed).observability.fullDetailUntil,
    ).toBeNull();
  });

  test("the same instant makes the two sides agree", () => {
    for (const at of [open, closed]) {
      expect(JSON.stringify(readBehaviorSettings(bag, at))).toBe(
        JSON.stringify(readBehaviorSettings(bag, at)),
      );
    }
  });

  test("the clock is read ONCE for the whole comparison", async () => {
    // Structural, and for the same reason the lock ordering below is: the consequence is a race
    // whose window is the gap between two synchronous calls, so a behavioural test would pass on the
    // broken code every time. Measured — replacing the shared instant with a fresh one per side
    // fails no test, which is exactly why this one reads the source instead.
    const src = Bun.file("src/modules/agents/audit-projection.ts");
    const body = bodyOf(await src.text(), "agentUpdateAudit");
    const clockReads = (b: string) =>
      b
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n")
        .split("new Date()").length - 1;
    expect(clockReads(body)).toBe(1);
    // Positive control: the shape this rules out, and a comment that must not count as one.
    expect(clockReads("const a = new Date(); const b = new Date();")).toBe(2);
    expect(clockReads("// new Date() in prose\nconst a = new Date();")).toBe(1);
  });

  test("an unchanged bag yields no audit, whichever side of the expiry it is read on", () => {
    const row = { settings: bag } as Record<string, unknown>;
    expect(agentUpdateAudit(row, row)).toBeNull();
  });
});

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
        "vault_entries",
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

  test("resubmitting the same grant set leaves no row, in any order", async () => {
    // The Tools tab resubmits the whole set on every save, and the order is not the operator's:
    // this path is a deleteMany + createMany, so each save reassigns the ids the read orders by.
    const agent = await seedAgent();
    // One grant per source, so the two entries come from two sources — which is the only way the
    // list can be reordered at all.
    const set = [
      { source: "NATIVE" as const, enabledTools: ["handoff_to_human"] },
      { source: "RAG" as const, enabledTools: ["search_knowledge"] },
    ];
    await replaceAgentToolSelections(ctx(), BigInt(agent.id), set, appDb);
    await clearAudit();

    await replaceAgentToolSelections(ctx(), BigInt(agent.id), set, appDb);
    expect(await rows()).toEqual([]);

    await replaceAgentToolSelections(
      ctx(),
      BigInt(agent.id),
      [...set].reverse(),
      appDb,
    );
    expect(await rows()).toEqual([]);

    // …and a set that genuinely differs still records.
    await replaceAgentToolSelections(
      ctx(),
      BigInt(agent.id),
      [{ source: "NATIVE" as const, enabledTools: ["handoff_to_human"] }],
      appDb,
    );
    expect((await rows()).map((r) => r.action)).toEqual(["agent.tools_set"]);
  });

  test("the delete row names the agent under the lock that deletes it", async () => {
    const agent = await seedAgent({ name: `doomed-${process.pid}` });
    await clearAudit();

    await deleteAgent(ctx(), BigInt(agent.id), appDb);

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.delete"]);
    expect(got[0]?.before).toEqual({
      id: agent.id,
      name: `doomed-${process.pid}`,
    });
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

  test("the third transport leaves the same row, differing only in how it authenticated", async () => {
    // The seam promises one row per change whichever door made it, and `actorType` is what names the
    // door. The console (`user`) and MCP (`mcp`) are exercised above; this is the Bearer key, the
    // one the PR body claimed without measuring.
    //
    // Asserted at the SERVICE and not through the route, and the line is worth drawing: what a
    // Bearer request contributes is a context whose `actorType` is `api_key`, and that resolution —
    // token to principal to context — is `#392`'s and is proven by its own test
    // (`audit-seam.test.ts`, "a Bearer API key is attributed as one"). What is unproven for THIS
    // family is that its rows carry whatever the context says, which is what this measures.
    const viaKey = await seedAgent();
    const viaConsole = await seedAgent();
    await clearAudit();

    for (const [agent, actorType] of [
      [viaConsole, "user"],
      [viaKey, "api_key"],
    ] as const) {
      await updateAgent(
        ctx({ actorType }),
        BigInt(agent.id),
        { systemPrompt: "the same new text" },
        appDb,
      );
    }

    const got = await rows("agent.prompt_set");
    expect(got.length).toBe(2);
    expect(got.map((r) => r.actorType)).toEqual(["user", "api_key"]);
    expect(got[0]?.before).toEqual(got[1]?.before);
    expect(got[0]?.after).toEqual(got[1]?.after);
    expect(got.map((r) => r.actorId)).toEqual([USER, USER]);
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

  test("a stray key in the model config never reaches the row", async () => {
    // `validateModelConfigForWrite` asks the schema whether the value is valid and discards the
    // stripped result, so a config that is valid apart from an extra key is STORED with it. The
    // column is the operator's problem; the audit row is ours, because it is retained and readable
    // by every tenant admin.
    const agent = await seedAgent();
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        modelConfig: {
          provider: "openai",
          model: "gpt-5.4-mini",
          temperature: 0.2,
          apiKey: "sk-must-not-be-recorded",
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.update"]);
    // The column DID take it — this is the leak the projection stops, not one it prevents upstream.
    const stored = await runScopedOn(appDb, ctx(), (db) =>
      db.agent.findUnique({
        where: { id: BigInt(agent.id) },
        select: { modelConfig: true },
      }),
    );
    expect(JSON.stringify(stored?.modelConfig)).toContain("sk-must-not-be");
    expect(JSON.stringify(got[0]?.after)).not.toContain("sk-must-not-be");
    const after = got[0]?.after as Record<string, unknown> | undefined;
    // The readable half AND the fact that something unread moved: one write did both, and a row
    // that stopped at the first would leave half the mutation out of the trail.
    expect(after?.modelConfig).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      temperature: 0.2,
      unreadConfigChanged: true,
    });
  });

  test("a settings edit the readers clamp to the same value leaves no row", async () => {
    // Raw-different, canonically equal: `debounce.windowSeconds` of 1 and of 2 both read as 3
    // (measured). This is NOT the unread-configuration case, and the distinction is the one the
    // residue draws: `windowSeconds` is a field the readers see, so it is not in the residue, and
    // what moved is a value the platform then replaced. Nothing the runtime does changed and nothing
    // is being kept from anyone, so there is nothing to record.
    const agent = await seedAgent({
      settings: { debounce: { enabled: true, windowSeconds: 1 } },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { settings: { debounce: { enabled: true, windowSeconds: 2 } } },
      appDb,
    );

    expect(await rows()).toEqual([]);
  });

  test("a write no reader sees is recorded, and neither its content NOR its key reaches the row", async () => {
    // An import can preserve a forward-compatible block, and an upgrade that adds its reader makes
    // it live: comparing only the resolved view would let a real configuration write leave no trace.
    // The answer is a boolean, and the boolean is the point. An unknown KEY is caller-controlled and
    // can itself be secret material — `assertNoSecrets` scans keys for exactly that reason — so a
    // row that named the block would carry a string nothing here can vouch for.
    const agent = await seedAgent({
      settings: { "sk-key-is-the-secret": { knob: "one" } },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          "sk-key-is-the-secret": { knob: "two", also: "sk-value-secret" },
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.settings_set"]);
    expect(got[0]?.after).toEqual({ unreadConfigChanged: true });
    expect(JSON.stringify([got[0]?.before, got[0]?.after])).not.toContain(
      "sk-",
    );
  });

  test("a block named like a prototype member is not swallowed by the comparison", async () => {
    // The names-based version filtered on `k in resolved`, which walks the prototype: measured,
    // `"constructor" in resolved` is true, so a stored block by that name vanished from the trail.
    // A whole-value comparison has no key iteration and therefore no such corner.
    const agent = await seedAgent({ settings: { constructor: { a: 1 } } });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { settings: { constructor: { a: 2 } } },
      appDb,
    );

    expect((await rows())[0]?.after).toEqual({ unreadConfigChanged: true });
  });

  test("an unread field inside a RECOGNIZED block is not swallowed either", async () => {
    // `debounce.futureOption` sits under a block the readers DO know, so a per-block name check
    // could never have seen it: an older console save can drop it while every resolved debounce
    // value stays put.
    const agent = await seedAgent({
      settings: {
        debounce: { enabled: true, windowSeconds: 30, futureOption: "keep" },
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { settings: { debounce: { enabled: true, windowSeconds: 30 } } },
      appDb,
    );

    expect((await rows())[0]?.after).toEqual({ unreadConfigChanged: true });
  });

  test("a stray model-config key that changes on its own is recorded, without being copied", async () => {
    const agent = await seedAgent({
      modelConfig: {
        provider: "openai",
        model: "gpt-5.4-mini",
        apiKey: "sk-a",
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        modelConfig: {
          provider: "openai",
          model: "gpt-5.4-mini",
          apiKey: "sk-b",
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.update"]);
    const patched = got[0]?.after as Record<string, unknown> | undefined;
    expect(patched?.modelConfig).toEqual({ unreadConfigChanged: true });
    expect(JSON.stringify([got[0]?.before, got[0]?.after])).not.toContain(
      "sk-",
    );
  });

  test("resubmitting the same allowlist shuffled is the same grant", async () => {
    // Every consumer reads `enabledTools` by membership: `filterAllowed` builds a Set, prepare.ts
    // asks `.includes`/`.some`, the playground builds a Set. Order is nobody's input.
    const agent = await seedAgent();
    await replaceAgentToolSelections(
      ctx(),
      BigInt(agent.id),
      [
        {
          source: "NATIVE" as const,
          enabledTools: ["handoff_to_human", "private_note"],
        },
      ],
      appDb,
    );
    await clearAudit();

    await replaceAgentToolSelections(
      ctx(),
      BigInt(agent.id),
      [
        {
          source: "NATIVE" as const,
          enabledTools: ["private_note", "handoff_to_human"],
        },
      ],
      appDb,
    );

    expect(await rows()).toEqual([]);

    // …and dropping a duplicate is not a change either: `normalizeGrants` permits one and a Set
    // cannot hold it, so the runtime's capability set is the same.
    await replaceAgentToolSelections(
      ctx(),
      BigInt(agent.id),
      [
        {
          source: "NATIVE" as const,
          enabledTools: ["private_note", "handoff_to_human", "private_note"],
        },
      ],
      appDb,
    );
    expect(await rows()).toEqual([]);
  });

  test("a credential pasted into a base URL is recorded as movement, never as the credential", async () => {
    // `https://user:pw@host` passes `z.string().url()` and the editor's validator alike, and the row
    // is append-only: a password pasted there once would outlive the correction. It is left out of
    // the canonical form rather than redacted in place, so the residue answers for it.
    const agent = await seedAgent({
      modelConfig: {
        provider: "openai-compatible",
        model: "m",
        baseURL: "https://user:hunter2@llm.example.com/v1",
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        modelConfig: {
          provider: "openai-compatible",
          model: "m",
          baseURL: "https://user:rotated@llm.example.com/v1",
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.update"]);
    const cfg = (got[0]?.after as Record<string, unknown> | undefined)
      ?.modelConfig as Record<string, unknown>;
    expect(cfg.unreadConfigChanged).toBe(true);
    expect(cfg.baseURL).toBeUndefined();
    expect(JSON.stringify([got[0]?.before, got[0]?.after])).not.toContain(
      "hunter2",
    );
    expect(JSON.stringify([got[0]?.before, got[0]?.after])).not.toContain(
      "rotated",
    );
  });

  test("a credential in a BEHAVIOR block's URL is covered too, not just the model's", async () => {
    // Eight of the nine URL-shaped fields in an audited projection live in settings blocks
    // (`stt`, `tts` twice, `vision`, `contactAuth`, `guardrails`, `memory.compaction`,
    // `modelFallback`), so a guard written on `modelConfig.baseURL` alone was a guard on one of
    // nine. The rule is on the VALUE and applies at every depth.
    const agent = await seedAgent({
      settings: {
        stt: { enabled: true, baseURL: "https://u:one@stt.example.com/v1" },
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          stt: { enabled: true, baseURL: "https://u:two@stt.example.com/v1" },
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.settings_set"]);
    const marked = got[0]?.after as Record<string, unknown> | undefined;
    expect(marked?.unreadConfigChanged).toBe(true);
    const dump = JSON.stringify([got[0]?.before, got[0]?.after]);
    expect(dump).not.toContain("one");
    expect(dump).not.toContain("two");
  });

  test("a credential in the QUERY or the FRAGMENT counts as one", async () => {
    for (const [a, b] of [
      [
        "https://h.example.com/v1?api_key=aaa",
        "https://h.example.com/v1?api_key=bbb",
      ],
      ["https://h.example.com/v1#tok=aaa", "https://h.example.com/v1#tok=bbb"],
    ]) {
      const agent = await seedAgent({
        modelConfig: { provider: "openai-compatible", model: "m", baseURL: a },
      });
      await clearAudit();

      await updateAgent(
        ctx(),
        BigInt(agent.id),
        {
          modelConfig: {
            provider: "openai-compatible",
            model: "m",
            baseURL: b,
          },
        },
        appDb,
      );

      const got = await rows();
      expect(got.length).toBe(1);
      const dump = JSON.stringify([got[0]?.before, got[0]?.after]);
      expect(dump).not.toContain("aaa");
      expect(dump).not.toContain("bbb");
    }
  });

  test("an unread field inside a normalized LIST is not invisible", async () => {
    // `followUp.steps` is a list the readers normalize element by element, so an unread field inside
    // one element is absent from the canonical element. A residue that stopped at the array made
    // every such write leave no row at all.
    const step = { delayUnit: "minutes", delayValue: 60, instructions: "hi" };
    const agent = await seedAgent({
      settings: {
        followUp: { enabled: true, steps: [{ ...step, futureOption: "keep" }] },
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { settings: { followUp: { enabled: true, steps: [step] } } },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.settings_set"]);
    const marked = got[0]?.after as Record<string, unknown> | undefined;
    expect(marked?.unreadConfigChanged).toBe(true);
  });

  test("whitespace around the endpoint does not smuggle the credential past the rule", async () => {
    // `z.string().url()` validates through `new URL`, which ignores surrounding whitespace, and
    // `validateModelConfigForWrite` discards the parsed result — so the space reaches the column and
    // an anchored test on the raw string would answer "not an endpoint".
    const agent = await seedAgent({
      modelConfig: {
        provider: "openai-compatible",
        model: "m",
        baseURL: " https://u:hunter2@h.example.com/v1",
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        modelConfig: {
          provider: "openai-compatible",
          model: "m",
          baseURL: " https://u:rotated@h.example.com/v1",
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.length).toBe(1);
    const dump = JSON.stringify([got[0]?.before, got[0]?.after]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("rotated");
  });

  test("a stored block named __proto__ is not swallowed by the residue map", async () => {
    // `out[k] = v` is not an assignment for that key: it invokes the legacy prototype setter and
    // creates no own property, so both residues would serialize empty and the write would vanish.
    //
    // Seeded through SQL because the app cannot produce this state — measured: Prisma drops an own
    // `__proto__` during serialization, so `{"__proto__":{…},"ok":1}` reaches the column as
    // `{"ok":1}`. A row carrying one arrives from a migration or a direct write, and the projection
    // reads the column rather than the payload. `ok` is on both sides so the ONLY difference between
    // the two residues is the key under test.
    const agent = await seedAgent({ settings: { ok: 1 } });
    await su?.$executeRawUnsafe(
      `UPDATE agents SET settings = '{"__proto__":{"knob":"one"},"ok":1}'::jsonb WHERE id = ${agent.id}`,
    );
    await clearAudit();

    await updateAgent(ctx(), BigInt(agent.id), { settings: { ok: 1 } }, appDb);

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.settings_set"]);
    const marked = got[0]?.after as Record<string, unknown> | undefined;
    expect(marked?.unreadConfigChanged).toBe(true);
  });

  test("a credential inside a LIST is dropped too, not just one under a key", async () => {
    // `guardrails.competitors` is a list of bare strings. Recursing into an element without asking
    // returns it untouched, so the rule has to run on elements as well as on object values.
    const agent = await seedAgent({
      settings: {
        guardrails: {
          enabled: true,
          competitors: ["https://u:hunter2@rival.example.com/x", "acme"],
        },
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          guardrails: {
            enabled: true,
            competitors: ["https://u:rotated@rival.example.com/x", "acme"],
          },
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.length).toBe(1);
    const dump = JSON.stringify([got[0]?.before, got[0]?.after]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("rotated");
  });

  test("a value the reader DISCARDS is unread, not accounted for", async () => {
    // `readContactAuthUrl` answers `null` for a URL carrying userinfo, on both sides of a change, so
    // the canonical forms agree. The key is present in the canonical form all the same, and a
    // residue that looked only at presence would call the value accounted for while nothing reads it.
    const agent = await seedAgent({
      settings: {
        contactAuth: { enabled: true, url: "https://u:one@auth.example.com/x" },
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          contactAuth: {
            enabled: true,
            url: "https://u:two@auth.example.com/x",
          },
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.settings_set"]);
    const marked = got[0]?.after as Record<string, unknown> | undefined;
    expect(marked?.unreadConfigChanged).toBe(true);
    const dump = JSON.stringify([got[0]?.before, got[0]?.after]);
    expect(dump).not.toContain("one@");
    expect(dump).not.toContain("two@");
  });

  test("an audited scalar that IS the endpoint is covered at the root", async () => {
    // A walk that inspects object values and array elements never asks about the value it was
    // handed, and an audited scalar can be the endpoint itself.
    const agent = await seedAgent({
      systemPrompt: "https://u:hunter2@prompts.example.com/p",
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { systemPrompt: "https://u:rotated@prompts.example.com/p" },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.prompt_set"]);
    // Under the field, not at the top: only the settings branch flattens its projection.
    const marked = got[0]?.after as Record<string, unknown> | undefined;
    expect(marked?.systemPrompt).toEqual({ unreadConfigChanged: true });
    const dump = JSON.stringify([got[0]?.before, got[0]?.after]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("rotated");
  });

  test("correcting an accidentally pasted credential is not refused by the trail", async () => {
    // The audit shares the mutation's transaction, so a throw while building the row rolls the write
    // back — and the write it rolled back was exactly the one that REMOVES the credential. Measured
    // before the fix: `TypeError: undefined is not an object`.
    const agent = await seedAgent({
      systemPrompt: "https://u:hunter2@prompts.example.com/p",
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { systemPrompt: "plain operator text" },
      appDb,
    );

    const still = await runScopedOn(appDb, ctx(), (db) =>
      db.agent.findUnique({
        where: { id: BigInt(agent.id) },
        select: { systemPrompt: true },
      }),
    );
    expect(still?.systemPrompt).toBe("plain operator text");

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.prompt_set"]);
    const after = got[0]?.after as Record<string, unknown> | undefined;
    expect(after?.systemPrompt).toEqual({
      value: "plain operator text",
      unreadConfigChanged: true,
    });
    expect(JSON.stringify([got[0]?.before, got[0]?.after])).not.toContain(
      "hunter2",
    );
  });

  test("the lifecycle rows sanitize a name the same way the update path does", async () => {
    // `createAgent`, `cloneAgent`, `importAgent` and `deleteAgent` build their own projections, and
    // `auditMutation` bounds sizes without knowing an endpoint can carry a credential. A rule the
    // update path enforces and the other four do not is a rule on one row in five.
    await clearAudit();
    const url = "https://u:hunter2@named.example.com/x";
    const created = await createAgent(ctx(), { name: url }, appDb);
    const clone = await cloneAgent(ctx(), BigInt(created.id), url, appDb);
    await deleteAgent(ctx(), BigInt(clone.id), appDb);

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual([
      "agent.create",
      "agent.clone",
      "agent.delete",
    ]);
    for (const r of got) {
      expect(JSON.stringify([r.before, r.after])).not.toContain("hunter2");
    }
    // The rest of each projection survives — only the unvouchable field goes.
    const createdRow = got[0]?.after as Record<string, unknown> | undefined;
    const deletedRow = got[2]?.before as Record<string, unknown> | undefined;
    expect(createdRow?.id).toBe(created.id);
    expect(deletedRow?.id).toBe(clone.id);
  });

  test("userinfo is asked of any scheme, and prose is left alone", async () => {
    // `z.string().url()` accepts `ftp://user:pw@host`, so bounding the WHOLE rule to `http(s)` let
    // that one through. Widening the userinfo half costs nothing: prose parses with an empty
    // username (`"Pergunta: você quer?"` has protocol `pergunta:`), which is why the query and
    // fragment half stays bounded to what is unambiguously an endpoint.
    const agent = await seedAgent({
      settings: {
        stt: { enabled: true, baseURL: "ftp://u:hunter2@files.example.com/x" },
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          stt: {
            enabled: true,
            baseURL: "ftp://u:rotated@files.example.com/x",
          },
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.length).toBe(1);
    const dump = JSON.stringify([got[0]?.before, got[0]?.after]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("rotated");
  });

  test("a prompt that merely reads like a URL is recorded in full", async () => {
    // The other side of that widening: an operator's prose parses as a URL and must survive intact,
    // or the trail starts losing the field it exists to record.
    const prose =
      "Pergunta: você quer? Responda mailto:contato@clinica.example";
    const agent = await seedAgent({ systemPrompt: "antes" });
    await clearAudit();

    await updateAgent(ctx(), BigInt(agent.id), { systemPrompt: prose }, appDb);

    const after = (await rows())[0]?.after as
      | Record<string, unknown>
      | undefined;
    expect(after?.systemPrompt).toBe(prose);
  });

  test("the PARSED protocol decides, not the spelling in the text", async () => {
    // `new URL` normalizes `https:llm.example/v1?api_key=…` to protocol `https:` and the model-config
    // validator accepts it, so a test anchored on `//` in the raw text called it a non-endpoint.
    const agent = await seedAgent({
      modelConfig: {
        provider: "openai-compatible",
        model: "m",
        baseURL: "https:llm.example.com/v1?api_key=hunter2",
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        modelConfig: {
          provider: "openai-compatible",
          model: "m",
          baseURL: "https:/llm.example.com/v1?api_key=rotated",
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.length).toBe(1);
    const dump = JSON.stringify([got[0]?.before, got[0]?.after]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("rotated");
  });

  test("a credentialRef that is not a vault reference is not vouched for", async () => {
    // `docs/mcp.md` says every one is a `vault:<id>` and never the secret, but the schema types it
    // as a non-empty string and only CHANGED refs are validated — so a legacy agent can resubmit a
    // raw key alongside an unrelated edit and have it copied into a permanent row.
    // Seeded through SQL: the write boundary refuses a raw ref outright (`requireVaultRef`), which
    // is precisely why the only agents carrying one are legacy. The edit below changes the MODEL and
    // resubmits the ref untouched, and `collectCredentialRefWrites` validates only refs a write
    // CHANGES — so the raw one goes through and reaches the projection.
    const agent = await seedAgent({ settings: { stt: { enabled: true } } });
    await su?.$executeRawUnsafe(
      `UPDATE agents SET settings = '{"stt":{"enabled":true,"credentialRef":"sk-legacy-raw-key"}}'::jsonb WHERE id = ${agent.id}`,
    );
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          stt: {
            enabled: true,
            credentialRef: "sk-legacy-raw-key",
            model: "whisper-1",
          },
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.length).toBe(1);
    expect(JSON.stringify([got[0]?.before, got[0]?.after])).not.toContain(
      "sk-legacy-raw-key",
    );
  });

  test("a proper vault reference is recorded, because that is what a reference is for", async () => {
    const mk = async (name: string) =>
      (
        await su?.vaultEntry.create({
          data: { tenantId, name, secret: "placeholder", kind: "openai" },
          select: { id: true },
        })
      )?.id;
    const one = await mk(`k1-${process.pid}`);
    const two = await mk(`k2-${process.pid}`);
    const agent = await seedAgent({
      settings: { stt: { enabled: true, credentialRef: `vault:${one}` } },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { settings: { stt: { enabled: true, credentialRef: `vault:${two}` } } },
      appDb,
    );

    const after = (await rows())[0]?.after as Record<string, unknown>;
    expect((after.stt as Record<string, unknown>).credentialRef).toBe(
      `vault:${two}`,
    );
  });

  test("a model config that omits `model` and one that sends it empty are the same", async () => {
    // The schema defaults `model` to `""`, so both resolve identically at runtime — measured. A
    // picker that preserved missing-versus-empty filed an `agent.update` for a save that changed
    // nothing, in a trail whose whole rule is that it records changes.
    const agent = await seedAgent({
      modelConfig: { provider: "openai-compatible" },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { modelConfig: { provider: "openai-compatible", model: "" } },
      appDb,
    );

    expect(await rows()).toEqual([]);
  });

  test("a legacy config the schema refuses still projects, by the allowlist", async () => {
    // The parse is the normalizer and the pick is the fallback; without the second, a config that no
    // longer validates would project nothing at all.
    const agent = await seedAgent();
    await su?.$executeRawUnsafe(
      `UPDATE agents SET model_config = '{"provider":"openai","apiKey":"sk-legacy"}'::jsonb WHERE id = ${agent.id}`,
    );
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { modelConfig: { provider: "openai", model: "gpt-5.4-mini" } },
      appDb,
    );

    const after = (await rows())[0]?.after as
      | Record<string, unknown>
      | undefined;
    const before = (await rows())[0]?.before as
      | Record<string, unknown>
      | undefined;
    const cfgBefore = before?.modelConfig as
      | Record<string, unknown>
      | undefined;
    const cfgAfter = after?.modelConfig as Record<string, unknown> | undefined;
    expect(cfgBefore?.provider).toBe("openai");
    expect(cfgAfter?.model).toBe("gpt-5.4-mini");
    expect(JSON.stringify([before, after])).not.toContain("sk-legacy");
  });

  test("a credential pasted INSIDE a prompt is not kept verbatim", async () => {
    // `new URL` is handed the whole string, so a sentence that merely contains the URL fails to
    // parse and was kept as it was — and a prompt is exactly where one gets pasted inline.
    const agent = await seedAgent({
      systemPrompt:
        "Consulte a agenda em https://u:hunter2@api.example.com/v1 e responda.",
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        systemPrompt:
          "Consulte a agenda em https://u:rotated@api.example.com/v1 e responda.",
      },
      appDb,
    );

    const got = await rows();
    expect(got.length).toBe(1);
    const dump = JSON.stringify([got[0]?.before, got[0]?.after]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("rotated");
  });

  test("embedded userinfo is caught under any scheme, and an ordinary link is not", async () => {
    // Measured both ways: `user:pass@` does not fire on a prompt that merely links to
    // `…/faq?secao=cancelamento`, and it does fire on an `ftp://` credential. A rule that also
    // matched an embedded QUERY could not separate those two, and it drops the WHOLE field.
    const agent = await seedAgent({
      systemPrompt:
        "Baixe em ftp://u:hunter2@files.example.com/x quando pedirem.",
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        systemPrompt:
          "Baixe em ftp://u:rotated@files.example.com/x quando pedirem.",
      },
      appDb,
    );
    const dump = JSON.stringify([
      (await rows())[0]?.before,
      (await rows())[0]?.after,
    ]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("rotated");

    // The other side: an ordinary link with a query survives, text and all.
    const link =
      "Veja a política em https://clinica.example.com/faq?secao=cancelamento.";
    const other = await seedAgent({ systemPrompt: "antes" });
    await clearAudit();
    await updateAgent(ctx(), BigInt(other.id), { systemPrompt: link }, appDb);
    const after = (await rows())[0]?.after as
      | Record<string, unknown>
      | undefined;
    expect(after?.systemPrompt).toBe(link);
  });

  test("userinfo with no password is still userinfo, and an @ in a path is not", async () => {
    const agent = await seedAgent({
      systemPrompt:
        "Use https://sk-live-hunter2@api.example.com/v1 se precisar.",
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        systemPrompt:
          "Use https://sk-live-rotated@api.example.com/v1 se precisar.",
      },
      appDb,
    );
    const dump = JSON.stringify([
      (await rows())[0]?.before,
      (await rows())[0]?.after,
    ]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("rotated");

    // Excluding `/` before the `@` is what keeps a path out of the rule.
    const path = "Veja https://github.com/orgs/@time/repos para o time.";
    const other = await seedAgent({ systemPrompt: "antes" });
    await clearAudit();
    await updateAgent(ctx(), BigInt(other.id), { systemPrompt: path }, appDb);
    const after = (await rows())[0]?.after as
      | Record<string, unknown>
      | undefined;
    expect(after?.systemPrompt).toBe(path);
  });

  test("a numeric ref outside the id range is not a reference either", async () => {
    // `vault:99999999999999999999` is all digits and unresolvable, so a spelling check called it
    // safe. The repo's own bounded parser is what decides.
    const agent = await seedAgent({ settings: { stt: { enabled: true } } });
    await su?.$executeRawUnsafe(
      `UPDATE agents SET settings = '{"stt":{"enabled":true,"credentialRef":"vault:99999999999999999999"}}'::jsonb WHERE id = ${agent.id}`,
    );
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          stt: {
            enabled: true,
            credentialRef: "vault:99999999999999999999",
            model: "whisper-1",
          },
        },
      },
      appDb,
    );

    expect(
      JSON.stringify([(await rows())[0]?.before, (await rows())[0]?.after]),
    ).not.toContain("99999999999999999999");
  });

  test("a vault PREFIX is not a vault reference", async () => {
    // `vault:sk-live-…` starts with the prefix and is a secret, and the unchanged-ref path is the
    // one that never validates.
    const agent = await seedAgent({ settings: { stt: { enabled: true } } });
    await su?.$executeRawUnsafe(
      `UPDATE agents SET settings = '{"stt":{"enabled":true,"credentialRef":"vault:sk-live-secret"}}'::jsonb WHERE id = ${agent.id}`,
    );
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          stt: {
            enabled: true,
            credentialRef: "vault:sk-live-secret",
            model: "whisper-1",
          },
        },
      },
      appDb,
    );

    const got = await rows();
    expect(got.length).toBe(1);
    expect(JSON.stringify([got[0]?.before, got[0]?.after])).not.toContain(
      "sk-live-secret",
    );
  });

  test("a tool precondition named __proto__ stays in the canonical view", async () => {
    // `readToolPreconditions` builds its map with `Object.create(null)` and keys it by TOOL NAME, so
    // that key arrives as an OWN property of the reader's output — measured. A plain assignment in
    // the projection walk dropped it, taking an ACTIVE runtime precondition out of the canonical
    // view: its removal then read as merely "unread configuration" instead of as the change it is.
    //
    // Seeded through SQL because Prisma drops an own `__proto__` on the way to the column, so the
    // app cannot write this state — a row carrying one comes from a migration or a direct write.
    const agent = await seedAgent();
    await su?.$executeRawUnsafe(
      `UPDATE agents SET settings = '{"toolPreconditions":{"__proto__":{"kind":"attribute","key":"cpf","scope":"conversation"}}}'::jsonb WHERE id = ${agent.id}`,
    );
    await clearAudit();

    // The edit REMOVES it, which is deliverable through the app.
    await updateAgent(
      ctx(),
      BigInt(agent.id),
      { settings: { toolPreconditions: {} } },
      appDb,
    );

    const got = await rows();
    expect(got.map((r) => r.action)).toEqual(["agent.settings_set"]);
    const before = got[0]?.before as Record<string, unknown> | undefined;
    const after = got[0]?.after as Record<string, unknown> | undefined;
    // What is observable is the CLASSIFICATION, not the key in the row: Prisma drops an own
    // `__proto__` on the way to the column, so the recorded projection cannot show it either way.
    // Carried in the canonical view, its removal is a change to `toolPreconditions` with a before
    // and an after; dropped from it, the two views compare equal and the write degrades to a bare
    // `unreadConfigChanged` — the trail saying "something you cannot see moved" about a precondition
    // the runtime was enforcing.
    expect(Object.keys(before ?? {})).toEqual(["toolPreconditions"]);
    expect(after?.unreadConfigChanged).toBeUndefined();
  });

  test("a base URL with no credential in it is recorded as itself", async () => {
    const agent = await seedAgent({
      modelConfig: {
        provider: "openai-compatible",
        model: "m",
        baseURL: "https://llm.example.com/v1",
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        modelConfig: {
          provider: "openai-compatible",
          model: "m",
          baseURL: "https://other.example.com/v1",
        },
      },
      appDb,
    );

    const cfg = (
      (await rows())[0]?.after as Record<string, unknown> | undefined
    )?.modelConfig as Record<string, unknown>;
    expect(cfg.baseURL).toBe("https://other.example.com/v1");
    expect(cfg.unreadConfigChanged).toBeUndefined();
  });

  test("a settings write that moves a read value AND an unread one records both", async () => {
    const agent = await seedAgent({
      settings: {
        debounce: { enabled: true, windowSeconds: 30, futureOption: "keep" },
      },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          debounce: { enabled: true, windowSeconds: 45, futureOption: "gone" },
        },
      },
      appDb,
    );

    const after = (await rows())[0]?.after as Record<string, unknown>;
    expect((after.debounce as Record<string, unknown>).windowSeconds).toBe(45);
    expect(after.unreadConfigChanged).toBe(true);
    expect(JSON.stringify(after)).not.toContain("gone");
  });

  test("a deadline the operator set reaches the row as the deadline, not as an empty object", async () => {
    // `readBehaviorSettings` hands back `observability.fullDetailUntil` as a `Date`, and the seam's
    // `truncForAudit` walks objects by their enumerable entries — a Date has none, so it lands as
    // `{}` and the row says the window moved without saying to when.
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const agent = await seedAgent({
      settings: { observability: { logToolValues: false } },
    });
    await clearAudit();

    await updateAgent(
      ctx(),
      BigInt(agent.id),
      {
        settings: {
          observability: { logToolValues: false, fullDetailUntil: until },
        },
      },
      appDb,
    );

    const after = (await rows())[0]?.after as Record<string, unknown>;
    const obs = after?.observability as Record<string, unknown>;
    expect(obs.fullDetailUntil).toBe(until);
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
