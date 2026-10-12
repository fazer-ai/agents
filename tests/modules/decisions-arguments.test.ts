import { describe, expect, test } from "bun:test";
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { buildCodeTool } from "@/graph/tools/code";
import { buildHttpTool } from "@/graph/tools/http";
import { adoptServerTool } from "@/graph/tools/mcp";
import { ruleStateKey } from "@/modules/decisions/config";
import { applyDecisions } from "@/modules/decisions/run";
import type { FillContext } from "@/modules/decisions/tool-args";

// THE CLASS, not one case: every way a rule's arguments can fail to fit its tool, asked of the three
// kinds of custom tool built the way the agent builds them. An argument that does not fit is never
// sent, spends no call of the budget (the rule after it still runs under `maxToolCalls: 1`) and
// holds no latch (agents#1223, decisions/arguments.ts).

const PUBLIC = "8.8.8.8";
const COMPACT = {
  motivo: { type: "string", required: true },
  telefone: { type: "string", required: true },
  prioridade: { type: "number" },
  canal: { type: "enum", enumValues: ["whatsapp", "email"] },
};
// What an MCP server declares: richer than the model's simplified declaration, which turns the
// nullable text below into `{}` and could not tell a number from text.
const SERVER = {
  type: "object",
  properties: {
    motivo: { type: "string" },
    telefone: { anyOf: [{ type: "string" }, { type: "null" }] },
    prioridade: { type: "number" },
    canal: { enum: ["whatsapp", "email"] },
    codigo: { $ref: "#/$defs/id" },
  },
  required: ["motivo", "telefone"],
  $defs: { id: { type: "string" } },
};

type Kind = "http" | "code" | "mcp";
function build(kind: Kind) {
  const sent: Record<string, unknown>[] = [];
  const name = kind === "mcp" ? "mcp__crm__abrir" : "abrir_ticket";
  if (kind === "http") {
    const tool = buildHttpTool(
      {
        name,
        method: "POST",
        urlTemplate: `https://${PUBLIC}/t`,
        allowedHosts: [PUBLIC],
        headers: {},
        inputSchema: COMPACT,
        credentialRef: null,
        body: {
          mode: "kv",
          rows: Object.keys(COMPACT).map((k) => ({
            key: k,
            value: `{{${k}}}`,
          })),
        },
      },
      {
        resolveCredential: async () => null,
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          sent.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
        context: {},
      },
    );
    return { tool, sent };
  }
  if (kind === "code") {
    const tool = buildCodeTool(
      { name, description: "x", inputSchema: COMPACT, code: "return input;" },
      {
        run: (async (_code: string, opts?: { call?: { input?: unknown } }) => {
          sent.push((opts?.call?.input ?? {}) as Record<string, unknown>);
          return { kind: "value", value: "ok", logs: [], ms: 1 };
        }) as never,
      },
    );
    return { tool, sent };
  }
  const tool = new DynamicStructuredTool({
    name,
    description: "x",
    schema: structuredClone(SERVER) as never,
    func: async (input) => {
      sent.push(input as Record<string, unknown>);
      return "ok";
    },
  });
  adoptServerTool(tool);
  return { tool: tool as unknown as StructuredToolInterface, sent };
}

const ctx: FillContext = {
  contact: { name: "Ana", phone: "+5511999990001" },
  contactAttributes: {},
  conversation: { display_id: 42 },
  conversationAttributes: {},
};
const when = [{ question: "q", minProbability: 0.5 }];
const answers = { q: { type: "yes_no" as const, probability: 0.9 } };

async function decide(
  kind: Kind,
  action: { args: Record<string, unknown>; fill?: Record<string, string> },
) {
  const { tool, sent } = build(kind);
  const after: string[] = [];
  const next = new DynamicStructuredTool({
    name: "avisar_slack",
    description: "x",
    schema: { type: "object" as const, properties: {} },
    func: async () => {
      after.push("ran");
      return "ok";
    },
  });
  const rule = { when, action: { tool: tool.name, ...action } };
  const r = await applyDecisions(
    {
      rules: [rule, { when, action: { tool: "avisar_slack", args: {} } }],
    },
    answers,
    [tool, next],
    [],
    new AbortController().signal,
    async () => true,
    1,
    undefined,
    false,
    new Set(),
    {},
    async () => true,
    { context: ctx, questions: [], logValues: true },
  );
  return { r, sent, after, key: ruleStateKey(rule) };
}

for (const kind of ["http", "code", "mcp"] as const) {
  describe(`a rule's arguments against a ${kind} tool`, () => {
    test("that fit are sent, a number into a text argument as its digits", async () => {
      const { r, sent, after, key } = await decide(kind, {
        args: { motivo: "cancelamento", canal: "email", prioridade: 2 },
        fill: { telefone: "conversation.display_id" },
      });
      expect(r.actions[0]?.outcome).toBe("ran");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.telefone).toBe("42");
      expect(r.triggerState.latch).toContain(key);
      // The one call of the budget was spent here.
      expect(after).toEqual([]);
    });

    for (const [why, action, failure] of [
      [
        "a required one the observation has no value for",
        { args: { motivo: "x" }, fill: { telefone: "contact.email" } },
        "missing_value",
      ],
      [
        "a fixed value of the wrong type",
        { args: { motivo: "x", telefone: "1", prioridade: "alta" } },
        "invalid_arguments",
      ],
      [
        "a value outside the allowed list",
        { args: { motivo: "x", telefone: "1", canal: "sms" } },
        "invalid_arguments",
      ],
      [
        "a required one left out",
        { args: { motivo: "x" } },
        "invalid_arguments",
      ],
    ] as const) {
      test(`${why} is not sent, spends no call and holds no latch`, async () => {
        const { r, sent, after, key } = await decide(kind, action);
        expect(sent).toEqual([]);
        expect(r.actions[0]).toMatchObject({ outcome: "failed", failure });
        expect(r.triggerState.latch).not.toContain(key);
        // The rule after it still had the call.
        expect(after).toEqual(["ran"]);
      });
    }
  });
}

// A text argument the server declares through a reference takes a filled number as its digits too.
test("an MCP argument declared through a $ref is fitted as the type it refers to", async () => {
  const { r, sent } = await decide("mcp", {
    args: { motivo: "x", telefone: "1" },
    fill: { codigo: "conversation.display_id" },
  });
  expect(r.actions[0]?.outcome).toBe("ran");
  expect(sent[0]?.codigo).toBe("42");
});
