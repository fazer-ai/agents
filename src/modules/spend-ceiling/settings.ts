import { z } from "zod";
import { clipText } from "@/lib/text";
import { TEMPLATE_MESSAGE_MAX } from "@/modules/agents/text-caps";

// PER-TENANT SPEND CEILING, read from the free-form `tenant.settings.spendCeiling` bag. Counted in
// DOLLARS, because the invoice is: tokens cannot track a bill. The figure is the usage ledger's
// priced cost, summed into a periodic snapshot (./poll.ts, ./service.ts). TWO CEILINGS, inbox and playground, so an operator testing in a loop cannot lock
// customers out. See docs/spend-ceiling.md.

export interface SpendCeilingConfig {
  enabled: boolean;
  // Dollars allowed per CALENDAR MONTH for `inbox` traffic, as the usage ledger priced it. 0 = no ceiling
  // on this half, which is what an operator who only wants to bound the playground writes.
  monthlyInboxUsd: number;
  // The same, for `playground` traffic. Separate on purpose: an operator testing must not be able
  // to silence the agent for customers.
  monthlyPlaygroundUsd: number;
  // What the customer receives when a turn is refused for being over the ceiling. null = say
  // nothing, which leaves the person waiting with no signal, so the default is a sentence.
  overCeilingMessage: string | null;
  // Whether a refused conversation is opened for humans, with the mechanics contact-auth uses (status
  // `open` ends the bot's attribution). No team target: a Chatwoot team id belongs to one account,
  // and a tenant spans as many accounts as instances; Chatwoot's inbox routing answers it for all.
  handoffEnabled: boolean;
  // Cooldown on the customer copy and the operator note, never on the VERDICT: the ceiling is
  // evaluated on every message regardless. Without it, ten people writing in after the ceiling is
  // reached are answered with the same sentence ten times.
  noticeCooldownSeconds: number;
  // Warn through the alert channels once a verdict lands at or past this fraction of a ceiling. 0 =
  // no warning. Evaluated on the snapshot BEFORE the turn, so one turn spending more than the band can
  // go from allowed straight to over; lowering the fraction buys lead time (docs/spend-ceiling.md).
  warnAtPercent: number;
  // A block saved while the ceiling counted tokens (`monthlyInboxTokens` / `monthlyPlaygroundTokens`)
  // has no price to convert them with, so it is NO CEILING and this says why, for the console.
  // Derived on read, never stored; the first save in dollars clears it. null once a dollar figure
  // exists, or when no token ceiling was ever set.
  legacyTokens: { inbox: number; playground: number } | null;
}

// Off by default; the other fields carry what an operator switching it on would otherwise have to
// think about. The default MESSAGE is what a tenant that never opens this screen shows customers.
// Its verb ("encaminhei") matches `handoffEnabled: true`: the handoff opens the conversation for
// humans and pages nobody. The two fields are independent on screen, so turning the handoff off
// while keeping this text promises something nothing keeps. It names no deadline and invites no retry.
export const SPEND_CEILING_DEFAULTS: SpendCeilingConfig = {
  enabled: false,
  monthlyInboxUsd: 0,
  monthlyPlaygroundUsd: 0,
  overCeilingMessage:
    "Não consigo responder agora. Encaminhei sua mensagem para a equipe.",
  handoffEnabled: true,
  noticeCooldownSeconds: 300,
  warnAtPercent: 80,
  legacyTokens: null,
};

// The ceiling an operator may type (a million dollars a month, which no tenant here approaches and
// which keeps a typo with three extra zeros from being stored as a policy), and the longest a notice
// may stay quiet. Declared here rather than beside the schema below because BOTH sides read them
// now, for the reason `readCount` gives.
export const SPEND_CEILING_USD_MAX = 1_000_000;
export const SPEND_CEILING_NOTICE_COOLDOWN_MAX_SECONDS = 3600;
// The largest token ceiling the old writer accepted; only the legacy marker reads it now.
const LEGACY_TOKENS_MAX = 1_000_000_000_000;

// A count is a non-negative whole number. FALLS BACK rather than throws, like every block in this
// bag, so a malformed write never breaks the webhook. The fallback is the DEFAULT, which for a
// ceiling is `0` ("no ceiling on this half"): inventing a positive number would silence an agent on
// corrupted data, and the console shows the zero. It CLAMPS TO THE WRITER'S MAXIMUM, because
// `updateSpendCeiling` validates this output merged with the patch, and an out-of-band value would
// 422 every save. Read field by field, unlike the sibling blocks, so one bad number keeps the rest.
function readCount(v: unknown, fallback: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < 0) return fallback;
  return Math.min(Math.floor(v), max);
}

// Cents from dollars, with the float error of a decimal amount taken out: `262144.04 * 100` is
// `26214403.999999996`. An amount within the float's precision of a whole cent (or a half cent) IS
// that value, so only a real third decimal reaches the rule. The tolerance scales with the amount.
export function centsOf(usd: number, thirdDecimal: "drop" | "round"): number {
  const raw = usd * 100;
  const tolerance = Math.abs(raw) * Number.EPSILON * 4;
  const nearest = Math.round(raw);
  if (Math.abs(raw - nearest) <= tolerance) return nearest;
  const below = Math.floor(raw);
  if (thirdDecimal === "drop") return below;
  if (Math.abs(raw - (below + 0.5)) <= tolerance) return below + 1;
  return nearest;
}

// Money is read TO THE CENT, and the third decimal is dropped rather than rounded: a ceiling that is
// lower is the safe side of its own field, the same direction every clamp here takes.
function readUsd(v: unknown, fallback: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < 0) return fallback;
  return Math.min(centsOf(v, "drop") / 100, max);
}

export function readSpendCeilingConfig(settings: unknown): SpendCeilingConfig {
  const raw =
    settings && typeof settings === "object"
      ? ((settings as Record<string, unknown>).spendCeiling ?? {})
      : {};
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const message =
    typeof s.overCeilingMessage === "string"
      ? clipText(s.overCeilingMessage.trim(), TEMPLATE_MESSAGE_MAX)
      : s.overCeilingMessage === null
        ? null
        : SPEND_CEILING_DEFAULTS.overCeilingMessage;
  // A token ceiling that was set, on a block no dollar figure has been written to yet.
  const legacyInbox = readCount(s.monthlyInboxTokens, 0, LEGACY_TOKENS_MAX);
  const legacyPlayground = readCount(
    s.monthlyPlaygroundTokens,
    0,
    LEGACY_TOKENS_MAX,
  );
  const legacyTokens =
    (legacyInbox > 0 || legacyPlayground > 0) &&
    s.monthlyInboxUsd === undefined &&
    s.monthlyPlaygroundUsd === undefined
      ? { inbox: legacyInbox, playground: legacyPlayground }
      : null;
  return {
    enabled: s.enabled === true,
    monthlyInboxUsd: readUsd(
      s.monthlyInboxUsd,
      SPEND_CEILING_DEFAULTS.monthlyInboxUsd,
      SPEND_CEILING_USD_MAX,
    ),
    monthlyPlaygroundUsd: readUsd(
      s.monthlyPlaygroundUsd,
      SPEND_CEILING_DEFAULTS.monthlyPlaygroundUsd,
      SPEND_CEILING_USD_MAX,
    ),
    overCeilingMessage: message === "" ? null : message,
    handoffEnabled: s.handoffEnabled !== false,
    noticeCooldownSeconds: readCount(
      s.noticeCooldownSeconds,
      SPEND_CEILING_DEFAULTS.noticeCooldownSeconds,
      SPEND_CEILING_NOTICE_COOLDOWN_MAX_SECONDS,
    ),
    warnAtPercent: readCount(
      s.warnAtPercent,
      SPEND_CEILING_DEFAULTS.warnAtPercent,
      100,
    ),
    legacyTokens,
  };
}

// Bounded, never negative, and ROUNDED to the cent rather than refused for a third decimal: the
// console's input cannot send one, and the HTTP boundary has no float-safe `multipleOf`, so a
// refusal here would be the service saying no first, which the global handler answers as a 500.
// A cent is not a policy the operator did not mean, unlike an extra zero.
const usd = z
  .number()
  .min(0)
  .max(SPEND_CEILING_USD_MAX)
  .transform((v) => centsOf(v, "round") / 100);

// The write side, which REFUSES rather than clamps. The reader above is deliberately lenient (a
// malformed bag must never break the webhook), and the two are not in tension: one answers "what is
// stored", the other answers "may this be stored". An operator who types a ceiling with an extra
// zero has to be told, not quietly given the number they did not mean.
//
// It carries the dollar fields and not the token ones, and not the legacy marker: what is stored
// after a save is exactly this shape, which is how a save in dollars retires a block written in
// tokens (`readSpendCeilingConfig`).
export const spendCeilingSettingsSchema = z.object({
  enabled: z.boolean(),
  monthlyInboxUsd: usd,
  monthlyPlaygroundUsd: usd,
  overCeilingMessage: z.string().max(TEMPLATE_MESSAGE_MAX).nullable(),
  handoffEnabled: z.boolean(),
  noticeCooldownSeconds: z
    .number()
    .int()
    .min(0)
    .max(SPEND_CEILING_NOTICE_COOLDOWN_MAX_SECONDS),
  warnAtPercent: z.number().int().min(0).max(100),
});

// What a save STORES: the schema's output, which is the config without the derived marker.
export type SpendCeilingStored = z.infer<typeof spendCeilingSettingsSchema>;

// The shape a block written in tokens KEEPS when a patch names no dollar field: the schema's output
// minus the dollar fields, plus the token keys the operator has not yet replaced. Stored by
// `updateSpendCeiling` only in that case; read back through `readSpendCeilingConfig`, which turns
// the token keys into `legacyTokens`.
export type SpendCeilingLegacyStored = Omit<
  SpendCeilingStored,
  "monthlyInboxUsd" | "monthlyPlaygroundUsd"
> & { monthlyInboxTokens: number; monthlyPlaygroundTokens: number };
