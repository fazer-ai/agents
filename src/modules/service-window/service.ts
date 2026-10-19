import { buildPromptVars, interpolatePromptVars } from "@/graph/prompt";
import { SERVICE_WINDOW_RANGES } from "@/modules/agents/number-ranges";

// WhatsApp 24h service window. Free-form business messages are only allowed within 24h of the
// customer's last inbound message; outside it, an APPROVED template (HSM) is required. This gates the
// PROACTIVE paths (follow-up / inbound-event nudge) — the reactive reply is always in-window (the
// customer just messaged). Inside the window → free-form; outside → an HSM template if configured,
// else a private note (never a free-form message that WhatsApp would reject). Per agent.

export interface ServiceWindowConfig {
  enabled: boolean; // apply the gate (default true; disable for channels with no 24h window)
  windowHours: number; // default 24
  // Approved template (HSM) to send outside the window. Null → fall back to a private note.
  templateName: string | null;
  templateLanguage: string; // e.g. "pt_BR"
  templateCategory: string; // e.g. "UTILITY"
  // Positional body params ({{1}},{{2}}…). Each may use {contact_name}/{primeiro_nome} placeholders.
  templateParams: string[];
  // Optional dashboard-facing rendered text (WhatsApp sends the approved template via template_params
  // regardless). Falls back to the joined params / template name.
  templateContent: string | null;
}

export const SERVICE_WINDOW_DEFAULTS: ServiceWindowConfig = {
  enabled: true,
  windowHours: 24,
  templateName: null,
  templateLanguage: "pt_BR",
  templateCategory: "UTILITY",
  templateParams: [],
  templateContent: null,
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

export function readServiceWindowConfig(
  settings: unknown,
): ServiceWindowConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).serviceWindow
      : undefined;
  if (!s || typeof s !== "object") return { ...SERVICE_WINDOW_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const params = Array.isArray(bag.templateParams)
    ? bag.templateParams.filter((p): p is string => typeof p === "string")
    : [];
  return {
    enabled:
      typeof bag.enabled === "boolean"
        ? bag.enabled
        : SERVICE_WINDOW_DEFAULTS.enabled,
    windowHours: clampHours(bag.windowHours),
    templateName: str(bag.templateName),
    templateLanguage: str(bag.templateLanguage) ?? "pt_BR",
    templateCategory: str(bag.templateCategory) ?? "UTILITY",
    templateParams: params,
    templateContent: str(bag.templateContent),
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

// What a proactive sender may do right now. Free-form when: the channel has no 24h window (baileys/zapi
// and non-WhatsApp channels), the operator disabled the gate, or we are inside the window. Outside the
// window on an official WhatsApp channel → template if configured, else a private note.
export function proactiveSendMode(
  cfg: ServiceWindowConfig,
  lastInboundAt: Date | null,
  now: Date,
  channel: InboxChannel,
): ProactiveSendMode {
  if (!cfg.enabled || !channelHasServiceWindow(channel)) return "freeform";
  if (isWithinServiceWindow(lastInboundAt, now, cfg.windowHours)) {
    return "freeform";
  }
  return cfg.templateName ? "template" : "note";
}

export interface TemplatePayload {
  content: string;
  name: string;
  category: string;
  language: string;
  processedParams: { body: Record<string, string> };
}

// Builds the HSM payload (body-only) for client.sendTemplate, interpolating contact placeholders into
// the params + content. NOTE (open-validation): only BODY params are handled here; header/button
// params and the exact processed_params shape for a given WhatsApp provider should be confirmed
// against a live approved template before relying on richer templates.
export function buildTemplatePayload(
  cfg: ServiceWindowConfig,
  contactName: string | null,
): TemplatePayload | null {
  if (!cfg.templateName) return null;
  const vars = buildPromptVars({
    contactName,
    contactEmail: null,
    contactPhone: null,
    inboxName: null,
  });
  const params = cfg.templateParams.map((p) => interpolatePromptVars(p, vars));
  const body: Record<string, string> = {};
  params.forEach((p, i) => {
    body[String(i + 1)] = p;
  });
  const content = cfg.templateContent
    ? interpolatePromptVars(cfg.templateContent, vars)
    : params.join(" ") || cfg.templateName;
  return {
    content,
    name: cfg.templateName,
    category: cfg.templateCategory,
    language: cfg.templateLanguage,
    processedParams: { body },
  };
}
