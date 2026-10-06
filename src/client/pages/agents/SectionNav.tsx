import type { LucideIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Card, HelpPopover } from "@/client/components";
import { cn } from "@/client/lib/utils";

// Shared building blocks for the heavy editor tabs: a titled <Section> card with an anchor id + icon,
// and a left-rail <SectionNav> index that scrolls to a section on click and highlights the one
// currently in view (scroll-spy), so the operator sees WHERE they are across the many sections of
// the Behavior/Tools tabs.

export interface SectionDef {
  id: string;
  icon: LucideIcon;
  label: string;
}

export interface SectionProps {
  id: string;
  icon: LucideIcon;
  title: string;
  description?: string;
  // Why this block exists and when it applies, behind the `?` next to the title. The rule that
  // sorts this from `description` is in docs/ui.md → "Where help goes".
  help?: ReactNode;
  children: ReactNode;
  className?: string;
  // Drawn but not shown: the form inside keeps its state. A Behavior section that does not apply to
  // the agent's mode is hidden this way rather than unmounted, so flipping the mode back shows it
  // again exactly as it was, unsaved edits included.
  hidden?: boolean;
}

// A titled config block: a Card carrying the anchor `id` (so SectionNav can scroll to it and the
// scroll-spy can track it) plus an icon + title + optional description header. scroll-mt offsets the
// smooth-scroll landing so the section title isn't flush against the scroll container's top edge.
export function Section({
  id,
  icon: Icon,
  title,
  description,
  help,
  children,
  className,
  hidden,
}: SectionProps) {
  return (
    <Card
      id={id}
      className={cn(
        "flex scroll-mt-4 flex-col gap-4",
        hidden && "hidden",
        className,
      )}
    >
      {/* The icon is 28px and one line of the title is 20px, so the alignment depends on whether
          there is a second line. With a description the icon rides the text column's FIRST line
          (`items-start` + the nudge); without one, the same rule would leave the title 6px above
          the icon's centre, so the two are centred against each other instead. */}
      <div
        className={cn(
          "flex gap-2.5",
          description ? "items-start" : "items-center",
        )}
      >
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-accent",
            description && "mt-0.5",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 font-medium text-sm text-text-primary">
            {title}
            {help ? <HelpPopover content={help} label={title} /> : null}
          </h3>
          {description && (
            <p className="text-text-muted text-xs">{description}</p>
          )}
        </div>
      </div>
      {children}
    </Card>
  );
}

// How long the scroll must stay still before a clicked entry stops holding the highlight.
const SCROLL_SETTLE_MS = 150;

type Pin = { settled: boolean; timer?: Timer };

const GESTURES = ["wheel", "touchstart", "keydown"] as const;

// The hold ends SCROLL_SETTLE_MS after the last scroll event, or after the click when the section
// was already in place and nothing scrolled: without its own clock the operator's next scroll would
// be read as the click's.
function armSettle(pin: Pin): void {
  clearTimeout(pin.timer);
  pin.timer = setTimeout(() => {
    pin.settled = true;
  }, SCROLL_SETTLE_MS);
}

// The nearest ancestor that scrolls (the app's <main>), or the document when none does.
function scrollBoxOf(el: HTMLElement): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return document.scrollingElement;
}

// Where the operator is reading: the section whose top has passed a line this far down the scroll
// container is the current one. A line and not a band, because a tall section covering a band kept
// the highlight until the page ended, and the section under it was never lit.
const ACTIVATION_LINE = 0.35;

// Tracks which section is current as the scroll container (the app's <main>) scrolls. Keyed on the
// joined id list so it re-binds only when the section set changes (the effect reads the ids from
// `key`, never the array identity).
function useScrollSpy(ids: string[]): {
  active: string | null;
  pin: (id: string) => void;
} {
  const key = ids.join("|");
  const [active, setActive] = useState<string | null>(null);
  const pinned = useRef<Pin | null>(null);
  useEffect(() => {
    const order = key ? key.split("|") : [];
    const els = order
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const first = els[0] as HTMLElement;
    const last = els[els.length - 1] as HTMLElement;
    // The ends of the page decide on their own: at the top the first section is current though a
    // short one leaves the line in the next (a page that does not scroll is at its top), and at the
    // bottom the last one is, though a last section shorter than the screen never reaches the line.
    const decide = (box: Element) => {
      if (pinned.current) return;
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
      let next = first;
      if (box.scrollTop > 1 && atBottom) next = last;
      else if (box.scrollTop > 1) {
        const top =
          box === document.scrollingElement
            ? 0
            : box.getBoundingClientRect().top;
        const line = top + box.clientHeight * ACTIVATION_LINE;
        for (const el of els) {
          if (el.getBoundingClientRect().top <= line) next = el;
        }
      }
      setActive(next.id);
    };
    // Scroll does not bubble, so it is caught on the way down; only the container holding the
    // sections counts, not a textarea scrolling inside one of them.
    const onScroll = (event: Event) => {
      const box =
        event.target instanceof Element
          ? event.target
          : document.scrollingElement;
      if (!box?.contains(last)) return;
      const pin = pinned.current;
      if (pin && !pin.settled) {
        armSettle(pin);
        return;
      }
      pinned.current = null;
      decide(box);
    };
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    // Mounted into a page already scrolled (Back and Forward between the editor's tabs), it answers
    // for where the page is now instead of waiting for the next scroll.
    const box = scrollBoxOf(last);
    if (box) decide(box);
    // A gesture of the operator's ends the hold at once: taking over mid-animation, their scroll events
    // come back to back with the animation's, and waiting for a pause would hold through the gesture.
    const release = () => {
      clearTimeout(pinned.current?.timer);
      pinned.current = null;
    };
    for (const type of GESTURES) {
      document.addEventListener(type, release, {
        capture: true,
        passive: true,
      });
    }
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      for (const type of GESTURES) {
        document.removeEventListener(type, release, { capture: true });
      }
      clearTimeout(pinned.current?.timer);
    };
  }, [key]);
  // An entry clicked holds the highlight until the operator scrolls again: its section may stop too
  // low to reach the line where the smooth scroll ends.
  const pin = useCallback((id: string) => {
    clearTimeout(pinned.current?.timer);
    const pin: Pin = { settled: false };
    armSettle(pin);
    pinned.current = pin;
    setActive(id);
  }, []);
  return { active: active ?? ids[0] ?? null, pin };
}

// The left-rail index: desktop-only (the tab already stacks vertically on mobile), sticky within the
// scroll container. Clicking an entry smooth-scrolls to its section; the active section is highlighted.
export function SectionNav({ sections }: { sections: SectionDef[] }) {
  const { t } = useTranslation();
  const { active, pin } = useScrollSpy(sections.map((s) => s.id));
  return (
    <nav
      className="hidden w-56 shrink-0 lg:block"
      aria-label={t("editor.sectionsNav", "Sections")}
    >
      <ul className="sticky top-4 flex flex-col gap-0.5">
        {sections.map((s) => {
          const Icon = s.icon;
          const isActive = active === s.id;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  pin(s.id);
                  document
                    .getElementById(s.id)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-bg-tertiary font-medium text-text-primary"
                    : "text-text-muted hover:bg-bg-hover hover:text-text-secondary",
                )}
                aria-current={isActive ? "true" : undefined}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{s.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
