import { MODEL_PROVIDERS, type ModelConfig } from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import { clipText } from "@/lib/text";
import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
} from "@/modules/agents/text-caps";

// Per-agent guardrails (input/output moderation) config, read from `agent.settings.guardrails`. A
// dedicated LLM "guardrails agent" (its OWN selectable chat model, separate from the main agent's)
// analyzes the customer message (input) and/or the agent reply (output) against a set of standard
// checks; on a violation the configured PER-DIRECTION action fires (template reply / a guardrails-
// generated safe reply / stay silent). This reader is the single source of defaults + clamping, so a
// malformed value never breaks the webhook. Surfaced in the agent editor. Off by default.

export type GuardrailAction = "template" | "generated" | "silent";
export const GUARDRAIL_ACTIONS: readonly GuardrailAction[] = [
  "template",
  "generated",
  "silent",
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
  // reply, or stay silent (send nothing). Default "template".
  action: GuardrailAction;
  // The static reply used when action === "template".
  templateMessage: string;
  // Steering prompt for action === "generated": guides HOW the guardrails agent writes the
  // replacement reply (tone, what to offer, what to avoid). Empty → generic safe reply.
  generationPrompt: string;
}

export interface GuardrailsConfig {
  enabled: boolean;
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
  input: GuardrailDirectionConfig;
  output: GuardrailDirectionConfig;
}

const DEFAULT_TEMPLATE = "Desculpe, não consigo ajudar com isso.";

export const GUARDRAILS_DEFAULTS: GuardrailsConfig = {
  enabled: false,
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
  },
};

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
  };
}

function readCompetitors(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s) out.push(clipText(s, MAX_COMPETITOR_LEN));
    if (out.length >= MAX_COMPETITORS) break;
  }
  return out;
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
    provider,
    // NOTE: An empty model is stored by the editor whenever the operator enables guardrails without
    // opening the provider select, and the model field shows the provider default anyway. Sending it
    // through is not a soft failure: the name goes on the wire verbatim, the provider refuses the
    // call, and analyzeGuardrail fails open, so the guardrail reads as enabled and screens nothing.
    // Resolving it here is what makes the runtime send the model the editor displayed.
    //
    // The agent's own model answers the same question the other way (`guardModelBeforeSave` refuses
    // to save it empty), and the asymmetry is deliberate. That one is the operator's core choice and
    // has no defensible default; this one is a supporting choice whose default the editor already
    // shows. A save-time refusal here would also leave every already-saved empty value broken, and
    // those are exactly the installs running unprotected today.
    model: str(bag.model) ?? PROVIDER_DEFAULT_MODEL[provider] ?? "",
    credentialRef: str(bag.credentialRef),
    baseURL: str(bag.baseURL),
    competitors: readCompetitors(bag.competitors),
    customPolicy: clipText(str(bag.customPolicy) ?? "", CUSTOM_POLICY_MAX),
    input: readDirection(bag.input, GUARDRAILS_DEFAULTS.input),
    output: readDirection(bag.output, GUARDRAILS_DEFAULTS.output),
  };
}
