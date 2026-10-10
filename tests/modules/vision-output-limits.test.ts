import { describe, expect, test } from "bun:test";
import { VISION_MAX_OUTPUT_TOKENS_CAP } from "@/modules/vision/output-limits";
import { getVisionProvider, type VisionKind } from "@/modules/vision/providers";
import { readVisionConfig } from "@/modules/vision/settings";

// The output ceiling and the reasoning effort of a vision call, from `settings.vision` to the
// provider's own field. Every case goes through `readVisionConfig`, the reader the runtime
// uses, so a value the reader drops is a value the request never carries.

type Sent = { url: string; body: Record<string, unknown> };

function capture(reply: unknown) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse((init?.body as string) ?? "{}"),
    });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const REPLIES: Record<string, unknown> = {
  anthropic: {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
  },
  openai: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
  openrouter: {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  },
  gemini: {
    candidates: [
      { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
    ],
  },
};

async function extractWith(
  vision: Record<string, unknown>,
  kind: VisionKind = "image",
  reply?: unknown,
) {
  const cfg = readVisionConfig({ vision });
  const provider = getVisionProvider(cfg.provider);
  if (!provider) throw new Error(`no provider ${cfg.provider}`);
  const { sent, fetchImpl } = capture(reply ?? REPLIES[cfg.provider]);
  const out = await provider.extract({
    bytes: new TextEncoder().encode("%PDF-1.4").buffer as ArrayBuffer,
    mimeType: kind === "document" ? "application/pdf" : "image/png",
    kind,
    prompt: "descreva",
    model: cfg.model || provider.defaultModel,
    apiKey: "k",
    baseURL: cfg.baseURL,
    fetchImpl,
    timeoutMs: 5_000,
    maxOutputTokens: cfg.maxOutputTokens,
    reasoningEffort: cfg.reasoningEffort,
  });
  const first = sent[0];
  if (!first) throw new Error("no request was sent");
  return { body: first.body, url: first.url, out };
}

describe("readVisionConfig: maxOutputTokens and reasoningEffort", () => {
  test("absent or null reads as unset", () => {
    expect(readVisionConfig({ vision: {} }).maxOutputTokens).toBeNull();
    expect(readVisionConfig({ vision: {} }).reasoningEffort).toBeNull();
    const nulls = readVisionConfig({
      vision: { maxOutputTokens: null, reasoningEffort: null },
    });
    expect(nulls.maxOutputTokens).toBeNull();
    expect(nulls.reasoningEffort).toBeNull();
  });

  test("a positive integer and a known effort are kept", () => {
    const cfg = readVisionConfig({
      vision: { maxOutputTokens: 4096, reasoningEffort: "medium" },
    });
    expect(cfg.maxOutputTokens).toBe(4096);
    expect(cfg.reasoningEffort).toBe("medium");
    for (const effort of ["none", "low", "medium", "high"]) {
      expect(
        readVisionConfig({ vision: { reasoningEffort: effort } })
          .reasoningEffort,
      ).toBe(effort as never);
    }
  });

  test("a ceiling above the cap is clamped to it", () => {
    expect(
      readVisionConfig({ vision: { maxOutputTokens: 1_000_000 } })
        .maxOutputTokens,
    ).toBe(VISION_MAX_OUTPUT_TOKENS_CAP);
    expect(VISION_MAX_OUTPUT_TOKENS_CAP).toBe(64_000);
  });

  // A value the provider would refuse, or one that would bill a fraction of a token, is dropped
  // rather than sent: the request then carries the provider's default, as if the field were unset.
  test("values a provider cannot take read as unset", () => {
    for (const bad of [0, -100, "abc", 1.5, "4096", Number.NaN]) {
      expect(
        readVisionConfig({ vision: { maxOutputTokens: bad } }).maxOutputTokens,
      ).toBeNull();
    }
    for (const bad of ["extreme", "turbo", "LOW", "", 1]) {
      expect(
        readVisionConfig({ vision: { reasoningEffort: bad } }).reasoningEffort,
      ).toBeNull();
    }
  });
});

describe("vision request: output ceiling", () => {
  test("anthropic unset sends a ceiling above the old 2048, and nothing else new", async () => {
    const { body, url } = await extractWith(
      { provider: "anthropic", model: "claude-haiku-5-5" },
      "document",
    );
    expect(url).toEndWith("/messages");
    // 2048 was the old fixed value, and a Haiku 5.5 read of a long PDF spent it on thinking.
    expect(body.max_tokens as number).toBeGreaterThan(2048);
    expect(Object.keys(body).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
    ]);
  });

  test("openai unset keeps today's body: model and messages only", async () => {
    const { body } = await extractWith({
      provider: "openai",
      model: "gpt-6.1-sol",
    });
    expect(Object.keys(body).sort()).toEqual(["messages", "model"]);
  });

  test("an explicit ceiling lands on each provider's own field", async () => {
    const ant = await extractWith({
      provider: "anthropic",
      maxOutputTokens: 3000,
    });
    expect(ant.body.max_tokens).toBe(3000);

    const oai = await extractWith({
      provider: "openai",
      maxOutputTokens: 3000,
    });
    expect(oai.body.max_completion_tokens).toBe(3000);
    expect(oai.body).not.toHaveProperty("max_tokens");

    const gem = await extractWith({
      provider: "gemini",
      maxOutputTokens: 3000,
    });
    expect(
      (gem.body.generationConfig as Record<string, unknown>)?.maxOutputTokens,
    ).toBe(3000);
    expect(
      gem.body.generationConfig as Record<string, unknown>,
    ).not.toHaveProperty("thinkingConfig");

    // OpenRouter and self-hosted endpoints take the older spelling, which every one of them reads.
    const orr = await extractWith({
      provider: "openrouter",
      maxOutputTokens: 3000,
    });
    expect(orr.body.max_tokens).toBe(3000);
    expect(orr.body).not.toHaveProperty("max_completion_tokens");

    for (const { body } of [ant, oai, gem, orr]) {
      for (const key of ["output_config", "thinking", "reasoning_effort"])
        expect(body).not.toHaveProperty(key);
    }
  });
});

describe("vision request: reasoning effort", () => {
  test("anthropic sends output_config.effort, and `none` turns thinking off", async () => {
    const low = await extractWith(
      { provider: "anthropic", reasoningEffort: "low" },
      "document",
    );
    expect(low.body.output_config).toEqual({ effort: "low" });
    expect(low.body).not.toHaveProperty("thinking");

    const none = await extractWith(
      { provider: "anthropic", reasoningEffort: "none" },
      "document",
    );
    expect(none.body.thinking).toEqual({ type: "disabled" });
    expect(none.body).not.toHaveProperty("output_config");
  });

  // Each family spells "off" differently, and the wrong spelling is a 400 that leaves the file unread.
  test("`none` uses the spelling each Claude family accepts", async () => {
    const off = async (model: string) =>
      (
        await extractWith(
          { provider: "anthropic", model, reasoningEffort: "none" },
          "document",
        )
      ).body;
    for (const model of [
      "claude-haiku-5-5",
      "claude-opus-5",
      "claude-sonnet-4-6",
    ]) {
      const body = await off(model);
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body).not.toHaveProperty("output_config");
    }
    const sonnet = await off("claude-sonnet-5-5");
    expect(sonnet.thinking).toEqual({ type: "between_tools" });
    expect(sonnet).not.toHaveProperty("output_config");
    for (const model of [
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-fable-5",
    ]) {
      const body = await off(model);
      expect(body).not.toHaveProperty("thinking");
      expect(body.output_config).toEqual({ effort: "low" });
    }
  });

  test("openai sends reasoning_effort at the top level and the rest unchanged", async () => {
    const plain = await extractWith({ provider: "openai" }, "document");
    const low = await extractWith(
      { provider: "openai", reasoningEffort: "low" },
      "document",
    );
    expect(low.body.reasoning_effort).toBe("low");
    expect(low.body).not.toHaveProperty("tools");
    const { reasoning_effort: _, ...rest } = low.body;
    expect(rest).toEqual(plain.body);
  });
});

describe("vision result: a read cut by the ceiling says so", () => {
  test("anthropic stop_reason max_tokens", async () => {
    const cut = await extractWith({ provider: "anthropic" }, "document", {
      content: [{ type: "text", text: 'com status "APRO' }],
      stop_reason: "max_tokens",
    });
    expect(cut.out.truncated).toBe(true);
    expect(cut.out.text).toBe('com status "APRO');
    const whole = await extractWith({ provider: "anthropic" }, "document");
    expect(whole.out.truncated).toBe(false);
  });

  test("chat completions finish_reason length", async () => {
    const cut = await extractWith({ provider: "openai" }, "document", {
      choices: [
        { message: { content: "Pedido 123 com sta" }, finish_reason: "length" },
      ],
    });
    expect(cut.out.truncated).toBe(true);
    const whole = await extractWith({ provider: "openai" }, "document");
    expect(whole.out.truncated).toBe(false);
  });

  test("gemini finishReason MAX_TOKENS", async () => {
    const cut = await extractWith({ provider: "gemini" }, "document", {
      candidates: [
        {
          content: { parts: [{ text: "Pedido 1" }] },
          finishReason: "MAX_TOKENS",
        },
      ],
    });
    expect(cut.out.truncated).toBe(true);
    const whole = await extractWith({ provider: "gemini" }, "document");
    expect(whole.out.truncated).toBe(false);
  });
});
