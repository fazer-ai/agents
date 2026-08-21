import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { analyzeGuardrail } from "@/modules/guardrails/analyze";

// The constrained verdict, against the adapters themselves (issue #131).
//
// These build the vendor adapters directly and point them at a local server, instead of asserting
// on a fake model. The whole change is about what an ADAPTER puts on the wire and what it does with
// the answer, and those are exactly the parts a hand-written double gets to invent: every earlier
// belief about this feature that turned out to be false ("the schema travels as json_schema",
// "a deviation comes back as a null parse") was a belief about the adapter, not about our code.
//
// The server here is not a generic double either. It answers in each vendor's own response shape,
// so the adapter parses it the way it parses the real one.

const BASE = {
  direction: "input" as const,
  text: "seus merdas",
  checks: {
    toxicity: true,
    unsafeContent: true,
    competitorMentions: false,
    promptAdherence: false,
    answerRelevance: false,
  },
  competitors: [],
  customPolicy: "",
};

const VIOLATION = {
  violated: true,
  categories: ["toxicity"],
  rationale: "xingamento",
  suggestedReply: null,
};

// ── an OpenAI-shaped endpoint ───────────────────────────────────────────────

// NOTE: two things the suite's happy-dom environment does to a local server. Its `fetch` enforces
// the same-origin policy, so every call below is preflighted and needs the CORS headers; and its
// `Response` is not the one Bun's socket layer recognises, so a server answering with it fails the
// connection outright (see tests/dom-setup.ts, which captures the native constructors for exactly
// this).
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
const preflight = (req: Request) =>
  req.method === "OPTIONS"
    ? new BunResponse(null, { status: 204, headers: CORS })
    : null;

type Wire = Record<string, unknown>;
let lastWire: Wire = {};
let openaiBody = "";

const openaiServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const pre = preflight(req);
    if (pre) return pre;
    lastWire = (await req.json()) as Wire;
    return BunResponse.json(
      {
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "local",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: openaiBody },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      { headers: CORS },
    );
  },
});

// Built here rather than through createChatModel because the point is the ADAPTER: which providers
// are allowed to reach this path at all is a separate decision, with its own table
// (tests/modules/guardrail-verdict.test.ts).
const openaiModel = new ChatOpenAI({
  model: "gpt-5.4-nano",
  apiKey: "sk-test",
  maxRetries: 0,
  configuration: { baseURL: `http://localhost:${openaiServer.port}/v1` },
});

// ── an Anthropic endpoint ───────────────────────────────────────────────────

let anthropicContent: unknown[] = [];

const anthropicServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const pre = preflight(req);
    if (pre) return pre;
    await req.json();
    return BunResponse.json(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: anthropicContent,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { headers: CORS },
    );
  },
});

const anthropicModel = new ChatAnthropic({
  model: "claude-haiku-4-5",
  apiKey: "sk-ant-test",
  maxRetries: 0,
  anthropicApiUrl: `http://localhost:${anthropicServer.port}`,
});

afterAll(() => {
  openaiServer.stop(true);
  anthropicServer.stop(true);
});

describe("the verdict is asked for as a schema, not as prose", () => {
  beforeEach(() => {
    lastWire = {};
    openaiBody = JSON.stringify(VIOLATION);
    anthropicContent = [];
  });

  test("the schema travels with the call, closed and strict", async () => {
    await analyzeGuardrail(openaiModel, BASE, "constrained");
    const format = lastWire.response_format as {
      type: string;
      json_schema: {
        name: string;
        strict: boolean;
        schema: { additionalProperties: boolean; required: string[] };
      };
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    expect(format.json_schema.schema.required.sort()).toEqual([
      "categories",
      "rationale",
      "suggestedReply",
      "violated",
    ]);
  });

  test("the answer the schema produced is the verdict", async () => {
    const v = await analyzeGuardrail(openaiModel, BASE, "constrained");
    expect(v.violated).toBe(true);
    expect(v.categories).toEqual(["toxicity"]);
    expect(v.error).toBeUndefined();
  });

  // The decoder is a property of the endpoint, and this repository reaches endpoints that only
  // claim to be the one they imitate. Measured on a local one: an answer that is valid json but not
  // a verdict comes back through `parsed` UNVALIDATED, so trusting it would publish "not violated"
  // for a screen that produced no verdict at all.
  test("json that is not a verdict does not become a clean verdict", async () => {
    openaiBody = JSON.stringify({ violado: true, categorias: ["toxicity"] });
    const v = await analyzeGuardrail(openaiModel, BASE, "constrained");
    expect(v.violated).toBe(false);
    expect(v.error).toBe("no usable verdict in response");
  });

  // The same call, in the shape every other endpoint keeps getting. Without this the change would
  // read as "the schema is always sent", and an operator's own server would be told to honour a
  // parameter it never agreed to.
  test("prose mode puts no format constraint on the wire", async () => {
    await analyzeGuardrail(openaiModel, BASE, "prose");
    expect(lastWire.response_format).toBeUndefined();
    expect(Object.keys(lastWire)).toContain("messages");
  });
});

describe("an adapter that answers around the schema", () => {
  beforeEach(() => {
    anthropicContent = [];
  });

  test("a forced tool call is read as the verdict", async () => {
    anthropicContent = [
      {
        type: "tool_use",
        id: "t1",
        name: "guardrail_verdict",
        input: VIOLATION,
      },
    ];
    const v = await analyzeGuardrail(anthropicModel, BASE, "constrained");
    expect(v.violated).toBe(true);
    expect(v.categories).toEqual(["toxicity"]);
    expect(v.error).toBeUndefined();
  });

  // Defence in depth, and it is reachable: measured on this adapter, a reply that answers in TEXT
  // instead of calling the forced tool arrives with no parsed answer and the text intact. Reading
  // it is what the prose path has always done, so the screen survives a model that ignored the
  // tool, instead of being reported as one that never ran.
  test("a text answer is still read, rather than reported as unscreened", async () => {
    anthropicContent = [
      { type: "text", text: `Analisei: ${JSON.stringify(VIOLATION)}` },
    ];
    const v = await analyzeGuardrail(anthropicModel, BASE, "constrained");
    expect(v.violated).toBe(true);
    expect(v.error).toBeUndefined();
  });

  test("a text answer carrying no verdict is not clean either", async () => {
    anthropicContent = [{ type: "text", text: "não consegui analisar" }];
    const v = await analyzeGuardrail(anthropicModel, BASE, "constrained");
    expect(v.violated).toBe(false);
    expect(v.error).toBe("no usable verdict in response");
  });
});
