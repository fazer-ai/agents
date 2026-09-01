import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";
import { contentToText } from "@/graph/message-text";
import { SKIP_REPLY_TOOL } from "@/graph/silence";
import { buildThreadStateGraph } from "@/graph/thread-state";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { buildNativeTools } from "@/graph/tools/native";
import { guardedTool } from "@/graph/tools/precondition";
import { unmetPreconditionMessage } from "@/modules/agents/tool-preconditions";

// Records the messages handed to the model on each invoke (the only thing agentNode does with it).
class RecordingModel {
  seen: BaseMessage[][] = [];
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.seen.push(messages);
    return new AIMessage("ok");
  }
}

// Regression for the production follow-up bug: agentNode must hand the model EXACTLY ONE system
// message, first. A proactive nudge used to be injected as a SystemMessage; combined with the
// per-turn system prompt that produced [system, …, system], which strict providers (Google) reject
// with "System messages are only permitted as the first passed message". The node now strips any
// system message from the history before prepending the prompt — auto-healing old threads too.
describe("agentNode system-message normalization", () => {
  test("prepends one system prompt and drops a system message leaked into history", async () => {
    const model = new RecordingModel();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
    });
    await graph.invoke(
      {
        messages: [
          new SystemMessage("OLD NUDGE"),
          new HumanMessage("oi"),
          new AIMessage("olá"),
          new HumanMessage("tudo bem?"),
        ],
      },
      { configurable: { thread_id: "t1" } },
    );
    const seen = model.seen[0];
    expect(seen).toBeDefined();
    if (!seen) return;
    const systems = seen.filter((m) => m.getType() === "system");
    expect(systems).toHaveLength(1);
    expect(seen[0]?.getType()).toBe("system");
    expect(seen[0]?.content).toBe("PROMPT");
    // the leaked nudge text is gone, the rest of the history is preserved in order
    expect(seen.some((m) => m.content === "OLD NUDGE")).toBe(false);
    expect(seen.slice(1).map((m) => m.content)).toEqual([
      "oi",
      "olá",
      "tudo bem?",
    ]);
  });
});

// A model that keeps calling a tool while tools are bound, and answers in text when they are NOT
// (the hard-limit path invokes the raw model). Records the system prompt seen on each bound invoke.
class ToolLoopModel {
  boundSystemPrompts: string[] = [];
  rawInvokes = 0;
  // Hard-limit path: raw model, no tools → a plain text answer ends the turn.
  async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
    this.rawInvokes++;
    return new AIMessage("resposta final");
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        n++;
        self.boundSystemPrompts.push(String(messages[0]?.content ?? ""));
        return new AIMessage({
          content: "",
          tool_calls: [{ name: "noop", args: {}, id: `call_${n}` }],
        });
      },
    };
  }
}

const noopTool = tool(async () => "feito", {
  name: "noop",
  description: "noop",
  schema: z.object({}),
});

// The REAL `skip_reply`, not a double: since round 24 the tool identifies itself with a mark in
// `additional_kwargs` that only it can set, so a stand-in returning the ack string is no longer the
// tool as far as `skipReplyRan` is concerned — which is the whole point of that change. It calls
// nothing, so the ctx below is never reached.
function realSkipTool(): StructuredToolInterface {
  const t = buildNativeTools({ client: {} as never, conversationId: 1 }, [
    SKIP_REPLY_TOOL,
  ]).find((x) => x.name === SKIP_REPLY_TOOL);
  if (!t) throw new Error("skip_reply is not in the native catalog");
  return t;
}

describe("agentNode tool-call limit (soft+hard)", () => {
  // Issue #454, review rounds 5 and 11. Silence is a TOOL CALL now, so the graph loops back with the
  // tool's result and asks the model AGAIN — and round 5 only stopped that round from being told
  // "Conclua agora: responda ao cliente". The round itself was the defect: whatever the model writes
  // there goes to the customer, and on the proactive path that is an unsolicited message, which the
  // sentinel made impossible by being the final text. The decision is terminal now: no further round
  // at all. The COUNT is untouched, so the cap still bounds a model that loops on skip_reply.
  test("the turn ends on the silence decision: the model is not asked again", async () => {
    const skipTool = realSkipTool();
    // One skip_reply call, then an empty answer — the shape a silent turn actually has.
    class SkipThenSilentModel {
      boundSystemPrompts: string[] = [];
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            n++;
            self.boundSystemPrompts.push(String(messages[0]?.content ?? ""));
            if (n === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: "skip_reply", args: {}, id: "c1" }],
              });
            }
            return new AIMessage("");
          },
        };
      }
    }
    const model = new SkipThenSilentModel();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool],
      maxToolCalls: 3,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("nada a fazer")] },
      { configurable: { thread_id: "limit-skip" } },
    );
    // ONE round: the decision ended the turn. The wrap-up instruction cannot land because there is
    // no round after it to land on (the control below proves the same cap DOES produce it).
    expect(model.boundSystemPrompts).toHaveLength(1);
    expect(
      model.boundSystemPrompts.some((p) =>
        p.includes("[Sistema] Você já usou"),
      ),
    ).toBe(false);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // The defect round 11 named, in the shape that reaches a person: the round after the decision is
  // where a follow-up that chose silence writes to the customer anyway. Well below the cap, so no
  // limit is involved — only the decision.
  test("a model that would speak after skip_reply never gets the chance", async () => {
    const skipTool = realSkipTool();
    class SkipThenTalksAnyway {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            }
            return new AIMessage("Oi! Só passando para lembrar do seu boleto.");
          },
        };
      }
    }
    const model = new SkipThenTalksAnyway();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      { configurable: { thread_id: "silence-terminal" } },
    );
    expect(model.rounds).toBe(1);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // Round 9: the HARD limit is the other way the decision gets talked over. At `maxToolCalls: 1` the
  // budget is spent by the very round that chose silence, and that path exists to force a TEXT
  // answer — it invokes the raw model with no tools bound. A deliberate silence became a message.
  test("the hard limit does not force text out of a turn that chose silence", async () => {
    const skipTool = realSkipTool();
    class SkipThenWouldSpeakModel {
      rawInvokes = 0;
      // The raw path is what the hard limit reaches for, and it is what must NOT run here.
      async invoke(): Promise<AIMessage> {
        this.rawInvokes++;
        return new AIMessage("texto que o cliente não deveria receber");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(): Promise<AIMessage> {
            n++;
            if (n === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: "skip_reply", args: {}, id: "c1" }],
              });
            }
            return self.invoke();
          },
        };
      }
    }
    const model = new SkipThenWouldSpeakModel();
    const hits: Array<{ maxToolCalls: number; toolCalls: number }> = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool],
      maxToolCalls: 1,
      onToolLimit: (info) => hits.push(info),
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("nada a fazer")] },
      { configurable: { thread_id: "limit-hard-skip" } },
    );
    // The turn ends silent, the raw model never spoke, and the call still COUNTED — which is what
    // keeps a model that loops on skip_reply bounded.
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    expect(model.rawInvokes).toBe(0);
    expect(hits).toEqual([{ maxToolCalls: 1, toolCalls: 1 }]);
  });

  // Round 10: the SAME name, the opposite outcome. `skip_reply` is a native name, so an operator may
  // declare a precondition on it (`isGuardableToolName`); unmet, the wrapper returns a normal tool
  // result under that name telling the model to carry on. Read by name that is a decision to stay
  // silent, and at `maxToolCalls: 1` the turn then ends with NO text — a customer left waiting by
  // the guard that was supposed to make the agent more careful.
  test("a refused skip_reply is not silence: the hard limit still forces an answer", async () => {
    const refusal = unmetPreconditionMessage(SKIP_REPLY_TOOL, {
      kind: "attribute",
      scope: "conversation",
      key: "cpf",
    });
    const guardedSkip = tool(async () => refusal, {
      name: SKIP_REPLY_TOOL,
      description: "skip",
      schema: z.object({}),
    });
    class SkipRefusedThenSpeaks {
      rawInvokes = 0;
      async invoke(): Promise<AIMessage> {
        this.rawInvokes++;
        return new AIMessage("Claro! Me confirma seu CPF?");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(): Promise<AIMessage> {
            n++;
            if (n === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            }
            return self.invoke();
          },
        };
      }
    }
    const model = new SkipRefusedThenSpeaks();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [guardedSkip],
      maxToolCalls: 1,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("quero a segunda via")] },
      { configurable: { thread_id: "limit-hard-skip-refused" } },
    );
    expect(model.rawInvokes).toBe(1);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Claro! Me confirma seu CPF?",
    );
  });

  // Round 13. A model can put text in the very message that calls `skip_reply`, and that text is
  // never delivered — the runtime posts the LAST assistant message, which is the empty one the turn
  // ends on. Left in the channel it is a sentence the customer never saw, read by the next turn as
  // something they were told: the false memory this whole family is about, arriving through the
  // silence protocol instead of through a refusal.
  test("text written beside the decision does not stay in the channel", async () => {
    const skipTool = realSkipTool();
    const NARRATION = "Vou deixar quieto por ora.";
    class TalksWhileSkipping {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            return new AIMessage({
              id: "ai-skip-1",
              content: NARRATION,
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              response_metadata: { finish_reason: "tool_calls" },
              usage_metadata: {
                input_tokens: 20,
                output_tokens: 10,
                total_tokens: 30,
              },
            });
          },
        };
      }
    }
    const model = new TalksWhileSkipping();
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      { configurable: { thread_id: "silence-narration" } },
    );
    expect(model.rounds).toBe(1);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    // Gone from the CHANNEL, which is the copy the next turn reads back.
    const state = await buildThreadStateGraph(checkpointer).getState({
      configurable: { thread_id: "silence-narration" },
    });
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(messages.length).toBeGreaterThan(0);
    expect(
      messages.filter((m) => JSON.stringify(m.content).includes("quieto")),
    ).toEqual([]);
    // The tool call and its result stay: the results already in the channel name that call, and an
    // orphaned `tool_call_id` is a provider error on the next turn.
    expect(
      messages.some((m) => ((m as AIMessage).tool_calls?.length ?? 0) > 0),
    ).toBe(true);
    expect(messages.some((m) => m.getType() === "tool")).toBe(true);
    // ...and so does everything BUT the content. Rebuilding the message from its id and content
    // alone drops the model's own usage and response fields, which is a second edit nobody asked
    // for — content is the only thing this rule may change.
    const rewritten = messages.find((m) => m.id === "ai-skip-1") as AIMessage;
    expect(rewritten.response_metadata?.finish_reason).toBe("tool_calls");
    expect(rewritten.usage_metadata?.total_tokens).toBe(30);
    // AN EMPTY BLOCK LIST, never `""`. This message keeps its tool calls, so it stays in the history
    // the model is sent — and `@langchain/anthropic` renders string content as a text block, which
    // Anthropic refuses when empty. An empty list renders no text block at all.
    expect(rewritten.content).toEqual([]);
    expect(contentToText(rewritten.content)).toBe("");
  });

  // Round 20, and it is where rounds 13 and 18 meet. A PARALLEL batch is not terminal, so the
  // narration written beside the decision no longer went out through the branch that blanks it —
  // and the turn could still finish silent, leaving that text standing as something the customer
  // was told.
  test("narration beside a parallel skip is blanked even without ending there", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class NarratesThenGoesQuiet {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                id: "ai-par-1",
                content: "Só vou reagir e ficar quieto.",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const model = new NarratesThenGoesQuiet();
    const checkpointer = new MemorySaver();
    const cfg = { configurable: { thread_id: "parallel-narration" } };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      cfg,
    );
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(messages.length).toBeGreaterThan(0);
    expect(
      messages.filter((m) => JSON.stringify(m.content).includes("quieto")),
    ).toEqual([]);
    // The reaction's own record stays: it really happened.
    expect(messages.some((m) => m.getType() === "tool")).toBe(true);
  });

  // Round 22. At the hard limit the graph invokes the RAW model with no tools bound, to force a text
  // answer — and round 18 made a parallel batch non-terminal, so a model that chose silence and had
  // a companion to inspect landed exactly there. Round 9 already named that defect; this is the same
  // one arriving through the parallel door. The budget stops the tools that ACT and leaves the one
  // that does not, so the model can reaffirm silence after seeing the companion's result.
  test("the hard limit leaves a silent turn the option to stay silent", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    const boundAtLimit: string[][] = [];
    class ReaffirmsSilence {
      rawInvokes = 0;
      rounds = 0;
      // The raw path is what forces text, and it must NOT be what runs here.
      async invoke(): Promise<AIMessage> {
        this.rawInvokes++;
        return new AIMessage("texto que o cliente não pediu");
      }
      bindTools(tls: unknown) {
        const self = this;
        const names = (tls as { name: string }[]).map((t) => t.name);
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            // The round the hard limit runs: only the inert tool is on offer, and the model takes it.
            boundAtLimit.push(names);
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const model = new ReaffirmsSilence();
    const hits: Array<{ maxToolCalls: number; toolCalls: number }> = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      // Spent by the parallel batch itself.
      maxToolCalls: 2,
      onToolLimit: (info) => hits.push(info),
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "hard-limit-parallel-silence" } },
    );
    expect(model.rawInvokes).toBe(0);
    expect(boundAtLimit).toEqual([[SKIP_REPLY_TOOL]]);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    // ONCE. The cap is one event — the turn ran out of budget — and its handlers write an operator
    // line and can page. Two rounds now cross the limit (the batch, then the reaffirmation), and
    // reporting both meant two warnings for one event, the second describing a round that spent
    // nothing (round 23).
    expect(hits).toEqual([{ maxToolCalls: 2, toolCalls: 2 }]);
  });

  // ...and the same round may ANSWER instead, which is what the customer needs when the companion
  // failed. The option is the point; the outcome is the model's.
  test("the hard limit still lets that turn answer if it wants to", async () => {
    const skipTool = realSkipTool();
    const reactTool = failableTool(async () => toolFailure("could not react"), {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class AnswersAfterAFailedReaction {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("nunca deveria rodar cru");
      }
      bindTools(_tls: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            return new AIMessage("Recebido, obrigado!");
          },
        };
      }
    }
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new AnswersAfterAFailedReaction() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 2,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "hard-limit-parallel-answer" } },
    );
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Recebido, obrigado!",
    );
  });

  // Round 22, the other half: the blanking is a reducer update that lands AFTER the model call, so
  // the extra round a parallel batch buys would otherwise still be SENT the sentence the customer
  // never received — and the model can lean on it, or repeat it, in the answer that does go out.
  test("the extra round is not shown the narration it is about to lose", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    const seenNarration: boolean[] = [];
    class NarratesThenIsAskedAgain {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tls: unknown) {
        const self = this;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                id: "ai-sent-1",
                content: "Só vou reagir e ficar quieto.",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            seenNarration.push(
              messages.some((m) =>
                JSON.stringify(m.content).includes("quieto"),
              ),
            );
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new NarratesThenIsAskedAgain() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "narration-not-sent" } },
    );
    expect(seenNarration).toEqual([false]);
  });

  // Round 26. A provider can emit a good `skip_reply` beside a call whose arguments do not parse, and
  // LangChain files that one under `invalid_tool_calls` — invisible to a check that reads
  // `tool_calls`. The batch then looked like nothing but the decision, the turn ended, and the model
  // never got the round where it would have seen the failure and answered.
  test("a malformed companion call is a companion", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({ emoji: z.string() }),
    });
    class SkipsBesideAMalformedCall {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                id: "ai-inv-1",
                content: "Vou reagir e sumir.",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
                invalid_tool_calls: [
                  {
                    name: "react_to_message",
                    args: "{ emoji: ",
                    id: "c2",
                    error: "Malformed args.",
                  },
                ],
              });
            }
            return new AIMessage("Recebido, obrigado!");
          },
        };
      }
    }
    const model = new SkipsBesideAMalformedCall();
    const checkpointer = new MemorySaver();
    const cfg = { configurable: { thread_id: "malformed-companion" } };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      cfg,
    );
    // The turn did NOT end on the decision, and the customer got the answer.
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Recebido, obrigado!",
    );
    // The narration is still blanked, and the malformed call survives the rebuild: it is part of
    // what the model asked for, and dropping it erases the record of a call that failed to parse.
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    const rewritten = messages.find((m) => m.id === "ai-inv-1") as AIMessage;
    expect(contentToText(rewritten.content)).toBe("");
    expect(rewritten.invalid_tool_calls?.map((c) => c.name)).toEqual([
      "react_to_message",
    ]);
  });

  // Round 27. A provider can return blocks BESIDE the text, and Anthropic's `thinking` /
  // `redacted_thinking` are signed and must be replayed unchanged before the tool result they
  // precede — so emptying the block list deletes protocol data and the very next round fails at the
  // provider. And for models served over the Responses API, `@langchain/openai` replays the raw
  // `output` array from `response_metadata` rather than `content`, so blanking `content` alone hands
  // the narration back anyway. Text is the only thing this rule may remove, wherever it lives.
  test("blanking removes the text and nothing else", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class ThinksThenSkips {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                id: "ai-think-1",
                content: [
                  { type: "thinking", thinking: "hmm", signature: "sig-abc" },
                  { type: "text", text: "Vou só reagir." },
                ],
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
                response_metadata: {
                  output: [
                    { type: "reasoning", id: "rs_1", summary: [] },
                    {
                      type: "message",
                      role: "assistant",
                      content: [
                        { type: "output_text", text: "Vou só reagir." },
                      ],
                    },
                    { type: "function_call", name: SKIP_REPLY_TOOL, id: "fc1" },
                  ],
                },
              });
            }
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const checkpointer = new MemorySaver();
    const cfg = { configurable: { thread_id: "blank-text-only" } };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new ThinksThenSkips() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    await graph.invoke({ messages: [new HumanMessage("👍")] }, cfg);
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    const rewritten = messages.find((m) => m.id === "ai-think-1") as AIMessage;
    // The signed thinking block survives; the text is gone.
    expect(rewritten.content).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig-abc" },
    ]);
    // ...and so does the raw provider output, minus its text part. `reasoning` and `function_call`
    // are untouched: they carry state the provider needs back.
    const out = rewritten.response_metadata?.output as Array<
      Record<string, unknown>
    >;
    expect(out.map((o) => o.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
    expect(out[1]?.content).toEqual([]);
    expect(JSON.stringify(rewritten)).not.toContain("Vou só reagir");
  });

  // The scope, pinned: a preamble beside an ORDINARY call is followed by a reply that may lean on
  // it, and rewriting the history of every tool-calling turn is a different change. Only the
  // decision to say nothing is rewritten here.
  test("a preamble beside an ordinary tool call is left alone", async () => {
    const echo = tool(async () => "pedido 42: enviado", {
      name: "search_order",
      description: "search",
      schema: z.object({}),
    });
    class PreamblesThenAnswers {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                id: "ai-pre-1",
                content: "Vou verificar seu pedido.",
                tool_calls: [{ name: "search_order", args: {}, id: "c1" }],
              });
            }
            return new AIMessage("Seu pedido 42 já foi enviado.");
          },
        };
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new PreamblesThenAnswers() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [echo],
      maxToolCalls: 10,
    });
    await graph.invoke(
      { messages: [new HumanMessage("cadê meu pedido?")] },
      { configurable: { thread_id: "ordinary-preamble" } },
    );
    const state = await buildThreadStateGraph(checkpointer).getState({
      configurable: { thread_id: "ordinary-preamble" },
    });
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(
      messages.filter((m) => JSON.stringify(m.content).includes("verificar")),
    ).not.toEqual([]);
  });

  // Round 17. `skip_reply` beside `react_to_message` is the documented way to answer with a reaction
  // ALONE — so the reaction IS the reply, and when it fails, ending the turn on the skip leaves the
  // customer with nothing at all. The model has to see that result and decide again, which is what
  // every other failed tool call already gets. (Round 18 widened the rule to every companion, for
  // the reason below; this case is what made the question visible.)
  test("a companion tool that FAILED keeps the turn going", async () => {
    const skipTool = realSkipTool();
    const reactTool = failableTool(
      async () => toolFailure("could not react: the message is a reaction"),
      { name: "react_to_message", description: "react", schema: z.object({}) },
    );
    class SkipsWithABrokenReaction {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            return new AIMessage("Recebido, obrigado!");
          },
        };
      }
    }
    const model = new SkipsWithABrokenReaction();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "companion-failed" } },
    );
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Recebido, obrigado!",
    );
  });

  // ...and a companion the operator's own rule REFUSED is the same thing to the customer: the
  // reaction did not happen, so ending on the skip leaves them with nothing. Round 17 read that off
  // the RESULT; round 18 showed a result cannot answer it (a tool may decline through an ordinary
  // success string), so the rule moved to the CALLS. This case is covered by the same rule now, and
  // it stays because it is the shape an operator can actually configure.
  test("a companion tool that was REFUSED keeps the turn going", async () => {
    const skipTool = realSkipTool();
    const reactTool = guardedTool(
      tool(async () => "reacted with 👍", {
        name: "react_to_message",
        description: "react",
        schema: z.object({}),
      }),
      { kind: "attribute", scope: "conversation", key: "cpf" },
      // No attributes at all, so the condition is unmet.
      async () => ({ conversationAttributes: {}, contactAttributes: {} }),
    );
    class SkipsWithARefusedReaction {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            return new AIMessage("Me confirma seu CPF?");
          },
        };
      }
    }
    const model = new SkipsWithARefusedReaction();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "companion-refused" } },
    );
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Me confirma seu CPF?",
    );
  });

  // The control, and round 18 changed what it controls FOR. A batch that called something else has
  // produced information the model has not seen, so it decides again — whether that companion
  // worked or not, because a tool can decline through a perfectly ordinary success result and no
  // reader can tell. What the extra round must still deliver is SILENCE when the model asks for it
  // alone: the decision is terminal there, and the raw model never speaks.
  test("a companion that worked costs one round and still ends silent", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class SkipsWithAReaction {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("nunca deveria falar");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            // Having seen the reaction land, the model asks for silence ALONE — and that is the
            // batch the turn may end on.
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const model = new SkipsWithAReaction();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "companion-ok" } },
    );
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // Round 17, the other half. The terminal marker is an EMPTY assistant message, and it stays in the
  // channel on purpose — it is what keeps `lastAssistantText` reading "" instead of the skip tool's
  // acknowledgement, which would otherwise go to the customer as the reply. What it must not do is
  // reach the provider: `@langchain/anthropic` renders string content as a text block and Anthropic
  // refuses an empty one, so a thread that accumulated one would stop answering entirely.
  test("the empty turn stays in the channel and never reaches the model", async () => {
    const skipTool = realSkipTool();
    const seen: number[] = [];
    class CountsEmptyAssistantTurns {
      round = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            seen.push(
              messages.filter(
                (m) =>
                  m.getType() === "ai" &&
                  ((m as AIMessage).tool_calls?.length ?? 0) === 0 &&
                  String(m.content).trim() === "",
              ).length,
            );
            self.round++;
            if (self.round === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            }
            return new AIMessage("Oi de novo!");
          },
        };
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new CountsEmptyAssistantTurns() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool],
      maxToolCalls: 10,
    });
    const cfg = { configurable: { thread_id: "empty-turn-filtered" } };
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    // A SECOND customer turn on the same thread, which is where the invalid history would land.
    await graph.invoke({ messages: [new HumanMessage("e aí?")] }, cfg);
    // The channel kept it...
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(
      messages.filter(
        (m) =>
          m.getType() === "ai" &&
          ((m as AIMessage).tool_calls?.length ?? 0) === 0 &&
          String(m.content).trim() === "",
      ).length,
    ).toBeGreaterThan(0);
    // ...and the model never saw one, on any round.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual(seen.map(() => 0));
  });

  // Round 7: parallel tool calls. `skip_reply` alongside `react_to_message` is the documented way to
  // answer with a reaction alone, and whichever result lands last is an ordering accident — reading
  // only the last one made the wrap-up instruction depend on it.
  test("skip_reply counts even when another tool's result lands last", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reagiu", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class ParallelThenSilentModel {
      boundSystemPrompts: string[] = [];
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            n++;
            self.boundSystemPrompts.push(String(messages[0]?.content ?? ""));
            if (n === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "skip_reply", args: {}, id: "c1" },
                  { name: "react_to_message", args: {}, id: "c2" },
                ],
              });
            }
            return new AIMessage("");
          },
        };
      }
    }
    const model = new ParallelThenSilentModel();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 3,
    });
    await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      { configurable: { thread_id: "limit-parallel" } },
    );
    // The batch was READ, not just its last result: the reaction landed AFTER the skip and the round
    // that follows was still not told to answer the customer. Two rounds now, because a batch that
    // called something else is not terminal (round 18) — which is exactly why reading the whole
    // batch still matters: the wrap-up instruction would otherwise land on the round after a
    // decision to stay quiet.
    expect(model.boundSystemPrompts.length).toBeGreaterThanOrEqual(2);
    expect(
      model.boundSystemPrompts.some((p) =>
        p.includes("[Sistema] Você já usou"),
      ),
    ).toBe(false);
  });

  test("forces a no-tools answer at the hard limit and fires onToolLimit", async () => {
    const model = new ToolLoopModel();
    const hits: Array<{ maxToolCalls: number; toolCalls: number }> = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [noopTool],
      maxToolCalls: 3,
      onToolLimit: (info) => hits.push(info),
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("faça muitas coisas")] },
      { configurable: { thread_id: "limit-1" } },
    );
    // Ended in a text answer (the raw model), not a GraphRecursionError.
    const last = result.messages.at(-1);
    expect(last?.content).toBe("resposta final");
    expect(model.rawInvokes).toBe(1);
    // Hard limit fired exactly once, at maxToolCalls executions.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ maxToolCalls: 3, toolCalls: 3 });
    // The soft "wrap up" instruction was appended once the budget got close (N-2 = 1 execution in).
    expect(
      model.boundSystemPrompts.some((p) =>
        p.includes("[Sistema] Você já usou"),
      ),
    ).toBe(true);
    // The first invoke (0 executions) used the plain prompt.
    expect(model.boundSystemPrompts[0]).toBe("PROMPT");
  });
});

// The ceiling is wired through the node, so what it is worth is measured where it matters: in the
// list the model actually receives. See tests/graph/history-window.test.ts for the rule itself.
describe("agentNode history ceiling", () => {
  // Eight turns of a chatty contact. Every message is long enough that a small ceiling has to cut.
  const seed = (): BaseMessage[] => {
    const out: BaseMessage[] = [];
    for (let i = 0; i < 8; i++) {
      out.push(new HumanMessage(`pergunta ${i} ${"palavra ".repeat(200)}`));
      out.push(new AIMessage(`resposta ${i} ${"palavra ".repeat(200)}`));
    }
    return out;
  };

  test("without a ceiling the whole thread travels", async () => {
    const model = new RecordingModel();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
    });
    await graph.invoke(
      { messages: seed() },
      { configurable: { thread_id: "ceiling-off" } },
    );
    // 16 seeded + the system prompt the node prepends.
    expect(model.seen[0]).toHaveLength(17);
  });

  test("with a ceiling the oldest attendances are dropped and the trim is announced", async () => {
    const model = new RecordingModel();
    const trims: Array<{ kept: number; dropped: number; tokens: number }> = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      maxHistoryTokens: 2_000,
      onHistoryTrim: (info) => trims.push(info),
    });
    await graph.invoke(
      { messages: seed() },
      { configurable: { thread_id: "ceiling-on" } },
    );
    const seen = model.seen[0];
    expect(seen).toBeDefined();
    if (!seen) return;
    expect(seen.length).toBeLessThan(17);
    // One system prompt, first, and the window opens on a customer message right after it.
    expect(seen[0]?.getType()).toBe("system");
    expect(seen[1]?.getType()).toBe("human");
    // The turn being answered is never the thing that gets dropped.
    expect(seen.at(-1)?.content).toContain("resposta 7");
    expect(String(seen[1]?.content)).not.toContain("pergunta 0");
    expect(trims).toHaveLength(1);
    expect(trims[0]?.dropped).toBeGreaterThan(0);
    expect(trims[0]?.kept).toBe(seen.length - 1);
    expect(trims[0]?.tokens).toBeGreaterThan(0);
  });

  test("a ceiling the thread already fits under changes nothing and stays silent", async () => {
    const model = new RecordingModel();
    const trims: unknown[] = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      maxHistoryTokens: 1_000_000,
      onHistoryTrim: (info) => trims.push(info),
    });
    await graph.invoke(
      { messages: seed() },
      { configurable: { thread_id: "ceiling-slack" } },
    );
    expect(model.seen[0]).toHaveLength(17);
    expect(trims).toHaveLength(0);
  });
});
