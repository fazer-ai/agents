// NOTE: Text-to-speech provider abstraction. Each provider has a different shape, so each gets a thin
// adapter behind one interface + registry. Adding a provider = one function + one registry entry, no
// caller changes. The API key is a vault entry; provider/voice are per-agent. The OUTPUT CONTAINER
// follows the destination channel (TtsRequest.format, chosen by pickTtsFormat): WhatsApp renders a
// recorded voice note (PTT) only when the audio is **Ogg/Opus** — anything else arrives as a plain
// file attachment — while Meta's Instagram messaging accepts audio only as aac/m4a/wav/mp4 and
// refuses ogg AND mp3 (the send job fails AFTER Chatwoot shows the message as sent, so the customer
// silently never receives it). openai emits aac natively; elevenlabs has no aac/wav output, so its
// Instagram replies are raw PCM wrapped in a 44-byte RIFF header locally (pcmToWav — a header write,
// not a transcode); openrouter only emits mp3 and therefore cannot serve Instagram at all (the
// service falls back to a text reply there).

import type { TtsVoiceSettings } from "./settings-shared";
import { pcmToWav } from "./wav";

const TTS_TIMEOUT_MS = 60_000;

// NOTE: the audio container the reply is delivered in, decided per destination channel by pickTtsFormat.
export type TtsOutputFormat = "ogg_opus" | "aac" | "wav" | "mp3";

export interface TtsRequest {
  text: string;
  voice: string; // already resolved (provider default applied by the caller)
  model: string;
  language: string;
  apiKey: string;
  baseURL: string | null;
  fetchImpl: typeof fetch;
  // NOTE: delivery container for the destination channel (see pickTtsFormat). Adapters map it onto their
  // provider parameter and return the matching mime/fileName.
  format: TtsOutputFormat;
  // NOTE: how the words are delivered (see TtsVoiceSettings). Omitted/null = the operator set nothing,
  // so the adapter drops the field entirely instead of sending its own idea of a default.
  voiceSettings?: TtsVoiceSettings | null;
}

export interface TtsResult {
  audio: ArrayBuffer;
  mime: string;
  fileName: string;
}

export interface TtsProvider {
  defaultModel: string;
  defaultVoice: string;
  requiresVoice?: boolean;
  requiresBaseURL?: boolean;
  // NOTE: containers this provider can emit; pickTtsFormat picks from these per channel.
  formats: readonly TtsOutputFormat[];
  // NOTE: the provider-level value a container maps onto (ElevenLabs `output_format=opus_48000_64`,
  // OpenAI `response_format: "opus"`). The adapters build their request from this same function, so
  // what the flow log reports is what went on the wire — `ogg_opus` alone is our INTERNAL name and
  // has been read as the wire value by operators debugging a failed synth.
  providerFormat(format: TtsOutputFormat): string;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

export class TtsError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    // NOTE: the provider's own machine-readable error code, when it sent one (see readProviderErrorCode).
    readonly code: string | null = null,
  ) {
    // NOTE: never capture the response body (provider detail / billing info) — only the code, which is
    // what turns an opaque "failed with 400" into something an operator can act on.
    super(`TTS ${provider} failed with ${status}${code ? ` (${code})` : ""}`);
    this.name = "TtsError";
  }
}

// NOTE: a provider error body is not a safe thing to keep (free-text messages carry account/billing
// detail and echoed credentials), but the machine-readable STATUS inside it is: `voice_not_found`,
// `invalid_api_key`, `quota_exceeded` each end a debugging session in one line. Known shapes:
// ElevenLabs `{detail: {status}}`, OpenAI/OpenRouter `{error: {code|type}}`.
const MAX_ERROR_BODY = 8_192;
// NOTE: the guard that keeps prose out by construction — a code is a slug, a message has spaces and
// punctuation. A body whose "code" field holds a sentence is dropped rather than logged.
const ERROR_CODE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function pickErrorCode(value: unknown): string | null {
  return typeof value === "string" && ERROR_CODE_RE.test(value) ? value : null;
}

// NOTE: reads at most `max` bytes and cancels the stream past that, instead of `res.text()`, which
// buffers the WHOLE body before any size check — a chunked error body has no declared length, so an
// unbounded one would be fully materialized just to be discarded.
async function readCappedText(
  res: Response,
  max: number,
): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

// NOTE: reads the provider's error code off a failed response. Never throws and never returns free text:
// a body that is absent, oversized, not JSON, or carries no slug-shaped code yields null.
export async function readProviderErrorCode(
  res: Response,
): Promise<string | null> {
  try {
    const raw = await readCappedText(res, MAX_ERROR_BODY);
    if (!raw) return null;
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object") return null;
    const { detail, error, status, code } = body as Record<string, unknown>;
    const nested = (v: unknown, key: string): unknown =>
      v && typeof v === "object" ? (v as Record<string, unknown>)[key] : null;
    return (
      pickErrorCode(nested(detail, "status")) ??
      pickErrorCode(nested(error, "code")) ??
      pickErrorCode(nested(error, "type")) ??
      pickErrorCode(status) ??
      pickErrorCode(code) ??
      null
    );
  } catch {
    return null;
  }
}

// NOTE: Chatwoot infers file_type "audio" from the audio/* mime + the extension, and `is_recorded_audio`
// marks it as a recording; baileys then sends Ogg/Opus to WhatsApp as a PTT voice note.
const RESULT_BY_FORMAT: Record<
  TtsOutputFormat,
  Pick<TtsResult, "mime" | "fileName">
> = {
  ogg_opus: { mime: "audio/ogg", fileName: "reply.ogg" },
  aac: { mime: "audio/aac", fileName: "reply.aac" },
  wav: { mime: "audio/wav", fileName: "reply.wav" },
  mp3: { mime: "audio/mpeg", fileName: "reply.mp3" },
};

// NOTE: picks the container for the destination channel. Instagram (Meta messaging) accepts audio only as
// aac/m4a/wav/mp4 — ogg and mp3 are refused by the send job AFTER Chatwoot already shows the message
// as sent, so the customer silently never receives the reply. Every other channel keeps the
// WhatsApp-first default: Ogg/Opus (native PTT voice note) when the provider can emit it, else the
// provider's mp3 file behavior. Returns null when the provider cannot emit any container the channel
// accepts — the caller must fall back to a text reply.
export function pickTtsFormat(
  provider: TtsProvider,
  channelType: string | null,
): TtsOutputFormat | null {
  if (channelType === "Channel::Instagram") {
    if (provider.formats.includes("aac")) return "aac";
    if (provider.formats.includes("wav")) return "wav";
    return null;
  }
  return provider.formats.includes("ogg_opus") ? "ogg_opus" : "mp3";
}

// NOTE: OpenAI speech: POST /audio/speech; response_format maps 1:1 from the requested container ("opus"
// returns an Ogg-Opus stream, the WhatsApp voice-note format; "aac" serves Instagram natively).
const OPENAI_FORMAT: Record<TtsOutputFormat, string> = {
  ogg_opus: "opus",
  aac: "aac",
  wav: "wav",
  mp3: "mp3",
};

async function openaiSynthesize(req: TtsRequest): Promise<TtsResult> {
  const base = (req.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await req.fetchImpl(`${base}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${req.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      input: req.text,
      voice: req.voice,
      response_format: OPENAI_FORMAT[req.format],
    }),
    redirect: "error",
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new TtsError("openai", res.status, await readProviderErrorCode(res));
  return { audio: await res.arrayBuffer(), ...RESULT_BY_FORMAT[req.format] };
}

// NOTE: ElevenLabs text-to-speech: POST /text-to-speech/{voice_id}?output_format=…. Opus output was added
// 2025-03; 48kHz/64kbps is ample for a voice note. There is no aac/wav output, so the "wav"
// container is served as pcm_24000 (raw 16-bit mono PCM, available on every plan tier) wrapped in a
// RIFF header locally — a 44-byte header write, no transcode.
const ELEVENLABS_OUTPUT: Partial<Record<TtsOutputFormat, string>> = {
  ogg_opus: "opus_48000_64",
  wav: "pcm_24000",
  mp3: "mp3_44100_128",
};
const ELEVENLABS_PCM_RATE = 24_000;

function elevenlabsOutput(format: TtsOutputFormat): string {
  return ELEVENLABS_OUTPUT[format] ?? "opus_48000_64";
}

// Maps our provider-neutral delivery knobs onto ElevenLabs' `voice_settings`, dropping every field the
// operator left unset so the payload never asserts a default we invented. Returns undefined when
// nothing was set, which keeps the body identical to what we sent before this existed — ElevenLabs
// then falls back to the settings saved on the voice itself.
function elevenlabsVoiceSettings(
  v: TtsVoiceSettings | null | undefined,
): Record<string, number | boolean> | undefined {
  if (!v) return undefined;
  const out: Record<string, number | boolean> = {};
  // NOTE: typeof rather than a null check — the fields are optional on the type, so an absent knob is
  // undefined, and `undefined !== null` would put an undefined into the payload.
  if (typeof v.stability === "number") out.stability = v.stability;
  if (typeof v.similarityBoost === "number")
    out.similarity_boost = v.similarityBoost;
  if (typeof v.style === "number") out.style = v.style;
  if (typeof v.speed === "number") out.speed = v.speed;
  if (typeof v.speakerBoost === "boolean")
    out.use_speaker_boost = v.speakerBoost;
  return Object.keys(out).length ? out : undefined;
}

async function elevenlabsSynthesize(req: TtsRequest): Promise<TtsResult> {
  const base = (req.baseURL ?? "https://api.elevenlabs.io/v1").replace(
    /\/+$/,
    "",
  );
  const output = elevenlabsOutput(req.format);
  const res = await req.fetchImpl(
    `${base}/text-to-speech/${encodeURIComponent(req.voice)}?output_format=${output}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": req.apiKey,
        "content-type": "application/json",
        ...(req.format === "ogg_opus" ? { accept: "audio/ogg" } : {}),
      },
      body: JSON.stringify({
        text: req.text,
        model_id: req.model,
        // NOTE: JSON.stringify drops an undefined value, so an agent with no knobs set sends exactly
        // the two fields it always sent.
        voice_settings: elevenlabsVoiceSettings(req.voiceSettings),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    },
  );
  if (!res.ok)
    throw new TtsError(
      "elevenlabs",
      res.status,
      await readProviderErrorCode(res),
    );
  const raw = await res.arrayBuffer();
  if (req.format === "wav") {
    return {
      audio: pcmToWav(raw, ELEVENLABS_PCM_RATE),
      ...RESULT_BY_FORMAT.wav,
    };
  }
  return { audio: raw, ...RESULT_BY_FORMAT[req.format] };
}

// NOTE: OpenRouter speech: dedicated audio API (launched 2026-05-01), POST /audio/speech. Unlike openai/
// elevenlabs it has NO Opus output option (only "mp3"/"pcm", and pcm's sample rate varies per routed
// model, so it cannot be safely wrapped), so the reply arrives at WhatsApp as a plain file
// attachment instead of a native voice note (PTT) — surfaced as a warning in the editor — and
// Instagram cannot be served at all (pickTtsFormat returns null there; the service falls back to a
// text reply). The `format` field is accepted but always rendered as mp3.
async function openrouterSynthesize(req: TtsRequest): Promise<TtsResult> {
  const base = (req.baseURL ?? "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    "",
  );
  const res = await req.fetchImpl(`${base}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${req.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      input: req.text,
      voice: req.voice,
      response_format: "mp3",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new TtsError(
      "openrouter",
      res.status,
      await readProviderErrorCode(res),
    );
  return { audio: await res.arrayBuffer(), ...RESULT_BY_FORMAT.mp3 };
}

const PROVIDERS: Record<string, TtsProvider> = {
  openai: {
    defaultModel: "gpt-4o-mini-tts",
    defaultVoice: "alloy",
    formats: ["ogg_opus", "aac", "wav", "mp3"],
    providerFormat: (format) => OPENAI_FORMAT[format],
    synthesize: openaiSynthesize,
  },
  elevenlabs: {
    defaultModel: "eleven_flash_v2_5",
    defaultVoice: "",
    requiresVoice: true,
    formats: ["ogg_opus", "wav", "mp3"],
    providerFormat: elevenlabsOutput,
    synthesize: elevenlabsSynthesize,
  },
  openrouter: {
    // Verified live end-to-end (GET /models?output_modalities=speech + a real /audio/speech call).
    // OpenRouter's speech catalog has NO openai/* entries. Picked over the (also real)
    // google/gemini-3.1-flash-tts-preview because Gemini's TTS only accepts response_format="pcm"
    // (rejects "mp3" with a 400), which would need server-side WAV wrapping; kokoro accepts "mp3"
    // directly, matching openrouterSynthesize's fixed response_format, and is the cheapest model in
    // the catalog. Voice/model namespaces are the underlying vendor's and vary per model (switching
    // model requires picking a matching voice — same caveat as elevenlabs).
    defaultModel: "hexgrad/kokoro-82m",
    defaultVoice: "af_alloy",
    formats: ["mp3"],
    providerFormat: () => "mp3",
    synthesize: openrouterSynthesize,
  },
};

// FROZEN because it is exported and shared: `sort`, `push` and friends mutate in place, so one
// caller tidying this list reorders it for every other holder in the process. A test did exactly
// that (`TTS_PROVIDER_NAMES.sort()`), and the damage landed in an unrelated file that
// compares the published MCP enum against this array. Frozen, that write throws where it is made.
export const TTS_PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

export function getTtsProvider(name: string): TtsProvider | null {
  return PROVIDERS[name] ?? null;
}
