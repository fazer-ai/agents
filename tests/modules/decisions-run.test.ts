import { describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { fenceReporterOf } from "@/graph/tools/fence-report";
import { ChatwootExpiredError } from "@/modules/chatwoot/client";
import { ruleStateKey } from "@/modules/decisions/config";
import { applyDecisions, type DecisionProgress } from "@/modules/decisions/run";

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
  // A dry run (decide without writing, internal: not a setting) counts the same budget, so it reports
  // what a run would.
  test("rules past limits.maxToolCalls do not dispatch, run or dry, and say why", async () => {
    for (const dryRun of [false, true]) {
      const t = tools(async () => "ok");
      const r = await applyDecisions(
        config,
        answers,
        t.list,
        [],
        t.controller.signal,
        async () => true,
        1,
        undefined,
        dryRun,
      );
      expect(r.actions.map((a) => a.outcome)).toEqual([
        dryRun ? "decided" : "ran",
        "over_budget",
      ]);
      expect(t.ran).toEqual(dryRun ? [] : ["private_note"]);
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
    const finished: string[] = [];
    const finishedAtStart = new Map<string, string[]>();
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
          const id = `${name}:${String(input.key ?? "")}`;
          finishedAtStart.set(id, [...finished]);
          startedOrder.push(id);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          finished.push(id);
          if (fail?.(input)) throw new Error("boom");
          return "ok";
        },
      });
    return {
      startedOrder,
      peak: () => peak,
      // What had already returned when this call started.
      finishedBeforeStart: (id: string) => finishedAtStart.get(id) ?? [],
      make,
    };
  }

  const key = (a: { tool: string }) =>
    a.tool === "set_custom_attribute" ? "attributes" : null;

  test("neighbours that share a write run side by side, and nothing runs ahead of its place", async () => {
    const r = recording();
    const report = await applyDecisions(
      {
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
    // The attribute rule ahead of the note is not joined by the two behind it.
    expect(r.startedOrder).toEqual([
      "set_labels:",
      "set_custom_attribute:k1",
      "private_note:",
      "set_custom_attribute:k2",
      "set_custom_attribute:k3",
    ]);
    expect(r.finishedBeforeStart("private_note:")).toEqual([
      "set_labels:",
      "set_custom_attribute:k1",
    ]);
    expect(r.peak()).toBe(2);
    expect(report.actions).toEqual([
      { rule: 0, tool: "set_labels", outcome: "ran" },
      { rule: 1, tool: "set_custom_attribute", outcome: "ran" },
      { rule: 2, tool: "private_note", outcome: "ran" },
      { rule: 3, tool: "set_custom_attribute", outcome: "ran" },
      { rule: 4, tool: "set_custom_attribute", outcome: "ran" },
    ]);
  });

  test("a run of three neighbours is three in flight at once", async () => {
    const r = recording();
    await applyDecisions(
      { rules: [args(1), args(2), args(3)] },
      answers,
      [r.make("set_custom_attribute")],
      [],
      new AbortController().signal,
      async () => true,
      10,
      key,
    );
    expect(r.peak()).toBe(3);
  });

  // The grouping is asked again after the fences, which are what read the live settings: a run
  // they no longer allow goes out one action at a time, each after the one before it.
  test("a grouping withdrawn while the fences were asked falls back to one at a time", async () => {
    const r = recording();
    let grouping = true;
    let fences = 0;
    const report = await applyDecisions(
      { rules: [args(1), args(2), args(3)] },
      answers,
      [r.make("set_custom_attribute")],
      [],
      new AbortController().signal,
      async () => {
        fences += 1;
        grouping = false;
        return true;
      },
      10,
      (a) => (grouping ? key(a) : null),
    );
    expect(r.peak()).toBe(1);
    expect(r.startedOrder).toEqual([
      "set_custom_attribute:k1",
      "set_custom_attribute:k2",
      "set_custom_attribute:k3",
    ]);
    expect(r.finishedBeforeStart("set_custom_attribute:k2")).toEqual([
      "set_custom_attribute:k1",
    ]);
    // The two that were held back are asked again, each after the write ahead of it.
    expect(fences).toBe(5);
    expect(report.actions.map((a) => a.outcome)).toEqual(["ran", "ran", "ran"]);
  });

  test("an action its tool's schema refuses rides inside the run, and does not part it", async () => {
    const r = recording();
    const strict = new DynamicStructuredTool({
      name: "private_note",
      description: "note",
      schema: z.object({ content: z.string() }),
      func: async () => "ok",
    });
    const report = await applyDecisions(
      {
        // A note with no content between two attribute rules: it can write nothing.
        rules: [args(1), rule("private_note"), args(2)],
      },
      answers,
      [r.make("set_custom_attribute"), strict],
      [],
      new AbortController().signal,
      async () => true,
      10,
      key,
    );
    expect(r.peak()).toBe(2);
    expect(report.actions).toEqual([
      { rule: 0, tool: "set_custom_attribute", outcome: "ran" },
      {
        rule: 1,
        tool: "private_note",
        outcome: "failed",
        failure: "invalid_arguments",
      },
      { rule: 2, tool: "set_custom_attribute", outcome: "ran" },
    ]);
  });

  test("a run does not stretch to an invalid action at its end", async () => {
    const r = recording();
    let fences = 0;
    const strict = new DynamicStructuredTool({
      name: "private_note",
      description: "note",
      schema: z.object({ content: z.string() }),
      func: async () => "ok",
    });
    await applyDecisions(
      {
        rules: [args(1), rule("private_note"), rule("set_labels")],
      },
      answers,
      [r.make("set_custom_attribute"), strict, r.make("set_labels")],
      [],
      new AbortController().signal,
      async () => {
        fences += 1;
        // Asked alone for the attribute rule: the invalid note behind it is not in its group.
        if (fences === 1) expect(r.startedOrder).toEqual([]);
        if (fences === 2) {
          expect(r.startedOrder).toEqual(["set_custom_attribute:k1"]);
        }
        return true;
      },
      10,
      key,
    );
    // The invalid note is checked before dispatch (decisions/arguments.ts) and asks no fence.
    expect(fences).toBe(2);
  });

  test("without a grouping every action runs alone, in rule order", async () => {
    const r = recording();
    await applyDecisions(
      { rules: [args(1), args(2), args(3)] },
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
      { rules: [args(1), rule("private_note"), args(2)] },
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
      { rules: [args(1), args(2), args(3)] },
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
        { rules: [args(1), args(2), rule("private_note")] },
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

// What latches when the actions do not all simply run (docs/decisions.md, "When a rule acts").
describe("applyDecisions and the trigger state", () => {
  const reporting = (
    name: string,
    fn: (report: ReturnType<typeof fenceReporterOf>) => Promise<string>,
  ) =>
    new DynamicStructuredTool({
      name,
      description: name,
      schema: z.object({}).passthrough(),
      func: async (_args, _run, config) => fn(fenceReporterOf(config)),
    });

  test("an action that wrote nothing is no_effect and does not latch", async () => {
    const rules = [
      {
        when,
        action: { tool: "set_custom_attribute" as const, args: {} },
        trigger: "once" as const,
      },
    ];
    const r = await applyDecisions(
      { rules },
      answers,
      [
        reporting("set_custom_attribute", async (report) => {
          report?.({ noEffect: true });
          return "Could not set the contact attribute (no contact in scope).";
        }),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
    );
    expect(r.actions).toEqual([
      { rule: 0, tool: "set_custom_attribute", outcome: "no_effect" },
    ]);
    expect(r.triggerState.latch).toEqual([]);
  });

  test("a failed action that left something behind latches", async () => {
    const rules = [
      { when, action: { tool: "handoff_to_human" as const, args: {} } },
    ];
    const r = await applyDecisions(
      { rules },
      answers,
      [
        reporting("handoff_to_human", async (report) => {
          report?.({ committed: true });
          throw new Error("status change failed");
        }),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
    );
    expect(r.actions).toEqual([
      {
        rule: 0,
        tool: "handoff_to_human",
        outcome: "failed",
        failure: "tool_error",
        committed: true,
      },
    ]);
    expect(r.triggerState.latch).toEqual([
      ruleStateKey({ when, action: { tool: "handoff_to_human", args: {} } }),
    ]);
  });

  const noteKey = ruleStateKey({
    when,
    action: { tool: "private_note", args: {} },
  });
  const handoffKey = ruleStateKey({
    when,
    action: { tool: "handoff_to_human", args: {} },
  });

  test("a rule's latch is written before its action is dispatched, and stays when the deadline ends the call", async () => {
    const controller = new AbortController();
    const progress: DecisionProgress = {};
    const order: string[] = [];
    await expect(
      applyDecisions(
        {
          rules: [
            { when, action: { tool: "handoff_to_human" as const, args: {} } },
          ],
        },
        answers,
        [
          reporting("handoff_to_human", async () => {
            order.push("dispatched");
            controller.abort(new Error("deadline"));
            throw new Error("aborted");
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
        async (keys) => {
          order.push(`latched ${keys.join(",")}`);
          return true;
        },
      ),
    ).rejects.toThrow();
    expect(order).toEqual([`latched ${handoffKey}`, "dispatched"]);
    // In flight when the tick ended: it may have written, so its latch is not undone.
    expect(progress.undo).toEqual([]);
  });

  test("a withdrawal that lands while the latch is written is seen before dispatch, and the latch released", async () => {
    let withdrawn = false;
    const order: string[] = [];
    const t = tools(async () => "ok");
    const r = await applyDecisions(
      { rules: config.rules.slice(0, 1) },
      answers,
      t.list,
      [],
      t.controller.signal,
      async () => {
        order.push("fence");
        return !withdrawn;
      },
      10,
      () => null,
      false,
      new Set(),
      {},
      async () => {
        order.push("latch");
        withdrawn = true;
        return true;
      },
    );
    expect(order).toEqual(["latch", "fence"]);
    expect(t.ran).toEqual([]);
    expect(r.withdrawn).toBe(true);
    expect(r.triggerState.undo).toEqual([noteKey]);
  });

  test("a call given up on at the deadline that then says it wrote nothing is undone, and the caller is told", async () => {
    const controller = new AbortController();
    let say: () => void = () => {};
    const progress: DecisionProgress = {};
    const run = applyDecisions(
      {
        rules: [
          {
            when,
            action: { tool: "set_labels" as const, args: {} },
            trigger: "once" as const,
          },
        ],
      },
      answers,
      [
        reporting(
          "set_labels",
          (report) =>
            new Promise<string>(() => {
              say = () => report?.({ noEffect: true });
            }),
        ),
      ],
      [],
      controller.signal,
      async () => true,
      10,
      () => null,
      false,
      new Set(),
      progress,
    );
    await Bun.sleep(5);
    expect(progress.undo).toEqual([]);
    let told = 0;
    progress.onChange = () => {
      told++;
    };
    say();
    const key = ruleStateKey({
      when,
      action: { tool: "set_labels", args: {} },
      trigger: "once",
    });
    expect(progress.undo).toEqual([key]);
    expect(told).toBe(1);
    controller.abort(new Error("deadline"));
    void run.catch(() => {});
  });

  test("a whole refusal said after the call was given up on undoes the latch too", async () => {
    let say: () => void = () => {};
    const progress: DecisionProgress = {};
    const run = applyDecisions(
      {
        rules: [
          {
            when,
            action: { tool: "set_labels" as const, args: {} },
            trigger: "once" as const,
          },
        ],
      },
      answers,
      [
        reporting(
          "set_labels",
          (report) =>
            new Promise<string>(() => {
              say = () =>
                report?.({ fence: "protected_label", partial: false });
            }),
        ),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
      () => null,
      false,
      new Set(),
      progress,
    );
    await Bun.sleep(5);
    say();
    expect(progress.undo).toEqual([
      ruleStateKey({
        when,
        action: { tool: "set_labels", args: {} },
        trigger: "once",
      }),
    ]);
    void run.catch(() => {});
  });

  test("a group after the deadline writes no latch", async () => {
    const controller = new AbortController();
    const latchedAhead: string[][] = [];
    await expect(
      applyDecisions(
        {
          rules: [
            { when, action: { tool: "private_note" as const, args: {} } },
            {
              when,
              action: { tool: "set_labels" as const, args: {} },
              trigger: "once" as const,
            },
          ],
        },
        answers,
        [
          reporting("private_note", async () => {
            controller.abort(new Error("deadline"));
            return "ok";
          }),
          reporting("set_labels", async () => "ok"),
        ],
        [],
        controller.signal,
        async () => true,
        10,
        () => null,
        false,
        new Set(),
        {},
        async (keys) => {
          latchedAhead.push(keys);
          return true;
        },
      ),
    ).rejects.toThrow();
    expect(latchedAhead).toEqual([[noteKey]]);
  });

  test("an on_start rule that did not hold is in the progress before anything is awaited", () => {
    const progress: DecisionProgress = {};
    const offRule = {
      when: [{ question: "q", minProbability: 0.99 }],
      action: { tool: "private_note" as const, args: {} },
    };
    void applyDecisions(
      { rules: [offRule] },
      answers,
      [],
      [],
      new AbortController().signal,
      async () => true,
      10,
      () => null,
      false,
      new Set(),
      progress,
    );
    expect(progress.release).toEqual([ruleStateKey(offRule)]);
  });

  test("an on_start rule that did not hold is released even when another action ends the tick", async () => {
    const controller = new AbortController();
    const progress: DecisionProgress = {};
    const offRule = {
      when: [{ question: "q", minProbability: 0.99 }],
      action: { tool: "private_note" as const, args: {} },
    };
    await expect(
      applyDecisions(
        {
          rules: [
            offRule,
            { when, action: { tool: "set_labels" as const, args: {} } },
          ],
        },
        answers,
        [
          reporting("private_note", async () => "ok"),
          reporting("set_labels", async () => {
            controller.abort(new Error("deadline"));
            throw new Error("aborted");
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
    expect(progress.release).toEqual([ruleStateKey(offRule)]);
  });

  test("a latch refused because a newer observation owns the state withdraws the tick, and nothing runs", async () => {
    const t = tools(async () => "ok");
    const r = await applyDecisions(
      { rules: config.rules.slice(0, 1) },
      answers,
      t.list,
      [],
      t.controller.signal,
      async () => true,
      10,
      () => null,
      false,
      new Set(),
      {},
      async () => false,
    );
    expect(t.ran).toEqual([]);
    expect(r.withdrawn).toBe(true);
    expect(r.actions).toEqual([]);
  });

  test("a latch that cannot be written ahead stops the tick before anything is dispatched", async () => {
    const t = tools(async () => "ok");
    await expect(
      applyDecisions(
        config,
        answers,
        t.list,
        [],
        t.controller.signal,
        async () => true,
        10,
        () => null,
        false,
        new Set(),
        {},
        async () => {
          throw new Error("db down");
        },
      ),
    ).rejects.toThrow("db down");
    expect(t.ran).toEqual([]);
  });

  test("an action that settled without writing before the deadline ended the tick is undone", async () => {
    const controller = new AbortController();
    const progress: DecisionProgress = {};
    const latchedAhead: string[] = [];
    await expect(
      applyDecisions(
        config,
        answers,
        [
          reporting("private_note", async (report) => {
            report?.({ fence: "precondition", partial: false });
            return "Did not run private_note (its condition does not hold).";
          }),
          reporting("set_labels", async () => {
            controller.abort(new Error("deadline"));
            throw new Error("aborted");
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
        async (keys) => {
          latchedAhead.push(...keys);
          return true;
        },
      ),
    ).rejects.toThrow();
    expect(latchedAhead).toEqual([noteKey]);
    expect(progress.undo).toEqual([noteKey]);
  });

  test("a finished tick latches what ran and releases what was latched ahead and wrote nothing", async () => {
    const r = await applyDecisions(
      {
        rules: [
          { when, action: { tool: "private_note" as const, args: {} } },
          { when, action: { tool: "handoff_to_human" as const, args: {} } },
        ],
      },
      answers,
      [
        reporting("private_note", async () => "ok"),
        reporting("handoff_to_human", async (report) => {
          report?.({ noEffect: true });
          return "Did not run handoff_to_human.";
        }),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
    );
    expect(r.triggerState.latch).toEqual([noteKey]);
    expect(r.triggerState.undo).toEqual([handoffKey]);
  });

  test("a call refused whole that then throws (its shared write failed) is still refused, by that fence", async () => {
    const rules = [
      {
        when,
        action: { tool: "set_labels" as const, args: {} },
        trigger: "once" as const,
      },
    ];
    const r = await applyDecisions(
      { rules },
      answers,
      [
        reporting("set_labels", async (report) => {
          report?.({ fence: "protected_label", partial: false });
          throw new Error("shared write failed");
        }),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
    );
    expect(r.actions).toEqual([
      {
        rule: 0,
        tool: "set_labels",
        outcome: "refused",
        fence: "protected_label",
      },
    ]);
    expect(r.triggerState.latch).toEqual([]);
  });

  test("a call that threw may have written: its rule stays latched", async () => {
    const r = await applyDecisions(
      {
        rules: [{ when, action: { tool: "private_note" as const, args: {} } }],
      },
      answers,
      [
        reporting("private_note", async () => {
          throw new Error("response could not be read");
        }),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
    );
    expect(r.triggerState.latch).toEqual([noteKey]);
    expect(r.triggerState.undo).toEqual([]);
  });

  test("a write the client refused before it left is released", async () => {
    const r = await applyDecisions(
      {
        rules: [{ when, action: { tool: "private_note" as const, args: {} } }],
      },
      answers,
      [
        reporting("private_note", async () => {
          throw new ChatwootExpiredError("POST messages");
        }),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
    );
    expect(r.triggerState.latch).toEqual([]);
    expect(r.triggerState.undo).toEqual([noteKey]);
  });

  test("a call withdrawn after a fence allowed part of it is no_effect, not a partial run", async () => {
    const rules = [
      {
        when,
        action: { tool: "set_labels" as const, args: {} },
        trigger: "once" as const,
      },
    ];
    const r = await applyDecisions(
      { rules },
      answers,
      [
        reporting("set_labels", async (report) => {
          report?.({ fence: "protected_label", partial: true });
          report?.({ noEffect: true });
          return "Could not set the contact labels (the run was called off while this write waited).";
        }),
      ],
      [],
      new AbortController().signal,
      async () => true,
      10,
    );
    expect(r.actions).toEqual([
      { rule: 0, tool: "set_labels", outcome: "no_effect" },
    ]);
    expect(r.triggerState.latch).toEqual([]);
  });
});
