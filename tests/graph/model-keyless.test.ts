import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { createChatModel } from "@/graph/models";

// The suite's DOM preload replaces the global `Response` and makes `fetch` same-origin (a preflight
// before every call, CORS headers on every answer); tests/dom-setup.ts keeps Bun's Response.
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};

// An openai-compatible endpoint that needs no key is a configuration the resolver supports on
// purpose (`credential: "none"`), and the OpenAI SDK refuses an empty key before any request. Every
// chat model the console builds goes through `createChatModel`, so this is where the key is filled.
describe("a keyless openai-compatible endpoint", () => {
  const seen: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let baseURL: string;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        if (req.method === "OPTIONS")
          return new BunResponse(null, { status: 204, headers: CORS });
        seen.push(req.headers.get("authorization") ?? "");
        const body = {
          id: "c",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "pong" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        return new BunResponse(JSON.stringify(body), {
          headers: { ...CORS, "content-type": "application/json" },
        });
      },
    });
    baseURL = `http://127.0.0.1:${server.port}/v1`;
  });
  afterAll(() => server.stop(true));

  test("answers with no key, sending a placeholder the server can ignore", async () => {
    seen.length = 0;
    const model = createChatModel({
      provider: "openai-compatible",
      model: "m",
      apiKey: "",
      baseURL,
    });
    const reply = await model.invoke([new HumanMessage("hi")]);
    expect(reply.content).toBe("pong");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^Bearer \S+$/);
  });

  test("a key that was given is the one sent", async () => {
    seen.length = 0;
    const model = createChatModel({
      provider: "openai-compatible",
      model: "m",
      apiKey: "sk-own-key",
      baseURL,
    });
    await model.invoke([new HumanMessage("hi")]);
    expect(seen).toEqual(["Bearer sk-own-key"]);
  });
});
