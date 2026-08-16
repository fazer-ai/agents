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
