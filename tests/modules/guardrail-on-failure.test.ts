import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  buildGuardrailGate,
  chatwootNoteSink,
  type GuardrailReport,
} from "@/modules/guardrails/gate";
import {
  GUARDRAILS_DEFAULTS,
  type GuardrailsConfig,
  readGuardrailsConfig,
} from "@/modules/guardrails/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { guardrailModel } from "../utils/scripted-models";

// `guardrails.onFailure: "hold"`: a screening that could not judge stops the message as a hand-over
// does, with the direction's own customer line, instead of letting it through (docs/logs.md).

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

const CUSTOMER = "MARCADOR-CLIENTE-1513";
const PROVIDER_BODY = "MARCADOR-PROVEDOR-1513";
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
    turnId: `held-${process.pid}-${++seq}`,
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

const held = (over: Partial<GuardrailsConfig> = {}) =>
  cfg({ onFailure: "hold", ...over });

const trippingChat = (() =>
  guardrailModel(async () => ({
    content: JSON.stringify({
      violated: true,
      categories: ["toxicity"],
      rationale: "x",
    }),
  }))) as never;

describe("reading onFailure", () => {
  // The bug it catches: a stored value the reader does not know turning moderation into a hold, or
  // `hold` itself dropped on the way to the gate.
  test("only hold reads as hold; anything else, and nothing, is pass", () => {
    const read = (onFailure: unknown) =>
      readGuardrailsConfig({ guardrails: { onFailure } }).onFailure;
    expect(read("hold")).toBe("hold");
    expect(read("HOLD")).toBe("pass");
    expect(read(undefined)).toBe("pass");
    expect(readGuardrailsConfig({}).onFailure).toBe("pass");
  });
});

describe.skipIf(!dbUp)("a guardrail that could not judge, under hold", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Held", slug: `held-${process.pid}` },
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

  // The bug it catches: the failure still letting the customer's message reach the agent.
  test("a chat verdict that fails on the customer's message hands over with the input line", async () => {
    const f = flow();
    const reports: GuardrailReport[] = [];
    const gate = buildGuardrailGate({
      langfuseCfg: null,
      cfg: held({
        input: { ...cfg().input, handoffMessage: "LINHA-ENTRADA" },
        output: { ...cfg().output, handoffMessage: "LINHA-SAIDA" },
      }),
      apiKey: "k",
      flow: f,
      makeModel: failingChat,
      announce: (r) => {
        reports.push(r);
      },
    });
    expect(await gate("input", CUSTOMER)).toEqual({
      kind: "handed-off",
      reply: "LINHA-ENTRADA",
    });
    expect(reports).toEqual([
      {
        direction: "input",
        outcome: "handed-off",
        held: true,
        refused: CUSTOMER,
        cause: "analysis_failed",
      },
    ]);
    const got = await lines(f.turnId);
    expect(got).toHaveLength(1);
    expect(got[0]?.detail).toEqual({
      direction: "input",
      outcome: "analysis_failed",
      classifier: "chat",
      unchecked: false,
      held: true,
    });
  });

  // The bug it catches: the reply going out unchecked, or the hand-over sending the input line.
  test("a missing credential on the reply hands over with the output line, one line written", async () => {
    const f = flow();
    const gate = buildGuardrailGate({
      langfuseCfg: null,
      cfg: held({
        classifier: "decisions",
        output: { ...cfg().output, handoffMessage: "LINHA-SAIDA" },
      }),
      apiKey: "",
      flow: f,
      decisionFetch: failingDecisions,
    });
    expect(await gate("output", CUSTOMER)).toEqual({
      kind: "handed-off",
      reply: "LINHA-SAIDA",
    });
    const got = await lines(f.turnId);
    expect(got.map((l) => l.detail.held)).toEqual([true]);
  });

  // The bug it catches: an empty handoffMessage sent to the customer as an empty message.
  test("an empty handoff line hands over saying nothing", async () => {
    const gate = buildGuardrailGate({
      langfuseCfg: null,
      cfg: held({ output: { ...cfg().output, handoffMessage: "" } }),
      apiKey: "k",
      flow: flow(),
      makeModel: failingChat,
    });
    expect(await gate("output", CUSTOMER)).toEqual({
      kind: "handed-off",
      reply: null,
    });
  });

  // The bug it catches: hold applied to a follow-up the agent started, opening a case nobody asked for.
  test("a proactive screening that fails still passes", async () => {
    const f = flow();
    const gate = buildGuardrailGate({
      langfuseCfg: null,
      cfg: held(),
      apiKey: "k",
      flow: f,
      makeModel: failingChat,
      proactive: true,
    });
    expect(await gate("output", CUSTOMER)).toEqual({
      kind: "unavailable",
      modelRan: true,
    });
    expect((await lines(f.turnId))[0]?.detail).toMatchObject({
      unchecked: true,
    });
  });

  // The bug it catches: hold overriding a check that did answer, or a partial failure that tripped.
  test("a check that answered and tripped fires its own action, and a clean one passes", async () => {
    const tripped = buildGuardrailGate({
      langfuseCfg: null,
      cfg: held(),
      apiKey: "k",
      flow: flow(),
      makeModel: trippingChat,
    });
    expect(await tripped("output", CUSTOMER)).toEqual({
      kind: "replaced",
      reply: GUARDRAILS_DEFAULTS.output.templateMessage,
    });
    const partly = buildGuardrailGate({
      langfuseCfg: null,
      cfg: held({ classifier: "decisions" }),
      apiKey: "k",
      flow: flow(),
      decisionFetch: partlyAnsweringDecisions,
    });
    expect(await partly("output", CUSTOMER)).toMatchObject({
      kind: "replaced",
    });
    const clean = buildGuardrailGate({
      langfuseCfg: null,
      cfg: held(),
      apiKey: "k",
      flow: flow(),
      makeModel: cleanChat,
    });
    expect(await clean("output", CUSTOMER)).toEqual({ kind: "clean" });
  });
});

// Answers toxicity well under its threshold and leaves every other question unanswered: a screening
// that failed in part with nothing tripped.
const partlyCleanDecisions = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { questions: object };
  const answers: Record<string, unknown> = {};
  for (const name of Object.keys(body.questions))
    if (name === "toxicity") answers[name] = { type: "noul", noul: 0.05 };
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), {
    status: 200,
  });
}) as unknown as typeof fetch;

describe("an empty screening under hold", () => {
  // The bug it catches: a missing key read before "is there anything to ask", so a decisions
  // screening with nothing to ask hands the conversation over under hold.
  test.skipIf(!dbUp)(
    "with nothing to ask and no key, nothing is held and nothing is written",
    async () => {
      const f = flow();
      const reports: GuardrailReport[] = [];
      const onlyCompetitors = {
        toxicity: false,
        unsafeContent: false,
        competitorMentions: true,
        promptAdherence: false,
        answerRelevance: false,
      };
      const gate = buildGuardrailGate({
        langfuseCfg: null,
        cfg: held({
          classifier: "decisions",
          competitors: [],
          customPolicy: "",
          input: {
            ...GUARDRAILS_DEFAULTS.input,
            enabled: true,
            checks: onlyCompetitors,
          },
        }),
        apiKey: "",
        flow: f,
        decisionFetch: failingDecisions,
        announce: async (r) => {
          reports.push(r);
        },
      });
      expect(await gate("input", CUSTOMER)).toEqual({ kind: "not-run" });
      expect(reports).toEqual([]);
      expect(await lines(f.turnId)).toEqual([]);
    },
  );
});

describe("the scores a held screening keeps", () => {
  // The bug it catches: hold replacing the report and dropping which checks answered, so the note
  // and the playground trace can no longer say which one failed.
  test.skipIf(!dbUp)(
    "a decisions screening that failed in part holds with the scores it got",
    async () => {
      const reports: GuardrailReport[] = [];
      const gate = buildGuardrailGate({
        langfuseCfg: null,
        cfg: held({ classifier: "decisions" }),
        apiKey: "k",
        flow: flow(),
        decisionFetch: partlyCleanDecisions,
        announce: async (r) => {
          reports.push(r);
        },
      });
      expect((await gate("output", CUSTOMER)).kind).toBe("handed-off");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ held: true, outcome: "handed-off" });
      const toxicity = reports[0]?.scores?.find(
        (x) => x.category === "toxicity",
      );
      expect(toxicity?.probability).toBe(0.05);
      expect(reports[0]?.scores?.some((x) => x.probability === null)).toBe(
        true,
      );
    },
  );
});

describe("the note a held message leaves", () => {
  // The bug it catches: a held hand-over posting no note, or one that reads like a policy trip.
  test("says the check could not run and quotes the reply that was held", async () => {
    const notes: string[] = [];
    const sink = chatwootNoteSink(
      {
        sendPrivateNote: async (_c: number, text: string) => {
          notes.push(text);
        },
      } as never,
      1,
    );
    await sink({
      direction: "output",
      outcome: "handed-off",
      held: true,
      refused: "RESPOSTA-SEGURADA",
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("a checagem não pôde ser feita");
    expect(notes[0]).toContain("RESPOSTA-SEGURADA");
  });

  // The bug it catches: a held note that never says why, so the person taking the case over cannot
  // tell a deleted credential from a model that timed out.
  test.skipIf(!dbUp)(
    "names the cause: a missing credential, and a model that failed",
    async () => {
      const notes: string[] = [];
      const announce = chatwootNoteSink(
        {
          sendPrivateNote: async (_c: number, text: string) => {
            notes.push(text);
          },
        } as never,
        1,
      );
      const noKey = buildGuardrailGate({
        langfuseCfg: null,
        cfg: held(),
        apiKey: "",
        flow: flow(),
        makeModel: cleanChat,
        announce,
      });
      await noKey("input", CUSTOMER);
      const failing = buildGuardrailGate({
        langfuseCfg: null,
        cfg: held(),
        apiKey: "k",
        flow: flow(),
        makeModel: failingChat,
        announce,
      });
      await failing("input", CUSTOMER);
      const noProviderKey = buildGuardrailGate({
        langfuseCfg: null,
        cfg: held({ classifier: "decisions" }),
        apiKey: "",
        flow: flow(),
        decisionFetch: failingDecisions,
        announce,
      });
      await noProviderKey("input", CUSTOMER);
      expect(notes).toHaveLength(3);
      expect(notes[0]).toContain(
        "a credencial do guardrail não foi encontrada",
      );
      expect(notes[1]).toContain(
        "o modelo do guardrail falhou ou não respondeu dentro do limite",
      );
      expect(notes[2]).toContain(
        "a credencial do guardrail não foi encontrada",
      );
    },
  );

  test("lists the scores of the checks that did answer", async () => {
    const notes: string[] = [];
    const sink = chatwootNoteSink(
      {
        sendPrivateNote: async (_c: number, text: string) => {
          notes.push(text);
        },
      } as never,
      1,
    );
    await sink({
      direction: "input",
      outcome: "handed-off",
      held: true,
      refused: CUSTOMER,
      scores: [
        { category: "toxicity", probability: 0.05, threshold: 0.8 },
        { category: "unsafeContent", probability: null, threshold: 0.8 },
      ],
    } as GuardrailReport);
    expect(notes[0]).toContain("toxicity 0.05 (threshold 0.80)");
    expect(notes[0]).toContain("unsafeContent ? (threshold 0.80)");
  });
});
