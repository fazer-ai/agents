import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  ArrowRightLeft,
  BellRing,
  CalendarClock,
  Check,
  Hourglass,
  type LucideIcon,
  Trash2,
  Webhook,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dropdown,
  FormField,
  Input,
  Select,
  useHoldSave,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";
import { clipText } from "@/lib/text";
import {
  buildTemplatePayload,
  findTemplateDefinition,
  PROACTIVE_KINDS,
  type ProactiveKind,
  readServiceWindowConfig,
  type TemplateDefinition,
  templatePlaceholders,
} from "@/modules/service-window/service";

// The 24h window's templates (docs/service-window.md): a default, and an optional template per
// proactive kind and per reminder offset. Each choice is filled per component from the synced
// template's own placeholders, and previewed through the SAME function the send uses, so what the
// operator reads here is what the customer reads.

export interface TemplateChoiceForm {
  name: string;
  language: string;
  category: string;
  params: string[];
  headerParams: string[];
  buttonParams: string[];
  content: string;
}

export interface ServiceWindowForm {
  enabled: boolean;
  windowHours: string;
  def: TemplateChoiceForm;
  templates: Partial<Record<ProactiveKind, TemplateChoiceForm>>;
  reminderTemplates: Array<{ offset: string; choice: TemplateChoiceForm }>;
}

const EMPTY_CHOICE: TemplateChoiceForm = {
  name: "",
  language: "pt_BR",
  category: "UTILITY",
  params: [],
  headerParams: [],
  buttonParams: [],
  content: "",
};

function strs(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function choiceToForm(v: unknown): TemplateChoiceForm | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || !o.name.trim()) return null;
  return {
    name: o.name,
    language: typeof o.language === "string" ? o.language : "pt_BR",
    category: typeof o.category === "string" ? o.category : "UTILITY",
    params: strs(o.params),
    headerParams: strs(o.headerParams),
    buttonParams: strs(o.buttonParams),
    content: typeof o.content === "string" ? o.content : "",
  };
}

export function serviceWindowToForm(
  sw: Record<string, unknown>,
): ServiceWindowForm {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const templates: ServiceWindowForm["templates"] = {};
  const rawKinds =
    sw.templates && typeof sw.templates === "object"
      ? (sw.templates as Record<string, unknown>)
      : {};
  for (const kind of PROACTIVE_KINDS) {
    const c = choiceToForm(rawKinds[kind]);
    if (c) templates[kind] = c;
  }
  const rawOffsets =
    sw.reminderTemplates && typeof sw.reminderTemplates === "object"
      ? (sw.reminderTemplates as Record<string, unknown>)
      : {};
  const reminderTemplates = Object.entries(rawOffsets).flatMap(
    ([offset, v]) => {
      const c = choiceToForm(v);
      return c ? [{ offset, choice: c }] : [];
    },
  );
  return {
    enabled: typeof sw.enabled === "boolean" ? sw.enabled : true,
    windowHours:
      typeof sw.windowHours === "number" ? String(sw.windowHours) : "24",
    def: {
      name: str(sw.templateName),
      language: str(sw.templateLanguage) || "pt_BR",
      category: str(sw.templateCategory) || "UTILITY",
      params: strs(sw.templateParams),
      headerParams: strs(sw.templateHeaderParams),
      buttonParams: strs(sw.templateButtonParams),
      content: str(sw.templateContent),
    },
    templates,
    reminderTemplates,
  };
}

function choiceToStored(c: TemplateChoiceForm) {
  return {
    name: c.name.trim(),
    language: c.language.trim() || "pt_BR",
    category: c.category.trim() || "UTILITY",
    params: c.params,
    headerParams: c.headerParams,
    buttonParams: c.buttonParams,
    content: c.content.trim() || null,
  };
}

export function serviceWindowToStored(f: ServiceWindowForm) {
  const templates: Record<string, ReturnType<typeof choiceToStored>> = {};
  for (const kind of PROACTIVE_KINDS) {
    const c = f.templates[kind];
    if (c?.name.trim()) templates[kind] = choiceToStored(c);
  }
  const reminderTemplates: Record<
    string,
    ReturnType<typeof choiceToStored>
  > = {};
  for (const { offset, choice } of f.reminderTemplates) {
    const hours = Number(offset);
    if (choice.name.trim() && Number.isFinite(hours) && hours > 0) {
      reminderTemplates[String(hours)] = choiceToStored(choice);
    }
  }
  return {
    enabled: f.enabled,
    windowHours: Number(f.windowHours) || 24,
    templateName: f.def.name.trim() || null,
    templateLanguage: f.def.language.trim() || "pt_BR",
    templateCategory: f.def.category.trim() || "UTILITY",
    templateParams: f.def.params,
    templateHeaderParams: f.def.headerParams,
    templateButtonParams: f.def.buttonParams,
    templateContent: f.def.content.trim() || null,
    templates,
    reminderTemplates,
  };
}

export const SERVICE_WINDOW_FORM_DEFAULTS: ServiceWindowForm =
  serviceWindowToForm({});

// The values the preview fills in: a sample contact, and a sample appointment tomorrow at 14:30.
const SAMPLE_CONTACT = "Maria Silva";
function sampleAppointmentISO(): string {
  const d = new Date(Date.now() + 86_400_000);
  const [day] = d.toISOString().split("T");
  return `${day}T14:30:00-03:00`;
}

// Resize a list to `n` entries, keeping what the operator already typed.
function sized(list: string[], n: number): string[] {
  return Array.from({ length: n }, (_, i) => list[i] ?? "");
}

const CONTACT_VARS = ["primeiro_nome", "nome_contato"] as const;
// The reminder's own facts, by their Portuguese names (the English aliases render the same values).
const REMINDER_VARS = [
  "data_agendamento",
  "hora_agendamento",
  "dia_semana_agendamento",
  "agenda",
] as const;
type SlotVar = (typeof CONTACT_VARS)[number] | (typeof REMINDER_VARS)[number];

// What one placeholder is filled with: a variable (with the text used when it renders empty), fixed
// text, or nothing yet. Stored as the string the send interpolates: `{{var}}`, `{{var|reserva}}`, text.
type SlotSource =
  | { kind: "var"; key: SlotVar; fallback: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };

const SLOT_VAR = /^\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}$/;

function parseSlot(value: string, offered: readonly SlotVar[]): SlotSource {
  if (value.trim() === "") return { kind: "empty" };
  const m = SLOT_VAR.exec(value.trim());
  const key = m?.[1] as SlotVar | undefined;
  if (key && offered.includes(key)) {
    return { kind: "var", key, fallback: m?.[2] ?? "" };
  }
  return { kind: "text", text: value };
}

function slotToString(src: SlotSource): string {
  if (src.kind === "var") {
    // A brace would end the placeholder early, so it cannot be part of the fallback.
    const fallback = src.fallback.replace(/[{}]/g, "");
    return fallback.trim() ? `{{${src.key}|${fallback}}}` : `{{${src.key}}}`;
  }
  return src.kind === "text" ? src.text : "";
}

// WhatsApp draws `*text*` in bold; the preview does too, instead of showing the asterisks.
function whatsappBold(text: string) {
  return text.split(/(\*[^*\n]+\*)/).map((part, i) =>
    /^\*[^*\n]+\*$/.test(part) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one fixed string.
      <strong key={i}>{part.slice(1, -1)}</strong>
    ) : (
      part
    ),
  );
}

function useVarLabel() {
  const { t } = useTranslation();
  return (k: SlotVar): string => {
    switch (k) {
      case "primeiro_nome":
        return t("editor.svcWindowVarFirstName", "Contact's first name");
      case "nome_contato":
        return t("editor.svcWindowVarFullName", "Contact's full name");
      case "data_agendamento":
        return t("editor.svcWindowVarDate", "Appointment date");
      case "hora_agendamento":
        return t("editor.svcWindowVarTime", "Appointment time");
      case "dia_semana_agendamento":
        return t("editor.svcWindowVarWeekday", "Appointment weekday");
      case "agenda":
        return t("editor.svcWindowVarCalendar", "Calendar name");
    }
  };
}

// One blank of the template, drawn where it sits in the message. Clicking it opens what fills it: a
// contact or appointment fact (with the text used when that comes empty), or fixed text.
function SlotChip({
  example,
  value,
  onChange,
  offered,
}: {
  example: string;
  value: string;
  onChange: (next: string) => void;
  offered: readonly SlotVar[];
}) {
  const { t } = useTranslation();
  const varLabel = useVarLabel();
  const [open, setOpen] = useState(false);
  const src = parseSlot(value, offered);
  const shown =
    src.kind === "var"
      ? varLabel(src.key)
      : src.kind === "text"
        ? `"${src.text.length > 28 ? `${clipText(src.text, 28)}…` : src.text}"`
        : t("editor.svcWindowSlotChoose", "choose");
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "mx-0.5 inline rounded-full px-2 py-0.5 align-baseline text-xs font-medium transition-colors",
            src.kind === "empty"
              ? "border-border-hover text-text-muted hover:border-accent hover:text-text-primary border border-dashed"
              : "bg-accent-soft text-text-primary hover:bg-accent-soft/70",
          )}
        >
          {src.kind === "empty" ? `+ ${shown}` : shown}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="border-border bg-bg-secondary z-(--z-popover) flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 rounded-lg border p-3 shadow-lg"
          aria-label={t("editor.svcWindowSlotSource", "What goes here")}
        >
          <div className="flex flex-col gap-1">
            <span className="text-text-muted text-xs font-medium">
              {t("editor.svcWindowSlotFacts", "Data")}
            </span>
            {offered.map((k) => (
              <button
                key={k}
                type="button"
                className={cn(
                  "hover:bg-bg-hover flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm",
                  src.kind === "var" && src.key === k
                    ? "text-text-primary"
                    : "text-text-secondary",
                )}
                onClick={() =>
                  onChange(
                    slotToString({
                      kind: "var",
                      key: k,
                      fallback: src.kind === "var" ? src.fallback : "",
                    }),
                  )
                }
              >
                {varLabel(k)}
                {src.kind === "var" && src.key === k && (
                  <Check className="text-accent h-4 w-4" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          {src.kind === "var" && (
            <FormField
              label={t(
                "editor.svcWindowSlotFallback",
                "If this comes empty, use",
              )}
              description={t(
                "editor.svcWindowSlotFallbackHint",
                "Optional. Without it, when the data is missing (a contact with no name, say), the message becomes a private note.",
              )}
            >
              <Input
                value={src.fallback}
                placeholder={t(
                  "editor.svcWindowSlotFallbackPlaceholder",
                  "e.g. customer",
                )}
                onChange={(e) =>
                  onChange(slotToString({ ...src, fallback: e.target.value }))
                }
              />
            </FormField>
          )}
          <FormField
            label={t("editor.svcWindowSlotTextValue", "Or fixed text")}
            description={
              example
                ? t(
                    "editor.svcWindowSlotExample",
                    "Example approved by Meta: {{example}}",
                    { example, interpolation: { escapeValue: false } },
                  )
                : undefined
            }
          >
            <Input
              value={src.kind === "text" ? src.text : ""}
              placeholder={example}
              onChange={(e) =>
                onChange(slotToString({ kind: "text", text: e.target.value }))
              }
            />
          </FormField>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// A component's text with each blank drawn as its chip, in place.
function withChips(
  text: string,
  chipFor: (key: string, index: number) => ReactNode,
): ReactNode[] {
  const keys = templatePlaceholders(text);
  return text.split(/(\{\{\s*[A-Za-z0-9_]+\s*\}\})/).map((part, i) => {
    const m = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/.exec(part);
    if (!m) return whatsappBold(part);
    const key = m[1] as string;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one fixed string.
      <span key={i}>{chipFor(key, keys.indexOf(key))}</span>
    );
  });
}

function TemplateChoiceEditor({
  value,
  onChange,
  templates,
  loaded,
  kind,
}: {
  value: TemplateChoiceForm;
  onChange: (next: TemplateChoiceForm) => void;
  templates: TemplateDefinition[];
  loaded: boolean;
  kind: ProactiveKind | null;
}) {
  const { t } = useTranslation();
  const offered: readonly SlotVar[] =
    kind === "appointment_reminder"
      ? [...CONTACT_VARS, ...REMINDER_VARS]
      : CONTACT_VARS;
  // A one-time-code template is never a proactive message (the save refuses it), so it is not offered.
  const usable = templates.filter(
    (tpl) => tpl.category.toUpperCase() !== "AUTHENTICATION",
  );
  const def = value.name
    ? findTemplateDefinition(usable, value.name, value.language)
    : undefined;
  const bodyKeys = templatePlaceholders(def?.body ?? null);
  const headerKeys =
    def?.header?.format === "TEXT" ? templatePlaceholders(def.header.text) : [];
  const pick = (key: string) => {
    if (!key) {
      onChange({ ...EMPTY_CHOICE });
      return;
    }
    const [name, language] = key.split("\u0000") as [string, string];
    const d = findTemplateDefinition(usable, name, language);
    onChange({
      ...value,
      name,
      language,
      category: d?.category || value.category,
      params: sized(value.params, templatePlaceholders(d?.body ?? null).length),
      headerParams: sized(
        value.headerParams,
        d?.header?.format === "TEXT"
          ? templatePlaceholders(d.header.text).length
          : 0,
      ),
      buttonParams: (d?.buttons ?? []).map((b, i) =>
        b.type === "URL" && templatePlaceholders(b.url).length > 0
          ? (value.buttonParams[i] ?? "")
          : "",
      ),
    });
  };
  // Hold Save while a field of the chosen template is still unfilled: the save would refuse it.
  const unfilled =
    def !== undefined &&
    [
      ...value.params,
      ...value.headerParams,
      ...def.buttons.flatMap((b, i) =>
        b.type === "URL" && templatePlaceholders(b.url).length > 0
          ? [value.buttonParams[i] ?? ""]
          : [],
      ),
    ].some((v) => v.trim() === "");
  useHoldSave(unfilled);
  const [showPreview, setShowPreview] = useState(false);
  const preview = useMemo(() => {
    if (!value.name.trim()) return null;
    // An unfilled field shows as a blank line to fill, so the preview follows the operator's progress.
    const shown = (list: string[]) =>
      list.map((v) => (v.trim() === "" ? "___" : v));
    const cfg = readServiceWindowConfig({
      serviceWindow: {
        templates: {
          [kind ?? "followup"]: {
            ...value,
            params: shown(value.params),
            headerParams: shown(value.headerParams),
            buttonParams: (def?.buttons ?? []).map((b, i) =>
              b.type === "URL" && b.url?.includes("{{")
                ? shown([value.buttonParams[i] ?? ""])[0]
                : "",
            ),
          },
        },
      },
    });
    const payload = buildTemplatePayload(
      cfg,
      SAMPLE_CONTACT,
      {
        kind: kind ?? "followup",
        appointment:
          kind === "appointment_reminder"
            ? {
                startISO: sampleAppointmentISO(),
                calendarLabel: t(
                  "editor.svcWindowSampleCalendar",
                  "Main office",
                ),
                fallbackTimezone: "America/Sao_Paulo",
              }
            : undefined,
      },
      usable,
    );
    if (!payload) return null;
    // The customer also sees where a button leads, so its suffix is filled like the rest.
    const buttons = payload.processedParams.buttons ?? [];
    return {
      content: payload.content,
      buttonUrls: (def?.buttons ?? []).map((b, i) => {
        const suffix = buttons[i]?.parameter;
        return b.url && suffix ? `${b.url.split("{{")[0]}${suffix}` : null;
      }),
    };
  }, [value, kind, usable, def, t]);
  // A stored name the inbox no longer has (or one that cannot be sent) keeps an option of its own,
  // so choosing the empty one clears it instead of re-selecting what is already selected.
  const MISSING = "\u0000missing";
  const unusable = value.name
    ? findTemplateDefinition(templates, value.name, value.language)
    : undefined;
  const pickedKey = def
    ? `${def.name}\u0000${def.language}`
    : value.name
      ? MISSING
      : "";
  const setList =
    (field: "params" | "headerParams", n: number, i: number) => (v: string) => {
      const next = sized(value[field], n);
      next[i] = v;
      onChange({ ...value, [field]: next });
    };
  return (
    <div className="flex flex-col gap-3">
      {templates.length > 0 ? (
        <Select
          value={pickedKey}
          onChange={(e) => {
            if (e.target.value !== MISSING) pick(e.target.value);
          }}
          aria-label={t("editor.svcWindowTemplate", "Template name (HSM)")}
        >
          <option value="">
            {t("editor.svcWindowTemplatePick", "Choose an approved template…")}
          </option>
          {pickedKey === MISSING && (
            <option value={MISSING}>
              {unusable
                ? t(
                    "editor.svcWindowTemplateAuth",
                    "{{name}} (one-time code template, cannot be used)",
                    { name: value.name },
                  )
                : t(
                    "editor.svcWindowTemplateMissing",
                    "{{name}} (not found in the inbox)",
                    { name: value.name },
                  )}
            </option>
          )}
          {usable.map((tpl) => (
            <option
              key={`${tpl.name}\u0000${tpl.language}`}
              value={`${tpl.name}\u0000${tpl.language}`}
            >
              {tpl.language ? `${tpl.name} (${tpl.language})` : tpl.name}
            </option>
          ))}
        </Select>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="reengajamento"
            aria-label={t("editor.svcWindowTemplate", "Template name (HSM)")}
          />
          <Input
            value={value.language}
            onChange={(e) => onChange({ ...value, language: e.target.value })}
            placeholder="pt_BR"
            aria-label={t("editor.svcWindowLang", "Template language")}
          />
          {loaded && (
            <span className="text-text-muted text-xs sm:col-span-2">
              {t(
                "editor.svcWindowNoTemplates",
                "No approved templates found for this agent's inbox. Type a name manually.",
              )}
            </span>
          )}
        </div>
      )}
      {value.name.trim() !== "" &&
        (def ? (
          <div className="flex flex-col gap-1.5">
            <div
              className="border-border bg-bg-subtle rounded-lg border p-3 text-sm leading-6 whitespace-pre-wrap"
              data-testid="service-window-message"
            >
              {showPreview && preview ? (
                whatsappBold(preview.content)
              ) : (
                <>
                  {def.header?.format === "TEXT" && def.header.text && (
                    <div className="font-semibold">
                      {withChips(def.header.text, (_key, i) => (
                        <SlotChip
                          example={def.examples.header[i] ?? ""}
                          value={value.headerParams[i] ?? ""}
                          onChange={setList(
                            "headerParams",
                            headerKeys.length,
                            i,
                          )}
                          offered={offered}
                        />
                      ))}
                    </div>
                  )}
                  {withChips(def.body ?? "", (_key, i) => (
                    <SlotChip
                      example={def.examples.body[i] ?? ""}
                      value={value.params[i] ?? ""}
                      onChange={setList("params", bodyKeys.length, i)}
                      offered={offered}
                    />
                  ))}
                  {def.footer && (
                    <div className="text-text-muted mt-2 text-xs">
                      {def.footer}
                    </div>
                  )}
                </>
              )}
              {def.buttons.length > 0 && (
                <div className="border-border mt-3 flex flex-col gap-1 border-t pt-2">
                  {def.buttons.map((b, i) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: a button IS its position in the template.
                      key={i}
                      className="text-center"
                    >
                      <div className="text-accent font-medium">{b.text}</div>
                      {showPreview && preview?.buttonUrls[i] && (
                        <div className="text-text-muted text-xs break-all">
                          {preview.buttonUrls[i]}
                        </div>
                      )}
                      {!showPreview &&
                        b.type === "URL" &&
                        b.url?.includes("{{") && (
                          <div className="text-text-muted text-xs break-all">
                            {b.url.split("{{")[0]}
                            <SlotChip
                              example={def.examples.buttons[i] ?? ""}
                              value={value.buttonParams[i] ?? ""}
                              onChange={(v) => {
                                const next = sized(
                                  value.buttonParams,
                                  def.buttons.length,
                                );
                                next[i] = v;
                                onChange({ ...value, buttonParams: next });
                              }}
                              offered={offered}
                            />
                          </div>
                        )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className={unfilled ? "text-warning" : "text-text-muted"}>
                {unfilled
                  ? t(
                      "editor.svcWindowSlotsLeft",
                      "Click each dashed blank to choose what goes there.",
                    )
                  : t(
                      "editor.svcWindowSlotsDone",
                      "Click a highlighted item to change it.",
                    )}
              </span>
              {preview && (
                <button
                  type="button"
                  className="text-accent shrink-0 hover:underline"
                  onClick={() => setShowPreview((v) => !v)}
                >
                  {showPreview
                    ? t("editor.svcWindowBackToEdit", "Back to editing")
                    : t(
                        "editor.svcWindowShowPreview",
                        "See it as the customer gets it",
                      )}
                </button>
              )}
            </div>
          </div>
        ) : (
          <FormField
            label={t("editor.svcWindowParams", "Body params")}
            description={t(
              "editor.svcWindowParamsOnePerLine",
              "One per line, in the template's order.",
            )}
          >
            <textarea
              className="border-border bg-bg min-h-16 w-full rounded-md border px-3 py-2 text-sm"
              value={value.params.join("\n")}
              onChange={(e) =>
                onChange({
                  ...value,
                  params:
                    e.target.value === "" ? [] : e.target.value.split("\n"),
                })
              }
            />
          </FormField>
        ))}
    </div>
  );
}

// One place a template can be chosen besides the default: a kind, or one reminder offset.
type Situation =
  | { kind: ProactiveKind }
  | { kind: "appointment_reminder"; offset: number };

const KIND_ICON: Record<ProactiveKind, LucideIcon> = {
  followup: Hourglass,
  snoozed_followup: BellRing,
  appointment_reminder: CalendarClock,
  inbound_event: Webhook,
  channel_redirect: ArrowRightLeft,
};

const situationKey = (s: Situation) =>
  "offset" in s ? `reminder:${s.offset}` : s.kind;

export function ServiceWindowTemplates({
  agentId,
  value,
  onChange,
}: {
  agentId: string;
  value: ServiceWindowForm;
  onChange: (next: ServiceWindowForm) => void;
}) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<TemplateDefinition[]>([]);
  const [agentOffsets, setAgentOffsets] = useState<number[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot["service-window-templates"]({
          agentId,
        }).get();
        if (!cancelled && data) {
          setTemplates(data.templates);
          setAgentOffsets(data.reminderOffsets);
        }
      } catch {
        // best-effort: leave the free-text fields as the fallback
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  const configuredOffsets = value.reminderTemplates.map((r) =>
    Number(r.offset),
  );
  // Hold Save while a situation was added and no template chosen for it: it would be dropped.
  useHoldSave(
    Object.values(value.templates).some((c) => !c?.name.trim()) ||
      value.reminderTemplates.some((r) => !r.choice.name.trim()),
  );
  const kindTitle = (k: ProactiveKind): string => {
    switch (k) {
      case "followup":
        return t("editor.svcWindowKindFollowup", "Inactivity follow-up");
      case "snoozed_followup":
        return t(
          "editor.svcWindowKindSnoozed",
          "Snoozed conversation reminder",
        );
      case "appointment_reminder":
        return t("editor.svcWindowKindReminder", "Appointment reminder");
      case "inbound_event":
        return t("editor.svcWindowKindInbound", "Integration event");
      case "channel_redirect":
        return t(
          "editor.svcWindowKindRedirect",
          "Follow-up after a channel switch",
        );
    }
  };
  const kindWhen = (k: ProactiveKind): string => {
    switch (k) {
      case "followup":
        return t(
          "editor.svcWindowWhenFollowup",
          "When the customer stops replying and the agent picks the conversation back up.",
        );
      case "snoozed_followup":
        return t(
          "editor.svcWindowWhenSnoozed",
          "When a person snoozed the conversation and the customer did not reply by then.",
        );
      case "appointment_reminder":
        return t(
          "editor.svcWindowWhenReminder",
          "Before an appointment the agent booked, at every reminder lead time.",
        );
      case "inbound_event":
        return t(
          "editor.svcWindowWhenInbound",
          "When an integration reports something (an order shipped, say) and the agent tells the customer.",
        );
      case "channel_redirect":
        return t(
          "editor.svcWindowWhenRedirect",
          "When the customer was sent from WhatsApp to the website chat and stopped replying there.",
        );
    }
  };
  const situationTitle = (s: Situation) =>
    "offset" in s
      ? t("editor.svcWindowOffsetTitle", "Reminder {{hours}}h before", {
          hours: s.offset,
        })
      : kindTitle(s.kind);
  const situationWhen = (s: Situation) =>
    "offset" in s
      ? agentOffsets.includes(s.offset)
        ? t(
            "editor.svcWindowWhenOffset",
            "Only the reminder sent {{hours}}h before. The other reminders use the appointment reminder's template, or the default.",
            { hours: s.offset },
          )
        : t(
            "editor.svcWindowOffsetUnused",
            "No booking tool of this agent sends a reminder {{hours}}h before today, so this template is not used.",
            { hours: s.offset },
          )
      : kindWhen(s.kind);
  const configured: Situation[] = PROACTIVE_KINDS.flatMap((kind) => [
    ...(value.templates[kind] ? [{ kind }] : []),
    ...(kind === "appointment_reminder"
      ? [...configuredOffsets]
          .sort((a, b) => b - a)
          .map((offset) => ({ kind, offset }) as Situation)
      : []),
  ]);
  const available: Situation[] = PROACTIVE_KINDS.flatMap((kind) => [
    ...(value.templates[kind] ? [] : [{ kind }]),
    ...(kind === "appointment_reminder"
      ? agentOffsets
          .filter((h) => !configuredOffsets.includes(h))
          .map((offset) => ({ kind, offset }) as Situation)
      : []),
  ]);
  const choiceOf = (s: Situation) =>
    "offset" in s
      ? value.reminderTemplates.find((r) => Number(r.offset) === s.offset)
          ?.choice
      : value.templates[s.kind];
  const setChoice = (s: Situation, c: TemplateChoiceForm | null) => {
    if ("offset" in s) {
      const rest = value.reminderTemplates.filter(
        (r) => Number(r.offset) !== s.offset,
      );
      onChange({
        ...value,
        reminderTemplates: c
          ? [...rest, { offset: String(s.offset), choice: c }]
          : rest,
      });
      return;
    }
    const { [s.kind]: _drop, ...rest } = value.templates;
    onChange({ ...value, templates: c ? { ...rest, [s.kind]: c } : rest });
  };
  return (
    <div className="flex flex-col gap-6">
      <FormField
        label={t("editor.svcWindowDefaultTemplate", "Default template")}
        group
        description={t(
          "editor.svcWindowDefaultTemplateHint",
          "Sent outside the window by every proactive message that has no template of its own below. Without one, the message becomes a private note in the conversation.",
        )}
      >
        <TemplateChoiceEditor
          value={value.def}
          onChange={(def) => onChange({ ...value, def })}
          templates={templates}
          loaded={loaded}
          kind={null}
        />
      </FormField>
      <div className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium">
            {t(
              "editor.svcWindowSituationsTitle",
              "Templates for specific situations",
            )}
          </div>
          <p className="text-text-muted text-xs">
            {t(
              "editor.svcWindowSituationsHint",
              "Optional. Use a different template in one situation; every other one keeps the default.",
            )}
          </p>
        </div>
        {configured.map((s) => {
          const choice = choiceOf(s);
          if (!choice) return null;
          const Icon = KIND_ICON[s.kind];
          return (
            <div
              key={situationKey(s)}
              className="border-border flex flex-col gap-3 rounded-lg border p-4"
              data-testid={`situation-${situationKey(s)}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <Icon
                    className="text-text-muted mt-0.5 h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <div className="text-sm font-medium">
                      {situationTitle(s)}
                    </div>
                    <p className="text-text-muted text-xs">
                      {situationWhen(s)}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t(
                    "editor.svcWindowRemoveSituation",
                    "Remove (back to the default)",
                  )}
                  title={t(
                    "editor.svcWindowRemoveSituation",
                    "Remove (back to the default)",
                  )}
                  onClick={() => setChoice(s, null)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <TemplateChoiceEditor
                value={choice}
                onChange={(c) => setChoice(s, c)}
                templates={templates}
                loaded={loaded}
                kind={s.kind}
              />
            </div>
          );
        })}
        {available.length > 0 && (
          <div className="max-w-md">
            <Dropdown
              value={null}
              ariaLabel={t(
                "editor.svcWindowAddSituation",
                "Use another template in a situation",
              )}
              placeholder={`+ ${t(
                "editor.svcWindowAddSituation",
                "Use another template in a situation",
              )}`}
              items={available.map((s) => ({
                value: situationKey(s),
                label: situationTitle(s),
                icon: KIND_ICON[s.kind],
                description: situationWhen(s),
              }))}
              onChange={(key) => {
                const s = available.find((x) => situationKey(x) === key);
                if (s) setChoice(s, { ...EMPTY_CHOICE });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
