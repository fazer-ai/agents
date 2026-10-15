import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/client/components/Input";
import { Tooltip } from "@/client/components/Tooltip";
import { cn } from "@/client/lib/utils";
import {
  groupSelection,
  isEventCovered,
  matchingEvents,
  toggleEvent,
  toggleGroup,
  type WebhookEventGroup,
} from "@/client/lib/webhookEventGroups";
import {
  webhookEventDescription,
  webhookEventLabel,
  webhookFamilyLabel,
} from "@/client/lib/webhookEvents";

// The subscription's events, one collapsible group per family. A group's "all" box stores the family
// wildcard, which also receives events added to the family later, and says so. Groups open with the
// dialog only where something is selected; a search opens every group it matches.
export function WebhookEventPicker({
  groups,
  selected,
  onChange,
  disabled,
}: {
  groups: readonly WebhookEventGroup[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        groups
          .filter((g) => groupSelection(g, selected).covered > 0)
          .map((g) => g.family ?? ""),
      ),
  );
  const searching = query.trim().length > 0;
  const label = (ev: string) => webhookEventLabel(ev, t);
  const visible = groups
    .map((group) => ({
      group,
      key: group.family ?? "",
      familyLabel: webhookFamilyLabel(group.family, t),
      events: matchingEvents(
        group,
        query,
        label,
        webhookFamilyLabel(group.family, t),
      ),
    }))
    .filter((g) => g.events.length > 0);

  return (
    <div className="flex flex-col gap-2">
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // NOTE: the picker sits inside the subscription's form, where Enter would save the draft.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        disabled={disabled}
        placeholder={t("webhooks.searchEvents", "Search events")}
        aria-label={t("webhooks.searchEvents", "Search events")}
      />
      {visible.length === 0 && (
        <p className="px-1 text-text-muted text-xs">
          {t("webhooks.noEventsMatch", "No event matches the search.")}
        </p>
      )}
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {visible.map(({ group, key, familyLabel, events }) => {
          const state = groupSelection(group, selected);
          const expanded = searching || open.has(key);
          const allOn = group.wildcard
            ? state.wildcard
            : state.covered === state.total;
          const partial = !allOn && state.covered > 0;
          const listId = `wh-group-${key || "system"}`;
          return (
            <div key={key} data-family={key || "system"}>
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  disabled={searching}
                  onClick={() =>
                    setOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {expanded ? (
                    <ChevronDown
                      className="h-3.5 w-3.5 shrink-0 text-text-muted"
                      aria-hidden="true"
                    />
                  ) : (
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-text-muted"
                      aria-hidden="true"
                    />
                  )}
                  <span className="font-medium text-sm text-text-primary">
                    {familyLabel}
                  </span>
                  <span className="text-text-muted text-xs">
                    {state.wildcard
                      ? t(
                          "webhooks.groupAllFuture",
                          "All, includes future events",
                        )
                      : t("webhooks.groupCount", "{{covered}} of {{total}}", {
                          covered: state.covered,
                          total: state.total,
                        })}
                  </span>
                </button>
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = partial;
                  }}
                  disabled={disabled}
                  aria-label={
                    group.wildcard
                      ? t(
                          "webhooks.groupAllAria",
                          "All {{family}} events, including future ones",
                          { family: familyLabel },
                        )
                      : t(
                          "webhooks.groupAllPlainAria",
                          "All {{family}} events",
                          {
                            family: familyLabel,
                          },
                        )
                  }
                  onChange={() => onChange(toggleGroup(selected, group))}
                />
              </div>
              {expanded && (
                <ul id={listId} className="flex flex-col pb-1">
                  {events.map((ev) => {
                    const checked = isEventCovered(group, selected, ev);
                    const description = webhookEventDescription(ev, t);
                    return (
                      <li key={ev}>
                        <label
                          className={cn(
                            "flex items-start gap-3 py-1.5 pr-3 pl-8.5 transition-colors hover:bg-bg-hover",
                            { "text-text-primary": checked },
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-accent"
                            checked={checked}
                            disabled={disabled}
                            onChange={() =>
                              onChange(toggleEvent(selected, group, ev))
                            }
                          />
                          <span className="flex min-w-0 flex-col">
                            <Tooltip content={ev}>
                              <span className="self-start text-sm">
                                {webhookEventLabel(ev, t)}
                              </span>
                            </Tooltip>
                            {description && (
                              <span className="text-text-muted text-xs">
                                {description}
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
