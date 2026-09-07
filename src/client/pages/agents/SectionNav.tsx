import type { LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, HelpPopover } from "@/client/components";
import { cn } from "@/client/lib/utils";

// Shared building blocks for the heavy editor tabs (item 9): a titled <Section> card with an anchor
// id + icon, and a left-rail <SectionNav> index that scrolls to a section on click and highlights the
// one currently in view (scroll-spy). Lets the operator see WHERE they are across the many sections of
// the Behavior/Tools tabs instead of scrolling blindly.

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
  // Drawn but not shown: the form inside keeps its state. A Behavior section that does not apply
  // to the agent's mode (issue #494) is hidden this way rather than unmounted, so flipping the
  // mode back shows it again exactly as it was, unsaved edits included.
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
      {/* The icon is 28px and one line of the title is 20px, so how they align depends on whether
          there is a second line. With a description the text column is the taller of the two and
          the icon rides its FIRST line (`items-start` + the nudge). Without one, the shape most
          sections took once their prose moved behind the `?`, the same rule leaves the title
          sitting 6px above the icon's centre, so the two are centred against each other instead. */}
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

// Tracks which section id is currently near the top of the viewport. IntersectionObserver against the
// viewport fires as the inner scroll container (the app's <main>) scrolls, because the observed
// section elements translate within the viewport. The rootMargin biases "active" to the upper band so
// the highlight matches what the operator is reading. Keyed on the joined id list so it re-binds only
// when the section set changes (the effect reads the ids from `key`, never the array identity).
function useScrollSpy(ids: string[]): string | null {
  const key = ids.join("|");
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const order = key ? key.split("|") : [];
    const els = order
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const visible = new Set<string>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const firstVisible = order.find((id) => visible.has(id));
        if (firstVisible) setActive(firstVisible);
      },
      { rootMargin: "-80px 0px -55% 0px", threshold: [0, 0.1] },
    );
    for (const el of els) obs.observe(el);
    return () => obs.disconnect();
  }, [key]);
  return active ?? ids[0] ?? null;
}

// The left-rail index: desktop-only (the tab already stacks vertically on mobile), sticky within the
// scroll container. Clicking an entry smooth-scrolls to its section; the active section is highlighted.
export function SectionNav({ sections }: { sections: SectionDef[] }) {
  const { t } = useTranslation();
  const active = useScrollSpy(sections.map((s) => s.id));
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
