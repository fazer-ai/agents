import { Plus, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { FormField } from "@/client/components/FormField";
import { Input } from "@/client/components/Input";
import { useUnsavedChanges } from "@/client/components/Modal";
import { Select } from "@/client/components/Select";
import { TimezonePicker } from "@/client/components/TimezonePicker";
import { useToast } from "@/client/components/Toast";
import { api } from "@/client/lib/api";

type HoursData = Awaited<
  ReturnType<(typeof api.api.v1)["business-hours"]["get"]>
>["data"];
type Window =
  NonNullable<HoursData>["businessHours"][number]["windows"][number];
type Exception =
  NonNullable<HoursData>["businessHours"][number]["exceptions"][number];
type Range = Exception["ranges"][number];

export type WindowSpec = Window;
export type ScheduleException = Exception;

const BROWSER_TZ =
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";

// Mon–Fri 08:00–18:00 default windows for new schedules.
const DEFAULT_WINDOWS: Window[] = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: "08:00",
  end: "18:00",
}));

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Today as YYYY-MM-DD in the VIEWER's zone. Only a starting value for a new row: the operator picks
// the real date, and the schedule's own timezone is what the server matches on.
function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

// A window is invalid when its end is not strictly after its start. The editor
// surfaces this in yellow and blocks the save; the server rejects it too.
function windowInvalid(w: Window): boolean {
  return toMinutes(w.start) >= toMinutes(w.end);
}

// An exception is invalid when it has no date, when a dated span runs backwards, or when any of its
// ranges does. A RECURRING span may run backwards: that is how a year-end shutdown is written.
function exceptionInvalid(e: Exception): boolean {
  if (!e.date) return true;
  if (e.dateEnd && !e.recurring && e.dateEnd < e.date) return true;
  return e.ranges.some((r) => toMinutes(r.start) >= toMinutes(r.end));
}

export interface BusinessHoursFormProps {
  mode: "create" | "update";
  initial?: {
    id: string;
    name: string;
    timezone: string;
    windows: Window[];
    // Required, not optional: the form PATCHes this field unconditionally, so a caller that omits it
    // initializes to [] and silently deletes every holiday the operator had. Three call sites build
    // this object; making it required is what stops a fourth from repeating that.
    exceptions: Exception[];
  };
  onSaved: (id: string, name: string) => void;
  onCancel: () => void;
}

// Extracted form for creating or editing a business-hours schedule. Used by
// BusinessHoursPanel (via modal) and SchedulePicker (inline create/edit).
// When rendered inside a <Modal>, calls useUnsavedChanges so the modal's
// discard-confirmation guard fires automatically on dirty state.
export function BusinessHoursForm({
  mode,
  initial,
  onSaved,
  onCancel,
}: BusinessHoursFormProps) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();

  const defaultName =
    mode === "create" ? t("hours.defaultName", "Business hours") : "";

  const [name, setName] = useState(initial?.name ?? defaultName);
  const [timezone, setTimezone] = useState(initial?.timezone ?? BROWSER_TZ);
  const [windows, setWindows] = useState<Window[]>(
    initial?.windows ?? DEFAULT_WINDOWS,
  );
  const [exceptions, setExceptions] = useState<Exception[]>(
    initial?.exceptions ?? [],
  );

  const [saving, setSaving] = useState(false);

  const baselineRef = useRef<string>(
    JSON.stringify({
      name: initial?.name ?? defaultName,
      timezone: initial?.timezone ?? BROWSER_TZ,
      windows: initial?.windows ?? DEFAULT_WINDOWS,
      exceptions: initial?.exceptions ?? [],
    }),
  );

  const isDirty =
    JSON.stringify({ name, timezone, windows, exceptions }) !==
    baselineRef.current;

  // Register dirty state with the enclosing <Modal> (no-op outside a modal).
  useUnsavedChanges(isDirty);

  // 2024-01-07 is a Sunday, so Date.UTC(2024,0,7+d) maps d=0..6 → Sun..Sat
  // (windowSpec.day convention). timeZone UTC keeps the weekday stable
  // regardless of the viewer's zone (without it, negative-offset viewers see
  // each day shifted back one).
  const dayName = useCallback(
    (d: number) =>
      new Intl.DateTimeFormat(i18n.language, {
        weekday: "long",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2024, 0, 7 + d))),
    [i18n.language],
  );

  function updateWindow(i: number, patch: Partial<Window>) {
    setWindows((prev) =>
      prev.map((w, idx) => (idx === i ? { ...w, ...patch } : w)),
    );
  }

  // Each field edits independently. A crossed/equal range (start >= end) is left
  // as the operator typed it and simply flagged invalid (yellow + message), which
  // blocks the save until they fix it — no surprising counterpart auto-adjust.
  function setStart(i: number, value: string) {
    if (!TIME_RE.test(value)) return; // ignore a cleared/partial time input
    setWindows((prev) =>
      prev.map((w, idx) => (idx === i ? { ...w, start: value } : w)),
    );
  }

  function setEnd(i: number, value: string) {
    if (!TIME_RE.test(value)) return; // ignore a cleared/partial time input
    setWindows((prev) =>
      prev.map((w, idx) => (idx === i ? { ...w, end: value } : w)),
    );
  }

  function updateException(i: number, patch: Partial<Exception>) {
    setExceptions((prev) =>
      prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)),
    );
  }

  function updateRange(i: number, ri: number, patch: Partial<Range>) {
    setExceptions((prev) =>
      prev.map((e, idx) =>
        idx === i
          ? {
              ...e,
              ranges: e.ranges.map((r, rIdx) =>
                rIdx === ri ? { ...r, ...patch } : r,
              ),
            }
          : e,
      ),
    );
  }

  const hasInvalidWindow = windows.some(windowInvalid);
  const hasInvalidException = exceptions.some(exceptionInvalid);

  async function save() {
    if (!name.trim()) return;
    if (hasInvalidException) {
      showToast(
        t(
          "hours.invalidExceptionsSave",
          "Fix the highlighted exceptions before saving.",
        ),
        "error",
      );
      return;
    }
    if (hasInvalidWindow) {
      showToast(
        t(
          "hours.invalidWindowsSave",
          "Fix the highlighted windows before saving.",
        ),
        "error",
      );
      return;
    }
    setSaving(true);
    const body = {
      name: name.trim(),
      timezone: timezone.trim() || "UTC",
      windows,
      exceptions,
    };
    try {
      if (mode === "update" && initial?.id) {
        const { data, error: err } = await api.api.v1["business-hours"]({
          id: initial.id,
        }).patch(body);
        if (err || !data) throw err;
        showToast(t("hours.saved", "Business hours saved."), "success");
        onSaved(data.businessHours.id, data.businessHours.name);
      } else {
        const { data, error: err } =
          await api.api.v1["business-hours"].post(body);
        if (err || !data) throw err;
        showToast(t("hours.saved", "Business hours saved."), "success");
        onSaved(data.businessHours.id, data.businessHours.name);
      }
    } catch {
      showToast(
        t("hours.saveError", "Could not save (check the timezone)."),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t("hours.name", "Name")} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label={t("hours.timezone", "Timezone")} group>
          <TimezonePicker
            value={timezone}
            onChange={setTimezone}
            aria-label={t("hours.timezone", "Timezone")}
          />
        </FormField>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm text-text-secondary">
            {t("hours.windows", "Windows")}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setWindows((prev) => [
                ...prev,
                { day: 1, start: "09:00", end: "18:00" },
              ])
            }
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("hours.addWindow", "Add window")}
          </Button>
        </div>
        {windows.length === 0 ? (
          <p className="text-sm text-text-muted">
            {t("hours.alwaysOpen", "No windows = always open.")}
          </p>
        ) : (
          windows.map((w, i) => {
            const invalid = windowInvalid(w);
            const invalidClass = invalid
              ? "border-warning ring-1 ring-warning"
              : undefined;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: windows are positional and edited in place; no stable id exists client-side.
                key={i}
                className="flex flex-col gap-1"
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={String(w.day)}
                    onChange={(e) =>
                      updateWindow(i, { day: Number(e.target.value) })
                    }
                    aria-label={t("hours.day", "Day")}
                  >
                    {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                      <option key={d} value={d}>
                        {dayName(d)}
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="time"
                    value={w.start}
                    onChange={(e) => setStart(i, e.target.value)}
                    aria-label={t("hours.start", "Start")}
                    aria-invalid={invalid || undefined}
                    className={invalidClass}
                  />
                  <Input
                    type="time"
                    value={w.end}
                    onChange={(e) => setEnd(i, e.target.value)}
                    aria-label={t("hours.end", "End")}
                    aria-invalid={invalid || undefined}
                    className={invalidClass}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setWindows((prev) => prev.filter((_, idx) => idx !== i))
                    }
                    aria-label={t("hours.removeWindow", "Remove window")}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
                {invalid && (
                  <p className="text-warning text-xs">
                    {t("hours.invalidWindow", "End must be after start.")}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm text-text-secondary">
            {t("hours.exceptions", "Holidays and closures")}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setExceptions((prev) => [
                ...prev,
                { date: todayLocal(), label: "", ranges: [] },
              ])
            }
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("hours.addException", "Add date")}
          </Button>
        </div>
        <p className="text-text-muted text-xs">
          {t(
            "hours.exceptionsHint",
            "A date listed here replaces the weekly windows above. With no hours it is closed all day.",
          )}
        </p>
        {exceptions.map((e, i) => {
          const invalid = exceptionInvalid(e);
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: exceptions are positional and edited in place; no stable id exists client-side.
              key={i}
              className={`flex flex-col gap-2 rounded-md border p-2 ${
                invalid ? "border-warning" : "border-border"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  value={e.date}
                  onChange={(ev) =>
                    updateException(i, { date: ev.target.value })
                  }
                  aria-label={t("hours.exceptionDate", "Date")}
                  aria-invalid={invalid || undefined}
                />
                <span className="text-text-muted text-xs">
                  {t("hours.exceptionUntil", "through")}
                </span>
                <Input
                  type="date"
                  value={e.dateEnd ?? ""}
                  onChange={(ev) =>
                    updateException(i, {
                      dateEnd: ev.target.value || undefined,
                    })
                  }
                  aria-label={t("hours.exceptionDateEnd", "Last date")}
                />
                <Input
                  value={e.label ?? ""}
                  onChange={(ev) =>
                    updateException(i, { label: ev.target.value })
                  }
                  placeholder={t("hours.exceptionLabel", "Name")}
                  aria-label={t("hours.exceptionLabel", "Name")}
                  className="min-w-32 flex-1"
                />
                <label className="flex items-center gap-1 text-text-secondary text-xs">
                  <input
                    type="checkbox"
                    checked={e.recurring === true}
                    onChange={(ev) =>
                      updateException(i, { recurring: ev.target.checked })
                    }
                  />
                  {t("hours.exceptionRecurring", "Every year")}
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setExceptions((prev) => prev.filter((_, idx) => idx !== i))
                  }
                  aria-label={t("hours.removeException", "Remove date")}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {e.ranges.length === 0 ? (
                  <span className="text-sm text-text-muted">
                    {t("hours.exceptionClosed", "Closed all day")}
                  </span>
                ) : (
                  e.ranges.map((r, ri) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: ranges are positional and edited in place; no stable id exists client-side.
                      key={ri}
                      className="flex items-center gap-1"
                    >
                      <Input
                        type="time"
                        value={r.start}
                        onChange={(ev) => {
                          if (!TIME_RE.test(ev.target.value)) return;
                          updateRange(i, ri, { start: ev.target.value });
                        }}
                        aria-label={t("hours.start", "Start")}
                      />
                      <Input
                        type="time"
                        value={r.end}
                        onChange={(ev) => {
                          if (!TIME_RE.test(ev.target.value)) return;
                          updateRange(i, ri, { end: ev.target.value });
                        }}
                        aria-label={t("hours.end", "End")}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          updateException(i, {
                            ranges: e.ranges.filter((_, idx) => idx !== ri),
                          })
                        }
                        aria-label={t("hours.removeWindow", "Remove window")}
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  ))
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    updateException(i, {
                      ranges: [...e.ranges, { start: "09:00", end: "12:00" }],
                    })
                  }
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t("hours.addExceptionRange", "Add hours")}
                </Button>
              </div>
              {invalid && (
                <p className="text-warning text-xs">
                  {t(
                    "hours.invalidException",
                    "Check the date and that every end is after its start.",
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button onClick={save} loading={saving} disabled={!name.trim()}>
          {t("common.save", "Save")}
        </Button>
      </div>
    </div>
  );
}
