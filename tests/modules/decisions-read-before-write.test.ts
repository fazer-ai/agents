import { describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { fenceReporterOf } from "@/graph/tools/fence-report";
import { buildNativeTools } from "@/graph/tools/native";
import {
  ChatwootClient,
  ChatwootExpiredError,
  sentNothing,
} from "@/modules/chatwoot/client";
import { type DecisionRule, ruleStateKey } from "@/modules/decisions/config";
import { applyDecisions, type DecisionProgress } from "@/modules/decisions/run";

// THE CLASS (docs/decisions.md, "When a rule acts"): every action a rule can run, in every scope,
// with the read it makes before its first write failing. Nothing was written, so the reservation the
// engine latched ahead is released and the rule tries again on the next hold. The contract that
// carries it is the Chatwoot client's `sentNothing`, not a check per action.

const when = [{ question: "q", minProbability: 0.5 }];
const answers = { q: { type: "yes_no" as const, probability: 0.9 } };

// Reads answer 503; any other request is recorded, and must never be reached.
function readsFail() {
  const writes: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") return new Response("unavailable", { status: 503 });
    writes.push(`${method} ${new URL(String(input)).pathname}`);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const client = new ChatwootClient(
    {
      baseUrl: "https://chat.example",
      accountId: 1,
      adminToken: "admin",
      botToken: "bot",
    },
    fetchImpl,
  );
  return { client, writes };
}

// The contact row the contact scope looks up; nothing here touches Postgres.
function contactDb(): PrismaClient {
  const tx = {
    $executeRaw: async () => 0,
    contact: { findUnique: async () => ({ chatwootContactId: 42 }) },
  };
  return {
    $extends: () => ({
      $transaction: (fn: (t: unknown) => unknown) => fn(tx),
    }),
  } as unknown as PrismaClient;
}

const kanban = {
  taskId: 11,
  boardId: 2,
  boardName: "Vendas",
  currentStepId: 7,
  currentStepName: "Novo",
  steps: [{ id: 7, name: "Novo" }],
  card: {
    title: "Lead",
    description: null,
    priority: null,
    status: "open",
    value: null,
    startDate: null,
    dueDate: null,
    attributes: {},
    labels: [],
  },
};

const actions: [string, DecisionRule["action"]][] = [
  [
    "set_labels on the conversation",
    { tool: "set_labels", args: { add: ["vip"] } },
  ],
  [
    "set_labels on the contact",
    { tool: "set_labels", args: { add: ["vip"], scope: "contact" } },
  ],
  [
    "set_labels on the card",
    { tool: "set_labels", args: { add: ["vip"], scope: "task" } },
  ],
  [
    "set_custom_attribute on the conversation",
    { tool: "set_custom_attribute", args: { key: "plano", value: "Pro" } },
  ],
  [
    "set_custom_attribute on the contact",
    {
      tool: "set_custom_attribute",
      args: { key: "plano", value: "Pro", scope: "contact" },
    },
  ],
  [
    "set_custom_attribute on the card",
    {
      tool: "set_custom_attribute",
      args: { key: "plano", value: "Pro", scope: "task" },
    },
  ],
];

describe("an action whose read before its first write fails", () => {
  for (const [name, action] of actions) {
    test(`${name}: nothing is written and the reservation is released`, async () => {
      const { client, writes } = readsFail();
      const tools = buildNativeTools({
        client,
        conversationId: 7,
        base: contactDb(),
        tenantId: 1n,
        contactDbId: 5n,
        kanban,
      });
      const rule: DecisionRule = { when, action, trigger: "once" };
      const progress: DecisionProgress = {};
      const ahead: string[] = [];
      const r = await applyDecisions(
        { rules: [rule] },
        answers,
        tools,
        [],
        new AbortController().signal,
        async () => true,
        10,
        () => null,
        false,
        new Set(),
        progress,
        async (keys) => {
          ahead.push(...keys);
          return true;
        },
      );
      expect(writes).toEqual([]);
      expect(ahead).toEqual([ruleStateKey(rule)]);
      expect(r.triggerState.latch).toEqual([]);
      expect(r.triggerState.undo).toEqual([ruleStateKey(rule)]);
    });
  }

  // The class is closed: the other actions a rule can run write first, so they have no read before
  // the write that could fail.
  test("private_note and handoff_to_human have no read before their first write", async () => {
    for (const action of [
      { tool: "private_note", args: { content: "nota" } },
      {
        tool: "handoff_to_human",
        args: { reason: "pediu", customerMessage: "" },
      },
    ] as DecisionRule["action"][]) {
      const { client, writes } = readsFail();
      const tools = buildNativeTools({ client, conversationId: 7 });
      await applyDecisions(
        { rules: [{ when, action }] },
        answers,
        tools,
        [],
        new AbortController().signal,
        async () => true,
        10,
      );
      expect(writes[0]).toBe(
        "POST /api/v1/accounts/1/conversations/7/messages",
      );
    }
  });
});

describe("the client's sentNothing contract", () => {
  test("a failed read sent nothing; a failed write may have landed", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const client = new ChatwootClient(
      {
        baseUrl: "https://chat.example",
        accountId: 1,
        adminToken: "admin",
        botToken: "bot",
      },
      fetchImpl,
    );
    const read = await client.getConversationLabels(7).catch((e) => e);
    const write = await client.setConversationLabels(7, ["x"]).catch((e) => e);
    expect(sentNothing(read)).toBe(true);
    expect(sentNothing(write)).toBe(false);
  });

  test("an error that sent nothing after a write the call reported keeps the rule latched", async () => {
    const rule: DecisionRule = {
      when,
      action: { tool: "handoff_to_human", args: {} },
      trigger: "once",
    };
    const r = await applyDecisions(
      { rules: [rule] },
      answers,
      [
        new DynamicStructuredTool({
          name: "handoff_to_human",
          description: "handoff",
          schema: z.object({}).passthrough(),
          func: async (_args, _run, config) => {
            fenceReporterOf(config)?.({ committed: true });
            throw new ChatwootExpiredError("POST toggle_status");
          },
        }),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
    );
    expect(r.triggerState.latch).toEqual([ruleStateKey(rule)]);
    expect(r.triggerState.undo).toEqual([]);
  });

  test("the same at the deadline: the write the call reported keeps the rule latched", async () => {
    const controller = new AbortController();
    const progress: DecisionProgress = {};
    const rule: DecisionRule = {
      when,
      action: { tool: "handoff_to_human", args: {} },
      trigger: "once",
    };
    await expect(
      applyDecisions(
        { rules: [rule] },
        answers,
        [
          new DynamicStructuredTool({
            name: "handoff_to_human",
            description: "handoff",
            schema: z.object({}).passthrough(),
            func: async (_args, _run, config) => {
              fenceReporterOf(config)?.({ committed: true });
              controller.abort(new Error("deadline"));
              throw new ChatwootExpiredError("POST toggle_status");
            },
          }),
        ],
        [],
        controller.signal,
        async () => true,
        10,
        () => null,
        false,
        new Set(),
        progress,
      ),
    ).rejects.toThrow();
    expect(progress.undo).toEqual([]);
  });
});
