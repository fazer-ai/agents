import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildGuardrailGate } from "@/modules/guardrails/gate";
import {
  GUARDRAILS_DEFAULTS,
  type GuardrailsConfig,
} from "@/modules/guardrails/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { guardrailModel } from "../utils/scripted-models";

// A guardrail that could not judge lets the message continue, and its warn line says so: that the
// message went on unchecked, in which direction, and which classifier failed (docs/logs.md).

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

const CUSTOMER = "MARCADOR-CLIENTE-1496";
const PROVIDER_BODY = "MARCADOR-PROVEDOR-1496";
let tenantId = 0n;
let seq = 0;

const ALL_CHECKS = {
  toxicity: true,
  unsafeContent: true,
  competitorMentions: false,
  promptAdherence: false,
  answerRelevance: false,
};

function cfg(over: Partial<GuardrailsConfig> = {}): GuardrailsConfig {
  return {
    ...GUARDRAILS_DEFAULTS,
    enabled: true,
    input: { ...GUARDRAILS_DEFAULTS.input, enabled: true, checks: ALL_CHECKS },
    output: {
      ...GUARDRAILS_DEFAULTS.output,
      enabled: true,
      checks: ALL_CHECKS,
    },
    ...over,
  };
}

function flow() {
  return {
    tenantId,
    turnId: `unchecked-${process.pid}-${++seq}`,
    source: "inbox" as const,
    base: appDb as never,
  };
}

async function lines(turnId: string) {
  const rows = await flowLogRows(suDb, {
    where: { tenantId, turnId, stage: "guardrail" },
    orderBy: { id: "asc" },
    select: { level: true, detail: true, errorMessage: true },
  });
  return rows.map((r) => ({
    level: r.level,
    detail: r.detail as Record<string, unknown>,
    errorMessage: r.errorMessage,
  }));
}

const failingChat = (() =>
  guardrailModel(async () => {
    throw new Error("The operation was aborted.");
  })) as never;

const cleanChat = (() =>
  guardrailModel(async () => ({
    content: JSON.stringify({ violated: false, categories: [], rationale: "" }),
  }))) as never;

const failingDecisions = (async () =>
  new Response(JSON.stringify({ error: PROVIDER_BODY }), {
    status: 503,
  })) as unknown as typeof fetch;

// Answers toxicity past its threshold and leaves every other question unanswered: a screening that
// failed in part and still tripped.
const partlyAnsweringDecisions = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { questions: object };
  const answers: Record<string, unknown> = {};
  for (const name of Object.keys(body.questions))
    if (name === "toxicity") answers[name] = { type: "noul", noul: 0.99 };
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers,
      usage: { input_tokens: 1 },
    }),
    { status: 200 },
  );
}) as unknown as typeof fetch;

describe.skipIf(!dbUp)(
  "the line a guardrail that could not judge writes",
  () => {
    beforeAll(async () => {
      tenantId = (
        await suDb.tenant.create({
          data: { name: "Unchecked", slug: `unchecked-${process.pid}` },
        })
      ).id;
    });

    afterAll(async () => {
      if (tenantId) {
        await clearFlowLog(suDb, { tenantId });
        await suDb.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("a chat verdict that fails on the customer's message lets it reach the agent, and says so", async () => {
      const f = flow();
      const gate = buildGuardrailGate({
        langfuseCfg: null,
        cfg: cfg(),
        apiKey: "k",
        flow: f,
        makeModel: failingChat,
      });
      expect(await gate("input", CUSTOMER)).toEqual({
        kind: "unavailable",
        modelRan: true,
      });
      const got = await lines(f.turnId);
      expect(got).toHaveLength(1);
      expect(got[0]?.level).toBe("warn");
      expect(got[0]?.detail).toEqual({
        direction: "input",
        outcome: "analysis_failed",
        classifier: "chat",
        unchecked: true,
      });
      expect(got[0]?.errorMessage).toBe("provider error");
    });

    test("a decisions provider that fails on the reply lets it go out, and the line names that classifier without the provider's text", async () => {
      const f = flow();
      const gate = buildGuardrailGate({
        langfuseCfg: null,
        cfg: cfg({ classifier: "decisions" }),
        apiKey: "k",
        flow: f,
        makeModel: (() => {
          throw new Error("the chat model must not be built");
        }) as never,
        decisionFetch: failingDecisions,
      });
      expect(await gate("output", CUSTOMER)).toMatchObject({
        kind: "unavailable",
      });
      const got = await lines(f.turnId);
      expect(got).toHaveLength(1);
      expect(got[0]?.detail).toMatchObject({
        direction: "output",
        outcome: "analysis_failed",
        classifier: "decisions",
        unchecked: true,
      });
      const detail = JSON.stringify(got[0]?.detail);
      expect(detail).not.toContain(CUSTOMER);
      expect(detail).not.toContain(PROVIDER_BODY);
    });

    for (const classifier of ["chat", "decisions"] as const) {
      test(`a missing credential under the ${classifier} classifier writes one unchecked line per direction`, async () => {
        const f = flow();
        const gate = buildGuardrailGate({
          langfuseCfg: null,
          cfg: cfg({ classifier }),
          apiKey: "",
          flow: f,
          makeModel: (() => {
            throw new Error("never built without a key");
          }) as never,
          decisionFetch: failingDecisions,
        });
        await gate("input", CUSTOMER);
        await gate("output", "resposta");
        // The two emits are fire-and-forget, so they land in either order.
        const got = (await lines(f.turnId))
          .map((l) => l.detail)
          .sort((a, b) =>
            String(a.direction).localeCompare(String(b.direction)),
          );
        expect(got).toEqual([
          {
            direction: "input",
            outcome: "credential_not_found",
            classifier,
            unchecked: true,
          },
          {
            direction: "output",
            outcome: "credential_not_found",
            classifier,
            unchecked: true,
          },
        ]);
      });
    }

    test("a chat model that will not build writes the unchecked line too", async () => {
      const f = flow();
      const gate = buildGuardrailGate({
        langfuseCfg: null,
        cfg: cfg(),
        apiKey: "k",
        flow: f,
        makeModel: (() => {
          throw new Error("openai-compatible provider requires a base URL");
        }) as never,
      });
      await gate("output", "resposta");
      const got = await lines(f.turnId);
      expect(got.map((l) => l.detail)).toEqual([
        {
          direction: "output",
          outcome: "model_unavailable",
          classifier: "chat",
          unchecked: true,
        },
      ]);
    });

    test("a screening that failed in part and still tripped says the message was not let through", async () => {
      const f = flow();
      const gate = buildGuardrailGate({
        langfuseCfg: null,
        cfg: cfg({ classifier: "decisions" }),
        apiKey: "k",
        flow: f,
        makeModel: (() => {
          throw new Error("the chat model must not be built");
        }) as never,
        decisionFetch: partlyAnsweringDecisions,
      });
      expect(await gate("output", "resposta")).toMatchObject({
        kind: "replaced",
      });
      const failed = (await lines(f.turnId)).filter(
        (l) => l.detail.outcome === "analysis_failed",
      );
      expect(
        failed.map((l) => [l.detail.classifier, l.detail.unchecked]),
      ).toEqual([["decisions", false]]);
    });

    test("a screening that ran and approved writes no unchecked line", async () => {
      const f = flow();
      const gate = buildGuardrailGate({
        langfuseCfg: null,
        cfg: cfg(),
        apiKey: "k",
        flow: f,
        makeModel: cleanChat,
      });
      expect(await gate("input", CUSTOMER)).toEqual({ kind: "clean" });
      const got = await lines(f.turnId);
      expect(got.some((l) => l.detail.unchecked !== undefined)).toBe(false);
    });
  },
);
