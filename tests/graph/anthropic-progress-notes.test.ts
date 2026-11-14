import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import {
  hiddenNotesDetail,
  hiddenNotesThisTurn,
  LAST_MESSAGE_RULE,
  PROGRESS_UPDATES_BETA,
  progressNotesFetch,
  writesProgressNotes,
} from "@/graph/anthropic-progress-notes";
import { contentToText } from "@/graph/message-text";
import { parseModelConfig } from "@/graph/model-config";
import { createChatModel, type ResolvedModelConfig } from "@/graph/models";
import { buildModelAndGraph } from "@/graph/prepare";
import { makeConfig } from "../utils/agent-config";

// A local stand-in for the Anthropic Messages API, answering the way claude-sonnet-5-5 answered live:
// text written before a tool call comes back as a `thinking` block, empty under the default display
// and carrying a summary of the note under `display: "updates"`, which the API refuses without the
// beta (the measured 400). The 4.x line refuses `adaptive` altogether. `retired` makes the API refuse
// `updates` even with the beta, as it would once the beta is gone.

const NOTE =
  "O curso Horta em Casa tem 5 módulos e 20 aulas, com certificado ao final, e a matrícula está no link que eu deixei acima.";
const NO_ADAPTIVE = new Set(["claude-haiku-4-5"]);

type Seen = { body: Record<string, unknown>; beta: string | null };
const seen: Seen[] = [];
let retired = false;

const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};
const json = (status: number, body: unknown) =>
  new BunResponse(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
const apiError = (message: string) =>
  json(400, {
    type: "error",
    error: { type: "invalid_request_error", message },
  });

function answer({ body, beta }: Seen): Response {
  const model = String(body.model);
  const thinking = body.thinking as
    | { type?: string; display?: string }
    | undefined;
  if (thinking && NO_ADAPTIVE.has(model))
    return apiError("adaptive thinking is not supported on this model");
  const updates = thinking?.display === "updates";
  const betaOn = !!beta?.split(",").includes(PROGRESS_UPDATES_BETA);
  if (updates && (!betaOn || retired))
    return apiError(
      "thinking.adaptive.display: Input should be 'summarized', 'omitted'",
    );
  return json(200, {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [
      { type: "thinking", thinking: updates ? NOTE : "", signature: "sig" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "set_labels",
        input: { add: ["link-enviado"] },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 319 },
  });
}

let server: ReturnType<typeof Bun.serve>;
let prevBase: string | undefined;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method === "OPTIONS")
        return new BunResponse(null, { status: 204, headers: CORS });
      const s: Seen = {
        body: (await req.json()) as Record<string, unknown>,
        beta: req.headers.get("anthropic-beta"),
      };
      seen.push(s);
      return answer(s);
    },
  });
  prevBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = prevBase;
});

async function ask(model: string) {
  const before = seen.length;
  const cfg = parseModelConfig({ provider: "anthropic", model });
  const llm = createChatModel({ ...cfg, apiKey: "k", maxRetries: 0 });
  const messages: BaseMessage[] = [
    new SystemMessage("Você é a Júlia."),
    new HumanMessage("Quero ver o conteúdo do curso"),
  ];
  try {
    const reply = (await llm.invoke(messages)) as AIMessage;
    return { reply, messages, error: undefined, requests: seen.slice(before) };
  } catch (error) {
    return { reply: undefined, messages, error, requests: seen.slice(before) };
  }
}

describe("the Anthropic request asks for the hidden notes' summary", () => {
  test("a 5.5 model is asked with display updates and the beta, and the note comes back readable", async () => {
    const { reply, messages, error, requests } = await ask("claude-sonnet-5-5");
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
    // NOTE: toMatchObject, since the binding wrapper may add `block_binding` for a model another file
    // already taught it about (its memory is per process).
    expect(requests[0]?.body.thinking).toMatchObject({
      type: "adaptive",
      display: "updates",
    });
    expect(requests[0]?.beta?.split(",")).toContain(PROGRESS_UPDATES_BETA);
    const turn = [...messages, reply as AIMessage];
    expect(hiddenNotesThisTurn(turn)).toEqual([NOTE]);
    // The summary is never text: nothing that posts a reply reads it.
    expect(contentToText((reply as AIMessage).content)).toBe("");
  });

  for (const model of [
    "claude-haiku-5-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
  ])
    test(`${model} keeps today's request`, async () => {
      const { error, requests } = await ask(model);
      expect(error).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body.thinking).toBeUndefined();
      expect(requests[0]?.beta ?? "").not.toContain(PROGRESS_UPDATES_BETA);
    });

  test("a refused option is dropped for that model, and its later requests go out without it", async () => {
    retired = true;
    try {
      const first = await ask("claude-fable-5-1");
      expect(first.error).toBeUndefined();
      expect(first.requests).toHaveLength(2);
      expect(first.requests[1]?.body.thinking).toBeUndefined();
      const second = await ask("claude-fable-5-1");
      expect(second.error).toBeUndefined();
      expect(second.requests).toHaveLength(1);
      expect(second.requests[0]?.body.thinking).toBeUndefined();
    } finally {
      retired = false;
    }
  });
});

describe("progressNotesFetch leaves a chosen thinking alone", () => {
  const sent: Array<{ body: Record<string, unknown>; beta: string | null }> =
    [];
  const fetchFn = progressNotesFetch(async (_input, init) => {
    sent.push({
      body: JSON.parse(String(init?.body)),
      beta: new Headers(init?.headers).get("anthropic-beta"),
    });
    return new Response("{}", { status: 200 });
  });
  const send = (body: Record<string, unknown>, headers?: HeadersInit) =>
    fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  test("between_tools, a chosen display and disabled go out as written", async () => {
    for (const thinking of [
      { type: "between_tools" },
      { type: "adaptive", display: "summarized" },
      { type: "disabled" },
    ]) {
      sent.length = 0;
      await send({ model: "claude-sonnet-5-5", thinking });
      expect(sent[0]?.body.thinking).toEqual(thinking);
      expect(sent[0]?.beta).toBeNull();
    }
  });

  test("an adaptive thinking with other fields keeps them, and the betas already named stay", async () => {
    sent.length = 0;
    await send(
      {
        model: "claude-opus-5-5",
        thinking: {
          type: "adaptive",
          block_binding: { prefix_mismatch_behavior: "drop_block" },
        },
      },
      { "anthropic-beta": "thinking-binding-controls-2026-08-01" },
    );
    expect(sent[0]?.body.thinking).toEqual({
      type: "adaptive",
      display: "updates",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    expect(sent[0]?.beta?.split(",")).toEqual([
      "thinking-binding-controls-2026-08-01",
      PROGRESS_UPDATES_BETA,
    ]);
  });

  test("a request that is not a message passes untouched", async () => {
    sent.length = 0;
    await fetchFn("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-5-5" }),
    });
    expect(sent[0]?.body.thinking).toBeUndefined();
  });
});

describe("which models write progress notes", () => {
  const yes = [
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-fable-5-2",
    "claude-mythos-5-2",
  ];
  const no = [
    "claude-haiku-5-5",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
    "claude-sonnet-5-5-mini",
    "anthropic/claude-sonnet-5-5",
  ];
  for (const m of yes)
    test(`${m}: yes`, () => expect(writesProgressNotes(m)).toBe(true));
  for (const m of no)
    test(`${m}: no`, () => expect(writesProgressNotes(m)).toBe(false));
});

describe("hiddenNotesThisTurn", () => {
  const calling = (thinking: string, provider = "anthropic", calls = true) =>
    new AIMessage({
      content: [{ type: "thinking", thinking, signature: "sig" }],
      tool_calls: calls ? [{ name: "set_labels", args: {}, id: "c1" }] : [],
      response_metadata: { model_provider: provider },
    });

  test("only this turn's, oldest first", () => {
    expect(
      hiddenNotesThisTurn([
        new HumanMessage("antes"),
        calling("de ontem"),
        new HumanMessage("agora"),
        calling("um"),
        calling("  "),
        calling("dois"),
      ]),
    ).toEqual(["um", "dois"]);
  });

  test("another provider's block is not one of these notes", () => {
    expect(
      hiddenNotesThisTurn([new HumanMessage("oi"), calling("nota", "openai")]),
    ).toEqual([]);
  });

  test("a message that calls no tool hides no note: progress notes precede a call", () => {
    expect(
      hiddenNotesThisTurn([
        new HumanMessage("oi"),
        calling("raciocínio resumido", "anthropic", false),
      ]),
    ).toEqual([]);
  });
});

describe("hiddenNotesDetail", () => {
  test("the summaries only where the agent logs tool values; their size always", () => {
    expect(hiddenNotesDetail(["abc", "de"], false)).toEqual({
      hiddenNotes: 2,
      hiddenNoteChars: 5,
    });
    expect(hiddenNotesDetail(["abc", "de"], true)).toEqual({
      hiddenNotes: 2,
      hiddenNoteChars: 5,
      hiddenNoteSummaries: ["abc", "de"],
    });
  });
});

// What the graph sends as the system prompt, per provider.
class PromptRecorder extends BaseChatModel {
  system = "";
  constructor() {
    super({});
  }
  _llmType() {
    return "prompt-recorder";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.system = contentToText(messages[0]?.content ?? "");
    return { generations: [{ text: "ok", message: new AIMessage("ok") }] };
  }
}

async function systemPromptFor(provider: string, model: string) {
  const recorder = new PromptRecorder();
  const cfg = makeConfig({});
  const graph = await buildModelAndGraph(
    {
      ...cfg,
      systemPrompt: "PROMPT",
      mc: { ...cfg.mc, provider, model },
    } as never,
    [],
    {
      makeModel: (_mc: ResolvedModelConfig) => recorder,
      checkpointer: new MemorySaver(),
    },
  );
  await graph.invoke(
    { messages: [new HumanMessage("oi")] },
    { configurable: { thread_id: `prompt-${provider}` } },
  );
  return recorder.system;
}

describe("the prompt of an Anthropic agent says where the reply is delivered", () => {
  test("anthropic: the rule closes the system prompt", async () => {
    const system = await systemPromptFor("anthropic", "claude-sonnet-5-5");
    expect(system.startsWith("PROMPT")).toBe(true);
    expect(system.endsWith(LAST_MESSAGE_RULE)).toBe(true);
  });

  test("other providers: no rule", async () => {
    const system = await systemPromptFor("openai", "gpt-5.5");
    expect(system).not.toContain(LAST_MESSAGE_RULE);
  });
});
