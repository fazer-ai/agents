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
import { GROUNDING_SOURCES_MAX } from "@/modules/guardrails/grounding";
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

const VIOLATED = JSON.stringify({
  violated: true,
  claims: [
    { claim: "abre às 16h", type: "contradiction", evidence: "Portões: 18h" },
  ],
  rationale: "horário diferente",
});

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

  test("a turn where no source tool ran is not reviewed, logged or billed", async () => {
    const r = reviewer(VIOLATED);
    const f = flow();
    const gate = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("revise"),
      apiKey: "k",
      flow: f,
      makeModel: r.make,
    });
    expect(await gate?.review(turn("clima"))).toBeNull();
    expect(r.calls).toHaveLength(0);
    expect(await lines(f.turnId)).toEqual([]);
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

  test("a clean verdict changes nothing and writes no line", async () => {
    const f = flow();
    const reports: GuardrailReport[] = [];
    const gate = buildGroundingGate({
      langfuseCfg: null,
      cfg: cfg("revise"),
      apiKey: "k",
      flow: f,
      makeModel: reviewer('{"violated": false, "claims": [], "rationale": ""}')
        .make,
      announce: (rep) => {
        reports.push(rep);
      },
    });
    expect(await gate?.review(turn())).toBeNull();
    expect(reports.map((x) => x.outcome)).toEqual(["clean"]);
    expect(await lines(f.turnId)).toEqual([]);
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
});
