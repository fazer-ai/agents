import { clipText, TEMPLATE_MESSAGE_MAX } from "@/modules/agents/text-caps";
import { formatNextOpen } from "@/modules/business-hours/announce";
import {
  localDateKey,
  nextOpenAt,
  type Schedule,
} from "@/modules/business-hours/hours";

// The customer-facing side of the availability gate. The gate silences the agent outside its schedule
// and tells the OPERATOR with a private note; until this module existed the CUSTOMER was told nothing,
// so from their side the business simply did not answer (issue #153). `awayMessage` is operator-authored
// copy sent as the persona bot from the same branch that posts the note: no model call, no tokens.
//
// Switched off (the default) = the pre-#153 behavior (silence), so the block is additive for every
// existing agent, and an operator who pauses the message keeps the text they wrote.

export interface AvailabilityConfig {
  // The operator's on/off for the message. It exists so pausing does not mean DISCARDING the copy,
  // and because the two sibling blocks whose job is also to send fixed, no-AI text carry the same
  // switch next to their text (`serviceWindow.enabled` beside its template, `channelRedirect.enabled`
  // beside its redirect/closing copy) — a third block spelling "off" as "the textarea is empty"
  // would be the odd one out on the same screen.
  enabled: boolean;
  // What the customer receives while the agent is outside its schedule. Empty = send nothing.
  awayMessage: string;
}

// Off, like every agent behaved before this block existed. Turning it on is a deliberate act.
export const AVAILABILITY_DEFAULTS: AvailabilityConfig = {
  enabled: false,
  awayMessage: "",
};

// The placeholder is the opt-in for interpolating the next opening: an operator who wants it writes it,
// which is why there is no companion boolean. The two spellings also pick the language of the rendered
// value — copy written in Portuguese asks for it in Portuguese — so the feature needs no locale setting
// of its own, and mixed-language output is impossible.
const NEXT_OPEN_PLACEHOLDERS: ReadonlyArray<{ token: string; locale: string }> =
  [
    { token: "{proximo_atendimento}", locale: "pt-BR" },
    { token: "{next_open}", locale: "en-US" },
  ];

export function readAvailabilityConfig(settings: unknown): AvailabilityConfig {
  const bag =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).availability
      : undefined;
  if (!bag || typeof bag !== "object") return { ...AVAILABILITY_DEFAULTS };
  const raw = (bag as Record<string, unknown>).awayMessage;
  // Strict boolean: anything else (absent, "true", 1) reads as off, so a malformed write can only
  // ever silence the message, never start sending one nobody switched on.
  // Clamped like every other operator free-text field: the write boundary refuses copy that is too
  // long, and this is the defense for a row that got one anyway (import, hand-edit, older write).
  return {
    enabled: (bag as Record<string, unknown>).enabled === true,
    awayMessage:
      typeof raw === "string" ? clipText(raw.trim(), TEMPLATE_MESSAGE_MAX) : "",
  };
}

export type AwayRender =
  | { send: false; reason: "disabled" | "not_configured" | "no_next_open" }
  | { send: true; text: string };

// The text the customer receives, or why they receive nothing.
//
// `no_next_open` is the case worth naming: the copy promises a return time ("we are back {next_open}")
// and the schedule never opens inside nextOpenAt's horizon, so there is no honest value to put there.
// Dropping the placeholder would leave the operator's sentence mutilated ("we are back ."), and filling
// it with anything else would be the product inventing a commitment nobody made. Copy that makes no
// promise is unaffected — it goes out as written.
export function renderAwayMessage(params: {
  enabled: boolean;
  copy: string;
  schedule: Schedule;
  now: Date;
}): AwayRender {
  if (!params.enabled) return { send: false, reason: "disabled" };
  const copy = params.copy.trim();
  if (!copy) return { send: false, reason: "not_configured" };

  const used = NEXT_OPEN_PLACEHOLDERS.filter((p) => copy.includes(p.token));
  if (used.length === 0) return { send: true, text: copy };

  const next = nextOpenAt(params.schedule, params.now);
  if (next === null) return { send: false, reason: "no_next_open" };

  let text = copy;
  for (const { token, locale } of used) {
    text = text.replaceAll(
      token,
      formatNextOpen(next, params.now, params.schedule.timezone, locale),
    );
  }
  return { send: true, text };
}

// Is the customer owed the message again? Once per LOCAL day per conversation, in the schedule's
// timezone: a WhatsApp conversation is never closed, so once-per-conversation would mean once per
// customer per lifetime, while a UTC comparison would roll the day over three hours early for
// America/Sao_Paulo. Chatwoot's own inbox out-of-office lands on the same rule
// (`conversation.messages.today.template.empty?`), so an operator migrating off that stopgap gets the
// cadence they already know.
//
// This reads the away message's OWN watermark, never the operator note's: a conversation whose note
// went out earlier today must still receive the message the first time an operator writes one.
export function awayMessageDue(
  schedule: Schedule,
  now: Date,
  lastSentAt: Date | null,
): boolean {
  if (lastSentAt === null) return true;
  return (
    localDateKey(lastSentAt, schedule.timezone) !==
    localDateKey(now, schedule.timezone)
  );
}
