import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  NumberInput,
  Select,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { REMINDER_OFFSET_RANGE } from "@/modules/integrations/calendar-config-ranges";
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
  const def = value.name
    ? findTemplateDefinition(templates, value.name, value.language)
    : undefined;
  const bodyKeys = templatePlaceholders(def?.body ?? null);
  const headerKeys =
    def?.header?.format === "TEXT" ? templatePlaceholders(def.header.text) : [];
  const dynamicButtons = (def?.buttons ?? []).map(
    (b) => b.type === "URL" && templatePlaceholders(b.url).length > 0,
  );
  const pick = (key: string) => {
    if (!key) {
      onChange({ ...EMPTY_CHOICE });
      return;
    }
    const [name, language] = key.split("\u0000") as [string, string];
    const d = findTemplateDefinition(templates, name, language);
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
  const preview = useMemo(() => {
    if (!value.name.trim()) return null;
    const cfg = readServiceWindowConfig({
      serviceWindow: { templates: { [kind ?? "followup"]: value } },
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
      templates,
    );
    return payload?.content ?? null;
  }, [value, kind, templates, t]);
  const paramHint =
    kind === "appointment_reminder"
      ? t("editor.svcWindowParamHintReminder", "Text or variables: {{vars}}.", {
          vars: "{{primeiro_nome}}, {{nome_contato}}, {{data_agendamento}}, {{hora_agendamento}}, {{dia_semana_agendamento}}, {{agenda}}",
        })
      : t("editor.svcWindowParamHint", "Text or variables: {{vars}}.", {
          vars: "{{primeiro_nome}}, {{nome_contato}}",
        });
  const listField = (
    label: string,
    keys: string[],
    list: string[],
    set: (next: string[]) => void,
  ) =>
    keys.map((key, i) => (
      <FormField key={`${label}-${key}`} label={`${label} {{${key}}}`}>
        <Input
          value={list[i] ?? ""}
          onChange={(e) => {
            const next = sized(list, keys.length);
            next[i] = e.target.value;
            set(next);
          }}
        />
      </FormField>
    ));
  const pickedKey = def ? `${def.name}\u0000${def.language}` : "";
  return (
    <div className="flex flex-col gap-3">
      {templates.length > 0 ? (
        <Select
          value={pickedKey}
          onChange={(e) => pick(e.target.value)}
          aria-label={t("editor.svcWindowTemplate", "Template name (HSM)")}
        >
          <option value="">
            {value.name && !def
              ? t(
                  "editor.svcWindowTemplateMissing",
                  "{{name}} (not found in the inbox)",
                  {
                    name: value.name,
                  },
                )
              : t(
                  "editor.svcWindowTemplatePick",
                  "Choose an approved template…",
                )}
          </option>
          {templates.map((tpl) => (
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
      {value.name.trim() !== "" && (
        <>
          {def ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {listField(
                t("editor.svcWindowHeaderParam", "Header"),
                headerKeys,
                value.headerParams,
                (headerParams) => onChange({ ...value, headerParams }),
              )}
              {listField(
                t("editor.svcWindowBodyParam", "Body"),
                bodyKeys,
                value.params,
                (params) => onChange({ ...value, params }),
              )}
              {dynamicButtons.map((dynamic, i) =>
                dynamic ? (
                  <FormField
                    // biome-ignore lint/suspicious/noArrayIndexKey: a button IS its position in the template.
                    key={`button-${i}`}
                    label={t(
                      "editor.svcWindowButtonParam",
                      'Button "{{text}}": end of the URL',
                      {
                        text: def.buttons[i]?.text ?? "",
                      },
                    )}
                  >
                    <Input
                      value={value.buttonParams[i] ?? ""}
                      onChange={(e) => {
                        const next = sized(
                          value.buttonParams,
                          def.buttons.length,
                        );
                        next[i] = e.target.value;
                        onChange({ ...value, buttonParams: next });
                      }}
                    />
                  </FormField>
                ) : null,
              )}
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
                className="min-h-16 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
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
          )}
          <p className="text-text-muted text-xs">{paramHint}</p>
          {preview && (
            <div
              className="whitespace-pre-wrap rounded-md border border-border bg-bg-subtle p-3 text-sm"
              data-testid="service-window-preview"
            >
              <div className="mb-1 font-medium text-text-muted text-xs">
                {t("editor.svcWindowPreview", "Preview (sample values)")}
              </div>
              {preview}
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot["service-window-templates"]({
          agentId,
        }).get();
        if (!cancelled && data) setTemplates(data.templates);
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
  const kindLabel = (k: ProactiveKind): string => {
    switch (k) {
      case "followup":
        return t("editor.svcWindowKindFollowup", "Inactivity follow-up");
      case "snoozed_followup":
        return t("editor.svcWindowKindSnoozed", "Snoozed follow-up");
      case "appointment_reminder":
        return t("editor.svcWindowKindReminder", "Appointment reminder");
      case "inbound_event":
        return t("editor.svcWindowKindInbound", "Integration event");
      case "document_approval":
        return t("editor.svcWindowKindDocument", "Approved document");
      case "channel_redirect":
        return t("editor.svcWindowKindRedirect", "Channel redirect link");
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <FormField
        label={t("editor.svcWindowDefaultTemplate", "Default template")}
        group
        description={t(
          "editor.svcWindowDefaultTemplateHint",
          "Sent outside the window by every kind of proactive message that has no template of its own. Blank: a private note instead.",
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
      {PROACTIVE_KINDS.map((kind) => {
        const own = value.templates[kind];
        return (
          <FormField
            key={kind}
            label={kindLabel(kind)}
            group
            description={
              own
                ? undefined
                : t("editor.svcWindowUsesDefault", "Uses the default template.")
            }
          >
            <div className="flex flex-col gap-3">
              {own ? (
                <>
                  <TemplateChoiceEditor
                    value={own}
                    onChange={(c) =>
                      onChange({
                        ...value,
                        templates: { ...value.templates, [kind]: c },
                      })
                    }
                    templates={templates}
                    loaded={loaded}
                    kind={kind}
                  />
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const { [kind]: _drop, ...rest } = value.templates;
                        onChange({ ...value, templates: rest });
                      }}
                    >
                      {t(
                        "editor.svcWindowUseDefault",
                        "Use the default instead",
                      )}
                    </Button>
                  </div>
                </>
              ) : (
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      onChange({
                        ...value,
                        templates: {
                          ...value.templates,
                          [kind]: { ...EMPTY_CHOICE },
                        },
                      })
                    }
                  >
                    {t(
                      "editor.svcWindowOwnTemplate",
                      "Choose a template for this kind",
                    )}
                  </Button>
                </div>
              )}
              {kind === "appointment_reminder" && (
                <div className="flex flex-col gap-3 border-border border-l-2 pl-3">
                  {value.reminderTemplates.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; the offset is editable.
                    <div key={i} className="flex flex-col gap-2">
                      <div className="flex items-end gap-2">
                        <FormField
                          label={t(
                            "editor.svcWindowReminderOffset",
                            "Reminder sent this many hours before",
                          )}
                        >
                          <NumberInput
                            range={REMINDER_OFFSET_RANGE}
                            value={row.offset}
                            onChange={(e) => {
                              const next = [...value.reminderTemplates];
                              next[i] = { ...row, offset: e.target.value };
                              onChange({ ...value, reminderTemplates: next });
                            }}
                          />
                        </FormField>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t(
                            "editor.svcWindowRemoveOffset",
                            "Remove",
                          )}
                          onClick={() =>
                            onChange({
                              ...value,
                              reminderTemplates: value.reminderTemplates.filter(
                                (_, j) => j !== i,
                              ),
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <TemplateChoiceEditor
                        value={row.choice}
                        onChange={(choice) => {
                          const next = [...value.reminderTemplates];
                          next[i] = { ...row, choice };
                          onChange({ ...value, reminderTemplates: next });
                        }}
                        templates={templates}
                        loaded={loaded}
                        kind="appointment_reminder"
                      />
                    </div>
                  ))}
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onChange({
                          ...value,
                          reminderTemplates: [
                            ...value.reminderTemplates,
                            { offset: "", choice: { ...EMPTY_CHOICE } },
                          ],
                        })
                      }
                    >
                      <Plus className="h-4 w-4" />
                      {t(
                        "editor.svcWindowAddOffset",
                        "Another template for one specific reminder",
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </FormField>
        );
      })}
    </div>
  );
}
