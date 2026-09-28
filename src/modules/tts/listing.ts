import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { assertSafeOutboundUrl as defaultAssertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readProviderJson } from "@/modules/models/provider-listing";
import { tryResolveApiKeyEntry } from "@/modules/vault/service";
import { TTS_PROVIDER_NAMES } from "./providers";

// Lists the voices / models the editor's TTS combobox offers (item 10). OpenAI has no list endpoint
// for its named voices/speech models, so we serve a curated set (the combobox's "use custom" covers
// anything newer). ElevenLabs voices are per-account, so we fetch them live with the tenant's vault
// key — the operator picks from their real voices instead of guessing a voice_id.

export interface TtsListItem {
  id: string;
  label?: string;
}

export type TtsListKind = "voices" | "models";

const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
];
const OPENAI_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];

// OpenRouter exposes a live speech catalog, but voices are scoped per model and this function is not
// given the selected model, so the list is curated and verified against a real /audio/speech call.
// Voices are the default model's (see providers.ts for why kokoro); another model needs other
// voices, which the combobox's "use custom" covers.
const OPENROUTER_VOICES = [
  "af_alloy",
  "af_bella",
  "af_heart",
  "af_nova",
  "am_adam",
  "am_michael",
  "bf_emma",
  "bm_george",
];
const OPENROUTER_MODELS = [
  "hexgrad/kokoro-82m",
  "google/gemini-3.1-flash-tts-preview",
  "microsoft/mai-voice-2",
  "x-ai/grok-voice-tts-1.0",
  "mistralai/voxtral-mini-tts-2603",
  "sesame/csm-1b",
  "canopylabs/orpheus-3b-0.1-ft",
];

async function resolveApiKey(
  base: PrismaClient,
  ctx: TenantContext,
  credentialRef: string,
): Promise<string | null> {
  const entry = await runScopedOn(base, ctx, (db) =>
    tryResolveApiKeyEntry(db, credentialRef),
  );
  // One null for three states, on purpose: the picker lists what it can, and an unusable credential
  // yields the same empty list as a missing one. The `state` split serves the runtime's log lines.
  return entry.state === "ok" ? entry.secret : null;
}

export type KeyResolver = (
  base: PrismaClient,
  ctx: TenantContext,
  credentialRef: string,
) => Promise<string | null>;

export async function listTtsOptions(
  ctx: TenantContext,
  input: {
    provider: string;
    kind: TtsListKind;
    credentialRef?: string;
    baseURL?: string;
  },
  base: PrismaClient = basePrisma,
  fetchFn: typeof fetch = fetch,
  assertSafe: typeof defaultAssertSafeOutboundUrl = defaultAssertSafeOutboundUrl,
  resolveKey: KeyResolver = resolveApiKey,
): Promise<TtsListItem[]> {
  const { provider, kind, credentialRef, baseURL } = input;

  if (!TTS_PROVIDER_NAMES.includes(provider)) {
    throw new AppError(
      `unknown tts provider: ${provider}`,
      400,
      "errors.unknownProvider",
      { capability: "tts", provider },
    );
  }

  // OpenAI: curated (no list endpoint for named voices / speech models), no credential needed.
  if (provider === "openai") {
    return (kind === "voices" ? OPENAI_VOICES : OPENAI_MODELS).map((id) => ({
      id,
    }));
  }

  // OpenRouter: also curated (no list endpoint for named voices / speech models), no credential
  // needed.
  if (provider === "openrouter") {
    return (kind === "voices" ? OPENROUTER_VOICES : OPENROUTER_MODELS).map(
      (id) => ({ id }),
    );
  }

  if (provider !== "elevenlabs") return [];

  if (!credentialRef) {
    throw new AppError(
      "A credential is required to list provider models.",
      400,
      "errors.credentialRequired",
    );
  }
  const apiKey = await resolveKey(base, ctx, credentialRef);
  if (!apiKey) {
    // NOTE: the sentence names three possibilities and picks none, because the resolver returns `null`
    // for all three (no entry, no secret, or a multi-field credential) and naming one would invent a
    // cause. Telling them apart would need a read-back on the failure path.
    throw new AppError(
      "credential did not resolve to an API key",
      400,
      "errors.credentialNotUsable",
    );
  }

  const root = (baseURL ?? "https://api.elevenlabs.io/v1").replace(/\/+$/, "");
  const safeUrl = await assertSafe(`${root}/${kind}`, { allowHttp: true });
  try {
    const res = await fetchFn(safeUrl.toString(), {
      headers: { "xi-api-key": apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new AppError(
        `ElevenLabs ${kind} endpoint returned ${res.status}`,
        502,
        "errors.providerModelsFailed",
        { provider, status: res.status },
      );
    }
    const json = await readProviderJson(res, provider);
    if (kind === "voices") {
      const voices = (json as { voices?: unknown[] }).voices;
      if (!Array.isArray(voices)) {
        throw new AppError(
          "unexpected ElevenLabs voices response",
          502,
          "errors.providerListUnexpectedResponse",
          { provider },
        );
      }
      return voices
        .map((v) => v as { voice_id?: unknown; name?: unknown } | null)
        .map((v) => ({
          id: typeof v?.voice_id === "string" ? v.voice_id : "",
          label: typeof v?.name === "string" ? v.name : undefined,
        }))
        .filter((v) => v.id.length > 0);
    }
    // models: a bare array of { model_id, name, can_do_text_to_speech }.
    const arr = Array.isArray(json)
      ? json
      : (json as { models?: unknown[] }).models;
    if (!Array.isArray(arr)) {
      throw new AppError(
        "unexpected ElevenLabs models response",
        502,
        "errors.providerListUnexpectedResponse",
        { provider },
      );
    }
    return arr
      .map(
        (m) =>
          m as {
            model_id?: unknown;
            name?: unknown;
            can_do_text_to_speech?: unknown;
          } | null,
      )
      .filter((m) => m?.can_do_text_to_speech !== false)
      .map((m) => ({
        id: typeof m?.model_id === "string" ? m.model_id : "",
        label: typeof m?.name === "string" ? m.name : undefined,
      }))
      .filter((m) => m.id.length > 0);
  } catch (e) {
    if (e instanceof AppError) throw e;
    // NOTE: the sentence carries the provider, not the error text: Bun's header validation puts the
    // header VALUE in its message (`'Bearer <the vault secret>'`), which would echo a write-only
    // credential to the caller. The text stays in `message`, the log line.
    throw new AppError(
      `failed to list ElevenLabs ${kind}: ${e instanceof Error ? e.message : String(e)}`,
      502,
      "errors.providerListUnreachable",
      { provider },
    );
  }
}
