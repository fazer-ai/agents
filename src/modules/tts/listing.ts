import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { assertSafeOutboundUrl as defaultAssertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readProviderJson } from "@/modules/models/provider-listing";
import { tryResolveVaultEntry } from "@/modules/vault/service";
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

// OpenRouter's audio API (launched 2026-05-01) DOES expose a live catalog (GET
// /models?output_modalities=speech, each entry carrying a `supported_voices` array), but voices are
// scoped per model and this function isn't passed the currently-selected model — wiring true live
// listing needs that extra parameter. Until then: curated, verified live against the real catalog
// (no openai/* entries exist here, unlike chat/vision/transcription) AND against a real
// /audio/speech call (confirms the model/voice/response_format combination actually works — see
// providers.ts on why kokoro, not the also-real gemini TTS, is the default). Voices are the default
// model's `supported_voices`; picking a different model needs different voices (combobox "use
// custom" covers it).
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
    // NOTE: the sentence names three possibilities and picks none, because the resolver returns
    // `null` for all three (the ref points at nothing, the entry holds no secret, or the entry is a
    // multi-field/managed credential whose secret is an object rather than an API key) and this
    // code learns nothing else. Naming one of them would be inventing a cause nobody measured,
    // which is the defect issue #292 exists to remove — one layer down. Telling them apart means
    // reading the entry back on the failure path, and that is a behaviour change, not a wording one.
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
    // NOTE: the sentence carries the PROVIDER and not the error text. A failure to reach a host is
    // raised by the client with the request in hand, and Bun's header validation puts the offending
    // header VALUE in the message it throws — measured: `Header 'Authorization' has invalid value:
    // 'Bearer <the vault secret>'`. Interpolating that would answer a write-only credential back to
    // whoever called the listing endpoint. The text stays in `message`, which is the log line, and
    // the catalog entry has no placeholder for it (found by review, issue #292).
    throw new AppError(
      `failed to list ElevenLabs ${kind}: ${e instanceof Error ? e.message : String(e)}`,
      502,
      "errors.providerListUnreachable",
      { provider },
    );
  }
}
