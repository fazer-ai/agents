import type { TFunction } from "i18next";
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

// Who a plan was taken as, in the console's language; the stored English wording when it names no
// scope the screen knows.
function plannedWho(x: TimeoutGroup, t: TFunction): string {
  const scope = x.plannedScope;
  if (!scope) return x.plannedAs ?? "";
  if (scope.fleet) return t("database.scopeFleet", "fleet role");
  return scope.tenantId
    ? t("database.plannedTenant", "application role, tenant {{id}}", {
        id: scope.tenantId,
      })
    : t("database.plannedNoTenant", "application role, no tenant");
}

// The privilege a refused plan lacks on each kind of object, and how GRANT names that object.
const GRANT_FOR: Record<string, { privilege: string; target: string }> = {
  table: { privilege: "SELECT", target: "" },
  view: { privilege: "SELECT", target: "" },
  "materialized view": { privilege: "SELECT", target: "" },
  sequence: { privilege: "USAGE", target: "SEQUENCE " },
  schema: { privilege: "USAGE", target: "SCHEMA " },
  function: { privilege: "EXECUTE", target: "FUNCTION " },
};

// Why there is no plan, by the server's category: a missing grant names it, the rest say what
// happened with the SQLSTATE; the raw error stays behind the expander.
function planFailureText(x: TimeoutGroup, t: TFunction): string {
  const f = x.planFailure;
  const role = x.fleet
    ? t("database.planRole.fleet", "the fleet role")
    : t("database.planRole.app", "the application role");
  switch (f?.kind) {
    case "permission": {
      const grant = f.objectType ? GRANT_FOR[f.objectType] : undefined;
      if (!grant || !f.object) {
        return t(
          "database.planFailure.permissionUnnamed",
          "No plan: {{role}} lacks a permission the plan needs (code 42501).",
          { role },
        );
      }
      return t(
        "database.planFailure.permission",
        "No plan: {{role}} has no {{privilege}} on {{object}}. Grant it with GRANT {{privilege}} ON {{target}} TO <role>, and the next timeout of this statement gets its plan.",
        {
          role,
          privilege: grant.privilege,
          object: f.object,
          target: `${grant.target}${f.object}`,
        },
      );
    }
    case "old_server":
      return t(
        "database.planFailure.oldServer",
        "No plan: plans are taken with EXPLAIN (GENERIC_PLAN), which needs PostgreSQL 16 or later.",
      );
    case "other_database":
      return t(
        "database.planFailure.otherDatabase",
        "No plan: this statement ran on the checkpointer's database (LANGGRAPH_DATABASE_URL), where plans are not taken.",
      );
    default:
      return f?.code
        ? t(
            "database.planFailure.otherCode",
            "No plan: Postgres refused to plan this statement (code {{code}}).",
            { code: f.code },
          )
        : t(
            "database.planFailure.other",
            "No plan: the plan could not be taken.",
          );
  }
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
                budget: fmt.ms(x.budgetMs),
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
                  ? t("database.plannedAs", "as {{who}}", {
                      who: plannedWho(x, t),
                    })
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
        <div
          className="text-text-secondary flex items-start gap-1.5 text-xs"
          data-testid="timeout-plan-failure"
        >
          <AlertTriangle
            className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="space-y-1">
            <span className="block" data-testid="timeout-plan-error">
              {planFailureText(x, t)}
            </span>
            <details data-testid="timeout-plan-error-raw">
              <summary className="cursor-pointer">
                {t(
                  "database.planErrorRaw",
                  "The error as Postgres returned it",
                )}
              </summary>
              <pre className="text-text-muted mt-1 font-mono text-xs break-all whitespace-pre-wrap">
                {x.planError}
              </pre>
            </details>
          </span>
        </div>
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
