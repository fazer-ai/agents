import { z } from "zod";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
// NOTE: The caps are IMPORTED, never retyped. They go in `.describe()` and never into the schema
// itself — the rule the file's header states is type and choice, never size, because these are
// refused by assertSettingsTextSizes on the write rather than clamped by the reader. A caller has to
// be able to build a valid call from tools/list without failing first (docs/mcp.md), and a number
// copied here would be a second copy that drifts.
import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
  TOOL_INSTRUCTIONS_MAX,
} from "@/modules/agents/text-caps";
import { REDIRECT_DELAY_UNITS } from "@/modules/channel-redirect/service";
import {
  FULL_DETAIL_MAX_HOURS,
  parseIsoInstant,
} from "@/modules/flowlog/settings";
import { FOLLOW_UP_DELAY_UNITS } from "@/modules/followups/settings";
import { GUARDRAIL_ACTIONS } from "@/modules/guardrails/settings";
import { HANDOFF_MODES } from "@/modules/handoff/settings";
import { STT_PROVIDER_NAMES } from "@/modules/stt/providers";
import { LANG_RE } from "@/modules/stt/settings";
import { TTS_PROVIDER_NAMES } from "@/modules/tts/providers";
import { TTS_MODES } from "@/modules/tts/settings-shared";
import { VISION_PROVIDER_NAMES } from "@/modules/vision/providers";

// The argument shape of the behavior blocks, as a schema instead of a paragraph.
//
// Every block used to be declared `z.record(z.string(), z.unknown())`, so a client was told "an
// object" and every field name, choice, unit and default had to live in the tool description. That
// is a place where a fact is easy to add and a stale one is impossible to find: `vision.provider`
// was written up as `(openai|gemini|anthropic)` while the registry had grown to five, and nothing
// could have caught it, because prose is not type-checked and the enum below is.
//
// WHAT GOES IN HERE, AND WHAT MUST NOT — the rule is type and choice, never size:
//
//   * A value the reader would THROW AWAY (wrong type, a provider that is not registered, a delay
//     unit that does not exist) is declared, so the call is refused with the field named instead of
//     succeeding and silently storing a default the caller never asked for.
//   * A value the reader HONORS after measuring it (a number outside its band is clamped, operator
//     text past its cap is refused only when the write CHANGES it, a list longer than its ceiling is
//     truncated) must still parse. Copying those bounds here would turn a clamp into a refusal and
//     break `agent_settings_set accepts a stored over-cap value it does not change`. They live in
//     the field's `.describe()`, which reaches a client as the property's `description`.
//
// Two pairs where that question separates fields the eye reads as identical:
//
//   * `handoff.targetAgentId` is `.int().positive()` and `limits.maxHistoryTokens` is a bare number.
//     `posInt` DISCARDS a 1.5 or a 0 — a pinned target silently cleared — while `readLimitsConfig`
//     treats 0 as the documented way to say OFF. Zero is a value only where the consumer says so.
//   * `stt.language` carries the reader's own pattern and `sendImage.allowedHosts` carries none.
//     `LANG_RE` only TESTS, so "portugues" is thrown away and comes back as "pt"; the host
//     normalizer TRANSFORMS what it accepts (a full URL, a port, a path all reduce to one host), so
//     a pattern here would refuse spellings the reader honors.
//
// The blocks are LOOSE objects on purpose. An undeclared key still reaches the readers exactly as
// before, so a field added to a reader by someone who never opened this file is merged rather than
// silently dropped on the way in — the readers stay the authority, and this schema only says what is
// already known about the shape.
//
// WHAT THIS SCHEMA ENFORCES IS WHAT IT PUBLISHES, and that is a second constraint, not the same one.
// `tools/list` ships the generated JSON Schema, so a client may validate a call before sending it;
// anything zod enforces that JSON Schema cannot express becomes a contract the two ends read
// differently. It has bitten twice here: a `/…/i` pattern loses its flag on the way out (so the
// published pattern refused the documented "pt-BR"), and a `z.preprocess` that trims before an enum
// is invisible out there (so a padded " openai " parsed on the server and would be refused by a
// client). The first was fixed by spelling the case classes out in the reader's own constant. The
// second cannot be fixed that way: encoding the whitespace means publishing a pattern INSTEAD of an
// enum, which trades away the one thing worth publishing — the list of options a client renders.
//
// So the schema is deliberately narrower than a reader in exactly two places, both for the same
// reason: `observability.logToolValues` / `memory.compaction.enabled` also honor the STRING
// spellings ("true"/"false"), and every `str()`-backed choice also honors surrounding whitespace.
// Both are normalizations of what is STORED — a bag written by an older build, a row edited by hand
// — and both stay true of everything already stored, because the readers are untouched. Neither was
// ever an input contract: no description offered them, and no console path can produce one (a
// provider comes from a dropdown). What narrows is only what a caller may newly SEND.

// A registry list as a set of choices. `Object.keys` of a provider map is `string[]`, which is the
// one shape `z.enum` cannot take; the registries are module-level literals and never empty.
function oneOf(names: readonly string[]) {
  return z.enum(names as [string, ...string[]]);
}

// Every credential field on every block: a vault entry NAME, or a `vault:<id>` ref when two entries
// share a name. Never a secret — the MCP boundary resolves it before anything is stored.
const credentialRef = () =>
  z
    .string()
    .nullable()
    .optional()
    .describe("vault entry NAME or vault:<id>; null clears it");

const baseURL = () =>
  z
    .string()
    .nullable()
    .optional()
    .describe("compatible / self-hosted endpoint; null = the provider's own");

const modelId = () =>
  z.string().optional().describe("empty = the provider's default");

// A Chatwoot-side id. `posInt`/`inboxRef` keep a positive integer and DISCARD everything else, so a
// 0 or a 1.5 stores as null: the pinned target the caller asked for, silently cleared. null stays,
// because that is how the field is cleared on purpose.
const chatwootId = () => z.number().int().positive().nullable().optional();

const debounce = z.looseObject({
  enabled: z.boolean().optional(),
  windowSeconds: z
    .number()
    .optional()
    .describe("3-120, clamped, after the LAST inbound message"),
  maxMessagesPerBurst: z.number().optional().describe("1-50, clamped"),
  maxWindowSeconds: z
    .number()
    .optional()
    .describe("up to 600, clamped, from the START of the burst"),
});

const stt = z.looseObject({
  enabled: z.boolean().optional(),
  provider: oneOf(STT_PROVIDER_NAMES).optional(),
  model: modelId(),
  language: z
    .string()
    .regex(LANG_RE)
    .optional()
    .describe('ISO-639-1, e.g. "pt" or "pt-BR"'),
  credentialRef: credentialRef(),
  baseURL: baseURL(),
});

const tts = z.looseObject({
  mode: oneOf(TTS_MODES)
    .optional()
    .describe("mirror = audio when the customer sent audio"),
  provider: oneOf(TTS_PROVIDER_NAMES).optional(),
  model: modelId(),
  voice: z
    .string()
    .optional()
    .describe("empty = the default; ElevenLabs requires one"),
  credentialRef: credentialRef(),
  baseURL: baseURL(),
  normalize: z
    .boolean()
    .optional()
    .describe("rewrite the reply for natural speech first"),
  // The rewrite runs on a CHAT model, so this is a model provider and not one of the synthesis
  // providers above. An unregistered name is not refused anywhere downstream: resolveNormalizeModel
  // returns `provider_unknown` at READ time and the rewrite silently never runs.
  normalizeProvider: oneOf(MODEL_PROVIDERS)
    .nullable()
    .optional()
    .describe("the rewrite's model PROVIDER; null inherits the agent's"),
  normalizeModel: z.string().nullable().optional(),
  normalizeCredentialRef: credentialRef(),
  normalizeBaseURL: baseURL(),
  stability: z
    .number()
    .nullable()
    .optional()
    .describe("0-1, clamped; null = the voice's own"),
  similarityBoost: z.number().nullable().optional().describe("0-1, clamped"),
  style: z.number().nullable().optional().describe("0-1, clamped"),
  speed: z.number().nullable().optional().describe("0.25-4, clamped"),
  speakerBoost: z.boolean().nullable().optional(),
});

const vision = z.looseObject({
  enabled: z.boolean().optional(),
  provider: oneOf(VISION_PROVIDER_NAMES).optional(),
  model: modelId(),
  credentialRef: credentialRef(),
  baseURL: baseURL(),
  extractionPrompt: z
    .string()
    .optional()
    .describe("what the vision model is asked to extract"),
});

const split = z.looseObject({
  enabled: z.boolean().optional(),
  maxChars: z.number().optional().describe("balloon size, 80-4000, clamped"),
  typingWpm: z.number().optional().describe("40-1000, clamped"),
  minDelayMs: z.number().optional().describe("0-10000, clamped"),
  maxDelayMs: z.number().optional().describe("0-30000, clamped"),
  maxChunks: z.number().optional().describe("1-12, clamped"),
});

const serviceWindow = z.looseObject({
  enabled: z.boolean().optional(),
  windowHours: z.number().optional().describe("1-168, clamped"),
  templateName: z
    .string()
    .nullable()
    .optional()
    .describe("approved HSM outside the window; null = a private note"),
  templateLanguage: z.string().optional().describe('e.g. "pt_BR"'),
  templateCategory: z.string().optional().describe('e.g. "UTILITY"'),
  templateParams: z
    .array(z.string())
    .optional()
    .describe("positional body params; {contact_name} interpolates"),
  templateContent: z
    .string()
    .nullable()
    .optional()
    .describe("dashboard-facing only; the send uses the params"),
});

const grounding = z.looseObject({
  maxDistance: z
    .number()
    .positive()
    .nullable()
    .optional()
    .describe("cosine ceiling for a knowledge hit; null = no filter"),
});

// BLANK IS WHAT THE READER THROWS AWAY, so the schema is where it gets declared. `readToolInstructions`
// trims and returns null for an empty result, so a note of `""` or `"   "` is accepted by the write,
// replaces whatever note was there, and then never reaches a tool description — the one outcome
// docs/mcp.md says a caller cannot discover by trying, because what comes back is success.
//
// A PATTERN rather than a length: `minLength` would not catch `"   "`, and this is not the size rule
// the contract forbids copying into zod ("type and choice, never size"). It refuses a KIND of value,
// it is published faithfully (`\S` carries no flag to lose, unlike the /…/i case in docs/mcp.md), and
// it diverges from no console path — all three fields are written by the editor as `.trim() || null`,
// or with the key deleted (toolGuidance), so the console never produces the value this refuses.
//
// `followUps[].instructions` is deliberately NOT here: its stored default is `""` (see
// modules/followups/settings.ts), the reader keeps it, and refusing it would break the round trip
// this surface documents.
const nonBlank = (message: string) => z.string().regex(/\S/, message);

const toolNote = () => nonBlank("must not be blank; use null to clear it");

const followUpStep = z.looseObject({
  delayValue: z.number().optional().describe("≥ 1, clamped"),
  delayUnit: oneOf(FOLLOW_UP_DELAY_UNITS).optional(),
  instructions: z
    .string()
    .optional()
    .describe("what THIS step's nudge should say"),
  assignLabels: z
    .array(z.string())
    .optional()
    .describe("merged into the conversation's labels, never replacing"),
  resolve: z.boolean().optional().describe("honored on the LAST step only"),
  ignoreAppointmentPause: z
    .boolean()
    .optional()
    .describe(
      "let THIS step fire while a booking stands; no-op unless followUp.pauseWhileAppointment is on",
    ),
});

const followUp = z.looseObject({
  enabled: z.boolean().optional(),
  pauseWhileAppointment: z
    .boolean()
    .optional()
    .describe("hold while a reminder is scheduled; default true"),
  steps: z
    .array(followUpStep)
    .optional()
    .describe("replaced as a unit, not merged; first 10 kept"),
});

const handoff = z.looseObject({
  mode: oneOf(HANDOFF_MODES)
    .optional()
    .describe(
      "route = Chatwoot's own assignment; agent_choice = the model names a target",
    ),
  targetAgentId: chatwootId().describe(
    "Chatwoot agent id, for pinned; wins over the team",
  ),
  targetTeamId: chatwootId().describe("Chatwoot team id"),
  targetInstanceId: chatwootId().describe(
    "the ChatwootInstance the pinned target came from",
  ),
  instructions: toolNote()
    .nullable()
    .optional()
    .describe(
      "appended to the handoff_to_human tool description; null clears it",
    ),
});

const limits = z.looseObject({
  maxToolCalls: z
    .number()
    .optional()
    .describe("tool executions in ONE turn; 1-50, clamped"),
  maxHistoryTokens: z
    .number()
    .nullable()
    .optional()
    .describe("2000-1000000, clamped; null/0/absent = OFF"),
});

const availability = z.looseObject({
  enabled: z.boolean().optional(),
  awayMessage: z
    .string()
    .optional()
    .describe(
      "what the CUSTOMER gets outside the schedule, once per local day; {proximo_atendimento}/{next_open} interpolate the next opening",
    ),
});

const contactAuth = z.looseObject({
  enabled: z.boolean().optional(),
  url: z
    .string()
    .nullable()
    .optional()
    .describe("the authorization endpoint; fixed origin, no placeholders"),
  credentialRef: credentialRef(),
  timeoutMs: z.number().optional().describe("1000-10000, clamped"),
  noticeCooldownSeconds: z
    .number()
    .optional()
    .describe(
      "cooldown on the refusal NOTICES, never on the verdict; 0 = notify on every refusal",
    ),
  includeMessageText: z
    .boolean()
    .optional()
    .describe(
      "forward the message text under `message.text` so the endpoint can accept an unlock code",
    ),
  denyMessage: z
    .string()
    .nullable()
    .optional()
    .describe("what a REFUSED contact receives; null = say nothing"),
  handoffEnabled: z.boolean().optional(),
  mode: z
    .enum(["perMessage", "once"])
    .optional()
    .describe(
      "perMessage (default) re-checks every message; once stores the first positive verdict per contact and reuses it until it expires",
    ),
  grantTtlSeconds: z
    .number()
    .optional()
    .describe(
      "how long a stored verdict counts for under mode=once; 60-2592000, clamped. Part of the policy a verdict is stored under, so a stored verdict stops counting while a different value is in force",
    ),
  handoffTeamId: chatwootId().describe("Chatwoot team id"),
  handoffTeamInstanceId: chatwootId().describe(
    "our ChatwootInstance id the team was picked from; the team is only assigned in that account",
  ),
});

const channelRedirect = z.looseObject({
  enabled: z.boolean().optional(),
  entryInboxId: chatwootId().describe(
    "the WhatsApp chatwootInboxId leads arrive on",
  ),
  widgetInboxId: chatwootId().describe(
    "the widget chatwootInboxId; set via the console",
  ),
  redirectMessage: z.string().optional().describe("must carry {link}"),
  resendDelayValue: z.number().optional().describe("≥ 1, clamped"),
  resendDelayUnit: oneOf(REDIRECT_DELAY_UNITS).optional(),
  maxResends: z.number().optional().describe("0-10, clamped"),
  openWidget: z.boolean().optional(),
  cloneWaMessage: z
    .boolean()
    .optional()
    .describe("replay it as the first widget message"),
  chatFollowupEnabled: z.boolean().optional(),
  chatFollowupDelayValue: z.number().optional().describe("≥ 1, clamped"),
  chatFollowupDelayUnit: oneOf(REDIRECT_DELAY_UNITS).optional(),
  chatFollowupInstructions: z.string().optional(),
  waFollowupEnabled: z.boolean().optional(),
  waFollowupDelayValue: z.number().optional().describe("≥ 1, clamped"),
  waFollowupDelayUnit: oneOf(REDIRECT_DELAY_UNITS).optional(),
  waFollowupMessage: z.string().optional().describe("must carry {link}"),
  closingEnabled: z.boolean().optional(),
  closingDelayValue: z.number().optional().describe("≥ 1, clamped"),
  closingDelayUnit: oneOf(REDIRECT_DELAY_UNITS).optional(),
  closingMessage: z
    .string()
    .optional()
    .describe("fixed, posted on BOTH channels"),
});

// The Chatwoot attribute KEYS injected into the prompt, per scope. The keys themselves are the
// tenant's own, so they stay free strings; what is fixed is the three scopes.
const attributeKeys = () =>
  z.array(z.string()).optional().describe("first 20 kept; empty disables");

const attributeContext = z.looseObject({
  conversation: attributeKeys(),
  contact: attributeKeys(),
  task: attributeKeys(),
});

const sendImage = z.looseObject({
  allowedHosts: z
    .array(z.string())
    .optional()
    .describe(
      'one hostname per entry ("*." covers a domain and its subdomains); empty refuses every send_image call',
    ),
});

const observability = z.looseObject({
  logToolValues: z
    .boolean()
    .optional()
    .describe("tool arguments as VALUES instead of shapes"),
  // NOTE: `z.string()`, not `z.iso.datetime()`. The typed form publishes a 430-character regex into
  // every listing of this tool, which is a third of a block's whole budget spent restating a format
  // the description states in four words. The check is the same either way — it runs in the refine
  // below, which publishes nothing — and what a caller loses is the machine-readable `format`, not
  // the constraint.
  fullDetailUntil: z
    .string()
    .nullable()
    .optional()
    .refine((v) => {
      if (v == null) return true;
      // Through the READER's own parser, so a caller is refused by the same rule the runtime will
      // apply — an offset-bearing ISO instant, never `Date.parse`'s wider vocabulary. Refusing here
      // is the courtesy half: the reader refuses it either way, but silently, as the mode simply
      // never arming.
      const t = parseIsoInstant(v);
      return (
        t !== null &&
        t.getTime() <= Date.now() + FULL_DETAIL_MAX_HOURS * 3_600_000
      );
    }, `an ISO instant with an offset, at most ${FULL_DETAIL_MAX_HOURS}h ahead`)
    .describe(
      `ISO instant the log debug mode ends, at most ${FULL_DETAIL_MAX_HOURS}h ahead; until then this agent's log detail is stored whole instead of cut at 2000 chars`,
    ),
});

const memory = z.looseObject({
  compaction: z
    .looseObject({
      enabled: z
        .boolean()
        .optional()
        .describe("summarize a closed attendance; default TRUE"),
      // The summariser's OWN model, and dead in exactly the way tts's rewrite is: resolveModelOverride
      // decides at READ time, so a half-named override is stored without complaint and the attendance
      // is simply never summarised. All four absent (the default) runs it on the agent's model.
      provider: oneOf(MODEL_PROVIDERS)
        .nullable()
        .optional()
        .describe("the summary's model PROVIDER; null inherits the agent's"),
      model: z.string().nullable().optional(),
      credentialRef: credentialRef(),
      baseURL: baseURL(),
    })
    .optional(),
});

const modelFallback = z.looseObject({
  // WHERE THE TURN GOES when the agent's own provider cannot take it. Resolved by the same
  // `resolveModelOverride` the speech rewrite and the summariser use, so the rules about whose key
  // may travel to which host are written once — a fallback on another vendor carries its own
  // credential or it does not run.
  //
  // The one place this block reads DIFFERENTLY from its two siblings: there, everything absent means
  // "run on the agent's own model", which is a useful default. Here that would be a fallback to the
  // provider that just failed — configured-looking and a guaranteed no-op. So a fallback exists only
  // when the operator named BOTH a provider and a model, and anything less is no fallback at all.
  provider: oneOf(MODEL_PROVIDERS)
    .nullable()
    .optional()
    .describe("the fallback's model PROVIDER; absent = no fallback"),
  model: z
    .string()
    .nullable()
    .optional()
    .describe("the fallback's model id; absent = no fallback"),
  credentialRef: credentialRef(),
  baseURL: baseURL(),
});

// The 18 behavior blocks of `agent_settings_set`, each a partial patch over the stored block.
// --- Blocks added by issue #402 ---------------------------------------------------------------
//
// Five blocks of the settings bag were written by the console and REST and reachable through MCP
// not at all. Four were never registered anywhere; `guardrails` was the one deliberate omission, and
// the reason was never written down. The guard that discovers this now
// (tests/modules/agent-settings-mcp-parity.test.ts) probes the readers rather than reading a list,
// so what follows only has to keep its promise: type and choice, never size.

// NOTE: THE TWO DIRECTIONS PUBLISH DIFFERENT FIELDS, because two of the checks only mean something about
// a REPLY. `activeChecks` drops `promptAdherence` and `answerRelevance` whenever the direction is
// `input`, and the generated-reply guidance is only read for `output` (prompts.ts). Publishing them
// under `input` advertised three settings that store, read back through agent_settings_get, and do
// nothing — configuration that reports success, which is the same failure `appointmentReminders` was
// removed from this change for. The console has always gated them behind `dir === "output"`.
const sharedChecks = {
  toxicity: z.boolean().optional(),
  unsafeContent: z.boolean().optional(),
  competitorMentions: z
    .boolean()
    .optional()
    .describe("matches the names in guardrails.competitors"),
};

// The two reply checks are REFUSED under `input`, not merely left unpublished. Splitting the
// published shape was round 4; round 5 showed it was half a fix, because a loose object still
// ACCEPTS them — and the shape `agent_settings_get` returns carries all five, so a caller doing the
// most ordinary thing (read, change one field, write back) would have sent them and had them stored
// as a silent no-op. The refusal names the field.
//
// Refused HERE and dropped from the read projection (modules/mcp/write.ts) together, because only
// one of the two would trade a silent no-op for a broken round trip: a `get` that returns a field
// the `set` refuses is a 400 for a caller who changed nothing.
//
// Still LOOSE otherwise, for the reason the header gives: an undeclared key reaches the readers as
// before, so a field someone adds to the reader is merged rather than silently dropped. What is
// refused is the specific, known, direction-wrong set.
// PUBLISHED as a prohibition, not merely enforced. `docs/mcp.md` states the constraint this failed
// on the first attempt: what the schema ENFORCES has to be what it PUBLISHES, because tools/list
// ships the generated JSON Schema and a client may validate a call before sending it. A zod
// `.check()` is invisible out there, so the client accepted what the server refused — the same shape
// of mismatch the doc already records twice (a regex flag lost on the way out, a preprocess trim).
// `z.never().optional()` serializes as `{"not": {}}`: both ends read the same rule.
const inputChecks = z.looseObject({
  ...sharedChecks,
  // NOTE: These two only mean something about a REPLY — activeChecks drops them whenever the direction
  // is `input` — so accepting them here would store configuration the runtime never acts on. That is
  // the one outcome a caller cannot discover by trying, because what comes back is success.
  promptAdherence: z.never().optional(),
  answerRelevance: z.never().optional(),
});

const outputChecks = z.looseObject({
  ...sharedChecks,
  promptAdherence: z.boolean().optional(),
  answerRelevance: z
    .boolean()
    .optional()
    .describe(
      "OFF by default on purpose: it is the one check that can replace a CORRECT reply",
    ),
});

const ACTION_DESC =
  "on a violation: template = send templateMessage verbatim; generated = guardrails writes a safe reply; silent = send nothing";

const directionCommon = {
  enabled: z.boolean().optional(),
  templateMessage: z
    .string()
    .optional()
    .describe(`refused above ${TEMPLATE_MESSAGE_MAX} characters, not trimmed`),
};

const guardrailInput = z.looseObject({
  ...directionCommon,
  // NOTE: All three actions are accepted here, as the console offers them — refusing `generated` would
  // make the same write succeed in the console and fail through MCP. What it DOES is different, and
  // that belongs in the description: the input direction never delivers a replacement
  // (`analyzeGuardrail` runs every input verdict through `withoutReplacement`, because there is no
  // assistant reply to repair), so `generated` falls back to the template message. A caller cannot
  // find that out by trying, since the write succeeds.
  action: oneOf(GUARDRAIL_ACTIONS)
    .optional()
    .describe(
      `${ACTION_DESC}. NOTE for this direction: there is no reply to rewrite, so 'generated' always falls back to templateMessage`,
    ),
  checks: inputChecks.optional(),
  // NOTE: Input analysis never generates a replacement reply (prompts.ts reads this only for `output`).
  generationPrompt: z.never().optional(),
});

const guardrailOutput = z.looseObject({
  ...directionCommon,
  action: oneOf(GUARDRAIL_ACTIONS).optional().describe(ACTION_DESC),
  checks: outputChecks.optional(),
  generationPrompt: z
    .string()
    .optional()
    .describe(
      `steers HOW a generated reply is written; empty = generic. Refused above ${GENERATION_PROMPT_MAX} characters, not trimmed`,
    ),
});

const guardrails = z.looseObject({
  enabled: z.boolean().optional(),
  provider: oneOf(MODEL_PROVIDERS)
    .optional()
    .describe("the guardrails agent's OWN model provider, not the agent's"),
  model: z
    .string()
    .optional()
    .describe(
      "empty resolves to the provider default (openai-compatible keeps empty: the server picks)",
    ),
  credentialRef: z
    .string()
    .nullable()
    .optional()
    .describe("vault entry NAME (never the key itself)"),
  baseURL: z.string().nullable().optional(),
  // NOTE: Item type declared, count and length not: readCompetitors DROPS a non-string (so declaring it
  // turns a silent loss into a named refusal) but truncates the list and each name, which must keep
  // parsing.
  competitors: z.array(z.string()).optional(),
  customPolicy: z
    .string()
    .optional()
    .describe(
      `free text appended to every analysis prompt; refused above ${CUSTOM_POLICY_MAX} characters, not trimmed`,
    ),
  input: guardrailInput.optional().describe("screens the CUSTOMER message"),
  output: guardrailOutput
    .optional()
    .describe("screens the AGENT reply before it is sent"),
});

const kanban = z.looseObject({
  instructions: toolNote()
    .nullable()
    .optional()
    .describe(
      `funnel guidance appended to the kanban_move_card tool description; null clears it. The board itself follows the conversation's linked card. Refused above ${TOOL_INSTRUCTIONS_MAX} characters, not trimmed`,
    ),
});

// NOTE: Keyed BY THE CATALOG, and NOT by an open string-keyed record. Both of these are maps whose keys are
// native tool names, and both readers DROP a key outside the catalog — so a record schema would
// publish "any string" and let a typo be accepted by the API and ignored by the turn, which for a
// precondition means an unguarded tool that reads as guarded. Generated from NATIVE_TOOL_NAMES so a
// tool added later is publishable the day it ships instead of the day someone remembers this file.
// NOTE: `__proto__` is refused BEFORE the object parser can lose it. It is the one key name that
// survives JSON.parse as an own property and then disappears inside zod's loose-object rebuild, so
// the entry reaches neither the write boundary nor the merge and the call answers ok having done
// nothing — a tombstone the caller believes deleted an enforced rule, or a rule the catalog refusal
// never sees. Checked on the RAW value, which is the only place it still exists.
//
// The runtime half of this hazard is already closed (#378 keys these maps on null-prototype objects
// and looks up with Object.hasOwn); this is the same name at the transport boundary, where the loss
// runs the other way.
const refuseProtoKey = <T extends z.ZodObject>(schema: T) =>
  schema.check((ctx) => {
    const raw = ctx.value as Record<string, unknown> | null;
    if (raw && Object.hasOwn(raw, "__proto__")) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: [],
        message:
          "__proto__ is not a usable tool name: it cannot survive parsing, so the entry would be silently dropped",
      });
    }
  });

const nativeToolKeys = <T extends z.ZodTypeAny>(value: T) => {
  // ONE instance shared by all thirteen keys, not thirteen `.optional()` calls. This is about the
  // PUBLISHED schema, not about the parse: distinct instances serialize as thirteen full copies of
  // the value, which for the precondition object alone came to 5.2 KB — 23% of the whole tool's
  // schema, for one block, in a catalogue the model pays for on every conversation.
  const shared = value.optional();
  return refuseProtoKey(
    z.looseObject(
      Object.fromEntries(NATIVE_TOOL_NAMES.map((n) => [n, shared])) as Record<
        (typeof NATIVE_TOOL_NAMES)[number],
        z.ZodOptional<T>
      >,
    ),
  );
};

const toolGuidance = nativeToolKeys(toolNote().nullable()).describe(
  `per-native-tool guidance appended to that tool's description; null clears one. A key outside the catalog is dropped by the reader, so only the names published here take effect. Each note is refused above ${TOOL_INSTRUCTIONS_MAX} characters, not trimmed. PRECEDENCE: handoff_to_human and kanban_move_card also have a note in their own block (handoff.instructions, kanban.instructions); a non-empty value THERE wins over this map for that tool, so the value here applies only while the grouped one is empty.`,
);

// NOTE: The field descriptions live on the BLOCK, once, rather than on each field — the value is
// serialized once per key, so a per-field `.describe()` is published thirteen times. That alone was
// worth ~2 KB of a schema the model pays for on every conversation, and thirteen copies of the same
// sentence is noise to the reader as much as it is bytes on the wire.
const toolPreconditions = nativeToolKeys(
  z
    .looseObject({
      kind: z.literal("attribute"),
      scope: z.enum(["conversation", "contact"]),
      // BLANK IS REFUSED BY THE SERVER HERE, so it is published rather than left to the caller to
      // discover. `parseToolPrecondition` trims both and returns null for either — and the write
      // boundary REFUSES what does not parse instead of dropping it, so a schema-valid call came
      // back as an MCP error with nothing in tools/list to predict it.
      //
      // The line that decides which refusals belong in the schema is whether JSON Schema can carry
      // them faithfully. A pattern can. `modelFallback`'s half-named pair cannot — that is a
      // requirement BETWEEN fields, and docs/mcp.md puts those in the description, which is where
      // it already is.
      key: nonBlank("must not be blank"),
      // NOTE: blank is refused rather than treated as absent, and the reader says why: dropping it
      // would turn "the attribute must equal X" into "the attribute must exist", a weaker rule than
      // the operator wrote, and weaker in silence.
      equals: nonBlank(
        "must not be blank; omit it to require only that the attribute is set",
      ).optional(),
    })
    // NOTE: NULLABLE, and it is the only way to REMOVE a rule over this surface. The merge treats each
    // tool's value as a replacement and an absent key as "leave it alone", so without a tombstone
    // there is no deletion at all — an empty object just replaces the rule with an unparseable one.
    // `toolGuidance` accepted one from the start because its value was already nullable, which is
    // exactly why the gap here survived a round: the test written for the tombstone covered the half
    // that already worked.
    .nullable(),
).describe(
  "per-native-tool precondition, checked by the runtime BEFORE the call runs (send `null` for a tool to remove its rule): `key` is the custom-attribute key that must be set on the chosen `scope`, and `equals` is the required value (omit it to require any non-blank value). Unmet, the tool does not run and the model is told why. Only native tools can be guarded (issue #389 tracks the rest).",
);

export const BEHAVIOR_PATCH_SHAPE = {
  debounce: debounce.optional(),
  stt: stt.optional(),
  tts: tts.optional(),
  vision: vision.optional(),
  split: split.optional(),
  serviceWindow: serviceWindow.optional(),
  grounding: grounding.optional(),
  followUp: followUp.optional(),
  handoff: handoff.optional(),
  limits: limits.optional(),
  availability: availability.optional(),
  contactAuth: contactAuth.optional(),
  channelRedirect: channelRedirect.optional(),
  attributeContext: attributeContext.optional(),
  sendImage: sendImage.optional(),
  observability: observability.optional(),
  memory: memory.optional(),
  modelFallback: modelFallback.optional(),
  guardrails: guardrails.optional(),
  kanban: kanban.optional(),
  toolGuidance: toolGuidance.optional(),
  toolPreconditions: toolPreconditions.optional(),
} satisfies z.ZodRawShape;

export type BehaviorPatchArgs = z.infer<
  z.ZodObject<typeof BEHAVIOR_PATCH_SHAPE>
>;
