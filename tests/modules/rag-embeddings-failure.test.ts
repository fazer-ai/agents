import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import logger from "@/api/lib/logger";
import { embedQuery, embedTexts } from "@/modules/rag/embeddings";

// `Bun.serve` under happy-dom: the DOM's Response is not one the server can return, so the native
// one is taken from the globals dom-setup.ts stashes (see tests/dom-setup.ts).
const nativeGlobals = globalThis as unknown as { BunResponse: typeof Response };
const BunResponse = nativeGlobals.BunResponse;

// A marker standing in for what the request actually carries: the customer's question on a search,
// the document's own text on an ingest.
const MARKER = "jabuticaba-do-planalto-4417";

// The embedding client is the OpenAI SDK, which builds its error message out of the RESPONSE BODY —
// measured here rather than assumed, against a server that answers the way a provider rejecting an
// input does. That is the whole leak: the body quotes what it was sent, and the message it lands in
// is read by `KnowledgeDocument.error` (the console, and a realtime broadcast to the browser) and,
// for a search inside a turn, by the tool line's `errorMessage` in `execution_logs`.
let server: ReturnType<typeof Bun.serve> | undefined;
let baseURL = "";

describe("an embedding failure carries no part of what was embedded", () => {
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      // happy-dom's fetch preflights a cross-origin request, and a preflight nobody answers fails
      // the call before the provider's own status is ever seen (tests/dom-setup.ts).
      fetch: (req: Request) =>
        req.method === "OPTIONS"
          ? new BunResponse(null, {
              status: 204,
              headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-headers": "*",
                "access-control-allow-methods": "*",
              },
            })
          : new BunResponse(
              JSON.stringify({
                error: {
                  message: `Invalid input: "${MARKER}" could not be embedded`,
                  type: "invalid_request_error",
                },
              }),
              {
                status: 400,
                headers: {
                  "content-type": "application/json",
                  "access-control-allow-origin": "*",
                },
              },
            ),
    });
    baseURL = `http://localhost:${server.port}/v1`;
  });

  afterAll(() => {
    server?.stop(true);
  });

  const cfg = () => ({
    model: "text-embedding-3-small",
    apiKey: "sk-probe",
    baseURL,
  });

  // Both entry points, because they leak into different stores and a rule applied to one of two
  // callers is the shape this whole change exists to stop repeating.
  test("the query path reports the status, not the question", async () => {
    const err = (await embedQuery(MARKER, cfg()).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(MARKER);
    expect(err.message).toBe("HTTP 400");
    expect(String((err.cause as Error)?.message ?? "")).toContain(MARKER);
  });

  test("the document path reports the status, not the text", async () => {
    const err = (await embedTexts([MARKER], cfg()).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(MARKER);
    expect(err.message).toBe("HTTP 400");
  });

  // The same claim as the model lane, asserted on this one too: two review rounds found this exact
  // hole one boundary apart, which is what a rule tested only where it was first applied produces.
  test("the original reaches the process log here as well", async () => {
    const seen: unknown[] = [];
    const realWarn = logger.warn;
    (logger as { warn: unknown }).warn = (...args: unknown[]) => {
      seen.push(args[0]);
    };
    try {
      await embedQuery(MARKER, cfg()).catch(() => undefined);
    } finally {
      (logger as { warn: unknown }).warn = realWarn;
    }
    const logged = seen
      .map((o) => String((o as { err?: Error })?.err?.message ?? ""))
      .join(" ");
    expect(logged).toContain(MARKER);
  });

  // The early return is not a way past the boundary: an empty batch never calls the provider, so
  // there is nothing to reduce and nothing to leak.
  test("an empty batch never reaches the provider", async () => {
    expect(await embedTexts([], cfg())).toEqual([]);
  });
});
