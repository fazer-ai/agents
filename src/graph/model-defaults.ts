// The model assumed when a provider that requires one was picked and no model was. The editor (on a
// provider change), the model picker (as an empty field's placeholder) and the guardrails reader (for
// an empty stored model) must agree, or the operator is told one thing and the runtime does another.
// openai-compatible maps to "" on purpose: single-model servers ignore the requested name, so empty
// is a real choice there. Import-free: the client bundle reads this table and must not pull server
// code in. Ids age with provider releases; revisit alongside DEFAULT_MODEL_CONFIG.
export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-3.5-flash",
  deepseek: "deepseek-chat",
  openrouter: "openai/gpt-5.6-luna",
  "openai-compatible": "",
};

// Whether an empty model is a real choice for this provider, the question the table above answers
// with `""`. Single-model servers (llama.cpp and friends) ignore the name they are sent, so for
// `openai-compatible` naming nothing is a configuration; elsewhere an empty model reaches the vendor
// verbatim and is refused. The one predicate `modelConfigSchema`, the editor's save guard and the
// fallback settings share, so none of them demands a model a single-model server would discard.
export function modelOptionalFor(provider: string): boolean {
  return provider === "openai-compatible";
}
