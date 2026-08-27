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

describe.skipIf(!dbUp)("the four blocks reach the agent through MCP", () => {
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

  test("all four apply in one call, and land in the stored bag", async () => {
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
    expect(stored.toolGuidance?.handoff_to_human).toBe("only after the quote");
    expect(stored.toolPreconditions?.handoff_to_human).toEqual({
      kind: "attribute",
      scope: "conversation",
      key: "article_url",
    });
  });

  // THE THIRD SCOPE ITEM OF #402, which asks to VERIFY rather than to build: `guardrails.credentialRef`
  // is already in SETTINGS_CREDENTIAL_PATHS, so the MCP's name ↔ `vault:<id>` translation should need
  // no change for the block this PR publishes. Reading the constant proves the path is listed; it does
  // not prove the translation runs for this block, which is what the issue asked. Both directions,
  // through the same functions the transport calls.
  //
  // The failure it rules out is specific and silent: the write stores the NAME verbatim, and the
  // guardrails model then resolves a credential that does not exist — at turn time, on the reply path.
  test("guardrails.credentialRef travels as a NAME and is stored as a ref", async () => {
    const keyId = (
      await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: `gr-key-${process.pid}`,
          secret: "placeholder",
          kind: "openai",
        },
        select: { id: true },
      })
    ).id;
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        guardrails: { credentialRef: `gr-key-${process.pid}` },
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
    expect(stored.guardrails?.credentialRef).toBe(`vault:${keyId}`);

    // And back out as the NAME, which is the half the issue's own history is about: the read handing
    // back an id where it promises a name is what the credential-paths guard was written for.
    const got = await agentSettingsGet(
      principal(),
      { agent_id: String(agentId) } as never,
      { base: appDb },
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const settings = (
      got.data as { settings: Record<string, Record<string, unknown>> }
    ).settings;
    expect(settings.guardrails?.credentialRef).toBe(`gr-key-${process.pid}`);
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

  // ROUND 1 OF PR #404. A blank key passes the schema (`z.string()` accepts " ") and
  // parseToolPrecondition then returns null, so before the fix the merge stored the reader's
  // filtered output over a working rule: the API answered ok and the guard was gone. Refused now on
  // the PATCH, before the merge, like the three sibling assertions beside it.
  test("a precondition that cannot parse is refused, and the working rule survives", async () => {
    const before = (
      await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings as Record<string, Record<string, unknown>>;
    expect(before.toolPreconditions?.handoff_to_human).toBeDefined();

    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        toolPreconditions: {
          handoff_to_human: {
            kind: "attribute",
            scope: "conversation",
            key: "   ",
          },
        },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(false);

    const after = (
      await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings as Record<string, Record<string, unknown>>;
    expect(after.toolPreconditions?.handoff_to_human).toEqual(
      before.toolPreconditions?.handoff_to_human as never,
    );
  });

  // ROUND 2: the tombstone e2e below only ever covered toolGuidance, whose value was already
  // nullable — so it passed while toolPreconditions refused the same shape at the schema boundary.
  // This is the half that was missing, end to end and against the stored bag.
  test("a precondition is REMOVED by its tombstone, and its siblings stay", async () => {
    await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        toolPreconditions: {
          private_note: {
            kind: "attribute",
            scope: "contact",
            key: "plan",
          },
        },
      } as never,
      { base: appDb },
    );
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        toolPreconditions: { handoff_to_human: null },
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
    expect(stored.toolPreconditions?.handoff_to_human).toBeUndefined();
    // Removed, not blanked: a null left in the bag would read as a configured entry to anything that
    // counts keys rather than parsing them.
    expect(
      Object.hasOwn(stored.toolPreconditions ?? {}, "handoff_to_human"),
    ).toBe(false);
    expect(stored.toolPreconditions?.private_note).toBeDefined();
  });

  // The mutation battery found the boundary check on the MCP path surviving its removal: with the
  // merge no longer destructive, a bad entry now reaches updateAgent, which refuses it. What that
  // does NOT cover is the DRY RUN — it never calls updateAgent, so without the check the preview
  // would happily describe a write the apply refuses. A preview that promises what the apply denies
  // is worse than no preview.
  test("a dry run REFUSES an unparseable precondition instead of previewing it", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        toolPreconditions: {
          handoff_to_human: {
            kind: "attribute",
            scope: "conversation",
            key: "   ",
          },
        },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(false);
  });

  // ROUND 5, and the reason the read and the write had to move together: a caller reads the config,
  // changes one thing, writes it back. If the read returns a field the write refuses, that caller
  // gets a 400 having changed nothing — a broken round trip is worse than the silent no-op it
  // replaced. This is the whole loop, against a real database.
  test("what agent_settings_get returns can be written straight back", async () => {
    const got = await agentSettingsGet(
      principal(),
      { agent_id: String(agentId) },
      { base: appDb },
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const settings = (got.data as { settings: Record<string, unknown> })
      .settings;

    const back = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        guardrails: settings.guardrails,
      } as never,
      { base: appDb },
    );
    expect(back.ok).toBe(true);
  });

  test("and the read does not carry the output-only fields under input", async () => {
    const got = await agentSettingsGet(
      principal(),
      { agent_id: String(agentId) },
      { base: appDb },
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const g = (
      got.data as {
        settings: {
          guardrails: {
            input: { checks: Record<string, unknown> } & Record<
              string,
              unknown
            >;
            output: { checks: Record<string, unknown> } & Record<
              string,
              unknown
            >;
          };
        };
      }
    ).settings.guardrails;
    expect(Object.keys(g.input.checks)).not.toContain("promptAdherence");
    expect(Object.keys(g.input.checks)).not.toContain("answerRelevance");
    expect(Object.keys(g.input)).not.toContain("generationPrompt");
    // Output keeps all of them: the asymmetry is the point, not a trim.
    expect(Object.keys(g.output.checks)).toContain("promptAdherence");
    expect(Object.keys(g.output)).toContain("generationPrompt");
  });

  // ROUND 7. Round 6 forbade TEXT on handoff_to_human/kanban_move_card, reading prepare.ts as if the
  // grouped note always won. It wins only when it is NON-EMPTY — so the flat value is live while the
  // grouped one is blank, and forbidding it broke the get→set round trip for any agent that had one.
  test("a legacy guidance on a shadowed name survives a read-modify-write", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          ...((
            await suDb.agent.findUniqueOrThrow({
              where: { id: agentId },
              select: { settings: true },
            })
          ).settings as Record<string, unknown>),
          toolGuidance: { handoff_to_human: "legacy note" },
        },
      },
    });

    const got = await agentSettingsGet(
      principal(),
      { agent_id: String(agentId) },
      { base: appDb },
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const settings = (got.data as { settings: Record<string, unknown> })
      .settings;
    expect(
      (settings.toolGuidance as Record<string, unknown>).handoff_to_human,
    ).toBe("legacy note");

    // Echoed straight back, the way a client making an unrelated edit would.
    const back = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        toolGuidance: settings.toolGuidance,
      } as never,
      { base: appDb },
    );
    expect(back.ok).toBe(true);
  });

  // ROUND 8. The read was projected in round 5 and the DIFF was not — the same question in a third
  // place. A dry run exists to be reused, so a preview whose `after` carries fields the write refuses
  // hands the caller a document the apply rejects.
  test("the dry run's own preview can be written straight back", async () => {
    const preview = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        // A value that certainly differs from what is stored, so the diff carries the block: the
        // preview only reports keys that CHANGED.
        guardrails: { output: { templateMessage: `r8-${process.pid}` } },
      } as never,
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const diff = (
      preview.data as {
        diff?: { guardrails?: { after?: Record<string, unknown> } };
      }
    ).diff;
    const after = diff?.guardrails?.after;
    expect(after).toBeDefined();
    // The preview must carry the WRITABLE shape. Asserted with the probe PROVEN to have arrived
    // first: `input?.checks ?? {}` is satisfied by `input` being undefined, and the first version of
    // this check passed against a mutation that removed the projection entirely, for exactly that
    // reason.
    const input = (after as { input?: { checks?: Record<string, unknown> } })
      ?.input;
    expect(input).toBeDefined();
    const checks = Object.keys(input?.checks ?? {});
    expect(checks).toContain("toxicity");
    expect(checks).not.toContain("promptAdherence");
    expect(checks).not.toContain("answerRelevance");
    expect(Object.keys(input ?? {})).not.toContain("generationPrompt");

    const applied = await agentSettingsSet(
      principal(),
      { agent_id: String(agentId), dry_run: false, guardrails: after } as never,
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
  });

  // The apply has its own two projections — the diff's `before` and the applied `after` — and the
  // battery found both uncovered after the preview one was fixed. All three emit the settings shape
  // to a caller, so all three have to emit the WRITABLE one; a client reverting from `before` or
  // re-sending `after` hits the same refusal the read was fixed for.
  test("the apply's before and after are writable too", async () => {
    const applied = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        guardrails: { output: { templateMessage: `r8b-${process.pid}` } },
      } as never,
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const diff = (
      applied.data as {
        diff?: {
          guardrails?: {
            before?: { input?: { checks?: Record<string, unknown> } };
            after?: { input?: { checks?: Record<string, unknown> } };
          };
        };
      }
    ).diff;
    for (const side of ["before", "after"] as const) {
      const input = diff?.guardrails?.[side]?.input;
      expect(input).toBeDefined();
      const checks = Object.keys(input?.checks ?? {});
      expect(checks).toContain("toxicity");
      expect(checks).not.toContain("promptAdherence");
      expect(Object.keys(input ?? {})).not.toContain("generationPrompt");
    }
  });

  // ROUND 10, and it is a regression round 9 introduced: refusing an empty tool map to catch a
  // transport-lost key also refused the DOCUMENTED round trip, because a default agent returns both
  // maps empty from agent_settings_get. Echoing the config back for an unrelated edit is the most
  // ordinary thing a client does.
  test("a default agent's own config can be echoed back, empty maps and all", async () => {
    const fresh = await suDb.agent.create({
      data: { tenantId, name: "Fresh", systemPrompt: "p" },
    });
    try {
      const got = await agentSettingsGet(
        principal(),
        { agent_id: String(fresh.id) },
        { base: appDb },
      );
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      const settings = (got.data as { settings: Record<string, unknown> })
        .settings;
      // The precondition for this test: the maps really are empty on a default agent.
      expect(settings.toolGuidance).toEqual({});
      expect(settings.toolPreconditions).toEqual({});

      const back = await agentSettingsSet(
        principal(),
        {
          agent_id: String(fresh.id),
          dry_run: false,
          ...settings,
        } as never,
        { base: appDb },
      );
      expect(back.ok).toBe(true);
    } finally {
      await suDb.agent.delete({ where: { id: fresh.id } }).catch(() => {});
    }
  });

  test("null clears one rule and leaves the others", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        toolGuidance: { private_note: "keep me" },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(true);

    const cleared = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        toolGuidance: { handoff_to_human: null },
      } as never,
      { base: appDb },
    );
    expect(cleared.ok).toBe(true);

    const stored = (
      await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings as Record<string, Record<string, unknown>>;
    expect(stored.toolGuidance?.handoff_to_human).toBeUndefined();
    expect(stored.toolGuidance?.private_note).toBe("keep me");
  });
});
