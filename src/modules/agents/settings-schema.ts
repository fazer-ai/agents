import { z } from "zod";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { inRange, type NumberRange } from "@/lib/number-range";
import {
  CALL_RANGES,
  CARRY_ATTACHMENTS_RANGES,
  CHANNEL_REDIRECT_RANGES,
  CONTACT_AUTH_RANGES,
  DEBOUNCE_RANGES,
  DELAY_VALUE_RANGE,
  delayRange,
  GROUNDING_RANGES,
  GUARDRAIL_RANGES,
  LIMITS_RANGES,
  MONITORING_RANGES,
  SERVICE_WINDOW_RANGES,
  SPLIT_RANGES,
  TTS_SPEAKABLE_RANGES,
  TTS_TIMEOUT_RANGES,
  TTS_VOICE_RANGES,
} from "@/modules/agents/number-ranges";
// NOTE: The text caps are IMPORTED, never retyped. They go in `.describe()` and never into the schema
// itself, because they are refused by assertSettingsTextSizes on the write. A caller has to be able
// to build a valid call from tools/list without failing first (docs/mcp.md), and a number copied here
// would be a second copy that drifts.
import { RESOLVE_LABELS_MAX } from "@/modules/agents/resolve-labels";
import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  SNOOZED_FOLLOW_UP_MAX_CADENCES,
  SNOOZED_FOLLOW_UP_MAX_LABELED_CADENCES,
  TEMPLATE_MESSAGE_MAX,
  TOOL_INSTRUCTIONS_MAX,
} from "@/modules/agents/text-caps";
import {
  ALLOWED_LABELS_MAX,
  PROTECTED_LABELS_MAX,
} from "@/modules/agents/tool-guidance";
import { GUARDABLE_TOOL_NAME } from "@/modules/agents/tool-preconditions";
import { REDIRECT_DELAY_UNITS } from "@/modules/channel-redirect/service";
import { CONTACT_FIELDS } from "@/modules/chatwoot/contact-fields";
import {
  CARRY_ATTACHMENTS_DEFAULTS,
  CARRY_FILE_TYPES,
  CARRY_MODES,
} from "@/modules/cross-inbox-case/carry-attachments-settings";
import { CROSS_INBOX_CASE_ATTRIBUTE_KEY_RE } from "@/modules/cross-inbox-case/settings";
import {
  DECISION_PROVIDERS,
  decisionsPatchSchema,
  decisionsSchema,
} from "@/modules/decisions/config";
import {
  FULL_DETAIL_MAX_HOURS,
  parseIsoInstant,
} from "@/modules/flowlog/settings";
import { FOLLOW_UP_DELAY_UNITS } from "@/modules/followups/settings";
import {
  GUARDRAIL_ACTIONS,
  GUARDRAIL_CLASSIFIERS,
  GUARDRAIL_FAILURE_MODES,
  GUARDRAIL_THRESHOLD_KEYS,
  isExternalCheckUrl,
} from "@/modules/guardrails/settings";
import { HANDOFF_MODES } from "@/modules/handoff/settings";
import {
  OTHER_INBOXES_LIMITS,
  OTHER_INBOXES_MAX_INBOXES,
} from "@/modules/other-inboxes/settings";
import {
  SIGNATURE_FREQUENCIES,
  SIGNATURE_POSITIONS,
  SIGNATURE_SEPARATORS,
} from "@/modules/signature/domains";
import { STT_PROVIDER_NAMES } from "@/modules/stt/providers";
import { LANG_RE } from "@/modules/stt/settings";
import { TTS_PROVIDER_NAMES } from "@/modules/tts/providers";
import { TTS_CHECK_MODES, TTS_MODES } from "@/modules/tts/settings-shared";
import {
  ANTHROPIC_VISION_DEFAULT_MAX_TOKENS,
  VISION_MAX_OUTPUT_TOKENS_CAP,
  VISION_REASONING_EFFORTS,
} from "@/modules/vision/output-limits";
import { VISION_PROVIDER_NAMES } from "@/modules/vision/providers";
import {
  CALL_ASR_MODELS,
  CALL_BACKGROUND_SOUNDS,
  CALL_PROVIDERS,
  CALL_TOOL_SOUNDS,
  CALL_TTS_MODELS,
  CALL_TURN_EAGERNESS,
} from "@/modules/voice-call/settings";

// The argument shape of the behavior blocks. Two rules, both in docs/mcp.md: type, choice and range
// (declare what a reader throws away, and every number's range from number-ranges.ts), and what the
// schema enforces is what it publishes in `tools/list`. Blocks are LOOSE so a key added to a reader
// still reaches it.

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

// A configurable number, refused outside its range. The range is the reader's own
// constant, so the schema, the reader and the console field cannot drift apart again; the JSON Schema
// MCP clients read carries it as `minimum`/`maximum`. tests/modules/number-ranges.test.ts fails on a
// settings number declared without one.
export const ranged = (r: NumberRange) =>
  (r.int ? z.number().int() : z.number()).min(r.min).max(r.max);

// A delay's value, whose ceiling follows its unit (30 days in any unit). Refused at the value's own
// path, and `pairedWith` names the unit, so the boundary asks it when the write changed either half.
// Every way out of the range carries it, not just the unit's ceiling: a stored 1.5 with only its
// unit changed is a new delay, and the value's own fraction issue alone would keep it as legacy.
function refineDelay(
  bag: Record<string, unknown>,
  ctx: z.RefinementCtx,
  value: string,
  unit: string,
): void {
  const v = bag[value];
  if (typeof v !== "number") return;
  const r = delayRange(bag[unit]);
  if (inRange(v, r)) return;
  const at = { input: v, path: [value], params: { pairedWith: unit } };
  if (v > r.max) {
    ctx.addIssue({
      ...at,
      code: "too_big",
      origin: "number",
      maximum: r.max,
      inclusive: true,
      message: `at most ${r.max} ${String(bag[unit] ?? "minutes")}`,
    });
  } else if (v < r.min) {
    ctx.addIssue({
      ...at,
      code: "too_small",
      origin: "number",
      minimum: r.min,
      inclusive: true,
      message: `at least ${r.min}`,
    });
  } else {
    ctx.addIssue({
      ...at,
      code: "invalid_type",
      expected: "int",
      message: "a whole number",
    });
  }
}
const delayValue = () => ranged(DELAY_VALUE_RANGE).optional();

const debounce = z.looseObject({
  enabled: z.boolean().optional(),
  windowSeconds: ranged(DEBOUNCE_RANGES.windowSeconds)
    .optional()
    .describe("after the LAST inbound message"),
  maxMessagesPerBurst: ranged(DEBOUNCE_RANGES.maxMessagesPerBurst).optional(),
  maxWindowSeconds: ranged(DEBOUNCE_RANGES.maxWindowSeconds)
    .optional()
    .describe("from the START of the burst; read as at least the window"),
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

// WhatsApp calls (modules/voice-call/settings). The engine is the provider's, on the customer's key.
const calls = z.looseObject({
  provider: oneOf(CALL_PROVIDERS).optional(),
  credentialRef: credentialRef().describe(
    "provider key that can run agents; none = no answer",
  ),
  voice: z.string().optional().describe("provider voice id; empty = default"),
  llm: z.string().optional().describe("model the provider runs"),
  ttsModel: oneOf(CALL_TTS_MODELS).optional(),
  asrModel: oneOf(CALL_ASR_MODELS).optional(),
  speed: ranged(CALL_RANGES.speed).optional(),
  openingDelayMs: ranged(CALL_RANGES.openingDelayMs)
    .optional()
    .describe("placed call's wait for hello, ms"),
  turnEagerness: oneOf(CALL_TURN_EAGERNESS).optional(),
  backgroundSound: oneOf(CALL_BACKGROUND_SOUNDS)
    .nullable()
    .optional()
    .describe("ambience under the speech; null = none"),
  backgroundVolume: ranged(CALL_RANGES.backgroundVolume)
    .optional()
    .describe("relative to the speech"),
  toolSound: oneOf(CALL_TOOL_SOUNDS)
    .nullable()
    .optional()
    .describe("plays while a tool runs; null = silence"),
  silenceEndCallSecs: ranged(CALL_RANGES.silenceEndCallSecs)
    .nullable()
    .optional()
    .describe("silence that ends the call, s; null = never"),
  maxDurationSecs: ranged(CALL_RANGES.maxDurationSecs).optional(),
  keywords: z
    .array(z.string())
    .optional()
    .describe("terms the transcription expects; up to 50"),
  providerAgentId: z
    .string()
    .nullable()
    .optional()
    .describe("server-owned; a write is ignored"),
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
  timeoutMs: ranged(TTS_TIMEOUT_RANGES.timeoutMs)
    .nullable()
    .optional()
    .describe("per synthesis, ms; null = 60000"),
  // The fallback voice, tried once before the reply goes as text. It exists once the provider is
  // named; null removes it.
  fallbackProvider: oneOf(TTS_PROVIDER_NAMES)
    .nullable()
    .optional()
    .describe("tried on a timeout or 5xx/429; null = none"),
  fallbackModel: modelId(),
  fallbackVoice: z.string().optional(),
  fallbackCredentialRef: credentialRef(),
  fallbackBaseURL: baseURL(),
  stability: ranged(TTS_VOICE_RANGES.stability)
    .nullable()
    .optional()
    .describe("null = the voice's own"),
  similarityBoost: ranged(TTS_VOICE_RANGES.similarityBoost)
    .nullable()
    .optional(),
  style: ranged(TTS_VOICE_RANGES.style).nullable().optional(),
  speed: ranged(TTS_VOICE_RANGES.speed).nullable().optional(),
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
  textOverChars: ranged(TTS_SPEAKABLE_RANGES.textOverChars)
    .nullable()
    .optional()
    .describe("text above this many chars (default 450); null = off"),
  textOverListItems: ranged(TTS_SPEAKABLE_RANGES.textOverListItems)
    .nullable()
    .optional()
    .describe("text from this many list items (default 3); null = off"),
  textOverNumbers: ranged(TTS_SPEAKABLE_RANGES.textOverNumbers)
    .nullable()
    .optional()
    .describe(
      "text from this many prices or 4+ digit numbers (default 3); null = off",
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
  // Null is the provider's default; a number is refused outside 1..cap.
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .max(VISION_MAX_OUTPUT_TOKENS_CAP)
    .nullable()
    .optional()
    .describe(`anthropic default ${ANTHROPIC_VISION_DEFAULT_MAX_TOKENS}`),
  reasoningEffort: oneOf(VISION_REASONING_EFFORTS).nullable().optional(),
});

const split = z.looseObject({
  enabled: z.boolean().optional(),
  maxChars: ranged(SPLIT_RANGES.maxChars).optional().describe("balloon size"),
  typingWpm: ranged(SPLIT_RANGES.typingWpm).optional(),
  minDelayMs: ranged(SPLIT_RANGES.minDelayMs).optional(),
  maxDelayMs: ranged(SPLIT_RANGES.maxDelayMs).optional(),
  maxChunks: ranged(SPLIT_RANGES.maxChunks).optional(),
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
  windowHours: ranged(SERVICE_WINDOW_RANGES.windowHours).optional(),
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
    .max(GROUNDING_RANGES.maxDistance.max)
    .nullable()
    .optional()
    .describe("cosine ceiling for a knowledge hit; null = no filter"),
});

const followUpStepShape = z.looseObject({
  delayValue: delayValue().describe("30 days at most, in any unit"),
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
const followUpStep = followUpStepShape.superRefine((v, ctx) =>
  refineDelay(v, ctx, "delayValue", "delayUnit"),
);

// Built from a step schema so the MCP arguments can take the steps unrefined (see
// BEHAVIOR_PATCH_ARGS_SHAPE) while the write boundary asks the refined ones.
const followUpOf = <S extends z.ZodType>(step: S) =>
  z.looseObject({
    enabled: z.boolean().optional(),
    pauseWhileAppointment: z
      .boolean()
      .optional()
      .describe("hold while a reminder is scheduled; default true"),
    steps: z
      .array(step)
      .optional()
      .describe("replaced as a unit, not merged; first 10 kept"),
  });

const snoozedFollowUpOf = <S extends z.ZodType>(step: S) => {
  const cadence = z.looseObject({
    label: z.string().nullable().optional().describe("null = default cadence"),
    steps: z.array(step).optional(),
  });

  return z.looseObject({
    enabled: z.boolean().optional(),
    cadences: z
      .array(cadence)
      .optional()
      .describe(
        `replaced whole; first label match wins; first ${SNOOZED_FOLLOW_UP_MAX_CADENCES} kept (default + ${SNOOZED_FOLLOW_UP_MAX_LABELED_CADENCES} labeled)`,
      ),
    signature: z.boolean().optional(),
  });
};
const followUp = followUpOf(followUpStep);
const snoozedFollowUp = snoozedFollowUpOf(followUpStep);

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
  maxToolCalls: ranged(LIMITS_RANGES.maxToolCalls)
    .optional()
    .describe("tool executions in ONE turn"),
  maxHistoryTokens: z
    .union([z.literal(0), ranged(LIMITS_RANGES.maxHistoryTokens)])
    .nullable()
    .optional()
    .describe("null/0/absent = OFF"),
  retrySilence: z
    .boolean()
    .optional()
    .describe("retry a silent reply turn once; default TRUE"),
  maxTurnsPerHour: ranged(LIMITS_RANGES.maxTurnsPerHour)
    .optional()
    .describe("per conversation per hour; 0 = off"),
  maxProactivePerDay: ranged(LIMITS_RANGES.maxProactivePerDay)
    .optional()
    .describe("per conversation per 24h; 0 = off"),
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

// The local rule, asked before `url` (which is then called only under `askEndpointAfterRule`). One
// flat union: a nested one publishes an `anyOf` wrapper per level and refuses the same values.
const contactAuthConditions = [
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
  z.object({
    kind: z.literal("conversation_type"),
    type: z.enum(["group", "individual"]),
  }),
  z.object({
    kind: z.literal("label"),
    label: nonBlank("must not be blank"),
  }),
] as const;

const contactAuthRule = z
  .union([
    ...contactAuthConditions,
    z.object({
      kind: z.enum(["all", "any"]),
      // NOTE: each condition is one of the shapes above; only the kind is declared here, so the
      // published schema does not carry the union twice. The write boundary parses the rest.
      conditions: z.array(
        z.looseObject({
          kind: z.enum([
            "allowlist",
            "attribute",
            "conversation_type",
            "label",
          ]),
        }),
      ),
    }),
    z.null(),
  ])
  .optional()
  .describe(
    "allowlist 1-500 entries; all/any 1-10 conditions, one level; null clears",
  );

// The descriptions carry only what a caller cannot read off the shape: clamps, refusals, and what
// null or 0 means. The gate's semantics are in docs/contact-auth.md.
const contactAuth = z.looseObject({
  enabled: z.boolean().optional(),
  rule: contactAuthRule,
  askEndpointAfterRule: z.boolean().optional(),
  url: z
    .string()
    .nullable()
    .optional()
    .describe("fixed origin, no placeholders"),
  credentialRef: credentialRef(),
  timeoutMs: ranged(CONTACT_AUTH_RANGES.timeoutMs).optional(),
  noticeCooldownSeconds: ranged(CONTACT_AUTH_RANGES.noticeCooldownSeconds)
    .optional()
    .describe("notices only; 0 = every refusal"),
  includeMessageText: z.boolean().optional(),
  denyMessage: z.string().nullable().optional().describe("null = say nothing"),
  handoffEnabled: z.boolean().optional(),
  operatorNoteEnabled: z.boolean().optional(),
  mode: z
    .enum(["perMessage", "once"])
    .optional()
    .describe("once = keep a contact's first allow"),
  grantTtlSeconds: ranged(CONTACT_AUTH_RANGES.grantTtlSeconds).optional(),
  handoffTeamId: chatwootId(),
  handoffTeamInstanceId: chatwootId().describe(
    "our ChatwootInstance id the team is from",
  ),
});

const channelRedirectShape = z.looseObject({
  enabled: z.boolean().optional(),
  entryInboxId: chatwootId().describe(
    "the WhatsApp chatwootInboxId leads arrive on",
  ),
  widgetInboxId: chatwootId().describe(
    "the widget chatwootInboxId; set via the console",
  ),
  redirectMessage: z.string().optional().describe("must carry {link}"),
  resendDelayValue: delayValue(),
  resendDelayUnit: oneOf(REDIRECT_DELAY_UNITS).optional(),
  maxResends: ranged(CHANNEL_REDIRECT_RANGES.maxResends).optional(),
  openWidget: z.boolean().optional(),
  cloneWaMessage: z
    .boolean()
    .optional()
    .describe("replay it as the first widget message"),
  chatFollowupEnabled: z.boolean().optional(),
  chatFollowupDelayValue: delayValue(),
  chatFollowupDelayUnit: oneOf(REDIRECT_DELAY_UNITS).optional(),
  chatFollowupInstructions: z.string().optional(),
  waFollowupEnabled: z.boolean().optional(),
  waFollowupDelayValue: delayValue(),
  waFollowupDelayUnit: oneOf(REDIRECT_DELAY_UNITS).optional(),
  waFollowupMessage: z.string().optional().describe("must carry {link}"),
  closingEnabled: z.boolean().optional(),
  closingDelayValue: delayValue(),
  closingDelayUnit: oneOf(REDIRECT_DELAY_UNITS).optional(),
  closingMessage: z
    .string()
    .optional()
    .describe("fixed, posted on BOTH channels"),
});
const REDIRECT_DELAY_PAIRS: [value: string, unit: string][] = [
  ["resendDelayValue", "resendDelayUnit"],
  ["chatFollowupDelayValue", "chatFollowupDelayUnit"],
  ["waFollowupDelayValue", "waFollowupDelayUnit"],
  ["closingDelayValue", "closingDelayUnit"],
];
const channelRedirect = channelRedirectShape.superRefine((v, ctx) => {
  for (const [value, unit] of REDIRECT_DELAY_PAIRS)
    refineDelay(v, ctx, value, unit);
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
    .describe("⊆ context, else refused; empty = no update_contact"),
});

const otherInboxInt = (b: { min: number; max: number }) =>
  z.number().int().min(b.min).max(b.max).optional();

const otherInboxes = z.looseObject({
  enabled: z.boolean().optional(),
  inboxes: z
    .array(
      z.object({
        instanceId: z.number().int().positive(),
        inboxId: z.number().int().positive(),
      }),
    )
    .max(OTHER_INBOXES_MAX_INBOXES)
    .optional()
    .describe("chatwootInboxId + our instance id; empty = none read"),
  maxConversations: otherInboxInt(OTHER_INBOXES_LIMITS.maxConversations),
  lookbackDays: otherInboxInt(OTHER_INBOXES_LIMITS.lookbackDays),
  fullTranscriptMaxChars: otherInboxInt(
    OTHER_INBOXES_LIMITS.fullTranscriptMaxChars,
  ),
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
  carryAttachments: z
    .looseObject({
      mode: z
        .enum(CARRY_MODES)
        .optional()
        .describe(
          "off (default); attendance = the origin's current attendance; conversation = all of it",
        ),
      fileTypes: z
        .array(z.string())
        .optional()
        .describe(
          `of ${CARRY_FILE_TYPES.join(", ")}; others dropped; default image, file`,
        ),
      maxFiles: ranged(CARRY_ATTACHMENTS_RANGES.maxFiles)
        .optional()
        .describe(`newest win; default ${CARRY_ATTACHMENTS_DEFAULTS.maxFiles}`),
    })
    .optional()
    .describe("the customer's files copied into the case as one private note"),
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

const knowledge = z.looseObject({
  // The model that reviews the agent's knowledge suggestions before they reach the queue, as an
  // override of the agent's. Resolved at READ time like memory.compaction: a half-named override is
  // stored without complaint and the review falls back to queueing the proposal unreviewed. All
  // four absent (the default) reviews on the agent's model.
  suggestionReview: z
    .looseObject({
      provider: oneOf(MODEL_PROVIDERS)
        .nullable()
        .optional()
        .describe("reviewer model PROVIDER; null inherits the agent's"),
      model: z.string().nullable().optional(),
      credentialRef: credentialRef(),
      baseURL: baseURL(),
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

// A threshold is refused outside 0..1 rather than clamped: GET returns what was stored, and a stored
// -0.5 would be read by the screening as 0 while the API kept showing -0.5.
const guardrailThreshold = ranged(GUARDRAIL_RANGES.threshold)
  .optional()
  .describe("probability at or above which the check trips; default 0.8");

const guardrailDecisions = z.looseObject({
  provider: oneOf(DECISION_PROVIDERS)
    .optional()
    .describe(
      "the classification API: typesafe (Jev) or openai (OpenAI Decisions)",
    ),
  model: modelId(),
  credentialRef: credentialRef(),
  thresholds: z
    .looseObject(
      Object.fromEntries(
        GUARDRAIL_THRESHOLD_KEYS.map((k) => [k, guardrailThreshold]),
      ),
    )
    .optional()
    .describe(
      "per check, plus customPolicy for the operator's policy; absent = 0.8",
    ),
});

const guardrails = z
  .looseObject({
    enabled: z.boolean().optional(),
    classifier: oneOf(GUARDRAIL_CLASSIFIERS)
      .optional()
      .describe(
        "who judges: chat = the guardrails model writes a verdict (default); decisions = a classification API asks each check as a yes/no question, configured under `decisions`",
      ),
    decisions: guardrailDecisions
      .optional()
      .describe(
        "the classification API used when classifier is decisions; the chat model fields stay stored for switching back",
      ),
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
    external: z
      .looseObject({
        url: z
          .string()
          .refine(
            isExternalCheckUrl,
            "must be an https URL with no credentials in it",
          )
          .nullable()
          .optional()
          .describe(
            "the endpoint that judges each reply before delivery; null = no external check",
          ),
        credentialRef: credentialRef().describe(
          "vault entry NAME or vault:<id> of the HMAC signing secret; null = unsigned",
        ),
        sendToolValues: z
          .boolean()
          .optional()
          .describe(
            "false sends tool call names and sizes without arguments and results (default true)",
          ),
      })
      .optional()
      .describe(
        "an endpoint that answers allow, replace or block for each reply to a customer message; a block fires output.action, a failure follows onFailure",
      ),
    onFailure: oneOf(GUARDRAIL_FAILURE_MODES)
      .optional()
      .describe(
        "when a check cannot judge (timeout, error, missing credential): pass = the message continues unchecked (default); hold = it is stopped and the conversation goes to the team with the direction's handoffMessage. Proactive sends always pass",
      ),
  })
  .superRefine(
    (v, ctx) => {
      // A classification API answers numbers: no model writes the replacement `generated` sends.
      // Asked over the whole block (`wholeBlock`), since switching the classifier makes an unchanged
      // action wrong. The MCP patch reaches here merged, so REST and MCP refuse the same write.
      const bag = v as Record<string, unknown>;
      if (bag.classifier !== "decisions") return;
      for (const dir of ["input", "output"] as const) {
        const d = bag[dir];
        if (
          d &&
          typeof d === "object" &&
          "action" in d &&
          d.action === "generated"
        ) {
          ctx.addIssue({
            code: "custom",
            path: [dir, "action"],
            message:
              "the decisions classifier cannot write a replacement reply: choose template, silent or handoff",
            params: { wholeBlock: 2 },
          });
        }
      }
    },
    // Runs past the aborting issues too: a normalized block carries the input's reply-only checks,
    // which fail their `never` and are let through by the write boundary when typed as the reader's.
    { when: (payload) => !!payload.value && typeof payload.value === "object" },
  );

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

// Keyed by any tool name, so the names are checked rather than published: a catalog of native
// properties would not refuse a typo here (the catchall takes any valid name) and only adds size.
const guardableToolKeys = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({})
    .catchall(value)
    .check((ctx) => {
      for (const [name, value] of Object.entries(ctx.value)) {
        // NOTE: a removal (`null`) passes whatever its name, so a rule stored under a name that is no
        // longer valid can still be deleted; the write boundary says whether it was there.
        if (value === null || GUARDABLE_TOOL_NAME.test(name)) continue;
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: [name],
          message:
            "must be a tool name: letters, digits, `_` or `-`, up to 64, not starting with `_`",
        });
      }
    });

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
const toolPreconditions = guardableToolKeys(
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
  "per-tool precondition, keyed by the name the model calls (native, toolpack, HTTP, code, `mcp__<server>__<tool>`); `null` removes one. `key` is the attribute that must be set on `scope`, `equals` the required value (omit for any). Unmet, the call does not run and the model is told why.",
);

// What a monitoring agent does with what it reads. Descriptions kept short: the MCP schema ceiling
// (tests/modules/mcp-tool-descriptions.test.ts) is a ratchet, and docs/chatwoot.md has the rest.
const monitoringShape = (decisions: z.ZodType<Record<string, unknown>>) => ({
  engine: oneOf(["llm", "decisions"] as const)
    .optional()
    .describe("llm (prompt+tools, default) or decisions (docs/decisions.md)"),
  decisions: decisions
    .nullable()
    .optional()
    .describe(
      "provider openai|typesafe, model, credentialRef, questions, rules",
    ),
  analysis: oneOf(["incremental", "on_resolve"] as const)
    .optional()
    .describe(
      "per burst + on resolve, or on resolve only; default incremental",
    ),
  window: z
    .looseObject({
      messages: ranged(MONITORING_RANGES.windowMessages).optional(),
    })
    .optional()
    .describe("newest messages the model reads; default 20"),
  debounce: z
    .looseObject({
      // A negative window is refused, not read as 0: 0 is the one value that changes what the agent
      // costs (a model call per message), so it is never reached by a typo's clamp.
      windowSeconds: ranged(MONITORING_RANGES.windowSeconds).optional(),
      maxWindowSeconds: ranged(MONITORING_RANGES.maxWindowSeconds).optional(),
    })
    .optional()
    .describe(
      "burst window in seconds (0: every message, no coalescing); default 20s with a 60s ceiling from the START of the burst",
    ),
});
// The engine and its block are one choice: `decisions` without a block would skip every tick.
// `wholeBlock`, so any edit of the monitoring block re-asks it (see decisionsSchema).
function refineMonitoringEngine(
  v: { engine?: unknown; decisions?: unknown },
  ctx: z.RefinementCtx,
) {
  if (v.engine === "decisions" && (v.decisions ?? null) === null) {
    ctx.addIssue({
      code: "custom",
      path: ["engine"],
      message: "the decisions engine needs a decisions block",
      params: { wholeBlock: 1 },
    });
  }
}
// The write boundary asks the whole block; the MCP argument is a patch, merged before it is whole.
const monitoring = z
  .looseObject(monitoringShape(decisionsSchema))
  .superRefine(refineMonitoringEngine);
const monitoringPatch = z.looseObject(monitoringShape(decisionsPatchSchema));

export const BEHAVIOR_PATCH_SHAPE = {
  debounce: debounce.optional(),
  stt: stt.optional(),
  tts: tts.optional(),
  calls: calls.optional(),
  vision: vision.optional(),
  split: split.optional(),
  signature: signature.optional(),
  serviceWindow: serviceWindow.optional(),
  grounding: grounding.optional(),
  followUp: followUp.optional(),
  snoozedFollowUp: snoozedFollowUp.optional(),
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
  otherInboxes: otherInboxes.optional(),
  observability: observability.optional(),
  memory: memory.optional(),
  knowledge: knowledge.optional(),
  modelFallback: modelFallback.optional(),
  guardrails: guardrails.optional(),
  kanban: kanban.optional(),
  toolGuidance: toolGuidance.optional(),
  setLabels: setLabels.optional(),
  toolPreconditions: toolPreconditions.optional(),
  monitoring: monitoring.optional(),
} satisfies z.ZodRawShape;

// Each block's refinements alone (the delay pairs, the monitoring engine), for the write boundary to
// ask on their own: zod skips an object's refinement once any of its fields fails, so a legacy
// fraction elsewhere in the block would let a changed pair through unchecked. Each level is an empty
// loose object, which any object parses.
const delayPairs = (...pairs: [value: string, unit: string][]) =>
  z.looseObject({}).superRefine((v, ctx) => {
    for (const [value, unit] of pairs) refineDelay(v, ctx, value, unit);
  });
const stepDelays = z.array(delayPairs(["delayValue", "delayUnit"]));
export const BLOCK_REFINEMENTS: Record<string, z.ZodType> = {
  followUp: z.looseObject({ steps: stepDelays.optional() }),
  snoozedFollowUp: z.looseObject({
    cadences: z
      .array(z.looseObject({ steps: stepDelays.optional() }))
      .optional(),
  }),
  channelRedirect: delayPairs(...REDIRECT_DELAY_PAIRS),
  monitoring: z.looseObject({}).superRefine(refineMonitoringEngine),
};

// What agent_settings_set takes: the patch shape with `monitoring.decisions` and the delays unrefined,
// since each refinement needs the merged block (a delay's unit may be stored while the patch names only
// its value) and JSON Schema cannot publish it. The handler asks the refined shape before the merge.
export const BEHAVIOR_PATCH_ARGS_SHAPE = {
  ...BEHAVIOR_PATCH_SHAPE,
  followUp: followUpOf(followUpStepShape).optional(),
  snoozedFollowUp: snoozedFollowUpOf(followUpStepShape).optional(),
  channelRedirect: channelRedirectShape.optional(),
  monitoring: monitoringPatch.optional(),
} satisfies z.ZodRawShape;

export type BehaviorPatchArgs = z.infer<
  z.ZodObject<typeof BEHAVIOR_PATCH_SHAPE>
>;
