import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
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
let wires: Wire[] = [];
let openaiBody = "";
// Refuse only the call that carries the constraint, so the retry has something to succeed at.
let refuseConstrained = false;
let refuseWith = 400;

const openaiServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const pre = preflight(req);
    if (pre) return pre;
    lastWire = (await req.json()) as Wire;
    wires.push(lastWire);
    if ((refuseConstrained || refuseWith !== 400) && lastWire.response_format) {
      return BunResponse.json(
        {
          error: {
            message:
              refuseWith === 429
                ? "Rate limit reached"
                : "Unsupported parameter: 'response_format' is not supported with this model.",
            type: "invalid_request_error",
          },
        },
        { status: refuseWith, headers: CORS },
      );
    }
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
    wires = [];
    refuseConstrained = false;
    refuseWith = 400;
    openaiBody = JSON.stringify(VIOLATION);
    anthropicContent = [];
  });

  test("the schema travels with the call, closed and strict", async () => {
    await analyzeGuardrail(openaiModel, BASE, "json-schema");
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
    const v = await analyzeGuardrail(openaiModel, BASE, "json-schema");
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
    const v = await analyzeGuardrail(openaiModel, BASE, "json-schema");
    expect(v.violated).toBe(false);
    expect(v.error).toBe("no usable verdict in response");
  });

  // The provider list is about the ENDPOINT; the model field next to it is free text, and a model
  // that takes ordinary chat and refuses this request would otherwise turn a working screen into a
  // silent one. A refusal is answered by making the call the way it was made before this existed.
  test("a refused request is retried the way it used to be made", async () => {
    refuseConstrained = true;
    const v = await analyzeGuardrail(openaiModel, BASE, "json-schema");
    expect(v.violated).toBe(true);
    expect(v.error).toBeUndefined();
    // Two calls: the constrained one that was refused, then the one that works.
    expect(wires.length).toBe(2);
    expect(Boolean(wires[0]?.response_format)).toBe(true);
    expect(Boolean(wires[1]?.response_format)).toBe(false);
  });

  // Only a 400 earns the retry. A rate limit or a timeout is the endpoint saying "not now", and
  // answering that with a second call doubles the pressure on the thing that is already refusing,
  // on a turn a customer is waiting on.
  test("a rate limit is not retried in prose", async () => {
    refuseWith = 429;
    const v = await analyzeGuardrail(openaiModel, BASE, "json-schema");
    expect(v.error).toBeTruthy();
    expect(v.violated).toBe(false);
    expect(wires.length).toBe(1);
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
    const v = await analyzeGuardrail(anthropicModel, BASE, "json-schema");
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
    const v = await analyzeGuardrail(anthropicModel, BASE, "json-schema");
    expect(v.violated).toBe(true);
    expect(v.error).toBeUndefined();
  });

  test("a text answer carrying no verdict is not clean either", async () => {
    anthropicContent = [{ type: "text", text: "não consegui analisar" }];
    const v = await analyzeGuardrail(anthropicModel, BASE, "json-schema");
    expect(v.violated).toBe(false);
    expect(v.error).toBe("no usable verdict in response");
  });
});

// Gemini is asked in its own dialect, and this is where that is pinned. The adapter forwards the
// schema unconverted, so what we hand it is what Gemini validates: measured live on
// gemini-3.5-flash and -flash-lite, the json-schema dialect comes back 400 ("Proto field is not
// repeating, cannot start list") and every screen then costs two calls, while this one answers in
// one.
//
// The reverse is why the two dialects are not interchangeable, also measured live: asked with
// `nullable: true`, OpenAI ignores the keyword, `suggestedReply` becomes a required string, and the
// model is pushed into inventing one (8 runs on gpt-5.4-nano: `""` seven times, `"/"` once) — on
// the direction whose entire rule is that it must never compose a reply.
describe("the schema dialect Gemini speaks", () => {
  test("nullability reaches the wire as a flag, not as a type union", async () => {
    let wire = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const pre = preflight(req);
        if (pre) return pre;
        wire = await req.text();
        return BunResponse.json(
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: JSON.stringify(VIOLATION) }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          },
          { headers: CORS },
        );
      },
    });
    const gemini = new ChatGoogleGenerativeAI({
      model: "gemini-3.5-flash",
      apiKey: "x",
      baseUrl: `http://localhost:${server.port}`,
    });
    try {
      await analyzeGuardrail(gemini, BASE, "openapi");
      const schema = (
        JSON.parse(wire) as {
          generationConfig?: {
            responseSchema?: {
              properties?: Record<
                string,
                { type?: unknown; nullable?: unknown }
              >;
            };
          };
        }
      ).generationConfig?.responseSchema;
      const field = schema?.properties?.suggestedReply as
        | { type?: unknown; nullable?: unknown }
        | undefined;
      // One type value plus the flag. A type UNION here is the shape Gemini refuses.
      expect(field?.type).toBe("string");
      expect(field?.nullable).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
