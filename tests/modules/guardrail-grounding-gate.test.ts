import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { FlowContext } from "@/modules/flowlog/service";
import type { GuardrailReport } from "@/modules/guardrails/gate";
import {
  GROUNDING_NO_SOURCE_PROMPT,
  GROUNDING_SOURCES_MAX,
} from "@/modules/guardrails/grounding";
import { buildGroundingGate } from "@/modules/guardrails/grounding-gate";
import {
  type GroundingAction,
  GUARDRAILS_DEFAULTS,
  type GuardrailsConfig,
} from "@/modules/guardrails/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { guardrailModel } from "../utils/scripted-models";

// The factual-grounding check as the turn runs it: when it reviews, what each action leaves for the
// caller, and what the flow line says. A made-up catalog; no real customer text.

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

let tenantId = 0n;
let seq = 0;
const TEMPLATE = "[resposta substituída]";
const HANDOFF = "[time assume]";
const DRAFT = "Os portões abrem às 16h.";

function cfg(
  action: GroundingAction,
  over: Partial<GuardrailsConfig> = {},
): GuardrailsConfig {
  return {
    ...GUARDRAILS_DEFAULTS,
    enabled: true,
    output: {
      ...GUARDRAILS_DEFAULTS.output,
      templateMessage: TEMPLATE,
      handoffMessage: HANDOFF,
    },
    factualGrounding: {
      ...GUARDRAILS_DEFAULTS.factualGrounding,
      enabled: true,
      sourceTools: ["catalogo"],
      action,
    },
    ...over,
  };
}

function flow(): FlowContext {
  return {
    tenantId,
    turnId: `grounding-${process.pid}-${++seq}`,
    source: "inbox",
    base: appDb,
  } as FlowContext;
}

function turn(toolName = "catalogo", result = "Portões: 18h."): BaseMessage[] {
  return [
    new HumanMessage("Que horas abrem os portões?"),
    new AIMessage({
      content: "",
      tool_calls: [{ name: toolName, args: {}, id: "c1" }],
    }),
    new ToolMessage({ content: result, tool_call_id: "c1", name: toolName }),
    new AIMessage(DRAFT),
  ];
}

// Turn 1 asked the catalog; turn 2 answers from memory, calling nothing.
function fromMemory(): BaseMessage[] {
  return [
    new HumanMessage("Que horas abrem os portões?"),
    new AIMessage({
      content: "",
      tool_calls: [{ name: "catalogo", args: {}, id: "m1" }],
    }),
    new ToolMessage({
      content: "Portões: 18h.",
      tool_call_id: "m1",
      name: "catalogo",
    }),
    new AIMessage("Às 18h."),
    new HumanMessage("Tem certeza? Não era às 16h?"),
    new AIMessage(DRAFT),
  ];
}

// A reviewer that reports its usage to the callbacks it is handed, as a provider adapter does.
function billedReviewer(answer: string) {
  return (() => {
    const run = async (_m: unknown, opts?: { callbacks?: unknown[] }) => {
      for (const cb of opts?.callbacks ?? [])
        await (
          cb as { handleLLMEnd?: (o: unknown, id: string) => Promise<void> }
        ).handleLLMEnd?.(
          {
            generations: [
              [
                {
                  text: answer,
                  message: {
                    usage_metadata: {
                      input_tokens: 1200,
                      output_tokens: 80,
                      total_tokens: 1280,
                    },
                  },
                },
              ],
            ],
          },
          "r1",
        );
      return { content: answer };
    };
    return {
      invoke: run,
      withStructuredOutput: () => ({
        invoke: async (m: unknown, opts?: { callbacks?: unknown[] }) => {
          const raw = await run(m, opts);
          return { raw, parsed: JSON.parse(answer) };
        },
      }),
    };
  }) as never;
}

const VIOLATED = JSON.stringify({
  violated: true,
  claims: [
    { claim: "abre às 16h", type: "contradiction", evidence: "Portões: 18h" },
  ],
  rationale: "horário diferente",
});

const CLEAN = JSON.stringify({ violated: false, claims: [], rationale: "" });

function reviewer(answer: string | Error) {
  const calls: unknown[] = [];
  const make = (() =>
    guardrailModel(async (msgs) => {
      calls.push(msgs);
      if (answer instanceof Error) throw answer;
      return { content: answer };
    })) as never;
  return { calls, make };
}

async function lines(turnId: string) {
  const rows = await flowLogRows(suDb, {
    where: { tenantId, turnId, stage: "guardrail" },
    orderBy: { id: "asc" },
    select: { level: true, status: true, detail: true },
  });
  return rows.map((r) => r.detail as Record<string, unknown>);
}

test("off, or with no source tool named, there is no hook at all", () => {
  const base = cfg("observe");
  expect(
    buildGroundingGate({
      langfuseCfg: null,
      cfg: { ...base, enabled: false },
      apiKey: "k",
      flow: { tenantId: 1n, turnId: "x", source: "inbox" } as FlowContext,
    }),
  ).toBeNull();
  expect(
    buildGroundingGate({
      langfuseCfg: null,
      cfg: {
        ...base,
        factualGrounding: { ...base.factualGrounding, sourceTools: [] },
      },
      apiKey: "k",
      flow: { tenantId: 1n, turnId: "x", source: "inbox" } as FlowContext,
    }),
  ).toBeNull();
});

describe.skipIf(!dbUp)("a reviewed turn", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Grounding", slug: `grounding-${process.pid}` },
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

  // The bug it catches: a reply stating an in-scope fact with no source consulted went out unchecked,
  // since only a turn a source answered was reviewed.
  test("a turn where no source ran is reviewed, told at system level that nothing was consulted", async () => {
    const r = reviewer(VIOLATED);
    const f = flow();
    const gate = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("observe"),
      apiKey: "k",
      flow: f,
      makeModel: r.make,
    });
    const answered = [
      new HumanMessage("O camarote Aurora dá acesso ao setor Leste?"),
      new AIMessage("Sim, o camarote Aurora dá acesso ao setor Leste."),
    ];
    expect(await gate?.review(answered)).toBeNull();
    const [system, user] = (r.calls[0] ?? []) as BaseMessage[];
    const [line] = await lines(f.turnId);
    expect([
      r.calls.length,
      String(system?.content).includes(GROUNDING_NO_SOURCE_PROMPT),
      String(user?.content).includes("<tool_results>\n\n</tool_results>"),
      line?.verdict,
      line?.sourced,
      line?.sources,
    ]).toEqual([1, true, true, "violated", false, []]);
  });

  test("a turn a source answered is reviewed without the no-source instruction, and says sourced", async () => {
    const r = reviewer(CLEAN);
    const f = flow();
    await buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("observe"),
      apiKey: "k",
      flow: f,
      makeModel: r.make,
    })?.review(turn());
    const [system] = (r.calls[0] ?? []) as BaseMessage[];
    const [line] = await lines(f.turnId);
    expect([
      String(system?.content).includes(GROUNDING_NO_SOURCE_PROMPT),
      line?.verdict,
      line?.sourced,
    ]).toEqual([false, "clean", true]);
  });

  test("observe records the claims and the evidence, and leaves the reply alone", async () => {
    const r = reviewer(VIOLATED);
    const f = flow();
    const reports: GuardrailReport[] = [];
    const gate = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("observe"),
      apiKey: "k",
      flow: f,
      makeModel: r.make,
      logValues: true,
      announce: (rep) => {
        reports.push(rep);
      },
    });
    expect(await gate?.review(turn())).toBeNull();
    expect(gate?.pending()).toBeNull();
    expect(reports[0]?.outcome).toBe("observed");
    expect(reports[0]?.claims?.[0]?.evidence).toBe("Portões: 18h");
    const [line] = await lines(f.turnId);
    expect(line?.check).toBe("factual_grounding");
    expect(line?.action).toBe("observe");
    expect(line?.claims).toEqual([
      { claim: "abre às 16h", type: "contradiction", evidence: "Portões: 18h" },
    ]);
  });

  test("with logToolValues off the line carries the count, not the claims", async () => {
    const f = flow();
    await buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("observe"),
      apiKey: "k",
      flow: f,
      makeModel: reviewer(VIOLATED).make,
    })?.review(turn());
    const [line] = await lines(f.turnId);
    expect(line?.claimCount).toBe(1);
    expect(JSON.stringify(line)).not.toContain("16h");
  });

  test("revise answers with a note naming the claim", async () => {
    const gate = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("revise"),
      apiKey: "k",
      flow: flow(),
      makeModel: reviewer(VIOLATED).make,
    });
    const note = await gate?.review(turn());
    expect(note).toContain("abre às 16h");
    expect(note).toContain(DRAFT);
    expect(gate?.pending()).toBeNull();
  });

  test("an empty rewrite leaves the Output template as the decision", async () => {
    const gate = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("revise"),
      apiKey: "k",
      flow: flow(),
      makeModel: reviewer(VIOLATED).make,
    });
    await gate?.review(turn());
    gate?.revised("Abre às 18h.");
    expect(gate?.pending()).toBeNull();
    gate?.revised("  ");
    expect(gate?.pending()).toEqual({ kind: "replaced", reply: TEMPLATE });
  });

  test("template and handoff leave the decision for the output gate", async () => {
    const t = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("template"),
      apiKey: "k",
      flow: flow(),
      makeModel: reviewer(VIOLATED).make,
    });
    expect(await t?.review(turn())).toBeNull();
    expect(t?.pending()).toEqual({ kind: "replaced", reply: TEMPLATE });
    const h = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("handoff"),
      apiKey: "k",
      flow: flow(),
      makeModel: reviewer(VIOLATED).make,
    });
    await h?.review(turn());
    expect(h?.pending()).toEqual({ kind: "handed-off", reply: HANDOFF });
  });

  test("a clean verdict changes nothing, and its review is still a line with its size and cost", async () => {
    const f = flow();
    const reports: GuardrailReport[] = [];
    const rows: { node: string | null; promptTokens: number }[] = [];
    const gate = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("revise"),
      apiKey: "k",
      flow: f,
      makeModel: billedReviewer(
        '{"violated": false, "claims": [], "rationale": ""}',
      ),
      persistUsage: async (row) => {
        rows.push({ node: row.node, promptTokens: row.promptTokens });
      },
      announce: (rep) => {
        reports.push(rep);
      },
    });
    expect(await gate?.review(turn())).toBeNull();
    expect(gate?.pending()).toBeNull();
    expect(reports.map((x) => x.outcome)).toEqual(["clean"]);
    const [line] = await lines(f.turnId);
    expect(line).toMatchObject({
      check: "factual_grounding",
      verdict: "clean",
      claimCount: 0,
      sources: ["catalogo"],
      resultChars: "Portões: 18h.".length,
      earlierSources: 0,
      inputTokens: 1200,
      outputTokens: 80,
    });
    expect(line?.action).toBeUndefined();
    expect(rows).toEqual([{ node: "guardrail_grounding", promptTokens: 1200 }]);
  });

  test("a turn that calls nothing is reviewed against a source an earlier turn in the window returned", async () => {
    const r = reviewer(VIOLATED);
    const f = flow();
    const gate = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("observe"),
      apiKey: "k",
      flow: f,
      makeModel: r.make,
    });
    expect(await gate?.review(fromMemory())).toBeNull();
    expect(r.calls).toHaveLength(1);
    const sent = JSON.stringify(r.calls[0]);
    expect(sent).toContain('turn=\\"earlier\\" turns_back=\\"1\\"');
    expect(sent).toContain("Portões: 18h.");
    const [line] = await lines(f.turnId);
    expect(line).toMatchObject({ verdict: "violated", earlierSources: 1 });
  });

  test("when the window does not reach the turn that asked the source, the reply is reviewed as unsourced", async () => {
    const r = reviewer(VIOLATED);
    const base = cfg("observe");
    const f = flow();
    await buildGroundingGate({
      langfuseCfg: null,
      cfg: {
        ...base,
        factualGrounding: { ...base.factualGrounding, contextMessages: 1 },
      },
      apiKey: "k",
      flow: f,
      makeModel: r.make,
    })?.review(fromMemory());
    const [line] = await lines(f.turnId);
    expect([r.calls.length, line?.sourced, line?.earlierSources]).toEqual([
      1,
      false,
      0,
    ]);
  });

  test("a review that fails lets the reply through, unless onFailure holds it", async () => {
    const f = flow();
    const pass = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("revise"),
      apiKey: "k",
      flow: f,
      makeModel: reviewer(new Error("down")).make,
    });
    expect(await pass?.review(turn())).toBeNull();
    expect(pass?.pending()).toBeNull();
    expect((await lines(f.turnId))[0]?.outcome).toBe("analysis_failed");
    const held = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("revise", { onFailure: "hold" }),
      apiKey: "k",
      flow: flow(),
      makeModel: reviewer(new Error("down")).make,
    });
    await held?.review(turn());
    expect(held?.pending()).toEqual({ kind: "handed-off", reply: HANDOFF });
  });

  test("results past the ceiling are not reviewed, and the line says why", async () => {
    const r = reviewer(VIOLATED);
    const f = flow();
    await buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("observe"),
      apiKey: "k",
      flow: f,
      makeModel: r.make,
    })?.review(turn("catalogo", "x".repeat(GROUNDING_SOURCES_MAX + 1)));
    expect(r.calls).toHaveLength(0);
    expect((await lines(f.turnId))[0]?.outcome).toBe("sources_too_large");
  });

  test("a keyless compatible endpoint is reviewed, and no key elsewhere is a missing credential", async () => {
    const r = reviewer(VIOLATED);
    const base = cfg("observe");
    await buildGroundingGate({
      langfuseCfg: null,
      cfg: {
        ...base,
        factualGrounding: {
          ...base.factualGrounding,
          provider: "openai-compatible",
          model: "revisor",
          credentialRef: null,
          baseURL: "http://revisor.local/v1",
        },
      },
      apiKey: "",
      flow: flow(),
      makeModel: r.make,
    })?.review(turn());
    expect(r.calls).toHaveLength(1);
  });

  test("no key is reported as a missing credential, never as clean", async () => {
    const f = flow();
    await buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("observe"),
      apiKey: "",
      flow: f,
      makeModel: reviewer(VIOLATED).make,
    })?.review(turn());
    expect((await lines(f.turnId))[0]?.outcome).toBe("credential_not_found");
  });

  test("a turn that ended is not reviewed, and one ending during the review decides nothing", async () => {
    const r = reviewer(VIOLATED);
    const f = flow();
    const done = new AbortController();
    done.abort(new Error("job deadline"));
    const gate = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("handoff"),
      apiKey: "k",
      flow: f,
      makeModel: r.make,
      signal: done.signal,
    });
    expect(await gate?.review(turn())).toBeNull();
    expect(r.calls).toHaveLength(0);
    const ending = new AbortController();
    const mid = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("handoff"),
      apiKey: "k",
      flow: f,
      makeModel: (() =>
        guardrailModel(async () => {
          ending.abort(new Error("job deadline"));
          return { content: VIOLATED };
        })) as never,
      signal: ending.signal,
    });
    expect(await mid?.review(turn())).toBeNull();
    expect(mid?.pending()).toBeNull();
    expect(await lines(f.turnId)).toEqual([]);
  });
});
