import { describe, expect, test } from "bun:test";
import { getSttProvider, SttError } from "@/modules/stt/providers";

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const audio = new ArrayBuffer(8);

describe("STT providers", () => {
  test("openai posts multipart to /audio/transcriptions with a Bearer key", async () => {
    const { calls, fetchImpl } = mockFetch({ text: "olá mundo" });
    const provider = getSttProvider("openai");
    const text = await provider?.transcribe({
      audio,
      mimeType: "audio/ogg",
      language: "pt",
      model: "whisper-1",
      apiKey: "sk-x",
      baseURL: null,
      fetchImpl,
    });
    expect(text).toEqual({ text: "olá mundo" });
    expect(calls[0]?.url).toBe(
      "https://api.openai.com/v1/audio/transcriptions",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-x");
    const form = calls[0]?.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("pt");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  test("openai-compatible honors a custom baseURL", async () => {
    const { calls, fetchImpl } = mockFetch({ text: "hi" });
    const provider = getSttProvider("openai-compatible");
    await provider?.transcribe({
      audio,
      mimeType: "audio/mpeg",
      language: "en",
      model: "whisper-large-v3",
      apiKey: "gsk",
      baseURL: "https://api.groq.com/openai/v1",
      fetchImpl,
    });
    expect(calls[0]?.url).toBe(
      "https://api.groq.com/openai/v1/audio/transcriptions",
    );
  });

  test("elevenlabs posts to /speech-to-text with xi-api-key + model_id", async () => {
    const { calls, fetchImpl } = mockFetch({ text: "transcrição" });
    const provider = getSttProvider("elevenlabs");
    const text = await provider?.transcribe({
      audio,
      mimeType: "audio/ogg",
      language: "pt",
      model: "scribe_v1",
      apiKey: "xi",
      baseURL: null,
      fetchImpl,
    });
    expect(text).toEqual({ text: "transcrição" });
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("xi");
    const form = calls[0]?.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v1");
    expect(form.get("language_code")).toBe("pt");
  });

  test("gemini posts inline audio to generateContent and reads the candidate text", async () => {
    const { calls, fetchImpl } = mockFetch({
      candidates: [{ content: { parts: [{ text: "olá do gemini" }] } }],
    });
    const provider = getSttProvider("gemini");
    const text = await provider?.transcribe({
      audio,
      mimeType: "audio/ogg",
      language: "pt",
      model: "gemini-2.0-flash",
      apiKey: "g-key",
      baseURL: null,
      fetchImpl,
    });
    expect(text).toEqual({ text: "olá do gemini" });
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("g-key");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.contents[0].parts[1].inline_data.mime_type).toBe("audio/ogg");
    expect(typeof body.contents[0].parts[1].inline_data.data).toBe("string");
  });

  test("a non-2xx response throws SttError without leaking the body", async () => {
    const { fetchImpl } = mockFetch({ error: "secret detail" }, 401);
    const provider = getSttProvider("openai");
    const p = provider?.transcribe({
      audio,
      mimeType: "audio/ogg",
      language: "pt",
      model: "whisper-1",
      apiKey: "bad",
      baseURL: null,
      fetchImpl,
    });
    await expect(p).rejects.toBeInstanceOf(SttError);
    await expect(p).rejects.toThrow("401");
  });

  test("unknown provider resolves to null", () => {
    expect(getSttProvider("bogus")).toBeNull();
  });

  test("openrouter posts JSON with base64 input_audio to /audio/transcriptions", async () => {
    const { calls, fetchImpl } = mockFetch({ text: "olá da openrouter" });
    const provider = getSttProvider("openrouter");
    const text = await provider?.transcribe({
      audio,
      mimeType: "audio/ogg",
      language: "pt",
      model: "openai/whisper-1",
      apiKey: "sk-or",
      baseURL: null,
      fetchImpl,
    });
    expect(text).toEqual({ text: "olá da openrouter" });
    expect(calls[0]?.url).toBe(
      "https://openrouter.ai/api/v1/audio/transcriptions",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-or");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.model).toBe("openai/whisper-1");
    expect(body.input_audio.format).toBe("ogg");
    expect(body.language).toBe("pt");
    expect(typeof body.input_audio.data).toBe("string");
  });
});

// What the provider says about its own certainty decides whether the text is the customer's. The
// numbers come from the live measurement in docs/stt.md: silence and noise come back as fluent text
// in any language and script, and only the confidence tells them apart from speech.
describe("STT confidence", () => {
  const req = (model: string, fetchImpl: typeof fetch, provider = "openai") =>
    getSttProvider(provider)?.transcribe({
      audio,
      mimeType: "audio/ogg",
      language: "pt",
      model,
      apiKey: "sk-x",
      baseURL: provider === "openai" ? null : "https://stt.example/v1",
      fetchImpl,
    });
  const tokens = (...lps: number[]) =>
    lps.map((logprob, i) => ({ token: `t${i}`, logprob, bytes: [] }));

  test("a gpt-4o transcription asks for its token logprobs", async () => {
    const { calls, fetchImpl } = mockFetch({
      text: "Oi, tudo bem?",
      logprobs: tokens(-0.01, -0.03),
    });
    const out = await req("gpt-4o-transcribe", fetchImpl);
    expect(out).toEqual({
      text: "Oi, tudo bem?",
      confidence: { signal: "token_logprob", meanLogprob: -0.02 },
    });
    const form = calls[0]?.init.body as FormData;
    expect(form.getAll("include[]")).toEqual(["logprobs"]);
    expect(form.get("response_format")).toBe("json");
  });

  test("a gpt-4o transcription the model was unsure of is withheld, whatever its script", async () => {
    for (const text of ["Das ist gut.", "οικογένεια."]) {
      const { fetchImpl } = mockFetch({ text, logprobs: tokens(-1.2, -2.4) });
      const out = await req("gpt-4o-transcribe", fetchImpl);
      expect(out).toEqual({
        text: "",
        confidence: { signal: "token_logprob", meanLogprob: -1.8 },
        withheld: true,
      });
    }
  });

  test("a Whisper transcription asks for its segments and drops the ones with no speech", async () => {
    const { calls, fetchImpl } = mockFetch({
      text: "Oi, boa tarde. Legendas pela comunidade Amara.org",
      segments: [
        { text: "Oi, boa tarde.", no_speech_prob: 0.01, avg_logprob: -0.3 },
        {
          text: " Legendas pela comunidade Amara.org",
          no_speech_prob: 0.85,
          avg_logprob: -0.5,
        },
      ],
    });
    const out = await req("whisper-large-v3", fetchImpl, "openai-compatible");
    expect(out).toEqual({
      text: "Oi, boa tarde.",
      confidence: { signal: "segments", segments: 2, droppedSegments: 1 },
    });
    const form = calls[0]?.init.body as FormData;
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("include[]")).toEqual([]);
  });

  test("a Whisper transcription whose segments are all speech is taken as the provider wrote it", async () => {
    const { fetchImpl } = mockFetch({
      text: "Oi, boa tarde. Tudo bem?",
      segments: [
        { text: " Oi, boa tarde.", no_speech_prob: 0.01, avg_logprob: -0.3 },
        { text: " Tudo bem?", no_speech_prob: 0.02, avg_logprob: -0.2 },
      ],
    });
    expect(await req("whisper-1", fetchImpl)).toEqual({
      text: "Oi, boa tarde. Tudo bem?",
      confidence: { signal: "segments", segments: 2, droppedSegments: 0 },
    });
  });

  test("segments a compatible server trimmed keep their word boundaries", async () => {
    const segs = [
      { text: "Quero marcar", no_speech_prob: 0.01, avg_logprob: -0.2 },
      { text: "uma consulta", no_speech_prob: 0.02, avg_logprob: -0.3 },
    ];
    const kept = mockFetch({
      text: "Quero marcar uma consulta",
      segments: segs,
    });
    expect(
      (await req("whisper-large-v3", kept.fetchImpl, "openai-compatible"))
        ?.text,
    ).toBe("Quero marcar uma consulta");
    const dropped = mockFetch({
      text: "Quero marcar uma consulta Amara.org",
      segments: [
        ...segs,
        { text: "Amara.org", no_speech_prob: 0.9, avg_logprob: -0.5 },
      ],
    });
    expect(
      (await req("whisper-large-v3", dropped.fetchImpl, "openai-compatible"))
        ?.text,
    ).toBe("Quero marcar uma consulta");
  });

  test("with nothing dropped, the provider's own text is kept, spacing included", async () => {
    // Languages written without spaces: a rebuilt text would put one between the segments.
    const { fetchImpl } = mockFetch({
      text: "你好世界",
      segments: [
        { text: "你好", no_speech_prob: 0.01, avg_logprob: -0.2 },
        { text: "世界", no_speech_prob: 0.01, avg_logprob: -0.2 },
      ],
    });
    expect((await req("whisper-1", fetchImpl))?.text).toBe("你好世界");
  });

  test("a Whisper segment the model was unsure of is dropped too", async () => {
    const { fetchImpl } = mockFetch({
      text: "Que Deus te abençoe.",
      segments: [
        {
          text: "Que Deus te abençoe.",
          no_speech_prob: 0.44,
          avg_logprob: -1.42,
        },
      ],
    });
    expect(await req("whisper-1", fetchImpl)).toEqual({
      text: "",
      confidence: { signal: "segments", segments: 1, droppedSegments: 1 },
      withheld: true,
    });
  });

  test("a server that refuses the confidence request is asked again without it", async () => {
    const calls: FormData[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      calls.push(form);
      if (form.get("response_format") === "verbose_json") {
        return new Response("{}", { status: 400 });
      }
      return new Response(JSON.stringify({ text: "olá" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await req("whisper-1", fetchImpl, "openai-compatible")).toEqual({
      text: "olá",
    });
    expect(calls.map((f) => f.get("response_format"))).toEqual([
      "verbose_json",
      null,
    ]);
  });

  test("a model with no known confidence shape is asked exactly as before, and nothing is withheld", async () => {
    const { calls, fetchImpl } = mockFetch({ text: "Ελένη, até amanhã" });
    expect(
      await req("distil-large-v3-pt", fetchImpl, "openai-compatible"),
    ).toEqual({ text: "Ελένη, até amanhã" });
    const form = calls[0]?.init.body as FormData;
    expect(form.get("response_format")).toBeNull();
    expect(form.getAll("include[]")).toEqual([]);
  });

  test("a response that carries no confidence is taken as text", async () => {
    const { fetchImpl } = mockFetch({ text: "olá" });
    expect(await req("gpt-4o-transcribe", fetchImpl)).toEqual({ text: "olá" });
  });
});

// Scribe writes audio events into the transcript ("[silêncio]", "[ruído]") and reports a logprob per
// word. Measured live in docs/stt.md: a note with no speech comes back as a tag alone.
describe("ElevenLabs transcription", () => {
  const scribe = (body: unknown) => {
    const { calls, fetchImpl } = mockFetch(body);
    const out = getSttProvider("elevenlabs")?.transcribe({
      audio,
      mimeType: "audio/ogg",
      language: "pt",
      model: "scribe_v2",
      apiKey: "xi",
      baseURL: null,
      fetchImpl,
    });
    return { calls, out };
  };
  const w = (type: string, text: string, logprob: number) => ({
    type,
    text,
    logprob,
  });

  test("audio events are not asked for", async () => {
    const { calls, out } = scribe({
      text: "Sim",
      words: [w("word", "Sim", -0.01)],
    });
    await out;
    const form = calls[0]?.init.body as FormData;
    expect(form.get("tag_audio_events")).toBe("false");
  });

  test("a note that is only an audio event carries no text", async () => {
    const { out } = scribe({
      text: "[silêncio]",
      words: [w("audio_event", "[silêncio]", -0.03)],
    });
    expect(await out).toEqual({ text: "" });
  });

  test("an audio event inside speech is dropped and the words around it kept", async () => {
    const { out } = scribe({
      text: "Oi, [risos] tudo bem? 😊",
      words: [
        w("word", "Oi,", -0.01),
        w("spacing", " ", 0),
        w("audio_event", "[risos]", -0.2),
        w("spacing", " ", 0),
        w("word", "tudo", -0.02),
        w("spacing", " ", 0),
        w("word", "bem? 😊", -0.03),
      ],
    });
    expect(await out).toEqual({
      text: "Oi, tudo bem? 😊",
      confidence: { signal: "word_logprob", meanLogprob: -0.02 },
    });
  });

  test("a transcription Scribe was unsure of is withheld, whatever is around its words", async () => {
    const { out } = scribe({
      text: "A inflação vai continuar",
      words: [
        w("word", "A", -0.9),
        w("spacing", " ", -0.001),
        w("word", "inflação", -1.6),
        w("audio_event", "[ruído]", -0.01),
      ],
    });
    expect(await out).toEqual({
      text: "",
      confidence: { signal: "word_logprob", meanLogprob: -1.25 },
      withheld: true,
    });
  });
});
