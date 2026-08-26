import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import {
  applyToolPreconditions,
  guardedTool,
  preconditionFlowEvent,
  unmatchedPreconditionEvent,
} from "@/graph/tools/precondition";
import type { ToolPrecondition } from "@/modules/agents/tool-preconditions";

const COND: ToolPrecondition = {
  kind: "attribute",
  scope: "conversation",
  key: "article_url",
};

// The side effect the issue is about: `handoff_to_human` reassigns the conversation and posts, and
// none of that is undoable. A stub that RECORDS the effect is the only way a test can tell "refused"
// from "ran and returned something that reads like a refusal".
function spyTool(name = "handoff_to_human") {
  const calls: unknown[] = [];
  const t = tool(
    async (input: unknown) => {
      calls.push(input);
      return "Handed off to a human (status set to open).";
    },
    {
      name,
      description: "Escalate the conversation to a human agent.",
      schema: z.object({ reason: z.string().optional() }),
    },
  ) as unknown as StructuredToolInterface;
  return { tool: t, calls };
}

const met = async () => ({
  conversationAttributes: { article_url: "https://financefootball.com/x" },
  contactAttributes: {},
});
const unmet = async () => ({
  conversationAttributes: {},
  contactAttributes: {},
});

describe("guardedTool", () => {
  test("runs the tool when the precondition is met", async () => {
    const { tool: inner, calls } = spyTool();
    const out = await guardedTool(inner, COND, met).invoke({ reason: "2" });
    expect(calls).toHaveLength(1);
    expect(String(out)).toContain("Handed off");
  });

  test("does NOT run the tool when the precondition is unmet", async () => {
    const { tool: inner, calls } = spyTool();
    const out = await guardedTool(inner, COND, unmet).invoke({ reason: "2" });
    expect(calls).toHaveLength(0);
    expect(String(out)).toContain("was not run");
    expect(String(out)).toContain("article_url");
  });

  test("fails CLOSED when the state cannot be read", async () => {
    const { tool: inner, calls } = spyTool();
    const boom = async () => {
      throw new Error("connection terminated");
    };
    const out = await guardedTool(inner, COND, boom).invoke({ reason: "2" });
    expect(calls).toHaveLength(0);
    expect(String(out)).toContain("was not run");
  });

  test("reports the refusal once, with the tool, the condition and WHY", async () => {
    const seen: unknown[] = [];
    const { tool: inner } = spyTool();
    await guardedTool(inner, COND, unmet, (i) => seen.push(i)).invoke({});
    expect(seen).toEqual([
      { tool: "handoff_to_human", cond: COND, reason: "unmet", err: undefined },
    ]);
  });

  // Round 5 of PR #378: both refusals reported identically, so a database fault that refuses EVERY
  // guarded call for as long as it lasts was indistinguishable from a rule doing its job — the same
  // `info`/`ok` line, and nothing anywhere to page on. The model still gets the same sentence.
  test("an unreadable state reports a DIFFERENT reason, carrying the error", async () => {
    const seen: Array<{ reason: string; err?: unknown }> = [];
    const { tool: inner, calls } = spyTool();
    const boom = async () => {
      throw new Error("connection terminated");
    };
    const out = await guardedTool(inner, COND, boom, (i) =>
      seen.push(i),
    ).invoke({});
    expect(calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    const reported = seen[0] as { reason: string; err?: unknown };
    expect(reported.reason).toBe("unreadable");
    expect((reported.err as Error).message).toBe("connection terminated");
    // Identical to what an unmet condition returns: the operator sees the difference, the customer
    // does not.
    expect(String(out)).toBe(
      String(await guardedTool(inner, COND, unmet).invoke({})),
    );
  });

  test("reports nothing when the tool actually ran", async () => {
    const seen: unknown[] = [];
    const { tool: inner } = spyTool();
    await guardedTool(inner, COND, met, (i) => seen.push(i)).invoke({});
    expect(seen).toEqual([]);
  });

  test("keeps the tool's identity, so the model sees no difference", () => {
    const { tool: inner } = spyTool();
    const guarded = guardedTool(inner, COND, unmet);
    expect(guarded.name).toBe(inner.name);
    expect(guarded.description).toBe(inner.description);
    expect(guarded.schema).toBe(inner.schema);
  });

  test("the state is read per CALL, not once at wrap time", async () => {
    const { tool: inner, calls } = spyTool();
    // The turn the issue describes: the value arrives mid-turn (set_custom_attribute writes it) and
    // the guarded call comes after. A state captured at wrap time would refuse this.
    let attributes: Record<string, unknown> = {};
    const guarded = guardedTool(inner, COND, async () => ({
      conversationAttributes: attributes,
      contactAttributes: {},
    }));
    await guarded.invoke({});
    expect(calls).toHaveLength(0);
    attributes = { article_url: "https://financefootball.com/x" };
    await guarded.invoke({});
    expect(calls).toHaveLength(1);
  });
});

describe("guardedTool under ToolNode", () => {
  test("the refusal reaches the model as this call's ToolMessage", async () => {
    const { tool: inner, calls } = spyTool();
    const node = new ToolNode([guardedTool(inner, COND, unmet)]);
    const out = (await node.invoke({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call_1", name: "handoff_to_human", args: { reason: "2" } },
          ],
        }),
      ],
    })) as { messages: ToolMessage[] };
    expect(calls).toHaveLength(0);
    const answer = out.messages[0];
    expect(answer).toBeInstanceOf(ToolMessage);
    // Bound to THIS call, or the model cannot tell which of a batch of calls was refused.
    expect(answer?.tool_call_id).toBe("call_1");
    expect(String(answer?.content)).toContain("was not run");
  });

  test("a refusal is not an error: the turn continues", async () => {
    const { tool: inner } = spyTool();
    const node = new ToolNode([guardedTool(inner, COND, unmet)]);
    const out = (await node.invoke({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "c", name: "handoff_to_human", args: {} }],
        }),
      ],
    })) as { messages: ToolMessage[] };
    // `status: "error"` is what tools/failure.ts marks an INTEGRATION failure with, and the flow
    // logger reads it to page an alert channel. A rule doing its job must not page anyone.
    expect(out.messages[0]?.status).not.toBe("error");
  });
});

describe("applyToolPreconditions", () => {
  test("returns the very same array when nothing is configured", () => {
    const { tool: a } = spyTool("a");
    const tools = [a];
    expect(applyToolPreconditions(tools, {}, unmet)).toBe(tools);
  });

  test("wraps only the named tool, and leaves its siblings identical", async () => {
    const { tool: guardedInner, calls: guardedCalls } = spyTool("guarded");
    const { tool: openInner, calls: openCalls } = spyTool("open");
    const out = applyToolPreconditions(
      [guardedInner, openInner],
      { guarded: COND },
      unmet,
    );
    expect(out[1]).toBe(openInner);
    await out[0]?.invoke({});
    await out[1]?.invoke({});
    expect(guardedCalls).toHaveLength(0);
    expect(openCalls).toHaveLength(1);
  });

  test("a condition naming a tool the agent was not granted changes nothing", () => {
    const { tool: a } = spyTool("a");
    const out = applyToolPreconditions([a], { not_granted: COND }, unmet);
    expect(out[0]).toBe(a);
  });

  // Round 5 of PR #378: "changes nothing" is exactly the problem. On screen the rule is there, the
  // tool runs anyway, and nothing connects the two. It happens without the operator doing anything —
  // the grant is removed, or an imported MCP connection comes back under a different exposed name.
  describe("a rule that matches nothing is REPORTED", () => {
    test("names every unmatched tool, once", () => {
      const { tool: a } = spyTool("a");
      const seen: string[][] = [];
      applyToolPreconditions(
        [a],
        { a: COND, gone: COND, also_gone: COND },
        unmet,
        undefined,
        (n) => seen.push(n),
      );
      expect(seen).toEqual([["gone", "also_gone"]]);
    });

    test("says nothing when every rule matched", () => {
      const { tool: a } = spyTool("a");
      const seen: string[][] = [];
      applyToolPreconditions([a], { a: COND }, unmet, undefined, (n) =>
        seen.push(n),
      );
      expect(seen).toEqual([]);
    });

    test("says nothing when there are no rules at all", () => {
      const { tool: a } = spyTool("a");
      const seen: string[][] = [];
      applyToolPreconditions([a], {}, unmet, undefined, (n) => seen.push(n));
      expect(seen).toEqual([]);
    });
  });
});

// Round 1 of PR #378: the wrapper used to be a second `tool()`, which started a CHILD run under the
// outer one. Two runs for one model-issued call is two flow-log lines and, on an integration
// failure, two alerts.
describe("round 1: one model-issued call is ONE tool run", () => {
  function runCounter() {
    const started: string[] = [];
    return {
      started,
      handlers: [
        {
          // The 7th argument is the run NAME; the first is a serialized descriptor whose `name` is
          // not the tool's. Measured, rather than assumed from the signature.
          handleToolStart(
            _tool: unknown,
            _input: string,
            _runId: string,
            _parentRunId?: string,
            _tags?: string[],
            _metadata?: unknown,
            runName?: string,
          ) {
            started.push(runName ?? "?");
          },
        },
      ],
    };
  }

  test("a permitted call starts exactly one run, under the inner tool's name", async () => {
    const { tool: inner } = spyTool();
    const { started, handlers } = runCounter();
    await guardedTool(inner, COND, met).invoke({ reason: "2" }, {
      callbacks: handlers,
    } as never);
    expect(started).toEqual(["handoff_to_human"]);
  });

  test("a refused call starts no run at all", async () => {
    const { tool: inner } = spyTool();
    const { started, handlers } = runCounter();
    await guardedTool(inner, COND, unmet).invoke({ reason: "2" }, {
      callbacks: handlers,
    } as never);
    expect(started).toEqual([]);
  });

  test("a tool whose NAME is an Object member is not guarded by an inherited value", async () => {
    const { tool: inner, calls } = spyTool("toString");
    // The map comes from the runtime reader (null-prototype), but this is the lookup that would
    // break on a plain object, so it is asserted where it happens.
    const out = applyToolPreconditions([inner], Object.create(null), unmet);
    expect(out[0]).toBe(inner);
    await out[0]?.invoke({});
    expect(calls).toHaveLength(1);
  });
});

// The half that decides whether anyone is paged. `tests/modules/tool-precondition-alerting.test.ts`
// takes these same two events to a real database and counts the deliveries; here it is the mapping
// itself, which is what a mutation would survive if only the end-to-end test existed.
describe("preconditionFlowEvent", () => {
  test("an unmet condition is info/ok — the rule working is not an incident", () => {
    const ev = preconditionFlowEvent({
      tool: "handoff_to_human",
      cond: COND,
      reason: "unmet",
    });
    expect(ev.level).toBe("info");
    expect(ev.status).toBe("ok");
    expect(ev.detail?.phase).toBe("precondition");
  });

  test("an unreadable state is warn/error — the database being down IS one", () => {
    const ev = preconditionFlowEvent({
      tool: "handoff_to_human",
      cond: COND,
      reason: "unreadable",
      err: new TypeError("connection terminated"),
    });
    expect(ev.level).toBe("warn");
    expect(ev.status).toBe("error");
    expect(ev.detail?.phase).toBe("precondition_unreadable");
  });

  test("the error's CLASS travels, never its message", () => {
    // Measured in this repo before (PR #292): a driver's own TypeError message carries the request
    // that failed, headers included. This detail is rendered in the console.
    const ev = preconditionFlowEvent({
      tool: "handoff_to_human",
      cond: COND,
      reason: "unreadable",
      err: new TypeError("connect ECONNREFUSED postgres://u:hunter2@db:5432"),
    });
    expect(ev.detail?.error).toBe("TypeError");
    expect(JSON.stringify(ev)).not.toContain("hunter2");
  });

  test("a non-Error rejection still reports, as unknown", () => {
    const ev = preconditionFlowEvent({
      tool: "handoff_to_human",
      cond: COND,
      reason: "unreadable",
      err: "nope",
    });
    expect(ev.detail?.error).toBe("unknown");
  });

  test("the attribute VALUE never appears in either event", () => {
    const withValue = { ...COND, equals: "https://financefootball.com/x" };
    for (const reason of ["unmet", "unreadable"] as const) {
      const ev = preconditionFlowEvent({
        tool: "handoff_to_human",
        cond: withValue,
        reason,
      });
      expect(ev.detail?.preconditionKey).toBe("article_url");
      expect(JSON.stringify(ev)).not.toContain("financefootball");
    }
  });
});

describe("unmatchedPreconditionEvent", () => {
  test("is info/ok: a static misconfiguration must not page once per turn", () => {
    const ev = unmatchedPreconditionEvent(["gone"]);
    expect(ev.level).toBe("info");
    expect(ev.status).toBe("ok");
    expect(ev.detail).toEqual({
      phase: "precondition_unmatched",
      tools: ["gone"],
    });
  });
});
