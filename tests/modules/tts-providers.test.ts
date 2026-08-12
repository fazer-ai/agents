import { describe, expect, test } from "bun:test";
import { getTtsProvider, TtsError } from "@/modules/tts/providers";
import { prepareSpeechText } from "@/modules/tts/service";

interface Call {
  url: string;
  init: RequestInit;
}

function mockAudioFetch(status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(new ArrayBuffer(32), {
      status,
      headers: { "content-type": "audio/ogg" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function mockErrorFetch(
  status: number,
  body: string,
  contentType = "application/json",
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, {
      status,
      headers: { "content-type": contentType },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ELEVEN_REQ = {
  text: "olá",
  voice: "Keren123",
  model: "eleven_flash_v2_5",
  language: "",
  apiKey: "xi",
  baseURL: null,
} as const;

async function synthError(
  provider: string,
  fetchImpl: typeof fetch,
): Promise<TtsError> {
  const err = await getTtsProvider(provider)
    ?.synthesize({ ...ELEVEN_REQ, fetchImpl, format: "ogg_opus" })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TtsError);
  return err as TtsError;
}

describe("prepareSpeechText", () => {
  test("strips markdown, links, emojis and collapses whitespace", () => {
    const out = prepareSpeechText(
      "**Olá!** 😀 veja [aqui](https://x.com)\n\n- item `code`",
    );
    expect(out).not.toContain("**");
    expect(out).not.toContain("😀");
    expect(out).not.toContain("https://");
    expect(out).toContain("Olá!");
    expect(out).toContain("aqui");
    expect(out).toContain("item");
  });
});

describe("TTS providers", () => {
  test("openai posts to /audio/speech and returns Ogg/Opus bytes", async () => {
    const { calls, fetchImpl } = mockAudioFetch();
    const provider = getTtsProvider("openai");
    const res = await provider?.synthesize({
      text: "olá",
      voice: "alloy",
      model: "tts-1",
      language: "",
      apiKey: "sk",
      baseURL: null,
      fetchImpl,
      format: "ogg_opus",
    });
    expect(res?.mime).toBe("audio/ogg");
    expect(res?.fileName).toBe("reply.ogg");
    expect(res?.audio.byteLength).toBe(32);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.voice).toBe("alloy");
    expect(body.input).toBe("olá");
    expect(body.response_format).toBe("opus"); // WhatsApp voice-note (PTT) format
  });

  test("elevenlabs posts to /text-to-speech/{voice} with xi-api-key", async () => {
    const { calls, fetchImpl } = mockAudioFetch();
    const provider = getTtsProvider("elevenlabs");
    await provider?.synthesize({
      text: "olá",
      voice: "Keren123",
      model: "eleven_flash_v2_5",
      language: "",
      apiKey: "xi",
      baseURL: null,
      fetchImpl,
      format: "ogg_opus",
    });
    expect(calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/Keren123?output_format=opus_48000_64",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("xi");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.model_id).toBe("eleven_flash_v2_5");
  });

  test("a non-2xx response throws TtsError", async () => {
    const { fetchImpl } = mockAudioFetch(500);
    const provider = getTtsProvider("openai");
    const p = provider?.synthesize({
      text: "x",
      voice: "alloy",
      model: "tts-1",
      language: "",
      apiKey: "sk",
      baseURL: null,
      fetchImpl,
      format: "ogg_opus",
    });
    await expect(p).rejects.toBeInstanceOf(TtsError);
  });

  test("elevenlabs requires a voice; openai has a default", () => {
    expect(getTtsProvider("elevenlabs")?.requiresVoice).toBe(true);
    expect(getTtsProvider("openai")?.defaultVoice).toBe("alloy");
    expect(getTtsProvider("bogus")).toBeNull();
  });

  // NOTE: Meta's Instagram messaging accepts audio only as aac/m4a/wav/mp4 (ogg AND mp3 are refused by the
  // send job AFTER Chatwoot already shows the message as sent), so the reply container must follow
  // the destination channel instead of being pinned to WhatsApp's Ogg/Opus.
  test("openai honors format 'aac' for an Instagram-bound reply", async () => {
    const { calls, fetchImpl } = mockAudioFetch();
    const provider = getTtsProvider("openai");
    const res = await provider?.synthesize({
      text: "olá",
      voice: "alloy",
      model: "tts-1",
      language: "",
      apiKey: "sk",
      baseURL: null,
      fetchImpl,
      format: "aac",
    });
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.response_format).toBe("aac");
    expect(res?.mime).toBe("audio/aac");
    expect(res?.fileName).toBe("reply.aac");
  });

  test("elevenlabs honors format 'wav': raw PCM request wrapped in a RIFF header", async () => {
    const { calls, fetchImpl } = mockAudioFetch();
    const provider = getTtsProvider("elevenlabs");
    const res = await provider?.synthesize({
      text: "olá",
      voice: "Keren123",
      model: "eleven_flash_v2_5",
      language: "",
      apiKey: "xi",
      baseURL: null,
      fetchImpl,
      format: "wav",
    });
    // NOTE: ElevenLabs has no aac/wav output; pcm_24000 is raw 16-bit mono PCM, wrapped locally (44-byte
    // RIFF header, no transcode).
    expect(calls[0]?.url).toContain("output_format=pcm_24000");
    expect(res?.mime).toBe("audio/wav");
    expect(res?.fileName).toBe("reply.wav");
    const head = res ? new TextDecoder().decode(res.audio.slice(0, 4)) : "";
    expect(head).toBe("RIFF");
  });

  test("format 'ogg_opus' keeps today's WhatsApp voice-note output", async () => {
    const { calls, fetchImpl } = mockAudioFetch();
    const provider = getTtsProvider("openai");
    const res = await provider?.synthesize({
      text: "olá",
      voice: "alloy",
      model: "tts-1",
      language: "",
      apiKey: "sk",
      baseURL: null,
      fetchImpl,
      format: "ogg_opus",
    });
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.response_format).toBe("opus");
    expect(res?.mime).toBe("audio/ogg");
    expect(res?.fileName).toBe("reply.ogg");
  });

  test("openrouter posts to /audio/speech with mp3 (no Opus option) and returns audio/mpeg", async () => {
    const { calls, fetchImpl } = mockAudioFetch();
    const provider = getTtsProvider("openrouter");
    const res = await provider?.synthesize({
      text: "olá",
      voice: "af_alloy",
      model: "hexgrad/kokoro-82m",
      language: "",
      apiKey: "sk-or",
      baseURL: null,
      fetchImpl,
      format: "mp3",
    });
    expect(res?.mime).toBe("audio/mpeg");
    expect(res?.fileName).toBe("reply.mp3");
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/audio/speech");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-or");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.model).toBe("hexgrad/kokoro-82m");
    expect(body.voice).toBe("af_alloy");
    expect(body.response_format).toBe("mp3");
  });
});

// NOTE: `ogg_opus` is our INTERNAL container name, not a wire value — each adapter maps it onto its own
// provider parameter. An operator who read `format: "ogg_opus"` on a failing tts log line next to a
// 400 reasonably concluded that string was what we sent to ElevenLabs (it never was: the URL carries
// `output_format=opus_48000_64`). providerFormat is what the log now reports alongside it.
describe("providerFormat", () => {
  test("reports the provider-level value each container maps onto", () => {
    const elevenlabs = getTtsProvider("elevenlabs");
    expect(elevenlabs?.providerFormat("ogg_opus")).toBe("opus_48000_64");
    expect(elevenlabs?.providerFormat("wav")).toBe("pcm_24000");
    expect(elevenlabs?.providerFormat("mp3")).toBe("mp3_44100_128");
    // ElevenLabs cannot emit aac; pickTtsFormat never asks for it, and the fallback stays Opus.
    expect(elevenlabs?.providerFormat("aac")).toBe("opus_48000_64");

    const openai = getTtsProvider("openai");
    expect(openai?.providerFormat("ogg_opus")).toBe("opus");
    expect(openai?.providerFormat("aac")).toBe("aac");

    // openrouter renders every container as mp3 (no Opus option in its audio API).
    expect(getTtsProvider("openrouter")?.providerFormat("ogg_opus")).toBe(
      "mp3",
    );
  });

  test("the reported value is the one the adapter actually sends", async () => {
    const elevenlabs = getTtsProvider("elevenlabs");
    for (const format of ["ogg_opus", "wav"] as const) {
      const { calls, fetchImpl } = mockAudioFetch();
      await elevenlabs?.synthesize({ ...ELEVEN_REQ, fetchImpl, format });
      expect(calls[0]?.url).toContain(
        `output_format=${elevenlabs?.providerFormat(format)}`,
      );
    }

    const openai = getTtsProvider("openai");
    const { calls, fetchImpl } = mockAudioFetch();
    await openai?.synthesize({
      ...ELEVEN_REQ,
      voice: "alloy",
      model: "tts-1",
      fetchImpl,
      format: "aac",
    });
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.response_format).toBe(openai?.providerFormat("aac"));
  });
});

// NOTE: a failing synth used to surface only "failed with 400" — the provider's own machine-readable
// status was discarded with the body, which is what made a real 400 undiagnosable from the Logs
// page. The code is kept; the free-text message (provider detail / billing info) still is not.
describe("TTS provider error codes", () => {
  test("elevenlabs: detail.status is kept, its message is not", async () => {
    const { fetchImpl } = mockErrorFetch(
      400,
      JSON.stringify({
        detail: {
          status: "voice_not_found",
          message: "A voice with voice_id Keren123 was not found.",
        },
      }),
    );
    const err = await synthError("elevenlabs", fetchImpl);
    expect(err.code).toBe("voice_not_found");
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      "TTS elevenlabs failed with 400 (voice_not_found)",
    );
  });

  test("openai: error.code is kept, the key fragment in its message is not", async () => {
    const { fetchImpl } = mockErrorFetch(
      401,
      JSON.stringify({
        error: {
          code: "invalid_api_key",
          type: "invalid_request_error",
          message: "Incorrect API key provided: sk-proj-abc123.",
        },
      }),
    );
    const err = await synthError("openai", fetchImpl);
    expect(err.code).toBe("invalid_api_key");
    expect(err.message).not.toContain("sk-proj");
  });

  test("error.type serves when the provider sends no code", async () => {
    const { fetchImpl } = mockErrorFetch(
      429,
      JSON.stringify({ error: { type: "rate_limit_exceeded", message: "…" } }),
    );
    const err = await synthError("openrouter", fetchImpl);
    expect(err.code).toBe("rate_limit_exceeded");
  });

  test("a prose-only field is NOT captured (a code is a slug, a message is not)", async () => {
    const { fetchImpl } = mockErrorFetch(
      400,
      JSON.stringify({
        detail: "Your account balance of $12.40 is insufficient for this call.",
      }),
    );
    const err = await synthError("elevenlabs", fetchImpl);
    expect(err.code).toBeNull();
    expect(err.message).toBe("TTS elevenlabs failed with 400");
  });

  test("a non-JSON body (proxy/gateway error page) yields no code", async () => {
    const { fetchImpl } = mockErrorFetch(
      502,
      "<html><body>502 Bad Gateway</body></html>",
      "text/html",
    );
    const err = await synthError("elevenlabs", fetchImpl);
    expect(err.code).toBeNull();
    expect(err.message).toBe("TTS elevenlabs failed with 502");
  });

  test("an oversized body is not parsed", async () => {
    const { fetchImpl } = mockErrorFetch(
      400,
      JSON.stringify({
        detail: { status: "voice_not_found", pad: "x".repeat(9000) },
      }),
    );
    const err = await synthError("elevenlabs", fetchImpl);
    expect(err.code).toBeNull();
  });

  // NOTE: a chunked error body declares no length, so the cap has to hold while streaming — and the
  // stream must be cancelled rather than drained, or an endless body keeps the turn alive.
  test("an unbounded streaming body is capped and the stream cancelled", async () => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("x".repeat(4_096)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const err = await synthError("elevenlabs", fetchImpl);
    expect(err.code).toBeNull();
    expect(err.message).toBe("TTS elevenlabs failed with 400");
    expect(cancelled).toBe(true);
    // Bounded by the cap (8192 / 4096), not by the body: a stream that never ends still stops here.
    expect(pulls).toBeLessThanOrEqual(4);
  });

  test("an empty body yields no code", async () => {
    const { fetchImpl } = mockErrorFetch(500, "");
    const err = await synthError("elevenlabs", fetchImpl);
    expect(err.code).toBeNull();
    expect(err.message).toBe("TTS elevenlabs failed with 500");
  });
});
