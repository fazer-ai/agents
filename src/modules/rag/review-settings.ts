// Per-agent knowledge settings, read from `agent.settings.knowledge` (Json, additive). Mirrors
// readMemoryConfig: the suggestion reviewer runs on the agent's model unless an override names one.

import type { ModelOverride } from "@/graph/model-override";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export interface KnowledgeConfig {
  suggestionReview: ModelOverride;
}

export function readKnowledgeConfig(settings: unknown): KnowledgeConfig {
  const empty: KnowledgeConfig = {
    suggestionReview: {
      provider: null,
      model: null,
      credentialRef: null,
      baseURL: null,
    },
  };
  if (!settings || typeof settings !== "object") return empty;
  const k = (settings as Record<string, unknown>).knowledge;
  if (!k || typeof k !== "object") return empty;
  const r = (k as Record<string, unknown>).suggestionReview;
  if (!r || typeof r !== "object") return empty;
  const bag = r as Record<string, unknown>;
  return {
    suggestionReview: {
      provider: str(bag.provider),
      model: str(bag.model),
      credentialRef: str(bag.credentialRef),
      baseURL: str(bag.baseURL),
    },
  };
}
