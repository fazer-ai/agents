import { clipText, TEMPLATE_MESSAGE_MAX } from "@/modules/agents/text-caps";

// Per-agent contact authorization gate, read from the free-form `agent.settings.contactAuth` bag
// (same pattern as availability / limits). Some agents may only serve contacts that a system outside
// the console knows about: the customers of a platform, the policyholders of an insurer, the patients
// of a clinic. Leaving that to the prompt is not a gate, so the runtime asks that system itself,
// before the turn, with the contact's phone from Chatwoot, and only a positive answer lets the model
// run (docs/contact-auth.md). Off by default; every other field clamps rather than throws, so a
// malformed write can never break the webhook.

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
  // How long a verdict (allowed AND denied) is reused for the same contact before asking again.
  // 0 = ask on every message.
  cacheTtlSeconds: number;
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
  cacheTtlSeconds: 300,
  denyMessage: null,
  handoffEnabled: true,
  handoffTeamId: null,
};

export const CONTACT_AUTH_TIMEOUT_MIN_MS = 1000;
export const CONTACT_AUTH_TIMEOUT_MAX_MS = 10_000;
export const CONTACT_AUTH_CACHE_TTL_MAX_SECONDS = 86_400;

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
  return {
    // Strict boolean, like the availability switch: a malformed write can only ever leave the gate
    // off, never start refusing customers nobody asked it to.
    enabled: b.enabled === true,
    url: readContactAuthUrl(b.url),
    method: str(b.method)?.toUpperCase() === "POST" ? "POST" : "GET",
    credentialRef: str(b.credentialRef),
    timeoutMs: clampInt(
      b.timeoutMs,
      CONTACT_AUTH_DEFAULTS.timeoutMs,
      CONTACT_AUTH_TIMEOUT_MIN_MS,
      CONTACT_AUTH_TIMEOUT_MAX_MS,
    ),
    cacheTtlSeconds: clampInt(
      b.cacheTtlSeconds,
      CONTACT_AUTH_DEFAULTS.cacheTtlSeconds,
      0,
      CONTACT_AUTH_CACHE_TTL_MAX_SECONDS,
    ),
    denyMessage: deny || null,
    handoffEnabled:
      typeof b.handoffEnabled === "boolean"
        ? b.handoffEnabled
        : CONTACT_AUTH_DEFAULTS.handoffEnabled,
    handoffTeamId: posInt(b.handoffTeamId),
  };
}
