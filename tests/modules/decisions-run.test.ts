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
