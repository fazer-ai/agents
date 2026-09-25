import { z } from "zod";

// A TENANT'S OWN PRICES for model calls (issue #865), read from `tenant.settings.priceOverrides`.
//
// The price table (./model-prices.json) is public list prices, and a tenant does not always pay
// list: a negotiated discount, a model served through Azure or Bedrock, a regional uplift, or its own
// `openai-compatible` server, which the table can never price. An override names a provider and a
// model and the four rates the table would have given, and it is consulted FIRST when a ledger row is
// priced (./price.ts). It is also the correction that does not wait for a release when a list price
// changes under a table already deployed.
//
// Stored as a list, not a map keyed by model, because the key is a PAIR (provider and model) and a
// JSON object key would have to encode it. The list is short and read on every priced call, through
// the cache below.

export const PRICE_OVERRIDE_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "openrouter",
  "openai-compatible",
] as const;

export const PRICE_OVERRIDES_MAX = 100;
// Dollars per MILLION tokens. A rate above this is a typo (the most expensive list price today is a
// few hundred), and one that would silently make every total on the screen wrong.
export const PRICE_OVERRIDE_RATE_MAX = 10_000;

const rate = z.number().finite().min(0).max(PRICE_OVERRIDE_RATE_MAX);

export const priceOverrideSchema = z.object({
  provider: z.enum(PRICE_OVERRIDE_PROVIDERS),
  // Empty is a real model name for `openai-compatible`: a single-model server ignores the name it is
  // sent, and the ledger records "" for it (`modelOptionalFor`).
  model: z.string().trim().max(200),
  input: rate,
  output: rate,
  cachedInput: rate.optional(),
  cacheWrite: rate.optional(),
});
export type PriceOverride = z.infer<typeof priceOverrideSchema>;

export const priceOverridesSchema = z
  .array(priceOverrideSchema)
  .max(PRICE_OVERRIDES_MAX)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((o, i) => {
      // Only a single-model `openai-compatible` server is called with no model name; any other
      // provider's calls name one, so an empty model would match nothing and save a price that
      // never applies.
      if (o.model === "" && o.provider !== "openai-compatible")
        ctx.addIssue({
          code: "custom",
          path: [i, "model"],
          message: "a model name is required for this provider",
        });
      const key = overrideKey(o.provider, o.model);
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          path: [i, "model"],
          message: "duplicate provider and model",
        });
      seen.add(key);
    });
  });

export interface PriceOverridesBlock {
  overrides: PriceOverride[];
  // When the list was last saved. It is what a ledger row priced by an override records, so a price
  // corrected later can find exactly the rows the old one wrote.
  updatedAt: string | null;
}

function overrideKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

// The runtime's reader: lenient, like every settings reader, so a hand-edited bag with one bad entry
// still prices with the good ones. The write path is strict (the schema above).
export function readPriceOverrides(
  settings: Record<string, unknown>,
): PriceOverridesBlock {
  const block = settings.priceOverrides;
  if (typeof block !== "object" || block === null)
    return { overrides: [], updatedAt: null };
  const raw = (block as Record<string, unknown>).overrides;
  const updatedAt = (block as Record<string, unknown>).updatedAt;
  const overrides: PriceOverride[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const parsed = priceOverrideSchema.safeParse(entry);
    if (!parsed.success) continue;
    const key = overrideKey(parsed.data.provider, parsed.data.model);
    if (seen.has(key)) continue;
    seen.add(key);
    overrides.push(parsed.data);
  }
  return {
    overrides,
    updatedAt: typeof updatedAt === "string" ? updatedAt : null,
  };
}

// The image reader's registry names Google `gemini`; the model factory names it `google`. One
// override answers both, the way the table does.
function sameProvider(a: string, b: string): boolean {
  const norm = (p: string) => (p === "gemini" ? "google" : p);
  return norm(a) === norm(b);
}

export function findOverride(
  block: PriceOverridesBlock,
  provider: string,
  model: string,
): PriceOverride | null {
  return (
    block.overrides.find(
      (o) => sameProvider(o.provider, provider) && o.model === model,
    ) ?? null
  );
}

// What a row priced by an override records in `price_table`.
export function overridePriceTable(block: PriceOverridesBlock): string {
  return `tenant-override@${block.updatedAt ?? "unknown"}`;
}

// PER-TENANT CACHE, because a turn prices every call it makes and the list lives in the tenant's
// settings row. Single replica (docs/deploy.md), so the save below can clear it in process and a
// saved price applies from the next call; the TTL bounds a write that reached the row some other way.
const CACHE_TTL_MS = 60_000;
const cache = new Map<bigint, { at: number; block: PriceOverridesBlock }>();
// Bumped by every save. A read that started before a save finishes after it with the OLD list, and
// caching that would undo the save for a whole TTL; a fill is kept only if no save happened while
// it was in flight.
const generation = new Map<bigint, number>();

export async function cachedPriceOverrides(
  tenantId: bigint,
  load: () => Promise<PriceOverridesBlock>,
  now: number = Date.now(),
): Promise<PriceOverridesBlock> {
  const hit = cache.get(tenantId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.block;
  const startedAt = generation.get(tenantId) ?? 0;
  const block = await load();
  if ((generation.get(tenantId) ?? 0) === startedAt)
    cache.set(tenantId, { at: now, block });
  return block;
}

export function forgetPriceOverrides(tenantId: bigint): void {
  cache.delete(tenantId);
  generation.set(tenantId, (generation.get(tenantId) ?? 0) + 1);
}
