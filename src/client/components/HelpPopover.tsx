import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import { Popover } from "./Popover";

interface HelpPopoverProps {
  // What the operator needs to DECIDE (why this exists, when it applies, what it costs) as
  // opposed to what they need to act correctly, which stays on screen. The rule that sorts one
  // from the other is in docs/ui.md.
  content: React.ReactNode;
  // What this help is ABOUT, for the accessible name. Every surface that renders a `?` already
  // knows it (a field's label, a section's title, a KPI's caption), and without it every trigger on
  // a page is announced identically: a screen-reader user tabbing a form of twelve fields hears the
  // same three words twelve times and cannot tell which one they are on.
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  // The TRIGGER's classes.
  className?: string;
  // The BOX's classes. The default is sized for prose; content that is a reference table wants a
  // denser size, which is the only reason this is exposed.
  contentClassName?: string;
}

// The `?` that opens long-form help, wherever help lives: next to a form field's label, next to a
// KPI's caption, next to a section heading. One component and not a prop on each of those, because
// the affordance is the part an operator learns once and then expects to find everywhere.
//
// A SPAN, NOT A BUTTON, and that is load-bearing rather than stylistic. A <label> is associated
// with the first LABELABLE element in its subtree, and `button` is labelable: as a button, this
// became the labelled control of any field it sat in: clicking the field's title opened the help
// instead of focusing the input, and the input lost its accessible name. Measured. `role="button"`
// plus `tabIndex` makes it interactive content (so a label forwards no click to it) without making
// it labelable, at the cost of wiring Enter and Space by hand, which a span does not emit as
// clicks. It is kept uniform outside labels too: one behaviour beats two variants that differ in a
// way nobody can see until it breaks.
export function HelpPopover({
  content,
  label,
  side = "bottom",
  align = "start",
  className,
  contentClassName,
}: HelpPopoverProps) {
  const { t } = useTranslation();
  // One name for both halves of the affordance: the button the operator activates and the box that
  // opens. Radix names the box nothing on its own, and hearing the same words on the way in and on
  // the way out is what ties the two together for somebody who cannot see that one came from the
  // other.
  const name = label
    ? `${t("common.showHelp", "Show help")}: ${label}`
    : t("common.showHelp", "Show help");
  return (
    <Popover
      content={content}
      label={name}
      side={side}
      align={align}
      contentClassName={contentClassName}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a real <button> is labelable and would steal the label of any field this sits in, see above. */}
      <span
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.currentTarget.click();
          }
        }}
        // "Show help: History ceiling". COMPOSED and not interpolated, which is the unusual choice
        // here and is deliberate. The two halves are an action and its subject, in that order in
        // both catalogues, and the subject arrives already translated from whoever rendered the
        // label. Interpolation would make the name of every trigger depend on a `t` that
        // interpolates, and in this suite one does not: nine client test files stub
        // `react-i18next` and the stub leaks across files (tests/lib/module-mock-package.test.ts
        // records exactly that, and predicted it would bite).
        aria-label={name}
        className={cn(
          // The RING is 16px; the TARGET is not, and the two are separated on purpose. A bare
          // `h-4 w-4` gives 256px² of which `rounded-full` then clips the four corners away, so
          // roughly 200px² are live and the outer band of the visible circle is dead: the pointer
          // has to be near the middle to open anything. The `after` box restores the missing area
          // without touching the drawing or the layout: it is 6px of overhang on every side,
          // which is exactly the `gap-1.5` between this and the label it sits beside, so it never
          // reaches the label's own text.
          "relative inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-border bg-transparent p-0 font-medium text-[10px] text-text-muted transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:border-border-hover hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-2",
          className,
        )}
      >
        {/* biome-ignore lint/style/noJsxLiterals: decorative glyph, accessible name comes from aria-label */}
        ?
      </span>
    </Popover>
  );
}
