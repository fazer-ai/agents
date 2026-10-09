import { describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { applyDecisions } from "@/modules/decisions/run";

// The tick's deadline inside `applyDecisions`, without the observation's fence (here always still
// wanted), so each of the two checks is the only thing that can stop the next rule.

const when = [{ question: "q", minProbability: 0.5 }];
const answers = { q: { type: "yes_no" as const, probability: 0.9 } };

function tools(first: (c: AbortController) => Promise<string>) {
  const ran: string[] = [];
  const controller = new AbortController();
  const make = (name: string, fn: () => Promise<string>) =>
    new DynamicStructuredTool({
      name,
      description: name,
      schema: z.object({}).passthrough(),
      func: async () => {
        ran.push(name);
        return fn();
      },
    });
  return {
    ran,
    controller,
    list: [
      make("private_note", () => first(controller)),
      make("set_labels", async () => "ok"),
    ],
  };
}

const config = {
  apply: "enforce" as const,
  rules: [
    { when, action: { tool: "private_note" as const, args: {} } },
    { when, action: { tool: "set_labels" as const, args: {} } },
  ],
};

describe("applyDecisions under the tick's deadline", () => {
  test("a deadline that passes during an action stops the next rule's action", async () => {
    const t = tools(async (c) => {
      c.abort(new Error("deadline"));
      return "ok";
    });
    await expect(
      applyDecisions(
        config,
        answers,
        t.list,
        [],
        t.controller.signal,
        async () => true,
        10,
      ),
    ).rejects.toThrow();
    expect(t.ran).toEqual(["private_note"]);
  });

  test("a deadline that fires while the fence is read starts no action", async () => {
    const t = tools(async () => "ok");
    await expect(
      applyDecisions(
        config,
        answers,
        t.list,
        [],
        t.controller.signal,
        async () => {
          t.controller.abort(new Error("deadline"));
          return true;
        },
        10,
      ),
    ).rejects.toThrow();
    expect(t.ran).toEqual([]);
  });

  // The last rule: no later iteration is left to notice the deadline.
  test("an action cancelled by the deadline ends the run instead of reading as that tool's failure", async () => {
    const t = tools(async (c) => {
      c.abort(new Error("deadline"));
      throw new Error("aborted");
    });
    await expect(
      applyDecisions(
        { ...config, rules: config.rules.slice(0, 1) },
        answers,
        t.list,
        [],
        t.controller.signal,
        async () => true,
        10,
      ),
    ).rejects.toThrow();
    expect(t.ran).toEqual(["private_note"]);
  });
});

describe("applyDecisions under the agent's tool-call budget", () => {
  test("rules past limits.maxToolCalls do not dispatch, in either mode, and say why", async () => {
    for (const apply of ["enforce", "shadow"] as const) {
      const t = tools(async () => "ok");
      const r = await applyDecisions(
        { ...config, apply },
        answers,
        t.list,
        [],
        t.controller.signal,
        async () => true,
        1,
      );
      expect(r.actions.map((a) => a.outcome)).toEqual([
        apply === "shadow" ? "shadow" : "ran",
        "over_budget",
      ]);
      expect(t.ran).toEqual(apply === "shadow" ? [] : ["private_note"]);
    }
  });
});

// Actions whose tool commits calls that arrive together as one write are dispatched side by side
// (`together`). What is asserted is the dispatch itself: who is in flight with whom, in which order
// they started, and that the report is still one entry per action in rule order.
describe("applyDecisions dispatching the actions that share a write", () => {
  const rule = (
    tool: "private_note" | "set_labels" | "set_custom_attribute",
  ) => ({
    when,
    action: { tool, args: {} },
  });
  const args = (n: number) => ({
    when,
    action: {
      tool: "set_custom_attribute" as const,
      args: { key: `k${n}`, value: "v" },
    },
  });

  function recording() {
    const startedOrder: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const make = (
      name: string,
      fail?: (input: Record<string, unknown>) => boolean,
    ) =>
      new DynamicStructuredTool({
        name,
        description: name,
        schema: z.object({}).passthrough(),
        func: async (input: Record<string, unknown>) => {
          startedOrder.push(`${name}:${String(input.key ?? "")}`);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          if (fail?.(input)) throw new Error("boom");
          return "ok";
        },
      });
    return { startedOrder, peak: () => peak, make };
  }

  const key = (a: { tool: string }) =>
    a.tool === "set_custom_attribute" ? "attributes" : null;

  test("a group runs side by side at the place of its first action, the rest one at a time", async () => {
    const r = recording();
    const report = await applyDecisions(
      {
        apply: "enforce",
        rules: [
          rule("set_labels"),
          args(1),
          rule("private_note"),
          args(2),
          args(3),
        ],
      },
      answers,
      [
        r.make("set_labels"),
        r.make("set_custom_attribute"),
        r.make("private_note"),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
      key,
    );
    expect(r.startedOrder).toEqual([
      "set_labels:",
      "set_custom_attribute:k1",
      "set_custom_attribute:k2",
      "set_custom_attribute:k3",
      "private_note:",
    ]);
    expect(r.peak()).toBe(3);
    expect(report.actions).toEqual([
      { rule: 0, tool: "set_labels", outcome: "ran" },
      { rule: 1, tool: "set_custom_attribute", outcome: "ran" },
      { rule: 2, tool: "private_note", outcome: "ran" },
      { rule: 3, tool: "set_custom_attribute", outcome: "ran" },
      { rule: 4, tool: "set_custom_attribute", outcome: "ran" },
    ]);
  });

  test("without a grouping every action runs alone, in rule order", async () => {
    const r = recording();
    await applyDecisions(
      { apply: "enforce", rules: [args(1), args(2), args(3)] },
      answers,
      [r.make("set_custom_attribute")],
      [],
      new AbortController().signal,
      async () => true,
      10,
    );
    expect(r.peak()).toBe(1);
    expect(r.startedOrder).toEqual([
      "set_custom_attribute:k1",
      "set_custom_attribute:k2",
      "set_custom_attribute:k3",
    ]);
  });

  test("each member of a group passes the fence, and a refusal starts none of them", async () => {
    const r = recording();
    let asked = 0;
    const report = await applyDecisions(
      {
        apply: "enforce",
        rules: [rule("private_note"), args(1), args(2), args(3)],
      },
      answers,
      [r.make("set_custom_attribute"), r.make("private_note")],
      [],
      new AbortController().signal,
      async () => {
        asked += 1;
        // The note's ask and the first two members' pass; the third member's refuses.
        return asked < 4;
      },
      10,
      key,
    );
    expect(asked).toBe(4);
    expect(report.withdrawn).toBe(true);
    expect(r.startedOrder).toEqual(["private_note:"]);
    expect(report.actions).toEqual([
      { rule: 0, tool: "private_note", outcome: "ran" },
    ]);
  });

  test("the budget is spent in rule order, whatever the dispatch order", async () => {
    const r = recording();
    const report = await applyDecisions(
      { apply: "enforce", rules: [args(1), rule("private_note"), args(2)] },
      answers,
      [r.make("set_custom_attribute"), r.make("private_note")],
      [],
      new AbortController().signal,
      async () => true,
      2,
      key,
    );
    expect(report.actions).toEqual([
      { rule: 0, tool: "set_custom_attribute", outcome: "ran" },
      { rule: 1, tool: "private_note", outcome: "ran" },
      { rule: 2, tool: "set_custom_attribute", outcome: "over_budget" },
    ]);
  });

  test("one member failing is that action's failure, and the others still report", async () => {
    const r = recording();
    const report = await applyDecisions(
      { apply: "enforce", rules: [args(1), args(2), args(3)] },
      answers,
      [r.make("set_custom_attribute", (input) => input.key === "k2")],
      [],
      new AbortController().signal,
      async () => true,
      10,
      key,
    );
    expect(report.actions).toEqual([
      { rule: 0, tool: "set_custom_attribute", outcome: "ran" },
      {
        rule: 1,
        tool: "set_custom_attribute",
        outcome: "failed",
        failure: "tool_error",
      },
      { rule: 2, tool: "set_custom_attribute", outcome: "ran" },
    ]);
  });

  test("a deadline that fires while a group runs ends the tick once every member has returned", async () => {
    const r = recording();
    const controller = new AbortController();
    const slow = new DynamicStructuredTool({
      name: "set_custom_attribute",
      description: "x",
      schema: z.object({}).passthrough(),
      func: async (input: Record<string, unknown>) => {
        r.startedOrder.push(String(input.key));
        if (input.key === "k1") {
          controller.abort(new Error("deadline"));
          throw new Error("aborted");
        }
        await new Promise((res) => setTimeout(res, 10));
        r.startedOrder.push(`${String(input.key)}:returned`);
        return "ok";
      },
    });
    await expect(
      applyDecisions(
        { apply: "enforce", rules: [args(1), args(2), rule("private_note")] },
        answers,
        [slow, r.make("private_note")],
        [],
        controller.signal,
        async () => true,
        10,
        key,
      ),
    ).rejects.toThrow();
    expect(r.startedOrder).toEqual(["k1", "k2", "k2:returned"]);
  });
});
