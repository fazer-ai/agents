import { describe, expect, test } from "bun:test";
import {
  CUSTOM_POLICY_KEY,
  classifyGuardrail,
  guardrailAsks,
} from "@/modules/guardrails/classify";
import {
  buildGuardrailGate,
  chatwootNoteSink,
  type GuardrailReport,
} from "@/modules/guardrails/gate";
import {
  GUARDRAILS_DEFAULTS,
  type GuardrailsConfig,
} from "@/modules/guardrails/settings";

// The guardrail screening on a decisions-engine provider: one yes/no question per
// enabled check and for the operator's policy, a trip at the threshold, numbers in place of a
// rationale, and `generated` never carried out.

const NO_CHECKS = {
  toxicity: false,
  unsafeContent: false,
  competitorMentions: false,
  promptAdherence: false,
  answerRelevance: false,
};

const thresholds = GUARDRAILS_DEFAULTS.decisions.thresholds;

interface SentCall {
  url: string;
  body: {
    model: string;
    state?: string;
    input?: string;
    questions: unknown;
  };
}

// A TypeSafe endpoint answering each `noul` question with the probability `answer(name, state)`
// gives, or leaving it out when that returns undefined.
function typesafeFetch(
  answer: (name: string, state: string) => number | undefined,
  opts: { status?: number } = {},
): { fetch: typeof fetch; calls: SentCall[] } {
  const calls: SentCall[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as SentCall["body"];
    calls.push({ url, body });
    if (opts.status && opts.status !== 200)
      return new Response("{}", { status: opts.status });
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(body.questions as object)) {
      const p = answer(name, body.state ?? "");
      if (p !== undefined) answers[name] = { type: "noul", noul: p };
    }
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers,
        usage: { input_tokens: 120 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe("guardrailAsks", () => {
  test("one question per enabled input check, named by the log's keys", () => {
    const asks = guardrailAsks(
      {
        direction: "input",
        text: "oi",
        checks: { ...NO_CHECKS, toxicity: true, unsafeContent: true },
        competitors: [],
        customPolicy: "",
      },
      thresholds,
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]?.input).toBe("Customer message:\noi");
    expect(asks[0]?.questions.map((q) => q.name)).toEqual([
      "toxicity",
      "unsafe_content",
    ]);
    expect(asks[0]?.questions[0]?.instructions).toContain(
      "the customer message",
    );
  });

  test("the reply-only checks are never asked about a customer message", () => {
    const asks = guardrailAsks(
      {
        direction: "input",
        text: "oi",
        checks: { ...NO_CHECKS, promptAdherence: true, answerRelevance: true },
        competitors: [],
        customPolicy: "",
        customerMessage: "oi",
      },
      thresholds,
    );
    expect(asks).toEqual([]);
  });

  test("competitor mentions with no names asks nothing; with names, names them", () => {
    const base = {
      direction: "output" as const,
      text: "compre na MegaLoja",
      checks: { ...NO_CHECKS, competitorMentions: true },
      customPolicy: "",
    };
    expect(guardrailAsks({ ...base, competitors: [] }, thresholds)).toEqual([]);
    const asks = guardrailAsks(
      { ...base, competitors: ["MegaLoja", "Outra"] },
      thresholds,
    );
    expect(asks[0]?.questions[0]?.name).toBe("competitor_mention");
    expect(asks[0]?.questions[0]?.instructions).toContain("MegaLoja, Outra");
  });

  test("the operator's policy travels as written, keyed custom_policy, with its own threshold", () => {
    const asks = guardrailAsks(
      {
        direction: "output",
        text: "reembolso garantido",
        checks: NO_CHECKS,
        competitors: [],
        customPolicy: "  A resposta promete reembolso ao cliente?  ",
      },
      { ...thresholds, customPolicy: 0.55 },
    );
    expect(asks[0]?.questions).toEqual([
      {
        name: CUSTOM_POLICY_KEY,
        type: "yes_no",
        instructions: "A resposta promete reembolso ao cliente?",
        threshold: 0.55,
      },
    ]);
  });

  test("relevance goes in a call of its own, the only one carrying the customer's message", () => {
    const asks = guardrailAsks(
      {
        direction: "output",
        text: "O prazo é de 3 dias.",
        checks: { ...NO_CHECKS, toxicity: true, answerRelevance: true },
        competitors: [],
        customPolicy: "",
        systemPrompt: "Você atende a Loja Verde.",
        customerMessage: "Qual o prazo?",
      },
      thresholds,
    );
    expect(asks).toHaveLength(2);
    const [policies, relevance] = asks;
    expect(policies?.questions.map((q) => q.name)).toEqual(["toxicity"]);
    expect(policies?.input).not.toContain("Qual o prazo?");
    // Instructions travel only for the check that judges against them.
    expect(policies?.input).not.toContain("Loja Verde");
    expect(relevance?.questions.map((q) => q.name)).toEqual([
      "answer_relevance",
    ]);
    expect(relevance?.input).toContain("Qual o prazo?");
    expect(relevance?.input).toContain("Loja Verde");
    expect(relevance?.input).toContain("O prazo é de 3 dias.");
  });

  test("prompt adherence reads the agent's instructions", () => {
    const asks = guardrailAsks(
      {
        direction: "output",
        text: "x",
        checks: { ...NO_CHECKS, promptAdherence: true },
        competitors: [],
        customPolicy: "",
        systemPrompt: "Você atende a Loja Verde.",
      },
      thresholds,
    );
    expect(asks[0]?.input).toContain("Loja Verde");
  });

  test("relevance without a customer message is not asked", () => {
    const asks = guardrailAsks(
      {
        direction: "output",
        text: "x",
        checks: { ...NO_CHECKS, answerRelevance: true },
        competitors: [],
        customPolicy: "",
      },
      thresholds,
    );
    expect(asks).toEqual([]);
  });
});

describe("classifyGuardrail", () => {
  const cfg = {
    ...GUARDRAILS_DEFAULTS.decisions,
    provider: "typesafe" as const,
  };
  const params = {
    direction: "input" as const,
    text: "você é uma idiota",
    checks: { ...NO_CHECKS, toxicity: true, unsafeContent: true },
    competitors: [],
    customPolicy: "",
  };

  test("a check trips when its probability reaches the threshold, not below", async () => {
    const at = typesafeFetch((name) => (name === "toxicity" ? 0.8 : 0.79));
    const v = await classifyGuardrail(cfg, params, "k", null, at.fetch);
    expect(v.violated).toBe(true);
    expect(v.categories).toEqual(["toxicity"]);
    expect(v.scores).toEqual([
      { category: "toxicity", probability: 0.8, threshold: 0.8 },
      { category: "unsafe_content", probability: 0.79, threshold: 0.8 },
    ]);
    expect(v.error).toBeUndefined();
    expect(v.calls).toEqual([
      { inputTokens: 120, durationMs: expect.any(Number) },
    ]);
    expect(at.calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(at.calls[0]?.body.model).toBe("jev-latest");
  });

  test("the threshold is the configured one", async () => {
    const f = typesafeFetch(() => 0.6);
    const strict = await classifyGuardrail(
      { ...cfg, thresholds: { ...cfg.thresholds, toxicity: 0.5 } },
      params,
      "k",
      null,
      f.fetch,
    );
    expect(strict.categories).toEqual(["toxicity"]);
    const lax = await classifyGuardrail(cfg, params, "k", null, f.fetch);
    expect(lax.violated).toBe(false);
  });

  test("an unanswered question is an error, never clean or violated", async () => {
    const f = typesafeFetch((name) => (name === "toxicity" ? 0.1 : undefined));
    const v = await classifyGuardrail(cfg, params, "k", null, f.fetch);
    expect(v.violated).toBe(false);
    expect(v.error).toBe("no answer for unsafe_content");
    expect(v.scores[1]).toEqual({
      category: "unsafe_content",
      probability: null,
      threshold: 0.8,
    });
  });

  test("a provider failure fails open with the status only, and bills nothing", async () => {
    const f = typesafeFetch(() => 1, { status: 503 });
    const v = await classifyGuardrail(cfg, params, "k", null, f.fetch);
    expect(v.violated).toBe(false);
    expect(v.error).toBe("HTTP 503");
    expect(v.calls).toEqual([]);
    expect(v.scores.every((s) => s.probability === null)).toBe(true);
  });

  test("the credential's base URL replaces the provider's", async () => {
    const f = typesafeFetch(() => 0);
    await classifyGuardrail(
      cfg,
      params,
      "k",
      "https://ts.example/v1/",
      f.fetch,
    );
    expect(f.calls[0]?.url).toBe("https://ts.example/v1/systemone");
  });
});

describe("the gate under a decisions classifier", () => {
  const flow = {
    tenantId: 1n,
    turnId: "gate-test",
    source: "playground" as const,
    base: {} as never,
  };
  const cfgWith = (over: Partial<GuardrailsConfig> = {}): GuardrailsConfig => ({
    ...GUARDRAILS_DEFAULTS,
    enabled: true,
    classifier: "decisions",
    ...over,
  });
  const neverModel = (() => {
    throw new Error("the chat model must not be built");
  }) as never;

  function gateFor(
    cfg: GuardrailsConfig,
    answer: (name: string) => number | undefined,
    apiKey = "k",
  ) {
    const reports: GuardrailReport[] = [];
    const notes: string[] = [];
    const f = typesafeFetch((n) => answer(n));
    const gate = buildGuardrailGate({
      langfuseCfg: null,
      cfg,
      apiKey,
      announce: async (r) => {
        reports.push(r);
        await chatwootNoteSink(
          {
            sendPrivateNote: async (_id: number, text: string) => {
              notes.push(text);
            },
          } as never,
          1,
        )(r);
      },
      flow,
      makeModel: neverModel,
      decisionFetch: f.fetch,
    });
    return { gate, reports, notes, calls: f.calls };
  }

  test("a trip sends the template and reports the scores, no rationale", async () => {
    const g = gateFor(cfgWith(), (n) => (n === "toxicity" ? 0.97 : 0.01));
    const d = await g.gate("input", "você é uma idiota");
    expect(d).toEqual({
      kind: "replaced",
      reply: GUARDRAILS_DEFAULTS.input.templateMessage,
    });
    expect(g.reports[0]).toEqual({
      direction: "input",
      outcome: "replaced",
      action: "template",
      categories: ["toxicity"],
      scores: [
        { category: "toxicity", probability: 0.97, threshold: 0.8 },
        { category: "unsafe_content", probability: 0.01, threshold: 0.8 },
      ],
    });
    expect(g.reports[0]?.rationale).toBeUndefined();
    // The note names the numbers, tripped first, and quotes nothing of the message.
    expect(g.notes[0]).toContain("toxicity 0.97 (threshold 0.80)");
    expect(g.notes[0]).not.toContain("idiota");
  });

  test("a clean screening reports its scores too", async () => {
    const g = gateFor(cfgWith(), () => 0.02);
    expect(await g.gate("input", "qual o prazo?")).toEqual({ kind: "clean" });
    expect(g.reports[0]).toEqual({
      direction: "input",
      outcome: "clean",
      scores: [
        { category: "toxicity", probability: 0.02, threshold: 0.8 },
        { category: "unsafe_content", probability: 0.02, threshold: 0.8 },
      ],
    });
  });

  test("generated stored under a classifier sends the template and says so", async () => {
    const g = gateFor(
      cfgWith({
        output: { ...GUARDRAILS_DEFAULTS.output, action: "generated" },
      }),
      () => 0.99,
    );
    const d = await g.gate("output", "resposta");
    expect(d).toEqual({
      kind: "replaced",
      reply: GUARDRAILS_DEFAULTS.output.templateMessage,
    });
    expect(g.reports[0]?.action).toBe("template");
  });

  test("handoff and silent run as configured", async () => {
    const silent = gateFor(
      cfgWith({ input: { ...GUARDRAILS_DEFAULTS.input, action: "silent" } }),
      () => 0.99,
    );
    expect(await silent.gate("input", "x")).toEqual({ kind: "suppressed" });
    const handoff = gateFor(
      cfgWith({ input: { ...GUARDRAILS_DEFAULTS.input, action: "handoff" } }),
      () => 0.99,
    );
    expect((await handoff.gate("input", "x")).kind).toBe("handed-off");
  });

  test("a disabled check is not asked and a disabled direction asks nothing", async () => {
    const g = gateFor(
      cfgWith({
        input: {
          ...GUARDRAILS_DEFAULTS.input,
          checks: { ...NO_CHECKS, toxicity: true },
        },
        output: { ...GUARDRAILS_DEFAULTS.output, enabled: false },
      }),
      () => 0.1,
    );
    await g.gate("input", "x");
    expect(Object.keys(g.calls[0]?.body.questions as object)).toEqual([
      "toxicity",
    ]);
    expect(await g.gate("output", "y")).toEqual({ kind: "not-run" });
    expect(g.calls).toHaveLength(1);
  });

  test("no key is unavailable without a call", async () => {
    const g = gateFor(cfgWith(), () => 1, "");
    expect(await g.gate("input", "x")).toEqual({
      kind: "unavailable",
      modelRan: false,
    });
    expect(g.calls).toHaveLength(0);
  });

  test("an unanswered question is unavailable, after the call", async () => {
    const g = gateFor(cfgWith(), (n) => (n === "toxicity" ? 0.1 : undefined));
    expect(await g.gate("input", "x")).toEqual({
      kind: "unavailable",
      modelRan: true,
    });
  });

  test("competitor mentions alone with no names asks nothing", async () => {
    const g = gateFor(
      cfgWith({
        output: {
          ...GUARDRAILS_DEFAULTS.output,
          checks: { ...NO_CHECKS, competitorMentions: true },
        },
      }),
      () => 1,
    );
    expect(await g.gate("output", "x")).toEqual({ kind: "not-run" });
    expect(g.calls).toHaveLength(0);
  });
});
