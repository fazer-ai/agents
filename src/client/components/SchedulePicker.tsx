import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BusinessHoursForm,
  type ScheduleException,
} from "@/client/components/BusinessHoursForm";
import { Button } from "@/client/components/Button";
import { Modal, useModalController } from "@/client/components/Modal";
import { formatTimezoneLabel } from "@/client/lib/timezones";
import { cn } from "@/client/lib/utils";
import { formatWindowsSummary } from "@/modules/business-hours/announce";
import type { WindowSpec } from "@/modules/business-hours/hours";

export type ScheduleOption = {
  id: string;
  name: string;
  windows: WindowSpec[];
  exceptions: ScheduleException[];
  timezone: string;
};

type Props = {
  value: string;
  onChange: (id: string) => void;
  schedules: ScheduleOption[];
  emptyLabel: string;
  emptySummary?: string;
  disabled?: boolean;
  "aria-label"?: string;
  // Called after a schedule is created or edited (with the saved id). The parent
  // is responsible for re-fetching the schedules list and, on create, selecting
  // the returned id if desired.
  onScheduleSaved?: (id: string) => void;
};

function ScheduleSummary({
  windows,
  exceptions,
  timezone,
}: {
  windows: WindowSpec[];
  exceptions: ScheduleException[];
  timezone: string;
}) {
  const { t, i18n } = useTranslation();
  const summary = formatWindowsSummary(
    windows,
    t("schedule.noWindows", "No windows"),
    i18n.language,
  );
  // The count, not the dates: the summary line is one truncated row, and what the operator needs from
  // it is whether this schedule has a second dimension at all before opening the editor.
  const extra =
    exceptions.length > 0
      ? ` · ${t("schedule.exceptionCount", "{{count}} exception", { count: exceptions.length })}`
      : "";
  return (
    <span className="truncate">
      {`${summary} · ${formatTimezoneLabel(timezone)}${extra}`}
    </span>
  );
}

const itemCls =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary";

export function SchedulePicker({
  value,
  onChange,
  schedules,
  emptyLabel,
  emptySummary,
  disabled,
  "aria-label": ariaLabel,
  onScheduleSaved,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const createModal = useModalController();
  const editModal = useModalController();

  const selected = schedules.find((s) => s.id === value) ?? null;

  return (
    <div className="flex min-w-0 items-stretch gap-2">
      <DropdownMenuPrimitive.Root open={open} onOpenChange={setOpen}>
        <DropdownMenuPrimitive.Trigger asChild disabled={disabled}>
          <button
            type="button"
            disabled={disabled}
            aria-label={ariaLabel}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-bg-tertiary py-2 pr-3 pl-3 text-left focus:border-border-focus focus:outline-none disabled:opacity-60"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-text-primary">
                {selected ? selected.name : emptyLabel}
              </span>
              <span className="truncate text-text-muted text-xs">
                {selected ? (
                  <ScheduleSummary
                    windows={selected.windows}
                    exceptions={selected.exceptions}
                    timezone={selected.timezone}
                  />
                ) : (
                  (emptySummary ?? null)
                )}
              </span>
            </div>
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
            className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-1 shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in"
          >
            {/* Empty / default option */}
            <DropdownMenuPrimitive.Item
              className={itemCls}
              onSelect={() => onChange("")}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{emptyLabel}</span>
                {emptySummary && (
                  <span className="truncate text-text-muted text-xs">
                    {emptySummary}
                  </span>
                )}
              </div>
              <Check
                aria-hidden="true"
                className={cn("h-3.5 w-3.5 shrink-0", {
                  invisible: value !== "",
                })}
              />
            </DropdownMenuPrimitive.Item>

            {schedules.map((s) => (
              <DropdownMenuPrimitive.Item
                key={s.id}
                className={itemCls}
                onSelect={() => onChange(s.id)}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{s.name}</span>
                  <span className="truncate text-text-muted text-xs">
                    <ScheduleSummary
                      windows={s.windows}
                      exceptions={s.exceptions}
                      timezone={s.timezone}
                    />
                  </span>
                </div>
                <Check
                  aria-hidden="true"
                  className={cn("h-3.5 w-3.5 shrink-0", {
                    invisible: value !== s.id,
                  })}
                />
              </DropdownMenuPrimitive.Item>
            ))}

            <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
            <DropdownMenuPrimitive.Item
              className={itemCls}
              onSelect={() => createModal.open()}
            >
              <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t("schedulePicker.new", "New schedule")}</span>
            </DropdownMenuPrimitive.Item>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>

      {selected && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-auto shrink-0 self-stretch"
          onClick={() => editModal.open()}
          disabled={disabled}
          aria-label={t("schedulePicker.edit", "Edit schedule")}
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}

      <Modal
        modal={createModal}
        size="lg"
        title={t("hours.addTitle", "New schedule")}
      >
        <BusinessHoursForm
          mode="create"
          onSaved={(id) => {
            createModal.close();
            onScheduleSaved?.(id);
          }}
          onCancel={() => createModal.close()}
        />
      </Modal>

      <Modal
        modal={editModal}
        size="lg"
        title={t("hours.editTitle", "Edit schedule")}
      >
        <BusinessHoursForm
          mode="update"
          initial={
            selected
              ? {
                  id: selected.id,
                  name: selected.name,
                  timezone: selected.timezone,
                  windows: selected.windows,
                  exceptions: selected.exceptions,
                }
              : undefined
          }
          onSaved={(id) => {
            editModal.close();
            onScheduleSaved?.(id);
          }}
          onCancel={() => editModal.close()}
        />
      </Modal>
    </div>
  );
}
