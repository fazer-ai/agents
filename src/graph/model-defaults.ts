// The model assumed when a provider that requires one was picked and no model was. Three places
// read it and they must agree, or the operator is told one thing and the runtime does another: the
// editor applies it when the provider select changes, the model picker shows it as the placeholder
// of an empty field, and the guardrails reader resolves an empty stored model through it.
//
// openai-compatible maps to "" on purpose. There, empty is a real choice (single-model servers
// ignore the requested name), which is why it is the only provider `modelConfigSchema` lets through
// empty. Everywhere else an empty model reaches the provider verbatim and the call is refused.
//
// Deliberately import-free: the client bundle reads this table too, and must not pull server code
// in to get it. Ids age with provider releases; revisit alongside DEFAULT_MODEL_CONFIG.
export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-3.5-flash",
  deepseek: "deepseek-chat",
  openrouter: "openai/gpt-5.4-mini",
  "openai-compatible": "",
};

// WHETHER AN EMPTY MODEL IS A REAL CHOICE FOR THIS PROVIDER, which is the same question the table
// above answers with `""` and the reason the two live together.
//
// Single-model servers (llama.cpp and friends) ignore the name they are sent, so `openai-compatible`
// is the one provider where naming nothing is a configuration rather than an omission — everywhere
// else an empty model reaches the vendor verbatim and the call is refused. The rule was written out
// inline in three places (`modelConfigSchema`, the editor's save guard, and this table's empty
// entry), which is the shape that grows an N+1: the fallback provider (#143) was written as
// "a provider AND a model, always", and an operator pointing a fallback at their own single-model
// server could not configure one at all without inventing a model name for a server that discards
// it. Review found it; there is one predicate now.
export function modelOptionalFor(provider: string): boolean {
  return provider === "openai-compatible";
}
