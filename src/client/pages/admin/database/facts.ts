import type { TFunction } from "i18next";
import type { SignalFacts } from "@/modules/instance-health/details";
import type { Formatters } from "./format";

type TimeoutFacts = Extract<SignalFacts, { kind: "timeout" }>;

// The line behind a signal's value, written here from the server's fields so it reads in the
// console's language with its figures formatted by the locale. The server's `detail` is the English
// line for the alert channel, REST and MCP, and is not shown.
function workText(w: TimeoutFacts["work"], t: TFunction): string {
  switch (w.kind) {
    case "job":
      return t("database.work.job", "job {{name}}", { name: w.name });
    case "request":
      return t("database.work.request", "request {{name}}", { name: w.name });
    case "worker":
      return t("database.work.worker", "worker {{name}}", { name: w.name });
    default:
      return w.pool
        ? t("database.work.nonePool", "work with no label (pool {{pool}})", {
            pool: w.pool,
          })
        : t("database.unlabeled", "unlabeled work");
  }
}

export function factsLine(
  f: SignalFacts,
  fmt: Formatters,
  t: TFunction,
): string {
  const onTable = f.table
    ? t("database.detail.onTable", "on {{table}}", { table: f.table })
    : null;
  if (f.kind === "drift") {
    const head = t(
      "database.detail.slowest",
      "Closest to its budget over the last hour: {{mean}} mean",
      { mean: fmt.ms(f.meanMs) },
    );
    const budget = t("database.budget", "budget {{budget}}", {
      budget: fmt.ms(f.budgetMs),
    });
    return [head, budget, onTable].filter(Boolean).join(", ");
  }
  const parts = [workText(f.work, t)];
  if (f.fleet) parts.push(t("database.detail.allTenants", "all tenants"));
  else if (f.tenantId !== null)
    parts.push(
      t("database.detail.tenant", "tenant {{id}}", { id: f.tenantId }),
    );
  if (f.budgetMs !== null)
    parts.push(
      t("database.budget", "budget {{budget}}", { budget: fmt.ms(f.budgetMs) }),
    );
  if (onTable) parts.push(onTable);
  return t("database.detail.lastTimeout", "Last timeout: {{parts}}", {
    parts: parts.join(", "),
  });
}
