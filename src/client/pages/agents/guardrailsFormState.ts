import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
} from "@/modules/agents/text-caps";
import {
  type GuardrailDirectionConfig,
  type GuardrailsConfig,
  readGuardrailsConfig,
} from "@/modules/guardrails/settings";

// The agent editor's view of the stored `guardrails` block: the runtime reader, with the capped
// prose put back the way it is stored. The reader clips over-cap prose (a legacy or REST row) for
// the analysis prompt; hydrating the editor with the clipped text would show a clean counter while
// every save is refused on that field. Only values actually over the cap are restored: below it the
// reader's text is kept, since the raw value wholesale would un-trim every ordinary field.
function raw(stored: unknown, read: string, max: number): string {
  return typeof stored === "string" && stored.length > max ? stored : read;
}

function direction(
  stored: unknown,
  read: GuardrailDirectionConfig,
): GuardrailDirectionConfig {
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
