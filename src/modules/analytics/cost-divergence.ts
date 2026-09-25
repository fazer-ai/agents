// THE LOCAL PRICE TABLE CHECKED AGAINST LANGFUSE'S, PER MODEL (issue #868).
//
// `llm_usage.cost_usd` is priced when a row is written, from a pinned copy of a public price table
// (issue #863), and that copy goes stale without anything noticing. Langfuse prices the same calls
// from a table of its own. Two independent tables disagreeing about a model is the signal that one of
// them is wrong, or that the tenant pays something neither knows, so the dashboard's "Cost by model"
// card puts the two side by side and flags a model where they part.
//
// Computed at READ time, beside the Langfuse query the card already makes, with that query's tenant,
// period and environments: the spend ceiling's poll also reads Langfuse per model, but it only runs
// while a ceiling is on and folds the models into totals, so a check stored with its snapshot would
// exist for almost nobody. Nothing here corrects anything: it names the model and both figures, and
// what to do about it is the operator's call.

// A model is flagged only when the two figures part by MORE than this fraction of the larger one...
export const COST_DIVERGENCE_RELATIVE = 0.2;
// ...AND by at least this many dollars, so a model that cost two cents cannot raise an alarm by
// being off by one: at small figures a relative gap is rounding and ingestion lag, not a wrong price.
export const COST_DIVERGENCE_FLOOR_USD = 1;

// What the local ledger summed for one model over the period.
export interface LocalModelCost {
  model: string;
  calls: number;
  // Calls whose row carried a price; the rest are null in `cost_usd` and are not in `costUsd`.
  pricedCalls: number;
  costUsd: number;
}

// What Langfuse costed for one `providedModelName` over the same period and fence.
export interface LangfuseModelCost {
  model: string;
  costUsd: number;
}

// `match`: both figures agree within the thresholds. `diverges`: they do not. `incomplete`: some of
// the model's local calls have no price, so the local figure is a floor and comparing it would flag
// a gap the price table never claimed to cover; it is neither a pass nor a divergence.
export type CostComparisonStatus = "match" | "diverges" | "incomplete";

export interface CostComparison {
  // The ledger's name for the model (the id the agent is configured with).
  model: string;
  // Every Langfuse name that matched it, summed into `langfuseUsd`.
  langfuseModels: string[];
  localUsd: number;
  langfuseUsd: number;
  calls: number;
  localUnpricedCalls: number;
  status: CostComparisonStatus;
}

export interface CostCheck {
  models: CostComparison[];
  // Names one side has and the other does not: not compared, and never a divergence, since there is
  // no second figure to disagree with.
  onlyInLangfuse: string[];
  onlyLocal: string[];
}

// A vendor's dated snapshot of a model: `gpt-4o-2024-08-06`, `claude-sonnet-4-20250514`, or Vertex's
// `claude-3-5-sonnet-v2@20241022`.
const SNAPSHOT_SUFFIX = /(?:-\d{4}-\d{2}-\d{2}|-\d{8}|@.+)$/;

// The name without its dated-snapshot suffix, or null when it carries none.
export function snapshotBase(name: string): string | null {
  const m = SNAPSHOT_SUFFIX.exec(name);
  if (!m || m.index === 0) return null;
  return name.replace(SNAPSHOT_SUFFIX, "");
}

// WHICH LEDGER MODEL A LANGFUSE NAME IS. Exact first; else a Langfuse name that is a ledger name plus
// a dated-snapshot suffix.
//
// The suffix is the common case, not an edge. Measured in `langfuse-langchain@3.38.20`
// (`lib/index.mjs`): `handleGenerationStart` writes the generation's `model` from
// `invocation_params.model`, falling back to `metadata.ls_model_name`, which is the configured id the
// ledger also stores; `handleLLMEnd` then updates the same generation with
// `response_metadata.model_name`, the name the VENDOR answered with, which OpenAI gives as the dated
// snapshot (`gpt-5.4-mini-2026-03-17`, measured in `src/graph/usage.ts`). An update whose value is
// undefined is dropped on serialize, so a response that carries no model name keeps the configured
// id. `providedModelName` is that final value. A call we trace by hand
// (`recordDirectGeneration`) carries the ledger's own name. So one ledger model can arrive as two
// Langfuse names, and both are summed into it.
export function matchLedgerModel(
  langfuseName: string,
  ledgerNames: ReadonlySet<string>,
): string | null {
  if (ledgerNames.has(langfuseName)) return langfuseName;
  const base = snapshotBase(langfuseName);
  return base !== null && ledgerNames.has(base) ? base : null;
}

// The verdict for one matched model. Money is compared in cents, the way the ceiling compares it
// (`decideSpend`): `1.1 - 0.1` is not `1` to a double.
export function judgeCosts(
  localUsd: number,
  langfuseUsd: number,
  calls: number,
  pricedCalls: number,
): CostComparisonStatus {
  if (pricedCalls < calls) return "incomplete";
  const gapCents = Math.round(Math.abs(localUsd - langfuseUsd) * 100);
  const largerCents = Math.round(Math.max(localUsd, langfuseUsd) * 100);
  if (gapCents < Math.round(COST_DIVERGENCE_FLOOR_USD * 100)) return "match";
  return gapCents / largerCents > COST_DIVERGENCE_RELATIVE
    ? "diverges"
    : "match";
}

export function compareModelCosts(
  local: readonly LocalModelCost[],
  langfuse: readonly LangfuseModelCost[],
): CostCheck {
  const ledgerNames = new Set(local.map((l) => l.model));
  const matched = new Map<string, { names: string[]; usd: number }>();
  const onlyInLangfuse: string[] = [];
  for (const row of langfuse) {
    const ledger = matchLedgerModel(row.model, ledgerNames);
    if (ledger === null) {
      onlyInLangfuse.push(row.model);
      continue;
    }
    const m = matched.get(ledger) ?? { names: [], usd: 0 };
    m.names.push(row.model);
    m.usd += row.costUsd;
    matched.set(ledger, m);
  }
  const models: CostComparison[] = [];
  const onlyLocal: string[] = [];
  for (const l of local) {
    const m = matched.get(l.model);
    if (!m) {
      onlyLocal.push(l.model);
      continue;
    }
    models.push({
      model: l.model,
      langfuseModels: m.names,
      localUsd: l.costUsd,
      langfuseUsd: m.usd,
      calls: l.calls,
      localUnpricedCalls: l.calls - l.pricedCalls,
      status: judgeCosts(l.costUsd, m.usd, l.calls, l.pricedCalls),
    });
  }
  models.sort(
    (a, b) =>
      Math.max(b.localUsd, b.langfuseUsd) - Math.max(a.localUsd, a.langfuseUsd),
  );
  return { models, onlyInLangfuse, onlyLocal: onlyLocal.sort() };
}
