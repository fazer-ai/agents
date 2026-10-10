import { describe, expect, test } from "bun:test";
import { DECISION_PROVIDER_REGISTRY } from "@/modules/decisions/providers";
import { getSttProvider, STT_PROVIDER_NAMES } from "@/modules/stt/providers";
import { getTtsProvider, TTS_PROVIDER_NAMES } from "@/modules/tts/providers";
import {
  getVisionProvider,
  VISION_PROVIDER_NAMES,
} from "@/modules/vision/providers";

// Every provider adapter the app calls with an operator's credential answers for the other end's
// text: what a provider writes in a failed response may quote the customer's content or the
// operator's account, and the error's `.message` reaches execution_logs, alerts and the
// conversation's private note. So each registered adapter is handed a failure whose body is that
// kind of text, in every field the known error shapes use, and its error must not repeat it.
// Embeddings (`throughProvider`) are held to the same rule in
// tests/modules/rag-embeddings-failure.test.ts.

const QUOTED = "Maria disse que o CPF dela termina em 4471";

function hostile(status: number): typeof fetch {
  const body = JSON.stringify({
    error: { message: QUOTED, code: QUOTED, type: QUOTED },
    detail: { status: QUOTED, message: QUOTED },
    message: QUOTED,
  });
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function messageOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (e) {
    return (e as Error).message;
  }
  return "did not throw";
}

const BASE_URL = "https://203.0.113.10/v1";

describe("a provider's failure text stays out of the error", () => {
  for (const status of [400, 500]) {
    test(`speech-to-text, every adapter, on a ${status}`, async () => {
      const leaked: string[] = [];
      for (const name of STT_PROVIDER_NAMES) {
        const provider = getSttProvider(name);
        if (!provider) throw new Error(`${name} left the registry`);
        const message = await messageOf(() =>
          provider.transcribe({
            audio: new Uint8Array([1, 2, 3]).buffer,
            mimeType: "audio/ogg",
            language: "pt",
            model: provider.defaultModel || "m",
            apiKey: "k",
            baseURL: BASE_URL,
            fetchImpl: hostile(status),
          }),
        );
        if (message === "did not throw" || message.includes(QUOTED)) {
          leaked.push(`${name}: ${message}`);
        }
      }
      expect(leaked).toEqual([]);
    });

    test(`text-to-speech, every adapter, on a ${status}`, async () => {
      const leaked: string[] = [];
      for (const name of TTS_PROVIDER_NAMES) {
        const provider = getTtsProvider(name);
        if (!provider) throw new Error(`${name} left the registry`);
        const message = await messageOf(() =>
          provider.synthesize({
            text: "Olá",
            voice: "v",
            model: "m",
            language: "pt",
            apiKey: "k",
            baseURL: BASE_URL,
            fetchImpl: hostile(status),
            format: "ogg_opus",
          }),
        );
        if (message === "did not throw" || message.includes(QUOTED)) {
          leaked.push(`${name}: ${message}`);
        }
      }
      expect(leaked).toEqual([]);
    });

    test(`vision, every adapter and kind, on a ${status}`, async () => {
      const leaked: string[] = [];
      for (const name of VISION_PROVIDER_NAMES) {
        const provider = getVisionProvider(name);
        if (!provider) throw new Error(`${name} left the registry`);
        for (const [kind, mimeType] of [
          ["image", "image/png"],
          ["document", "application/pdf"],
        ] as const) {
          const message = await messageOf(() =>
            provider.extract({
              bytes: new Uint8Array([1, 2, 3]).buffer,
              mimeType,
              kind,
              prompt: "descreva",
              model: provider.defaultModel || "m",
              apiKey: "k",
              baseURL: BASE_URL,
              fetchImpl: hostile(status),
              timeoutMs: 5_000,
            }),
          );
          if (message === "did not throw" || message.includes(QUOTED)) {
            leaked.push(`${name} ${kind}: ${message}`);
          }
        }
      }
      expect(leaked).toEqual([]);
    });

    test(`decisions, every adapter, on a ${status}`, async () => {
      const leaked: string[] = [];
      for (const [name, provider] of Object.entries(
        DECISION_PROVIDER_REGISTRY,
      )) {
        const message = await messageOf(() =>
          provider.decide({
            input: "oi",
            questions: [
              { name: "quer_comprar", type: "yes_no", instructions: "?" },
            ],
            model: "m",
            apiKey: "k",
            baseURL: BASE_URL,
            fetchImpl: hostile(status),
            signal: new AbortController().signal,
          }),
        );
        if (message === "did not throw" || message.includes(QUOTED)) {
          leaked.push(`${name}: ${message}`);
        }
      }
      expect(leaked).toEqual([]);
    });
  }
});
