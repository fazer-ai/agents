import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@/client/components";
import { cn } from "@/client/lib/utils";

// The pieces the three sections of the Database screen share: a statement's text, a bar against a
// reference, the mean-time series and a plan with its costly nodes marked.

// Past this many characters a statement starts cut, with a control to show it whole.
const CUT_AT = 140;

export type Tone = "neutral" | "accent" | "warning" | "error";

const FILL: Record<Tone, string> = {
  neutral: "bg-text-muted",
  accent: "bg-accent-solid",
  warning: "bg-warning",
  error: "bg-error",
};

export function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // NOTE: without a clipboard (an insecure context) the text stays selectable on screen.
    }
  };
  const hint = copied ? t("database.copied", "Copied") : label;
  return (
    <Tooltip content={hint}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={hint}
        className="text-text-muted hover:text-text-primary hover:bg-bg-hover inline-flex h-6 w-6 shrink-0 items-center justify-center rounded"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
    </Tooltip>
  );
}

// A statement as Postgres normalized it: cut to a few lines until asked, copied whole either way.
export function SqlText({
  sql,
  testId,
  className,
}: {
  sql: string;
  testId?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = sql.length > CUT_AT || sql.includes("\n");
  return (
    <div className={cn("flex min-w-0 items-start gap-1", className)}>
      <div className="min-w-0 flex-1">
        <code
          data-testid={testId}
          data-expanded={open}
          className={cn(
            "text-text-primary font-mono text-xs leading-relaxed break-all whitespace-pre-wrap",
            { block: !long || open, "line-clamp-2": long && !open },
          )}
        >
          {sql}
        </code>
        {long && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="text-accent mt-0.5 inline-flex items-center gap-0.5 text-xs hover:underline"
          >
            {open ? (
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            )}
            {open
              ? t("database.collapseSql", "Show less")
              : t("database.expandSql", "Show the whole statement")}
          </button>
        )}
      </div>
      <CopyButton
        text={sql}
        label={t("database.copySql", "Copy the statement")}
      />
    </div>
  );
}

// A horizontal bar filled to `pct` of its track (capped at the track; the figure beside it is not).
export function Meter({
  pct,
  tone,
  className,
}: {
  pct: number;
  tone: Tone;
  className?: string;
}) {
  const width = Math.max(0, Math.min(100, pct));
  // NOTE: decorative: the figure it draws is always printed beside it.
  return (
    <div
      aria-hidden="true"
      data-tone={tone}
      data-pct={Math.round(pct)}
      className={cn(
        "bg-bg-tertiary h-1.5 w-full overflow-hidden rounded-full",
        className,
      )}
    >
      <div
        className={cn("h-full rounded-full", FILL[tone])}
        style={{ width: `${width > 0 ? Math.max(width, 2) : 0}%` }}
      />
    </div>
  );
}

// Mean time per bucket of the window, a line with gaps where the statement did not run and a dot for
// a bucket alone between gaps.
export function MeanSpark({
  points,
  label,
}: {
  points: (number | null)[];
  label: string;
}) {
  const values = points.filter((p): p is number => p !== null);
  const top = Math.max(...values, 0) || 1;
  const w = 120;
  const h = 28;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  points.forEach((p, i) => {
    if (p === null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push([i * step, h - (p / top) * (h - 4) - 2]);
  });
  if (current.length) segments.push(current);
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={label}
      data-testid="mean-spark"
      className="text-accent shrink-0 overflow-visible"
    >
      <line
        x1={0}
        x2={w}
        y1={h - 1}
        y2={h - 1}
        className="stroke-border"
        strokeWidth={1}
      />
      {segments.map((pts) =>
        pts.length > 1 ? (
          <polyline
            key={pts.map((p) => p.join(",")).join(" ")}
            points={pts
              .map((p) => p.map((v) => v.toFixed(1)).join(","))
              .join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ) : (
          <circle
            key={pts[0]?.join(",")}
            cx={pts[0]?.[0]}
            cy={pts[0]?.[1]}
            r={2}
            fill="currentColor"
          />
        ),
      )}
    </svg>
  );
}

// A node that reads a whole table, and the tenant predicate row-level security adds to a statement:
// the two things a timed-out plan is usually read for.
const SEQ_SCAN = /\bSeq Scan\b/;
const RLS_PREDICATE = /current_setting\('app\.tenant_id'/;

export function planLineKind(line: string): "seq" | "rls" | null {
  if (SEQ_SCAN.test(line)) return "seq";
  if (RLS_PREDICATE.test(line)) return "rls";
  return null;
}

export function PlanBlock({ plan }: { plan: string }) {
  const { t } = useTranslation();
  const lines = plan.split("\n");
  const kinds = new Set(lines.map(planLineKind));
  return (
    <div className="space-y-2">
      <pre
        data-testid="timeout-plan"
        className="border-border bg-bg-primary text-text-primary max-h-96 overflow-auto rounded-md border py-2 font-mono text-xs leading-relaxed"
      >
        {lines.map((line, i) => {
          const kind = planLineKind(line);
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a plan's lines repeat and never move.
              key={i}
              data-plan-line={kind ?? undefined}
              className={cn("block border-l-2 border-transparent px-3", {
                "border-warning bg-warning-soft": kind === "seq",
                "border-info bg-info-soft": kind === "rls",
              })}
            >
              {line || " "}
            </span>
          );
        })}
      </pre>
      {(kinds.has("seq") || kinds.has("rls")) && (
        <div className="text-text-muted flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {kinds.has("seq") && (
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-warning h-2.5 w-0.5" aria-hidden="true" />
              {t(
                "database.planLegendSeq",
                "Seq Scan: reads the whole table, row by row",
              )}
            </span>
          )}
          {kinds.has("rls") && (
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-info h-2.5 w-0.5" aria-hidden="true" />
              {t(
                "database.planLegendRls",
                "Tenant predicate added by row-level security",
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// A section heading with its one line of context, the same in all three sections.
export function SectionIntro({
  title,
  children,
  aside,
}: {
  title: string;
  children?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-text-primary text-sm font-semibold">{title}</h3>
        {children && (
          <p className="text-text-muted max-w-3xl text-xs">{children}</p>
        )}
      </div>
      {aside}
    </div>
  );
}
