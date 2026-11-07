import { readChoiceCheckConfig } from "@/graph/tools/choice-check-settings";

// The Tools tab's choice-judge model block, stored settings → form state → stored settings, the same
// pair as the suggestion reviewer's (./knowledgeFormState). The block is written whole.

export interface ChoiceCheckState {
  provider: string;
  model: string;
  credentialRef: string;
  baseURL: string;
}

export function choiceCheckToForm(settings: unknown): ChoiceCheckState {
  const r = readChoiceCheckConfig(settings);
  return {
    provider: r.provider ?? "",
    model: r.model ?? "",
    credentialRef: r.credentialRef ?? "",
    baseURL: r.baseURL ?? "",
  };
}

export function choiceCheckToStored(form: ChoiceCheckState): {
  provider: string | null;
  model: string | null;
  credentialRef: string | null;
  baseURL: string | null;
} {
  return {
    provider: form.provider || null,
    model: form.model || null,
    credentialRef: form.credentialRef || null,
    baseURL: form.baseURL || null,
  };
}
