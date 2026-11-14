import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { thinkingDroppedThisTurn } from "@/graph/anthropic-thinking-binding";
import { parseModelConfig } from "@/graph/model-config";
import { createChatModel } from "@/graph/models";

// A local stand-in for the Anthropic Messages API that enforces thinking-block binding the way the
// 5.5 models do: a block's signature is bound to the system prompt it was created under, a replay
// under another prefix is refused with the API's own 400, and the beta's `drop_block` drops the
// mismatched blocks and reports them in `input_transformations`. Models listed in `NO_ADAPTIVE`
// behave like the 4.x line: no binding to enforce, and `thinking.type: "adaptive"` refused.

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const NO_ADAPTIVE = new Set(["claude-haiku-4-5"]);

type Seen = { body: Record<string, unknown>; beta: string | null };
const seen: Seen[] = [];
let forceBindingError = false;
let forceOtherError = false;

// The request carries the system prompt as a string or as text blocks; the binding is to its text.
const signatureFor = (system: unknown) =>
  `sig:${
    typeof system === "string"
      ? system
      : (system as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
  }`;

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

function answer(req: Seen): Response {
  const { body, beta } = req;
  const model = String(body.model);
  const thinking = body.thinking as
    | { type?: string; block_binding?: { prefix_mismatch_behavior?: string } }
    | undefined;
  if (thinking && NO_ADAPTIVE.has(model))
    return apiError("adaptive thinking is not supported on this model");
  if (forceOtherError) return apiError("messages: roles must alternate");
  const dropping =
    !!beta?.split(",").includes(BINDING_BETA) &&
    thinking?.block_binding?.prefix_mismatch_behavior === "drop_block";
  const expected = signatureFor(body.system);
  const transformations: unknown[] = [];
  const messages = body.messages as Array<{
    role: string;
    content: unknown;
  }>;
  for (const [i, m] of messages.entries()) {
    if (!Array.isArray(m.content)) continue;
    for (const [j, block] of (
      m.content as Array<{ type: string; signature?: string }>
    ).entries()) {
      if (block.type !== "thinking" || NO_ADAPTIVE.has(model)) continue;
      if (block.signature === expected && !forceBindingError) continue;
      if (!dropping || forceBindingError)
        return apiError(
          `messages.${i}.content.${j}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block". That setting requires the \`${BINDING_BETA}\` value in the \`anthropic-beta\` header.`,
        );
      transformations.push({
        type: "thinking_dropped",
        path: `messages.${i}.content.${j}`,
        reason: "prefix_binding_mismatch",
      });
    }
  }
  return json(200, {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [
      { type: "thinking", thinking: "...", signature: expected },
      { type: "text", text: "ok" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2 },
    ...(transformations.length
      ? { input_transformations: transformations }
      : {}),
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

// A conversation whose assistant turn carries a thinking block signed under `signedUnder`.
const conversation = (system: string, signedUnder: string): BaseMessage[] => [
  new SystemMessage(system),
  new HumanMessage("Quanto é 17*23?"),
  new AIMessage({
    content: [
      {
        type: "thinking",
        thinking: "17*23=391",
        signature: signatureFor(signedUnder),
      },
      { type: "text", text: "391" },
    ],
  }),
  new HumanMessage("E 19*21?"),
];

async function ask(model: string, messages: BaseMessage[]) {
  const before = seen.length;
  const cfg = parseModelConfig({ provider: "anthropic", model });
  const llm = createChatModel({ ...cfg, apiKey: "k", maxRetries: 0 });
  try {
    const reply = await llm.invoke(messages);
    return { reply, error: undefined, requests: seen.slice(before) };
  } catch (error) {
    return { reply: undefined, error, requests: seen.slice(before) };
  }
}

describe("a replayed thinking block bound to an older prefix", () => {
  test("the turn answers after the system prompt changed, and reports the dropped block", async () => {
    const { reply, error, requests } = await ask(
      "claude-sonnet-5-5",
      conversation("Seja breve.", "Prompt antigo."),
    );
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.beta?.split(",")).toContain(BINDING_BETA);
    // NOTE: `display` is the progress-notes wrapper's, which this model also gets.
    expect(requests[1]?.body.thinking).toEqual({
      type: "adaptive",
      display: "updates",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    expect(thinkingDroppedThisTurn([reply as BaseMessage])).toBe(1);
  });

  test("a model that refused a replay once is sent drop_block up front from then on", async () => {
    const model = "claude-opus-5-5";
    await ask(model, conversation("B", "A"));
    const { error, requests } = await ask(model, conversation("C", "A"));
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.beta?.split(",")).toContain(BINDING_BETA);
  });

  test("an unchanged prefix replays the block as-is and sends no thinking field", async () => {
    const { error, requests } = await ask(
      "claude-haiku-5-5",
      conversation("Mesmo prompt.", "Mesmo prompt."),
    );
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.thinking).toBeUndefined();
    expect(requests[0]?.beta ?? "").not.toContain(BINDING_BETA);
    const messages = requests[0]?.body.messages as
      | Array<{ content: Array<{ type: string; signature?: string }> }>
      | undefined;
    expect(messages?.[1]?.content[0]).toMatchObject({
      type: "thinking",
      signature: signatureFor("Mesmo prompt."),
    });
  });

  test("a model without adaptive thinking never receives the thinking field", async () => {
    const { error, requests } = await ask(
      "claude-haiku-4-5",
      conversation("Novo.", "Velho."),
    );
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.thinking).toBeUndefined();
  });

  test("another 400 is not retried and keeps the replayed blocks", async () => {
    forceOtherError = true;
    try {
      const { error, requests } = await ask(
        "claude-sonnet-5-5-other",
        conversation("Novo.", "Velho."),
      );
      expect(String(error)).toContain("roles must alternate");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body.thinking).toBeUndefined();
    } finally {
      forceOtherError = false;
    }
  });

  test("a binding 400 that survives drop_block fails the call after one retry", async () => {
    forceBindingError = true;
    try {
      const { error, requests } = await ask(
        "claude-sonnet-5-5-loop",
        conversation("Mesmo.", "Mesmo."),
      );
      expect(String(error)).toContain("bound to a different conversation");
      expect(requests).toHaveLength(2);
    } finally {
      forceBindingError = false;
    }
  });
});

describe("thinkingDroppedThisTurn", () => {
  const dropped = (n: number) =>
    new AIMessage({
      content: "ok",
      response_metadata: {
        input_transformations: Array.from({ length: n }, () => ({
          type: "thinking_dropped",
          reason: "prefix_binding_mismatch",
        })),
      },
    });

  test("counts only the replies after the last customer message", () => {
    expect(
      thinkingDroppedThisTurn([
        new HumanMessage("a"),
        dropped(3),
        new HumanMessage("b"),
        dropped(1),
        dropped(2),
      ]),
    ).toBe(3);
  });

  test("ignores transformations of another type", () => {
    const other = new AIMessage({
      content: "ok",
      response_metadata: { input_transformations: [{ type: "other" }] },
    });
    expect(thinkingDroppedThisTurn([new HumanMessage("a"), other])).toBe(0);
  });
});
