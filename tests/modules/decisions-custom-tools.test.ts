import { describe, expect, test } from "bun:test";
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { ASKS_WAIT_MESSAGE } from "@/graph/tools/http";
import { adoptServerTool } from "@/graph/tools/mcp";
import { AppError } from "@/lib/errors";
import type { ScopedDb } from "@/lib/tenancy";
import {
  assertDecisionActionArgs,
  DecisionToolUnknownError,
} from "@/modules/agents/service";
import { renameDecisionActionTools } from "@/modules/agents/transfer";
import {
  type DecisionQuestion,
  decisionsIssues,
  projectDecisionsBlock,
  readDecisionsConfig,
  ruleStateKey,
  triggerOf,
} from "@/modules/decisions/config";
import { applyDecisions } from "@/modules/decisions/run";
import {
  actionArgIssues,
  argSpecsFrom,
  type FillContext,
} from "@/modules/decisions/tool-args";
import { attributeFillsOf } from "@/modules/observe/job";

// A decisions rule calling one of the tenant's own tools (agents#1223): the arguments are fixed or
// filled from what the observation knows, checked against the tool's schema when the rule is saved,
// and the call is recorded with what it was given.

const questions: DecisionQuestion[] = [
  { name: "quer_cancelar", type: "yes_no", instructions: "x" },
  {
    name: "assunto",
    type: "choice",
    instructions: "x",
    options: [
      { value: "pedido", description: "x" },
      { value: "outro", description: "x" },
    ],
  },
  {
    name: "irritacao",
    type: "score",
    instructions: "x",
    levels: [
      { value: "calmo", description: "x" },
      { value: "irritado", description: "x" },
      { value: "muito_irritado", description: "x" },
    ],
  },
];

const block = (action: Record<string, unknown>) => ({
  provider: "typesafe",
  credentialRef: "vault:1",
  questions,
  rules: [
    { when: [{ question: "quer_cancelar", minProbability: 0.7 }], action },
  ],
});

describe("the block names a custom tool and fills its arguments", () => {
  test("an argument named like an object's own member is the rule's, not inherited", () => {
    expect(
      decisionsIssues(
        block({
          tool: "abrir_ticket",
          args: {},
          fill: { constructor: "contact.name" },
        }),
      ),
    ).toEqual([]);
    expect(
      actionArgIssues({ args: {}, fill: {} }, [
        { name: "toString", type: "string", required: true },
      ]),
    ).toEqual([{ arg: "toString", in: "args", code: "arg_required" }]);
  });

  test("a custom tool with fixed and filled arguments saves, and defaults to acting when it starts holding", () => {
    const b = block({
      tool: "abrir_ticket",
      args: { motivo: "cancelamento" },
      fill: { telefone: "contact.phone", nivel: "answer.irritacao.level" },
    });
    expect(decisionsIssues(b)).toEqual([]);
    const read = readDecisionsConfig({ decisions: b });
    if (!read.ok) throw new Error(read.problem);
    const rule = read.config.rules[0];
    expect(rule?.action.fill).toEqual({
      telefone: "contact.phone",
      nivel: "answer.irritacao.level",
    });
    if (!rule) throw new Error("no rule");
    expect(triggerOf(rule)).toBe("on_start");
    // The fill travels on every rewrite of the block (the MCP merge, the audit projection).
    const projected = projectDecisionsBlock(b) as {
      rules: { action: Record<string, unknown> }[];
    };
    expect(projected.rules[0]?.action.fill).toEqual({
      telefone: "contact.phone",
      nivel: "answer.irritacao.level",
    });
  });

  test("a filled argument is part of what the rule is: a different source is a different rule", () => {
    const one = readDecisionsConfig({
      decisions: block({
        tool: "abrir_ticket",
        args: {},
        fill: { telefone: "contact.phone" },
      }),
    });
    const two = readDecisionsConfig({
      decisions: block({
        tool: "abrir_ticket",
        args: {},
        fill: { telefone: "contact.email" },
      }),
    });
    if (!one.ok || !two.ok) throw new Error("unreadable");
    const [a] = one.config.rules;
    const [b] = two.config.rules;
    if (!a || !b) throw new Error("no rule");
    expect(ruleStateKey(a)).not.toBe(ruleStateKey(b));
  });

  test("what the block gets wrong about a fill is named at the argument", () => {
    const codes = (action: Record<string, unknown>) =>
      decisionsIssues(block(action)).map((i) => [i.code, i.path.join(".")]);
    expect(
      codes({
        tool: "private_note",
        args: { content: "x" },
        fill: { content: "contact.name" },
      }),
    ).toEqual([["fill_on_native", "rules.0.action.fill"]]);
    expect(
      codes({
        tool: "abrir_ticket",
        args: {},
        fill: { telefone: "contact.cpf" },
      }),
    ).toEqual([["unknown_field_source", "rules.0.action.fill.telefone"]]);
    expect(
      codes({
        tool: "abrir_ticket",
        args: {},
        fill: { nivel: "answer.quer_cancelar.level" },
      }),
    ).toEqual([["fill_question_type", "rules.0.action.fill.nivel"]]);
    expect(
      codes({
        tool: "abrir_ticket",
        args: {},
        fill: { nivel: "answer.sumiu.choice" },
      }),
    ).toEqual([["unknown_question", "rules.0.action.fill.nivel"]]);
    expect(
      codes({
        tool: "abrir_ticket",
        args: { telefone: "1" },
        fill: { telefone: "contact.phone" },
      }),
    ).toEqual([["arg_twice", "rules.0.action.fill.telefone"]]);
  });
});

const ticketSchema = {
  motivo: { type: "string", required: true },
  telefone: { type: "string", required: true },
  prioridade: { type: "number" },
};

describe("an action's arguments against its tool's schema", () => {
  const specs = argSpecsFrom(ticketSchema);

  test("a required argument with no value, a fixed value of the wrong type, a source of the wrong type, an argument the tool lacks", () => {
    expect(
      actionArgIssues({ args: { motivo: "cancelamento" } }, specs),
    ).toEqual([{ arg: "telefone", in: "args", code: "arg_required" }]);
    expect(
      actionArgIssues(
        {
          args: { motivo: "cancelamento", prioridade: "alta" },
          fill: { telefone: "contact.phone" },
        },
        specs,
      ),
    ).toEqual([{ arg: "prioridade", in: "args", code: "arg_type" }]);
    expect(
      actionArgIssues(
        {
          args: { motivo: "cancelamento" },
          fill: { telefone: "contact.phone", prioridade: "contact.name" },
        },
        specs,
      ),
    ).toEqual([{ arg: "prioridade", in: "fill", code: "arg_source_type" }]);
    expect(
      actionArgIssues(
        {
          args: { motivo: "cancelamento", extra: 1 },
          fill: { telefone: "contact.phone" },
        },
        specs,
      ),
    ).toEqual([{ arg: "extra", in: "args", code: "arg_unknown" }]);
    // A number fills a number argument, and a text one as its digits.
    expect(
      actionArgIssues(
        {
          args: { motivo: "cancelamento" },
          fill: {
            telefone: "conversation.display_id",
            prioridade: "answer.irritacao.level_index",
          },
        },
        specs,
      ),
    ).toEqual([]);
  });

  test("standard JSON Schema reads as the compact map does", () => {
    expect(
      argSpecsFrom({
        type: "object",
        properties: { pedido: { type: "string" }, n: { type: "integer" } },
        required: ["pedido"],
      }).map((s) => [s.name, s.type, s.required]),
    ).toEqual([
      ["pedido", "string", true],
      ["n", "integer", false],
    ]);
  });
});

function fakeDb(rows: { name: string; inputSchema: unknown }[]): ScopedDb {
  const findMany = async () => rows;
  return {
    toolDefinition: { findMany },
    codeToolDefinition: { findMany: async () => [] },
  } as unknown as ScopedDb;
}

const settingsWith = (action: Record<string, unknown>) => ({
  monitoring: { engine: "decisions", decisions: block(action) },
});

describe("the write boundary asks the tenant's tool", () => {
  const db = fakeDb([{ name: "abrir_ticket", inputSchema: ticketSchema }]);

  test("a required argument left without a value is refused, naming it at its field", async () => {
    const err = await assertDecisionActionArgs(
      db,
      settingsWith({ tool: "abrir_ticket", args: { motivo: "cancelamento" } }),
      undefined,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    expect(e.statusCode).toBe(400);
    expect(e.message).toContain('"telefone"');
    expect(e.field).toBe("monitoring.decisions.rules.0.action.args.telefone");
  });

  test("a fixed value of another type than the schema's is refused, naming the argument", async () => {
    const err = await assertDecisionActionArgs(
      db,
      settingsWith({
        tool: "abrir_ticket",
        args: { motivo: "cancelamento", prioridade: "alta" },
        fill: { telefone: "contact.phone" },
      }),
      undefined,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).field).toBe(
      "monitoring.decisions.rules.0.action.args.prioridade",
    );
  });

  test("a tool the tenant has no such name for is refused; a complete action, an unchanged one and an MCP tool are not", async () => {
    await expect(
      assertDecisionActionArgs(
        db,
        settingsWith({ tool: "sumiu", args: {} }),
        undefined,
      ),
    ).rejects.toBeInstanceOf(DecisionToolUnknownError);
    const ok = {
      tool: "abrir_ticket",
      args: { motivo: "cancelamento" },
      fill: { telefone: "contact.phone" },
    };
    await assertDecisionActionArgs(db, settingsWith(ok), undefined);
    // The tool's schema changed after the rule was saved: an unrelated save is not refused.
    const stale = { tool: "abrir_ticket", args: { motivo: "x" } };
    await assertDecisionActionArgs(
      db,
      settingsWith(stale),
      settingsWith(stale),
    );
    await assertDecisionActionArgs(
      db,
      settingsWith({ tool: "mcp__crm__abrir", args: {} }),
      undefined,
    );
  });
});

const ctx: FillContext = {
  contact: { name: "Ana", phone: "+5511999990001" },
  contactAttributes: {},
  conversation: {
    display_id: 42,
    inbox_id: 7,
    link: "https://cw/app/accounts/1/conversations/42",
  },
  conversationAttributes: { numero_pedido: "PED-778" },
};

function customTool(
  name: string,
  schema: z.ZodObject<z.ZodRawShape>,
  seen: Record<string, unknown>[],
) {
  return new DynamicStructuredTool({
    name,
    description: name,
    schema,
    func: async (input) => {
      seen.push(input as Record<string, unknown>);
      return "ok";
    },
  });
}

describe("the tick fills a custom tool's arguments and records them", () => {
  const answers = {
    quer_cancelar: { type: "yes_no" as const, probability: 0.9 },
    // A mean of the level indices, as the providers answer: the nearest level is the one filled.
    irritacao: {
      type: "score" as const,
      score: 1.99,
      confidence: 0.9,
      probabilities: {},
    },
  };
  const when = [{ question: "quer_cancelar", minProbability: 0.7 }];
  const schema = z.object({
    pedido: z.string(),
    nivel: z.string(),
    conversa: z.number(),
    telefone: z.string(),
    link: z.string().optional(),
  });
  const rule = {
    when,
    action: {
      tool: "registrar_caso",
      args: {},
      fill: {
        pedido: "conversation.attribute.numero_pedido",
        nivel: "answer.irritacao.level",
        conversa: "conversation.display_id",
        telefone: "contact.phone",
      },
    },
  };

  for (const logValues of [true, false]) {
    test(`the call gets the observation's values, and the line records them ${logValues ? "as values" : "by source"}`, async () => {
      const seen: Record<string, unknown>[] = [];
      const r = await applyDecisions(
        { rules: [rule] },
        answers,
        [customTool("registrar_caso", schema, seen)],
        [],
        new AbortController().signal,
        async () => true,
        10,
        undefined,
        false,
        new Set(),
        {},
        async () => true,
        { context: ctx, questions, logValues },
      );
      expect(seen).toEqual([
        {
          pedido: "PED-778",
          nivel: "muito_irritado",
          conversa: 42,
          telefone: "+5511999990001",
        },
      ]);
      expect(r.actions).toHaveLength(1);
      expect(r.actions[0]?.outcome).toBe("ran");
      expect(r.actions[0]?.args).toEqual(
        logValues
          ? {
              pedido: "PED-778",
              nivel: "muito_irritado",
              conversa: 42,
              telefone: "+5511999990001",
            }
          : {
              pedido: { from: "conversation.attribute.numero_pedido" },
              nivel: { from: "answer.irritacao.level" },
              conversa: { from: "conversation.display_id" },
              telefone: { from: "contact.phone" },
            },
      );
      expect(JSON.stringify(r.actions).includes("+5511999990001")).toBe(
        logValues,
      );
      expect(r.triggerState.latch).toEqual([ruleStateKey(rule)]);
    });
  }

  test("a number goes into a text argument as its digits", async () => {
    const seen: Record<string, unknown>[] = [];
    await applyDecisions(
      {
        rules: [
          {
            when,
            action: {
              tool: "abrir_ticket",
              args: { motivo: "cancelamento" },
              fill: { telefone: "conversation.display_id" },
            },
          },
        ],
      },
      answers,
      [
        customTool(
          "abrir_ticket",
          z.object({ motivo: z.string(), telefone: z.string() }),
          seen,
        ),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
      undefined,
      false,
      new Set(),
      {},
      async () => true,
      { context: ctx, questions, logValues: true },
    );
    expect(seen).toEqual([{ motivo: "cancelamento", telefone: "42" }]);
  });

  test("a field the observation has no value for keeps a tool that needs it from being called, and leaves the rule free to act later", async () => {
    const seen: Record<string, unknown>[] = [];
    const missingRule = {
      when,
      action: {
        tool: "abrir_ticket",
        args: { motivo: "cancelamento" },
        fill: { telefone: "contact.email" },
      },
    };
    const r = await applyDecisions(
      { rules: [missingRule] },
      answers,
      [
        customTool(
          "abrir_ticket",
          z.object({ motivo: z.string(), telefone: z.string() }),
          seen,
        ),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
      undefined,
      false,
      new Set(),
      {},
      async () => true,
      { context: ctx, questions, logValues: true },
    );
    expect(seen).toEqual([]);
    expect(r.actions[0]).toMatchObject({
      outcome: "failed",
      failure: "missing_value",
      missing: ["telefone"],
    });
    expect(r.triggerState.latch).toEqual([]);
  });

  test("an optional argument with no value is left out of the call", async () => {
    const seen: Record<string, unknown>[] = [];
    await applyDecisions(
      {
        rules: [
          {
            when,
            action: {
              tool: "abrir_ticket",
              args: { motivo: "cancelamento" },
              fill: { email: "contact.email" },
            },
          },
        ],
      },
      answers,
      [
        customTool(
          "abrir_ticket",
          z.object({ motivo: z.string(), email: z.string().optional() }),
          seen,
        ),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
      undefined,
      false,
      new Set(),
      {},
      async () => true,
      { context: ctx, questions, logValues: true },
    );
    expect(seen).toEqual([{ motivo: "cancelamento" }]);
  });

  test("two rules on the same tool filled from different fields are two calls, not one", async () => {
    const seen: Record<string, unknown>[] = [];
    const action = (from: string) => ({
      when,
      action: {
        tool: "abrir_ticket",
        args: { motivo: "cancelamento" },
        fill: { telefone: from },
      },
    });
    const r = await applyDecisions(
      { rules: [action("contact.phone"), action("conversation.link")] },
      answers,
      [
        customTool(
          "abrir_ticket",
          z.object({ motivo: z.string(), telefone: z.string() }),
          seen,
        ),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
      undefined,
      false,
      new Set(),
      {},
      async () => true,
      { context: ctx, questions, logValues: true },
    );
    expect(seen.map((s) => s.telefone)).toEqual([
      "+5511999990001",
      "https://cw/app/accounts/1/conversations/42",
    ]);
    expect(r.actions.map((a) => a.merged)).toEqual([undefined, undefined]);
  });

  const once = (tool: StructuredToolInterface, fill: Record<string, string>) =>
    applyDecisions(
      {
        rules: [
          {
            when,
            action: { tool: tool.name, args: { motivo: "cancelamento" }, fill },
          },
        ],
      },
      answers,
      [tool],
      [],
      new AbortController().signal,
      async () => true,
      10,
      undefined,
      false,
      new Set(),
      {},
      async () => true,
      { context: ctx, questions, logValues: true },
    );

  test("an MCP tool's JSON Schema fits a number into a text argument as well", async () => {
    const seen: Record<string, unknown>[] = [];
    const tool = new DynamicStructuredTool({
      name: "mcp__crm__abrir",
      description: "x",
      schema: {
        type: "object",
        properties: {
          motivo: { type: "string" },
          telefone: { type: "string" },
        },
        required: ["motivo", "telefone"],
      },
      func: async (input) => {
        seen.push(input as Record<string, unknown>);
        return "ok";
      },
    });
    await once(tool as unknown as StructuredToolInterface, {
      telefone: "conversation.display_id",
    });
    expect(seen).toEqual([{ motivo: "cancelamento", telefone: "42" }]);
  });

  test("a tool that asks the model for a holding message runs from a rule, which writes none", async () => {
    const seen: Record<string, unknown>[] = [];
    const tool = customTool(
      "abrir_ticket",
      z.object({
        motivo: z.string(),
        telefone: z.string(),
        __wait_message: z.string().min(1),
      }),
      seen,
    );
    // As buildHttpTool marks a tool built with an acknowledgement.
    (tool as { [ASKS_WAIT_MESSAGE]?: true })[ASKS_WAIT_MESSAGE] = true;
    const r = await once(tool as unknown as StructuredToolInterface, {
      telefone: "contact.phone",
    });
    expect(r.actions[0]?.outcome).toBe("ran");
    expect(seen[0]?.telefone).toBe("+5511999990001");
  });

  test("a rule written fixed and one filled with the same value are one call", async () => {
    const seen: Record<string, unknown>[] = [];
    const tool = customTool(
      "abrir_ticket",
      z.object({ motivo: z.string(), telefone: z.string() }),
      seen,
    );
    const fixed = {
      when,
      action: {
        tool: "abrir_ticket",
        args: { motivo: "cancelamento", telefone: "+5511999990001" },
      },
    };
    const filled = {
      when,
      action: {
        tool: "abrir_ticket",
        args: { motivo: "cancelamento" },
        fill: { telefone: "contact.phone" },
      },
    };
    const r = await applyDecisions(
      { rules: [fixed, filled] },
      answers,
      [tool],
      [],
      new AbortController().signal,
      async () => true,
      10,
      undefined,
      false,
      new Set(),
      {},
      async () => true,
      { context: ctx, questions, logValues: true },
    );
    expect(seen).toHaveLength(1);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]?.merged).toEqual([1]);
    expect(r.triggerState.latch.sort()).toEqual(
      [ruleStateKey(fixed), ruleStateKey(filled)].sort(),
    );
  });

  test("a nullable text argument of a JSON Schema takes a number as its digits", async () => {
    const seen: Record<string, unknown>[] = [];
    const tool = new DynamicStructuredTool({
      name: "mcp__crm__abrir",
      description: "x",
      schema: {
        type: "object",
        properties: {
          motivo: { type: "string" },
          telefone: { type: ["string", "null"] },
        },
      },
      func: async (input) => {
        seen.push(input as Record<string, unknown>);
        return "ok";
      },
    });
    await once(tool as unknown as StructuredToolInterface, {
      telefone: "conversation.display_id",
    });
    expect(seen[0]?.telefone).toBe("42");
  });

  test("an MCP call its adapter refuses for its arguments sent nothing, and leaves the rule free", async () => {
    const refusal = Object.assign(
      new Error('Invalid arguments for MCP tool "abrir"'),
      { name: "ToolException", cause: { name: "ZodError" } },
    );
    const tool = new DynamicStructuredTool({
      name: "mcp__crm__abrir",
      description: "x",
      schema: z.object({}).passthrough(),
      func: async () => {
        throw refusal;
      },
    });
    const r = await once(tool, { telefone: "contact.phone" });
    expect(r.actions[0]).toMatchObject({
      outcome: "failed",
      failure: "invalid_arguments",
    });
    expect(r.triggerState.latch).toEqual([]);
  });

  test("an MCP response the SDK cannot parse was sent, and keeps the rule latched", async () => {
    const malformed = Object.assign(
      new Error("Error calling tool abrir: ZodError: invalid response"),
      { name: "ToolException", cause: { name: "ZodError" } },
    );
    const tool = new DynamicStructuredTool({
      name: "mcp__crm__abrir",
      description: "x",
      schema: z.object({}).passthrough(),
      func: async () => {
        throw malformed;
      },
    });
    const r = await once(tool, { telefone: "contact.phone" });
    expect(r.actions[0]).toMatchObject({
      outcome: "failed",
      failure: "tool_error",
    });
    expect(r.triggerState.latch).toHaveLength(1);
  });

  test("a custom tool that answers with a failure (an HTTP 503) is failed, not ran", async () => {
    const tool = failableTool(async () => toolFailure("HTTP 503"), {
      name: "abrir_ticket",
      description: "x",
      schema: z.object({ motivo: z.string(), telefone: z.string() }),
    });
    const r = await once(tool, { telefone: "contact.phone" });
    expect(r.actions[0]).toMatchObject({
      outcome: "failed",
      failure: "tool_error",
    });
    // It may have reached the other side: the rule stays latched.
    expect(r.triggerState.latch).toHaveLength(1);
  });

  test("a fixed value its tool's schema refuses fails the action and leaves the rule free", async () => {
    const seen: Record<string, unknown>[] = [];
    const tool = customTool(
      "abrir_ticket",
      z.object({ motivo: z.number(), telefone: z.string() }),
      seen,
    );
    const r = await once(tool, { telefone: "contact.phone" });
    expect(seen).toEqual([]);
    expect(r.actions[0]).toMatchObject({
      outcome: "failed",
      failure: "invalid_arguments",
    });
    expect(r.triggerState.latch).toEqual([]);
  });

  // What the adapter checks is the server's schema, kept beside the simplified declaration.
  const mcpTool = (
    server: Record<string, unknown>,
    seen: Record<string, unknown>[],
    name = "mcp__crm__abrir",
  ) => {
    const tool = new DynamicStructuredTool({
      name,
      description: "x",
      schema: server,
      func: async (input) => {
        seen.push(input as Record<string, unknown>);
        return "ok";
      },
    });
    adoptServerTool(tool);
    return tool as unknown as StructuredToolInterface;
  };

  test("a number fits an anyOf text argument of the server's schema as its digits", async () => {
    const seen: Record<string, unknown>[] = [];
    await once(
      mcpTool(
        {
          type: "object",
          properties: {
            motivo: { type: "string" },
            telefone: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
        seen,
      ),
      { telefone: "conversation.display_id" },
    );
    expect(seen[0]?.telefone).toBe("42");
  });

  test("an MCP argument the server requires and the observation lacks is not called and spends no budget", async () => {
    const seen: Record<string, unknown>[] = [];
    const lacking = mcpTool(
      {
        type: "object",
        properties: { motivo: { type: "string" }, email: { type: "string" } },
        required: ["motivo", "email"],
      },
      seen,
    );
    const other = customTool(
      "avisar_slack",
      z.object({ texto: z.string() }),
      seen,
    );
    const r = await applyDecisions(
      {
        rules: [
          {
            when,
            action: {
              tool: "mcp__crm__abrir",
              args: { motivo: "x" },
              fill: { email: "contact.email" },
            },
          },
          { when, action: { tool: "avisar_slack", args: { texto: "oi" } } },
        ],
      },
      answers,
      [lacking, other],
      [],
      new AbortController().signal,
      async () => true,
      1,
      undefined,
      false,
      new Set(),
      {},
      async () => true,
      { context: ctx, questions, logValues: true },
    );
    expect(r.actions.map((a) => [a.tool, a.outcome])).toEqual([
      ["mcp__crm__abrir", "failed"],
      ["avisar_slack", "ran"],
    ]);
    expect(r.actions[0]?.failure).toBe("missing_value");
    expect(seen).toEqual([{ texto: "oi" }]);
  });

  test("a custom tool the agent was not granted reports not_granted and calls nothing", async () => {
    const r = await applyDecisions(
      { rules: [rule] },
      answers,
      [],
      [],
      new AbortController().signal,
      async () => true,
      10,
      undefined,
      false,
      new Set(),
      {},
      async () => true,
      { context: ctx, questions, logValues: true },
    );
    expect(r.actions).toEqual([
      { rule: 0, tool: "registrar_caso", outcome: "not_granted" },
    ]);
  });

  test("once it acted, a custom tool is held while the rule keeps holding", async () => {
    const seen: Record<string, unknown>[] = [];
    const r = await applyDecisions(
      { rules: [rule] },
      answers,
      [customTool("registrar_caso", schema, seen)],
      [],
      new AbortController().signal,
      async () => true,
      10,
      undefined,
      false,
      new Set([ruleStateKey(rule)]),
      {},
      async () => true,
      { context: ctx, questions, logValues: true },
    );
    expect(seen).toEqual([]);
    expect(r.held).toEqual([{ rule: 0, trigger: "on_start" }]);
  });
});

// A bundled tool the import stores under another name (a code tool already holds it) takes its
// rules with it, or they would name a tool the restored agent was not granted.
describe("an imported rule on a renamed tool", () => {
  test("follows the tool to its stored name; other rules are left as they are", () => {
    const bag = {
      monitoring: {
        engine: "decisions",
        decisions: {
          rules: [
            { when: [], action: { tool: "lookup", args: {} } },
            { when: [], action: { tool: "set_labels", args: { add: ["x"] } } },
          ],
        },
      },
    };
    // A bundled custom tool named after a native is stored under another name; the native's own
    // rules keep naming the native.
    const out = renameDecisionActionTools(
      bag,
      new Map([
        ["Lookup", "lookup_2"],
        ["set_labels", "set_labels_2"],
      ]),
    );
    const rules = (
      (out.monitoring as Record<string, unknown>).decisions as {
        rules: { action: { tool: string } }[];
      }
    ).rules;
    expect(rules.map((r) => r.action.tool)).toEqual(["lookup_2", "set_labels"]);
  });
});

// The attribute bags are unbounded: the observation reads one only when a rule fills from it.
describe("the attribute bags an observation reads", () => {
  test("only those a decisions rule fills an argument from", () => {
    const rules = (fill: Record<string, string>) => ({
      engine: "decisions",
      decisions: {
        rules: [{ action: { tool: "abrir_ticket", args: {}, fill } }],
      },
    });
    expect(attributeFillsOf({ engine: "llm" })).toEqual({
      conversation: false,
      contact: false,
    });
    expect(attributeFillsOf(rules({ telefone: "contact.phone" }))).toEqual({
      conversation: false,
      contact: false,
    });
    expect(
      attributeFillsOf(
        rules({ pedido: "conversation.attribute.numero_pedido" }),
      ),
    ).toEqual({ conversation: true, contact: false });
    expect(attributeFillsOf(rules({ cpf: "contact.attribute.cpf" }))).toEqual({
      conversation: false,
      contact: true,
    });
  });
});

// An action an API wrote without `args` is the same action the console writes back with `args: {}`.
test("an untouched action written back with an empty args is not asked again", async () => {
  const db = fakeDb([]);
  const apiWritten = { tool: "sumiu", fill: { telefone: "contact.phone" } };
  await assertDecisionActionArgs(
    db,
    settingsWith({ ...apiWritten, args: {} }),
    settingsWith(apiWritten),
  );
});
