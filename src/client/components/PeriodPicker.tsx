import { CalendarDays, ChevronDown } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import { ControlPopover } from "./ControlPopover";

export interface PeriodGroup<V extends string> {
  label: string;
  options: { value: V; label: string }[];
}

const CUSTOM = "custom";
const TYPEAHEAD_MS = 700;

// Case and accents folded away, so "u" reaches "Últimos 7 dias" as it would in a native select.
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

// THE PERIOD BUTTON AND ITS POPOVER, shared by the operator dashboard and the Dashboards. The button
// says the whole period: name and days, then the stretch it is compared with, and a bar on its bottom
// edge while a calendar period runs. The popover lists the presets by group in columns, the custom
// dates, and the progress and comparison in full. The caller computes every text. The presets are a
// listbox with one Tab stop: up and down walk the list, left and right reach the same row of the other
// column, Home and End the ends, and Enter or a click picks and closes (custom dates stay open).
export function PeriodPicker<V extends string>({
  value,
  label,
  dates,
  compareShort,
  compareFull,
  progress,
  dayText,
  groups,
  onSelect,
  custom,
}: {
  value: V | typeof CUSTOM;
  label: string;
  dates: string | null;
  compareShort: string | null;
  compareFull: string | null;
  // The share of a running calendar period already gone, from 0 to 1, or null when none runs.
  progress: number | null;
  dayText: string | null;
  groups: PeriodGroup<V>[];
  onSelect: (value: V | typeof CUSTOM) => void;
  // The custom option's label and the fields it shows once picked; absent where custom dates are not offered.
  custom?: { label: string; fields: ReactNode } | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The option holding the listbox's one Tab stop: the selected one when the box opens, then whichever
  // the arrows or the pointer focused, so Tab leaves the list from where the focus is.
  const [active, setActive] = useState<string>(value);
  const listRef = useRef<HTMLDivElement>(null);
  // What has been typed to jump to an option, cleared after a pause, as a native select does.
  const typed = useRef({ text: "", at: 0 });
  // Custom dates just picked: their fields appear below the option, possibly under the box's fold on a
  // short screen, so they are scrolled into view once, and not again while they are edited.
  const fieldsRef = useRef<HTMLDivElement>(null);
  const revealFields = useRef(false);
  useEffect(() => {
    if (value !== CUSTOM || !revealFields.current) return;
    revealFields.current = false;
    fieldsRef.current?.scrollIntoView({ block: "nearest" });
  }, [value]);
  // A period changed from outside while the box is open (Back, under custom dates) can take the focused
  // field away with it; the focus then goes to the option now selected, so the list stays in reach.
  useEffect(() => {
    if (!open) return;
    const box = listRef.current?.closest('[role="dialog"]');
    if (box?.contains(document.activeElement)) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`)
      ?.focus();
  }, [value, open]);
  const id = useId();
  const periodLabel = t("dashboard.range.label", "Period");
  const options = (): HTMLButtonElement[] =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
  const columns: string[][] = groups.map((g) => g.options.map((o) => o.value));
  // A modified key is the browser's (Alt+Left goes back), never a move in the list.
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Any other key ends a typed search, so the next letter starts a new one.
    if (e.key.length !== 1) typed.current = { text: "", at: 0 };
    const all = options();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const current = all[at]?.dataset.value ?? "";
    const col = columns.findIndex((c) => c.includes(current));
    const row = col >= 0 ? (columns[col] as string[]).indexOf(current) : -1;
    const byValue = (v: string | undefined) =>
      all.find((b) => b.dataset.value === v);
    let next: HTMLButtonElement | undefined;
    switch (e.key) {
      case "ArrowDown":
        next = all[Math.min(at + 1, all.length - 1)];
        break;
      case "ArrowUp":
        next = all[Math.max(at - 1, 0)];
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        if (col < 0) return;
        const to = columns[col + (e.key === "ArrowRight" ? 1 : -1)];
        if (!to) return;
        next = byValue(to[Math.min(row, to.length - 1)]);
        break;
      }
      case "Home":
        next = all[0];
        break;
      case "End":
        next = all[all.length - 1];
        break;
      default: {
        if (e.key.length !== 1) return;
        const now = Date.now();
        const text =
          (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") +
          fold(e.key);
        typed.current = { text, at: now };
        // A repeated first letter steps through the options that start with it, from the one focused.
        const repeat = [...text].every((c) => c === text[0]);
        const from = repeat ? at + 1 : at;
        const ring = all.map((_, i) => all[(from + i) % all.length]);
        next = ring.find((b) =>
          fold(b?.textContent ?? "").startsWith(
            repeat ? (text[0] as string) : text,
          ),
        );
        // NOTE: a key that continues a search is the search's even when nothing matches, so a space
        // typed into "last x " never presses the option the focus is on.
        if (!next) {
          if (text.length > 1) e.preventDefault();
          return;
        }
      }
    }
    e.preventDefault();
    next?.focus();
  };
  // Picking the period already in use changes nothing, so it adds no entry to the history.
  const pick = (v: V | typeof CUSTOM) => {
    if (v !== value) onSelect(v);
    if (v !== CUSTOM) setOpen(false);
    else revealFields.current = true;
  };
  const option = (v: V | typeof CUSTOM, text: string) => (
    <button
      key={v}
      type="button"
      role="option"
      aria-selected={v === value}
      data-value={v}
      tabIndex={v === active ? 0 : -1}
      onFocus={() => setActive(v)}
      onClick={() => pick(v)}
      className={cn(
        "hover:bg-bg-tertiary focus-visible:outline-accent-solid rounded-md px-2 py-1 text-left text-sm outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid",
        { "bg-accent-soft text-accent font-medium": v === value },
      )}
    >
      {text}
    </button>
  );
  const twoLines = !!compareShort;
  const name = [
    `${periodLabel}: ${label}${dates ? ` · ${dates}` : ""}`,
    compareShort,
    dayText,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <ControlPopover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setActive(value);
          typed.current = { text: "", at: 0 };
        }
        setOpen(next);
      }}
      label={periodLabel}
      className="w-[30rem] p-0"
      trigger={
        <button
          type="button"
          aria-label={name}
          className={cn(
            "border-border-hover bg-bg-tertiary text-text-primary hover:border-border-focus focus:ring-accent-soft relative flex max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border px-2.5 text-left text-sm focus:ring-2 focus:outline-hidden",
            { "h-11": twoLines, "h-8": !twoLines },
          )}
        >
          <CalendarDays
            className="text-text-muted h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate whitespace-nowrap">
              <span className="font-medium">{label}</span>
              {dates && <span className="text-text-muted"> · {dates}</span>}
            </span>
            {twoLines && (
              <span className="text-text-muted truncate text-xs whitespace-nowrap">
                {compareShort}
              </span>
            )}
          </span>
          <ChevronDown
            className="text-text-muted h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          {progress !== null && (
            <span
              aria-hidden="true"
              data-progress={progress.toFixed(3)}
              className="bg-accent-solid absolute bottom-0 left-0 h-0.5"
              style={{ width: `${progress * 100}%` }}
            />
          )}
        </button>
      }
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={periodLabel}
        onKeyDown={move}
        className="flex flex-col"
      >
        <div className="grid grid-cols-2 gap-x-2 p-2">
          {groups.map((g, i) => (
            // biome-ignore lint/a11y/useSemanticElements: an option group of a listbox is ARIA's group role, a fieldset would make it a form section.
            <div
              key={g.label}
              role="group"
              aria-labelledby={`${id}-g${i}`}
              className="flex min-w-0 flex-col py-1"
            >
              <span
                id={`${id}-g${i}`}
                className="text-text-muted px-2 pb-1 text-xs font-medium"
              >
                {g.label}
              </span>
              {g.options.map((o) => option(o.value, o.label))}
            </div>
          ))}
        </div>
        {custom && (
          <div className="border-border flex flex-col border-t px-2 py-2">
            {option(CUSTOM, custom.label)}
          </div>
        )}
      </div>
      {custom && value === CUSTOM && (
        <div ref={fieldsRef} className="px-4 pb-3">
          {custom.fields}
        </div>
      )}
      {(dayText || compareFull) && (
        <div className="border-border bg-bg-secondary text-text-secondary flex flex-col gap-0.5 border-t px-4 py-2 text-xs">
          {dayText && <span>{dayText}</span>}
          {compareFull && <span>{compareFull}</span>}
        </div>
      )}
    </ControlPopover>
  );
}
