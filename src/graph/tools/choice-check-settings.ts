// The customer_choice judge's own model (`agent.settings.choiceCheck`), as an override of the agent's.
// Mirrors readKnowledgeConfig: all four absent (the default) judges on the agent's model and key.

import type { ModelOverride } from "@/graph/model-override";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function readChoiceCheckConfig(settings: unknown): ModelOverride {
  const bag =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).choiceCheck
      : null;
  const r =
    bag && typeof bag === "object" ? (bag as Record<string, unknown>) : {};
  return {
    provider: str(r.provider),
    model: str(r.model),
    credentialRef: str(r.credentialRef),
    baseURL: str(r.baseURL),
  };
}

export function choiceCheckOverridden(o: ModelOverride): boolean {
  return Boolean(o.provider || o.model || o.credentialRef || o.baseURL);
}
