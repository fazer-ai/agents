import { clipText } from "@/lib/text";
import { TEMPLATE_MESSAGE_MAX } from "@/modules/agents/text-caps";

// Per-agent contact authorization gate, read from the free-form `agent.settings.contactAuth` bag
// (same pattern as availability / limits). Some agents may only serve contacts that a system outside
// the console knows about: the customers of a platform, the policyholders of an insurer, the patients
// of a clinic. Leaving that to the prompt is not a gate, so the runtime asks that system itself,
// before the turn, with the identity Chatwoot mirrored for the contact, and only a positive answer
// lets the model run (docs/contact-auth.md). Every incoming message is re-checked: the endpoint owns
// the verdict, so revoking there takes effect on the customer's next message. Off by default; every
// other field clamps rather than throws, so a malformed write can never break the webhook.

// How long a positive verdict counts for (issue #189). `perMessage` is the gate as it shipped: the
// endpoint owns the answer, and asking it every time is what lets a revocation there land on the
// contact's very next message. `once` trades that immediacy for the call: the first `authorized:
// true` is stored per contact and reused until it expires. Two operators asked for it — an endpoint
// that is expensive or rate-limited (a burst of five WhatsApp messages is five identical lookups),
// and a gate that is an UNLOCK, where the customer sends a code once and should stay served
// afterwards without the endpoint having to remember them.
export type ContactAuthMode = "perMessage" | "once";

export interface ContactAuthConfig {
  enabled: boolean;
  // The authorization endpoint: a fixed origin, no placeholders (the identity travels in the body).
  // https in production; http only where the SSRF guard allows private targets, the same rule HTTP
  // tools follow. null = not configured, which an enabled gate treats as an error (fail-closed).
  url: string | null;
  // `vault:<id>` of the credential sent with the request, injected per the entry's kind (bearer /
  // header / query). null = the endpoint needs none.
  credentialRef: string | null;
  timeoutMs: number;
  // Cooldown on the NOTICES for a refused message (the customer copy and the operator note), never
  // on the verdict: the endpoint is asked on every message regardless. Without it, a burst of five
  // messages from a refused contact with handoff off would be answered with the same copy five
  // times. 0 = notify on every refused message.
  noticeCooldownSeconds: number;
  // Forward the triggering message's text as `message.text`, so an endpoint can accept something the
  // customer sends to unlock themselves (an access code, a protocol number). It travels under its
  // own key, never inside `contact`: what the customer typed and what Chatwoot mirrored are not the
  // same kind of claim, and the endpoint has to be able to tell them apart.
  includeMessageText: boolean;
  // What the customer receives when the endpoint denies them. null = say nothing.
  denyMessage: string | null;
  // Whether a refused conversation is opened for humans (the handoff_to_human mechanics), and the
  // Chatwoot team it is assigned to after the open (null = Chatwoot's inbox routing). Flat, not a
  // nested object, because mergeBehaviorSettings merges a block one level deep: a patch that set
  // only the team would otherwise silently reset the switch (the tts block has the same note).
  handoffEnabled: boolean;
  // Reuse policy. Strict, like `enabled`: anything that is not exactly "once" reads as perMessage,
  // so a malformed write can only ever make the gate ask MORE often, never less.
  mode: ContactAuthMode;
  // How long a stored grant counts for, under `once`. Clamped 60s-30d. It is part of the POLICY a
  // grant is written under (see grants.ts): changing it invalidates every stored grant, which is
  // also the operator's lever for dropping them without a new endpoint to call.
  grantTtlSeconds: number;
  handoffTeamId: number | null;
  // Our ChatwootInstance DB id the team above was picked from. A Chatwoot team id belongs to ONE
  // account, so the pinned number is only meaningful in the account it came from; the runtime
  // assigns the team ONLY when the conversation's instance matches. The editor already refuses to
  // pin while the agent spans several accounts, and this covers the drift it cannot see: an agent
  // MOVED to another account keeps the number it was given in the old one, and there the editor
  // sees a single account and has nothing to warn about. null ⇒ legacy value stored before this
  // field existed (applied under the older, weaker check).
  handoffTeamInstanceId: number | null;
}

export const CONTACT_AUTH_DEFAULTS: ContactAuthConfig = {
  enabled: false,
  url: null,
  credentialRef: null,
  timeoutMs: 5000,
  noticeCooldownSeconds: 60,
  includeMessageText: false,
  denyMessage: null,
  handoffEnabled: true,
  mode: "perMessage",
  grantTtlSeconds: 86_400,
  handoffTeamId: null,
  handoffTeamInstanceId: null,
};

export const CONTACT_AUTH_TIMEOUT_MIN_MS = 1000;
export const CONTACT_AUTH_TIMEOUT_MAX_MS = 10_000;
export const CONTACT_AUTH_NOTICE_COOLDOWN_MAX_SECONDS = 3600;
// A grant shorter than a minute is a grant that expires inside the burst it exists to collapse, and
// one longer than a month outlives most of the facts an endpoint decides on. "Never reuse" is the
// MODE, not a TTL of zero: two ways to say the same thing, and the second one says it in the more
// confusing place.
export const CONTACT_AUTH_GRANT_TTL_MIN_SECONDS = 60;
export const CONTACT_AUTH_GRANT_TTL_MAX_SECONDS = 30 * 24 * 3600;

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
    includeMessageText: b.includeMessageText === true,
    denyMessage: deny || null,
    handoffEnabled:
      typeof b.handoffEnabled === "boolean"
        ? b.handoffEnabled
        : CONTACT_AUTH_DEFAULTS.handoffEnabled,
    mode: b.mode === "once" ? "once" : "perMessage",
    grantTtlSeconds: clampInt(
      b.grantTtlSeconds,
      CONTACT_AUTH_DEFAULTS.grantTtlSeconds,
      CONTACT_AUTH_GRANT_TTL_MIN_SECONDS,
      CONTACT_AUTH_GRANT_TTL_MAX_SECONDS,
    ),
    handoffTeamId: posInt(b.handoffTeamId),
    handoffTeamInstanceId: posInt(b.handoffTeamInstanceId),
  };
}
