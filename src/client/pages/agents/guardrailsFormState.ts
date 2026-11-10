import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
} from "@/modules/agents/text-caps";
import {
  type GuardrailDirectionConfig,
  type GuardrailsConfig,
  groundingReviewer,
  guardrailCredentialRef,
  readGuardrailsConfig,
} from "@/modules/guardrails/settings";

// Whether the playground's "Run guardrails" toggle is usable: the same hard requirements the runtime
// has (modules/guardrails/gate), the feature switched on and its OWN credential. Under `hold` a
// missing credential still screens (every turn is held), so the operator has to be able to turn it
// off. A configured external check calls out on every turn, and so does a factual-grounding reviewer
// with its own key on a turn a source answered, so both need the switch. A direction
// being off is not checked here: the gate returns "not-run" for it at no cost.
export function playgroundGuardrailsUsable(g: GuardrailsConfig): boolean {
  return (
    g.enabled &&
    (!!guardrailCredentialRef(g) ||
      g.onFailure === "hold" ||
      !!g.external.url ||
      (g.factualGrounding.enabled &&
        g.factualGrounding.sourceTools.length > 0 &&
        groundingReviewerCalls(g)))
  );
}

// Whether the reviewer can call out: it has a key, or it is an `openai-compatible` endpoint that the
// operator left keyless on purpose (the runtime sends a placeholder key there).
function groundingReviewerCalls(g: GuardrailsConfig): boolean {
  const r = groundingReviewer(g);
  return (
    !!r.credentialRef || (r.provider === "openai-compatible" && !!r.baseURL)
  );
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
