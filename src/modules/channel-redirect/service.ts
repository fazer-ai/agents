// WhatsApp → website-chat redirect (per-agent). Receive a lead on the OFFICIAL WhatsApp inbox, answer
// with a fixed (no-AI) message linking to the Chatwoot web widget, and let the AI serve the conversation
// there (no per-message WhatsApp cost). The widget conversation is merged onto the same contact via the
// widget's identity validation (identifier + identifier_hash). A cross-channel follow-up then chases the
// lead in the chat, escalates to WhatsApp if still idle, and finally posts a closing message on BOTH
// channels (chat + WhatsApp) as the last timed stage (or when the widget conversation is resolved). This
// reader is the single source of defaults + clamping for the `agent.settings.channelRedirect` block; the
// runtime, the gate, the follow-up handler, REST/UI and MCP all project this shape.

// A delay expressed as value + unit, mirroring the followup module so the editor reuses the same picker.
export type RedirectDelayUnit = "minutes" | "hours" | "days";

export interface ChannelRedirectConfig {
  enabled: boolean;
  // The OFFICIAL WhatsApp Cloud API inbox that leads arrive on (chatwootInboxId). The gate only fires
  // for this inbox; null → the feature is inert (nothing to redirect from).
  entryInboxId: number | null;
  // The Channel::WebWidget inbox the lead is redirected to (chatwootInboxId). null → not provisioned yet.
  widgetInboxId: number | null;
  // The no-AI auto-reply sent on WhatsApp. Must contain the `{link}` placeholder (the per-lead widget URL).
  redirectMessage: string;
  // Re-send the link at most once per this interval if the lead keeps messaging WhatsApp without clicking.
  resendDelayValue: number;
  resendDelayUnit: RedirectDelayUnit;
  // How many times the link may be re-sent (beyond the first) before we go silent on WhatsApp.
  maxResends: number;
  // Open the widget automatically when the lead lands on the page (cw_open=1).
  openWidget: boolean;
  // Clone the lead's original WhatsApp message into the widget and auto-send it as the first message, so
  // the AI answers what was asked on WhatsApp (which the redirect message pre-empted).
  cloneWaMessage: boolean;
  // Step 1 — follow up IN THE CHAT when the lead goes idle in the widget.
  chatFollowupEnabled: boolean;
  chatFollowupDelayValue: number;
  chatFollowupDelayUnit: RedirectDelayUnit;
  chatFollowupInstructions: string;
  // Step 2 — re-send the LINK on WhatsApp (the sibling conversation) if still idle after the chat
  // follow-up: a fixed message (NOT AI — the lead may have left the chat, so this pulls them back), like
  // the first redirect message. Must contain `{link}` (the per-lead widget URL is interpolated in).
  waFollowupEnabled: boolean;
  waFollowupDelayValue: number;
  waFollowupDelayUnit: RedirectDelayUnit;
  waFollowupMessage: string;
  // Step 3 — post a FIXED closing message on BOTH channels (website chat + WhatsApp) as the final timed
  // stage, `closingDelay` after the WhatsApp escalation, if the lead is still idle. Also fires (once) when
  // the widget conversation is resolved by anyone. Fixed (not AI): the WhatsApp closing nudge silences, so
  // a fixed goodbye is the only way to guarantee it lands on both. Closing message + resolve is at most
  // once per episode.
  closingEnabled: boolean;
  closingDelayValue: number;
  closingDelayUnit: RedirectDelayUnit;
  closingMessage: string;
}

export const CHANNEL_REDIRECT_DEFAULTS: ChannelRedirectConfig = {
  // Opt-in: this reshapes the whole inbound flow, so it stays off until explicitly enabled.
  enabled: false,
  entryInboxId: null,
  widgetInboxId: null,
  redirectMessage:
    "Olá! Para te atender melhor, vamos continuar a conversa pelo nosso chat. É só acessar o link: {link}",
  resendDelayValue: 60,
  resendDelayUnit: "minutes",
  maxResends: 3,
  openWidget: true,
  cloneWaMessage: true,
  // The follow-up chain is on by default (short cadence): chase in the chat, then on WhatsApp, then close.
  chatFollowupEnabled: true,
  chatFollowupDelayValue: 15,
  chatFollowupDelayUnit: "minutes",
  chatFollowupInstructions: "",
  waFollowupEnabled: true,
  waFollowupDelayValue: 45,
  waFollowupDelayUnit: "minutes",
  waFollowupMessage:
    "Vi que você começou um atendimento pelo nosso chat e não finalizou. É só acessar o link para retomar de onde parou: {link}",
  closingEnabled: true,
  closingDelayValue: 60,
  closingDelayUnit: "minutes",
  closingMessage:
    "Obrigado pelo contato! Estou encerrando o atendimento por aqui, mas é só chamar novamente quando precisar.",
};

// How long a minted redirect token (the per-lead link) stays clickable. DECOUPLED from resendDelay (the
// re-send cooldown): a lead often clicks the WhatsApp link hours after receiving it, so the link's life
// must not shrink with a short cooldown. Single-use + opaque + no-PII, so a generous 24h window is safe.
// (The fork's Widget::RedirectToken already defaults to 24h; we set it explicitly so the agents side owns it.)
export const REDIRECT_LINK_TTL_SECONDS = 24 * 60 * 60;

// value + unit → minutes, clamped to [1, 43200] (30 days). Shared by the gate (resend interval) and the
// follow-up handler (chat/WhatsApp stage delays), mirroring the followup module's stepDelayMinutes.
export function redirectDelayMinutes(
  value: number,
  unit: RedirectDelayUnit,
): number {
  const minutes =
    unit === "days" ? value * 1440 : unit === "hours" ? value * 60 : value;
  return Math.min(Math.max(Math.round(minutes), 1), 43200);
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.round(v), min), max);
}

// Exported for the MCP argument schema (see modules/agents/settings-schema); the Set below is
// derived from it so the two can never disagree.
export const REDIRECT_DELAY_UNITS = [
  "minutes",
  "hours",
  "days",
] as const satisfies readonly RedirectDelayUnit[];

const VALID_DELAY_UNITS = new Set<string>(REDIRECT_DELAY_UNITS);

function delayUnit(v: unknown, fallback: RedirectDelayUnit): RedirectDelayUnit {
  return VALID_DELAY_UNITS.has(v as string)
    ? (v as RedirectDelayUnit)
    : fallback;
}

// A chatwootInboxId reference: a positive integer, or null when absent/invalid.
function inboxRef(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

export function readChannelRedirectConfig(
  settings: unknown,
): ChannelRedirectConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).channelRedirect
      : undefined;
  if (!s || typeof s !== "object") return { ...CHANNEL_REDIRECT_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const D = CHANNEL_REDIRECT_DEFAULTS;
  return {
    enabled: bool(bag.enabled, D.enabled),
    entryInboxId: inboxRef(bag.entryInboxId),
    widgetInboxId: inboxRef(bag.widgetInboxId),
    redirectMessage: str(bag.redirectMessage, D.redirectMessage),
    resendDelayValue: clampInt(
      bag.resendDelayValue,
      1,
      100_000,
      D.resendDelayValue,
    ),
    resendDelayUnit: delayUnit(bag.resendDelayUnit, D.resendDelayUnit),
    maxResends: clampInt(bag.maxResends, 0, 10, D.maxResends),
    openWidget: bool(bag.openWidget, D.openWidget),
    cloneWaMessage: bool(bag.cloneWaMessage, D.cloneWaMessage),
    chatFollowupEnabled: bool(bag.chatFollowupEnabled, D.chatFollowupEnabled),
    chatFollowupDelayValue: clampInt(
      bag.chatFollowupDelayValue,
      1,
      100_000,
      D.chatFollowupDelayValue,
    ),
    chatFollowupDelayUnit: delayUnit(
      bag.chatFollowupDelayUnit,
      D.chatFollowupDelayUnit,
    ),
    chatFollowupInstructions: str(
      bag.chatFollowupInstructions,
      D.chatFollowupInstructions,
    ),
    waFollowupEnabled: bool(bag.waFollowupEnabled, D.waFollowupEnabled),
    waFollowupDelayValue: clampInt(
      bag.waFollowupDelayValue,
      1,
      100_000,
      D.waFollowupDelayValue,
    ),
    waFollowupDelayUnit: delayUnit(
      bag.waFollowupDelayUnit,
      D.waFollowupDelayUnit,
    ),
    waFollowupMessage: str(bag.waFollowupMessage, D.waFollowupMessage),
    closingEnabled: bool(bag.closingEnabled, D.closingEnabled),
    closingDelayValue: clampInt(
      bag.closingDelayValue,
      1,
      100_000,
      D.closingDelayValue,
    ),
    closingDelayUnit: delayUnit(bag.closingDelayUnit, D.closingDelayUnit),
    closingMessage: str(bag.closingMessage, D.closingMessage),
  };
}

// Whether the redirect gate should fire for a given inbox: the feature is on, an entry inbox is set, and
// this is that inbox. Pure helper so the webhook gate and tests share one definition.
export function isRedirectEntryInbox(
  cfg: ChannelRedirectConfig,
  chatwootInboxId: number,
): boolean {
  return (
    cfg.enabled &&
    cfg.entryInboxId !== null &&
    cfg.entryInboxId === chatwootInboxId
  );
}

// One-shot + resend-cooldown decision: should the redirect link be (re-)sent right now? First contact
// (never sent) → yes. Otherwise re-send only once the interval has elapsed AND the resend budget is not
// spent. Pure so the gate and tests share one definition.
export function shouldSendRedirect(
  cfg: ChannelRedirectConfig,
  redirectSentAt: Date | null,
  redirectCount: number,
  now: Date,
): boolean {
  if (redirectSentAt === null) return true;
  if (redirectCount > cfg.maxResends) return false;
  return (
    now.getTime() - redirectSentAt.getTime() >=
    redirectDelayMinutes(cfg.resendDelayValue, cfg.resendDelayUnit) * 60_000
  );
}
