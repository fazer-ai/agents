import { describe, expect, test } from "bun:test";
import {
  getVisionProvider,
  VISION_PROVIDER_NAMES,
  visionKindForMime,
} from "@/modules/vision/providers";
import { readVisionConfig, VISION_DEFAULTS } from "@/modules/vision/settings";

describe("visionKindForMime", () => {
  test("classifies images and PDFs, rejects the rest", () => {
    expect(visionKindForMime("image/png")).toBe("image");
    expect(visionKindForMime("image/jpeg")).toBe("image");
    expect(visionKindForMime("application/pdf")).toBe("document");
    expect(visionKindForMime("application/vnd.ms-excel")).toBeNull();
    expect(visionKindForMime("audio/ogg")).toBeNull();
    expect(visionKindForMime(null)).toBeNull();
  });

  test("rejects vector/markup images (svg) that vision LLMs don't accept as raster", () => {
    expect(visionKindForMime("image/svg+xml")).toBeNull();
    expect(visionKindForMime("image/svg+xml; charset=utf-8")).toBeNull();
    // a raster type with a parameter still classifies as an image
    expect(visionKindForMime("image/png; foo=bar")).toBe("image");
  });
});

describe("vision providers", () => {
  // Which of them reads a PDF is NOT here: that answer depends on the endpoint the call goes to,
  // and it lives in ./document-support with its own decision table.
  test("registry exposes openai/openai-compatible/gemini/anthropic/openrouter", () => {
    // NOTE: sorted through a COPY. `sort` mutates, and this array is the exported registry — sorting
    // it here reordered it for every other test in the same process, which is how a schema test
    // comparing the published enum against this constant went red in CI and green locally.
    expect([...VISION_PROVIDER_NAMES].sort()).toEqual([
      "anthropic",
      "gemini",
      "openai",
      "openai-compatible",
      "openrouter",
    ]);
    expect(getVisionProvider("nope")).toBeNull();
  });

  // Measured against the live API (2026-08-26, gpt-4o), and the two directions are what force the
  // choice to be made per kind rather than once:
  //   - a PDF in an `image_url` part  -> 400 "Invalid MIME type. Only image types are supported."
  //   - an image in a `file` part     -> 400 "unsupported MIME type 'image/png'"
  // So the part is picked by `req.kind`, exactly as anthropicExtract already picks document vs image.
  test("openai posts a document as a file content part, and an image as image_url", async () => {
    const sent: unknown[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      sent.push(JSON.parse((init?.body as string) ?? "{}"));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "um recibo" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const call = (kind: "image" | "document", mimeType: string) =>
      getVisionProvider("openai")?.extract({
        bytes: new ArrayBuffer(4),
        mimeType,
        kind,
        prompt: "Leia o documento.",
        model: "gpt-4o",
        apiKey: "sk-openai",
        baseURL: null,
        fetchImpl,
        timeoutMs: 5_000,
      });

    const doc = await call("document", "application/pdf");
    expect(doc?.text).toBe("um recibo");
    const docBody = sent[0] as {
      messages: Array<{ content: Array<Record<string, never>> }>;
    };
    const docPart = docBody.messages[0]?.content[1] as unknown as {
      type: string;
      file?: { filename?: string; file_data?: string };
    };
    expect(docPart.type).toBe("file");
    // Both fields are REQUIRED by the endpoint, measured: with no `filename` it answers
    // "Missing required parameter: ... file.file_id" (it reads the part as a file-id reference),
    // and a `file_data` without the `data:` prefix is rejected by name.
    expect(typeof docPart.file?.filename).toBe("string");
    expect((docPart.file?.filename ?? "").endsWith(".pdf")).toBe(true);
    expect(
      (docPart.file?.file_data ?? "").startsWith(
        "data:application/pdf;base64,",
      ),
    ).toBe(true);

    const img = await call("image", "image/png");
    expect(img?.text).toBe("um recibo");
    const imgBody = sent[1] as {
      messages: Array<{ content: Array<Record<string, never>> }>;
    };
    const imgPart = imgBody.messages[0]?.content[1] as unknown as {
      type: string;
      image_url?: { url?: string };
    };
    expect(imgPart.type).toBe("image_url");
    expect(
      (imgPart.image_url?.url ?? "").startsWith("data:image/png;base64,"),
    ).toBe(true);
  });

  // `visionKindForMime` classifies ANY `*/pdf` as a document (`application/x-pdf` included), and
  // Chatwoot serves whatever content type the uploader's server declared. The endpoint accepts one
  // spelling only, by name: "Expected a base64-encoded data URL with an application/pdf MIME type".
  // So the document part carries the canonical type rather than the one that came off the wire.
  test("a document part carries application/pdf even when the mime came in spelled otherwise", async () => {
    let body: { messages: Array<{ content: Array<Record<string, never>> }> } = {
      messages: [],
    };
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await getVisionProvider("openai")?.extract({
      bytes: new ArrayBuffer(4),
      mimeType: "application/x-pdf",
      kind: "document",
      prompt: "Leia.",
      model: "gpt-4o",
      apiKey: "sk-openai",
      baseURL: null,
      fetchImpl,
      timeoutMs: 5_000,
    });

    const part = body.messages[0]?.content[1] as unknown as {
      file?: { file_data?: string };
    };
    expect(
      (part.file?.file_data ?? "").startsWith("data:application/pdf;base64,"),
    ).toBe(true);
  });

  test("openrouter extract posts chat-completions with an image_url data URI", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "um gato" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await getVisionProvider("openrouter")?.extract({
      bytes: new ArrayBuffer(4),
      mimeType: "image/png",
      kind: "image",
      prompt: "Descreva a imagem.",
      model: "openai/gpt-4o",
      apiKey: "sk-or",
      baseURL: null,
      fetchImpl,
      timeoutMs: 5_000,
    });

    expect(out?.text).toBe("um gato");
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-or");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.model).toBe("openai/gpt-4o");
    expect(body.messages[0].content[1].image_url.url).toContain(
      "data:image/png;base64,",
    );
  });
});

describe("readVisionConfig", () => {
  test("defaults when absent or malformed", () => {
    expect(readVisionConfig(undefined)).toEqual(VISION_DEFAULTS);
    expect(readVisionConfig({ vision: "x" })).toEqual(VISION_DEFAULTS);
  });

  test("reads a valid config and falls back the unknown bits", () => {
    const cfg = readVisionConfig({
      vision: {
        enabled: true,
        provider: "gemini",
        model: "gemini-2.0-flash",
        credentialRef: "vault:7",
        extractionPrompt: "  Leia o documento.  ",
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.provider).toBe("gemini");
    expect(cfg.model).toBe("gemini-2.0-flash");
    expect(cfg.credentialRef).toBe("vault:7");
    expect(cfg.extractionPrompt).toBe("Leia o documento.");
  });

  test("an unknown provider falls back to the default", () => {
    const cfg = readVisionConfig({ vision: { provider: "made-up" } });
    expect(cfg.provider).toBe(VISION_DEFAULTS.provider);
    expect(cfg.extractionPrompt).toBe(VISION_DEFAULTS.extractionPrompt);
  });
});
