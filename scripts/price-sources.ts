// The two reads the price table is built from, as pure functions over what each source answered.
// Import-free for the same reason as refresh-guard.ts: the refresh regenerates the table, so nothing
// here may depend on it.
//
// OpenRouter's rows come from OpenRouter's own models API: LiteLLM's table has carried no OpenRouter
// row since 2026-10-09, and its sync of them is off. Every other provider still
// comes from LiteLLM, and a LiteLLM row that names OpenRouter is ignored, so `openrouter/` keys have
// one source.

export const OPENROUTER_PREFIX = "openrouter/";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// LiteLLM's provider name → ours.
const LITELLM_PROVIDERS: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  deepseek: "deepseek",
};

export type Rates = {
  input: number;
  cachedInput?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  output: number;
};
export type Entry = Rates & { tiers?: (Rates & { above: number })[] };

// USD per token → USD per million tokens, rounded so float noise does not show up as a price change.
// OpenRouter states its rates as decimal strings, LiteLLM as numbers; a negative rate is OpenRouter's
// "decided per request" (its routers) and is no price.
function perMillion(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.round(n * 1e6 * 1e6) / 1e6
    : undefined;
}

function withOptional(r: Rates, extra: Omit<Rates, "input" | "output">) {
  for (const [k, v] of Object.entries(extra) as [keyof Rates, unknown][]) {
    if (v !== undefined) (r as Record<string, unknown>)[k] = v;
  }
  return r;
}

function litellmRates(e: Record<string, unknown>, suffix: string) {
  const input = perMillion(e[`input_cost_per_token${suffix}`]);
  const output = perMillion(e[`output_cost_per_token${suffix}`]);
  if (input === undefined || output === undefined) return null;
  // NOTE: LiteLLM states the 1-hour write only at the base tier; a row without it is priced at 2x
  // input (`cacheWrite1hRate` in src/modules/pricing/price.ts).
  return withOptional(
    { input, output },
    {
      cachedInput: perMillion(e[`cache_read_input_token_cost${suffix}`]),
      cacheWrite: perMillion(e[`cache_creation_input_token_cost${suffix}`]),
      cacheWrite1h:
        suffix === ""
          ? perMillion(e.cache_creation_input_token_cost_above_1hr)
          : undefined,
    },
  );
}

// LiteLLM's chat models of the providers the model factory speaks to, OpenRouter excepted. A rate
// above a context threshold (OpenAI's >272K, Gemini's >200K) is kept as a tier.
export function litellmModels(table: unknown): Record<string, Entry> {
  const models: Record<string, Entry> = {};
  if (typeof table !== "object" || table === null) return models;
  for (const [key, e] of Object.entries(table as Record<string, unknown>)) {
    if (typeof e !== "object" || e === null) continue;
    const row = e as Record<string, unknown>;
    if (row.mode !== "chat" && row.mode !== "responses") continue;
    if (
      typeof row.litellm_provider !== "string" ||
      !(row.litellm_provider in LITELLM_PROVIDERS)
    )
      continue;
    const base = litellmRates(row, "");
    if (!base) continue;
    const thresholds = new Set<number>();
    for (const k of Object.keys(row)) {
      const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(k);
      if (m) thresholds.add(Number(m[1]) * 1000);
    }
    const tiers = [...thresholds]
      .sort((a, b) => a - b)
      .flatMap((above) => {
        const r = litellmRates(row, `_above_${above / 1000}k_tokens`);
        return r ? [{ above, ...r }] : [];
      });
    models[key] = tiers.length > 0 ? { ...base, tiers } : base;
  }
  return models;
}

function openrouterRates(p: Record<string, unknown>) {
  const input = perMillion(p.prompt);
  const output = perMillion(p.completion);
  if (input === undefined || output === undefined) return null;
  return withOptional(
    { input, output },
    {
      cachedInput: perMillion(p.input_cache_read),
      cacheWrite: perMillion(p.input_cache_write),
      cacheWrite1h: perMillion(p.input_cache_write_1h),
    },
  );
}

// Every model OpenRouter lists with a price, under `openrouter/<its id>`, the key the runtime looks
// an OpenRouter call up by. Of `pricing.overrides`, only a long-context tier (`min_prompt_tokens`
// and no time window) is kept, applying above `min_prompt_tokens` as the vendors state it ("over
// 200K tokens"). A time-window override (`utc_*`) is a discount the base rate already bounds from
// above.
export function openrouterModels(body: unknown): Record<string, Entry> {
  const models: Record<string, Entry> = {};
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return models;
  for (const m of data as { id?: unknown; pricing?: unknown }[]) {
    if (typeof m?.id !== "string" || typeof m.pricing !== "object") continue;
    const pricing = m.pricing as Record<string, unknown> | null;
    if (!pricing) continue;
    const base = openrouterRates(pricing);
    if (!base) continue;
    const overrides = Array.isArray(pricing.overrides) ? pricing.overrides : [];
    const tiers = (overrides as Record<string, unknown>[])
      .flatMap((o) => {
        const min = o?.min_prompt_tokens;
        if (typeof min !== "number" || !Number.isInteger(min) || min < 1)
          return [];
        if (Object.keys(o).some((k) => k.startsWith("utc_"))) return [];
        const r = openrouterRates({ ...pricing, ...o });
        return r ? [{ above: min, ...r }] : [];
      })
      .sort((a, b) => a.above - b.above);
    models[`${OPENROUTER_PREFIX}${m.id}`] =
      tiers.length > 0 ? { ...base, tiers } : base;
  }
  return models;
}

// How many rows each source holds in a table, so a broken read of one source is told apart from a
// real change in the other.
export function countBySource(models: Record<string, unknown>) {
  let openrouter = 0;
  for (const k of Object.keys(models))
    if (k.startsWith(OPENROUTER_PREFIX)) openrouter++;
  return { litellm: Object.keys(models).length - openrouter, openrouter };
}

// The identity of an OpenRouter read: its API has no version, so the rows themselves are hashed.
export function rowsHash(models: Record<string, Entry>): string {
  const sorted = Object.keys(models)
    .sort()
    .map((k) => [k, models[k]]);
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex");
}
