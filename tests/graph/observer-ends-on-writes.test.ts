import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import {
  type StructuredToolInterface,
  type ToolRunnableConfig,
  tool,
} from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";
import { markEffectFree } from "@/graph/tools/effect-free";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { fenceReporterOf } from "@/graph/tools/fence-report";
import { markRead } from "@/graph/tools/reads";

type Call = { name: string; args?: Record<string, unknown> };

// A model that plays a script, one entry per call, and counts every call. Each entry is the step's
// tool calls; an empty entry is a plain text answer. `bareCalls` counts the calls made with no tools
// bound, which is how the hard limit forces an answer.
class ScriptedModel {
  calls = 0;
  bareCalls = 0;
  seen: BaseMessage[][] = [];
  constructor(private readonly script: Call[][]) {}
  private next(messages: BaseMessage[]): AIMessage {
    const step = this.script[this.calls] ?? [];
    this.calls++;
    this.seen.push(messages);
    if (step.length === 0) return new AIMessage("texto");
    return new AIMessage({
      content: "",
      tool_calls: step.map((c, i) => ({
        name: c.name,
        args: c.args ?? {},
        id: `call_${this.calls}_${i}`,
      })),
    });
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.bareCalls++;
    return this.next(messages);
  }
  bindTools(_tools: unknown) {
    return { invoke: async (m: BaseMessage[]) => this.next(m) };
  }
}

const ran: string[] = [];
const write = (name: string) =>
  tool(
    async () => {
      ran.push(name);
      return "ok";
    },
    { name, description: name, schema: z.object({}) },
  );
const strictWrite = tool(
  async () => {
    ran.push("strict");
    return "ok";
  },
  {
    name: "strict",
    description: "strict",
    schema: z.object({ value: z.string() }),
  },
);
const failingWrite = failableTool(
  async () => {
    ran.push("failing");
    return toolFailure("HTTP 500");
  },
  { name: "failing", description: "failing", schema: z.object({}) },
);
// A refusal the model sees as an ordinary result and the call reports on its config.
const fencedWrite = tool(
  async (_i: unknown, config: ToolRunnableConfig) => {
    ran.push("fenced");
    fenceReporterOf(config)?.({ fence: "allowed_labels", partial: false });
    return "etiqueta fora da lista";
  },
  { name: "fenced", description: "fenced", schema: z.object({}) },
);
const read = (name: string) =>
  markRead(
    tool(
      async () => {
        ran.push(name);
        return `resultado de ${name}`;
      },
      { name, description: name, schema: z.object({}) },
    ),
  );
const effectFree = markEffectFree(
  tool(
    async () => {
      ran.push("search");
      return "trecho";
    },
    { name: "search", description: "search", schema: z.object({}) },
  ),
);
const utility = tool(
  async () => {
    ran.push("get_current_time");
    return "12:00";
  },
  { name: "get_current_time", description: "time", schema: z.object({}) },
);

async function run(
  script: Call[][],
  tools: StructuredToolInterface[],
  opts: {
    observer?: boolean;
    maxToolCalls?: number;
    noEffectCount?: () => number;
  } = {},
) {
  ran.length = 0;
  const model = new ScriptedModel(script);
  const graph = buildAgentGraph({
    primary: { provider: "openai", model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer: new MemorySaver(),
    tools,
    maxToolCalls: opts.maxToolCalls ?? 10,
    ...(opts.observer === false ? {} : { noReplyChannel: true }),
    ...(opts.noEffectCount ? { noEffectCount: opts.noEffectCount } : {}),
  });
  const result = await graph.invoke(
    { messages: [new HumanMessage("conversa")] },
    { configurable: { thread_id: `t-${Math.random()}` } },
  );
  return { model, messages: result.messages as BaseMessage[] };
}

const toolResults = (round: BaseMessage[] | undefined) =>
  (round ?? []).filter((m) => m.getType() === "tool") as ToolMessage[];

describe("an observation ends after a step of writes alone", () => {
  test("one accepted write: one model call, and the turn ends on an empty message", async () => {
    const { model, messages } = await run([[{ name: "w" }]], [write("w")]);
    expect(model.calls).toBe(1);
    expect(ran).toEqual(["w"]);
    const last = messages.at(-1);
    expect(last?.getType()).toBe("ai");
    expect(last?.content).toBe("");
  });

  test("maxToolCalls 1: no forced call with no tools bound", async () => {
    const { model } = await run([[{ name: "w" }]], [write("w")], {
      maxToolCalls: 1,
    });
    expect(model.calls).toBe(1);
    expect(model.bareCalls).toBe(0);
  });

  test("a repeat the script would make never happens", async () => {
    const { model } = await run(
      [[{ name: "w" }], [{ name: "w" }]],
      [write("w")],
      { maxToolCalls: 2 },
    );
    expect(model.calls).toBe(1);
    expect(ran).toEqual(["w"]);
  });

  test("two different writes in one step both run, and the turn ends", async () => {
    const { model } = await run(
      [[{ name: "a" }, { name: "b" }]],
      [write("a"), write("b")],
    );
    expect(model.calls).toBe(1);
    expect(ran.sort()).toEqual(["a", "b"]);
  });
});

describe("an observation goes on when the model has something to see", () => {
  for (const [label, t] of [
    ["a marked read (HTTP GET, MCP)", read("r")],
    ["an effect-free tool (search, code)", effectFree],
    ["a utility native", utility],
  ] as const) {
    test(`${label} keeps the next call, which receives the result`, async () => {
      const { model } = await run([[{ name: t.name }], []], [t]);
      expect(model.calls).toBe(2);
      expect(toolResults(model.seen[1])).toHaveLength(1);
    });
  }

  test("a read beside a write keeps the next call", async () => {
    const { model } = await run(
      [[{ name: "r" }, { name: "w" }], []],
      [read("r"), write("w")],
    );
    expect(model.calls).toBe(2);
    expect(ran.filter((n) => n === "w")).toHaveLength(1);
  });

  test("arguments the schema refuses keep the next call; the fixed write then ends the turn", async () => {
    const { model } = await run(
      [[{ name: "strict" }], [{ name: "strict", args: { value: "x" } }], []],
      [strictWrite],
    );
    expect(model.calls).toBe(2);
    expect(toolResults(model.seen[1])[0]?.status).toBe("error");
    expect(ran).toEqual(["strict"]);
  });

  test("a failed write keeps the next call", async () => {
    const { model } = await run([[{ name: "failing" }], []], [failingWrite]);
    expect(model.calls).toBe(2);
    expect(toolResults(model.seen[1])[0]?.status).toBe("error");
  });

  test("one accepted write beside a failed one keeps the next call", async () => {
    const { model } = await run(
      [[{ name: "w" }, { name: "failing" }], []],
      [write("w"), failingWrite],
    );
    expect(model.calls).toBe(2);
    expect(toolResults(model.seen[1])).toHaveLength(2);
  });

  test("a fence that refused the call keeps the next call", async () => {
    const { model } = await run([[{ name: "fenced" }], []], [fencedWrite]);
    expect(model.calls).toBe(2);
  });

  test("a call that reported writing nothing keeps the next call", async () => {
    let noEffect = 0;
    const silent = tool(
      async () => {
        noEffect++;
        return "nada a fazer";
      },
      { name: "silent", description: "silent", schema: z.object({}) },
    );
    const { model } = await run([[{ name: "silent" }], []], [silent], {
      noEffectCount: () => noEffect,
    });
    expect(model.calls).toBe(2);
  });

  test("a tool the toolset does not have keeps the next call", async () => {
    const { model } = await run([[{ name: "ghost" }], []], [write("w")]);
    expect(model.calls).toBe(2);
  });
});

describe("a responder is unchanged", () => {
  test("it calls the model again after a write, and that text is the reply", async () => {
    const { model, messages } = await run([[{ name: "w" }], []], [write("w")], {
      observer: false,
    });
    expect(model.calls).toBe(2);
    expect(messages.at(-1)?.content).toBe("texto");
  });

  test("it keeps the forced call with no tools at maxToolCalls", async () => {
    const { model } = await run([[{ name: "w" }], []], [write("w")], {
      observer: false,
      maxToolCalls: 1,
    });
    expect(model.calls).toBe(2);
    expect(model.bareCalls).toBe(1);
  });
});
