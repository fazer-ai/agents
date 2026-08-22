import { clipText, TEMPLATE_MESSAGE_MAX } from "@/modules/agents/text-caps";

// Per-agent contact authorization gate, read from the free-form `agent.settings.contactAuth` bag
// (same pattern as availability / limits). Some agents may only serve contacts that a system outside
// the console knows about: the customers of a platform, the policyholders of an insurer, the patients
// of a clinic. Leaving that to the prompt is not a gate, so the runtime asks that system itself,
// before the turn, with the identity Chatwoot mirrored for the contact, and only a positive answer
// lets the model run (docs/contact-auth.md). Every incoming message is re-checked: the endpoint owns
// the verdict, so revoking there takes effect on the customer's next message. Off by default; every
// other field clamps rather than throws, so a malformed write can never break the webhook.

export type ContactAuthMethod = "GET" | "POST";
// A lista existe para o schema do MCP não repetir os dois valores por conta própria: o par
// "reader aceita" / "schema declara" já divergiu em outros blocos, e aqui há uma fonte só.
export const CONTACT_AUTH_METHODS: ContactAuthMethod[] = ["GET", "POST"];

export interface ContactAuthConfig {
  enabled: boolean;
  // The authorization endpoint: a fixed origin, no placeholders (the identity travels as query or
  // body). https in production; http only where the SSRF guard allows private targets, the same rule
  // HTTP tools follow. null = not configured, which an enabled gate treats as an error (fail-closed).
  url: string | null;
  method: ContactAuthMethod;
  // `vault:<id>` of the credential sent with the request, injected per the entry's kind (bearer /
  // header / query). null = the endpoint needs none.
  credentialRef: string | null;
  timeoutMs: number;
  // Cooldown on the NOTICES for a refused message (the customer copy and the operator note), never
  // on the verdict: the endpoint is asked on every message regardless. Without it, a burst of five
  // messages from a refused contact with handoff off would be answered with the same copy five
  // times. 0 = notify on every refused message.
  noticeCooldownSeconds: number;
  // POST only: forward the triggering message's text as `message.text`, so an endpoint can accept
  // something the customer sends to unlock themselves (an access code, a protocol number). Read as
  // false under GET, where the text would land on the query string and in access logs.
  includeMessageText: boolean;
  // What the customer receives when the endpoint denies them. null = say nothing.
  denyMessage: string | null;
  // Whether a refused conversation is opened for humans (the handoff_to_human mechanics), and the
  // Chatwoot team it is assigned to after the open (null = Chatwoot's inbox routing). Flat, not a
  // nested object, because mergeBehaviorSettings merges a block one level deep: a patch that set
  // only the team would otherwise silently reset the switch (the tts block has the same note).
  handoffEnabled: boolean;
  handoffTeamId: number | null;
}

export const CONTACT_AUTH_DEFAULTS: ContactAuthConfig = {
  enabled: false,
  url: null,
  method: "GET",
  credentialRef: null,
  timeoutMs: 5000,
  noticeCooldownSeconds: 60,
  includeMessageText: false,
  denyMessage: null,
  handoffEnabled: true,
  handoffTeamId: null,
};

// Whether the triggering message's text actually travels: the operator's opt-in AND a POST, since
// GET would put customer text on a query string and into the endpoint's access logs. Stored and
// effective are deliberately separate — a method switch must not erase a setting it never named.
export function sendsMessageText(cfg: ContactAuthConfig): boolean {
  return cfg.method === "POST" && cfg.includeMessageText;
}

export const CONTACT_AUTH_TIMEOUT_MIN_MS = 1000;
export const CONTACT_AUTH_TIMEOUT_MAX_MS = 10_000;
export const CONTACT_AUTH_NOTICE_COOLDOWN_MAX_SECONDS = 3600;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.round(v)))
    : def;
}

function posInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

// The endpoint as stored, or null when it cannot be one: unparseable, a scheme other than http(s),
// or credentials written into the URL itself (`https://user:pass@host`). Those belong in the vault,
// where they are encrypted and never leave with an agent export; a URL that carries them is refused
// whole rather than stripped, so the operator sees the field empty instead of a silently changed one.
export function readContactAuthUrl(v: unknown): string | null {
  const raw = str(v);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return raw;
}

export function readContactAuthConfig(settings: unknown): ContactAuthConfig {
  const bag =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).contactAuth
      : undefined;
  if (!bag || typeof bag !== "object") return { ...CONTACT_AUTH_DEFAULTS };
  const b = bag as Record<string, unknown>;
  const deny =
    typeof b.denyMessage === "string"
      ? clipText(b.denyMessage.trim(), TEMPLATE_MESSAGE_MAX)
      : "";
  const method: ContactAuthMethod =
    str(b.method)?.toUpperCase() === "POST" ? "POST" : "GET";
  return {
    // Strict boolean, like the availability switch: a malformed write can only ever leave the gate
    // off, never start refusing customers nobody asked it to.
    enabled: b.enabled === true,
    url: readContactAuthUrl(b.url),
    method,
    credentialRef: str(b.credentialRef),
    timeoutMs: clampInt(
      b.timeoutMs,
      CONTACT_AUTH_DEFAULTS.timeoutMs,
      CONTACT_AUTH_TIMEOUT_MIN_MS,
      CONTACT_AUTH_TIMEOUT_MAX_MS,
    ),
    noticeCooldownSeconds: clampInt(
      b.noticeCooldownSeconds,
      CONTACT_AUTH_DEFAULTS.noticeCooldownSeconds,
      0,
      CONTACT_AUTH_NOTICE_COOLDOWN_MAX_SECONDS,
    ),
    // NOTE: The RAW opt-in, not the effective one. Forcing it to false here made the claim above it
    // untrue: `mergeBehaviorSettings` persists what this reader returns, so a patch that changed
    // only the method to GET wrote the flag off for good and switching back to POST could not bring
    // it back — the operator's setting was erased by an edit that never mentioned it. Whether the
    // text actually travels is `sendsMessageText`, decided when the request is built.
    includeMessageText: b.includeMessageText === true,
    denyMessage: deny || null,
    handoffEnabled:
      typeof b.handoffEnabled === "boolean"
        ? b.handoffEnabled
        : CONTACT_AUTH_DEFAULTS.handoffEnabled,
    handoffTeamId: posInt(b.handoffTeamId),
  };
}
