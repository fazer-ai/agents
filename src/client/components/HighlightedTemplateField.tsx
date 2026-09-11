import { forwardRef, type ReactNode, type Ref, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";

// Generic template field with inline {{token}} highlighting, via the classic transparent-control-
// over-colored-backdrop overlay: the editable control (on top) owns caret/selection with transparent
// text; the backdrop (behind) shows the same text with the tokens colored; scroll is mirrored so the
// layers stay aligned. The token pattern and the "is this a known token?" predicate are injected, so
// the same component serves the prompt editor (lowercase prompt vars) and the HTTP tool editor
// (AI fields + context vars + {{secret}}). Renders a <textarea> when `multiline`, else an <input>.

// Splits text into plain runs and highlighted {{token}} spans (known → accent, unknown → warning
// with a wavy underline so typos stand out). Returns React nodes (never innerHTML) — the content is
// operator-controlled, so building elements keeps it XSS-safe by construction.
function renderHighlighted(
  text: string,
  patternSource: string,
  isKnown: (name: string) => boolean,
): ReactNode[] {
  const re = new RegExp(patternSource, "g");
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const known = isKnown(m[1] ?? "");
    out.push(
      <span
        key={key++}
        className={cn(
          known ? "text-accent" : "text-warning underline decoration-wavy",
        )}
      >
        {m[0]}
      </span>,
    );
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  // A trailing newline renders an empty last line in the control but collapses in the backdrop div;
  // a trailing space keeps the two heights (and scroll) in sync.
  if (text.endsWith("\n")) out.push(" ");
  return out;
}

// Box model shared by both layers. Matches <Input>/<Textarea> (border, bg-bg-tertiary, focus ring).
// Font-size/line-height come from `textClassName` (applied to BOTH layers) so the glyphs line up;
// padding differs (multiline px-3 like <Textarea>, single-line px-4 like <Input>).
// `block` is load-bearing: without it the control is inline-block and its line-box adds a baseline
// descender gap, so the wrapper grows taller than the control and the absolute backdrop shows below
// the border as a thin band. `block` makes wrapper height == control height so the two layers align.
// Below this fraction of the cap the counter is noise: the value is nowhere near the wall and the
// field should look like any other. At it, the operator gets warning before the wall, not at it.
// Same number `Textarea` uses, because it is the same affordance on a different control.
const COUNTER_FROM = 0.8;

const FIELD_BASE =
  "block w-full rounded-lg border bg-bg-tertiary py-2 focus:border-border-focus focus:outline-none";

export const HighlightedTemplateField = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    isKnownToken: (name: string) => boolean;
    patternSource: string;
    multiline?: boolean;
    rows?: number;
    placeholder?: string;
    invalid?: boolean;
    // Multiline only: grow to fill a flex-column parent (textarea becomes h-full, non-resizable)
    // instead of the fixed `rows` height — used by the prompt editor's expand-to-modal view.
    fill?: boolean;
    // Applied to the wrapper (e.g. "flex-1" so a single-line field fills a flex row).
    className?: string;
    // Applied to BOTH layers; controls font-family/size/leading. Defaults to "text-sm".
    textClassName?: string;
    // DECLARES the cap, the way `Textarea` does and for the same reason: a field whose reader clamps
    // silently must say so on screen, or the operator pastes a long value, sees it whole, and the
    // customer reads a truncated one. Pass it only where the stored value is clamped or refused at
    // the same number. Below `COUNTER_FROM` of it the counter stays hidden, so an ordinary value
    // looks like any other field.
    maxLength?: number;
    "aria-label"?: string;
  }
>(
  (
    {
      value,
      onChange,
      isKnownToken,
      patternSource,
      multiline = false,
      rows = 6,
      placeholder,
      invalid = false,
      fill = false,
      className,
      textClassName = "text-sm",
      maxLength,
      "aria-label": ariaLabel,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const backdropRef = useRef<HTMLDivElement>(null);
    const pad = multiline ? "px-3" : "px-4";
    // The backdrop wraps like the textarea (multiline) or stays a single non-wrapping line that
    // scrolls horizontally with the input (single-line).
    const wrapCls = multiline
      ? "whitespace-pre-wrap break-words"
      : "whitespace-pre";
    const mirror = (el: HTMLElement) => {
      const b = backdropRef.current;
      if (!b) return;
      b.scrollTop = el.scrollTop;
      b.scrollLeft = el.scrollLeft;
    };
    const sharedText = cn(FIELD_BASE, pad, textClassName, wrapCls);
    // Raw length, the same thing the browser enforces `maxLength` against and the same thing the
    // reader clamps. `maxLength` stops new typing at the wall; what it cannot show is a value
    // ALREADY past it — pasted before the cap existed, imported, or written through the API — which
    // is exactly the case where the text looks whole here and reaches the customer cut short.
    const over = maxLength !== undefined && value.length > maxLength;
    const showCount =
      maxLength !== undefined && value.length >= maxLength * COUNTER_FROM;
    return (
      // TWO WRAPPERS, and the inner one is load-bearing. The backdrop is `absolute inset-0` over its
      // positioned parent, so anything else inside that parent grows it and the backdrop stops
      // matching the control: at ~400 characters the counter made the highlighted layer taller than
      // the textarea, spilling text below the field and giving the two layers different maximum
      // scroll offsets, so the caret drifted from the text it sat in. Found in review of #599.
      // The counter and the over-limit line therefore sit OUTSIDE the positioned box.
      <div
        className={cn(
          "min-w-0",
          fill && "flex min-h-0 flex-1 flex-col",
          className,
        )}
      >
        <div className={cn("relative min-w-0", fill && "min-h-0 flex-1")}>
          <div
            ref={backdropRef}
            aria-hidden="true"
            className={cn(
              sharedText,
              "pointer-events-none absolute inset-0 overflow-hidden border-transparent text-text-primary",
            )}
          >
            {renderHighlighted(value, patternSource, isKnownToken)}
          </div>
          {multiline ? (
            <textarea
              ref={ref as Ref<HTMLTextAreaElement>}
              rows={rows}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onScroll={(e) => mirror(e.currentTarget)}
              spellCheck={false}
              placeholder={placeholder}
              aria-label={ariaLabel}
              maxLength={maxLength}
              className={cn(
                sharedText,
                "relative bg-transparent text-transparent placeholder-text-placeholder caret-text-primary",
                fill ? "h-full resize-none" : "resize-y",
                invalid ? "border-error" : "border-border",
              )}
            />
          ) : (
            <input
              ref={ref as Ref<HTMLInputElement>}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onScroll={(e) => mirror(e.currentTarget)}
              spellCheck={false}
              placeholder={placeholder}
              aria-label={ariaLabel}
              maxLength={maxLength}
              className={cn(
                sharedText,
                "relative bg-transparent text-transparent placeholder-text-placeholder caret-text-primary",
                invalid ? "border-error" : "border-border",
              )}
            />
          )}
        </div>
        {showCount && (
          <span
            className={cn(
              "mt-1 block text-right text-xs",
              over ? "text-error" : "text-text-muted",
            )}
          >
            {`${value.length}/${maxLength}`}
          </span>
        )}
        {over && (
          <span className="mt-1 block text-error text-xs">
            {t(
              "common.charOverLimit",
              "{{over}} characters over the limit. The agent only receives the first {{max}}; shorten it to save a change to this field.",
              { over: value.length - (maxLength ?? 0), max: maxLength },
            )}
          </span>
        )}
      </div>
    );
  },
);

HighlightedTemplateField.displayName = "HighlightedTemplateField";
