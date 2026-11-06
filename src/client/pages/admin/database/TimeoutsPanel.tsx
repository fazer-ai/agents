import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, EmptyState, Tooltip } from "@/client/components";
import { cn } from "@/client/lib/utils";
import { formatSignalValue } from "../instance-health/signals";
import type { Formatters } from "./format";
import { CopyButton, PlanBlock, SectionIntro, SqlText } from "./parts";
import type { Screen, TimeoutGroup } from "./types";

// "What is blowing up, and why?": every statement cancelled by its time budget in the window, one
// card per statement, with the work that ran it, the scope it ran under and the plan it ran with.

export function TimeoutsPanel({
  screen,
  fmt,
}: {
  screen: Screen;
  fmt: Formatters;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <SectionIntro
        title={t(
          "database.timeoutsTitle",
          "Statement timeouts and their plans",
        )}
        aside={
          screen.timeouts.length > 0 ? (
            <span
              className="text-text-muted text-xs"
              data-testid="timeouts-count"
            >
              {t(
                "database.timeoutsCount",
                "{{occurrences}} timeouts across {{statements}} statements in the window",
                {
                  occurrences: fmt.number(screen.timeoutOccurrences),
                  statements: fmt.number(screen.timeouts.length),
                },
              )}
            </span>
          ) : null
        }
      >
        {t(
          "database.timeoutsHelpShort",
          "Statements cancelled by their time budget (SQLSTATE 57014), grouped by statement. The first one of each statement per hour gets its plan, taken as the role and tenant it ran under, without running it.",
        )}
      </SectionIntro>
      {screen.timeouts.length === 0 ? (
        <div data-testid="no-timeouts">
          <EmptyState
            icon={ShieldCheck}
            title={t("database.noTimeoutsTitle", "No timeouts in this window")}
            description={t(
              "database.noTimeoutsMeaning",
              "No statement was cancelled by its time budget, so no request or job stopped because of a slow query.",
            )}
          />
        </div>
      ) : (
        <ul className="space-y-3" data-testid="timeouts-list">
          {screen.timeouts.map((x) => (
            <TimeoutCard key={x.fingerprint} x={x} fmt={fmt} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TimeoutCard({ x, fmt }: { x: TimeoutGroup; fmt: Formatters }) {
  const { t } = useTranslation();
  const [planOpen, setPlanOpen] = useState(false);
  const scope = x.fleet
    ? t("database.scopeFleet", "fleet role")
    : x.tenantId
      ? t("database.scopeTenant", "tenant {{id}}", { id: x.tenantId })
      : t("database.scopeNone", "no tenant scope");
  return (
    <li
      className="border-border bg-bg-secondary space-y-3 rounded-lg border p-4"
      data-testid="timeout-item"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant="error" className="tabular-nums">
          {t("database.occurrences", "{{count}} times", {
            count: x.occurrences,
          })}
        </Badge>
        <Tooltip content={fmt.dateTime(x.lastAt)}>
          <time dateTime={x.lastAt} className="text-text-secondary text-xs">
            {t("database.lastAtRelative", "last {{when}}", {
              when: fmt.relative(x.lastAt),
            })}
          </time>
        </Tooltip>
        <span className="flex flex-wrap gap-1.5">
          <Badge
            variant="primary"
            className={cn({ "font-mono": x.label !== null })}
          >
            {x.label ?? t("database.unlabeled", "unlabeled work")}
          </Badge>
          <Badge variant={x.fleet ? "purple" : "info"}>{scope}</Badge>
          {x.budgetMs !== null && (
            <Badge variant="secondary">
              {t("database.budget", "budget {{budget}}", {
                budget: formatSignalValue(x.budgetMs, "ms"),
              })}
            </Badge>
          )}
        </span>
      </div>
      <SqlText sql={x.statement} testId="timeout-statement" />
      {x.plan ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setPlanOpen((o) => !o)}
              aria-expanded={planOpen}
              className="text-accent inline-flex items-center gap-1 text-xs font-medium hover:underline"
              data-testid="timeout-plan-toggle"
            >
              {planOpen ? (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {planOpen
                ? t("database.hidePlan", "Hide the plan")
                : t("database.showPlan", "Show the plan")}
              <span className="text-text-muted font-normal">
                {x.plannedAs
                  ? t("database.plannedAs", "as {{who}}", { who: x.plannedAs })
                  : null}
                {x.plannedAt ? ` · ${fmt.relative(x.plannedAt)}` : null}
              </span>
            </button>
            {planOpen && (
              <CopyButton
                text={x.plan}
                label={t("database.copyPlan", "Copy the plan")}
              />
            )}
          </div>
          {planOpen && <PlanBlock plan={x.plan} />}
        </div>
      ) : x.planError ? (
        <p
          className="text-text-secondary flex items-start gap-1.5 text-xs"
          data-testid="timeout-plan-error"
        >
          <AlertTriangle
            className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span>
            {t("database.planError", "No plan: {{error}}", {
              error: x.planError,
            })}
          </span>
        </p>
      ) : (
        <p className="text-text-muted text-xs">
          {t(
            "database.planPending",
            "No plan under this scope yet: one is taken per statement each hour, on its next timeout.",
          )}
        </p>
      )}
    </li>
  );
}
