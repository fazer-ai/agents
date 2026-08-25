import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import { AppError } from "@/lib/errors";
import { assertSafeOutboundUrl as defaultAssertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { tryResolveVaultEntry } from "@/modules/vault/service";
import { readProviderJson } from "./provider-listing";

// Non-chat model ids to filter out from OpenAI listings.
const OPENAI_FILTER_SEGMENTS = [
  "embedding",
  "whisper",
  "tts",
  "dall-e",
  "moderation",
  "audio",
  "realtime",
  "transcribe",
  "image",
];
const OPENAI_FILTER_PREFIXES = ["davinci", "babbage"];

function isOpenAiChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (OPENAI_FILTER_PREFIXES.some((p) => lower.startsWith(p))) return false;
  if (OPENAI_FILTER_SEGMENTS.some((s) => lower.includes(s))) return false;
  return true;
}

// The capability the listing is for. Chat is the model that powers the agent; transcription (STT)
// and vision (image/document reading) use their own provider keys and need a different filter.
export type ModelCapability = "chat" | "transcription" | "vision";

// Providers selectable per capability — mirrors the editor's chat/STT/vision provider lists. STT and
// vision use `gemini` (→ Google's listing endpoint); STT also offers `elevenlabs`.
const PROVIDERS_BY_CAPABILITY: Record<ModelCapability, readonly string[]> = {
  chat: MODEL_PROVIDERS,
  transcription: [
    "openai",
    "openai-compatible",
    "gemini",
    "elevenlabs",
    "openrouter",
  ],
  vision: ["openai", "gemini", "anthropic", "openrouter"],
};

// Curated set for providers without a usable list endpoint for the capability. ElevenLabs has no
// /v1/models that returns its speech-to-text models, so we hardcode the stable ids (the picker's
// "use custom" fallback covers anything newer).
const ELEVENLABS_STT_MODELS: ProviderModel[] = [
  { id: "scribe_v2", label: "Scribe v2" },
  { id: "scribe_v1", label: "Scribe v1" },
  { id: "scribe_v1_experimental", label: "Scribe v1 (experimental)" },
];

// OpenAI lists every model on one endpoint, so filter by what the capability needs: transcription
// keeps the whisper/transcribe ids the chat filter drops; chat and vision both want chat models
// (vision-capable ids like gpt-4o are chat models).
function openAiCapabilityFilter(
  capability: ModelCapability,
): (id: string) => boolean {
  if (capability === "transcription") {
    return (id) => {
      const lower = id.toLowerCase();
      return lower.includes("whisper") || lower.includes("transcribe");
    };
  }
  return isOpenAiChatModel;
}

export interface ProviderModel {
  id: string;
  label?: string;
}

// Tenant-scoped credential resolution. Returns null if the entry doesn't exist.
// Fetch happens OUTSIDE runScopedOn to avoid holding a DB transaction during I/O.
async function resolveApiKey(
  base: PrismaClient,
  ctx: TenantContext,
  credentialRef: string,
): Promise<string | null> {
  const entry = await runScopedOn(base, ctx, (db) =>
    tryResolveVaultEntry<unknown>(db, credentialRef),
  );
  if (!entry) return null;
  return typeof entry.secret === "string" ? entry.secret : null;
}

export type KeyResolver = (
  base: PrismaClient,
  ctx: TenantContext,
  credentialRef: string,
) => Promise<string | null>;

// llama.cpp-style servers expose the loaded model FILE PATH as the model id. Give the picker a
// humane label (basename, no .gguf) while the id stays the exact value the API expects.
function compatibleModelLabel(id: string): string {
  const base = id.split(/[\\/]/).pop() ?? id;
  return base.replace(/\.gguf$/i, "") || id;
}

export async function listProviderModels(
  ctx: TenantContext,
  input: {
    provider: string;
    credentialRef?: string;
    baseURL?: string;
    capability?: ModelCapability;
  },
  base: PrismaClient = basePrisma,
  fetchFn: typeof fetch = fetch,
  assertSafe: typeof defaultAssertSafeOutboundUrl = defaultAssertSafeOutboundUrl,
  resolveKey: KeyResolver = resolveApiKey,
): Promise<ProviderModel[]> {
  const { provider, credentialRef, baseURL, capability = "chat" } = input;

  if (!PROVIDERS_BY_CAPABILITY[capability].includes(provider)) {
    throw new AppError(
      `unknown ${capability} provider: ${provider}`,
      400,
      "errors.unknownProvider",
      { capability, provider },
    );
  }

  // ElevenLabs has no usable list endpoint → curated set, no credential needed.
  if (provider === "elevenlabs") return ELEVENLABS_STT_MODELS;

  if (!credentialRef) {
    throw new AppError(
      "A credential is required to list provider models.",
      400,
      "errors.credentialRequired",
    );
  }

  if (provider === "openai-compatible" && !baseURL) {
    throw new AppError(
      "A base URL is required for this provider.",
      400,
      "errors.baseUrlRequired",
    );
  }

  // Resolve key inside a scoped transaction; fetch happens after.
  const apiKey = await resolveKey(base, ctx, credentialRef);
  if (!apiKey) {
    // Credential referenced but not usable yet (a pending vault entry with no secret, or a
    // dangling ref): the request is well-formed, the config just isn't complete. Return an empty
    // list (200) instead of a 400 so the editor's model picker degrades quietly while the operator
    // is still wiring the credential, rather than logging a console error on every open.
    return [];
  }

  const signal = AbortSignal.timeout(10_000);

  // STT/vision use `gemini` for the same vendor Google chat models list under; map it to the
  // Google generativelanguage listing (Gemini models serve chat, vision and audio via the same
  // generateContent surface).
  const apiProvider = provider === "gemini" ? "google" : provider;

  try {
    switch (apiProvider) {
      case "openai": {
        const res = await fetchFn("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (!res.ok) {
          throw new AppError(
            `OpenAI models endpoint returned ${res.status}`,
            502,
            "errors.providerModelsFailed",
            { provider, status: res.status },
          );
        }
        const json = await readProviderJson(res, provider);
        const data = (json as { data?: unknown[] }).data;
        if (!Array.isArray(data)) {
          throw new AppError(
            "unexpected OpenAI models response",
            502,
            "errors.providerListUnexpectedResponse",
            { provider },
          );
        }
        return data
          .map((m) => (m as { id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === "string")
          .filter(openAiCapabilityFilter(capability))
          .sort((a, b) => b.localeCompare(a))
          .map((id) => ({ id }));
      }

      case "deepseek": {
        const res = await fetchFn("https://api.deepseek.com/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (!res.ok) {
          throw new AppError(
            `DeepSeek models endpoint returned ${res.status}`,
            502,
            "errors.providerModelsFailed",
            { provider, status: res.status },
          );
        }
        const json = await readProviderJson(res, provider);
        const data = (json as { data?: unknown[] }).data;
        if (!Array.isArray(data)) {
          throw new AppError(
            "unexpected DeepSeek models response",
            502,
            "errors.providerListUnexpectedResponse",
            { provider },
          );
        }
        return data
          .map((m) => (m as { id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === "string")
          .sort((a, b) => b.localeCompare(a))
          .map((id) => ({ id }));
      }

      case "openrouter": {
        // OpenRouter is OpenAI-compatible; its /models endpoint returns { data: [{ id, name }] }.
        const res = await fetchFn("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (!res.ok) {
          throw new AppError(
            `OpenRouter models endpoint returned ${res.status}`,
            502,
            "errors.providerModelsFailed",
            { provider, status: res.status },
          );
        }
        const json = await readProviderJson(res, provider);
        const data = (json as { data?: unknown[] }).data;
        if (!Array.isArray(data)) {
          throw new AppError(
            "unexpected OpenRouter models response",
            502,
            "errors.providerListUnexpectedResponse",
            { provider },
          );
        }
        const result: ProviderModel[] = [];
        for (const m of data) {
          const model = m as { id?: unknown; name?: unknown } | null;
          if (typeof model?.id !== "string") continue;
          const entry: ProviderModel = { id: model.id };
          if (typeof model.name === "string") entry.label = model.name;
          result.push(entry);
        }
        return result;
      }

      case "anthropic": {
        const res = await fetchFn("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          signal,
        });
        if (!res.ok) {
          throw new AppError(
            `Anthropic models endpoint returned ${res.status}`,
            502,
            "errors.providerModelsFailed",
            { provider, status: res.status },
          );
        }
        const json = await readProviderJson(res, provider);
        const data = (json as { data?: unknown[] }).data;
        if (!Array.isArray(data)) {
          throw new AppError(
            "unexpected Anthropic models response",
            502,
            "errors.providerListUnexpectedResponse",
            { provider },
          );
        }
        const result: ProviderModel[] = [];
        for (const m of data) {
          const model = m as { id?: unknown; display_name?: unknown } | null;
          if (typeof model?.id !== "string") continue;
          const entry: ProviderModel = { id: model.id };
          if (typeof model.display_name === "string") {
            entry.label = model.display_name;
          }
          result.push(entry);
        }
        return result;
      }

      case "google": {
        const res = await fetchFn(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
          {
            headers: { "x-goog-api-key": apiKey },
            signal,
          },
        );
        if (!res.ok) {
          throw new AppError(
            `Google models endpoint returned ${res.status}`,
            502,
            "errors.providerModelsFailed",
            { provider, status: res.status },
          );
        }
        const json = await readProviderJson(res, provider);
        const models = (json as { models?: unknown[] }).models;
        if (!Array.isArray(models)) {
          throw new AppError(
            "unexpected Google models response",
            502,
            "errors.providerListUnexpectedResponse",
            { provider },
          );
        }
        const result: ProviderModel[] = [];
        for (const m of models) {
          const model = m as {
            name?: unknown;
            displayName?: unknown;
            supportedGenerationMethods?: unknown[];
          } | null;
          if (typeof model?.name !== "string") continue;
          const methods = model.supportedGenerationMethods;
          if (!Array.isArray(methods) || !methods.includes("generateContent")) {
            continue;
          }
          const id = model.name.startsWith("models/")
            ? model.name.slice("models/".length)
            : model.name;
          const entry: ProviderModel = { id };
          if (typeof model.displayName === "string") {
            entry.label = model.displayName;
          }
          result.push(entry);
        }
        return result;
      }

      case "openai-compatible": {
        // baseURL already validated above; SSRF guard before fetch.
        // NOTE: allow http for self-hosted/local compatibility.
        const safeUrl = await assertSafe(`${baseURL}/models`, {
          allowHttp: true,
        });
        const res = await fetchFn(safeUrl.toString(), {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (!res.ok) {
          throw new AppError(
            `OpenAI-compatible models endpoint returned ${res.status}`,
            502,
            "errors.providerModelsFailed",
            { provider, status: res.status },
          );
        }
        const json = await readProviderJson(res, provider);
        const data = (json as { data?: unknown[] }).data;
        if (!Array.isArray(data)) {
          throw new AppError(
            "unexpected OpenAI-compatible models response",
            502,
            "errors.providerListUnexpectedResponse",
            { provider },
          );
        }
        return data
          .map((m) => (m as { id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === "string")
          .sort((a, b) => b.localeCompare(a))
          .map((id) => {
            const label = compatibleModelLabel(id);
            return label === id ? { id } : { id, label };
          });
      }

      default:
        throw new AppError(`unsupported provider: ${provider}`, 400);
    }
  } catch (e) {
    // Re-throw AppErrors as-is; wrap network/timeout errors.
    //
    // NOTE: what reaches here has to BE a network error, which is why every read of the parsed body
    // above is null-safe (`readProviderJson` for the body, `?.` for each item). A `TypeError` from
    // reading a field off `null` lands in this catch indistinguishable from a refused connection,
    // and this sentence then sends the operator to check a network that is fine. Two rounds of
    // review on issue #292 found it twice, one layer apart: the body, then the items inside it.
    if (e instanceof AppError) throw e;
    // NOTE: the sentence carries the PROVIDER and not the error text. A failure to reach a host is
    // raised by the client with the request in hand, and Bun's header validation puts the offending
    // header VALUE in the message it throws — measured: `Header 'Authorization' has invalid value:
    // 'Bearer <the vault secret>'`. Interpolating that would answer a write-only credential back to
    // whoever called the listing endpoint. The text stays in `message`, which is the log line, and
    // the catalog entry has no placeholder for it (found by review, issue #292).
    throw new AppError(
      `failed to list models: ${e instanceof Error ? e.message : String(e)}`,
      502,
      "errors.providerListUnreachable",
      { provider },
    );
  }
}
