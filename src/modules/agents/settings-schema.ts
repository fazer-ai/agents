import { z } from "zod";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
// NOTE: The caps are IMPORTED, never retyped. They go in `.describe()` and never into the schema
// itself — the rule the file's header states is type and choice, never size, because these are
// refused by assertSettingsTextSizes on the write rather than clamped by the reader. A caller has to
// be able to build a valid call from tools/list without failing first (docs/mcp.md), and a number
// copied here would be a second copy that drifts.
import { RESOLVE_LABELS_MAX } from "@/modules/agents/resolve-labels";
import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
  TOOL_INSTRUCTIONS_MAX,
} from "@/modules/agents/text-caps";
import {
  ALLOWED_LABELS_MAX,
  PROTECTED_LABELS_MAX,
} from "@/modules/agents/tool-guidance";
import { REDIRECT_DELAY_UNITS } from "@/modules/channel-redirect/service";
import { CONTACT_FIELDS } from "@/modules/chatwoot/contact-fields";
import { CROSS_INBOX_CASE_ATTRIBUTE_KEY_RE } from "@/modules/cross-inbox-case/settings";
import {
  FULL_DETAIL_MAX_HOURS,
  parseIsoInstant,
} from "@/modules/flowlog/settings";
import { FOLLOW_UP_DELAY_UNITS } from "@/modules/followups/settings";
import { GUARDRAIL_ACTIONS } from "@/modules/guardrails/settings";
import { HANDOFF_MODES } from "@/modules/handoff/settings";
import {
  SIGNATURE_FREQUENCIES,
  SIGNATURE_POSITIONS,
  SIGNATURE_SEPARATORS,
} from "@/modules/signature/domains";
import { STT_PROVIDER_NAMES } from "@/modules/stt/providers";
import { LANG_RE } from "@/modules/stt/settings";
import { TTS_PROVIDER_NAMES } from "@/modules/tts/providers";
import { TTS_CHECK_MODES, TTS_MODES } from "@/modules/tts/settings-shared";
import { VISION_PROVIDER_NAMES } from "@/modules/vision/providers";

// The argument shape of the behavior blocks. Two rules, both in docs/mcp.md: type and choice, never
// size (declare what a reader throws away, never a bound it clamps), and what the schema enforces is
// what it publishes in `tools/list`. Blocks are LOOSE so a key added to a reader still reaches it.

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

// Blank is what the reader throws away (it trims to null), so it is refused here rather than stored
// as a silent no-op. A pattern, since `minLength` misses `"   "`. Not used for
// `followUps[].instructions`, whose stored default is `""`.
const nonBlank = (message: string) => z.string().regex(/\S/, message);

const toolNote = () => nonBlank("must not be blank; use null to clear it");

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
  checkMode: oneOf(TTS_CHECK_MODES)
    .nullable()
    .optional()
    .describe("null = the instance default"),
  // With `textInstead` on, a reply past one of these goes as TEXT instead of a voice
  // note. Absent = the default, null = that criterion off; the reader clamps, so a number outside the
  // band is read at its end.
  textInstead: z
    .boolean()
    .optional()
    .describe("send a reply past a textOver* limit as text; default false"),
  textOverChars: z
    .number()
    .nullable()
    .optional()
    .describe("text above this many chars (80-4000, default 450); null = off"),
  textOverListItems: z
    .number()
    .nullable()
    .optional()
    .describe("text from this many list items (2-50, default 3); null = off"),
  textOverNumbers: z
    .number()
    .nullable()
    .optional()
    .describe(
      "text from this many prices or 4+ digit numbers (2-50, default 3); null = off",
    ),
  // What the model is told about a spoken reply. Both switches default to false.
  spokenNotice: z
    .boolean()
    .optional()
    .describe("tell the model when its reply will be spoken; default false"),
  spokenNoticeText: toolNote()
    .nullable()
    .optional()
    .describe("null = the default notice"),
  textChoice: z
    .boolean()
    .optional()
    .describe("offer the reply_as_text tool; default false"),
  textChoiceNote: toolNote()
    .nullable()
    .optional()
    .describe("note appended to reply_as_text"),
});

const vision = z.looseObject({
  enabled: z.boolean().optional(),
  provider: oneOf(VISION_PROVIDER_NAMES).optional(),
  model: modelId(),
  credentialRef: credentialRef(),
  baseURL: baseURL(),
  // Nullable because the reader honours null as "the default prompt" and the console sends exactly that
  // on every Behavior save; a value the reader honours must parse.
  extractionPrompt: z
    .string()
    .nullable()
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

const signature = z.looseObject({
  enabled: z
    .boolean()
    .optional()
    .describe("off by default; off keeps the text"),
  text: z.string().optional().describe("the operator's closing line"),
  position: z.enum(SIGNATURE_POSITIONS).optional().describe("default top"),
  frequency: z
    .enum(SIGNATURE_FREQUENCIES)
    .optional()
    .describe("which messages of a split reply; default from position"),
  separator: z
    .enum(SIGNATURE_SEPARATORS)
    .optional()
    .describe("blank = 2 newlines; -- adds a -- line. Chatwoot's own bytes"),
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

const takeover = z.looseObject({
  onHumanReply: z
    .boolean()
    .optional()
    .describe(
      "a person answering the customer (composer or paired phone) ends the agent's attendance; default TRUE",
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
  retrySilence: z
    .boolean()
    .optional()
    .describe("retry a silent reply turn once; default TRUE"),
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

// The local rule. Either this or `url`: with a rule, the endpoint is never called.
const contactAuthRule = z
  .union([
    z.object({
      kind: z.literal("allowlist"),
      phones: z.array(z.string()).optional(),
      identifiers: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.literal("attribute"),
      scope: z.enum(["conversation", "contact"]),
      key: nonBlank("must not be blank"),
      equals: nonBlank("must not be blank").optional(),
    }),
  ])
  .nullable()
  .optional()
  .describe(
    "decides instead of `url`: allowlist = phone (with country code) or identifier listed, 1-500 entries; attribute = set, or equal to `equals`. null clears",
  );

const contactAuth = z.looseObject({
  enabled: z.boolean().optional(),
  rule: contactAuthRule,
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

// The contact's standard Chatwoot fields: a closed set, so an unknown name is refused rather than
// stored and dropped by the reader.
const contactFields = z.looseObject({
  context: z.array(oneOf(CONTACT_FIELDS)).optional(),
  writable: z
    .array(oneOf(CONTACT_FIELDS))
    .optional()
    .describe("⊆ context, else ignored; empty = no update_contact"),
});

const crossInboxCase = z.looseObject({
  targetInboxId: chatwootId().describe(
    "chatwootInboxId the case opens in; unset = tool not offered",
  ),
  targetInstanceId: chatwootId().describe("our instance id of that inbox"),
  originLabel: z.string().nullable().optional(),
  caseLabels: z.array(z.string()).optional().describe("first 20 kept"),
  subjectTemplate: z
    .string()
    .nullable()
    .optional()
    .describe("email subject; {{resumo}} = model's summary"),
  openingTemplate: z
    .string()
    .nullable()
    .optional()
    .describe("{{mensagem}} = model's part"),
  noteTemplate: z
    .string()
    .nullable()
    .optional()
    .describe("{{assunto}} {{motivo}} {{link_origem}}"),
  // Checked with `refine`, not `regex`: a pattern would enter the published JSON Schema and its
  // ceiling, and the refusal message already names the rule to whoever sends a bad key.
  caseAttributeKey: z
    .string()
    .trim()
    .refine(
      (k) => k === "" || CROSS_INBOX_CASE_ATTRIBUTE_KEY_RE.test(k),
      "caseAttributeKey must be lowercase snake_case (a-z, 0-9, _), starting with a letter, up to 64 characters",
    )
    .optional()
    .describe("default case_conversation_id"),
  mergeContacts: z
    .boolean()
    .optional()
    .describe("merge into the contact holding the typed email; default false"),
  resolveOrigin: z
    .boolean()
    .optional()
    .describe("close the origin after the reply once the case is open"),
});

// The labels the agent's own close writes, merged into the conversation's set right
// before resolve_conversation changes the status, so anything keyed on them at resolve time (a CSAT
// survey rule, a folder) sees them whether or not the model called set_labels.
const resolveConversation = z
  .looseObject({
    assignLabels: z
      .array(z.string())
      .optional()
      .describe(
        `merged in before the close; one in setLabels.protected is refused. First ${RESOLVE_LABELS_MAX} kept`,
      ),
  })
  .describe("labels resolve_conversation writes itself");

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
  historyDates: z
    .looseObject({
      enabled: z
        .boolean()
        .optional()
        .describe(
          "date each sent message in the model's history; default TRUE",
        ),
    })
    .optional(),
});

const modelFallback = z.looseObject({
  // Where the turn goes when the agent's own provider cannot take it (`resolveModelOverride`). Unlike
  // its siblings, absent does NOT mean the agent's model (that is the provider that just failed): a
  // fallback exists only when BOTH a provider and a model are named.
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
// tests/modules/agent-settings-mcp-parity.test.ts probes the readers so no block is left out.

// The two directions publish different fields: `promptAdherence` and `answerRelevance` only mean
// something about a REPLY (`activeChecks` drops them for `input`), as in the console.
const sharedChecks = {
  toxicity: z.boolean().optional(),
  unsafeContent: z.boolean().optional(),
  competitorMentions: z
    .boolean()
    .optional()
    .describe("matches the names in guardrails.competitors"),
};

// The reply checks are REFUSED under `input` (a loose object would accept them as a silent no-op),
// and dropped from the read projection in modules/mcp/write.ts so a read-then-write round trip holds.
// `z.never().optional()` publishes as `{"not": {}}`, where a zod `.check()` would be invisible.
const inputChecks = z.looseObject({
  ...sharedChecks,
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
  "on a violation: template = send templateMessage verbatim; generated = guardrails writes a safe reply; silent = send nothing; handoff = send handoffMessage and give the conversation to the team";

const directionCommon = {
  enabled: z.boolean().optional(),
  templateMessage: z
    .string()
    .optional()
    .describe(`refused above ${TEMPLATE_MESSAGE_MAX} characters, not trimmed`),
  handoffMessage: z
    .string()
    .optional()
    .describe(
      `sent on handoff; empty = hand over without writing. Refused above ${TEMPLATE_MESSAGE_MAX} characters, not trimmed`,
    ),
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

// `__proto__` is refused on the RAW value, before zod's loose-object rebuild silently drops it and the
// call answers ok having done nothing (a removal that removed nothing, a rule never checked).
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

// A map keyed BY THE NATIVE CATALOG, not an open record: both readers drop any other key, so "any
// string" would accept a typo the turn then ignores (for a precondition, an unguarded tool).
const nativeToolKeys = <T extends z.ZodTypeAny>(value: T) => {
  // ONE shared instance: distinct ones serialize as a full copy per key in the published
  // schema, which the model pays for on every conversation.
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

// The `set_labels` guard: a block of its own, since it fences a tool (`settings.labels` is refused on
// write). Loose like its siblings.
const setLabels = z
  .looseObject({
    protected: z
      .array(z.string())
      .describe(
        `labels set_labels may neither add nor remove — for the ones another system owns (a switch that keeps an agent off a conversation, a testing marker). The agent SEES them and is told so. Blank, duplicate and non-string entries are dropped by the reader, and the list is capped at ${PROTECTED_LABELS_MAX}. An empty array clears the guard.`,
      )
      .optional(),
    allowed: z
      .array(z.string())
      .describe(
        `the only titles set_labels may ADD; empty = any, and a new one is created. Removal is not limited. At most ${ALLOWED_LABELS_MAX}`,
      )
      .optional(),
    outsideAllowed: z
      .enum(["refuse", "accept"])
      .describe(
        "a title outside `allowed`: refuse (default: not written) or accept (written, counted in the log)",
      )
      .optional(),
  })
  .describe(
    "per-agent configuration for the set_labels native tool that is not a note (the note lives in toolGuidance.set_labels)",
  );

const toolGuidance = nativeToolKeys(toolNote().nullable()).describe(
  `per-native-tool guidance appended to that tool's description; null clears one. A key outside the catalog is dropped by the reader, so only the names published here take effect. Each note is refused above ${TOOL_INSTRUCTIONS_MAX} characters, not trimmed. PRECEDENCE: handoff_to_human and kanban_move_card also have a note in their own block (handoff.instructions, kanban.instructions); a non-empty value THERE wins over this map for that tool, so the value here applies only while the grouped one is empty.`,
);

// The field descriptions live on the BLOCK: the value is serialized once per key, so a per-field
// `.describe()` would be published once per native tool.
const toolPreconditions = nativeToolKeys(
  z
    .looseObject({
      kind: z.literal("attribute"),
      scope: z.enum(["conversation", "contact"]),
      // NOTE: Blank is refused by the write boundary (`parseToolPrecondition` trims to null), so the
      // schema publishes it as a pattern, which JSON Schema carries faithfully.
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

// What a monitoring agent does with what it reads. Descriptions kept short: the MCP schema ceiling
// (tests/modules/mcp-tool-descriptions.test.ts) is a ratchet, and docs/chatwoot.md has the rest.
const monitoring = z.looseObject({
  analysis: oneOf(["incremental", "on_resolve"] as const)
    .optional()
    .describe(
      "per burst + on resolve, or on resolve only; default incremental",
    ),
  window: z
    .looseObject({ messages: z.number().optional() })
    .optional()
    .describe(
      "newest messages the model reads; 4-60, rounded and clamped, default 20",
    ),
  debounce: z
    .looseObject({
      windowSeconds: z.number().optional(),
      maxWindowSeconds: z.number().optional(),
    })
    .optional()
    .describe(
      "burst window; 3-600s, rounded and clamped, default 20s with a 60s ceiling from the START of the burst",
    ),
});

export const BEHAVIOR_PATCH_SHAPE = {
  debounce: debounce.optional(),
  stt: stt.optional(),
  tts: tts.optional(),
  vision: vision.optional(),
  split: split.optional(),
  signature: signature.optional(),
  serviceWindow: serviceWindow.optional(),
  grounding: grounding.optional(),
  followUp: followUp.optional(),
  handoff: handoff.optional(),
  takeover: takeover.optional(),
  limits: limits.optional(),
  availability: availability.optional(),
  contactAuth: contactAuth.optional(),
  channelRedirect: channelRedirect.optional(),
  attributeContext: attributeContext.optional(),
  contactFields: contactFields.optional(),
  sendImage: sendImage.optional(),
  resolveConversation: resolveConversation.optional(),
  crossInboxCase: crossInboxCase.optional(),
  observability: observability.optional(),
  memory: memory.optional(),
  modelFallback: modelFallback.optional(),
  guardrails: guardrails.optional(),
  kanban: kanban.optional(),
  toolGuidance: toolGuidance.optional(),
  setLabels: setLabels.optional(),
  toolPreconditions: toolPreconditions.optional(),
  monitoring: monitoring.optional(),
} satisfies z.ZodRawShape;

export type BehaviorPatchArgs = z.infer<
  z.ZodObject<typeof BEHAVIOR_PATCH_SHAPE>
>;
