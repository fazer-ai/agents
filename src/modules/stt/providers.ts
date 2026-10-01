// Speech-to-text provider abstraction. The OpenAI `/audio/transcriptions` multipart shape is a
// de-facto standard (Groq and most self-hosted Whisper servers implement it), so `openai` and
// `openai-compatible` share one adapter (baseURL switch). Gemini and ElevenLabs have their own
// shapes, so each gets a thin adapter. Adding a provider = one function + one registry entry; a
// future generic/declarative provider can slot in behind the same interface without touching callers.

const STT_TIMEOUT_MS = 60_000;

export interface SttRequest {
  audio: ArrayBuffer;
  mimeType: string | null;
  language: string;
  model: string; // already resolved (provider default applied by the caller)
  apiKey: string;
  baseURL: string | null;
  fetchImpl: typeof fetch;
}

// What the provider's own confidence said about the text, for the providers that report one.
// `withheld` means none of it is the customer's: silence and noise come back as fluent text in any
// language and script, and the confidence is what tells them apart (docs/stt.md has the measurement).
export type SttWithheld =
  | { signal: "token_logprob"; meanLogprob: number }
  | { signal: "segments"; droppedSegments: number };

export interface SttResult {
  text: string;
  withheld?: SttWithheld;
  // Segments dropped from a transcription whose other segments were kept.
  droppedSegments?: number;
}

export interface SttProvider {
  defaultModel: string;
  // openai-compatible requires an explicit baseURL (no public default endpoint).
  requiresBaseURL?: boolean;
  transcribe(req: SttRequest): Promise<SttResult>;
}

export class SttError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    // NOTE: never capture the response body — it carries the (PII) transcription / provider detail.
    super(`STT ${provider} failed with ${status}`);
    this.name = "SttError";
  }
}

// WhatsApp voice notes are ogg/opus; map the mime to an extension the multipart APIs recognize.
function fileNameFor(mimeType: string | null): string {
  const m = (mimeType ?? "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "audio.ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "audio.mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac"))
    return "audio.m4a";
  if (m.includes("wav")) return "audio.wav";
  if (m.includes("webm")) return "audio.webm";
  if (m.includes("flac")) return "audio.flac";
  return "audio.ogg";
}

function audioBlob(req: SttRequest): Blob {
  return new Blob([req.audio], { type: req.mimeType ?? "audio/ogg" });
}

// Below these the text is not taken as speech. Measured live (docs/stt.md): on gpt-4o-transcribe,
// silence, noise and speech buried under noise averaged -1.39 or lower per token, clear speech -0.16
// or higher; on Whisper, a segment of silence or noise reported a no-speech probability of 0.82 or
// more, speech 0.69 or less.
const MIN_MEAN_TOKEN_LOGPROB = -1.0;
const MAX_SEGMENT_NO_SPEECH_PROB = 0.7;
const MIN_SEGMENT_AVG_LOGPROB = -1.0;

// The confidence each model family can report through the OpenAI shape: gpt-4o transcription models
// return token logprobs on request, Whisper models per-segment probabilities in `verbose_json`. Any
// other model is asked exactly as before, since a server may not know either parameter.
function confidenceShapeFor(model: string): "logprobs" | "segments" | null {
  const m = model.toLowerCase();
  if (m.startsWith("gpt-4o") && m.includes("transcribe")) return "logprobs";
  if (m.includes("whisper")) return "segments";
  return null;
}

interface OpenAiTranscription {
  text?: string;
  logprobs?: Array<{ logprob?: number }>;
  segments?: Array<{
    text?: string;
    no_speech_prob?: number;
    avg_logprob?: number;
  }>;
}

function judgeTranscription(json: OpenAiTranscription): SttResult {
  const text = (json.text ?? "").trim();
  const lps = (json.logprobs ?? [])
    .map((t) => t.logprob)
    .filter((lp): lp is number => typeof lp === "number");
  if (lps.length > 0) {
    const mean = lps.reduce((a, b) => a + b, 0) / lps.length;
    if (mean < MIN_MEAN_TOKEN_LOGPROB) {
      return {
        text: "",
        withheld: {
          signal: "token_logprob",
          meanLogprob: Math.round(mean * 100) / 100,
        },
      };
    }
    return { text };
  }
  const segments = json.segments ?? [];
  if (segments.length === 0) return { text };
  const spoken = segments.filter(
    (s) =>
      !(
        (s.no_speech_prob ?? 0) > MAX_SEGMENT_NO_SPEECH_PROB ||
        (s.avg_logprob ?? 0) < MIN_SEGMENT_AVG_LOGPROB
      ),
  );
  const dropped = segments.length - spoken.length;
  if (dropped === 0) return { text };
  if (spoken.length === 0) {
    return {
      text: "",
      withheld: { signal: "segments", droppedSegments: dropped },
    };
  }
  return {
    text: spoken
      .map((s) => s.text ?? "")
      .join("")
      .trim(),
    droppedSegments: dropped,
  };
}

// OpenAI Whisper + any OpenAI-compatible endpoint (Groq, self-hosted faster-whisper, …).
async function openaiTranscribe(req: SttRequest): Promise<SttResult> {
  const base = (req.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const post = (shape: "logprobs" | "segments" | null) => {
    const form = new FormData();
    form.append("file", audioBlob(req), fileNameFor(req.mimeType));
    form.append("model", req.model);
    if (req.language) form.append("language", req.language);
    if (shape === "logprobs") {
      form.append("response_format", "json");
      form.append("include[]", "logprobs");
    } else if (shape === "segments") {
      form.append("response_format", "verbose_json");
    }
    return req.fetchImpl(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${req.apiKey}` },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
  };
  const shape = confidenceShapeFor(req.model);
  let res = await post(shape);
  // A compatible server that does not know the confidence parameters may refuse them; the
  // transcription matters more than the confidence, so it is asked again the way it always was.
  if (shape && res.status === 400) res = await post(null);
  if (!res.ok) throw new SttError("openai", res.status);
  return judgeTranscription((await res.json()) as OpenAiTranscription);
}

// ElevenLabs Scribe.
async function elevenlabsTranscribe(req: SttRequest): Promise<SttResult> {
  const base = (req.baseURL ?? "https://api.elevenlabs.io/v1").replace(
    /\/+$/,
    "",
  );
  const form = new FormData();
  form.append("file", audioBlob(req), fileNameFor(req.mimeType));
  form.append("model_id", req.model);
  if (req.language) form.append("language_code", req.language);
  const res = await req.fetchImpl(`${base}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": req.apiKey },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) throw new SttError("elevenlabs", res.status);
  const json = (await res.json()) as { text?: string };
  return { text: (json.text ?? "").trim() };
}

// Google Gemini: transcription via generateContent with the audio inlined as base64. The key goes in
// the x-goog-api-key header (not the URL) to keep it out of logs.
async function geminiTranscribe(req: SttRequest): Promise<SttResult> {
  const base = (
    req.baseURL ?? "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");
  const prompt = `Transcreva o áudio a seguir literalmente${
    req.language ? ` (idioma: ${req.language})` : ""
  }. Responda APENAS com a transcrição, sem comentários nem pontuação extra.`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: req.mimeType ?? "audio/ogg",
              data: Buffer.from(req.audio).toString("base64"),
            },
          },
        ],
      },
    ],
  };
  const res = await req.fetchImpl(
    `${base}/models/${encodeURIComponent(req.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": req.apiKey,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new SttError("gemini", res.status);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return {
    text: parts
      .map((p) => p.text ?? "")
      .join("")
      .trim(),
  };
}

// OpenRouter transcription: dedicated audio API (launched 2026-05-01), JSON + base64 — NOT the
// multipart shape `openaiTranscribe` uses, so it needs its own adapter. Maps the mime to the
// short format token OpenRouter expects (no "audio." prefix, unlike fileNameFor's multipart names).
function audioFormatFor(mimeType: string | null): string {
  const m = (mimeType ?? "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("flac")) return "flac";
  return "ogg";
}

async function openrouterTranscribe(req: SttRequest): Promise<SttResult> {
  const base = (req.baseURL ?? "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    "",
  );
  const body: Record<string, unknown> = {
    model: req.model,
    input_audio: {
      data: Buffer.from(req.audio).toString("base64"),
      format: audioFormatFor(req.mimeType),
    },
  };
  if (req.language) body.language = req.language;
  const res = await req.fetchImpl(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) throw new SttError("openrouter", res.status);
  const json = (await res.json()) as { text?: string };
  return { text: (json.text ?? "").trim() };
}

const PROVIDERS: Record<string, SttProvider> = {
  openai: { defaultModel: "gpt-4o-transcribe", transcribe: openaiTranscribe },
  "openai-compatible": {
    // Generic Whisper id for Groq/self-hosted endpoints (gpt-4o-transcribe is OpenAI-only).
    defaultModel: "whisper-1",
    requiresBaseURL: true,
    transcribe: openaiTranscribe,
  },
  gemini: { defaultModel: "gemini-3.5-flash", transcribe: geminiTranscribe },
  elevenlabs: { defaultModel: "scribe_v2", transcribe: elevenlabsTranscribe },
  openrouter: {
    defaultModel: "openai/whisper-1",
    transcribe: openrouterTranscribe,
  },
};

// FROZEN because it is exported and shared: `sort`, `push` and friends mutate in place, so one
// caller tidying this list reorders it for every other holder in the process. A test did exactly
// that (`STT_PROVIDER_NAMES.sort()`), and the damage landed in an unrelated file that
// compares the published MCP enum against this array. Frozen, that write throws where it is made.
export const STT_PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

export function getSttProvider(name: string): SttProvider | null {
  return PROVIDERS[name] ?? null;
}
