import type { TFunction } from "i18next";
import type { OccurrenceStep } from "@/modules/occurrences/settings";

// What the occurrence monitor's screen says in words (docs/occurrences.md): the sentence under the
// thresholds, a step's name, why a step did not complete, and the two fixed fields. Kept apart from the
// components so each phrase can be checked against what the backend does with the same values.

export interface FlagValues {
  newMinConversations: number;
  windowMinutes: number;
  previousDays: number;
  aboveUsualRatio: number;
  concentrationShare: number;
}

// "in the last hour", "in the last 90 minutes", "in the last 2 hours": the recent window as the flags
// step counts it, `windowMinutes` back from the round.
export function windowPhrase(t: TFunction, minutes: number): string {
  if (minutes % 60 === 0)
    return t("occurrences.sentence.lastHours", "in the last {{count}} hours", {
      count: minutes / 60,
    });
  return t(
    "occurrences.sentence.lastMinutes",
    "in the last {{count}} minutes",
    { count: minutes },
  );
}

// The sentence under the thresholds: what the flags step (src/modules/occurrences/flags.ts, `flagsOf`)
// does with these values. Every flag needs the minimum in the window; then the theme is new when it
// had no conversation in the days before the window, above its usual when it is not new and the
// window runs at that many times its rate over those days, and concentrated when that share of its
// window conversations has one reference. Without a reference field, concentrated is never raised and
// the sentence leaves it out. Null while a value is missing.
export function flagsSentence(
  t: TFunction,
  language: string,
  v: { [K in keyof FlagValues]: number | null },
  hasReference = true,
): string | null {
  if (Object.values(v).some((x) => x === null || !Number.isFinite(x)))
    return null;
  const f = v as FlagValues;
  const ratio = new Intl.NumberFormat(language, {
    maximumFractionDigits: 2,
  }).format(f.aboveUsualRatio);
  const share = new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(f.concentrationShare);
  const parts = {
    conversations: t(
      "occurrences.sentence.conversations",
      "at least {{count}} conversations",
      { count: f.newMinConversations },
    ),
    window: windowPhrase(t, f.windowMinutes),
    previous: t(
      "occurrences.sentence.previousDays",
      "in the {{count}} days before",
      { count: f.previousDays },
    ),
    ratio,
    share,
  };
  return hasReference
    ? t(
        "occurrences.sentence.full",
        "Flags a theme as out of the usual when it has {{conversations}} {{window}} and, on top of that, is new (no conversation {{previous}}), or runs at {{ratio}} times its usual, or has {{share}} of those conversations with the same reference.",
        parts,
      )
    : t(
        "occurrences.sentence.noReference",
        "Flags a theme as out of the usual when it has {{conversations}} {{window}} and, on top of that, is new (no conversation {{previous}}), or runs at {{ratio}} times its usual.",
        parts,
      );
}

export function stepName(t: TFunction, step: OccurrenceStep | null): string {
  switch (step) {
    case "reading":
      return t("occurrences.step.reading", "Conversation reading");
    case "canonical":
      return t("occurrences.step.canonical", "Reference names");
    case "assignment":
      return t("occurrences.step.assignment", "Theme assignment");
    case "consolidation":
      return t("occurrences.step.consolidation", "Theme consolidation");
    default:
      return t("occurrences.step.unknown", "A step");
  }
}

export type SkipReason =
  | "no_model"
  | "spend_ceiling"
  | "round_budget"
  | "unreadable_answer"
  | "credential_unresolved"
  | "credential_not_key"
  | "endpoint_missing"
  | "endpoint_not_taken"
  | "inbox_unreceived"
  | "credential_refused"
  | "model_refused"
  | "rate_limited"
  | "timeout"
  | "endpoint_unreachable"
  | "error";

// Why a step did not complete, from the code the server sends: never the provider's own words,
// which the screen keeps for a details popover.
export function skipReasonText(
  t: TFunction,
  reason: SkipReason,
  inbox: string | null = null,
): string {
  switch (reason) {
    case "no_model":
      return t(
        "occurrences.skip.noModel",
        "it has no model it can run on (check its provider, API key and model)",
      );
    case "spend_ceiling":
      return t(
        "occurrences.skip.spendCeiling",
        "the account's spend ceiling was reached",
      );
    case "round_budget":
      return t(
        "occurrences.skip.roundBudget",
        "the round ran out of time; what it did not do is left for the next one",
      );
    case "unreadable_answer":
      return t(
        "occurrences.skip.unreadable",
        "the model's answer could not be read",
      );
    case "credential_unresolved":
      return t(
        "occurrences.skip.credentialUnresolved",
        "its API key is no longer in the vault (choose another one)",
      );
    case "credential_not_key":
      return t(
        "occurrences.skip.credentialNotKey",
        "the credential chosen is not an API key",
      );
    case "endpoint_missing":
      return t(
        "occurrences.skip.endpointMissing",
        "an OpenAI-compatible model needs a base URL",
      );
    case "endpoint_not_taken":
      return t(
        "occurrences.skip.endpointNotTaken",
        "this provider does not take a base URL (remove it from the model or from its key)",
      );
    case "inbox_unreceived":
      return t(
        "occurrences.skip.inboxUnreceived",
        'no agent receives the inbox "{{inbox}}"; link or observe it with an agent in Channels',
        { inbox: inbox ?? "" },
      );
    case "credential_refused":
      return t(
        "occurrences.skip.credentialRefused",
        "the provider refused the API key",
      );
    case "model_refused":
      return t(
        "occurrences.skip.modelRefused",
        "the provider does not offer this model",
      );
    case "rate_limited":
      return t(
        "occurrences.skip.rateLimited",
        "the provider's rate limit or quota was reached",
      );
    case "timeout":
      return t("occurrences.skip.timeout", "the model took too long to answer");
    case "endpoint_unreachable":
      return t(
        "occurrences.skip.endpointUnreachable",
        "the model's address did not answer",
      );
    default:
      return t("occurrences.skip.errorBare", "the call failed");
  }
}

// A field's key, from the name the admin types: lowercase, accents dropped, anything else an
// underscore, as Chatwoot spells a custom attribute key. Another field's key is not reused: a
// number is added instead.
// A name with no letter or digit has no key: empty, which the screen refuses.
export function keyFromName(name: string, taken: readonly string[]): string {
  const base = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  // A name every object already has (`constructor`, `__proto__`) is refused as a key, so it counts
  // as taken.
  const used = (k: string) => taken.includes(k) || k in Object.prototype;
  if (base === "" || !used(base)) return base;
  for (let n = 2; ; n += 1) {
    const k = `${base}_${n}`;
    if (!used(k)) return k;
  }
}

export interface FixedField {
  name: string;
  description: string;
}

// The two fields every monitor starts with, worded as the monitor is told them: the reason, which is
// grouped into themes, and the reference it refers to, which is optional.
export function fixedFieldDefaults(t: TFunction): {
  reason: FixedField;
  reference: FixedField;
} {
  return {
    reason: {
      name: t("occurrences.fixed.reasonName", "Reason"),
      description: t(
        "occurrences.fixed.reasonDescription",
        "Why the customer got in touch: what they want or report, in one short sentence. Empty when the conversation does not say.",
      ),
    },
    reference: {
      name: t("occurrences.fixed.referenceName", "Reference"),
      description: t(
        "occurrences.fixed.referenceDescription",
        "What the reason refers to, as the customer names it. Empty when the conversation does not say.",
      ),
    },
  };
}
