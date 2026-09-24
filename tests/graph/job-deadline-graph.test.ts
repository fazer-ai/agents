import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";
import { CALLED_OFF_TOOL_RESULT } from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
import { withoutComments } from "@/tests/utils/source-text";

// Issue #811, where a job's deadline meets the graph. The signal is never handed to `graph.invoke`:
// aborting an invoke between a checkpointed tool call and its result leaves the thread with a call no
// `ToolMessage` answers, which the providers reject on every later turn, and the invoke rejects while
// the tool is still running, so the job would look finished with its work still going. The signal
// reaches the model call and the tool boundary instead: a tool already running finishes and is
// answered, the next model call sees the abort, and a call not yet run is refused like a called-off
// turn's.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Round 1 calls the writer; round 2 answers. Records whether each round's signal had aborted.
// `afterCalling` runs as round 1 returns its call, which is where a test puts the deadline to land
// between the model's answer and the tool.
class CallsThenAnswers {
  rounds = 0;
  sawAborted: boolean[] = [];
  constructor(private afterCalling?: () => void) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    return {
      async invoke(_m: BaseMessage[], opts?: { signal?: AbortSignal }) {
        self.rounds++;
        self.sawAborted.push(opts?.signal?.aborted === true);
        if (self.rounds === 1) {
          self.afterCalling?.();
          return new AIMessage({
            content: "",
            tool_calls: [{ name: "writer", args: { v: "sim" }, id: "c1" }],
          });
        }
        return new AIMessage("pronto");
      },
    };
  }
}

function slowWriter(ran: string[], ms: number): StructuredToolInterface {
  return tool(
    async ({ v }: { v: string }) => {
      await sleep(ms);
      ran.push(v);
      return `wrote ${v}`;
    },
    {
      name: "writer",
      description: "writes something to the world",
      schema: z.object({ v: z.string() }),
    },
  ) as unknown as StructuredToolInterface;
}

// Every tool call in the thread has a `ToolMessage` answering it.
function unanswered(messages: BaseMessage[]): string[] {
  const answered = new Set(
    messages
      .filter((m) => m.getType() === "tool")
      .map((m) => (m as unknown as { tool_call_id: string }).tool_call_id),
  );
  return messages
    .flatMap((m) =>
      m.getType() === "ai" ? ((m as AIMessage).tool_calls ?? []) : [],
    )
    .map((c) => c.id as string)
    .filter((id) => !answered.has(id));
}

describe("a job's deadline inside the graph (issue #811)", () => {
  test("a tool running when the deadline fires finishes and is answered, and no model call starts after it", async () => {
    const ran: string[] = [];
    const model = new CallsThenAnswers();
    const controller = new AbortController();
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [slowWriter(ran, 400)],
      signal: controller.signal,
    });
    const timer = setTimeout(
      () => controller.abort(new Error("deadline exceeded")),
      100,
    );
    const t = performance.now();
    try {
      await graph
        .invoke(
          { messages: [new HumanMessage("marca como qualificado")] },
          { configurable: { thread_id: "deadline-mid-tool" } },
        )
        .catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    // The graph returned only after the tool it was running had finished.
    expect(ran).toEqual(["sim"]);
    expect(performance.now() - t).toBeGreaterThanOrEqual(390);
    expect(model.sawAborted).toEqual([false]);
    const state = await graph.getState({
      configurable: { thread_id: "deadline-mid-tool" },
    });
    const messages = (state.values as { messages: BaseMessage[] }).messages;
    expect(unanswered(messages)).toEqual([]);
  });

  test("a tool call reached after the deadline is refused, answered, and the turn ends", async () => {
    const ran: string[] = [];
    const controller = new AbortController();
    const model = new CallsThenAnswers(() =>
      controller.abort(new Error("deadline exceeded")),
    );
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [slowWriter(ran, 10)],
      signal: controller.signal,
    });
    const result = await graph
      .invoke(
        { messages: [new HumanMessage("marca como qualificado")] },
        { configurable: { thread_id: "deadline-before-tool" } },
      )
      .catch(async () =>
        graph
          .getState({ configurable: { thread_id: "deadline-before-tool" } })
          .then((st) => st.values as { messages: BaseMessage[] }),
      );
    expect(ran).toEqual([]);
    expect(model.rounds).toBe(1);
    const answers = result.messages.filter((m) => m.getType() === "tool");
    expect(contentToText(answers[0]?.content ?? "")).toBe(
      CALLED_OFF_TOOL_RESULT,
    );
    expect(unanswered(result.messages)).toEqual([]);
  });

  test("a deadline that fires while the tool fence is being read still refuses the call", async () => {
    // The fence's own read is I/O, and the deadline can end during it: the abort is read after the
    // fence answers, so a fence that says "still wanted" does not outvote a job that is already over.
    const ran: string[] = [];
    const model = new CallsThenAnswers();
    const controller = new AbortController();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [slowWriter(ran, 10)],
      signal: controller.signal,
      stillWanted: async () => {
        controller.abort(new Error("deadline exceeded"));
        return true;
      },
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("marca como qualificado")] },
      { configurable: { thread_id: "deadline-during-fence" } },
    );
    expect(ran).toEqual([]);
    const answers = result.messages.filter((m) => m.getType() === "tool");
    expect(contentToText(answers[0]?.content ?? "")).toBe(
      CALLED_OFF_TOOL_RESULT,
    );
    expect(unanswered(result.messages)).toEqual([]);
  });

  test("a primary ended by the deadline does not hand the turn to the fallback, and the turn fails with the job's own error", async () => {
    // The primary listens and rejects the way the SDKs do on an abort, which the provider layer reads
    // as a timeout, which is what would hand the turn to the fallback.
    const primary = {
      async invoke(_m: BaseMessage[], opts?: { signal?: AbortSignal }) {
        await new Promise<void>((_, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            const err = new Error("Request was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        });
        return new AIMessage("never");
      },
      bindTools() {
        return primary;
      },
    };
    let fallbackCalls = 0;
    const fallback = {
      async invoke() {
        fallbackCalls++;
        return new AIMessage("do fallback");
      },
      bindTools() {
        return fallback;
      },
    };
    const controller = new AbortController();
    const graph = buildAgentGraph({
      model: primary as unknown as BaseChatModel,
      systemPrompt: "s",
      primary: { provider: "openai", model: "test-model" },
      fallback: {
        model: fallback as unknown as BaseChatModel,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
      signal: controller.signal,
    });
    const timer = setTimeout(
      () => controller.abort(new Error("deadline exceeded after 240s")),
      100,
    );
    let thrown: unknown;
    try {
      await graph.invoke({ messages: [new HumanMessage("oi")] });
    } catch (err) {
      thrown = err;
    } finally {
      clearTimeout(timer);
    }
    expect(fallbackCalls).toBe(0);
    expect((thrown as Error | undefined)?.message).toBe(
      "deadline exceeded after 240s",
    );
  });

  test("no graph invoke in the runtime or the nudge is handed a signal", async () => {
    // The structural half: the two places a job's turn invokes its graph build the invoke's options
    // next to `recursionLimit`, and none of them may carry `signal`.
    for (const file of ["src/graph/runtime.ts", "src/graph/nudge.ts"]) {
      const src = await Bun.file(file).text();
      const sites = [...src.matchAll(/recursionLimit: recursionLimitFor\(/g)];
      expect(sites.length).toBeGreaterThan(0);
      for (const m of sites) {
        // The rest of the options object: up to the brace that closes it, nested ones included.
        let depth = 1;
        let end = m.index;
        while (depth > 0 && end < src.length) {
          end++;
          if (src[end] === "{") depth++;
          else if (src[end] === "}") depth--;
        }
        const options = src.slice(m.index, end);
        expect({ file, options }).toEqual({
          file,
          options: options.replace(/\bsignal\b[^\n]*\n/g, ""),
        });
      }
    }
  });

  test("every send of a nudge is marked as delivered before it leaves", async () => {
    // After a send the step is the run's, and what follows it (labels, resolve) runs past the
    // deadline; the mark is what tells `stillWanted` so. A send without it would lose those to a
    // deadline that fired during it, and a new send added later is held to the same line.
    const src = withoutComments(await Bun.file("src/graph/nudge.ts").text());
    const lines = src.split("\n");
    const sends = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) =>
        /await client\.send(Message|Template|PrivateNote)\(/.test(line),
      );
    expect(sends.length).toBeGreaterThan(0);
    for (const { line, i } of sends) {
      expect({ line: line.trim(), marked: lines[i - 1]?.trim() }).toEqual({
        line: line.trim(),
        marked: "delivered = true;",
      });
    }
  });

  test("no silent end of a nudge drops a refused post-action", async () => {
    // A silent end sent nothing, so a post-action the deadline refused leaves the step to the retry;
    // an end that reported "silent" over it would have the step stamped and committed with its
    // labels or resolve missing. So a call whose answer is thrown away must be followed by an end
    // that did send something.
    const src = withoutComments(await Bun.file("src/graph/nudge.ts").text());
    const bare = [...src.matchAll(/\n\s*await applyPostActions\(/g)];
    expect(bare.length).toBeGreaterThan(0);
    for (const m of bare) {
      const after = src.slice(m.index);
      const end = after
        .slice(after.indexOf(";") + 1)
        .match(/return [^;]*;/)?.[0];
      expect({ end, silent: /"silent"/.test(end ?? "") }).toEqual({
        end,
        silent: false,
      });
    }
  });

  test("every job kind whose handler runs a model turn hands the turn its job's signal", async () => {
    // The handlers are tested by calling them, which skips the registration, and a registration that
    // wraps its handler is where the signal was dropped twice. A kind that starts running a turn has
    // to be added to the list below, which is the point: it cannot join without being looked at.
    const turn = /\b(runAgentNudge|runLoadedTurn|runAgentTurn)\(/;
    const noTurn = new Set(["FOLLOWUP_SWEEP"]);
    const kinds: string[] = [];
    for await (const file of new Bun.Glob("src/**/*.ts").scan(".")) {
      const src = withoutComments(await Bun.file(file).text());
      if (!turn.test(src)) continue;
      const sites = src.matchAll(
        /registerJobHandler\(\s*"([A-Z_]+)",\s*([\s\S]*?)\);\n/g,
      );
      for (const [, kind = "", handler = ""] of sites) {
        if (noTurn.has(kind)) continue;
        kinds.push(kind);
        // The call, not the arrow's parameter list, which names `ctx` whether or not it is passed on.
        let body = handler.includes("=>")
          ? handler.slice(handler.indexOf("=>"))
          : handler;
        const named = handler.trim();
        if (/^\w+$/.test(named)) {
          const start = src.indexOf(`function ${named}(`);
          body = src.slice(start, src.indexOf("\n}\n", start));
        }
        // The signal, or the whole context, which also carries `commit`.
        const forwards = /\bctx\??\.signal\b|[(,]\s*ctx\s*\)/.test(body);
        expect({ kind, forwards }).toEqual({
          kind,
          forwards: true,
        });
      }
    }
    expect(kinds.sort()).toEqual([
      "APPOINTMENT_REMINDER",
      "DEBOUNCE",
      "FOLLOWUP",
      "REDIRECT_FOLLOWUP",
    ]);
  });
});
