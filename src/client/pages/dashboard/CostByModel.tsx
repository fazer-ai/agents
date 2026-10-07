import { useTranslation } from "react-i18next";
import { Card } from "@/client/components";
import type { api } from "@/client/lib/api";

// Derived from the Eden treaty, never hand-declared (docs/eden-treaty.md).
type CostsData = Awaited<
  ReturnType<typeof api.api.v1.metrics.costs.get>
>["data"];
type CostRow = NonNullable<CostsData>["costs"]["byModel"][number];

function usd(locale: string, v: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(v);
}

// "Cost by model", summed from this app's usage records over the page's period and segment.
export function CostByModelCard({ byModel }: { byModel: CostRow[] }) {
  const { t, i18n } = useTranslation();
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-medium text-text-primary">
        {t("dashboard.costByModel", "Cost by model")}
      </h2>
      <ul className="flex flex-col gap-2">
        {byModel.map((m) => (
          <li
            key={m.model}
            className="flex items-center justify-between gap-4 text-sm"
          >
            <span className="truncate text-text-secondary">{m.model}</span>
            <span className="shrink-0 font-medium text-text-primary tabular-nums">
              {usd(i18n.language, m.costUsd)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
