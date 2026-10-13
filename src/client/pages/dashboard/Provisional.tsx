import { type CSSProperties, type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/client/components";
import { cn } from "@/client/lib/utils";
import type { BlockCoverage } from "./useStream";

// A FIGURE THAT DOES NOT COVER ITS WHOLE WINDOW YET LOOKS PROVISIONAL. Its value is fainter and, while
// parts are still arriving, pulses slowly; the "partial · N of M days" badge sits by it, with a static
// bar of the days in. Once the figure covers the window, all of it fades out. A stream that failed or
// was refused stops the pulse: nothing is loading any more, and saying so would be false.

const PULSE_MS = 1600;

export function isProvisional(
  coverage: BlockCoverage | null | undefined,
): coverage is BlockCoverage {
  return !!coverage && coverage.total > 0 && !coverage.done && coverage.graced;
}

// Whether some of the window's days have no figures for good (the retention sweep emptied them before
// they were kept): an empty result over them is unknown, never "none in the period".
export function hasNoData(coverage: BlockCoverage | null | undefined): boolean {
  return !!coverage && coverage.noData > 0;
}

// Every card's pulse on one clock: the animation is the same with no delay of its own, and a card
// whose pulse starts mid-cycle (mounted, or turned provisional, after the others) starts where the
// others are rather than at the faint end. The offset is taken when the pulse starts, which is when
// the browser starts the animation.
function usePhase(pulsing: boolean): CSSProperties | undefined {
  const phase = useRef<string | null>(null);
  if (!pulsing) phase.current = null;
  else if (phase.current === null)
    phase.current = `-${Math.round(performance.now() % PULSE_MS)}ms`;
  return phase.current
    ? ({ "--provisional-phase": phase.current } as CSSProperties)
    : undefined;
}

export function ProvisionalValue({
  coverage,
  children,
  className,
}: {
  coverage: BlockCoverage | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const partial = isProvisional(coverage);
  const style = usePhase(partial && coverage.arriving);
  return (
    <div
      data-provisional={
        partial ? (coverage.arriving ? "arriving" : "stopped") : undefined
      }
      style={style}
      className={cn(
        "transition-opacity duration-300",
        partial && "text-text-muted",
        partial && (coverage.arriving ? "provisional-pulse" : "opacity-70"),
        className,
      )}
    >
      {children}
    </div>
  );
}

// The last partial coverage, kept while the badge and bar fade out after the figure completes.
function useLastPartial(
  coverage: BlockCoverage | null | undefined,
): BlockCoverage | null {
  const last = useRef<BlockCoverage | null>(null);
  if (isProvisional(coverage)) last.current = coverage;
  return last.current;
}

// Collapses its content in a short transition once `open` turns false.
function Fade({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

export function PartialBadge({
  coverage,
}: {
  coverage: BlockCoverage | null | undefined;
}) {
  const { t } = useTranslation();
  const shown = useLastPartial(coverage);
  if (!shown) return null;
  return (
    <span
      className={cn(
        "transition-opacity duration-300",
        isProvisional(coverage) ? "opacity-100" : "opacity-0",
      )}
      aria-hidden={!isProvisional(coverage)}
    >
      <Badge variant="info">
        {t(
          "dashboard.coverage.partial",
          "partial · {{ready}} of {{total}} days",
          { ready: shown.ready, total: shown.total },
        )}
      </Badge>
    </span>
  );
}

// The days in, as a bar: only its fill moves, as parts arrive, so a card has one motion, the pulse.
export function CoverageBar({
  coverage,
}: {
  coverage: BlockCoverage | null | undefined;
}) {
  const { t } = useTranslation();
  const shown = useLastPartial(coverage);
  if (!shown) return null;
  const pct = Math.round((shown.ready / shown.total) * 100);
  return (
    <Fade open={isProvisional(coverage)}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={shown.total}
        aria-valuenow={shown.ready}
        aria-label={t(
          "dashboard.coverage.bar",
          "{{ready}} of {{total}} days in",
          { ready: shown.ready, total: shown.total },
        )}
        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-info-soft"
      >
        <div
          className="h-full rounded-full bg-info"
          style={{ width: `${pct}%` }}
        />
      </div>
    </Fade>
  );
}

// A card's figure with its badge beside it: the figure fades and pulses, the badge stays legible.
export function ProvisionalFigure({
  coverage,
  children,
}: {
  coverage: BlockCoverage | null | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProvisionalValue coverage={coverage}>{children}</ProvisionalValue>
      <PartialBadge coverage={coverage} />
    </div>
  );
}
