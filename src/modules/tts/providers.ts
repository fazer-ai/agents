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
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

export class TtsError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    // NOTE: never capture the response body (provider detail / billing info).
    super(`TTS ${provider} failed with ${status}`);
    this.name = "TtsError";
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
  if (!res.ok) throw new TtsError("openai", res.status);
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

async function elevenlabsSynthesize(req: TtsRequest): Promise<TtsResult> {
  const base = (req.baseURL ?? "https://api.elevenlabs.io/v1").replace(
    /\/+$/,
    "",
  );
  const output = ELEVENLABS_OUTPUT[req.format] ?? "opus_48000_64";
  const res = await req.fetchImpl(
    `${base}/text-to-speech/${encodeURIComponent(req.voice)}?output_format=${output}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": req.apiKey,
        "content-type": "application/json",
        ...(req.format === "ogg_opus" ? { accept: "audio/ogg" } : {}),
      },
      body: JSON.stringify({ text: req.text, model_id: req.model }),
      redirect: "error",
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new TtsError("elevenlabs", res.status);
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
  if (!res.ok) throw new TtsError("openrouter", res.status);
  return { audio: await res.arrayBuffer(), ...RESULT_BY_FORMAT.mp3 };
}

const PROVIDERS: Record<string, TtsProvider> = {
  openai: {
    defaultModel: "gpt-4o-mini-tts",
    defaultVoice: "alloy",
    formats: ["ogg_opus", "aac", "wav", "mp3"],
    synthesize: openaiSynthesize,
  },
  elevenlabs: {
    defaultModel: "eleven_flash_v2_5",
    defaultVoice: "",
    requiresVoice: true,
    formats: ["ogg_opus", "wav", "mp3"],
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
    synthesize: openrouterSynthesize,
  },
};

export const TTS_PROVIDER_NAMES = Object.keys(PROVIDERS);

export function getTtsProvider(name: string): TtsProvider | null {
  return PROVIDERS[name] ?? null;
}
