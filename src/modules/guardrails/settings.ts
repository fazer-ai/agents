import { MODEL_PROVIDERS, type ModelConfig } from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import { resolveModelOverride } from "@/graph/model-override";
import { parseDbId } from "@/lib/db-id";
import { clampToRange } from "@/lib/number-range";
import { clipText } from "@/lib/text";
import { GUARDRAIL_RANGES } from "@/modules/agents/number-ranges";
import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
} from "@/modules/agents/text-caps";
import {
  DECISION_PROVIDERS,
  DEFAULT_DECISION_MODEL,
  type DecisionProvider,
} from "@/modules/decisions/config";

// Per-agent guardrails (input/output moderation) config, read from `agent.settings.guardrails`. A
// dedicated LLM "guardrails agent" (its OWN selectable chat model, separate from the main agent's)
// analyzes the customer message (input) and/or the agent reply (output) against a set of standard
// checks; on a violation the configured PER-DIRECTION action fires (template reply / a guardrails-
// generated safe reply / stay silent / hand the conversation to the team / only record the verdict). This reader is the single source of defaults + clamping, so a
// malformed value never breaks the webhook. Surfaced in the agent editor. Off by default.

// `observe` runs the check and records the verdict, and the conversation goes on as if it had passed:
// nothing is replaced, suppressed or handed over, and no note is posted. It is how an operator measures
// a policy on real traffic before letting it act.
export type GuardrailAction =
  | "template"
  | "generated"
  | "silent"
  | "handoff"
  | "observe";
export const GUARDRAIL_ACTIONS: readonly GuardrailAction[] = [
  "template",
  "generated",
  "silent",
  "handoff",
  "observe",
];

// Who judges a screening. `chat` is the guardrails agent's own chat model writing a verdict with a
// rationale (./analyze). `decisions` asks a classification API of the decisions engine
// (modules/decisions: Jev on TypeSafe, OpenAI Decisions) one yes/no question per enabled check and per
// operator policy, and a check trips when its probability reaches its threshold. The chat verdict is
// the default because only the chat model writes a replacement reply.
export type GuardrailClassifier = "chat" | "decisions";
export const GUARDRAIL_CLASSIFIERS: readonly GuardrailClassifier[] = [
  "chat",
  "decisions",
];

// What each threshold is keyed by: the checks, by their settings name, plus the operator's policy,
// which a decisions provider answers as a question of its own.
export type GuardrailThresholdKey = keyof GuardrailChecks | "customPolicy";
export const GUARDRAIL_THRESHOLD_KEYS: readonly GuardrailThresholdKey[] = [
  "toxicity",
  "unsafeContent",
  "competitorMentions",
  "promptAdherence",
  "answerRelevance",
  "customPolicy",
];
export const DEFAULT_GUARDRAIL_THRESHOLD = 0.8;

export interface GuardrailDecisionsConfig {
  provider: DecisionProvider;
  // Always a usable model after the reader: empty resolves to the provider's default.
  model: string;
  credentialRef: string | null; // `vault:<id>`, of the provider's own kind or a generic key
  // Probability at or above which a check trips, 0 to 1, per check and for the policy.
  thresholds: Record<GuardrailThresholdKey, number>;
}

// What a screening that could not judge does with the message: `pass` lets it continue unchecked (the
// default), `hold` stops it and hands the conversation to the team. A check that answered is unaffected.
export type GuardrailFailureMode = "pass" | "hold";
export const GUARDRAIL_FAILURE_MODES: readonly GuardrailFailureMode[] = [
  "pass",
  "hold",
];

export interface GuardrailChecks {
  // Harassment, hate speech, insults, or abusive/threatening language.
  toxicity: boolean;
  // Sexual content, graphic violence, illegal/dangerous acts, or self-harm.
  unsafeContent: boolean;
  // Mentions/recommendations of the configured competitor names.
  competitorMentions: boolean;
  // (output only) the reply stays within the scope/persona set by the agent's instructions.
  promptAdherence: boolean;
  // (output only) the reply addresses what the customer actually asked. Separate from
  // promptAdherence, and OFF by default, because it is the only check whose input is the customer's
  // own message and the only one that can trip on a correct reply: a short continuation ("sim")
  // makes a complete answer look like an answer to a different question, and the configured action
  // then replaces a good reply in front of the customer. Opting in is the point.
  answerRelevance: boolean;
}

export interface GuardrailDirectionConfig {
  enabled: boolean;
  checks: GuardrailChecks;
  // What to do on a violation: send `templateMessage` verbatim, send a guardrails-generated safe
  // reply, stay silent (send nothing), hand over to the team, or only record it. Default "template".
  action: GuardrailAction;
  // The static reply used when action === "template".
  templateMessage: string;
  // Steering prompt for action === "generated": guides HOW the guardrails agent writes the
  // replacement reply (tone, what to offer, what to avoid). Empty → generic safe reply.
  generationPrompt: string;
  // What the CUSTOMER reads when action === "handoff": the case went to the team. Not
  // `templateMessage`, which is a refusal, and a refusal is the wrong sentence for "a person will
  // continue". EMPTY is a real value and means: say nothing, only hand over.
  handoffMessage: string;
}

// The customer side also reads the conversation: a short reply ("sim, o vip, como?") is ambiguous on
// its own and plain after the question it answers.
export interface GuardrailInputConfig extends GuardrailDirectionConfig {
  // How many earlier messages travel beside the customer's as context, never judged themselves. 0 is
  // the message alone, which is what an agent saved before this setting existed keeps.
  contextMessages: number;
}

// What a NEW agent is born with (modules/agents/creation-defaults.ts): two exchanges.
export const NEW_AGENT_CONTEXT_MESSAGES = 4;

export interface GuardrailsConfig {
  enabled: boolean;
  // Who judges. The chat model's fields below stay stored while a decisions provider is chosen, so
  // switching back restores them.
  classifier: GuardrailClassifier;
  decisions: GuardrailDecisionsConfig;
  // The guardrails agent's own chat model (separate from the main agent's model).
  provider: ModelConfig["provider"];
  // Always a usable model name after the reader: an empty stored value resolves to
  // PROVIDER_DEFAULT_MODEL, and stays "" only for openai-compatible, where the server picks.
  model: string;
  credentialRef: string | null; // `vault:<id>` ref of the entry holding the API key
  baseURL: string | null; // for openai-compatible / self-hosted endpoints
  // Configurable competitor names for the competitorMentions check.
  competitors: string[];
  // Free-text extra policy appended to every analysis prompt.
  customPolicy: string;
  input: GuardrailInputConfig;
  output: GuardrailDirectionConfig;
  onFailure: GuardrailFailureMode;
  external: GuardrailExternalConfig;
  factualGrounding: GuardrailGroundingConfig;
}

// What a factual-grounding trip does. `revise` gives the agent one more generation with the claims the
// reviewer pointed out, and the revised reply is the one sent; `template` and `handoff` use the Output
// direction's messages. `generated` and `silent` are not offered: the reviewer has no tools to write a
// correct answer with, and silence would leave the customer unanswered on a false positive.
export type GroundingAction = "observe" | "revise" | "template" | "handoff";
export const GROUNDING_ACTIONS: readonly GroundingAction[] = [
  "observe",
  "revise",
  "template",
  "handoff",
];

// The factual-grounding output check (./grounding.ts, docs/factual-grounding.md). It runs only on a
// turn in which one of `sourceTools` returned something. The reviewer is its own chat model when
// `provider` is set, and the guardrails chat model (provider, model, key) when it is null.
export interface GuardrailGroundingConfig {
  enabled: boolean;
  sourceTools: string[];
  // Knowledge bases of the tenant whose READY documents the reviewer reads whole on every reviewed
  // turn, as sources the agent did not have to consult (decimal ids, as the editor holds them).
  referenceKnowledgeBaseIds: string[];
  action: GroundingAction;
  contextMessages: number;
  provider: ModelConfig["provider"] | null;
  model: string;
  credentialRef: string | null;
  baseURL: string | null;
}

export const MAX_SOURCE_TOOLS = 50;
export const MAX_REFERENCE_KNOWLEDGE_BASES = 20;
const MAX_TOOL_NAME_LEN = 128;

// An endpoint the operator runs that judges a reply before it is delivered (./external.ts). Active
// when guardrails are on and `url` is set; a block fires the output direction's action.
export interface GuardrailExternalConfig {
  // An https URL, or null when there is no external check.
  url: string | null;
  // `vault:<id>` ref of the HMAC signing secret, or null to send the request unsigned.
  credentialRef: string | null;
  // Off sends each tool call's name and sizes without its arguments and result.
  sendToolValues: boolean;
}

const DEFAULT_TEMPLATE = "Desculpe, não consigo ajudar com isso.";
const DEFAULT_HANDOFF_MESSAGE =
  "Encaminhei seu atendimento para a nossa equipe. Uma pessoa vai continuar com você por aqui.";

const DEFAULT_THRESHOLDS: Record<GuardrailThresholdKey, number> =
  Object.fromEntries(
    GUARDRAIL_THRESHOLD_KEYS.map((k) => [k, DEFAULT_GUARDRAIL_THRESHOLD]),
  ) as Record<GuardrailThresholdKey, number>;

export const GUARDRAILS_DEFAULTS: GuardrailsConfig = {
  enabled: false,
  classifier: "chat",
  decisions: {
    provider: "typesafe",
    model: DEFAULT_DECISION_MODEL.typesafe,
    credentialRef: null,
    thresholds: DEFAULT_THRESHOLDS,
  },
  provider: "openai",
  model: "",
  credentialRef: null,
  baseURL: null,
  competitors: [],
  customPolicy: "",
  input: {
    enabled: true,
    checks: {
      toxicity: true,
      unsafeContent: true,
      competitorMentions: false,
      promptAdherence: false,
      answerRelevance: false,
    },
    action: "template",
    templateMessage: DEFAULT_TEMPLATE,
    generationPrompt: "",
    handoffMessage: DEFAULT_HANDOFF_MESSAGE,
    contextMessages: 0,
  },
  output: {
    enabled: true,
    checks: {
      toxicity: true,
      unsafeContent: true,
      competitorMentions: true,
      promptAdherence: true,
      answerRelevance: false,
    },
    action: "template",
    templateMessage: DEFAULT_TEMPLATE,
    generationPrompt: "",
    handoffMessage: DEFAULT_HANDOFF_MESSAGE,
  },
  onFailure: "pass",
  external: { url: null, credentialRef: null, sendToolValues: true },
  factualGrounding: {
    enabled: false,
    sourceTools: [],
    referenceKnowledgeBaseIds: [],
    action: "observe",
    contextMessages: 6,
    provider: null,
    model: "",
    credentialRef: null,
    baseURL: null,
  },
};

// The endpoint as stored, or null when it cannot be one: unparseable, not https, or carrying
// credentials in the URL itself (those belong in the vault). The write boundary refuses the same
// three by name (`isExternalCheckUrl`), so a stored value that fails here came from outside it.
export function isExternalCheckUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password;
}

function readExternal(v: unknown): GuardrailExternalConfig {
  const bag = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const url = str(bag.url);
  return {
    url: url && isExternalCheckUrl(url) ? url : null,
    credentialRef: str(bag.credentialRef),
    sendToolValues: bool(
      bag.sendToolValues,
      GUARDRAILS_DEFAULTS.external.sendToolValues,
    ),
  };
}

const MAX_COMPETITORS = 50;
const MAX_COMPETITOR_LEN = 100;

function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function readChecks(v: unknown, d: GuardrailChecks): GuardrailChecks {
  const b = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    toxicity: bool(b.toxicity, d.toxicity),
    unsafeContent: bool(b.unsafeContent, d.unsafeContent),
    competitorMentions: bool(b.competitorMentions, d.competitorMentions),
    promptAdherence: bool(b.promptAdherence, d.promptAdherence),
    answerRelevance: bool(b.answerRelevance, d.answerRelevance),
  };
}

function readAction(v: unknown): GuardrailAction {
  return typeof v === "string" &&
    GUARDRAIL_ACTIONS.includes(v as GuardrailAction)
    ? (v as GuardrailAction)
    : "template";
}

function readDirection(
  v: unknown,
  d: GuardrailDirectionConfig,
): GuardrailDirectionConfig {
  const b = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    enabled: bool(b.enabled, d.enabled),
    checks: readChecks(b.checks, d.checks),
    action: readAction(b.action),
    templateMessage: clipText(
      str(b.templateMessage) ?? d.templateMessage,
      TEMPLATE_MESSAGE_MAX,
    ),
    generationPrompt: clipText(
      str(b.generationPrompt) ?? d.generationPrompt,
      GENERATION_PROMPT_MAX,
    ),
    // A stored string is kept even when blank, unlike the template above: "" is the operator saying
    // "hand over without writing to the customer". Only an absent or non-string value takes the
    // default.
    handoffMessage:
      typeof b.handoffMessage === "string"
        ? clipText(b.handoffMessage.trim(), TEMPLATE_MESSAGE_MAX)
        : d.handoffMessage,
  };
}

function readInput(v: unknown): GuardrailInputConfig {
  const b = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    ...readDirection(v, GUARDRAILS_DEFAULTS.input),
    contextMessages: clampToRange(
      b.contextMessages,
      GUARDRAIL_RANGES.contextMessages,
      GUARDRAILS_DEFAULTS.input.contextMessages,
    ),
  };
}

// The competitor list as the check receives it, which is also what the editor counts.
export function readCompetitors(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s) out.push(clipText(s, MAX_COMPETITOR_LEN));
    if (out.length >= MAX_COMPETITORS) break;
  }
  return out;
}

// A threshold outside 0..1 is clamped, and anything not a finite number takes the default: the write
// boundary refuses both (settings-schema.ts), so this only meets a row that skipped it.
function readThresholds(v: unknown): Record<GuardrailThresholdKey, number> {
  const b = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of GUARDRAIL_THRESHOLD_KEYS) {
    const n = b[k];
    if (typeof n === "number" && Number.isFinite(n))
      out[k] = Math.min(Math.max(n, 0), 1);
  }
  return out;
}

function readDecisions(v: unknown): GuardrailDecisionsConfig {
  const b = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const raw = str(b.provider);
  const provider =
    raw && (DECISION_PROVIDERS as readonly string[]).includes(raw)
      ? (raw as DecisionProvider)
      : GUARDRAILS_DEFAULTS.decisions.provider;
  return {
    provider,
    model: str(b.model) ?? DEFAULT_DECISION_MODEL[provider],
    credentialRef: str(b.credentialRef),
    thresholds: readThresholds(b.thresholds),
  };
}

// The credential the guardrail screening actually uses: the chat model's, or the decisions
// provider's. One answer for the runtime and the configuration check, so the two cannot look at
// different fields.
export function guardrailCredentialRef(cfg: GuardrailsConfig): string | null {
  return cfg.classifier === "decisions"
    ? cfg.decisions.credentialRef
    : cfg.credentialRef;
}

// Trimmed, deduplicated tool names, bounded in count and length.
export function readSourceTools(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s && s.length <= MAX_TOOL_NAME_LEN && !out.includes(s)) out.push(s);
    if (out.length >= MAX_SOURCE_TOOLS) break;
  }
  return out;
}

// Decimal ids, deduplicated, bounded in count; anything else is dropped.
export function readReferenceKnowledgeBaseIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = typeof item === "number" ? String(item) : str(item);
    const id = parseDbId(s);
    if (id !== null && id > 0n && !out.includes(String(id)))
      out.push(String(id));
    if (out.length >= MAX_REFERENCE_KNOWLEDGE_BASES) break;
  }
  return out;
}

// Whether the check has anything to judge a reply against: a source tool, or a reference base.
export function groundingHasSources(fg: GuardrailGroundingConfig): boolean {
  return fg.sourceTools.length > 0 || fg.referenceKnowledgeBaseIds.length > 0;
}

function readGrounding(v: unknown): GuardrailGroundingConfig {
  const b = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const d = GUARDRAILS_DEFAULTS.factualGrounding;
  const rawProvider = str(b.provider);
  const provider =
    rawProvider && (MODEL_PROVIDERS as readonly string[]).includes(rawProvider)
      ? (rawProvider as ModelConfig["provider"])
      : null;
  return {
    enabled: bool(b.enabled, d.enabled),
    sourceTools: readSourceTools(b.sourceTools),
    referenceKnowledgeBaseIds: readReferenceKnowledgeBaseIds(
      b.referenceKnowledgeBaseIds,
    ),
    action: GROUNDING_ACTIONS.includes(b.action as GroundingAction)
      ? (b.action as GroundingAction)
      : d.action,
    contextMessages: clampToRange(
      b.contextMessages,
      GUARDRAIL_RANGES.contextMessages,
      d.contextMessages,
    ),
    // As stored: `resolveGroundingReviewer` decides what they mean, a model or a key without a
    // provider included (refused there, as every other model override refuses it).
    provider,
    model: str(b.model) ?? "",
    credentialRef: str(b.credentialRef),
    baseURL: str(b.baseURL),
  };
}

// The keys the reviewer may run on: its own credential's, and the guardrails chat model's (the model
// it inherits from). "" when a credential is not configured or did not resolve.
export interface GroundingReviewerKeys {
  ownKey: string;
  ownBaseUrl: string | null;
  parentKey: string;
  parentBaseUrl: string | null;
}

export type GroundingReviewerModel =
  | {
      runnable: true;
      provider: ModelConfig["provider"];
      model: string;
      baseURL: string | null;
      apiKey: string;
    }
  | {
      runnable: false;
      // `resolveModelOverride`'s refusal, or `credential_not_found` for a key that did not resolve.
      reason: string;
      provider: string;
      model: string;
    };

// The chat model that reviews a turn for grounding, as an override of the guardrails chat model
// (`resolveModelOverride`), exactly as the suggestion reviewer and the choice judge are of the
// agent's: nothing set inherits it whole, its own fields are inherited one by one while the
// destination is the same, a model or key without a provider is refused, and a keyless
// `openai-compatible` endpoint runs on no key at all, never on the guardrails one.
export function resolveGroundingReviewer(
  cfg: GuardrailsConfig,
  keys: GroundingReviewerKeys,
): GroundingReviewerModel {
  const fg = cfg.factualGrounding;
  const r = resolveModelOverride(
    {
      provider: fg.provider,
      model: fg.model,
      credentialRef: fg.credentialRef,
      baseURL: fg.baseURL,
    },
    {
      provider: cfg.provider,
      model: cfg.model,
      baseURL: keys.parentBaseUrl ?? cfg.baseURL,
    },
    { ownCredentialBaseURL: keys.ownBaseUrl },
  );
  if (!r.runnable)
    return {
      runnable: false,
      reason: r.reason ?? "unknown",
      provider: r.provider,
      model: r.model,
    };
  const apiKey =
    r.credential === "own"
      ? keys.ownKey
      : r.credential === "agent"
        ? keys.parentKey
        : "";
  // A key is missing only when a credential was configured and did not resolve. A guardrails model on
  // a keyless OpenAI-compatible endpoint has no key to inherit, and the reviewer that inherits it
  // runs keyless too, as the guardrails model does.
  const keylessParent =
    r.credential === "agent" &&
    !cfg.credentialRef &&
    r.provider === "openai-compatible";
  if (r.credential !== "none" && !apiKey && !keylessParent)
    return {
      runnable: false,
      reason: "credential_not_found",
      provider: r.provider,
      model: r.model,
    };
  return {
    runnable: true,
    provider: r.provider as ModelConfig["provider"],
    model: r.model,
    baseURL: r.baseURL,
    apiKey,
  };
}

export function readGuardrailsConfig(settings: unknown): GuardrailsConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).guardrails
      : undefined;
  if (!s || typeof s !== "object") return structuredClone(GUARDRAILS_DEFAULTS);
  const bag = s as Record<string, unknown>;
  const rawProvider = str(bag.provider);
  const provider =
    rawProvider && (MODEL_PROVIDERS as readonly string[]).includes(rawProvider)
      ? (rawProvider as ModelConfig["provider"])
      : GUARDRAILS_DEFAULTS.provider;
  return {
    enabled: bool(bag.enabled, GUARDRAILS_DEFAULTS.enabled),
    classifier: bag.classifier === "decisions" ? "decisions" : "chat",
    decisions: readDecisions(bag.decisions),
    provider,
    // NOTE: an empty model (saved when the operator enables guardrails without opening the provider
    // select) resolves to the provider default the editor displays; sent verbatim, the provider would
    // refuse it and the fail-open guardrail would screen nothing. Unlike the agent's own model (refused
    // empty at save), this is a supporting choice with a shown default, and a save-time refusal would
    // leave every already-saved empty value broken.
    model: str(bag.model) ?? PROVIDER_DEFAULT_MODEL[provider] ?? "",
    credentialRef: str(bag.credentialRef),
    baseURL: str(bag.baseURL),
    competitors: readCompetitors(bag.competitors),
    customPolicy: clipText(str(bag.customPolicy) ?? "", CUSTOM_POLICY_MAX),
    input: readInput(bag.input),
    output: readDirection(bag.output, GUARDRAILS_DEFAULTS.output),
    onFailure: bag.onFailure === "hold" ? "hold" : "pass",
    external: readExternal(bag.external),
    factualGrounding: readGrounding(bag.factualGrounding),
  };
}
