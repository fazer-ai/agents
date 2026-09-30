import type { ReactNode } from "react";
import { useId } from "react";
import { cn } from "@/client/lib/utils";

// One titled group of settings. The rows share a single bordered surface
// and are separated by hairlines, the layout GitHub and Linear use for
// settings, so a page reads as a list of decisions rather than a stack of
// unrelated cards.
export function SettingsSection({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const headingId = useId();
  return (
    // NOTE: a size container, so rows and their controls lay out by the width
    // the section actually gets (the settings nav and an expanded sidebar can
    // leave far less than the viewport suggests), never by `sm:`.
    <section
      aria-labelledby={headingId}
      className="@container flex flex-col gap-3"
    >
      <div>
        <h2
          id={headingId}
          className="font-semibold text-base text-text-primary"
        >
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-sm text-text-muted">{description}</p>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-bg-secondary">
        <div className="divide-y divide-border">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-border border-t bg-bg-primary/40 px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </section>
  );
}

// Label and description on the left, the control on the right; stacked
// when the section is narrower than 32rem. Size a control's wrapper with the
// same container variant (`@lg:w-64`), never `sm:`, or it will not fit.
// Pass `labelId` through to the control (aria-labelledby)
// when the control is not a native input wrapped by a <label>.
export function SettingsRow({
  label,
  labelId,
  description,
  children,
  stacked = false,
}: {
  label: ReactNode;
  labelId?: string;
  description?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      className={cn("flex flex-col gap-3 px-4 py-3.5", {
        "@lg:flex-row @lg:items-center @lg:justify-between @lg:gap-6": !stacked,
      })}
    >
      <div className="min-w-0">
        <div id={labelId} className="font-medium text-sm text-text-primary">
          {label}
        </div>
        {description && (
          <div className="mt-0.5 text-sm text-text-muted">{description}</div>
        )}
      </div>
      {children && (
        <div
          className={cn("min-w-0", {
            "@lg:shrink-0": !stacked,
          })}
        >
          {children}
        </div>
      )}
    </div>
  );
}
