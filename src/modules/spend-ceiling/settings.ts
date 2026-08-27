import { z } from "zod";
import { clipText } from "@/lib/text";
import { TEMPLATE_MESSAGE_MAX } from "@/modules/agents/text-caps";

// PER-TENANT TOKEN CEILING, read from the free-form `tenant.settings.spendCeiling` bag (issue #146).
//
// Nothing in the system could refuse a model call because a tenant had spent enough: `LlmUsage` is
// an accurate ledger written AFTER each call, and every reader of it is a projection. The first
// time an operator learned a month had gone wrong was the dashboard, or the provider's invoice.
//
// COUNTED IN TOKENS, not in currency, and that is the one decision the shape rests on. Cost in this
// codebase comes from Langfuse (src/modules/analytics/langfuse-costs.ts), which is optional and
// asynchronous, and the dashboard already treats a zero-cost series as "ingestion lag, or pricing
// not configured" rather than "spent nothing". A gate cannot be built on a number that is optional,
// lagging, and legitimately zero. Tokens are written by our own callback and are queryable on an
// index that already exists.
//
// TWO CEILINGS, because the ledger already separates the two kinds of traffic and they fail
// differently. Real customer traffic is driven by how many people write in, which is the variable
// the operator does not control; the playground is one operator testing a prompt in a loop, which
// is the cheapest way to discover there was no ceiling at all. A single ceiling would let the
// second one lock the first out of answering customers.

export interface SpendCeilingConfig {
  enabled: boolean;
  // Tokens allowed per CALENDAR MONTH for `inbox` traffic, counted as prompt + completion. That
  // sum already INCLUDES the cached reads, because a cached read is a discounted subset of the
  // prompt tokens rather than a separate charge; adding the cached column on top would count the
  // same token twice (see `tokensUsedSince`). 0 = no ceiling on this half, which is what an
  // operator who only wants to bound the playground writes.
  monthlyInboxTokens: number;
  // The same, for `playground` traffic. Separate on purpose: an operator testing must not be able
  // to silence the agent for customers.
  monthlyPlaygroundTokens: number;
  // What the customer receives when a turn is refused for being over the ceiling. null = say
  // nothing, which leaves the person waiting with no signal, so the default is a sentence.
  overCeilingMessage: string | null;
  // Whether a refused conversation is opened for humans: the same mechanics contact-auth uses, where
  // status `open` ends the bot's attribution and the human queue picks the conversation up.
  //
  // NO TEAM TARGET HERE, and that is the one place this block deliberately offers less than the
  // per-agent gate it is modelled on. A Chatwoot team id belongs to ONE account, and contact-auth
  // carries the account alongside it precisely so a pinned team is ignored in the wrong one. This
  // ceiling is per TENANT, and a tenant spans as many Chatwoot accounts as it has instances, so a
  // single stored team would be meaningless in every account but one. Chatwoot's own inbox routing
  // already answers the question for all of them.
  handoffEnabled: boolean;
  // Cooldown on the customer copy and the operator note, never on the VERDICT: the ceiling is
  // evaluated on every message regardless. Without it, ten people writing in after the ceiling is
  // reached are answered with the same sentence ten times.
  noticeCooldownSeconds: number;
  // Emit a warning through the alert channels once a verdict lands at or past this fraction of a
  // ceiling, so the operator hears about it before the agent goes quiet rather than after. 0 = no
  // warning.
  //
  // "At or past", not "on the way past": the fraction is evaluated by the gate, on the ledger as it
  // stood BEFORE the turn, so a single turn that spends more than the band between the fraction and
  // the ceiling goes from allowed straight to over and the `over` line is the first one written.
  // Same bound as the overshoot, from the same read-then-act shape (docs/spend-ceiling.md); the band
  // is what buys the lead time, and lowering the fraction is what buys more of it.
  warnAtPercent: number;
}

// Off by default, and every other field carries the value an operator who switches it on would
// otherwise have to think about. The default MESSAGE is the field that matters most here: it is
// what a tenant that never opens this screen shows its customers.
export const SPEND_CEILING_DEFAULTS: SpendCeilingConfig = {
  enabled: false,
  monthlyInboxTokens: 0,
  monthlyPlaygroundTokens: 0,
  overCeilingMessage:
    "Não consigo responder agora. Já avisei a equipe, e alguém continua por aqui.",
  handoffEnabled: true,
  noticeCooldownSeconds: 300,
  warnAtPercent: 80,
};

// The ceiling an operator may type, and the longest a notice may stay quiet. Declared here rather
// than beside the schema below because BOTH sides read them now, for the reason `readCount` gives.
export const SPEND_CEILING_TOKENS_MAX = 1_000_000_000_000;
export const SPEND_CEILING_NOTICE_COOLDOWN_MAX_SECONDS = 3600;

// A token ceiling is a count, so anything that is not a non-negative whole number is not one. FALLS
// BACK rather than throws, like every other block in this bag: a malformed write must never be able
// to break the webhook.
//
// And it falls back to the DEFAULT, which for the two token fields is `0`, which is "no ceiling on
// this half". Said plainly because it is the direction the whole feature takes and it deserves to
// be read as a choice rather than found as a surprise: a `-1` that reached this column out of band
// leaves the block enabled and bounding nothing. The alternative is to invent a positive number,
// and a ceiling nobody typed is a ceiling that silences an agent for real customers on the strength
// of corrupted data — the same trade the unreadable-ledger path already makes in the same
// direction, one level up. It is not silent, either: the console renders exactly what this returns,
// so an operator looking at the ceiling screen sees the zero.
//
// AND IT CLAMPS TO THE MAXIMUM THE WRITER ENFORCES, so this reader can never return a block the
// writer would refuse. That is not the two sides collapsing into one question — one still answers
// "what is stored" and the other "may this be stored" — it is the round trip between them. A value
// past the maximum can only arrive out of band (an import, a hand-edited column), and
// `updateSpendCeiling` merges THIS output with the operator's patch before validating the merge, so
// passing it through would 422 every save on the screen over a field the operator never touched,
// with nothing rendered that they could fix. Each clamp runs toward the safe side of its own field:
// a notice that speaks more often, a ceiling that is lower.
//
// The sibling blocks in `tenant-settings/service.ts` hold the same invariant by a different trade:
// they run the strict schema itself, partial, and fall back to the DEFAULTS for the whole block when
// any field fails. This one reads field by field on purpose, so one bad number does not discard an
// operator's message and ceilings along with it, and per-field clamping is what that costs.
function readCount(v: unknown, fallback: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < 0) return fallback;
  return Math.min(Math.floor(v), max);
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
  return {
    enabled: s.enabled === true,
    monthlyInboxTokens: readCount(
      s.monthlyInboxTokens,
      SPEND_CEILING_DEFAULTS.monthlyInboxTokens,
      SPEND_CEILING_TOKENS_MAX,
    ),
    monthlyPlaygroundTokens: readCount(
      s.monthlyPlaygroundTokens,
      SPEND_CEILING_DEFAULTS.monthlyPlaygroundTokens,
      SPEND_CEILING_TOKENS_MAX,
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
  };
}

// The write side, which REFUSES rather than clamps. The reader above is deliberately lenient (a
// malformed bag must never break the webhook), and the two are not in tension: one answers "what is
// stored", the other answers "may this be stored". An operator who types a ceiling with an extra
// zero has to be told, not quietly given the number they did not mean.
export const spendCeilingSettingsSchema = z.object({
  enabled: z.boolean(),
  monthlyInboxTokens: z.number().int().min(0).max(SPEND_CEILING_TOKENS_MAX),
  monthlyPlaygroundTokens: z
    .number()
    .int()
    .min(0)
    .max(SPEND_CEILING_TOKENS_MAX),
  overCeilingMessage: z.string().max(TEMPLATE_MESSAGE_MAX).nullable(),
  handoffEnabled: z.boolean(),
  noticeCooldownSeconds: z
    .number()
    .int()
    .min(0)
    .max(SPEND_CEILING_NOTICE_COOLDOWN_MAX_SECONDS),
  warnAtPercent: z.number().int().min(0).max(100),
});
