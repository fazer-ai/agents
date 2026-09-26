import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import {
  buildAgentGraph,
  SILENCE_RETRY_MARK,
  type SilenceRetryInfo,
} from "@/graph/graph";
import { contentToText } from "@/graph/message-text";
import { SKIP_REPLY_TOOL } from "@/graph/silence";
import { buildNativeTools } from "@/graph/tools/native";
import { ScriptedSilenceModel } from "../utils/scripted-models";

// ISSUE #885. A reactive turn that ends with nothing for the customer, no handoff and no
// `skip_reply` is asked ONCE more, in the same round, with a late system instruction naming both
// exits: answer, or declare the silence. Measured on 51 real turns read from the checkpoint, most of
// them are correct silences after a thank-you that were never declared, and a few are customers who
// were owed an answer — so the instruction must not push the model into replying to a thank-you.

const noopTool = tool(async () => "feito", {
  name: "set_labels",
  description: "labels",
  schema: z.object({}),
});

function realSkipTool(): StructuredToolInterface {
  const t = buildNativeTools({ client: {} as never, conversationId: 1 }, [
    SKIP_REPLY_TOOL,
  ]).find((x) => x.name === SKIP_REPLY_TOOL);
  if (!t) throw new Error("skip_reply is not in the native catalog");
  return t;
}

const carriesRetry = (round: BaseMessage[] | undefined) =>
  (round ?? []).some((m) =>
    contentToText(m.content).includes(SILENCE_RETRY_MARK),
  );

async function run(
  model: ScriptedSilenceModel,
  opts: {
    retrySilence?: () => boolean;
    provider?: string;
    tools?: StructuredToolInterface[];
    thread?: string;
    noReplyChannel?: boolean;
    maxToolCalls?: number;
    history?: BaseMessage[];
  } = {},
) {
  const retries: SilenceRetryInfo[] = [];
  const checkpointer = new MemorySaver();
  const graph = buildAgentGraph({
    primary: { provider: opts.provider ?? "openai", model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer,
    tools: opts.tools ?? [noopTool, realSkipTool()],
    retrySilence: opts.retrySilence,
    onSilenceRetry: (info) => retries.push(info),
    noReplyChannel: opts.noReplyChannel,
    maxToolCalls: opts.maxToolCalls,
  });
  const thread = opts.thread ?? "t-885";
  const out = await graph.invoke(
    { messages: opts.history ?? [new HumanMessage("Muito obrigada!")] },
    { configurable: { thread_id: thread } },
  );
  return { out, retries, messages: out.messages as BaseMessage[] };
}

const lastText = (messages: BaseMessage[]) =>
  contentToText((messages.at(-1) as AIMessage).content).trim();

describe("unexplained silence: one retry with both exits (issue #885)", () => {
  test("an empty answer is asked again once, and the second answer is the turn's", async () => {
    const model = new ScriptedSilenceModel([
      { text: "" },
      { text: "Por nada! Bom evento." },
    ]);
    const { retries, messages } = await run(model, {
      retrySilence: () => true,
    });
    expect(model.seen).toHaveLength(2);
    expect(lastText(messages)).toBe("Por nada! Bom evento.");
    expect(retries).toEqual([{ outcome: "answered" }]);
  });

  test("the instruction names both exits and travels as a late system message", async () => {
    const model = new ScriptedSilenceModel([{ text: "" }, { text: "Ok!" }]);
    await run(model, { retrySilence: () => true });
    const second = model.seen[1] ?? [];
    const last = second.at(-1);
    expect(last?.getType()).toBe("system");
    const said = contentToText(last?.content ?? "");
    expect(said).toContain(SILENCE_RETRY_MARK);
    expect(said).toContain("skip_reply");
    expect(said).toMatch(/responda/i);
    // Never in a human message: the role is what a customer cannot forge.
    expect(
      second.some(
        (m) =>
          m.getType() === "human" &&
          contentToText(m.content).includes(SILENCE_RETRY_MARK),
      ),
    ).toBe(false);
    // The empty answer it replaces is not in what the retry is sent.
    expect(second.filter((m) => m.getType() === "ai")).toHaveLength(0);
  });

  test("where a late system message is not accepted, it rides in the one system prompt", async () => {
    const model = new ScriptedSilenceModel([{ text: "" }, { text: "Ok!" }]);
    await run(model, { retrySilence: () => true, provider: "google" });
    const second = model.seen[1] ?? [];
    expect(second.filter((m) => m.getType() === "system")).toHaveLength(1);
    expect(second[0]?.getType()).toBe("system");
    expect(contentToText(second[0]?.content ?? "")).toContain(
      SILENCE_RETRY_MARK,
    );
  });

  test("neither the instruction nor the empty answer is persisted in the thread", async () => {
    const model = new ScriptedSilenceModel([{ text: "" }, { text: "Ok!" }]);
    const { messages } = await run(model, { retrySilence: () => true });
    expect(messages.map((m) => m.getType())).toEqual(["human", "ai"]);
    expect(
      messages.some((m) =>
        contentToText(m.content).includes(SILENCE_RETRY_MARK),
      ),
    ).toBe(false);
  });

  test("empty twice: two calls, never a third, and the outcome says so", async () => {
    const model = new ScriptedSilenceModel([{ text: "" }, { text: "" }]);
    const { retries, messages } = await run(model, {
      retrySilence: () => true,
    });
    expect(model.seen).toHaveLength(2);
    expect(lastText(messages)).toBe("");
    expect(retries).toEqual([{ outcome: "empty" }]);
  });

  test("a retry that declares silence is honored, and the turn ends on it", async () => {
    const model = new ScriptedSilenceModel([
      { text: "" },
      {
        text: "",
        calls: [{ name: SKIP_REPLY_TOOL, args: { reason: "acknowledged" } }],
      },
    ]);
    const { retries, messages } = await run(model, {
      retrySilence: () => true,
    });
    expect(retries).toEqual([{ outcome: "skip_reply" }]);
    expect(
      messages.some(
        (m) =>
          m.getType() === "ai" &&
          ((m as AIMessage).tool_calls ?? []).some(
            (c) => c.name === SKIP_REPLY_TOOL,
          ),
      ),
    ).toBe(true);
    // No second retry on the round after the decision.
    expect(model.seen.filter(carriesRetry)).toHaveLength(1);
  });

  test("a retry that calls skip_reply beside another tool is a declared silence", async () => {
    const model = new ScriptedSilenceModel([
      { text: "" },
      {
        text: "",
        calls: [
          { name: SKIP_REPLY_TOOL, args: { reason: "acknowledged" } },
          { name: "set_labels", args: {} },
        ],
      },
    ]);
    const { retries } = await run(model, { retrySilence: () => true });
    expect(retries).toEqual([{ outcome: "skip_reply" }]);
  });

  test("the silence after tool calls is retried too (the common shape)", async () => {
    const model = new ScriptedSilenceModel([
      { text: "", calls: [{ name: "set_labels", args: {} }] },
      { text: "" },
      { text: "Combinado!" },
    ]);
    const { retries, messages } = await run(model, {
      retrySilence: () => true,
    });
    expect(model.seen).toHaveLength(3);
    expect(carriesRetry(model.seen[2])).toBe(true);
    expect(lastText(messages)).toBe("Combinado!");
    expect(retries).toEqual([{ outcome: "answered" }]);
  });

  test("at most once per turn, even when the retry goes back to tools", async () => {
    const model = new ScriptedSilenceModel([
      { text: "" },
      { text: "", calls: [{ name: "set_labels", args: {} }] },
      { text: "" },
    ]);
    const { retries } = await run(model, { retrySilence: () => true });
    expect(model.seen).toHaveLength(3);
    expect(model.seen.filter(carriesRetry)).toHaveLength(1);
    expect(retries).toEqual([{ outcome: "tools" }]);
  });

  test("off unless the caller asks for it", async () => {
    const model = new ScriptedSilenceModel([{ text: "" }, { text: "Oi" }]);
    const { retries } = await run(model);
    expect(model.seen).toHaveLength(1);
    expect(retries).toEqual([]);
  });

  test("the caller can refuse it at the moment it would run", async () => {
    const model = new ScriptedSilenceModel([{ text: "" }, { text: "Oi" }]);
    const { retries } = await run(model, { retrySilence: () => false });
    expect(model.seen).toHaveLength(1);
    expect(retries).toEqual([]);
  });

  test("a declared silence is not retried", async () => {
    const model = new ScriptedSilenceModel([
      {
        text: "",
        calls: [{ name: SKIP_REPLY_TOOL, args: { reason: "acknowledged" } }],
      },
    ]);
    const { retries } = await run(model, { retrySilence: () => true });
    expect(model.seen.some(carriesRetry)).toBe(false);
    expect(retries).toEqual([]);
  });

  // Issue #886 recovers text written earlier in the turn: that turn is not a silence.
  test("a reply written earlier in the turn is not a silence, and is not retried", async () => {
    const model = new ScriptedSilenceModel([
      {
        text: "O evento começa às 21h.",
        calls: [{ name: "set_labels", args: {} }],
      },
      { text: "" },
    ]);
    const { retries } = await run(model, { retrySilence: () => true });
    expect(model.seen).toHaveLength(2);
    expect(retries).toEqual([]);
  });

  test("a non-empty answer is never retried", async () => {
    const model = new ScriptedSilenceModel([{ text: "Olá!" }]);
    const { retries } = await run(model, { retrySilence: () => true });
    expect(model.seen).toHaveLength(1);
    expect(retries).toEqual([]);
  });
  test("a turn with no reply channel is never told to answer", async () => {
    const model = new ScriptedSilenceModel([{ text: "" }, { text: "Oi" }]);
    const { retries } = await run(model, {
      retrySilence: () => true,
      noReplyChannel: true,
    });
    expect(model.seen).toHaveLength(1);
    expect(retries).toEqual([]);
  });

  // At the hard limit the model runs without tools, so the instruction's `skip_reply` would be a
  // tool it cannot call.
  test("not at the hard tool limit", async () => {
    const model = new ScriptedSilenceModel([
      { text: "", calls: [{ name: "set_labels", args: {} }] },
      { text: "" },
      { text: "Oi" },
    ]);
    const { retries } = await run(model, {
      retrySilence: () => true,
      maxToolCalls: 1,
    });
    expect(model.seen).toHaveLength(2);
    expect(retries).toEqual([]);
  });

  // The thread is checkpointed per contact-inbox: a thank-you declared silent in an EARLIER turn is
  // in this history and says nothing about this one.
  test("a skip_reply from an earlier turn does not stop this turn's retry", async () => {
    const model = new ScriptedSilenceModel([{ text: "" }, { text: "Claro!" }]);
    const { retries } = await run(model, {
      retrySilence: () => true,
      history: [
        new HumanMessage("obrigado"),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: SKIP_REPLY_TOOL,
              args: { reason: "acknowledged" },
              id: "old_skip",
            },
          ],
        }),
        new ToolMessage({ content: "ok", tool_call_id: "old_skip" }),
        new AIMessage(""),
        new HumanMessage("e o horário do show?"),
      ],
    });
    expect(model.seen).toHaveLength(2);
    expect(retries).toEqual([{ outcome: "answered" }]);
  });

  test("without skip_reply granted, the instruction names only the exit that exists", async () => {
    const model = new ScriptedSilenceModel([{ text: "" }, { text: "Oi" }]);
    await run(model, { retrySilence: () => true, tools: [noopTool] });
    const said = contentToText(model.seen[1]?.at(-1)?.content ?? "");
    expect(said).toContain(SILENCE_RETRY_MARK);
    expect(said).not.toContain("skip_reply");
    expect(said).toMatch(/responda/i);
  });

  // A call the provider could not parse runs no tool and ends the turn: the customer is exactly as
  // unanswered, so it is retried like an empty answer.
  test("an answer whose only call was unparseable is retried", async () => {
    const model = new ScriptedSilenceModel([
      { text: "", invalid: true },
      { text: "Oi" },
    ]);
    const { retries } = await run(model, { retrySilence: () => true });
    expect(model.seen).toHaveLength(2);
    expect(retries).toEqual([{ outcome: "answered" }]);
  });
});
