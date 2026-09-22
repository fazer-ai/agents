import type { TtsCheckMode } from "@/config";

// Client for the corrupted-audio detector (issue #779, docs/tts.md "Checking the audio").
//
// The detector is a separate HTTP service the operator runs, and this file is the whole of what the
// agents side knows about it: one POST with the audio and the words it was meant to say, one JSON
// answer. It holds no thresholds. Where "corrupted" starts is calibrated on the detector's side,
// against the deployment's own traffic, so nothing here has a number to drift.

export interface TtsCheckConfig {
  url: string;
  mode: TtsCheckMode;
  token: string;
  timeoutMs: number;
}

export interface TtsCheckVerdict {
  corrupted: boolean;
  // 0..1, or null when the detector did not send one we can trust.
  score: number | null;
  // The failure mode the detector named (`balbucio`, `zumbido`, ...), or null. Slug-shaped only:
  // it is written to the execution log, which never carries free text (docs/logs.md).
  verdict: string | null;
}

const VERDICT_SLUG = /^[a-z0-9_]{1,40}$/i;

export class TtsCheckError extends Error {
  constructor(
    message: string,
    // A closed code for the log line, so the operator can tell "detector down" from "detector
    // answered something we cannot read" without reading an error string.
    readonly code: "timeout" | "http_status" | "network" | "malformed",
  ) {
    super(message);
    this.name = "TtsCheckError";
  }
}

// Throws TtsCheckError on every way the detector can fail to give a usable answer. The caller
// decides what a failure means (in every mode today: send the audio as it is).
export async function checkSynthesizedAudio(params: {
  cfg: TtsCheckConfig;
  audio: ArrayBuffer;
  mime: string;
  fileName: string;
  // The reply as the agent wrote it, and the text that actually went to the synthesizer (after the
  // speech rewrite). Both, because the detector compares what it hears against the words, and the
  // rewrite is what turns "R$ 15.000" into the words that were spoken.
  text: string;
  speech: string;
  fetchImpl?: typeof fetch;
}): Promise<TtsCheckVerdict> {
  const { cfg } = params;
  const form = new FormData();
  // NOTE: a File, not a Blob plus a filename argument: Bun's FormData keeps the name only on a File
  // (a named Blob reads back as "blob"), and the detector picks the decoder by the extension.
  form.append(
    "audio",
    new File([params.audio], params.fileName, { type: params.mime }),
  );
  form.append("text", params.text);
  form.append("speech", params.speech);
  const headers: Record<string, string> = {};
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;

  let res: Response;
  try {
    res = await (params.fetchImpl ?? fetch)(`${cfg.url}/v1/check`, {
      method: "POST",
      body: form,
      headers,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new TtsCheckError(
        `audio check timed out after ${cfg.timeoutMs}ms`,
        "timeout",
      );
    }
    throw new TtsCheckError(
      `audio check request failed: ${e instanceof Error ? e.message : String(e)}`,
      "network",
    );
  }
  if (!res.ok) {
    throw new TtsCheckError(
      `audio check failed with ${res.status}`,
      "http_status",
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new TtsCheckError("audio check answered non-JSON", "malformed");
  }
  return parseVerdict(body);
}

// `corrupted` is the only field a decision rests on, so it is the only one that must be exactly
// right: anything but a boolean is a detector we cannot read, not a clean audio. The other two are
// descriptive and degrade to null.
export function parseVerdict(body: unknown): TtsCheckVerdict {
  if (!body || typeof body !== "object") {
    throw new TtsCheckError("audio check answered no object", "malformed");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.corrupted !== "boolean") {
    throw new TtsCheckError(
      "audio check answered without a boolean `corrupted`",
      "malformed",
    );
  }
  const score =
    typeof b.score === "number" &&
    Number.isFinite(b.score) &&
    b.score >= 0 &&
    b.score <= 1
      ? b.score
      : null;
  const verdict =
    typeof b.verdict === "string" && VERDICT_SLUG.test(b.verdict)
      ? b.verdict
      : null;
  return { corrupted: b.corrupted, score, verdict };
}
