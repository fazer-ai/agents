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
  test("registry exposes openai/openai-compatible/gemini/anthropic/openrouter with document support flags", () => {
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
    expect(getVisionProvider("openai")?.supportsDocuments).toBe(false);
    expect(getVisionProvider("openai-compatible")?.supportsDocuments).toBe(
      false,
    );
    expect(getVisionProvider("gemini")?.supportsDocuments).toBe(true);
    expect(getVisionProvider("anthropic")?.supportsDocuments).toBe(true);
    expect(getVisionProvider("openrouter")?.supportsDocuments).toBe(false);
    expect(getVisionProvider("nope")).toBeNull();
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
