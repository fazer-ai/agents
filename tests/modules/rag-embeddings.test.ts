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
