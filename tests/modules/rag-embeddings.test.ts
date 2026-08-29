import { describe, expect, test } from "bun:test";
import { embedQuery, embedTexts } from "@/modules/rag/embeddings";

function config(fetchImpl: typeof fetch) {
  return {
    model: "text-embedding-3-small",
    apiKey: ["unit", "value"].join("-"),
    baseURL: "https://embedding.internal/v1/",
    fetchImpl,
  };
}

describe("OpenAI-compatible embeddings", () => {
  test("preserves provider vectors and restores response order", async () => {
    let requestBody: { input?: string[] } = {};
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://embedding.internal/v1/embeddings");
      requestBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const vectors = await embedTexts(
      ["primeiro", "segundo"],
      config(fetchImpl),
    );
    expect(requestBody.input).toEqual(["primeiro", "segundo"]);
    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  test("uses the same compatible path for query embeddings", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [0.5, 0.5] }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch;
    expect(await embedQuery("consulta", config(fetchImpl))).toEqual([0.5, 0.5]);
  });

  test("rejects a response with the wrong vector count", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(embedTexts(["consulta"], config(fetchImpl))).rejects.toThrow(
      "provider error",
    );
  });
});
