// The local price table checked against Langfuse's, per model. Two independent tables disagreeing
// about a model means one is wrong or the tenant pays something neither knows. Computed at read time
// beside the card's Langfuse query: the spend ceiling's poll only runs while a ceiling is on and folds
// models into totals, so a check stored with its snapshot would exist for almost nobody.

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
  // Of those, the calls priced by this tenant's own price for the model, not by the table.
  ownPricedCalls?: number;
  costUsd: number;
}

// What Langfuse costed for one `providedModelName` over the same period and fence.
export interface LangfuseModelCost {
  model: string;
  costUsd: number;
}

// `match`: both figures agree within the thresholds. `diverges`: they do not. `incomplete`: some of
// the model's local calls have no price, so the local figure is a floor and comparing it would flag
// a gap the price table never claimed to cover. `own`: some were priced by the tenant's own price,
// which is what the card tells the operator to set, so judging it against Langfuse's table would keep
// flagging the model after the operator did exactly that.
export type CostComparisonStatus = "match" | "diverges" | "incomplete" | "own";

export interface CostComparison {
  // The ledger's name for the model (the id the agent is configured with). For a group of ledger
  // models compared together (see `compareModelCosts`), the first of `ledgerModels`.
  model: string;
  // Every ledger model this comparison covers, sorted: one, unless Langfuse reports a name that
  // could belong to more than one of them, in which case they are compared as a whole and
  // `localUsd`, `calls` and `localUnpricedCalls` are their sums.
  ledgerModels: string[];
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

// Which ledger model a Langfuse name is: exact first, else a ledger name plus a dated-snapshot suffix.
// The suffix is the common case: the Langfuse callback overwrites the generation's configured model id
// with the name the vendor answered with (OpenAI's dated snapshot), so one ledger model arrives under
// two Langfuse names and both are summed into it. A name that is both a ledger name and a snapshot of
// another is ambiguous; `compareModelCosts` compares the two as one group.
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
  ownPricedCalls = 0,
): CostComparisonStatus {
  if (pricedCalls < calls) return "incomplete";
  if (ownPricedCalls > 0) return "own";
  const gapCents = Math.round(Math.abs(localUsd - langfuseUsd) * 100);
  const largerCents = Math.round(Math.max(localUsd, langfuseUsd) * 100);
  if (gapCents < Math.round(COST_DIVERGENCE_FLOOR_USD * 100)) return "match";
  return gapCents / largerCents > COST_DIVERGENCE_RELATIVE
    ? "diverges"
    : "match";
}

// The ledger models a Langfuse name could belong to: its exact name, and the model it is a dated
// snapshot of. Two candidates make the name ambiguous.
function candidateLedgerModels(
  langfuseName: string,
  ledgerNames: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  if (ledgerNames.has(langfuseName)) out.push(langfuseName);
  const base = snapshotBase(langfuseName);
  if (base !== null && ledgerNames.has(base)) out.push(base);
  return out;
}

// One comparison per group of ledger models that Langfuse cannot tell apart. With both an alias and
// its dated snapshot configured, the alias's calls can reach Langfuse under the snapshot's name, so
// handing that figure to the exact match flags a split as a divergence. A name with more than one
// candidate joins them into one group (transitively), compared as sums on both sides.
export function compareModelCosts(
  local: readonly LocalModelCost[],
  langfuse: readonly LangfuseModelCost[],
): CostCheck {
  const ledgerNames = new Set(local.map((l) => l.model));
  const parent = new Map<string, string>();
  for (const n of ledgerNames) parent.set(n, n);
  const root = (n: string): string => {
    let r = n;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  for (const row of langfuse) {
    const [first, ...rest] = candidateLedgerModels(row.model, ledgerNames);
    if (first === undefined) continue;
    for (const other of rest) parent.set(root(other), root(first));
  }

  const matched = new Map<string, { names: string[]; usd: number }>();
  const onlyInLangfuse: string[] = [];
  for (const row of langfuse) {
    const ledger = matchLedgerModel(row.model, ledgerNames);
    if (ledger === null) {
      onlyInLangfuse.push(row.model);
      continue;
    }
    const group = root(ledger);
    const m = matched.get(group) ?? { names: [], usd: 0 };
    m.names.push(row.model);
    m.usd += row.costUsd;
    matched.set(group, m);
  }

  const groups = new Map<string, LocalModelCost[]>();
  for (const l of local) {
    const g = root(l.model);
    groups.set(g, [...(groups.get(g) ?? []), l]);
  }

  const models: CostComparison[] = [];
  const onlyLocal: string[] = [];
  for (const [group, rows] of groups) {
    const m = matched.get(group);
    if (!m) {
      onlyLocal.push(...rows.map((r) => r.model));
      continue;
    }
    const ledgerModels = rows.map((r) => r.model).sort();
    const localUsd = rows.reduce((a, r) => a + r.costUsd, 0);
    const calls = rows.reduce((a, r) => a + r.calls, 0);
    const pricedCalls = rows.reduce((a, r) => a + r.pricedCalls, 0);
    const ownPricedCalls = rows.reduce(
      (a, r) => a + (r.ownPricedCalls ?? 0),
      0,
    );
    models.push({
      model: ledgerModels[0] as string,
      ledgerModels,
      langfuseModels: m.names,
      localUsd,
      langfuseUsd: m.usd,
      calls,
      localUnpricedCalls: calls - pricedCalls,
      status: judgeCosts(localUsd, m.usd, calls, pricedCalls, ownPricedCalls),
    });
  }
  models.sort(
    (a, b) =>
      Math.max(b.localUsd, b.langfuseUsd) - Math.max(a.localUsd, a.langfuseUsd),
  );
  return { models, onlyInLangfuse, onlyLocal: onlyLocal.sort() };
}
