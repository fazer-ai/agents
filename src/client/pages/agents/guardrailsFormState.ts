import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
} from "@/modules/agents/text-caps";
import {
  type GuardrailDirectionConfig,
  type GuardrailsConfig,
  groundingHasSources,
  guardrailCredentialRef,
  readGuardrailsConfig,
} from "@/modules/guardrails/settings";
import { overrideResolution } from "./modelOverrideForm";

// Whether the playground's "Run guardrails" toggle is usable: the same hard requirements the runtime
// has (modules/guardrails/gate), the feature switched on and its OWN credential. Under `hold` a
// missing credential still screens (every turn is held), so the operator has to be able to turn it
// off. A configured external check calls out on every turn, and so does a factual-grounding reviewer
// with its own key on a turn a source answered, so both need the switch. A direction
// being off is not checked here: the gate returns "not-run" for it at no cost.
// `credBaseUrls` are the endpoints the vault holds on the guardrails credential and on the reviewer's
// own one, which outrank the typed fields exactly as they do at runtime.
export function playgroundGuardrailsUsable(
  g: GuardrailsConfig,
  credBaseUrls: GroundingCredBaseUrls = NO_CRED_BASE_URLS,
): boolean {
  return (
    g.enabled &&
    (!!guardrailCredentialRef(g) ||
      g.onFailure === "hold" ||
      !!g.external.url ||
      (g.factualGrounding.enabled &&
        groundingHasSources(g.factualGrounding) &&
        groundingReviewerCalls(g, credBaseUrls)))
  );
}

// Whether the reviewer can call out: its override of the guardrails chat model resolves, with a key
// to run on (its own, the guardrails one at the same destination) or none needed (a keyless
// OpenAI-compatible endpoint). The same resolution the runtime makes.
export interface GroundingCredBaseUrls {
  guardrails: string | null;
  grounding: string | null;
}

const NO_CRED_BASE_URLS: GroundingCredBaseUrls = {
  guardrails: null,
  grounding: null,
};

function groundingReviewerCalls(
  g: GuardrailsConfig,
  credBaseUrls: GroundingCredBaseUrls,
): boolean {
  const fg = g.factualGrounding;
  const r = overrideResolution(
    {
      provider: fg.provider ?? "",
      model: fg.model,
      credentialRef: fg.credentialRef ?? "",
      baseURL: fg.baseURL ?? "",
    },
    {
      provider: g.provider,
      credentialRef: g.credentialRef ?? "",
      baseURL: credBaseUrls.guardrails ?? g.baseURL ?? "",
    },
    credBaseUrls.grounding,
  );
  if (!r.runnable) return false;
  // Inheriting the guardrails key needs one, unless that model is a keyless OpenAI-compatible
  // endpoint (resolveGroundingReviewer).
  return r.credential === "agent"
    ? !!g.credentialRef || r.provider === "openai-compatible"
    : true;
}

// The agent editor's view of the stored `guardrails` block: the runtime reader, with the capped
// prose put back the way it is stored. The reader clips over-cap prose (a legacy or REST row) for
// the analysis prompt; hydrating the editor with the clipped text would show a clean counter while
// every save is refused on that field. Only values actually over the cap are restored: below it the
// reader's text is kept, since the raw value wholesale would un-trim every ordinary field.
function raw(stored: unknown, read: string, max: number): string {
  return typeof stored === "string" && stored.length > max ? stored : read;
}

function direction<D extends GuardrailDirectionConfig>(
  stored: unknown,
  read: D,
): D {
  const bag =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {};
  return {
    ...read,
    templateMessage: raw(
      bag.templateMessage,
      read.templateMessage,
      TEMPLATE_MESSAGE_MAX,
    ),
    generationPrompt: raw(
      bag.generationPrompt,
      read.generationPrompt,
      GENERATION_PROMPT_MAX,
    ),
    handoffMessage: raw(
      bag.handoffMessage,
      read.handoffMessage,
      TEMPLATE_MESSAGE_MAX,
    ),
  };
}

export function readGuardrailsFormState(settings: unknown): GuardrailsConfig {
  const read = readGuardrailsConfig(settings);
  const block =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).guardrails
      : undefined;
  if (!block || typeof block !== "object") return read;
  const bag = block as Record<string, unknown>;
  return {
    ...read,
    customPolicy: raw(bag.customPolicy, read.customPolicy, CUSTOM_POLICY_MAX),
    input: direction(bag.input, read.input),
    output: direction(bag.output, read.output),
  };
}
