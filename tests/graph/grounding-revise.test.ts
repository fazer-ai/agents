import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";
import { contentToText } from "@/graph/message-text";
import { FOLLOWUP_SKIP_SENTINEL } from "@/graph/silence";
import { ScriptedSilenceModel } from "../utils/scripted-models";

// The graph's side of the factual-grounding `revise`: the review is asked about the answer that would
// end the turn, and a note back buys exactly one more answer, which is the one the thread keeps.

const catalogo = tool(async () => "Portões: 18h.", {
  name: "catalogo",
  description: "catálogo",
  schema: z.object({}),
});
const NOTE = "[Sistema] Revisão factual: NOTA-DE-TESTE";

async function run(
  model: ScriptedSilenceModel,
  review: (turn: BaseMessage[], reply: string) => Promise<string | null>,
  provider = "openai",
  opts: {
    onReplyRevised?: (text: string) => void;
    history?: BaseMessage[];
    recoversReply?: () => boolean;
  } = {},
) {
  const graph = buildAgentGraph({
    primary: { provider, model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer: new MemorySaver(),
    tools: [catalogo],
    reviewReply: review,
    onReplyRevised: opts.onReplyRevised,
    recoversReply: opts.recoversReply ?? (() => true),
  });
  const out = await graph.invoke(
    {
      messages: opts.history ?? [
        new HumanMessage("Que horas abrem os portões?"),
      ],
    },
    { configurable: { thread_id: `g-${Math.random()}` } },
  );
  return out.messages as BaseMessage[];
}

const text = (m: BaseMessage | undefined) =>
  contentToText(m?.content ?? "").trim();

describe("reviewReply", () => {
  test("a note asks the model once more, and only the revised answer stays in the thread", async () => {
    const model = new ScriptedSilenceModel([
      { text: "", calls: [{ name: "catalogo", args: {} }] },
      { text: "Abre às 16h." },
      { text: "Abre às 18h." },
    ]);
    const seen: BaseMessage[][] = [];
    const messages = await run(model, async (turn) => {
      seen.push(turn);
      return NOTE;
    });
    expect(seen).toHaveLength(1);
    expect(text(seen[0]?.at(-1))).toBe("Abre às 16h.");
    expect(model.seen).toHaveLength(3);
    const last = model.seen[2]?.at(-1);
    expect(last?.getType()).toBe("system");
    expect(text(last)).toBe(NOTE);
    expect(text(messages.at(-1))).toBe("Abre às 18h.");
    expect(messages.some((m) => text(m) === "Abre às 16h.")).toBe(false);
  });

  test("where a late system message is not accepted, the note rides in the system prompt", async () => {
    const model = new ScriptedSilenceModel([
      { text: "Abre às 16h." },
      { text: "Abre às 18h." },
    ]);
    await run(model, async () => NOTE, "google");
    const second = model.seen[1] ?? [];
    expect(second.filter((m) => m.getType() === "system")).toHaveLength(1);
    expect(text(second[0])).toContain(NOTE);
  });

  test("no note, no second answer; a revised answer is never reviewed again", async () => {
    const model = new ScriptedSilenceModel([{ text: "Abre às 18h." }]);
    let asked = 0;
    await run(model, async () => {
      asked++;
      return null;
    });
    expect(model.seen).toHaveLength(1);
    expect(asked).toBe(1);
    const again = new ScriptedSilenceModel([
      { text: "Abre às 16h." },
      { text: "", calls: [{ name: "catalogo", args: {} }] },
      { text: "Abre às 18h." },
    ]);
    let reviews = 0;
    await run(again, async () => {
      reviews++;
      return NOTE;
    });
    expect(reviews).toBe(1);
    expect(again.seen).toHaveLength(3);
  });

  test("a reply written beside the call and then recovered is the one reviewed", async () => {
    const model = new ScriptedSilenceModel([
      { text: "Abre às 16h.", calls: [{ name: "catalogo", args: {} }] },
      { text: "" },
    ]);
    const replies: string[] = [];
    await run(model, async (_turn, reply) => {
      replies.push(reply);
      return null;
    });
    expect(replies).toEqual(["Abre às 16h."]);
  });

  test("the rewrite is asked without tools, and its text is reported", async () => {
    const asked: string[] = [];
    const model = new ScriptedSilenceModel([
      { text: "Abre às 16h." },
      { text: "" },
    ]);
    const raw = model.invoke.bind(model);
    model.invoke = async (m: BaseMessage[]) => {
      asked.push("raw");
      return raw(m);
    };
    const revised: string[] = [];
    await run(model, async () => NOTE, "openai", {
      onReplyRevised: (t) => revised.push(t),
    });
    expect([asked, revised]).toEqual([["raw"], [""]]);
  });

  test("a stalled turn still reviews the reply the runtime would recover", async () => {
    const model = new ScriptedSilenceModel([
      { text: "", calls: [{ name: "catalogo", args: {} }] },
    ]);
    const replies: string[] = [];
    const revised: string[] = [];
    const messages = await run(
      model,
      async (_turn, reply) => {
        replies.push(reply);
        return NOTE;
      },
      "openai",
      {
        onReplyRevised: (t) => revised.push(t),
        history: [
          new HumanMessage("Que horas abrem os portões?"),
          new AIMessage({
            content: "Abre às 16h.",
            tool_calls: [{ name: "catalogo", args: {}, id: "call_1_0" }],
          }),
          new ToolMessage({
            content: "Portões: 18h.",
            tool_call_id: "call_1_0",
            name: "catalogo",
          }),
        ],
      },
    );
    expect([replies, revised]).toEqual([["Abre às 16h."], [""]]);
    expect(messages.some((m) => text(m) === "Abre às 16h.")).toBe(false);
  });

  test("a round that calls tools, or says nothing, is not reviewed", async () => {
    const model = new ScriptedSilenceModel([
      { text: "", calls: [{ name: "catalogo", args: {} }] },
      { text: "" },
    ]);
    const seen: BaseMessage[][] = [];
    await run(model, async (turn) => {
      seen.push(turn);
      return NOTE;
    });
    expect(seen).toHaveLength(0);
    expect(
      ((model.seen[0] ?? []).at(-1) as AIMessage | undefined)?.getType(),
    ).toBe("human");
  });

  test("an answer that is only the silence token is not a reply, so nothing is reviewed", async () => {
    const model = new ScriptedSilenceModel([
      { text: "", calls: [{ name: "catalogo", args: {} }] },
      { text: FOLLOWUP_SKIP_SENTINEL },
    ]);
    let asked = 0;
    await run(model, async () => {
      asked++;
      return NOTE;
    });
    expect(asked).toBe(0);
    expect(model.seen).toHaveLength(2);
  });

  test("a revised recovered draft leaves the thread, and its call stays", async () => {
    const model = new ScriptedSilenceModel([
      { text: "Abre às 16h.", calls: [{ name: "catalogo", args: {} }] },
      { text: "" },
      { text: "Abre às 18h." },
    ]);
    const messages = await run(model, async () => NOTE);
    expect(messages.some((m) => text(m) === "Abre às 16h.")).toBe(false);
    expect(text(messages.at(-1))).toBe("Abre às 18h.");
    const caller = messages.find(
      (m) => ((m as AIMessage).tool_calls?.length ?? 0) > 0,
    ) as AIMessage | undefined;
    expect(caller?.tool_calls?.[0]?.name).toBe("catalogo");
  });

  test("a reply the caller would not recover is not reviewed", async () => {
    const model = new ScriptedSilenceModel([
      { text: "Abre às 16h.", calls: [{ name: "catalogo", args: {} }] },
      { text: "" },
    ]);
    let asked = 0;
    await run(
      model,
      async () => {
        asked++;
        return NOTE;
      },
      "openai",
      { recoversReply: () => false },
    );
    expect(asked).toBe(0);
  });
});
