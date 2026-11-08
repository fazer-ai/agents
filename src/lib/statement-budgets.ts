import config from "@/config";

// THE BUDGET A STATEMENT RAN UNDER, by the pool that sent it (docs/logs.md, "Database"). The console's
// reads run on the metrics pool under METRICS_TIMEOUT_MS and take seconds on a large tenant; the rest
// runs under DB_TX_TIMEOUT_MS. pg_stat_statements keeps neither the pool nor the budget, so the
// instrumented pools note here the texts they send, and the snapshot stores each text's class beside
// it, where the drift signal and the screen read it. A text this process saw on any other pool is
// 'default': the smaller budget wins, so no statement gets the metrics budget by omission.

export type BudgetClass = "metrics" | "default";

const METRICS_POOL = "metrics";
// Bounds the memory: distinct statement texts, kept by the most recent use.
const MAX_TEXTS = 5000;

const KEY = Symbol.for("fazerai.statementBudgets");

interface Registry {
  // Canonical text -> whether every time this process saw it, it came from the metrics pool.
  texts: Map<string, BudgetClass>;
  // Raw text -> canonical text, so the hot path does not normalize the same string twice.
  canonical: Map<string, string>;
}

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  g[KEY] ??= { texts: new Map(), canonical: new Map() };
  return g[KEY];
}

// The text as pg_stat_statements stores it, reduced to what both sides agree on: literals and
// placeholders become `?` (the server replaces constants with `$N` and renumbers them), and runs of
// whitespace become one space.
export function canonicalStatement(text: string): string {
  return text
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalOf(text: string): string {
  const r = registry();
  let c = r.canonical.get(text);
  if (c === undefined) {
    c = canonicalStatement(text);
    if (r.canonical.size >= MAX_TEXTS) r.canonical.clear();
    r.canonical.set(text, c);
  }
  return c;
}

// Called by the instrumented pool for every statement it sends.
export function noteStatementPool(pool: string, text: string): void {
  const r = registry();
  if (pool !== METRICS_POOL && r.texts.size === 0) return;
  const c = canonicalOf(text);
  const seen = r.texts.get(c);
  if (pool === METRICS_POOL) {
    if (seen !== undefined) {
      r.texts.delete(c);
      r.texts.set(c, seen);
      return;
    }
    if (r.texts.size >= MAX_TEXTS) {
      const oldest = r.texts.keys().next().value;
      if (oldest !== undefined) r.texts.delete(oldest);
    }
    r.texts.set(c, "metrics");
  } else if (seen === "metrics") {
    r.texts.set(c, "default");
  }
}

// The class this process knows for a stored text; null when it never saw it sent.
export function budgetClassOf(text: string): BudgetClass | null {
  return registry().texts.get(canonicalOf(text)) ?? null;
}

export interface StatementBudgets {
  tx: number;
  metrics: number;
}

// The budget a class ran under; an unknown class is the transaction budget.
export function budgetOfClass(
  cls: string | null,
  budgets: StatementBudgets = statementBudgets(),
): number {
  return cls === "metrics" ? budgets.metrics : budgets.tx;
}

export function statementBudgets(): StatementBudgets {
  return { tx: config.dbTx.timeoutMs, metrics: config.metrics.timeoutMs };
}

export function resetStatementBudgetsForTest(): void {
  const r = registry();
  r.texts.clear();
  r.canonical.clear();
}
