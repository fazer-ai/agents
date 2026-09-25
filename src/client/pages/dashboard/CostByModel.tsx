import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card } from "@/client/components";
import { Popover } from "@/client/components/Popover";
import type { api } from "@/client/lib/api";
import {
  COST_DIVERGENCE_FLOOR_USD,
  COST_DIVERGENCE_RELATIVE,
} from "@/modules/analytics/cost-divergence";

// Derived from the Eden treaty, never hand-declared (docs/eden-treaty.md).
type CostsData = Awaited<
  ReturnType<typeof api.api.v1.metrics.costs.get>
>["data"];
type OkCosts = Extract<NonNullable<CostsData>["costs"], { status: "ok" }>;
type CostRow = OkCosts["byModel"][number];
type CostCheck = NonNullable<OkCosts["costCheck"]>;
type Comparison = CostCheck["models"][number];

function usd(locale: string, v: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(v);
}

// The marker beside a model whose two figures part (issue #868), with both figures and what to do in
// a popover rather than a tooltip: it is read, and read on a phone as much as at a desk (Popover.tsx).
function DivergenceMarker({ c }: { c: Comparison }) {
  const { t, i18n } = useTranslation();
  const pct = Math.round(COST_DIVERGENCE_RELATIVE * 100);
  const floor = usd(i18n.language, COST_DIVERGENCE_FLOOR_USD);
  // NOTE: a group (issue #868 review) is several ledger models Langfuse cannot tell apart, compared as one.
  const model = c.ledgerModels.join(", ");
  const grouped = c.ledgerModels.length > 1;
  const renamed = c.langfuseModels.some((n) => !c.ledgerModels.includes(n));
  return (
    <Popover
      label={t("dashboard.costCheck.detailLabel", "Cost check for {{model}}", {
        model,
      })}
      side="top"
      align="end"
      content={
        <div className="space-y-3" data-testid="cost-divergence-detail">
          <p className="font-semibold">
            {t(
              "dashboard.costCheck.title",
              "Langfuse and this app disagree on what {{model}} cost",
              { model },
            )}
          </p>
          <div className="space-y-1 tabular-nums">
            <div className="flex justify-between gap-6">
              <span className="text-text-muted">
                {t("dashboard.costCheck.langfuse", "Langfuse's figure")}
              </span>
              <span>{usd(i18n.language, c.langfuseUsd)}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-text-muted">
                {t("dashboard.costCheck.local", "This app's figure")}
              </span>
              <span>{usd(i18n.language, c.localUsd)}</span>
            </div>
          </div>
          {grouped && (
            <p className="text-text-muted text-xs">
              {t(
                "dashboard.costCheck.grouped",
                "Langfuse can report calls to {{models}} under one name, so they are compared together, as their sum.",
                { models: model },
              )}
            </p>
          )}
          {renamed && (
            <p className="text-text-muted text-xs">
              {t("dashboard.costCheck.names", "Langfuse names it {{names}}.", {
                names: c.langfuseModels.join(", "),
              })}
            </p>
          )}
          <p>
            {t(
              "dashboard.costCheck.why",
              "They differ by more than {{pct}}% and by at least {{floor}}. One of the two price tables may be out of date, or this account pays a price neither of them knows.",
              { pct, floor },
            )}
          </p>
          <p>
            {t(
              "dashboard.costCheck.whatToDo",
              "Check the price on the vendor's own page. If this account pays a different price, set this account's own price for the model. If this app's table is the one that is wrong, the calls it priced can be re-priced once it is corrected.",
            )}
          </p>
        </div>
      }
    >
      <button
        type="button"
        data-testid="cost-divergence-marker"
        aria-label={t(
          "dashboard.costCheck.markerLabel",
          "Cost differs from this app's price table",
        )}
        className="inline-flex rounded text-warning"
      >
        <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Popover>
  );
}

// "Cost by model" as Langfuse costed it, with the local price table's figure checked against it per
// model. Rendered only where Langfuse answered, so nothing here can say the check passed where it
// could not run; and a model that matched says nothing either, since the card is about cost, not
// about the check.
export function CostByModelCard({
  byModel,
  costCheck,
}: {
  byModel: CostRow[];
  costCheck: CostCheck | undefined;
}) {
  const { t, i18n } = useTranslation();
  const comparisonFor = (name: string) =>
    costCheck?.models.find((c) => c.langfuseModels.includes(name));
  const diverging =
    costCheck?.models.filter((c) => c.status === "diverges").length ?? 0;
  const onlyInLangfuse = costCheck?.onlyInLangfuse ?? [];
  const onlyLocal = costCheck?.onlyLocal ?? [];
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-medium text-text-primary">
        {t("dashboard.costByModel", "Cost by model")}
      </h2>
      {diverging > 0 && (
        <p
          className="flex items-center gap-1.5 text-warning text-xs"
          data-testid="cost-divergence-summary"
        >
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t(
            "dashboard.costCheck.summary",
            "{{count}} models cost differently in Langfuse than in this app's price table",
            { count: diverging },
          )}
        </p>
      )}
      {byModel.length > 0 && (
        <ul className="flex flex-col gap-2">
          {byModel.map((m) => {
            const c = comparisonFor(m.model);
            return (
              <li
                key={m.model}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <span className="truncate text-text-secondary">{m.model}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {c?.status === "diverges" && <DivergenceMarker c={c} />}
                  <span className="font-medium text-text-primary tabular-nums">
                    {usd(i18n.language, m.costUsd)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {onlyInLangfuse.length > 0 && (
        <p
          className="text-text-muted text-xs"
          data-testid="cost-check-only-langfuse"
        >
          {t(
            "dashboard.costCheck.onlyInLangfuse",
            "Only in Langfuse, not compared: {{names}}",
            { names: onlyInLangfuse.join(", ") },
          )}
        </p>
      )}
      {onlyLocal.length > 0 && (
        <p
          className="text-text-muted text-xs"
          data-testid="cost-check-only-local"
        >
          {t(
            "dashboard.costCheck.onlyLocal",
            "Only in this app's usage records, not compared: {{names}}",
            { names: onlyLocal.join(", ") },
          )}
        </p>
      )}
    </Card>
  );
}
