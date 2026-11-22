import { Plus, X } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ControlPopover } from "./ControlPopover";

export interface FilterChip {
  key: string;
  // "Agent: Ana": the filter's name and the value it narrows to.
  label: string;
  onClear: () => void;
}

// The filters that narrow a view, one removable chip each, and a "+ Filter" button that opens the
// editor. The caller decides which filters are chips: one at its default, or at a value that narrows
// nothing, is none.
export function FilterChips({
  chips,
  editor,
}: {
  chips: FilterChip[];
  editor: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  // The remove button that holds the focus. A chip can go by any change of the URL, Back included, and
  // the browser drops the focus of a removed node on the page body, so it goes to "+ Filter" instead.
  const focused = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const el = focused.current;
    if (!el || el.isConnected) return;
    focused.current = null;
    const active = document.activeElement;
    if (!active || active === document.body) addRef.current?.focus();
  });
  const filtersLabel = t("filters.label", "Filters");
  return (
    <ul
      aria-label={filtersLabel}
      className="m-0 flex max-w-full min-w-0 list-none flex-wrap items-center gap-1.5 p-0"
    >
      {chips.map((c) => (
        <li
          key={c.key}
          className="bg-accent-soft text-accent inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full pr-1 pl-2.5 text-xs font-medium"
        >
          <span className="truncate">{c.label}</span>
          <button
            type="button"
            // The removed chip takes its button away, and clearing one filter can take another chip with it,
            // so the focus goes to the one control that stays.
            onClick={() => {
              c.onClear();
              addRef.current?.focus();
            }}
            onFocus={(e) => {
              focused.current = e.currentTarget;
            }}
            onBlur={(e) => {
              // A blur from the removal itself must not forget the button before the check above runs.
              const el = e.currentTarget;
              queueMicrotask(() => {
                if (el.isConnected && focused.current === el)
                  focused.current = null;
              });
            }}
            aria-label={t("filters.remove", "Remove filter {{filter}}", {
              filter: c.label,
            })}
            className="hover:bg-bg-tertiary focus-visible:outline-accent-solid shrink-0 rounded-full p-0.5 outline-hidden focus-visible:outline-2 focus-visible:outline-solid"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </li>
      ))}
      <li className="inline-flex">
        <ControlPopover
          open={open}
          onOpenChange={setOpen}
          label={filtersLabel}
          className="w-80 p-3"
          trigger={
            <button
              ref={addRef}
              type="button"
              className="border-border-hover text-text-secondary hover:text-text-primary focus:ring-accent-soft inline-flex h-7 items-center gap-1 rounded-full border border-dashed px-2.5 text-xs focus:ring-2 focus:outline-hidden"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              {t("filters.add", "Filter")}
            </button>
          }
        >
          {editor}
        </ControlPopover>
      </li>
    </ul>
  );
}
