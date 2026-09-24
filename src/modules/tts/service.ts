import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { trackFlowWrite } from "@/modules/flowlog/scheduled";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import {
  checkSynthesizedAudio,
  type TtsCheckConfig,
  TtsCheckError,
  type TtsCheckVerdict,
} from "@/modules/tts/check";
import {
  getTtsProvider,
  pickTtsFormat,
  type TtsResult,
} from "@/modules/tts/providers";
import { tryResolveApiKeyEntry } from "@/modules/vault/service";
import { type TtsConfig, voiceSettingsOf } from "./settings";

// Text-to-speech orchestration: normalize the reply for speech, synthesize via the configured
// provider (key from the vault), and return the audio for the Chatwoot voice-note upload. The
// audio-vs-text DECISION lives in settings.shouldReplyWithAudio (pure); this module only renders the
// audio once that decision is yes. All network I/O is outside transactions; deps injectable for tests.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Emoji ranges + an optional trailing variation selector (FE0F kept OUTSIDE the class — a combining
// char inside a class is a lint/correctness hazard).
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]\u{FE0F}?/gu;

// Light text-for-speech normalization (no LLM): drop markdown formatting, links→label, emojis, and
// collapse whitespace so the TTS engine reads clean prose. Full SSML/number-spelling is a future
// enhancement (modern multilingual voices handle most of it).
export function prepareSpeechText(input: string): string {
  return input
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [label](url) → label
    .replace(/`+/g, "") // inline/code-fence backticks
    .replace(/(\*\*|\*|__|_|~~)/g, "") // bold / italic / strike markers
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^[-*+]\s+/gm, "") // bullet markers
    .replace(EMOJI, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export interface SynthesizeReplyParams {
  tenantId: bigint;
  cfg: TtsConfig;
  text: string;
  // NOTE: the conversation's Chatwoot channel class ("Channel::Api", "Channel::Instagram", …).
  // Decides the audio container via pickTtsFormat: Instagram refuses WhatsApp's Ogg/Opus (and mp3),
  // so the reply must be aac/wav there. Absent/null keeps the WhatsApp-first default.
  channelType?: string | null;
  base?: PrismaClient;
  deps?: {
    fetchImpl?: typeof fetch;
    // Opt-in LLM text-for-speech normalizer (built by the runtime from the agent's model). Best-effort:
    // a throw/timeout here falls back to the un-normalized speech text. Only invoked when cfg.normalize.
    normalizeSpeech?: (text: string) => Promise<string>;
    // The detector's transport, apart from the provider's: a test fakes the two independently.
    checkFetchImpl?: typeof fetch;
  };
  // Optional execution-flow context: when present, the provider synth is logged as a `tts` stage.
  flow?: FlowContext;
  // The corrupted-audio check (issue #779). Defaults to the deployment's `config.ttsCheck`.
  check?: TtsCheckConfig;
  // Asked before paying for a regeneration: true = the turn this audio belongs to was called off,
  // so a new synthesis would be billed for a reply nobody will send.
  shouldStop?: () => Promise<boolean>;
}

// How many times an audio the detector called corrupted is synthesized again before the reply goes
// out as text instead. Two, because the defect is a property of one synthesis and not of the text
// (the provider gets no seed, so the same words come back as different audio), and a text that fails
// three times in a row is telling us something no fourth attempt will fix.
export const MAX_TTS_REGENERATIONS = 2;

// Returns the synthesized audio, or null when TTS is not runnable (no key / misconfigured / empty
// text). Throws only on a hard provider error so the caller can fall back to a text reply.
export async function synthesizeReply(
  params: SynthesizeReplyParams,
): Promise<TtsResult | null> {
  const { cfg } = params;
  const base = params.base ?? basePrisma;
  let speech = prepareSpeechText(params.text);
  if (!speech) return null;

  // Surface a misconfig skip on the turn trail / Logs (warn + skipped), so a TTS that silently does
  // nothing is visible to the operator instead of just falling back to text with no trace.
  const skip = (reason: string): null => {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "tts",
        level: "warn",
        status: "skipped",
        provider: cfg.provider,
        detail: { reason },
      });
    }
    return null;
  };

  const provider = getTtsProvider(cfg.provider);
  if (!provider) {
    logger.warn("tts: unknown provider %s", cfg.provider);
    return skip("unknown_provider");
  }
  const voice = cfg.voice || provider.defaultVoice;
  if (provider.requiresVoice && !voice) {
    logger.warn("tts: provider %s requires a voice — skipping", cfg.provider);
    return skip("no_voice");
  }
  // NOTE: container per destination channel. Like every other check here it runs BEFORE the paid
  // rewrite below, so an unsupported combination skips without burning a call whose output would be
  // discarded. null = the provider cannot emit anything this channel accepts (openrouter on
  // Instagram: mp3-only, and Meta refuses mp3) — synthesizing would produce a message Chatwoot shows
  // as sent and Meta then rejects, so degrade to a text reply with a visible skip.
  const format = pickTtsFormat(provider, params.channelType ?? null);
  if (!format) {
    logger.warn(
      "tts: provider %s has no output format accepted on %s — falling back to text",
      cfg.provider,
      params.channelType,
    );
    return skip("channel_format_unsupported");
  }

  if (!cfg.credentialRef) {
    logger.warn("tts: no credentialRef configured — skipping");
    return skip("no_credential");
  }
  const entry = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    tryResolveApiKeyEntry(db, cfg.credentialRef as string),
  );
  if (entry.state !== "ok") {
    // Gone/unfilled and wrong-KIND are separate lines because the operator's move differs: re-pick or
    // fill one, move the other to the field it belongs on (issue #471).
    if (entry.state === "unusable") {
      logger.warn(
        "tts: credential %s is a %s credential, which cannot be used as an API key — skipping",
        cfg.credentialRef,
        entry.kind,
      );
      return skip("credential_unusable");
    }
    logger.warn(
      "tts: credential %s not found in the vault — skipping",
      cfg.credentialRef,
    );
    return skip("credential_not_found");
  }
  // NOTE: credential baseUrl takes precedence over the agent config baseURL (config is a fallback).
  // The requiresBaseURL check uses the effective value so a credential-stored URL satisfies the guard.
  const effectiveBaseURL = entry.baseUrl ?? cfg.baseURL;
  if (provider.requiresBaseURL && !effectiveBaseURL) {
    logger.warn("tts: provider %s requires a baseURL — skipping", cfg.provider);
    return skip("no_base_url");
  }

  // The rewrite for speech, LAST of all: it is a billed model call, and every check above can still
  // abort this synthesis. It used to run before the credential was even resolved, which was harmless
  // while the rewrite was opt-in and is not now that it ships on: an agent set to mirror/preference
  // with no TTS credential would pay for a rewrite on every audio-triggering turn and still fall back
  // to text. Best-effort: any failure here keeps the raw speech text. The Chatwoot transcribedText
  // keeps the ORIGINAL reply either way; only the synth input is rewritten.
  if (cfg.normalize && params.deps?.normalizeSpeech) {
    try {
      const normalized = (await params.deps.normalizeSpeech(speech)).trim();
      if (normalized) speech = normalized;
    } catch (e) {
      logger.warn(
        "tts: speech normalization failed, using raw text: %s",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  const synth = (attempt: number): Promise<TtsResult> =>
    withFlowStage(
      params.flow,
      "tts",
      {
        provider: cfg.provider,
        model: cfg.model || provider.defaultModel,
        // NOTE: `format` is our internal container name; `providerFormat` is the value that actually goes on
        // the wire (ElevenLabs `output_format`, OpenAI `response_format`). Both, because a failing line
        // showing only "ogg_opus" reads like the wire value and has been reported as one.
        detail: {
          normalized: cfg.normalize,
          format,
          providerFormat: provider.providerFormat(format),
          // Which synthesis of this reply the line is: 1, or a regeneration after the detector
          // called the previous one corrupted (issue #779).
          attempt,
          // AND NOT THE REPLY ITSELF, which is the fix this issue asked for and the one the
          // contract refuses (issue #763). `docs/logs.md` promises `execution_logs` NEVER carries
          // message text: that promise is what makes the Logs page and `GET /v1/logs` exportable,
          // and `redactSecretsDeep` removes credentials, not a customer's name or number, which a
          // reply routinely repeats back. The spoken words live on the conversation instead — the
          // audio attachment's `transcribed_text`, which `GET /v1/conversations/:id/messages`
          // already returns — and that surface has the access control this one does not.
        },
        // TTS is best-effort: the runtime falls back to a text reply on a synth error, so log a warn
        // (advisory), not a red error, on the conversation/Logs.
        errorLevel: "warn",
      },
      () =>
        provider.synthesize({
          text: speech,
          voice,
          model: cfg.model || provider.defaultModel,
          language: "",
          apiKey: entry.secret,
          baseURL: effectiveBaseURL,
          fetchImpl: params.deps?.fetchImpl ?? fetch,
          format,
          voiceSettings: voiceSettingsOf(cfg),
        }),
    );

  // Synthesized ONCE per attempt from the same `speech`: a regeneration repeats the synthesis and
  // never the rewrite above, which is a billed model call whose output did not change.
  let out = await synth(1);
  // The deployment owns the detector; the agent may pick what the check does with it (issue #802),
  // and one that never picked follows the deployment's mode.
  const deployment = params.check ?? config.ttsCheck;
  const check: TtsCheckConfig = {
    ...deployment,
    mode: cfg.checkMode ?? deployment.mode,
  };
  if (check.mode === "off" || !check.url) return out;

  const ask = (audio: TtsResult, attempt: number) =>
    runAudioCheck({
      check,
      audio,
      text: params.text,
      speech,
      attempt,
      flow: params.flow,
      fetchImpl: params.deps?.checkFetchImpl,
    });

  if (check.mode === "shadow") {
    // NOT awaited, and that is the whole mode: the send does not wait on the detector, and what it
    // answers changes nothing but a log line. Tracked with the flow writes so a test (or shutdown)
    // settling them also settles this. `runAudioCheck` never throws.
    const first = out;
    trackFlowWrite(
      ask(first, 1).then((c) => {
        if (c) {
          reportCheck(
            params.flow,
            check,
            c,
            1,
            c.verdict.corrupted ? "flagged" : "passed",
          );
        }
      }),
    );
    return out;
  }

  for (let attempt = 1; ; attempt++) {
    const c = await ask(out, attempt);
    // No usable answer (down, slow, unreadable): the audio goes out as it is. A detector outage must
    // never cost the customer the reply, and the line already written says why it went unchecked.
    if (!c) return out;
    if (!c.verdict.corrupted) {
      reportCheck(params.flow, check, c, attempt, "passed");
      return out;
    }
    if (attempt > MAX_TTS_REGENERATIONS) {
      // null is the "no audio" answer every caller already turns into a text reply.
      reportCheck(params.flow, check, c, attempt, "rejected");
      logger.warn(
        "tts: the audio check rejected %d syntheses in a row, replying with text",
        attempt,
      );
      return null;
    }
    // NOTE: asked BEFORE the line is written, because the line names what happened: a turn called
    // off here regenerates nothing, and `regenerated` would record a synthesis that never ran. null,
    // not the audio in hand: it is known to be corrupted, and a caller must never be handed one as
    // if it were the reply.
    if (params.shouldStop && (await params.shouldStop())) {
      reportCheck(params.flow, check, c, attempt, "called_off");
      return null;
    }
    reportCheck(params.flow, check, c, attempt, "regenerated");
    out = await synth(attempt + 1);
  }
}

// What THIS function did with the verdict, never what happened to the reply afterwards: the send is
// the caller's, and a turn can still be called off or a send fail after this returns. So shadow says
// `flagged` (corrupted, and not held back), not "sent".
type CheckOutcome =
  | "passed"
  | "regenerated"
  | "rejected"
  | "called_off"
  | "flagged";

interface CheckAnswer {
  verdict: TtsCheckVerdict;
  durationMs: number;
}

// One call to the detector. Never throws: a failure is written as its own line (warn, with the
// closed code) and comes back as null, which every mode reads as "send what you have".
async function runAudioCheck(params: {
  check: TtsCheckConfig;
  audio: TtsResult;
  text: string;
  speech: string;
  attempt: number;
  flow?: FlowContext;
  fetchImpl?: typeof fetch;
}): Promise<CheckAnswer | null> {
  const start = Date.now();
  try {
    const verdict = await checkSynthesizedAudio({
      cfg: params.check,
      audio: params.audio.audio,
      mime: params.audio.mime,
      fileName: params.audio.fileName,
      text: params.text,
      speech: params.speech,
      fetchImpl: params.fetchImpl,
    });
    return { verdict, durationMs: Date.now() - start };
  } catch (e) {
    const code = e instanceof TtsCheckError ? e.code : "network";
    logger.warn(
      "tts: audio check unavailable (%s), sending the audio unchecked: %s",
      code,
      e instanceof Error ? e.message : String(e),
    );
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "tts_check",
        level: "warn",
        status: "error",
        durationMs: Date.now() - start,
        detail: {
          mode: params.check.mode,
          attempt: params.attempt,
          outcome: "unavailable",
          reason: code,
        },
        // NOTE: our own closed wording, never the thrown message: a network failure carries the
        // runtime's text, and the column promises no words we did not choose (docs/logs.md). The
        // full message is in the process log above.
        errorMessage: `audio check unavailable (${code})`,
      });
    }
    return null;
  }
}

// The verdict line. Ids, numbers and enums only, like every `detail`: the detector's `verdict` is
// admitted only slug-shaped (check.ts), and nothing it sends besides the three fields is read at all,
// so no words from the audio or the reply can reach the execution log through it.
function reportCheck(
  flow: FlowContext | undefined,
  check: TtsCheckConfig,
  c: CheckAnswer,
  attempt: number,
  outcome: CheckOutcome,
): void {
  if (!flow) return;
  emitFlowEvent(flow, {
    stage: "tts_check",
    // warn whenever the audio was corrupted, whatever was done about it: that is the line an alert
    // channel subscribes to, and a regeneration that saved the reply still means the provider
    // produced a broken audio.
    level: c.verdict.corrupted ? "warn" : "info",
    status: "ok",
    durationMs: c.durationMs,
    detail: {
      mode: check.mode,
      attempt,
      outcome,
      corrupted: c.verdict.corrupted,
      score: c.verdict.score,
      verdict: c.verdict.verdict,
    },
  });
}
