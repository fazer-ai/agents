import { describe, expect, test } from "bun:test";
import {
  EMBEDDING_DIM,
  type EmbeddingDeps,
  embedQuery,
  embedTexts,
} from "@/modules/rag/embeddings";

const nativeGlobals = globalThis as unknown as { BunResponse: typeof Response };
const BunResponse = nativeGlobals.BunResponse;

// A vector of the width the `knowledge_chunks` column actually is. Anything narrower is a different
// model answering, which is the case `assertWidth` exists for and is asserted on its own below.
function vec(seed: number, dim = EMBEDDING_DIM): number[] {
  return Array.from({ length: dim }, (_, i) => (i === seed ? 1 : 0));
}

function config() {
  return {
    model: "text-embedding-3-small",
    apiKey: "sk-probe",
    baseURL: "https://embedding.internal/v1/",
  };
}

// The SSRF assertion resolves DNS, so a hermetic test cannot reach the real one; `embedding.internal`
// does not exist. Its own wiring is asserted separately.
const passThrough: EmbeddingDeps["assertSafe"] = async (u) => new URL(u);

function json(body: unknown, status = 200): Response {
  return new BunResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI-compatible embeddings", () => {
  test("preserves provider vectors and restores response order", async () => {
    let requestBody: { input?: string[]; model?: string } = {};
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String(
        (init?.headers as Record<string, string> | undefined)?.authorization,
      );
      requestBody = JSON.parse(init?.body as string);
      return json({
        data: [
          { index: 1, embedding: vec(1) },
          { index: 0, embedding: vec(0) },
        ],
      });
    }) as unknown as typeof fetch;

    const vectors = await embedTexts(["primeiro", "segundo"], config(), {
      fetchImpl,
      assertSafe: passThrough,
    });
    expect(seenUrl).toBe("https://embedding.internal/v1/embeddings");
    expect(seenAuth).toBe("Bearer sk-probe");
    expect(requestBody.input).toEqual(["primeiro", "segundo"]);
    // The pinned model travels on the wire: the endpoint may move, the model may not.
    expect(requestBody.model).toBe("text-embedding-3-small");
    expect(vectors).toEqual([vec(0), vec(1)]);
  });

  test("keeps response order when the provider sends no index at all", async () => {
    const fetchImpl = (async () =>
      json({
        data: [{ embedding: vec(0) }, { embedding: vec(1) }],
      })) as unknown as typeof fetch;
    expect(
      await embedTexts(["a", "b"], config(), {
        fetchImpl,
        assertSafe: passThrough,
      }),
    ).toEqual([vec(0), vec(1)]);
  });

  test("uses the same compatible path for query embeddings", async () => {
    const fetchImpl = (async () =>
      json({
        data: [{ index: 0, embedding: vec(7) }],
      })) as unknown as typeof fetch;
    expect(
      await embedQuery("consulta", config(), {
        fetchImpl,
        assertSafe: passThrough,
      }),
    ).toEqual(vec(7));
  });

  // The guard the vault does not apply: `baseUrl` is persisted after an http(s) SYNTAX check only,
  // so without this a tenant admin turns ingestion into a POST at a loopback or metadata address.
  test("asserts the outbound URL before any fetch, and refuses on a block", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return json({ data: [] });
    }) as unknown as typeof fetch;
    const seen: Array<[string, unknown]> = [];
    const assertSafe: EmbeddingDeps["assertSafe"] = async (u, opts) => {
      seen.push([u, opts]);
      throw new Error("Blocked outbound URL: 169.254.169.254 is blocked");
    };
    await expect(
      embedTexts(["a"], config(), { fetchImpl, assertSafe }),
    ).rejects.toThrow("provider error");
    expect(fetched).toBe(false);
    expect(seen).toEqual([
      ["https://embedding.internal/v1/embeddings", { allowHttp: true }],
    ]);
  });

  // `documents.ts` hands over EVERY chunk of a document at once and nothing caps a document's size,
  // so an unbatched call is a 400/413 on the self-hosted servers this path exists to serve.
  test("splits a large document into bounded batches, in order", async () => {
    const sizes: number[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[] };
      sizes.push(body.input.length);
      return json({
        data: body.input.map((t, i) => ({
          index: i,
          embedding: vec(Number(t)),
        })),
      });
    }) as unknown as typeof fetch;

    const texts = Array.from({ length: 600 }, (_, i) =>
      String(i % EMBEDDING_DIM),
    );
    const vectors = await embedTexts(texts, config(), {
      fetchImpl,
      assertSafe: passThrough,
    });
    expect(sizes).toEqual([512, 88]);
    expect(vectors).toHaveLength(600);
    expect(vectors[0]).toEqual(vec(0));
    expect(vectors[511]).toEqual(vec(511));
    expect(vectors[512]).toEqual(vec(512));
    expect(vectors[599]).toEqual(vec(599));
  });

  // `providerFailure` reads the status off a numeric property and never parses the message, so a
  // status that lives only in the text reaches the operator as the opaque "provider error".
  test("reports the provider's status, and keeps its words for the log", async () => {
    const fetchImpl = (async () =>
      new BunResponse('{"error":{"message":"invalid api key"}}', {
        status: 401,
      })) as unknown as typeof fetch;
    const err = (await embedTexts(["a"], config(), {
      fetchImpl,
      assertSafe: passThrough,
    }).catch((e) => e)) as Error;
    expect(err.message).toBe("HTTP 401");
    expect(String((err.cause as Error).message)).toContain("invalid api key");
  });

  test("rejects a response with the wrong vector count", async () => {
    const fetchImpl = (async () =>
      json({ data: [] })) as unknown as typeof fetch;
    await expect(
      embedTexts(["consulta"], config(), {
        fetchImpl,
        assertSafe: passThrough,
      }),
    ).rejects.toThrow("provider error");
  });

  test("rejects a vector that is not all numbers", async () => {
    const fetchImpl = (async () =>
      json({
        data: [{ index: 0, embedding: ["nope"] }],
      })) as unknown as typeof fetch;
    await expect(
      embedTexts(["a"], config(), { fetchImpl, assertSafe: passThrough }),
    ).rejects.toThrow("provider error");
  });

  // The column is `vector(1536)` and `updateEmbeddingSettings` pins the model precisely because
  // nothing records which model produced a stored vector. Once the endpoint is configurable, the
  // width is no longer guaranteed by construction — and it has to fail by NAME, not as the closed
  // "provider error", or the operator cannot tell a wrong endpoint from a dead one.
  test("refuses an endpoint answering with a different dimensionality", async () => {
    const fetchImpl = (async () =>
      json({
        data: [{ index: 0, embedding: vec(0, 768) }],
      })) as unknown as typeof fetch;
    await expect(
      embedTexts(["a"], config(), { fetchImpl, assertSafe: passThrough }),
    ).rejects.toThrow(/returned 768 dimensions .* is 1536 wide/);
  });

  // `@langchain/openai` pins the OpenAI client to `maxRetries: 0` and wraps the call in AsyncCaller,
  // which retries six times; this path shipped with none, and an ingest failure is terminal (the
  // document lands in FAILED and only a manual reindex moves it).
  test("asks again after a transient failure, and only then", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new BunResponse("upstream busy", { status: 503 })
        : json({ data: [{ index: 0, embedding: vec(2) }] });
    }) as unknown as typeof fetch;
    expect(
      await embedTexts(["a"], config(), { fetchImpl, assertSafe: passThrough }),
    ).toEqual([vec(2)]);
    expect(calls).toBe(2);
  });

  test("does not ask again about what we sent", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new BunResponse("bad key", { status: 401 });
    }) as unknown as typeof fetch;
    await expect(
      embedTexts(["a"], config(), { fetchImpl, assertSafe: passThrough }),
    ).rejects.toThrow("HTTP 401");
    expect(calls).toBe(1);
  });

  // Azure's own spelling of a compatible base carries a query; concatenating puts `/embeddings`
  // inside it and the POST lands on the base path instead.
  test("keeps a query on the base URL out of the path", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      seenUrl = String(url);
      return json({ data: [{ index: 0, embedding: vec(1) }] });
    }) as unknown as typeof fetch;
    await embedTexts(
      ["a"],
      { ...config(), baseURL: "https://azure.example/openai/v1?api-version=x" },
      { fetchImpl, assertSafe: passThrough },
    );
    expect(seenUrl).toBe(
      "https://azure.example/openai/v1/embeddings?api-version=x",
    );
  });

  // AsyncCaller's no-retry list is STATUSES, so a connection reset fell through to a retry on the
  // path this replaced. The ingest is where that matters: nobody is waiting and the document lands
  // terminally FAILED.
  test("the ingest asks again after a transport failure with no status", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return json({ data: [{ index: 0, embedding: vec(4) }] });
    }) as unknown as typeof fetch;
    expect(
      await embedTexts(["a"], config(), { fetchImpl, assertSafe: passThrough }),
    ).toEqual([vec(4)]);
    expect(calls).toBe(2);
  });

  // The other half of that split: a live turn, where the retry is time a customer spends and a base
  // URL that will never resolve has to fail on the first attempt (`modules/vision/retry`).
  test("the query path does not, and fails on the first attempt", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      embedQuery("q", config(), { fetchImpl, assertSafe: passThrough }),
    ).rejects.toThrow("provider error");
    expect(calls).toBe(1);
  });

  // A response that arrived and cannot be used is never asked again: the endpoint answered, and it
  // will answer the same way next time.
  test("an unusable response is not retried", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return json({ data: [] });
    }) as unknown as typeof fetch;
    await expect(
      embedTexts(["a"], config(), { fetchImpl, assertSafe: passThrough }),
    ).rejects.toThrow("provider error");
    expect(calls).toBe(1);
  });

  // One item saying `index: 1` is the provider stating that position is not the order. Reading the
  // array positionally anyway publishes the pair swapped.
  test("refuses a response only some of whose items are indexed", async () => {
    const fetchImpl = (async () =>
      json({
        data: [{ index: 1, embedding: vec(1) }, { embedding: vec(0) }],
      })) as unknown as typeof fetch;
    await expect(
      embedTexts(["a", "b"], config(), { fetchImpl, assertSafe: passThrough }),
    ).rejects.toThrow("provider error");
  });

  // A 2xx whose body is not JSON arrived and cannot be used: `res.json()` rejects with a statusless
  // SyntaxError, which the ingest's own policy would otherwise read as a transport failure and send
  // the same batch twice more.
  test("a 2xx that is not JSON is refused once, not asked again", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new BunResponse("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    await expect(
      embedTexts(["a"], config(), { fetchImpl, assertSafe: passThrough }),
    ).rejects.toThrow("provider error");
    expect(calls).toBe(1);
  });

  // Numeric but not a permutation of 0..n-1: it sorts into SOMETHING and passes the count check, so
  // without this the document publishes with each vector attached to the wrong chunk.
  test.each([
    ["a duplicate index", [0, 0]],
    ["an index past the batch", [0, 9]],
    ["a non-integer index", [0, 1.5]],
  ])("refuses %s", async (_label, indexes) => {
    const fetchImpl = (async () =>
      json({
        data: (indexes as number[]).map((index, i) => ({
          index,
          embedding: vec(i),
        })),
      })) as unknown as typeof fetch;
    await expect(
      embedTexts(["a", "b"], config(), { fetchImpl, assertSafe: passThrough }),
    ).rejects.toThrow("provider error");
  });

  test("the query path refuses the same mismatch", async () => {
    const fetchImpl = (async () =>
      json({
        data: [{ index: 0, embedding: vec(0, 1024) }],
      })) as unknown as typeof fetch;
    await expect(
      embedQuery("q", config(), { fetchImpl, assertSafe: passThrough }),
    ).rejects.toThrow(/returned 1024 dimensions/);
  });
});

// The other half of the routing, and the reason the compatible path is worth its own code: with no
// `encoding_format` of its own the OpenAI SDK adds `base64`, which a good many OpenAI-compatible
// servers reject outright.
describe("no configured base URL keeps the OpenAI SDK path", () => {
  test("goes to OpenAI, and lets the SDK pick the wire format", async () => {
    let seenUrl = "";
    let body: { encoding_format?: string } = {};
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      body = JSON.parse(init?.body as string);
      const floats = new Float32Array(vec(3));
      return json({
        data: [
          {
            index: 0,
            embedding: Buffer.from(floats.buffer).toString("base64"),
          },
        ],
      });
    }) as unknown as typeof fetch;

    const out = await embedQuery(
      "consulta",
      { model: "text-embedding-3-small", apiKey: "sk-probe" },
      { fetchImpl },
    );
    expect(seenUrl).toBe("https://api.openai.com/v1/embeddings");
    expect(body.encoding_format).toBe("base64");
    expect(out).toEqual(vec(3));
  });
});
