import { describe, expect, test } from "bun:test";
import type { TenantContext } from "@/lib/tenancy";
import { type KeyResolver, listProviderModels } from "@/modules/models/service";

// Pass-through SSRF guard (avoids DNS resolution; keeps the real
// assertSafeOutboundUrl untouched for other test suites).
const passthroughSafe = async (url: string) => new URL(url);

// Key resolver that always returns "fake-api-key" for any credentialRef,
// bypassing the DB and crypto entirely.
const fakeResolveKey: KeyResolver = async (_base, _ctx, ref) => {
  return ref ? "fake-api-key" : null;
};

// Build a fake fetch that returns a successful JSON response.
function makeFetch(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => body,
  })) as unknown as typeof fetch;
}

// Build a fake fetch that returns a non-2xx status.
function makeErrorFetch(status: number): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    json: async () => ({ error: "provider error" }),
  })) as unknown as typeof fetch;
}

const ctx: TenantContext = {
  tenantId: 1n,
  userId: null,
  role: "TENANT_ADMIN",
};

// No real DB needed; the key resolver is fully injected.
const noDb = null as never;

describe("listProviderModels", () => {
  test("openai: filters whisper, embedding, tts models; sorts desc", async () => {
    const body = {
      data: [
        { id: "gpt-4o" },
        { id: "gpt-4o-mini" },
        { id: "whisper-1" },
        { id: "text-embedding-3-small" },
        { id: "tts-1" },
        { id: "dall-e-3" },
        { id: "gpt-3.5-turbo" },
        { id: "babbage-002" },
      ],
    };
    const result = await listProviderModels(
      ctx,
      { provider: "openai", credentialRef: "vault:1" },
      noDb,
      makeFetch(body),
      passthroughSafe,
      fakeResolveKey,
    );
    const ids = result.map((m) => m.id);
    // Chat models only, sorted desc.
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("gpt-4o-mini");
    expect(ids).toContain("gpt-3.5-turbo");
    // Filtered out.
    expect(ids).not.toContain("whisper-1");
    expect(ids).not.toContain("text-embedding-3-small");
    expect(ids).not.toContain("tts-1");
    expect(ids).not.toContain("dall-e-3");
    expect(ids).not.toContain("babbage-002");
    // Sorted descending.
    const gpt4Idx = ids.indexOf("gpt-4o");
    const gpt35Idx = ids.indexOf("gpt-3.5-turbo");
    expect(gpt4Idx).toBeLessThan(gpt35Idx);
  });

  test("anthropic: maps display_name to label", async () => {
    const body = {
      data: [
        { id: "claude-opus-4-5", display_name: "Claude Opus 4.5" },
        { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" },
        { id: "no-label-model" },
      ],
    };
    const result = await listProviderModels(
      ctx,
      { provider: "anthropic", credentialRef: "vault:1" },
      noDb,
      makeFetch(body),
      passthroughSafe,
      fakeResolveKey,
    );
    expect(result).toHaveLength(3);
    const opus = result.find((m) => m.id === "claude-opus-4-5");
    expect(opus?.label).toBe("Claude Opus 4.5");
    const noLabel = result.find((m) => m.id === "no-label-model");
    expect(noLabel?.label).toBeUndefined();
  });

  test("openrouter: maps name to label; keeps every id", async () => {
    const body = {
      data: [
        { id: "openai/gpt-5.4-mini", name: "OpenAI: GPT-5.4 mini" },
        { id: "anthropic/claude-sonnet-4-6", name: "Anthropic: Claude Sonnet" },
        { id: "no-label/model" },
      ],
    };
    const result = await listProviderModels(
      ctx,
      { provider: "openrouter", credentialRef: "vault:1" },
      noDb,
      makeFetch(body),
      passthroughSafe,
      fakeResolveKey,
    );
    expect(result).toHaveLength(3);
    const gpt = result.find((m) => m.id === "openai/gpt-5.4-mini");
    expect(gpt?.label).toBe("OpenAI: GPT-5.4 mini");
    const noLabel = result.find((m) => m.id === "no-label/model");
    expect(noLabel?.label).toBeUndefined();
  });

  test("google: includes only generateContent models; strips models/ prefix", async () => {
    const body = {
      models: [
        {
          name: "models/gemini-pro",
          displayName: "Gemini Pro",
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/embedding-001",
          displayName: "Embedding 001",
          supportedGenerationMethods: ["embedContent"],
        },
        {
          name: "models/gemini-flash",
          displayName: "Gemini Flash",
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
      ],
    };
    const result = await listProviderModels(
      ctx,
      { provider: "google", credentialRef: "vault:1" },
      noDb,
      makeFetch(body),
      passthroughSafe,
      fakeResolveKey,
    );
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gemini-pro");
    expect(ids).toContain("gemini-flash");
    expect(ids).not.toContain("embedding-001");
    // Prefix stripped.
    expect(ids).not.toContain("models/gemini-pro");
    // Label present.
    const pro = result.find((m) => m.id === "gemini-pro");
    expect(pro?.label).toBe("Gemini Pro");
  });

  test("provider error (non-2xx) → AppError 502 with providerModelsFailed key", async () => {
    await expect(
      listProviderModels(
        ctx,
        { provider: "openai", credentialRef: "vault:1" },
        noDb,
        makeErrorFetch(401),
        passthroughSafe,
        fakeResolveKey,
      ),
    ).rejects.toMatchObject({
      statusCode: 502,
      translationKey: "errors.providerModelsFailed",
    });
  });

  test("openai-compatible: path-like ids get a basename label without .gguf, value stays the full id", async () => {
    const path =
      "/Users/x/.cache/huggingface/hub/models--a--B-GGUF/snapshots/68a3/Qwen3.6-35B-A3B-Q4_K_M.gguf";
    const body = { data: [{ id: path }, { id: "gpt-oss-20b" }] };
    const result = await listProviderModels(
      ctx,
      {
        provider: "openai-compatible",
        credentialRef: "vault:1",
        baseURL: "http://localhost:8080/v1",
      },
      noDb,
      makeFetch(body),
      passthroughSafe,
      fakeResolveKey,
    );
    expect(result).toEqual([
      // Sorted desc; a plain id keeps no label (identical to the id).
      { id: "gpt-oss-20b" },
      { id: path, label: "Qwen3.6-35B-A3B-Q4_K_M" },
    ]);
  });

  test("openai-compatible without baseURL → AppError 400", async () => {
    await expect(
      listProviderModels(
        ctx,
        { provider: "openai-compatible", credentialRef: "vault:1" },
        noDb,
        makeFetch({ data: [] }),
        passthroughSafe,
        fakeResolveKey,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("missing credentialRef → AppError 400 with credentialRequired key", async () => {
    await expect(
      listProviderModels(
        ctx,
        { provider: "openai" },
        noDb,
        makeFetch({ data: [] }),
        passthroughSafe,
        fakeResolveKey,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      translationKey: "errors.credentialRequired",
    });
  });

  test("transcription/openai: keeps whisper + transcribe, drops chat models", async () => {
    const body = {
      data: [
        { id: "gpt-4o" },
        { id: "whisper-1" },
        { id: "gpt-4o-transcribe" },
        { id: "gpt-4o-mini" },
      ],
    };
    const result = await listProviderModels(
      ctx,
      {
        provider: "openai",
        credentialRef: "vault:1",
        capability: "transcription",
      },
      noDb,
      makeFetch(body),
      passthroughSafe,
      fakeResolveKey,
    );
    const ids = result.map((m) => m.id);
    expect(ids).toContain("whisper-1");
    expect(ids).toContain("gpt-4o-transcribe");
    expect(ids).not.toContain("gpt-4o");
    expect(ids).not.toContain("gpt-4o-mini");
  });

  test("gemini provider maps to the Google generativelanguage listing", async () => {
    const body = {
      models: [
        {
          name: "models/gemini-2.0-flash",
          displayName: "Gemini 2.0 Flash",
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    };
    const result = await listProviderModels(
      ctx,
      {
        provider: "gemini",
        credentialRef: "vault:1",
        capability: "transcription",
      },
      noDb,
      makeFetch(body),
      passthroughSafe,
      fakeResolveKey,
    );
    expect(result.map((m) => m.id)).toContain("gemini-2.0-flash");
  });

  test("elevenlabs: curated list, no credential or fetch needed", async () => {
    const failFetch = (() => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    const result = await listProviderModels(
      ctx,
      { provider: "elevenlabs", capability: "transcription" },
      noDb,
      failFetch,
      passthroughSafe,
      fakeResolveKey,
    );
    expect(result.map((m) => m.id)).toContain("scribe_v1");
  });

  test("provider not allowed for the capability → AppError 400 unknownProvider", async () => {
    await expect(
      listProviderModels(
        ctx,
        {
          provider: "anthropic",
          credentialRef: "vault:1",
          capability: "transcription",
        },
        noDb,
        makeFetch({ data: [] }),
        passthroughSafe,
        fakeResolveKey,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      translationKey: "errors.unknownProvider",
    });
  });
});
