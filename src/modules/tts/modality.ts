import { getTtsProvider, pickTtsFormat } from "./providers";
import { shouldReplyWithAudio, type TtsConfig } from "./settings";
import { SPOKEN_NOTICE_DEFAULT } from "./settings-shared";

// WHETHER THIS TURN'S REPLY IS PLANNED AS A VOICE NOTE, decided once, before the model runs
// (issue #859). The model is told "your reply will be spoken" from this answer, and the delivery
// starts from the same one, so the two cannot disagree about the turn they share.
//
// Two parts. The MODE, which is the operator's rule (never / mirror / preference, read against what
// the customer sent and what they asked for). And the IMPOSSIBILITIES that are known before a word
// is generated: a provider this build does not have, one that needs a voice and has none, a channel
// that accepts nothing the provider can emit (openrouter on Instagram), no key at all. Those are the
// same checks the synthesis makes before it spends anything (`synthesizeReply` reads them from here),
// minus the one that needs the network. A reply that is certain to go as text is planned as text,
// so the model is never told "voice" for it.
//
// What this cannot know is decided later and still changes the delivery: the vault entry failing to
// resolve, the provider failing, the #856 gate finding the reply unspeakable, the model choosing
// text, the customer changing their preference mid-turn. Each of those leaves its own `tts` line.

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
