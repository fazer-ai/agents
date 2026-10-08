import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  observationToForm,
  observationToStored,
} from "@/client/pages/agents/observationFormState";
import { assertAgentCreatable } from "@/modules/agents/service";
import { readDecisionsConfig } from "@/modules/decisions/config";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentSettingsGet, agentSettingsSet } from "@/modules/mcp/write";
import { readMonitoringConfig } from "@/modules/observe/settings";

// The `decisions` block at the write boundary: REST and MCP refuse a block the tick
// could not run, naming the field; a valid one round-trips; the credential travels by name on MCP and
// is stored as a ref; and the readers every rewrite of `monitoring` goes through (the MCP merge, the
// console's Behavior save) carry the engine and the block instead of deleting them.

const QUESTIONS = [
  { name: "pede_reembolso", type: "yes_no", instructions: "Pede o dinheiro?" },
  {
    name: "assunto",
    type: "choice",
    instructions: "Assunto",
    options: [
      { value: "reembolso", description: "estorno" },
      { value: "outro", description: "outro" },
    ],
  },
];
const RULES = [
  {
    when: [{ question: "pede_reembolso", minProbability: 0.7 }],
    action: { tool: "set_labels", args: { add: ["reembolso"] } },
  },
];

function refusal(monitoring: Record<string, unknown>) {
  try {
    assertAgentCreatable({ name: "x", settings: { monitoring } });
  } catch (e) {
    return e as { field?: string; statusCode?: number; message: string };
  }
  return null;
}

describe("the decisions block at the write boundary", () => {
  const valid = {
    engine: "decisions",
    decisions: {
      provider: "typesafe",
      credentialRef: "vault:1",
      questions: QUESTIONS,
      rules: RULES,
      apply: "shadow",
    },
  };

  test("a valid block is accepted", () => {
    expect(refusal(valid)).toBeNull();
  });

  test.each([
    [
      "an engine this build does not know",
      { ...valid, engine: "xyz" },
      "monitoring.engine",
    ],
    [
      "a provider that is not a classification API",
      { ...valid, decisions: { ...valid.decisions, provider: "anthropic" } },
      "monitoring.decisions.provider",
    ],
    [
      "a rule naming a question that does not exist",
      {
        ...valid,
        decisions: {
          ...valid.decisions,
          rules: [
            {
              when: [{ question: "nao_existe", minProbability: 0.5 }],
              action: { tool: "set_labels", args: {} },
            },
          ],
        },
      },
      "monitoring.decisions.rules.0.when.0.question",
    ],
    [
      "a choice condition without equals",
      {
        ...valid,
        decisions: {
          ...valid.decisions,
          rules: [
            {
              when: [{ question: "assunto", minProbability: 0.5 }],
              action: { tool: "set_labels", args: {} },
            },
          ],
        },
      },
      // At the condition, not at the absent key: see crossFieldProblems.
      "monitoring.decisions.rules.0.when.0",
    ],
    [
      "an action that is not one of the watcher's writes",
      {
        ...valid,
        decisions: {
          ...valid.decisions,
          rules: [
            {
              when: [{ question: "pede_reembolso", minProbability: 0.5 }],
              action: { tool: "send_image", args: {} },
            },
          ],
        },
      },
      "monitoring.decisions.rules.0.action.tool",
    ],
    [
      "a threshold outside 0..1",
      {
        ...valid,
        decisions: {
          ...valid.decisions,
          rules: [
            {
              when: [{ question: "pede_reembolso", minProbability: 1.5 }],
              action: { tool: "set_labels", args: {} },
            },
          ],
        },
      },
      "monitoring.decisions.rules.0.when.0.minProbability",
    ],
    [
      "a block without questions, named at the block",
      {
        ...valid,
        decisions: { provider: "typesafe", credentialRef: "vault:1" },
      },
      "monitoring.decisions",
    ],
    [
      "a question without instructions, named at the question",
      {
        ...valid,
        decisions: {
          ...valid.decisions,
          questions: [{ name: "pede_reembolso", type: "yes_no" }],
          rules: [],
        },
      },
      "monitoring.decisions.questions.0",
    ],
    [
      "a rule without an action, named at the rule",
      {
        ...valid,
        decisions: {
          ...valid.decisions,
          rules: [
            { when: [{ question: "pede_reembolso", minProbability: 0.5 }] },
          ],
        },
      },
      "monitoring.decisions.rules.0",
    ],
    [
      "a choice with the same option twice",
      {
        ...valid,
        decisions: {
          ...valid.decisions,
          questions: [
            QUESTIONS[0],
            {
              ...QUESTIONS[1],
              options: [
                { value: "reembolso", description: "a" },
                { value: "reembolso", description: "b" },
              ],
            },
          ],
        },
      },
      "monitoring.decisions.questions.1.options.1.value",
    ],
    [
      "a choice condition naming an option the question does not have",
      {
        ...valid,
        decisions: {
          ...valid.decisions,
          rules: [
            {
              when: [{ question: "assunto", equals: "troca" }],
              action: { tool: "set_labels", args: {} },
            },
          ],
        },
      },
      "monitoring.decisions.rules.0.when.0.equals",
    ],
  ])("refused: %s", (_label, monitoring, field) => {
    const r = refusal(monitoring);
    expect(r?.statusCode).toBe(400);
    expect(r?.field).toBe(field);
  });

  test("the tick's reader agrees with the boundary, and answers a problem instead of throwing", () => {
    expect(readDecisionsConfig(valid).ok).toBe(true);
    const bad = readDecisionsConfig({
      decisions: { ...valid.decisions, provider: "anthropic" },
    });
    expect(bad).toEqual({
      ok: false,
      problem: expect.stringContaining("monitoring.decisions.provider"),
    });
    // Defaults the block may omit: the provider's model, and shadow, never enforce.
    const read = readDecisionsConfig({
      decisions: { ...valid.decisions, apply: undefined },
    });
    expect(read.ok && read.config.apply).toBe("shadow");
    expect(read.ok && read.config.model).toBe("jev-latest");
  });

  test("the console's Behavior save carries the engine and the block it has no control for", () => {
    const stored = readMonitoringConfig({ monitoring: valid });
    expect(stored.engine).toBe("decisions");
    const saved = observationToStored(observationToForm({ monitoring: valid }));
    expect(saved.engine).toBe("decisions");
    expect(saved.decisions).toEqual(valid.decisions);
  });

  test("typesafe is not a chat provider", () => {
    let err: { statusCode?: number } | null = null;
    try {
      assertAgentCreatable({
        name: "x",
        modelConfig: { provider: "typesafe", model: "jev-latest" },
      } as never);
    } catch (e) {
      err = e as { statusCode?: number };
    }
    expect(err?.statusCode).toBe(400);
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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

describe.skipIf(!dbUp)("the decisions block through MCP", () => {
  let tenantId = 0n;
  let agentId = 0n;
  let keyId = 0n;
  const keyName = `typesafe-teste-${process.pid}`;
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
      (
        await suDb.agent.findUniqueOrThrow({
          where: { id: agentId },
          select: { settings: true },
        })
      ).settings as Record<string, Record<string, unknown>> | null
    )?.monitoring;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DECSET", slug: `decset-${process.pid}` },
    });
    tenantId = t.id;
    keyId = (
      await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: keyName,
          secret: encryptJson("ts-secret-value"),
        },
        select: { id: true },
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: { tenantId, name: "Obs", systemPrompt: "p", mode: "monitoring" },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.agent.deleteMany({ where: { tenantId } }).catch(() => {});
      await suDb.vaultEntry.deleteMany({ where: { tenantId } }).catch(() => {});
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  const block = {
    engine: "decisions",
    decisions: {
      provider: "openai",
      model: "gpt-6-luna",
      credentialRef: keyName,
      questions: QUESTIONS,
      rules: RULES,
      apply: "shadow",
    },
  };

  test("the preview writes nothing; the apply stores the block with the credential as a ref", async () => {
    const before = await stored();
    const preview = await agentSettingsSet(
      principal(),
      { agent_id: String(agentId), monitoring: block } as never,
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    expect(await stored()).toEqual(before);

    const r = await agentSettingsSet(
      principal(),
      { agent_id: String(agentId), dry_run: false, monitoring: block } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const mon = await stored();
    expect(mon?.engine).toBe("decisions");
    const dec = mon?.decisions as Record<string, unknown>;
    expect(dec.credentialRef).toBe(`vault:${keyId}`);
    expect(dec.questions).toEqual(QUESTIONS);
    expect(dec.rules).toEqual(RULES);
    expect(dec.apply).toBe("shadow");
    expect(JSON.stringify(r)).not.toContain("ts-secret-value");
  });

  test("agent_settings_get answers the block with the credential's NAME, never the secret", async () => {
    const g = await agentSettingsGet(
      principal(),
      { agent_id: String(agentId) },
      { base: appDb },
    );
    expect(g.ok).toBe(true);
    const text = JSON.stringify(g);
    expect(text).not.toContain("ts-secret-value");
    const mon = (
      g as unknown as {
        data: { settings: { monitoring: Record<string, unknown> } };
      }
    ).data.settings.monitoring;
    expect(mon.engine).toBe("decisions");
    expect((mon.decisions as Record<string, unknown>).credentialRef).toBe(
      keyName,
    );
  });

  test("a later MCP write to another monitoring field keeps the engine and the block", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        monitoring: { window: { messages: 30 } },
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const mon = await stored();
    expect(mon?.engine).toBe("decisions");
    expect((mon?.decisions as Record<string, unknown>)?.questions).toEqual(
      QUESTIONS,
    );
  });
});
