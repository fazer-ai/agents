import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { createAlertChannel } from "@/modules/flowlog/channels";
import { listExecutionLogs } from "@/modules/flowlog/read";
import { type FlowContext, writeFlowEvent } from "@/modules/flowlog/service";
import { GUARDRAIL_OBSERVED } from "@/modules/flowlog/stages";
import { buildExternalCheck } from "@/modules/guardrails/external";
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
import { outboundUrl } from "../utils/outbound";
import { guardrailModel } from "../utils/scripted-models";

// The `observe` action (issue #1640): the check runs and its verdict is recorded, and the
// conversation goes on as if it had passed. What it must never do is what the other four actions
// exist to do: replace, suppress, hand over, or post a note.

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

const CUSTOMER = "MARCADOR-CLIENTE-1640";
const RATIONALE = "a mensagem cita MARCADOR-CLIENTE-1640";
let tenantId = 0n;
let seq = 0;

const CHECKS = {
  toxicity: false,
  unsafeContent: true,
  competitorMentions: false,
  promptAdherence: false,
  answerRelevance: false,
};

function cfg(over: Partial<GuardrailsConfig> = {}): GuardrailsConfig {
  return {
    ...GUARDRAILS_DEFAULTS,
    enabled: true,
    input: {
      ...GUARDRAILS_DEFAULTS.input,
      enabled: true,
      checks: CHECKS,
      action: "observe",
    },
    output: {
      ...GUARDRAILS_DEFAULTS.output,
      enabled: true,
      checks: CHECKS,
      action: "observe",
    },
    ...over,
  };
}

function flow(): FlowContext {
  return {
    tenantId,
    turnId: `obs-${process.pid}-${++seq}`,
    source: "inbox",
    base: appDb,
  } as FlowContext;
}

async function lines(turnId: string) {
  const rows = await flowLogRows(suDb, {
    where: { tenantId, turnId, stage: "guardrail" },
    orderBy: { id: "asc" },
    select: { level: true, status: true, detail: true },
  });
  return rows.map((r) => ({
    level: r.level,
    status: r.status,
    detail: r.detail as Record<string, unknown>,
  }));
}

const trippingChat = (() =>
  guardrailModel(async () => ({
    content: JSON.stringify({
      violated: true,
      categories: ["unsafe_content"],
      rationale: RATIONALE,
    }),
  }))) as never;

const cleanChat = (() =>
  guardrailModel(async () => ({
    content: JSON.stringify({ violated: false, categories: [], rationale: "" }),
  }))) as never;

const failingChat = (() =>
  guardrailModel(async () => {
    throw new Error("The operation was aborted.");
  })) as never;

const trippingDecisions = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { questions: object };
  const answers: Record<string, unknown> = {};
  for (const name of Object.keys(body.questions))
    answers[name] = { type: "noul", noul: 0.99 };
  return new Response(
    JSON.stringify({ model: "jev-1", answers, usage: { input_tokens: 1 } }),
    { status: 200 },
  );
}) as unknown as typeof fetch;

describe("configuring it", () => {
  // The bug it catches: a reader that does not know the action falling back to `template`, which
  // would turn "only record" into "replace the message" for every agent that chose it.
  test("observe is read on both directions, and an unknown value still falls back", () => {
    const read = readGuardrailsConfig({
      guardrails: {
        input: { action: "observe" },
        output: { action: "observe" },
      },
    });
    expect(read.input.action).toBe("observe");
    expect(read.output.action).toBe("observe");
    const unknown = readGuardrailsConfig({
      guardrails: { input: { action: "shadow-xyz" } },
    });
    expect(unknown.input.action).toBe(GUARDRAILS_DEFAULTS.input.action);
  });
});

describe("the note sink", () => {
  // The bug it catches: an observed trip posting a private note, which is a change to the
  // conversation the action promises not to make.
  test("an observed trip posts nothing", async () => {
    const posted: string[] = [];
    const sink = chatwootNoteSink(
      {
        sendPrivateNote: async (_c: number, text: string) => {
          posted.push(text);
          return {} as never;
        },
      } as never,
      1,
    );
    await sink({
      direction: "input",
      outcome: "observed",
      action: "observe",
      categories: ["unsafe_content"],
      rationale: RATIONALE,
    });
    expect(posted).toEqual([]);
  });
});

describe.skipIf(!dbUp)("an observed screening", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Observe", slug: `observe-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const tbl of ["alert_deliveries", "alert_channels"])
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tenantId}`,
        );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // The bug it catches: the trip acting anyway, on either direction. The caller reads `clean` and
  // sends the subject; the report says the trip was observed so the trace and the playground can.
  test("a trip lets the subject through and reports it as observed, on both directions", async () => {
    for (const direction of ["input", "output"] as const) {
      const f = flow();
      const reports: GuardrailReport[] = [];
      const gate = buildGuardrailGate({
        langfuseCfg: null,
        cfg: cfg(),
        apiKey: "k",
        flow: f,
        makeModel: trippingChat,
        announce: (r) => {
          reports.push(r);
        },
      });
      expect(await gate(direction, CUSTOMER)).toEqual({ kind: "clean" });
      expect(reports).toEqual([
        {
          direction,
          outcome: "observed",
          action: "observe",
          categories: ["unsafe_content"],
          rationale: RATIONALE,
        },
      ]);
      const got = await lines(f.turnId);
      expect(got).toHaveLength(1);
      expect(got[0]?.level).toBe("warn");
      expect(got[0]?.detail.direction).toBe(direction);
      expect(got[0]?.detail.action).toBe("observe");
      expect(got[0]?.detail.categories).toEqual(["unsafe_content"]);
    }
  });

  // The bug it catches: the rationale, which quotes the customer, landing in the log row with
  // logToolValues off, or not reachable at all with it on (an observed trip has no note to carry it).
  test("the rationale reaches the line only with logToolValues on", async () => {
    const run = async (logValues: boolean) => {
      const f = flow();
      await buildGuardrailGate({
        langfuseCfg: null,
        cfg: cfg(),
        apiKey: "k",
        flow: f,
        makeModel: trippingChat,
        logValues,
      })("input", CUSTOMER);
      return (await lines(f.turnId))[0]?.detail ?? {};
    };
    const off = await run(false);
    expect(JSON.stringify(off)).not.toContain("MARCADOR-CLIENTE-1640");
    expect(off.rationaleChars).toBe(RATIONALE.length);
    const on = await run(true);
    expect(on.rationale).toBe(RATIONALE);
  });

  // The bug it catches: an approved message writing a trip line just because the action is observe.
  test("an approved message writes no line", async () => {
    const f = flow();
    const gate = buildGuardrailGate({
      langfuseCfg: null,
      cfg: cfg(),
      apiKey: "k",
      flow: f,
      makeModel: cleanChat,
    });
    expect(await gate("input", CUSTOMER)).toEqual({ kind: "clean" });
    expect(await lines(f.turnId)).toEqual([]);
  });

  // The bug it catches: `hold` handing the conversation over when the judge fails on a direction the
  // operator set to only record.
  // The line is the operator's record of it: a `held` line there would send them looking for a
  // hand-over that never happened.
  test("under hold, a screening that cannot judge on an observed direction still passes", async () => {
    const f = flow();
    const gate = buildGuardrailGate({
      langfuseCfg: null,
      cfg: cfg({ onFailure: "hold" }),
      apiKey: "k",
      flow: f,
      makeModel: failingChat,
    });
    expect(await gate("input", CUSTOMER)).toEqual({
      kind: "unavailable",
      modelRan: true,
    });
    const got = await lines(f.turnId);
    expect(got.map((l) => [l.detail.unchecked, l.detail.held ?? null])).toEqual(
      [[true, null]],
    );
  });

  // The bug it catches: the decisions classifier reaching the shared trip code by another path that
  // still acts.
  test("the decisions classifier observes the same way", async () => {
    const f = flow();
    const gate = buildGuardrailGate({
      langfuseCfg: null,
      cfg: cfg({ classifier: "decisions" }),
      apiKey: "k",
      flow: f,
      decisionFetch: trippingDecisions,
    });
    expect(await gate("output", CUSTOMER)).toEqual({ kind: "clean" });
    const got = await lines(f.turnId);
    expect(got.map((l) => l.detail.action)).toEqual(["observe"]);
  });

  // The bug it catches: the operator's external endpoint blocking a reply on a direction set to only
  // record, and the reply never going out.
  test("an external block on an observed reply lets the reply out", async () => {
    const f = flow();
    const check = buildExternalCheck({
      cfg: cfg({
        external: {
          ...GUARDRAILS_DEFAULTS.external,
          url: "https://example.invalid/check",
        },
      }),
      ctx: {
        tenantId,
        agentId: 2n,
        conversationId: 3n,
        chatwootConversationId: 4,
        turnId: f.turnId,
        customerMessage: "oi",
      },
      secret: null,
      flow: f,
      deps: {
        assertSafe: async (u) => new URL(u),
        fetchImpl: (async (_u: string, init: RequestInit) => {
          const b = JSON.parse(String(init.body)) as { candidateId: string };
          return new Response(
            JSON.stringify({ candidateId: b.candidateId, decision: "block" }),
          );
        }) as unknown as typeof fetch,
      },
    });
    const d = await check?.({
      text: "RESPOSTA",
      attachments: [],
      model: "primary",
      toolCalls: [],
    });
    expect(d).toEqual({ kind: "clean" });
    expect((await lines(f.turnId)).map((l) => l.detail.action)).toEqual([
      "observe",
    ]);
  });

  // The bug it catches: an endpoint that cannot answer holding a reply on a direction set to only
  // record. Holding is acting, so the failure passes unchecked there, as the built-in check's does.
  test("an external failure under hold lets an observed reply out", async () => {
    const f = flow();
    const check = buildExternalCheck({
      cfg: cfg({
        onFailure: "hold",
        external: {
          ...GUARDRAILS_DEFAULTS.external,
          url: "https://example.invalid/check",
        },
      }),
      ctx: {
        tenantId,
        agentId: 2n,
        conversationId: 3n,
        chatwootConversationId: 4,
        turnId: f.turnId,
        customerMessage: "oi",
      },
      secret: null,
      flow: f,
      deps: {
        assertSafe: async (u) => new URL(u),
        fetchImpl: (async () =>
          new Response("down", { status: 503 })) as unknown as typeof fetch,
      },
    });
    const d = await check?.({
      text: "RESPOSTA",
      attachments: [],
      model: "primary",
      toolCalls: [],
    });
    expect(d?.kind).not.toBe("handed-off");
    const got = await lines(f.turnId);
    expect(got.map((l) => l.detail.unchecked)).toEqual([true]);
  });

  // The bug it catches: an observed trip paging a channel that asked for acted trips only, or the
  // channel that asked for observed trips missing it. The delivery's stage stays `guardrail`.
  test("alert channels select observed and acted trips apart", async () => {
    const ctx: TenantContext = {
      tenantId,
      userId: null,
      role: "TENANT_ADMIN",
    };
    const observed = await createAlertChannel(
      ctx,
      {
        name: "obs",
        type: "discord",
        url: outboundUrl("/api/webhooks/1/obs"),
        minLevel: "warn",
        stages: [GUARDRAIL_OBSERVED],
      },
      appDb,
    );
    const acted = await createAlertChannel(
      ctx,
      {
        name: "act",
        type: "discord",
        url: outboundUrl("/api/webhooks/1/act"),
        minLevel: "warn",
        stages: ["guardrail"],
      },
      appDb,
    );
    const count = (id: string) =>
      suDb.alertDelivery.count({
        where: { tenantId, channelId: BigInt(id), stage: "guardrail" },
      });
    await writeFlowEvent(flow(), {
      stage: "guardrail",
      level: "warn",
      status: "ok",
      detail: { direction: "input", action: "observe" },
    });
    expect([await count(observed.id), await count(acted.id)]).toEqual([1, 0]);
    await writeFlowEvent(flow(), {
      stage: "guardrail",
      level: "warn",
      status: "ok",
      detail: { direction: "input", action: "handoff" },
    });
    expect([await count(observed.id), await count(acted.id)]).toEqual([1, 1]);
  });

  // The bug it catches: the Logs filter for observed trips returning acted trips, or the stage
  // filter for `guardrail` losing the observed ones.
  test("the logs filter for observed trips returns only them", async () => {
    const f1 = flow();
    const f2 = flow();
    await writeFlowEvent(f1, {
      stage: "guardrail",
      level: "warn",
      status: "ok",
      detail: { direction: "input", action: "observe" },
    });
    await writeFlowEvent(f2, {
      stage: "guardrail",
      level: "warn",
      status: "ok",
      detail: { direction: "input", action: "handoff" },
    });
    const ctx: TenantContext = {
      tenantId,
      userId: null,
      role: "TENANT_ADMIN",
    };
    const turns = async (stage: string) =>
      (await listExecutionLogs(ctx, { stage, limit: 200 }, appDb)).items
        .map((i) => i.turnId)
        .filter((t) => t === f1.turnId || t === f2.turnId);
    expect(await turns(GUARDRAIL_OBSERVED)).toEqual([f1.turnId]);
    expect((await turns("guardrail")).sort()).toEqual(
      [f1.turnId, f2.turnId].sort(),
    );
  });
});
