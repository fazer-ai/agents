// Affiliate/referral links: signing up through these helps fund fazer.ai, so they render with the
// "create one through our link to help us out" copy. Keyed by the secret-type `kind` id.
export const AFFILIATE_LINKS: Record<string, string> = {
  asaas: "https://www.asaas.com/r/5ec90fd5-677d-40c7-b577-cc1f6de62fec",
  elevenlabs: "https://try.elevenlabs.io/fazer-ai-agents-cli",
};

// Direct "get your API key" pages for named providers. These are NOT referral links, so they render
// with neutral copy (never the affiliate "help us out" wording). Keyed by the secret-type `kind` id.
export const PROVIDER_KEY_LINKS: Record<string, string> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
  deepseek: "https://platform.deepseek.com/api_keys",
  openrouter: "https://openrouter.ai/keys",
  typesafe: "https://console.typesafe.ai/keys",
};

export type ProviderLink = { href: string; kind: "affiliate" | "direct" };

// Resolve the help link for a secret type. An affiliate link wins when one exists (asaas/elevenlabs
// are referral-only); otherwise a direct provider key page, shown with neutral copy.
export function providerLink(kind: string): ProviderLink | undefined {
  const affiliate = AFFILIATE_LINKS[kind];
  if (affiliate) return { href: affiliate, kind: "affiliate" };
  const direct = PROVIDER_KEY_LINKS[kind];
  if (direct) return { href: direct, kind: "direct" };
  return undefined;
}
