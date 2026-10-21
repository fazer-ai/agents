import { buildPromptVars, interpolatePromptVars } from "@/graph/prompt";
import { SERVICE_WINDOW_RANGES } from "@/modules/agents/number-ranges";
import { APPOINTMENT_VARS, PROACTIVE_KINDS, type ProactiveKind } from "./kinds";

export { APPOINTMENT_VARS, PROACTIVE_KINDS, type ProactiveKind };

// WhatsApp 24h service window. Free-form business messages are only allowed within 24h of the
// customer's last inbound message; outside it, an APPROVED template (HSM) is required. This gates the
// PROACTIVE paths (follow-up / inbound-event nudge) — the reactive reply is always in-window (the
// customer just messaged). Inside the window → free-form; outside → an HSM template if configured,
// else a private note (never a free-form message that WhatsApp would reject). Per agent.

// One approved template and how to fill it. Params are positional per component, and each may carry
// {{placeholders}}: the contact's on every kind, the appointment's on reminders only.
export interface TemplateChoice {
  name: string;
  language: string; // e.g. "pt_BR"
  category: string; // e.g. "UTILITY"
  params: string[]; // body {{1}},{{2}}…
  headerParams: string[]; // a TEXT header's {{1}}
  // One entry per button, by the button's position in the template: the suffix of a dynamic URL
  // button, "" for a button that takes nothing.
  buttonParams: string[];
  // Optional dashboard-facing rendered text (WhatsApp sends the approved template via template_params
  // regardless). Falls back to the joined params / template name.
  content: string | null;
}

export interface ServiceWindowConfig {
  enabled: boolean; // apply the gate (default true; disable for channels with no 24h window)
  windowHours: number; // default 24
  // The DEFAULT approved template (HSM) sent outside the window. Null → fall back to a private note.
  templateName: string | null;
  templateLanguage: string; // e.g. "pt_BR"
  templateCategory: string; // e.g. "UTILITY"
  // Positional body params ({{1}},{{2}}…). Each may use {{nome_contato}}/{{primeiro_nome}} placeholders.
  templateParams: string[];
  templateHeaderParams: string[];
  templateButtonParams: string[];
  templateContent: string | null;
  // Per-kind overrides of the default. An absent kind uses the default.
  templates: Partial<Record<ProactiveKind, TemplateChoice>>;
  // Per reminder offset (hours before the start, as written in the reminder settings) overrides of
  // `templates.appointment_reminder`, for an agent that reminds more than once.
  reminderTemplates: Record<string, TemplateChoice>;
}

export const SERVICE_WINDOW_DEFAULTS: ServiceWindowConfig = {
  enabled: true,
  windowHours: 24,
  templateName: null,
  templateLanguage: "pt_BR",
  templateCategory: "UTILITY",
  templateParams: [],
  templateHeaderParams: [],
  templateButtonParams: [],
  templateContent: null,
  templates: {},
  reminderTemplates: {},
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function clampHours(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return SERVICE_WINDOW_DEFAULTS.windowHours;
  }
  const { min, max } = SERVICE_WINDOW_RANGES.windowHours;
  return Math.min(Math.max(Math.round(v), min), max);
}

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((p): p is string => typeof p === "string")
    : [];
}

function readChoice(v: unknown): TemplateChoice | null {
  if (!v || typeof v !== "object") return null;
  const bag = v as Record<string, unknown>;
  const name = str(bag.name);
  if (!name) return null;
  return {
    name,
    language: str(bag.language) ?? "pt_BR",
    category: str(bag.category) ?? "UTILITY",
    params: strings(bag.params),
    headerParams: strings(bag.headerParams),
    buttonParams: strings(bag.buttonParams),
    content: str(bag.content),
  };
}

// The offset key, written from the number so "24", "24.0" and 24 are one reminder.
export function reminderOffsetKey(hours: number): string {
  return String(hours);
}

export function readServiceWindowConfig(
  settings: unknown,
): ServiceWindowConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).serviceWindow
      : undefined;
  if (!s || typeof s !== "object") return { ...SERVICE_WINDOW_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const templates: Partial<Record<ProactiveKind, TemplateChoice>> = {};
  if (bag.templates && typeof bag.templates === "object") {
    const raw = bag.templates as Record<string, unknown>;
    for (const kind of PROACTIVE_KINDS) {
      const choice = readChoice(raw[kind]);
      if (choice) templates[kind] = choice;
    }
  }
  const reminderTemplates: Record<string, TemplateChoice> = {};
  if (bag.reminderTemplates && typeof bag.reminderTemplates === "object") {
    for (const [k, v] of Object.entries(
      bag.reminderTemplates as Record<string, unknown>,
    )) {
      const hours = Number(k);
      const choice = readChoice(v);
      if (choice && Number.isFinite(hours) && hours > 0) {
        reminderTemplates[reminderOffsetKey(hours)] = choice;
      }
    }
  }
  return {
    enabled:
      typeof bag.enabled === "boolean"
        ? bag.enabled
        : SERVICE_WINDOW_DEFAULTS.enabled,
    windowHours: clampHours(bag.windowHours),
    templateName: str(bag.templateName),
    templateLanguage: str(bag.templateLanguage) ?? "pt_BR",
    templateCategory: str(bag.templateCategory) ?? "UTILITY",
    templateParams: strings(bag.templateParams),
    templateHeaderParams: strings(bag.templateHeaderParams),
    templateButtonParams: strings(bag.templateButtonParams),
    templateContent: str(bag.templateContent),
    templates,
    reminderTemplates,
  };
}

export function isWithinServiceWindow(
  lastInboundAt: Date | null,
  now: Date,
  windowHours: number,
): boolean {
  if (!lastInboundAt) return false; // no inbound ever → outside the window (business-initiated)
  return now.getTime() - lastInboundAt.getTime() < windowHours * 3_600_000;
}

// The inbox's channel identity, as mirrored from Chatwoot. Both fields drive the service-window gate.
export interface InboxChannel {
  channelType: string | null;
  provider: string | null;
}

// Only the OFFICIAL WhatsApp Business Platform has a 24h window + HSM templates. On Chatwoot all
// WhatsApp inboxes share channel_type "Channel::Whatsapp"; the `provider` distinguishes the official
// API (whatsapp_cloud = Cloud API; default = 360dialog BSP) from the unofficial bridges (baileys/zapi),
// which have NO window and NO templates. So channel_type alone is insufficient — the provider decides.
const OFFICIAL_WHATSAPP_PROVIDERS = new Set(["whatsapp_cloud", "default"]);

// Whether a proactive send on this channel is subject to the 24h window. True only for the official
// WhatsApp providers. A null/unknown provider on a WhatsApp inbox → false (treated as no window): it
// favors the common bridge case and fails visibly (a rejected free-form is logged) rather than silently
// degrading every proactive send to a note; an inbox sync populates the provider and self-heals.
export function channelHasServiceWindow(channel: InboxChannel): boolean {
  return (
    channel.channelType === "Channel::Whatsapp" &&
    OFFICIAL_WHATSAPP_PROVIDERS.has(channel.provider ?? "")
  );
}

export type ProactiveSendMode = "freeform" | "template" | "note";

// What a proactive send knows about itself when it picks a template: its kind, a reminder's offset,
// and the appointment a reminder is about. Absent is the default template, as before kinds existed.
export interface TemplateOccasion {
  kind: ProactiveKind;
  offsetHours?: number;
  appointment?: AppointmentFacts;
}

export interface AppointmentFacts {
  // The start as the calendar wrote it, offset included: its wall clock IS the calendar's.
  startISO: string;
  calendarLabel: string | null;
  // The zone to read a start that states no offset (`Z`) in: the agent's.
  fallbackTimezone: string;
}

// The template this occasion sends: the reminder's own offset first, then its kind, then the default.
export function resolveTemplateChoice(
  cfg: ServiceWindowConfig,
  occasion?: TemplateOccasion,
): TemplateChoice | null {
  if (occasion?.kind === "appointment_reminder" && occasion.offsetHours) {
    const byOffset =
      cfg.reminderTemplates[reminderOffsetKey(occasion.offsetHours)];
    if (byOffset) return byOffset;
  }
  const byKind = occasion ? cfg.templates[occasion.kind] : undefined;
  if (byKind) return byKind;
  if (!cfg.templateName) return null;
  return {
    name: cfg.templateName,
    language: cfg.templateLanguage,
    category: cfg.templateCategory,
    params: cfg.templateParams,
    headerParams: cfg.templateHeaderParams,
    buttonParams: cfg.templateButtonParams,
    content: cfg.templateContent,
  };
}

// What a proactive sender may do right now. Free-form when: the channel has no 24h window (baileys/zapi
// and non-WhatsApp channels), the operator disabled the gate, or we are inside the window. Outside the
// window on an official WhatsApp channel → template if THIS occasion has one, else a private note.
export function proactiveSendMode(
  cfg: ServiceWindowConfig,
  lastInboundAt: Date | null,
  now: Date,
  channel: InboxChannel,
  occasion?: TemplateOccasion,
): ProactiveSendMode {
  if (!cfg.enabled || !channelHasServiceWindow(channel)) return "freeform";
  if (isWithinServiceWindow(lastInboundAt, now, cfg.windowHours)) {
    return "freeform";
  }
  return resolveTemplateChoice(cfg, occasion) ? "template" : "note";
}

const ALL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATED_OFFSET = /([+-])(\d{2}):?(\d{2})$/;

// A template language ("pt_BR") as a BCP 47 tag Intl reads ("pt-BR"); an unknown one falls back to
// pt-BR, the product's default, rather than throwing on a send.
function intlLocale(language: string): string {
  const tag = language.replace(/_/g, "-");
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0
      ? tag
      : "pt-BR";
  } catch {
    return "pt-BR";
  }
}

// The date, time and weekday the CUSTOMER reads, in the calendar's own wall clock: a start with a
// stated offset is read at that offset (never converted), one in UTC in the agent's zone, and an
// all-day one has a date and a weekday but no time.
export function appointmentVars(
  facts: AppointmentFacts,
  language: string,
): Record<string, string> {
  const locale = intlLocale(language);
  const label = facts.calendarLabel?.trim() ?? "";
  const out: Record<string, string> = { agenda: label, calendar_name: label };
  let instant: Date;
  let timeZone: string;
  let hasTime = true;
  if (ALL_DAY.test(facts.startISO)) {
    instant = new Date(`${facts.startISO}T12:00:00Z`);
    timeZone = "UTC";
    hasTime = false;
  } else {
    const ms = Date.parse(facts.startISO);
    if (!Number.isFinite(ms)) {
      for (const k of APPOINTMENT_VARS) out[k] ??= "";
      return out;
    }
    const m = STATED_OFFSET.exec(facts.startISO);
    // `+00:00` is a wall clock (London in winter); `Z` and `-00:00` (ISO 8601's "unknown") are not.
    const offset =
      m && !(m[1] === "-" && m[2] === "00" && m[3] === "00")
        ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
        : null;
    if (offset !== null) {
      // NOTE: Shifted to the stated wall clock and printed as UTC: the payload carries an offset, not
      // an IANA zone, and the offset is what the calendar said the customer's hour is.
      instant = new Date(ms + offset * 60_000);
      timeZone = "UTC";
    } else {
      instant = new Date(ms);
      timeZone = facts.fallbackTimezone;
    }
  }
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone, ...o }).format(instant);
  const date = fmt({ day: "2-digit", month: "2-digit", year: "numeric" });
  const weekday = fmt({ weekday: "long" });
  const time = hasTime ? fmt({ hour: "2-digit", minute: "2-digit" }) : "";
  out.data_agendamento = out.appointment_date = date;
  out.dia_semana_agendamento = out.appointment_weekday = weekday;
  out.hora_agendamento = out.appointment_time = time;
  return out;
}

// What the synced template says about itself, read from the inbox's `message_templates` (Meta's
// template object). Enough to count placeholders, map NAMED ones, and render what the customer reads.
export interface TemplateDefinition {
  name: string;
  language: string;
  category: string;
  parameterFormat: "POSITIONAL" | "NAMED";
  header: { format: string; text: string | null } | null;
  body: string | null;
  footer: string | null;
  buttons: Array<{ type: string; text: string; url: string | null }>;
}

const PLACEHOLDER_IN_TEMPLATE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// The distinct placeholders of a component's text, in the order they first appear.
export function templatePlaceholders(text: string | null): string[] {
  if (!text) return [];
  const seen: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_IN_TEMPLATE)) {
    const key = m[1] as string;
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

export function parseTemplateDefinition(
  raw: unknown,
): TemplateDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  if (!name) return null;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  let header: TemplateDefinition["header"] = null;
  let body: string | null = null;
  let footer: string | null = null;
  const buttons: TemplateDefinition["buttons"] = [];
  for (const c of Array.isArray(o.components) ? o.components : []) {
    if (!c || typeof c !== "object") continue;
    const comp = c as Record<string, unknown>;
    const type = String(comp.type ?? "").toUpperCase();
    if (type === "HEADER") {
      header = {
        format: String(comp.format ?? "TEXT").toUpperCase(),
        text: text(comp.text),
      };
    } else if (type === "BODY") body = text(comp.text);
    else if (type === "FOOTER") footer = text(comp.text);
    else if (type === "BUTTONS" && Array.isArray(comp.buttons)) {
      for (const b of comp.buttons) {
        if (!b || typeof b !== "object") continue;
        const btn = b as Record<string, unknown>;
        buttons.push({
          type: String(btn.type ?? "").toUpperCase(),
          text: text(btn.text) ?? "",
          url: text(btn.url),
        });
      }
    }
  }
  return {
    name,
    language: typeof o.language === "string" ? o.language : "",
    category: typeof o.category === "string" ? o.category : "",
    parameterFormat:
      String(o.parameter_format ?? "").toUpperCase() === "NAMED"
        ? "NAMED"
        : "POSITIONAL",
    header,
    body,
    footer,
    buttons,
  };
}

export function findTemplateDefinition(
  defs: readonly TemplateDefinition[],
  name: string,
  language: string,
): TemplateDefinition | undefined {
  return defs.find(
    (d) =>
      d.name === name && d.language.toLowerCase() === language.toLowerCase(),
  );
}

// Why a choice cannot be sent with this inbox's templates: an i18n key (under `errors.`), its
// values, and the English sentence that is the log line and the untranslated fallback.
export interface TemplateProblem {
  key:
    | "serviceWindowTemplateNotFound"
    | "serviceWindowTemplateLanguage"
    | "serviceWindowTemplateBodyCount"
    | "serviceWindowTemplateHeaderCount"
    | "serviceWindowTemplateMediaHeader"
    | "serviceWindowTemplateButtonCount"
    | "serviceWindowTemplateButtonNeedsSuffix"
    | "serviceWindowTemplateButtonTakesNone";
  params: Record<string, string | number>;
  message: string;
}

// Asked at save against the synced definitions, so a mismatch is a refusal the operator reads instead
// of a channel error (132000) at send time. Null when the choice can be sent.
export function templateChoiceProblem(
  choice: TemplateChoice,
  defs: readonly TemplateDefinition[],
): TemplateProblem | null {
  const name = choice.name;
  const sameName = defs.filter((d) => d.name === name);
  if (sameName.length === 0) {
    return {
      key: "serviceWindowTemplateNotFound",
      params: { name },
      message: `template "${name}" is not an approved template of this agent's inbox`,
    };
  }
  const def = findTemplateDefinition(sameName, name, choice.language);
  if (!def) {
    const available = sameName.map((d) => d.language).join(", ");
    return {
      key: "serviceWindowTemplateLanguage",
      params: { name, language: choice.language, available },
      message: `template "${name}" has no "${choice.language}" version (available: ${available})`,
    };
  }
  const bodyWant = templatePlaceholders(def.body).length;
  if (bodyWant !== choice.params.length) {
    return {
      key: "serviceWindowTemplateBodyCount",
      params: { name, want: bodyWant, got: choice.params.length },
      message: `template "${name}" takes ${bodyWant} body parameter(s), ${choice.params.length} configured`,
    };
  }
  if (def.header && def.header.format !== "TEXT") {
    const format = def.header.format.toLowerCase();
    return {
      key: "serviceWindowTemplateMediaHeader",
      params: { name, format },
      message: `template "${name}" has a ${format} header, which proactive sends do not fill`,
    };
  }
  const headerWant = templatePlaceholders(def.header?.text ?? null).length;
  if (headerWant !== choice.headerParams.length) {
    return {
      key: "serviceWindowTemplateHeaderCount",
      params: { name, want: headerWant, got: choice.headerParams.length },
      message: `template "${name}" takes ${headerWant} header parameter(s), ${choice.headerParams.length} configured`,
    };
  }
  if (choice.buttonParams.length > def.buttons.length) {
    return {
      key: "serviceWindowTemplateButtonCount",
      params: {
        name,
        want: def.buttons.length,
        got: choice.buttonParams.length,
      },
      message: `template "${name}" has ${def.buttons.length} button(s), ${choice.buttonParams.length} configured`,
    };
  }
  for (const [i, btn] of def.buttons.entries()) {
    const dynamic =
      btn.type === "URL" && templatePlaceholders(btn.url).length > 0;
    const given = (choice.buttonParams[i] ?? "").trim() !== "";
    const params = { name, index: i + 1, text: btn.text };
    if (dynamic && !given) {
      return {
        key: "serviceWindowTemplateButtonNeedsSuffix",
        params,
        message: `template "${name}" button ${i + 1} ("${btn.text}") needs the end of its URL`,
      };
    }
    if (!dynamic && given) {
      return {
        key: "serviceWindowTemplateButtonTakesNone",
        params,
        message: `template "${name}" button ${i + 1} ("${btn.text}") takes no parameter`,
      };
    }
  }
  return null;
}

// Every configured choice, named the way a refusal should name it.
export function configuredChoices(cfg: ServiceWindowConfig): Array<{
  where: string;
  kind: ProactiveKind | null;
  choice: TemplateChoice;
}> {
  const out: Array<{
    where: string;
    kind: ProactiveKind | null;
    choice: TemplateChoice;
  }> = [];
  const def = resolveTemplateChoice(cfg);
  if (def) out.push({ where: "serviceWindow", kind: null, choice: def });
  for (const kind of PROACTIVE_KINDS) {
    const c = cfg.templates[kind];
    if (c)
      out.push({ where: `serviceWindow.templates.${kind}`, kind, choice: c });
  }
  for (const [offset, c] of Object.entries(cfg.reminderTemplates)) {
    out.push({
      where: `serviceWindow.reminderTemplates.${offset}`,
      kind: "appointment_reminder",
      choice: c,
    });
  }
  return out;
}

const APPOINTMENT_VAR_PATTERN = new RegExp(
  `\\{\\{\\s*(${APPOINTMENT_VARS.join("|")})\\s*(?::[^}]*)?\\}\\}`,
);

// An appointment placeholder where no appointment exists: on the default (which every kind sends)
// or on a kind that is not a reminder. It would go out as an empty value, so the save refuses it.
export function misplacedAppointmentVar(
  cfg: ServiceWindowConfig,
): { where: string; placeholder: string } | null {
  for (const { where, kind, choice } of configuredChoices(cfg)) {
    if (kind === "appointment_reminder") continue;
    for (const p of [
      ...choice.params,
      ...choice.headerParams,
      ...choice.buttonParams,
      choice.content ?? "",
    ]) {
      const m = APPOINTMENT_VAR_PATTERN.exec(p);
      if (m) return { where, placeholder: m[1] as string };
    }
  }
  return null;
}

export interface TemplatePayload {
  content: string;
  name: string;
  category: string;
  language: string;
  processedParams: {
    body: Record<string, string>;
    header?: Record<string, string>;
    buttons?: Array<{ type?: string; parameter?: string }>;
  };
}

// The text the customer reads, the template's own components with the values in place.
export function renderTemplateText(
  def: TemplateDefinition,
  values: { body: string[]; header: string[] },
): string {
  const fill = (text: string | null, vals: string[]) => {
    if (!text) return "";
    const keys = templatePlaceholders(text);
    return text.replace(PLACEHOLDER_IN_TEMPLATE, (_m, key: string) => {
      const v = vals[keys.indexOf(key)];
      return v === undefined || v === "" ? `{{${key}}}` : v;
    });
  };
  const header =
    def.header?.format === "TEXT" ? fill(def.header.text, values.header) : "";
  return [
    header ? `*${header}*` : "",
    fill(def.body, values.body),
    def.footer ?? "",
  ]
    .filter((x) => x !== "")
    .join("\n\n");
}

// Builds the HSM payload for client.sendTemplate: the occasion's template, its params with the
// contact's (and on a reminder the appointment's) placeholders filled, keyed the way Chatwoot's
// `processed_params` reads them (body/header by placeholder, buttons by position). With the synced
// definition at hand, a NAMED template is keyed by name and `content` is the text the customer reads.
export function buildTemplatePayload(
  cfg: ServiceWindowConfig,
  contactName: string | null,
  occasion?: TemplateOccasion,
  definitions: readonly TemplateDefinition[] = [],
): TemplatePayload | null {
  const choice = resolveTemplateChoice(cfg, occasion);
  if (!choice) return null;
  const vars = {
    ...buildPromptVars({
      contactName,
      contactEmail: null,
      contactPhone: null,
      inboxName: null,
    }),
    ...(occasion?.appointment
      ? appointmentVars(occasion.appointment, choice.language)
      : {}),
  };
  const fill = (list: string[]) =>
    list.map((p) => interpolatePromptVars(p, vars));
  const params = fill(choice.params);
  const headerParams = fill(choice.headerParams);
  const buttonParams = fill(choice.buttonParams);
  const def = findTemplateDefinition(definitions, choice.name, choice.language);
  const keyed = (values: string[], text: string | null) => {
    const names =
      def?.parameterFormat === "NAMED" ? templatePlaceholders(text) : [];
    const out: Record<string, string> = {};
    values.forEach((v, i) => {
      out[names[i] ?? String(i + 1)] = v;
    });
    return out;
  };
  const processedParams: TemplatePayload["processedParams"] = {
    body: keyed(params, def?.body ?? null),
  };
  if (headerParams.length > 0) {
    processedParams.header = keyed(headerParams, def?.header?.text ?? null);
  }
  // Positional, a blank entry kept as `{}`: Chatwoot numbers a button by its place in this
  // array, so dropping a static button's slot would hand the next button's suffix to the wrong one.
  const lastButton = buttonParams.findLastIndex((p) => p.trim() !== "");
  if (lastButton >= 0) {
    processedParams.buttons = buttonParams
      .filter((_, i) => i <= lastButton)
      .map((p) => (p.trim() ? { type: "url", parameter: p.trim() } : {}));
  }
  const content = def
    ? renderTemplateText(def, { body: params, header: headerParams })
    : choice.content
      ? interpolatePromptVars(choice.content, vars)
      : params.join(" ") || choice.name;
  return {
    content,
    name: choice.name,
    category: choice.category,
    language: choice.language,
    processedParams,
  };
}
