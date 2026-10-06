import { readKnowledgeConfig } from "@/modules/rag/review-settings";

// The Knowledge tab's reviewer-model block, as a pair of pure functions: stored settings → form state
// → stored settings. Same shape and reason as the summariser's pair (./memoryFormState): the save
// REPLACES the whole `knowledge` block, so a field the form does not carry is deleted on the next save.

export interface SuggestionReviewState {
  provider: string;
  model: string;
  credentialRef: string;
  baseURL: string;
}

export function suggestionReviewToForm(
  settings: unknown,
): SuggestionReviewState {
  const r = readKnowledgeConfig(settings).suggestionReview;
  return {
    provider: r.provider ?? "",
    model: r.model ?? "",
    credentialRef: r.credentialRef ?? "",
    baseURL: r.baseURL ?? "",
  };
}

export function suggestionReviewToStored(form: SuggestionReviewState): {
  suggestionReview: {
    provider: string | null;
    model: string | null;
    credentialRef: string | null;
    baseURL: string | null;
  };
} {
  return {
    suggestionReview: {
      provider: form.provider || null,
      model: form.model || null,
      credentialRef: form.credentialRef || null,
      baseURL: form.baseURL || null,
    },
  };
}
