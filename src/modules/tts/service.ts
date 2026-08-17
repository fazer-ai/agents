import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import {
  getTtsProvider,
  pickTtsFormat,
  type TtsResult,
} from "@/modules/tts/providers";
import { tryResolveVaultEntry } from "@/modules/vault/service";
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
  };
  // Optional execution-flow context: when present, the provider synth is logged as a `tts` stage.
  flow?: FlowContext;
}

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
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
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

  return withFlowStage(
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
}
