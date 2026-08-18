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
// prose put back the way it is stored.
//
// The reader clips that prose so a row written before the caps existed (or over REST) cannot push
// 3000 characters into the analysis prompt. Hydrating the editor through it is what made a legacy row
// unfixable: the field arrived AT the cap, so the counter read clean, while every save on every tab
// was refused naming a field that looked fine on screen. Every other block already hydrates the bag
// raw (readBehaviorState reads it with str()); this puts guardrails on the same footing, so the
// counter shows the overage and the refusal points at something the operator can act on.
//
// Only the values that are actually over the cap are restored: below it the reader returns the same
// text, and taking its output wholesale would un-trim every ordinary field.
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
