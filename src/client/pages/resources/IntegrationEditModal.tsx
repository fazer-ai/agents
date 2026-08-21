import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Plus,
  RefreshCw,
  Webhook,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  CredentialPicker,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  type ScheduleOption,
  SchedulePicker,
  Select,
  Skeleton,
  SwitchField,
  Tabs,
  TimezonePicker,
  ToolArgPills,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import { api } from "@/client/lib/api";
import { credentialCompat } from "@/client/lib/credentialCompat";
import {
  toolpackToolMeta,
  withToolpackArgNotes,
} from "@/client/lib/toolpackTools";

type CatalogData = Awaited<
  ReturnType<typeof api.api.v1.integrations.catalog.get>
>["data"];
type CatalogEntry = NonNullable<CatalogData>["catalog"][number];

const AUTH_STRATEGIES = ["NONE", "STATIC_HEADER", "HMAC_SHA256"] as const;
type AuthStrategy = (typeof AUTH_STRATEGIES)[number];

// The brand mark a catalogType renders (ServiceLogo key). Calendar and Drive get their own
// product logos instead of the generic Google "G".
function serviceFor(catalogType: string): string {
  switch (catalogType) {
    case "ASAAS":
      return "asaas";
    case "GOOGLE_CALENDAR":
      return "google_calendar";
    case "GOOGLE_DRIVE":
      return "google_drive";
    default:
      return catalogType.startsWith("GOOGLE_") ? "google" : "";
  }
}

// Mirrors MAX_BLOCKING_CALENDARS in the google-calendar toolpack: past this, availability refuses
// (fail-closed), so the picker warns before the operator saves a config the runtime will reject.
const BLOCKING_CALENDARS_LIMIT = 10;

// Appointment sizing options (minutes), mirroring the n8n v3 allowlist. Duration = the appointment
// length; granularity = the spacing between candidate start times (15 ⇒ 09:00 and 09:15 both offered).
const SLOT_DURATIONS = [15, 20, 30, 45, 60, 90, 120] as const;
const SLOT_GRANULARITIES = [5, 10, 15, 20, 30, 60] as const;

// Maps a BusinessHours DTO to the SchedulePicker's option shape (id as string, windows passed through).
function toScheduleOption(h: {
  id: string;
  name: string;
  windows?: unknown;
  exceptions?: unknown;
  timezone: string;
}): ScheduleOption {
  return {
    id: String(h.id),
    name: h.name,
    windows: (h.windows ?? []) as ScheduleOption["windows"],
    exceptions: (h.exceptions ?? []) as ScheduleOption["exceptions"],
    timezone: h.timezone,
  };
}

type Form = {
  catalogType: string;
  name: string;
  credentialRef: string;
  enabled: boolean;
  config: Record<string, unknown>;
  inboundAuthStrategy: AuthStrategy;
  inboundSecretRef: string;
};

// Default config seed per toolpack (only the keys the modal surfaces; runtime fills the rest).
function defaultConfig(catalogType: string): Record<string, unknown> {
  switch (catalogType) {
    case "ASAAS":
      return { environment: "sandbox", notifyOnPayment: true };
    case "GOOGLE_CALENDAR":
      return {
        calendarIds: [],
        calendarLabels: {},
        blockingCalendarIds: [],
        timeZone: "America/Sao_Paulo",
        businessHoursId: "",
        slotDurationMinutes: 30,
        slotGranularityMinutes: 15,
        createMeetLink: true,
        appointmentReminders: {
          enabled: false,
          offsetsHours: [24, 1],
          askConfirmationOnLast: true,
        },
      };
    case "GOOGLE_DRIVE":
      return { folderId: "", folderName: "" };
    default:
      return {};
  }
}

type ReminderUnit = "hours" | "days";
interface ReminderRow {
  value: string;
  unit: ReminderUnit;
}

const REMINDER_MAX_ROWS = 5;

function readReminderCfg(cfg: Record<string, unknown>): {
  enabled: boolean;
  offsetsHours: number[];
  askConfirmationOnLast: boolean;
} {
  const ar = (cfg.appointmentReminders ?? {}) as Record<string, unknown>;
  const offsets = Array.isArray(ar.offsetsHours)
    ? (ar.offsetsHours as unknown[]).filter(
        (x): x is number =>
          typeof x === "number" && Number.isFinite(x) && x > 0,
      )
    : [];
  return {
    enabled: ar.enabled === true,
    offsetsHours: offsets,
    askConfirmationOnLast: ar.askConfirmationOnLast !== false,
  };
}

// hours → editable rows: collapse whole-day multiples ABOVE 24h to "N days" for readability. 24h itself
// stays "24 hours" (clearer than "1 day", and keeps the common [24, 1] default reading as 24h + 1h).
function hoursToRows(offsets: number[]): ReminderRow[] {
  return offsets.map((h) =>
    h > 24 && h % 24 === 0
      ? { value: String(h / 24), unit: "days" as const }
      : { value: String(h), unit: "hours" as const },
  );
}

// rows → canonical hours[]: parse, days→hours, drop invalid, de-dup, sort far→near (matches the
// server-side normalizeOffsets so the saved value round-trips).
function rowsToHours(rows: ReminderRow[]): number[] {
  const hrs: number[] = [];
  for (const r of rows) {
    const n = Math.round(Number(r.value));
    if (!Number.isFinite(n) || n <= 0) continue;
    hrs.push(r.unit === "days" ? n * 24 : n);
  }
  return [...new Set(hrs)].sort((a, b) => b - a);
}

// Editor for the Calendar integration's appointment-reminder policy. The rows are held LOCALLY (so a
// half-typed/empty row survives the keystroke) and the canonical hours[] is synced into the shared
// integration config on every change. The policy lives on the integration (every agent that uses this
// Calendar inherits it), NOT on the agent.
function ReminderConfigEditor({
  cfg,
  setCfg,
}: {
  cfg: Record<string, unknown>;
  setCfg: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const initial = readReminderCfg(cfg);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [rows, setRows] = useState<ReminderRow[]>(
    hoursToRows(
      initial.offsetsHours.length > 0 ? initial.offsetsHours : [24, 1],
    ),
  );
  const [askConfirmation, setAskConfirmation] = useState(
    initial.askConfirmationOnLast,
  );

  function persist(next: {
    enabled?: boolean;
    rows?: ReminderRow[];
    askConfirmation?: boolean;
  }) {
    setCfg({
      appointmentReminders: {
        enabled: next.enabled ?? enabled,
        offsetsHours: rowsToHours(next.rows ?? rows),
        askConfirmationOnLast: next.askConfirmation ?? askConfirmation,
      },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-text-muted text-xs">
        {t(
          "integrations.config.remindersHint",
          "When the agent books an appointment on this calendar, send reminder messages before it. Reminders are scheduled deterministically and re-armed if the appointment is rescheduled or cancelled.",
        )}
      </p>
      <SwitchField
        checked={enabled}
        onCheckedChange={(v) => {
          setEnabled(v);
          persist({ enabled: v });
        }}
        label={t(
          "integrations.config.remindersEnabled",
          "Send reminders before booked appointments",
        )}
      />
      {enabled && (
        <>
          <FormField
            label={t(
              "integrations.config.remindersOffsets",
              "Reminders before the appointment",
            )}
            group
          >
            <div className="flex flex-col gap-2">
              {rows.map((row, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: editable rows; the index is the stable identity (values change as the operator types)
                  key={`rem-${i}`}
                  className="flex items-center gap-2"
                >
                  <div className="w-24 shrink-0">
                    <Input
                      type="number"
                      min={1}
                      value={row.value}
                      aria-label={t(
                        "integrations.config.remindersAmount",
                        "Amount",
                      )}
                      onChange={(e) => {
                        const next = rows.map((x, j) =>
                          j === i ? { ...x, value: e.target.value } : x,
                        );
                        setRows(next);
                        persist({ rows: next });
                      }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Select
                      aria-label={t(
                        "integrations.config.remindersUnit",
                        "Unit",
                      )}
                      value={row.unit}
                      onChange={(e) => {
                        const next = rows.map((x, j) =>
                          j === i
                            ? { ...x, unit: e.target.value as ReminderUnit }
                            : x,
                        );
                        setRows(next);
                        persist({ rows: next });
                      }}
                    >
                      <option value="hours">
                        {t(
                          "integrations.config.remindersUnitHours",
                          "hours before",
                        )}
                      </option>
                      <option value="days">
                        {t(
                          "integrations.config.remindersUnitDays",
                          "days before",
                        )}
                      </option>
                    </Select>
                  </div>
                  <button
                    type="button"
                    aria-label={t("common.remove", "Remove")}
                    onClick={() => {
                      const next = rows.filter((_, j) => j !== i);
                      setRows(next);
                      persist({ rows: next });
                    }}
                    className="shrink-0 rounded-lg border border-border p-2 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
              {rows.length < REMINDER_MAX_ROWS && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    const next: ReminderRow[] = [
                      ...rows,
                      { value: "1", unit: "hours" },
                    ];
                    setRows(next);
                    persist({ rows: next });
                  }}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t("integrations.config.remindersAdd", "Add reminder")}
                </Button>
              )}
              <p className="text-text-muted text-xs">
                {t(
                  "integrations.config.remindersOffsetsHint",
                  "The closest reminder is the one that can ask for confirmation. Minimum 1 hour before the start.",
                )}
              </p>
            </div>
          </FormField>
          <SwitchField
            checked={askConfirmation}
            onCheckedChange={(v) => {
              setAskConfirmation(v);
              persist({ askConfirmation: v });
            }}
            label={t(
              "integrations.config.remindersConfirm",
              "Ask for confirmation on the last reminder",
            )}
          />
        </>
      )}
    </div>
  );
}

// A multi-select over the credential's fetched calendars plus hand-typed ids (shared calendars the
// list does not return). Shared by the allowed-calendars and blocking-calendars pickers; the parent
// owns the selection semantics (which config key, whether labels are captured).
function CalendarMultiPicker({
  cals,
  selectedIds,
  onToggle,
  manualIds,
  onManualChange,
}: {
  cals: { id: string; summary: string; primary?: boolean }[];
  selectedIds: string[];
  onToggle: (cal: { id: string; summary: string }, on: boolean) => void;
  manualIds: string[];
  onManualChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      {cals.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {cals.map((c) => {
            const checked = selectedIds.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={checked}
                onClick={() => onToggle(c, !checked)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                  checked
                    ? "border-accent bg-accent-soft"
                    : "border-border hover:bg-bg-hover"
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    checked
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border"
                  }`}
                >
                  {checked && <Check className="h-3 w-3" aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm text-text-primary">
                    {c.summary}
                    {c.primary && (
                      <span className="ml-1.5 text-text-muted text-xs">
                        {t("integrations.config.calendarPrimary", "(primary)")}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-text-muted text-xs">
                    {c.id}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {/* Advanced: shared calendars not returned by the list, typed by id. */}
      {manualIds.map((id, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: editable free-text rows; the index is the stable identity (the value changes as the operator types)
          key={`cal-${i}`}
          className="flex items-center gap-2"
        >
          <Input
            value={id}
            placeholder={t(
              "integrations.config.calendarPlaceholder",
              "Calendar ID (e.g. team@group.calendar.google.com)",
            )}
            aria-label={t(
              "integrations.config.calendarManualAria",
              "Manual calendar ID {{index}}",
              { index: i + 1 },
            )}
            onChange={(e) => {
              const next = [...manualIds];
              next[i] = e.target.value;
              onManualChange(next);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onManualChange(manualIds.filter((_, j) => j !== i))}
            aria-label={t("common.remove", "Remove")}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onManualChange([...manualIds, ""])}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t("integrations.config.addCalendarById", "Add by ID")}
      </Button>
    </div>
  );
}

function emptyForm(): Form {
  return {
    catalogType: "",
    name: "",
    credentialRef: "",
    enabled: true,
    config: {},
    inboundAuthStrategy: "NONE",
    inboundSecretRef: "",
  };
}

// Per-toolpack create/edit modal for an integration instance. Shared by the Components → Integrations
// panel and the agent editor's Tools tab. It fetches the catalog (with each toolpack's tool specs),
// renders a SERVICE-specific form (Asaas charges + webhook, Calendar allowlist, Drive folder), lists
// the tools the integration exposes (label/description/args, never internal names), and reveals the
// inbound webhook URL once after creating an Asaas instance. `onSaved` lets the caller refetch.
export function IntegrationEditModal({
  modal,
  onSaved,
  sharedNotice,
}: {
  modal: ModalController<{ id?: string }>;
  onSaved?: (saved: { id: string; name: string }, isNew: boolean) => void;
  sharedNotice?: boolean;
}) {
  const { t } = useTranslation();
  const catalogLabel = (c: CatalogEntry | undefined) => {
    switch (c?.catalogType) {
      case "ASAAS":
        return t("integrations.catalog.ASAAS.label", "Asaas");
      case "GOOGLE_CALENDAR":
        return t(
          "integrations.catalog.GOOGLE_CALENDAR.label",
          "Google Calendar",
        );
      case "GOOGLE_DRIVE":
        return t("integrations.catalog.GOOGLE_DRIVE.label", "Google Drive");
      default:
        return c?.label ?? "";
    }
  };
  const catalogDescription = (c: CatalogEntry | undefined) => {
    switch (c?.catalogType) {
      case "ASAAS":
        return t(
          "integrations.catalog.ASAAS.description",
          "Brazilian payments. Create payment links and PIX charges; when a charge is paid, the agent is woken on the conversation that generated it.",
        );
      case "GOOGLE_CALENDAR":
        return t(
          "integrations.catalog.GOOGLE_CALENDAR.description",
          "Scheduling over a connected Google account, restricted to an allowlist of calendars.",
        );
      case "GOOGLE_DRIVE":
        return t(
          "integrations.catalog.GOOGLE_DRIVE.description",
          "Find a file, get its link, or send it to the customer over a connected Google account.",
        );
      default:
        return c?.description ?? "";
    }
  };
  const authStrategyLabel = (s: AuthStrategy) => {
    switch (s) {
      case "STATIC_HEADER":
        return t(
          "integrations.inboundAuthStrategy.STATIC_HEADER",
          "Static header",
        );
      case "HMAC_SHA256":
        return t(
          "integrations.inboundAuthStrategy.HMAC_SHA256",
          "HMAC SHA-256",
        );
      default:
        return t("integrations.inboundAuthStrategy.NONE", "None");
    }
  };
  const { showToast } = useToast();
  const tokenModal = useModalController<{ url: string }>();
  const rotateConfirm = useModalController<ConfirmPayload>();
  // NOTE: The instance's inbound webhook token, read back on edit so the operator can copy the URL
  // again. When it is null the STATUS says why: "absent" (nothing was ever stored — an instance
  // older than this feature) vs "unreadable" (a blob the key can no longer decrypt). Both are fixed
  // by rotating, but pointing at the wrong cause sends the operator hunting in the wrong place.
  const [routeToken, setRouteToken] = useState<string | null>(null);
  const [routeTokenStatus, setRouteTokenStatus] = useState<
    "present" | "absent" | "unreadable"
  >("absent");
  const [rotating, setRotating] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [form, setForm] = useState<Form>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [loadingForm, setLoadingForm] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Google Calendar: the calendars the connected credential can see (picker source).
  const [availableCals, setAvailableCals] = useState<
    { id: string; summary: string; primary: boolean; accessRole: string }[]
  >([]);
  const [calLoading, setCalLoading] = useState(false);
  const [calError, setCalError] = useState(false);
  // Google Drive: the folders the connected credential can see (search-scope picker source).
  const [availableFolders, setAvailableFolders] = useState<
    { id: string; name: string }[]
  >([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError] = useState(false);
  // True once a folder load has SUCCEEDED (even with zero folders) — lets the picker tell "not loaded
  // yet" apart from "loaded and the account exposed no folders" (the drive.file-scope symptom).
  const [folderLoaded, setFolderLoaded] = useState(false);
  const [folderFilter, setFolderFilter] = useState("");
  // Google Calendar: the tenant's BusinessHours, so the operator picks a service-hours schedule that
  // bounds bookable slots (reuses the same SchedulePicker as the agent editor).
  const [schedules, setSchedules] = useState<ScheduleOption[]>([]);
  // Whether the duration/granularity selects are in free-text "custom" mode (a value off the preset
  // list). Derived from the loaded config; toggled by the "Custom…" option.
  const [durationCustom, setDurationCustom] = useState(false);
  const [granularityCustom, setGranularityCustom] = useState(false);
  // Active sub-tab for the Google Calendar config (calendars allowlist vs appointment reminders).
  const [calTab, setCalTab] = useState<"calendars" | "reminders">("calendars");
  const formBaseline = useRef("");

  // Fetches the calendars a google_oauth credential can access, so the operator picks from real
  // agendas instead of typing opaque ids. Takes the ref explicitly to avoid stale form state.
  async function loadCalendars(ref: string) {
    if (!ref) return;
    setCalError(false);
    setCalLoading(true);
    try {
      const { data, error } =
        await api.api.v1.integrations.google.calendars.get({
          query: { credentialRef: ref },
        });
      if (error || !data) {
        setCalError(true);
        return;
      }
      setAvailableCals(data.calendars);
    } catch {
      setCalError(true);
    } finally {
      setCalLoading(false);
    }
  }

  // Fetches the folders a google_oauth credential can access, so the operator searches and picks one
  // to scope file search to instead of pasting an opaque folder id. Mirrors loadCalendars.
  async function loadFolders(ref: string) {
    if (!ref) return;
    setFolderError(false);
    setFolderLoading(true);
    try {
      const { data, error } = await api.api.v1.integrations.google[
        "drive-folders"
      ].get({
        query: { credentialRef: ref },
      });
      if (error || !data) {
        setFolderError(true);
        return;
      }
      setAvailableFolders(data.folders);
      setFolderLoaded(true);
    } catch {
      setFolderError(true);
    } finally {
      setFolderLoading(false);
    }
  }

  // Loads the tenant's BusinessHours so the Calendar integration can pick a service-hours schedule.
  // Best-effort: a failure just leaves the picker with no options (the schedule stays "always on").
  async function loadHours() {
    try {
      const { data } = await api.api.v1["business-hours"].get();
      if (data) setSchedules(data.businessHours.map(toScheduleOption));
    } catch {
      // ignore — the SchedulePicker degrades to "always on"
    }
  }

  // Derives the duration/granularity "custom" flags from a config: a numeric value that is not on the
  // preset list means the operator typed a custom value, so the field should render as a free input.
  function syncSlotModes(config: Record<string, unknown>) {
    const d = config.slotDurationMinutes;
    setDurationCustom(
      typeof d === "number" &&
        !(SLOT_DURATIONS as readonly number[]).includes(d),
    );
    const g = config.slotGranularityMinutes;
    setGranularityCustom(
      typeof g === "number" &&
        !(SLOT_GRANULARITIES as readonly number[]).includes(g),
    );
  }

  const editId = modal.payload?.id;

  useOnModalOpen(modal, () => {
    setLoadError(false);
    setAvailableCals([]);
    setCalError(false);
    setAvailableFolders([]);
    setFolderError(false);
    setFolderLoaded(false);
    setFolderFilter("");
    void loadHours();
    const payloadId = modal.payload?.id;
    formBaseline.current = "";
    setLoadingForm(true);
    void (async () => {
      try {
        const catList = catalog.length
          ? catalog
          : await (async () => {
              const { data, error } =
                await api.api.v1.integrations.catalog.get();
              if (error || !data) throw error ?? new Error("no catalog");
              const list = [...data.catalog];
              setCatalog(list);
              return list;
            })();
        setRouteToken(null);
        setRouteTokenStatus("absent");
        if (!payloadId) {
          const first = catList[0];
          const ct = first?.catalogType ?? "";
          const next: Form = {
            catalogType: ct,
            name: catalogLabel(first),
            credentialRef: "",
            enabled: true,
            config: defaultConfig(ct),
            inboundAuthStrategy: (first?.defaultInboundAuth ??
              "NONE") as AuthStrategy,
            inboundSecretRef: "",
          };
          setForm(next);
          formBaseline.current = JSON.stringify(next);
          syncSlotModes(next.config);
          return;
        }
        const { data, error } = await api.api.v1.integrations
          .instances({ id: payloadId })
          .get();
        if (error || !data) {
          setLoadError(true);
          return;
        }
        const inst = data.integration;
        const next: Form = {
          catalogType: inst.catalogType,
          name: inst.name,
          credentialRef: inst.credentialRef ?? "",
          enabled: inst.enabled,
          config: (inst.config ?? {}) as Record<string, unknown>,
          inboundAuthStrategy: inst.inboundAuthStrategy as AuthStrategy,
          inboundSecretRef: inst.inboundSecretRef ?? "",
        };
        setForm(next);
        setRouteToken(inst.routeToken);
        setRouteTokenStatus(inst.routeTokenStatus);
        formBaseline.current = JSON.stringify(next);
        syncSlotModes(next.config);
        // Pre-load the credential's calendars/folders so the picker reflects the saved selection.
        if (next.catalogType === "GOOGLE_CALENDAR" && next.credentialRef) {
          void loadCalendars(next.credentialRef);
        }
        if (next.catalogType === "GOOGLE_DRIVE" && next.credentialRef) {
          void loadFolders(next.credentialRef);
        }
      } catch {
        setLoadError(true);
      } finally {
        setLoadingForm(false);
      }
    })();
  });

  function pickType(c: CatalogEntry) {
    const nameIsPristine =
      form.name.trim() === "" ||
      form.name ===
        catalogLabel(catalog.find((x) => x.catalogType === form.catalogType));
    setForm({
      ...form,
      catalogType: c.catalogType,
      name: nameIsPristine ? catalogLabel(c) : form.name,
      config: defaultConfig(c.catalogType),
      inboundAuthStrategy: (c.defaultInboundAuth ?? "NONE") as AuthStrategy,
      inboundSecretRef: "",
    });
    setAvailableCals([]);
    setCalError(false);
    setAvailableFolders([]);
    setFolderError(false);
    setFolderLoaded(false);
    setFolderFilter("");
    syncSlotModes(defaultConfig(c.catalogType));
  }

  async function save() {
    if (!form.name.trim() || !form.catalogType) return;
    setSaving(true);
    try {
      if (editId) {
        const { data, error: err } = await api.api.v1.integrations
          .instances({ id: editId })
          .patch({
            name: form.name.trim(),
            credentialRef: form.credentialRef || null,
            config: form.config,
            inboundAuthStrategy: form.inboundAuthStrategy,
            inboundSecretRef: form.inboundSecretRef || null,
            enabled: form.enabled,
          });
        if (err || !data) throw err ?? new Error("no data");
        showToast(t("integrations.saved", "Integration saved."), "success");
        modal.close();
        onSaved?.(
          { id: data.integration.id, name: data.integration.name },
          false,
        );
      } else {
        const { data, error: err } =
          await api.api.v1.integrations.instances.post({
            catalogType: form.catalogType,
            name: form.name.trim(),
            credentialRef: form.credentialRef || null,
            config: form.config,
            inboundAuthStrategy: form.inboundAuthStrategy,
            inboundSecretRef: form.inboundSecretRef || null,
            enabled: form.enabled,
          });
        if (err || !data) throw err ?? new Error("no data");
        showToast(t("integrations.created", "Integration created."), "success");
        modal.close();
        onSaved?.({ id: data.id, name: form.name.trim() }, true);
        // Reveal the inbound webhook URL ONCE (the route token is never returned again). Only
        // inbound-capable toolpacks (Asaas) mint a token; the rest return null → no reveal.
        if (data.routeToken) {
          tokenModal.open({
            url: `${window.location.origin}/api/v1/integrations/inbound/${data.routeToken}`,
          });
        }
      }
    } catch {
      showToast(t("integrations.saveError", "Could not save."), "error");
    } finally {
      setSaving(false);
    }
  }

  function copyUrl() {
    const url = tokenModal.payload?.url;
    if (url) {
      void navigator.clipboard?.writeText(url);
      showToast(t("common.copied", "Copied"), "success");
    }
  }

  const inboundUrl = (token: string) =>
    `${window.location.origin}/api/v1/integrations/inbound/${token}`;

  function copyInboundUrl() {
    if (!routeToken) return;
    void navigator.clipboard?.writeText(inboundUrl(routeToken));
    showToast(t("common.copied", "Copied"), "success");
  }

  // NOTE: Rotation is destructive from the provider's point of view — the old URL stops resolving
  // the moment this commits, so the confirm spells that out instead of a generic "are you sure".
  function askRotate() {
    rotateConfirm.open({
      title: t("integrations.webhook.rotateTitle", "Generate a new URL"),
      message: t(
        "integrations.webhook.rotateMessage",
        "The current URL stops working immediately. You must paste the new one into the provider's panel, or payment notifications stop arriving.",
      ),
      danger: true,
      confirmLabel: t("integrations.webhook.rotateConfirm", "Generate"),
      onConfirm: async () => {
        if (!editId) return;
        setRotating(true);
        try {
          const { data, error } = await api.api.v1.integrations
            .instances({ id: editId })
            ["route-token"].post();
          if (error || !data) throw error ?? new Error("no data");
          setRouteToken(data.routeToken);
          tokenModal.open({ url: inboundUrl(data.routeToken) });
        } catch (e) {
          showToast(
            t("integrations.webhook.rotateError", "Could not generate."),
            "error",
          );
          // NOTE: Rethrow — ConfirmDialog's contract is that a throwing onConfirm keeps the dialog
          // open (the caller owns the toast). Swallowing it closes the dialog on failure, which
          // reads as "done" for an action that did not happen.
          throw e;
        } finally {
          setRotating(false);
        }
      },
    });
  }

  const selectedCatalog = catalog.find(
    (c) => c.catalogType === form.catalogType,
  );
  const compat = credentialCompat.catalog(form.catalogType);
  const needsGoogle = compat[0] === "google_oauth";
  const cfg = form.config;
  const setCfg = (patch: Record<string, unknown>) =>
    setForm({ ...form, config: { ...form.config, ...patch } });
  const calendarIds = Array.isArray(cfg.calendarIds)
    ? (cfg.calendarIds as string[])
    : [];
  const calendarLabels =
    cfg.calendarLabels && typeof cfg.calendarLabels === "object"
      ? (cfg.calendarLabels as Record<string, string>)
      : {};
  const pickedCalIds = new Set(availableCals.map((c) => c.id));
  // Calendars in the allowlist that aren't in the fetched list (e.g. a shared calendar typed by hand)
  // stay editable via the advanced manual rows.
  const manualCalIds = calendarIds.filter((id) => !pickedCalIds.has(id));
  // Blocking calendars: respected by availability (every event blocks slots) but never operated on.
  const blockingIds = Array.isArray(cfg.blockingCalendarIds)
    ? (cfg.blockingCalendarIds as string[])
    : [];
  const manualBlockingIds = blockingIds.filter((id) => !pickedCalIds.has(id));
  // Drive: the search-scope folder (a single optional id) + its captured friendly name.
  const folderId = typeof cfg.folderId === "string" ? cfg.folderId : "";
  const folderName = typeof cfg.folderName === "string" ? cfg.folderName : "";
  const pickedFolderIds = new Set(availableFolders.map((f) => f.id));
  // A saved folderId not in the fetched list (a shared/Team-drive folder, or one typed by hand)
  // stays editable via the manual input below the picker.
  const isManualFolder = folderId !== "" && !pickedFolderIds.has(folderId);
  const folderQuery = folderFilter.trim().toLowerCase();
  const filteredFolders = folderQuery
    ? availableFolders.filter((f) => f.name.toLowerCase().includes(folderQuery))
    : availableFolders;

  // Choosing a credential clears the stale lists and loads the new one for the active Google service.
  function setCredential(v: string) {
    setForm({ ...form, credentialRef: v });
    setAvailableCals([]);
    setCalError(false);
    setAvailableFolders([]);
    setFolderError(false);
    if (v && form.catalogType === "GOOGLE_CALENDAR") void loadCalendars(v);
    if (v && form.catalogType === "GOOGLE_DRIVE") void loadFolders(v);
  }

  // Toggle a fetched calendar in the allowlist, capturing its friendly name for the tool descriptions.
  function toggleCalendar(c: { id: string; summary: string }, on: boolean) {
    const labels = { ...calendarLabels };
    let ids = [...calendarIds];
    if (on) {
      if (!ids.includes(c.id)) ids.push(c.id);
      labels[c.id] = c.summary;
    } else {
      ids = ids.filter((x) => x !== c.id);
      delete labels[c.id];
    }
    setCfg({ calendarIds: ids, calendarLabels: labels });
  }

  // Replace just the hand-typed ids, preserving the picker selections (and their labels).
  function setManualCalIds(next: string[]) {
    const picked = calendarIds.filter((id) => pickedCalIds.has(id));
    setCfg({ calendarIds: [...picked, ...next] });
  }

  // Blocking-calendar selection: ids only (labels are never used at runtime for these).
  function toggleBlockingCalendar(c: { id: string }, on: boolean) {
    const ids = on
      ? blockingIds.includes(c.id)
        ? blockingIds
        : [...blockingIds, c.id]
      : blockingIds.filter((x) => x !== c.id);
    setCfg({ blockingCalendarIds: ids });
  }

  function setManualBlockingIds(next: string[]) {
    const picked = blockingIds.filter((id) => pickedCalIds.has(id));
    setCfg({ blockingCalendarIds: [...picked, ...next] });
  }

  const isDirty =
    !!formBaseline.current && JSON.stringify(form) !== formBaseline.current;

  return (
    <>
      <Modal
        modal={modal}
        size="lg"
        unsavedChanges={isDirty}
        title={
          editId
            ? t("integrations.editTitle", "Edit integration")
            : t("integrations.addTitle", "New integration")
        }
        footer={
          <div className="flex justify-end gap-2">
            <ModalCancelButton disabled={saving} />
            <Button
              onClick={save}
              loading={saving}
              disabled={
                loadingForm ||
                loadError ||
                !form.name.trim() ||
                !form.catalogType
              }
            >
              {t("common.save", "Save")}
            </Button>
          </div>
        }
      >
        {loadingForm ? (
          <div className="flex flex-col gap-3" role="status">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : loadError ? (
          <p className="text-error text-sm">
            {t("integrations.loadError", "Could not load this integration.")}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {sharedNotice && editId && (
              <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                  aria-hidden="true"
                />
                <span>
                  {t(
                    "integrations.sharedNotice",
                    "This is a shared integration. Changes affect every agent that uses it.",
                  )}
                </span>
              </div>
            )}

            {/* Service selector (logo cards) on create; a fixed header on edit. */}
            {editId ? (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
                <ServiceLogo
                  service={serviceFor(form.catalogType)}
                  className="h-6 w-6 shrink-0 text-text-primary"
                />
                <div className="min-w-0">
                  <div className="font-medium text-sm text-text-primary">
                    {catalogLabel(selectedCatalog)}
                  </div>
                  <p className="truncate text-text-muted text-xs">
                    {catalogDescription(selectedCatalog)}
                  </p>
                </div>
              </div>
            ) : (
              <FormField label={t("integrations.type", "Integration")} group>
                <div className="grid gap-2 sm:grid-cols-3">
                  {catalog.map((c) => {
                    const active = c.catalogType === form.catalogType;
                    return (
                      <button
                        key={c.catalogType}
                        type="button"
                        onClick={() => pickType(c)}
                        aria-pressed={active}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                          active
                            ? "border-accent bg-accent-soft"
                            : "border-border hover:bg-bg-hover"
                        }`}
                      >
                        <ServiceLogo
                          service={serviceFor(c.catalogType)}
                          className="h-5 w-5 shrink-0 text-text-primary"
                        />
                        <span className="font-medium text-sm text-text-primary">
                          {catalogLabel(c)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </FormField>
            )}
            {catalogDescription(selectedCatalog) && !editId && (
              <p className="text-text-muted text-xs">
                {catalogDescription(selectedCatalog)}
              </p>
            )}

            <FormField label={t("integrations.name", "Name")} required>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </FormField>

            <FormField label={t("integrations.credential", "Credential")} group>
              <CredentialPicker
                value={form.credentialRef}
                onChange={setCredential}
                compatibleTypes={compat}
                defaultCreateType={compat[0]}
                ariaLabel={t("integrations.credential", "Credential")}
              />
              {needsGoogle && (
                <p className="mt-1.5 text-text-muted text-xs">
                  {t(
                    "integrations.googleScopeHint",
                    "Connect a Google account with the right scope (Calendar or Drive). If a tool returns a permission error, reconnect the credential adding that scope.",
                  )}
                </p>
              )}
            </FormField>

            {/* ── Per-toolpack configuration ── */}
            {form.catalogType === "ASAAS" && (
              <FormField
                label={t("integrations.config.environment", "Environment")}
              >
                <Select
                  value={(cfg.environment as string) ?? "sandbox"}
                  onChange={(e) => setCfg({ environment: e.target.value })}
                >
                  <option value="sandbox">
                    {t("integrations.env.sandbox", "Sandbox (test)")}
                  </option>
                  <option value="production">
                    {t(
                      "integrations.env.production",
                      "Production (real charges)",
                    )}
                  </option>
                </Select>
              </FormField>
            )}

            {form.catalogType === "GOOGLE_CALENDAR" && (
              <>
                <Tabs
                  items={[
                    {
                      key: "calendars",
                      label: t("integrations.config.tabCalendars", "Calendars"),
                    },
                    {
                      key: "reminders",
                      label: t("integrations.config.tabReminders", "Reminders"),
                    },
                  ]}
                  value={calTab}
                  onChange={(k) => setCalTab(k as "calendars" | "reminders")}
                  aria-label={t(
                    "integrations.config.calendarTabs",
                    "Calendar settings",
                  )}
                />
                {calTab === "calendars" && (
                  <div className="flex flex-col gap-4">
                    <FormField
                      label={t(
                        "integrations.config.calendars",
                        "Allowed calendars",
                      )}
                      group
                    >
                      <p className="mb-1.5 text-text-muted text-xs">
                        {t(
                          "integrations.config.calendarsHint",
                          "The calendars the agent may read and write. The calendar tools stay disabled until at least one is picked.",
                        )}
                      </p>
                      <a
                        href="https://calendar.google.com/calendar/u/0/r/settings/createcalendar"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mb-2 inline-flex items-center gap-1 text-accent text-xs hover:underline"
                      >
                        {t(
                          "integrations.config.createCalendarLink",
                          "Need a new calendar? Create one in Google Calendar",
                        )}
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                      {!form.credentialRef ? (
                        <p className="rounded-lg border border-border border-dashed px-3 py-2 text-text-muted text-xs">
                          {t(
                            "integrations.config.calendarsPickCredential",
                            "Choose a connected Google credential above to list its calendars.",
                          )}
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-text-muted text-xs">
                              {t(
                                "integrations.config.calendarsFromCredential",
                                "Calendars from the connected account",
                              )}
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={calLoading}
                              onClick={() => loadCalendars(form.credentialRef)}
                            >
                              <RefreshCw
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              {availableCals.length
                                ? t("common.reload", "Reload")
                                : t(
                                    "integrations.config.loadCalendars",
                                    "Load",
                                  )}
                            </Button>
                          </div>
                          {calLoading ? (
                            <Skeleton className="h-20 w-full" />
                          ) : (
                            <>
                              {calError && (
                                <p className="text-error text-xs">
                                  {t(
                                    "integrations.config.calendarsError",
                                    "Could not list calendars. Check the credential's Calendar scope and try again.",
                                  )}
                                </p>
                              )}
                              <CalendarMultiPicker
                                cals={calError ? [] : availableCals}
                                selectedIds={calendarIds}
                                onToggle={toggleCalendar}
                                manualIds={manualCalIds}
                                onManualChange={setManualCalIds}
                              />
                            </>
                          )}
                        </div>
                      )}
                    </FormField>
                    <FormField
                      label={t(
                        "integrations.config.blockingCalendars",
                        "Blocking calendars",
                      )}
                      group
                    >
                      <p className="mb-1.5 text-text-muted text-xs">
                        {t(
                          "integrations.config.blockingCalendarsHint",
                          "Calendars the agent respects but never books into: every event on them blocks availability (holidays, closures, days off). The agent never sees their event details.",
                        )}
                      </p>
                      {!form.credentialRef ? (
                        <p className="rounded-lg border border-border border-dashed px-3 py-2 text-text-muted text-xs">
                          {t(
                            "integrations.config.calendarsPickCredential",
                            "Choose a connected Google credential above to list its calendars.",
                          )}
                        </p>
                      ) : calLoading ? (
                        <Skeleton className="h-20 w-full" />
                      ) : (
                        <>
                          {blockingIds.length > BLOCKING_CALENDARS_LIMIT && (
                            <p className="text-warning text-xs">
                              {t(
                                "integrations.config.blockingCalendarsLimitWarning",
                                "More than {{max}} blocking calendars are selected; availability checks will refuse until the list is reduced.",
                                { max: BLOCKING_CALENDARS_LIMIT },
                              )}
                            </p>
                          )}
                          {calError && (
                            <p className="text-error text-xs">
                              {t(
                                "integrations.config.calendarsError",
                                "Could not list calendars. Check the credential's Calendar scope and try again.",
                              )}
                            </p>
                          )}
                          <CalendarMultiPicker
                            cals={calError ? [] : availableCals}
                            selectedIds={blockingIds}
                            onToggle={toggleBlockingCalendar}
                            manualIds={manualBlockingIds}
                            onManualChange={setManualBlockingIds}
                          />
                        </>
                      )}
                    </FormField>
                    <FormField
                      label={t("integrations.config.timeZone", "Time zone")}
                      group
                      required
                    >
                      <TimezonePicker
                        value={(cfg.timeZone as string) || "America/Sao_Paulo"}
                        onChange={(tz) => setCfg({ timeZone: tz })}
                      />
                    </FormField>
                    <FormField
                      label={t(
                        "integrations.config.serviceHours",
                        "Service hours",
                      )}
                      group
                    >
                      <p className="mb-1.5 text-text-muted text-xs">
                        {t(
                          "integrations.config.serviceHoursHint",
                          "The weekly hours the agent may offer for appointments. Reuses your schedules; leave it as Always available for no time-of-day limit.",
                        )}
                      </p>
                      <SchedulePicker
                        value={(cfg.businessHoursId as string) ?? ""}
                        onChange={(id) => setCfg({ businessHoursId: id })}
                        schedules={schedules}
                        emptyLabel={t(
                          "integrations.config.scheduleAlwaysOn",
                          "Always available",
                        )}
                        onScheduleSaved={(savedId) => {
                          void loadHours();
                          setCfg({ businessHoursId: savedId });
                        }}
                        aria-label={t(
                          "integrations.config.serviceHours",
                          "Service hours",
                        )}
                      />
                    </FormField>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <FormField
                        label={t(
                          "integrations.config.appointmentLength",
                          "Appointment length",
                        )}
                        group
                      >
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <Select
                              aria-label={t(
                                "integrations.config.appointmentLength",
                                "Appointment length",
                              )}
                              value={
                                durationCustom
                                  ? "custom"
                                  : cfg.slotDurationMinutes == null
                                    ? "ai"
                                    : String(cfg.slotDurationMinutes)
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "ai") {
                                  setDurationCustom(false);
                                  setCfg({ slotDurationMinutes: null });
                                } else if (v === "custom") {
                                  setDurationCustom(true);
                                  setCfg({
                                    slotDurationMinutes:
                                      typeof cfg.slotDurationMinutes ===
                                      "number"
                                        ? cfg.slotDurationMinutes
                                        : 30,
                                  });
                                } else {
                                  setDurationCustom(false);
                                  setCfg({ slotDurationMinutes: Number(v) });
                                }
                              }}
                            >
                              <option value="ai">
                                {t(
                                  "integrations.config.slotAiChooses",
                                  "Let the AI choose",
                                )}
                              </option>
                              {SLOT_DURATIONS.map((m) => (
                                <option key={m} value={m}>
                                  {t(
                                    "integrations.config.minutesOption",
                                    "{{n}} min",
                                    { n: m },
                                  )}
                                </option>
                              ))}
                              <option value="custom">
                                {t("integrations.config.slotCustom", "Custom…")}
                              </option>
                            </Select>
                          </div>
                          {durationCustom && (
                            <div className="w-24 shrink-0">
                              <Input
                                type="number"
                                min={5}
                                value={
                                  typeof cfg.slotDurationMinutes === "number"
                                    ? String(cfg.slotDurationMinutes)
                                    : ""
                                }
                                placeholder={t(
                                  "integrations.config.minutesPlaceholder",
                                  "Minutes",
                                )}
                                onChange={(e) =>
                                  setCfg({
                                    slotDurationMinutes:
                                      e.target.value === ""
                                        ? null
                                        : Number(e.target.value),
                                  })
                                }
                              />
                            </div>
                          )}
                        </div>
                      </FormField>
                      <FormField
                        label={t(
                          "integrations.config.slotSpacing",
                          "Slot spacing",
                        )}
                        group
                      >
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <Select
                              aria-label={t(
                                "integrations.config.slotSpacing",
                                "Slot spacing",
                              )}
                              value={
                                granularityCustom
                                  ? "custom"
                                  : String(
                                      typeof cfg.slotGranularityMinutes ===
                                        "number"
                                        ? cfg.slotGranularityMinutes
                                        : 15,
                                    )
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "custom") {
                                  setGranularityCustom(true);
                                  setCfg({
                                    slotGranularityMinutes:
                                      typeof cfg.slotGranularityMinutes ===
                                      "number"
                                        ? cfg.slotGranularityMinutes
                                        : 15,
                                  });
                                } else {
                                  setGranularityCustom(false);
                                  setCfg({ slotGranularityMinutes: Number(v) });
                                }
                              }}
                            >
                              {SLOT_GRANULARITIES.map((m) => (
                                <option key={m} value={m}>
                                  {t(
                                    "integrations.config.minutesOption",
                                    "{{n}} min",
                                    { n: m },
                                  )}
                                </option>
                              ))}
                              <option value="custom">
                                {t("integrations.config.slotCustom", "Custom…")}
                              </option>
                            </Select>
                          </div>
                          {granularityCustom && (
                            <div className="w-24 shrink-0">
                              <Input
                                type="number"
                                min={5}
                                value={
                                  typeof cfg.slotGranularityMinutes === "number"
                                    ? String(cfg.slotGranularityMinutes)
                                    : ""
                                }
                                placeholder={t(
                                  "integrations.config.minutesPlaceholder",
                                  "Minutes",
                                )}
                                onChange={(e) =>
                                  setCfg({
                                    slotGranularityMinutes:
                                      e.target.value === ""
                                        ? null
                                        : Number(e.target.value),
                                  })
                                }
                              />
                            </div>
                          )}
                        </div>
                      </FormField>
                    </div>
                    <p className="text-text-muted text-xs">
                      {t(
                        "integrations.config.slotSpacingHint",
                        "Spacing is the gap between offered start times: 15 min means 09:00 and 09:15 can both be offered.",
                      )}
                    </p>
                    <SwitchField
                      checked={cfg.createMeetLink !== false}
                      onCheckedChange={(v) => setCfg({ createMeetLink: v })}
                      label={t(
                        "integrations.config.createMeetLink",
                        "Create a Google Meet room for each appointment",
                      )}
                    />
                    <p className="text-text-muted text-xs">
                      {t(
                        "integrations.config.createMeetLinkHint",
                        "The agent then shares the Meet link with the customer. Turn it off if this calendar is only used to block time slots.",
                      )}
                    </p>
                  </div>
                )}
                {calTab === "reminders" && (
                  <ReminderConfigEditor cfg={cfg} setCfg={setCfg} />
                )}
              </>
            )}

            {form.catalogType === "GOOGLE_DRIVE" && (
              <FormField
                label={t("integrations.config.folder", "Folder")}
                group
              >
                <p className="mb-1.5 text-text-muted text-xs">
                  {t(
                    "integrations.config.folderHint",
                    "Optional. When set, file search is limited to this folder.",
                  )}
                </p>
                {form.credentialRef && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-text-muted text-xs">
                        {t(
                          "integrations.config.foldersFromCredential",
                          "Folders from the connected account",
                        )}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={folderLoading}
                        onClick={() => loadFolders(form.credentialRef)}
                      >
                        <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        {availableFolders.length
                          ? t("common.reload", "Reload")
                          : t("integrations.config.loadFolders", "Load")}
                      </Button>
                    </div>
                    {folderLoading ? (
                      <Skeleton className="h-20 w-full" />
                    ) : folderError ? (
                      <p className="text-error text-xs">
                        {t(
                          "integrations.config.foldersError",
                          "Could not list folders. Check the credential's Drive scope and try again.",
                        )}
                      </p>
                    ) : availableFolders.length > 0 ? (
                      <>
                        <Input
                          value={folderFilter}
                          onChange={(e) => setFolderFilter(e.target.value)}
                          placeholder={t(
                            "integrations.config.filterFolders",
                            "Filter folders by name",
                          )}
                        />
                        <div className="flex max-h-60 flex-col gap-1.5 overflow-auto">
                          <button
                            type="button"
                            aria-pressed={folderId === ""}
                            onClick={() =>
                              setCfg({ folderId: "", folderName: "" })
                            }
                            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                              folderId === ""
                                ? "border-accent bg-accent-soft"
                                : "border-border hover:bg-bg-hover"
                            }`}
                          >
                            <span
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                                folderId === ""
                                  ? "border-accent"
                                  : "border-border"
                              }`}
                            >
                              {folderId === "" && (
                                <span className="h-2 w-2 rounded-full bg-accent" />
                              )}
                            </span>
                            <span className="font-medium text-sm text-text-primary">
                              {t(
                                "integrations.config.anyFolder",
                                "Any folder (no scope)",
                              )}
                            </span>
                          </button>
                          {filteredFolders.map((f) => {
                            const selected = folderId === f.id;
                            return (
                              <button
                                key={f.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() =>
                                  setCfg({
                                    folderId: f.id,
                                    folderName: f.name,
                                  })
                                }
                                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                                  selected
                                    ? "border-accent bg-accent-soft"
                                    : "border-border hover:bg-bg-hover"
                                }`}
                              >
                                <span
                                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                                    selected ? "border-accent" : "border-border"
                                  }`}
                                >
                                  {selected && (
                                    <span className="h-2 w-2 rounded-full bg-accent" />
                                  )}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium text-sm text-text-primary">
                                    {f.name}
                                  </span>
                                  <span className="block truncate text-text-muted text-xs">
                                    {f.id}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                          {filteredFolders.length === 0 && (
                            <p className="px-1 text-text-muted text-xs">
                              {t(
                                "integrations.config.noFoldersMatch",
                                "No folders match your filter.",
                              )}
                            </p>
                          )}
                        </div>
                      </>
                    ) : folderLoaded ? (
                      <p className="text-text-muted text-xs">
                        {t(
                          "integrations.config.noFoldersScopeHint",
                          "No folders found. If you connected the account with the 'Drive (app files)' scope, it only sees files this app itself created, so reconnect the credential with 'Drive (read-only)' or 'Drive (full access)' to list your existing folders.",
                        )}
                      </p>
                    ) : null}
                  </div>
                )}
                {/* Manual fallback: a shared/Team-drive folder not in the list, or no credential yet. */}
                <div className="mt-1 flex flex-col gap-1">
                  <span className="text-text-muted text-xs">
                    {t(
                      "integrations.config.folderByIdLabel",
                      "Or paste a folder ID",
                    )}
                  </span>
                  <Input
                    value={isManualFolder ? folderId : ""}
                    placeholder={t(
                      "integrations.config.folderPlaceholder",
                      "Drive folder ID (optional)",
                    )}
                    onChange={(e) =>
                      setCfg({ folderId: e.target.value, folderName: "" })
                    }
                  />
                </div>
                {folderId !== "" && !isManualFolder && folderName && (
                  <p className="mt-1 text-text-muted text-xs">
                    {t(
                      "integrations.config.folderSelected",
                      "Selected folder:",
                    )}{" "}
                    <span className="text-text-secondary">{folderName}</span>
                  </p>
                )}
              </FormField>
            )}

            {/* ── Tools this integration exposes (read-only) ── */}
            {selectedCatalog && selectedCatalog.tools.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="font-medium text-sm text-text-secondary">
                  {t("integrations.toolsTitle", "What this integration can do")}
                </span>
                <div className="flex flex-col gap-2">
                  {selectedCatalog.tools.map((tool) => {
                    const meta = toolpackToolMeta(tool.name, t);
                    const Icon = meta.icon;
                    return (
                      <div
                        key={tool.name}
                        className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
                      >
                        <div className="flex items-center gap-2">
                          <Icon
                            className="h-4 w-4 shrink-0 text-text-muted"
                            aria-hidden="true"
                          />
                          <span className="font-medium text-sm text-text-primary">
                            {meta.label}
                          </span>
                        </div>
                        <p className="text-text-muted text-xs">
                          {meta.description}
                        </p>
                        {tool.args.length > 0 && (
                          <ToolArgPills
                            args={withToolpackArgNotes(tool.name, tool.args, t)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Payment webhook (Asaas only) ── */}
            {selectedCatalog?.supportsInbound && (
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-3">
                <div className="flex items-center gap-2">
                  <Webhook
                    className="h-4 w-4 shrink-0 text-accent"
                    aria-hidden="true"
                  />
                  <span className="font-medium text-sm text-text-primary">
                    {t("integrations.webhook.title", "Payment webhook")}
                  </span>
                </div>
                <p className="text-text-muted text-xs">
                  {t(
                    "integrations.webhook.explain",
                    "When a charge is paid, Asaas calls this webhook and the agent is woken on the exact conversation that generated the charge. It then decides whether to message the customer (and may use its tools). You paste the webhook URL into the Asaas panel after saving.",
                  )}
                </p>
                {/* The URL only exists once the instance does, so it shows on edit, never create. */}
                {editId && (
                  <FormField
                    label={t("integrations.webhook.url", "Webhook URL")}
                    group
                    description={
                      routeToken
                        ? t(
                            "integrations.webhook.urlHint",
                            "Paste this into the provider's panel.",
                          )
                        : routeTokenStatus === "unreadable"
                          ? t(
                              "integrations.webhook.urlUnreadable",
                              "The stored URL can no longer be decrypted, which usually means the encryption key changed. Generate a new one and update it in the provider's panel.",
                            )
                          : t(
                              "integrations.webhook.urlMissing",
                              "This integration was created before the URL could be shown again, so we no longer have it. Generate a new one and update it in the provider's panel.",
                            )
                    }
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      {routeToken && (
                        <>
                          <Input
                            readOnly
                            value={inboundUrl(routeToken)}
                            onFocus={(e) => e.currentTarget.select()}
                            aria-label={t(
                              "integrations.webhook.url",
                              "Webhook URL",
                            )}
                            className="font-mono text-xs"
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={copyInboundUrl}
                          >
                            {t("common.copy", "Copy")}
                          </Button>
                        </>
                      )}
                      <Button
                        type="button"
                        variant="secondary"
                        loading={rotating}
                        onClick={askRotate}
                      >
                        {t("integrations.webhook.rotate", "Generate new URL")}
                      </Button>
                    </div>
                  </FormField>
                )}
                <SwitchField
                  checked={cfg.notifyOnPayment !== false}
                  onCheckedChange={(v) => setCfg({ notifyOnPayment: v })}
                  label={t(
                    "integrations.config.notifyOnPayment",
                    "Wake the agent when a payment is confirmed",
                  )}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField
                    label={t("integrations.inboundAuth", "Webhook auth")}
                  >
                    <Select
                      value={form.inboundAuthStrategy}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          inboundAuthStrategy: e.target.value as AuthStrategy,
                        })
                      }
                    >
                      {AUTH_STRATEGIES.map((s) => (
                        <option key={s} value={s}>
                          {authStrategyLabel(s)}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  {form.inboundAuthStrategy !== "NONE" && (
                    <FormField
                      label={t("integrations.inboundSecret", "Webhook secret")}
                      group
                    >
                      <CredentialPicker
                        value={form.inboundSecretRef}
                        onChange={(v) =>
                          setForm({ ...form, inboundSecretRef: v })
                        }
                        ariaLabel={t(
                          "integrations.inboundSecret",
                          "Webhook secret",
                        )}
                      />
                    </FormField>
                  )}
                </div>
              </div>
            )}

            <SwitchField
              checked={form.enabled}
              onCheckedChange={(v) => setForm({ ...form, enabled: v })}
              label={t("common.enabled", "Enabled")}
            />
          </div>
        )}
      </Modal>

      <Modal
        modal={tokenModal}
        title={t("integrations.tokenTitle", "Inbound webhook URL")}
        footer={
          <div className="flex justify-end">
            <Button onClick={() => tokenModal.close()}>
              {t("common.done", "Done")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            {t(
              "integrations.tokenHint",
              "Copy this URL into the provider's webhook settings. You can read it again later by editing this integration.",
            )}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-text-primary text-xs">
              {tokenModal.payload?.url}
            </code>
            <Button variant="secondary" size="sm" onClick={copyUrl}>
              <Copy className="h-4 w-4" aria-hidden="true" />
              {t("common.copy", "Copy")}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog modal={rotateConfirm} />
    </>
  );
}
