import { z } from "zod";
import {
  MODEL_PROVIDERS,
  PROVIDERS_HONORING_BASE_URL,
} from "@/graph/model-config";
import { intRange, numberRange } from "@/lib/number-range";
import { unstorableCodePoints } from "@/lib/text";

// AN OCCURRENCE MONITOR'S CONFIGURATION, the `config` of its `occurrence_monitors` row (docs/occurrences.md).
// It declares which inboxes the monitor reads, what it reads off each conversation (the FIELDS,
// entirely the account's choice), which of them is the REASON the model groups into themes and which,
// optionally, the REFERENCE a theme's conversations are counted by, the one model every step runs on,
// and when the rounds run. The readings, the rounds and the themes are rows of their own; this block
// is only what an admin chooses.

// A field's key doubles as a Chatwoot custom attribute key when the field is mirrored there, so it is
// spelled the way Chatwoot derives one: lowercase letters, digits and underscores.
export const FIELD_KEY_PATTERN = /^[a-z0-9_]{1,64}$/;
export const FIELD_NAME_MAX = 80;
export const FIELD_DESCRIPTION_MAX = 500;
export const FIELDS_MAX = 10;

// At most this many conversations are read per round, the ones waiting longest first; the rest wait
// for the next round, and the round's row says how many.
export const READINGS_PER_ROUND = 200;
// The conversation's newest messages the model reads (customer and team, private notes excluded).
export const READING_MESSAGES = 30;
// How many open themes one read of the list returns at most (the console pages within one read).
export const THEMES_LIMIT_RANGE = intRange(1, 500);

// A round every few minutes at most often (the prototype's hourly round saw an outage an hour late),
// once a day at least.
export const CADENCE_MINUTES_RANGE = intRange(5, 1440);
// The stronger model's pass over the open themes, rarer than the rounds: hourly by default, weekly at
// most rarely.
export const CONSOLIDATION_MINUTES_RANGE = intRange(15, 10_080);
// The flags (docs/occurrences.md, "Flags"). N: conversations a theme needs in the window before it is
// flagged at all, so one or two customers never raise one.
export const NEW_MIN_CONVERSATIONS_RANGE = intRange(1, 10_000);
export const WINDOW_MINUTES_RANGE = intRange(15, 1440);
export const PREVIOUS_DAYS_RANGE = intRange(1, 30);
// X: how many times its own usual rate the window has to run at.
export const ABOVE_USUAL_RATIO_RANGE = numberRange(1.1, 100);
// The share of a theme's window conversations with one reference.
export const CONCENTRATION_SHARE_RANGE = numberRange(0.1, 1);
// How long a flagged theme that met no rule keeps its flags (held) before they drop; 0 drops them the
// first round, as alerting holds an alert a while after its condition clears. A day at most.
export const FLAG_HOLD_MINUTES_RANGE = intRange(0, 1440);
// How long after its first conversation a theme can still be new, so "new" does not end by itself when
// the window moves past that conversation. A week at most.
export const NEW_WITHIN_MINUTES_RANGE = intRange(15, 10_080);
export const MODEL_ID_MAX = 200;
export const BASE_URL_MAX = 500;
export const CREDENTIAL_REF_MAX = 200;
// The inboxes one monitor reads: an account's whole line-up, with room to spare.
export const INBOXES_MAX = 50;
// What the account tells every step about its business. Long enough for a paragraph on what it deals
// with and what is routine, short enough to ride on every call without crowding out the conversation.
export const BUSINESS_CONTEXT_MAX = 2_000;

// The model calls of a round, each its own call type in the usage ledger. `reading` is the
// conversation read; the other three run over what the readings say. All four run on the monitor's one
// model.
export const OCCURRENCE_STEPS = [
  "reading",
  "canonical",
  "assignment",
  "consolidation",
] as const;
export type OccurrenceStep = (typeof OCCURRENCE_STEPS)[number];

// The monitor's model: its own provider, vault credential and model id, never borrowed from an agent.
// A null model is the provider's default. `baseURL` is the endpoint for `openai-compatible`, or a
// proxy for a provider that honors one; null uses the credential's own, then the vendor's.
export interface OccurrenceModel {
  provider: (typeof MODEL_PROVIDERS)[number];
  model: string | null;
  credentialRef: string | null;
  baseURL: string | null;
}

export interface OccurrenceField {
  key: string;
  name: string;
  // What the observer is told to write, verbatim: the account's words, not ours.
  description: string;
  // Also write the value to the conversation's Chatwoot custom attribute of the same key, which is
  // what a folder filters by. Off for a field that is noise to the people answering.
  attribute: boolean;
}

export interface OccurrencesConfig {
  enabled: boolean;
  // The inboxes whose conversations the monitor reads and counts (`Inbox` row ids). Readings of any
  // other inbox stay stored and count nowhere.
  inboxIds: string[];
  fields: OccurrenceField[];
  // The short sentence of why the customer came, grouped into themes, and optionally what it refers to
  // (whatever the account deals with), which a theme's conversations are counted by for the
  // concentration flag. Both are keys of `fields`; the reference may be none.
  reasonField: string | null;
  referenceField: string | null;
  cadenceMinutes: number;
  consolidationMinutes: number;
  newMinConversations: number;
  windowMinutes: number;
  previousDays: number;
  aboveUsualRatio: number;
  concentrationShare: number;
  flagHoldMinutes: number;
  newWithinMinutes: number;
  model: OccurrenceModel | null;
  // Appended to every step's fixed prompt as context about the business; empty sends nothing.
  businessContext: string;
  // On upstream Chatwoot a voice note's words and an image's description live only in this process's
  // memory for 15 minutes; on, the reading transcribes or describes again what a conversation's new
  // messages are missing, with the inbox agent's speech-to-text and vision, on its own cost lines.
  recoverMedia: boolean;
}

export const OCCURRENCES_DEFAULTS: OccurrencesConfig = {
  enabled: false,
  inboxIds: [],
  fields: [],
  reasonField: null,
  referenceField: null,
  cadenceMinutes: 15,
  consolidationMinutes: 60,
  newMinConversations: 5,
  windowMinutes: 60,
  previousDays: 7,
  aboveUsualRatio: 3,
  concentrationShare: 0.6,
  flagHoldMinutes: 120,
  newWithinMinutes: 360,
  model: null,
  businessContext: "",
  recoverMedia: false,
};

const ranged = (r: { min: number; max: number; int: boolean }) =>
  (r.int ? z.number().int() : z.number()).min(r.min).max(r.max);

// A key the block does not have is refused, not dropped, so a caller that means a setting this
// version lacks is told so. zod's own message quotes the caller's key; this one does not.
const unknownKey = {
  error: (issue: { code?: string }) =>
    issue.code === "unrecognized_keys"
      ? "a key the block does not have"
      : undefined,
};

// A NUL or half of a character passes every length bound and fails at the JSONB write: refused here,
// so a preview and an apply refuse the same block.
const storableMessage =
  "contains characters the database cannot store (a NUL or half of a character)";

// A blank model id is the provider's default, the same as null; so is a blank endpoint.
const blankIsNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => unstorableCodePoints(v) === null, storableMessage)
    .nullable()
    .transform((v) => (v === "" || v === null ? null : v));

const rowId = z.string().regex(/^[1-9][0-9]{0,18}$/, "an inbox id is a row id");

export const occurrenceModelSchema = z
  .strictObject(
    {
      provider: z.enum(MODEL_PROVIDERS),
      model: blankIsNull(MODEL_ID_MAX),
      credentialRef: blankIsNull(CREDENTIAL_REF_MAX),
      baseURL: blankIsNull(BASE_URL_MAX).refine(
        (v) => v === null || URL.canParse(v),
        "baseURL is not a URL",
      ),
    },
    unknownKey,
  )
  .superRefine((m, ctx) => {
    // `openai-compatible` authenticates through its endpoint and may have no key (a local server);
    // every other provider needs one, and the agent's is not there to fall back on.
    if (m.provider !== "openai-compatible" && m.credentialRef === null)
      ctx.addIssue({
        code: "custom",
        path: ["credentialRef"],
        message: `a ${m.provider} model needs a credential`,
      });
    if (m.provider === "openai-compatible" && m.model === null)
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "an openai-compatible model needs a model id",
      });
    // With no credential there is no endpoint to inherit either: the model names its own. One that
    // names a credential is checked against the credential's endpoint on save (monitors.ts).
    if (
      m.provider === "openai-compatible" &&
      m.credentialRef === null &&
      m.baseURL === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["baseURL"],
        message: "an openai-compatible model needs an endpoint",
      });
    // An endpoint the provider's adapter drops would send the conversations to the vendor's own
    // host instead of the proxy named here (graph/model-config.ts, PROVIDERS_HONORING_BASE_URL).
    if (
      m.baseURL !== null &&
      !(PROVIDERS_HONORING_BASE_URL as readonly string[]).includes(m.provider)
    )
      ctx.addIssue({
        code: "custom",
        path: ["baseURL"],
        message: `a ${m.provider} model does not take an endpoint`,
      });
  });

export const occurrenceFieldSchema = z.strictObject(
  {
    key: z
      .string()
      .regex(
        FIELD_KEY_PATTERN,
        "a field key is lowercase letters, digits and _",
      )
      // The key names a property of the tool's schema and of the readings it writes: `__proto__` would
      // set the object's prototype, and `constructor` reads as the inherited one when the call omits it.
      .refine(
        (k) => !(k in Object.prototype),
        "a field key cannot be a name every object already has",
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(FIELD_NAME_MAX)
      .refine((v) => unstorableCodePoints(v) === null, storableMessage),
    description: z
      .string()
      .trim()
      .min(1)
      .max(FIELD_DESCRIPTION_MAX)
      .refine((v) => unstorableCodePoints(v) === null, storableMessage),
    attribute: z.boolean(),
  },
  unknownKey,
);

export const occurrencesSettingsSchema = z
  .strictObject(
    {
      enabled: z.boolean(),
      inboxIds: z.array(rowId).max(INBOXES_MAX),
      fields: z.array(occurrenceFieldSchema).max(FIELDS_MAX),
      reasonField: z.string().nullable(),
      referenceField: z.string().nullable(),
      cadenceMinutes: ranged(CADENCE_MINUTES_RANGE),
      consolidationMinutes: ranged(CONSOLIDATION_MINUTES_RANGE),
      newMinConversations: ranged(NEW_MIN_CONVERSATIONS_RANGE),
      windowMinutes: ranged(WINDOW_MINUTES_RANGE),
      previousDays: ranged(PREVIOUS_DAYS_RANGE),
      aboveUsualRatio: ranged(ABOVE_USUAL_RATIO_RANGE),
      concentrationShare: ranged(CONCENTRATION_SHARE_RANGE),
      flagHoldMinutes: ranged(FLAG_HOLD_MINUTES_RANGE),
      newWithinMinutes: ranged(NEW_WITHIN_MINUTES_RANGE),
      model: occurrenceModelSchema.nullable(),
      // Stored and returned exactly as sent: the cap counts the raw text, and only the prompt it is
      // appended to trims it.
      businessContext: z
        .string()
        .max(
          BUSINESS_CONTEXT_MAX,
          `the business context is at most ${BUSINESS_CONTEXT_MAX} characters`,
        )
        .refine((v) => unstorableCodePoints(v) === null, storableMessage),
      recoverMedia: z.boolean(),
    },
    unknownKey,
  )
  .superRefine((b, ctx) => {
    if (new Set(b.inboxIds).size !== b.inboxIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["inboxIds"],
        message: "an inbox is listed twice",
      });
    const keys = b.fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: "two fields share a key",
      });
    for (const which of ["reasonField", "referenceField"] as const) {
      const key = b[which];
      if (key !== null && !keys.includes(key))
        ctx.addIssue({
          code: "custom",
          path: [which],
          message: `${which} names no declared field`,
        });
    }
    if (b.referenceField !== null && b.referenceField === b.reasonField)
      ctx.addIssue({
        code: "custom",
        path: ["referenceField"],
        message: "the reason and the reference are different fields",
      });
    // The reference is optional: without it the monitor runs and only the concentration flag is off.
    if (b.enabled) {
      if (b.reasonField === null)
        ctx.addIssue({
          code: "custom",
          path: ["reasonField"],
          message: "switching occurrences on needs a reason field",
        });
      if (b.model === null)
        ctx.addIssue({
          code: "custom",
          path: ["model"],
          message: "switching occurrences on needs a model",
        });
      if (b.inboxIds.length === 0)
        ctx.addIssue({
          code: "custom",
          path: ["inboxIds"],
          message: "switching occurrences on needs at least one inbox",
        });
    }
  });

// Lenient, like every runtime reader of a stored block: an absent or damaged block is the default,
// which is OFF. A block that no longer parses must not start spending a model. A key this version
// does not have (a later version wrote it) is left out, so it does not switch the monitor off.
export function readOccurrencesConfig(settings: unknown): OccurrencesConfig {
  const block = (settings as Record<string, unknown> | null | undefined)
    ?.occurrences;
  if (!block || typeof block !== "object")
    return structuredClone(OCCURRENCES_DEFAULTS);
  const known = {
    ...OCCURRENCES_DEFAULTS,
    ...Object.fromEntries(
      Object.entries(block).filter(([k]) =>
        Object.hasOwn(OCCURRENCES_DEFAULTS, k),
      ),
    ),
  };
  const parsed = occurrencesSettingsSchema.safeParse(known);
  if (parsed.success) return parsed.data;
  // A block that is on but can no longer run (one saved before the monitor named its own model and
  // inboxes) reads as an OFF draft with what it has, so the admin finds the fields still there.
  const draft = occurrencesSettingsSchema.safeParse({
    ...known,
    enabled: false,
  });
  return draft.success ? draft.data : structuredClone(OCCURRENCES_DEFAULTS);
}

// A monitor's own block (`occurrence_monitors.config`), read as leniently as the account's block was.
export function readMonitorConfig(config: unknown): OccurrencesConfig {
  return readOccurrencesConfig({ occurrences: config });
}

// The patch a REST or MCP caller sends: any top-level key; what it leaves out keeps its value.
export type OccurrencesPatch = Partial<OccurrencesConfig>;

export function mergeOccurrences(
  current: OccurrencesConfig,
  patch: OccurrencesPatch,
): unknown {
  const top = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  return { ...current, ...top };
}
