import { getTtsProvider, pickTtsFormat } from "./providers";
import { shouldReplyWithAudio, type TtsConfig } from "./settings";
import { SPOKEN_NOTICE_DEFAULT } from "./settings-shared";

// Whether this turn's reply is planned as a voice note, decided once before the model runs, so the
// prompt ("your reply will be spoken") and the delivery cannot disagree. It combines the operator's
// mode with the impossibilities known before generation (missing provider, no voice, a channel that
// accepts nothing the provider emits, no key): the same checks `synthesizeReply` reads from here,
// minus the network one. Later failures (vault, provider, the speakability gate, the model choosing
// text, a changed preference) still change the delivery and each leaves its own `tts` line.

export type StaticTtsImpossibility =
  | "unknown_provider"
  | "no_voice"
  | "channel_format_unsupported"
  | "no_credential";

export function staticTtsImpossibility(
  cfg: TtsConfig,
  channelType: string | null | undefined,
): StaticTtsImpossibility | null {
  const provider = getTtsProvider(cfg.provider);
  if (!provider) return "unknown_provider";
  if (provider.requiresVoice && !(cfg.voice || provider.defaultVoice)) {
    return "no_voice";
  }
  if (!pickTtsFormat(provider, channelType ?? null)) {
    return "channel_format_unsupported";
  }
  if (!cfg.credentialRef) return "no_credential";
  return null;
}

export function plannedReplyIsAudio(
  cfg: TtsConfig,
  turn: {
    userSentAudio: boolean;
    contactVoiceReply: boolean | null;
    channelType: string | null | undefined;
    // The playground's "answer in audio" switch, which overrides the mode and nothing else.
    forceAudio?: boolean;
  },
): boolean {
  const asked =
    turn.forceAudio === true ||
    shouldReplyWithAudio(cfg.mode, turn.userSentAudio, turn.contactVoiceReply);
  return asked && staticTtsImpossibility(cfg, turn.channelType) === null;
}

// The notice this turn's model reads, or null for none: only on a turn planned as audio, and only
// when the operator turned it on. Their wording when they wrote one, the default otherwise; a blank
// one never reaches here (the reader drops it), so the notice is never an empty block.
export function spokenNoticeFor(
  cfg: TtsConfig,
  plannedAudio: boolean,
): string | null {
  if (!plannedAudio || !cfg.spokenNotice) return null;
  return cfg.spokenNoticeText ?? SPOKEN_NOTICE_DEFAULT;
}
