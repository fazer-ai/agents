import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Search } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTimezoneLabel, listTimezones } from "@/client/lib/timezones";
import { cn } from "@/client/lib/utils";

const ALL_TIMEZONES = listTimezones();

type Props = {
  value: string;
  onChange: (tz: string) => void;
  disabled?: boolean;
  "aria-label"?: string;
};

export function TimezonePicker({
  value,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = search.trim()
    ? ALL_TIMEZONES.filter((tz) => {
        const q = search.toLowerCase();
        return (
          tz.toLowerCase().includes(q) ||
          formatTimezoneLabel(tz).toLowerCase().includes(q)
        );
      })
    : ALL_TIMEZONES;

  return (
    <DropdownMenuPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // NOTE: reset on OPEN, not close — clearing on close re-renders the full list while
        // the Radix exit animation still shows the content (visible flicker).
        if (next) setSearch("");
      }}
    >
      <DropdownMenuPrimitive.Trigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel ?? t("hours.timezone", "Timezone")}
          className="flex min-h-8 w-full items-center gap-2 rounded-md border border-border-hover bg-bg-tertiary py-1 pr-2.5 pl-2.5 text-sm text-text-primary transition-colors focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-60"
        >
          <span className="flex-1 truncate text-left">
            {value
              ? formatTimezoneLabel(value)
              : t("hours.selectTimezone", "Select timezone")}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-text-muted"
          />
        </button>
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          sideOffset={6}
          style={{
            zIndex: "calc(var(--z-modal) + 5)",
            minWidth: "var(--radix-dropdown-menu-trigger-width)",
          }}
          className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 rounded-lg border border-border bg-bg-secondary shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in"
        >
          <div className="flex items-center gap-1.5 border-border border-b px-2 py-1.5">
            <Search
              className="pointer-events-none h-4 w-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // NOTE: Block typeahead for printable characters so the menu's native typeahead
                // doesn't steal keystrokes; navigation keys pass through to keep arrow/esc working.
                if (
                  e.key.length === 1 ||
                  e.key === "Backspace" ||
                  e.key === "Delete"
                ) {
                  e.stopPropagation();
                }
              }}
              placeholder={t("hours.searchTimezone", "Search timezones…")}
              aria-label={t("hours.searchTimezone", "Search timezones…")}
              className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>

          <div className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-text-muted">
                {t(
                  "hours.noTimezoneResults",
                  "No timezones match your search.",
                )}
              </div>
            ) : (
              filtered.map((tz) => (
                <DropdownMenuPrimitive.Item
                  key={tz}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary"
                  onSelect={() => onChange(tz)}
                >
                  <span className="flex-1 truncate">
                    {formatTimezoneLabel(tz)}
                  </span>
                  <Check
                    aria-hidden="true"
                    className={cn("h-3.5 w-3.5 shrink-0", {
                      invisible: value !== tz,
                    })}
                  />
                </DropdownMenuPrimitive.Item>
              ))
            )}
          </div>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
