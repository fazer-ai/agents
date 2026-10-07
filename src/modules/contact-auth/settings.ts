import { clipText } from "@/lib/text";
import { TEMPLATE_MESSAGE_MAX } from "@/modules/agents/text-caps";
import {
  parseToolPrecondition,
  type ToolPrecondition,
} from "@/modules/agents/tool-preconditions";

// Per-agent contact authorization gate, read from the free-form `agent.settings.contactAuth` bag
// (same pattern as availability / limits). Some agents may only serve contacts that a system outside
// the console knows about: the customers of a platform, the policyholders of an insurer, the patients
// of a clinic. Leaving that to the prompt is not a gate, so the runtime asks that system itself,
// before the turn, with the identity Chatwoot mirrored for the contact, and only a positive answer
// lets the model run (docs/contact-auth.md). Every incoming message is re-checked: the endpoint owns
// the verdict, so revoking there takes effect on the customer's next message. Off by default; every
// other field clamps rather than throws, so a malformed write can never break the webhook.

// How long a positive verdict counts for. `perMessage` asks the endpoint every time, so a revocation
// there lands on the contact's very next message. `once` stores the first `authorized: true` per
// contact and reuses it until it expires, for an expensive or rate-limited endpoint and for an UNLOCK
// gate where the customer sends a code once and should stay served.
export type ContactAuthMode = "perMessage" | "once";

// A verdict the runtime reaches from data it already holds, instead of asking an endpoint (a pilot
// list of numbers, a mirrored attribute), sparing the TLS, credential, timeout budget and availability
// dependency of a fail-closed endpoint. TYPED, as in tool-preconditions.ts: the gate is fail-closed,
// so every way a rule could fail to answer would refuse a customer, and a closed set of conditions
// always answers. The attribute condition IS the precondition's, parsed by the same function.
export type ContactAuthCondition =
  // The contact's mirrored phone (compared by digits, so `+55 (11) 9...` and `5511 9...` are one
  // number) or its operator identifier is on the list.
  | { kind: "allowlist"; phones: string[]; identifiers: string[] }
  | ToolPrecondition
  // The conversation is a WhatsApp group or a one-to-one chat (the fork's `group_type`).
  | { kind: "conversation_type"; type: ContactAuthConversationType }
  // The conversation carries this label, stored lowercased as Chatwoot stores label titles.
  | { kind: "label"; label: string };

// One level only: a combination holds plain conditions, never another combination, so every rule
// the API accepts is a rule the editor can show and save back unchanged.
export type ContactAuthRule =
  | ContactAuthCondition
  | { kind: "all"; conditions: ContactAuthCondition[] }
  | { kind: "any"; conditions: ContactAuthCondition[] };

export type ContactAuthConversationType = "group" | "individual";

export const CONTACT_AUTH_RULE_CONDITIONS_MAX = 10;
// Chatwoot keeps a label title in a varchar(255).
export const CONTACT_AUTH_LABEL_MAX = 255;

// A list the operator types into a text box, and every entry is compared on every message: bounded
// so a paste of a whole CRM cannot turn a settings bag into a table. Past a few hundred numbers the
// list lives in a system, and that system is what `url` is for.
export const CONTACT_AUTH_ALLOWLIST_MAX = 500;
export const CONTACT_AUTH_ALLOWLIST_ENTRY_MAX = 200;
// A phone of fewer digits than this is not a phone the mirror holds (E.164 numbers with country code
// are 8-15 digits), and a short entry is the one that would match by accident if the comparison were
// ever loosened. Refused at the write, dropped by the reader.
export const CONTACT_AUTH_PHONE_MIN_DIGITS = 8;
export const CONTACT_AUTH_PHONE_MAX_DIGITS = 15;
// The editor's text boxes, one entry per line: room for a full list of entries at their widest
// (a formatted phone runs to about 25 characters), and not a byte more.
export const CONTACT_AUTH_PHONES_TEXT_MAX = CONTACT_AUTH_ALLOWLIST_MAX * 26;
export const CONTACT_AUTH_IDENTIFIERS_TEXT_MAX =
  CONTACT_AUTH_ALLOWLIST_MAX * (CONTACT_AUTH_ALLOWLIST_ENTRY_MAX + 1);

export function phoneDigits(v: string): string {
  return v.replace(/\D+/g, "");
}

function normalizedPhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const digits = phoneDigits(v);
  return digits.length >= CONTACT_AUTH_PHONE_MIN_DIGITS &&
    digits.length <= CONTACT_AUTH_PHONE_MAX_DIGITS
    ? digits
    : null;
}

// A line break inside an identifier is refused: the editor holds the list one entry per line, so an
// identifier carrying one would come back from the editor as two, each authorizing somebody else.
function normalizedIdentifier(v: unknown): string | null {
  const s = str(v);
  return s && s.length <= CONTACT_AUTH_ALLOWLIST_ENTRY_MAX && !/[\r\n]/.test(s)
    ? s
    : null;
}

function entries(
  v: unknown,
  normalize: (x: unknown) => string | null,
): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out = new Set<string>();
  for (const x of v) {
    const n = normalize(x);
    if (n === null) return null;
    out.add(n);
  }
  return [...out];
}

// Strict, both at the write (invalidContactAuthRule) and here: a rule that "sort of" parses is worse
// than none, because the operator would read the gate as a list while the runtime reads it as open.
// A malformed rule reads as ABSENT, and an enabled gate with neither a rule nor a url is the
// fail-closed `not_configured` it always was, never an open door.
function parseCondition(raw: unknown): ContactAuthCondition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "allowlist") {
    const phones = entries(r.phones, normalizedPhone);
    const identifiers = entries(r.identifiers, normalizedIdentifier);
    if (!phones || !identifiers) return null;
    // An empty list is a gate that refuses everybody. That is expressible (turn the agent off, or
    // leave the rule out and let `not_configured` refuse), and as a rule it is almost always a save
    // made before the list was typed, so it is refused rather than honoured.
    if (phones.length + identifiers.length === 0) return null;
    return { kind: "allowlist", phones, identifiers };
  }
  if (r.kind === "conversation_type") {
    return r.type === "group" || r.type === "individual"
      ? { kind: "conversation_type", type: r.type }
      : null;
  }
  if (r.kind === "label") {
    const label = str(r.label);
    return label &&
      label.length <= CONTACT_AUTH_LABEL_MAX &&
      !/[\r\n]/.test(label)
      ? { kind: "label", label: label.toLowerCase() }
      : null;
  }
  return parseToolPrecondition(raw);
}

function listEntries(c: ContactAuthCondition): number {
  return c.kind === "allowlist" ? c.phones.length + c.identifiers.length : 0;
}

export function parseContactAuthRule(raw: unknown): ContactAuthRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  let rule: ContactAuthRule | null;
  if (r.kind === "all" || r.kind === "any") {
    const list = r.conditions;
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > CONTACT_AUTH_RULE_CONDITIONS_MAX
    ) {
      return null;
    }
    const conditions: ContactAuthCondition[] = [];
    for (const item of list) {
      const c = parseCondition(item);
      if (!c) return null;
      conditions.push(c);
    }
    rule =
      r.kind === "all"
        ? { kind: "all", conditions }
        : { kind: "any", conditions };
  } else {
    rule = parseCondition(raw);
  }
  if (!rule) return null;
  // The list cap is on the RULE: two lists of 500 inside a combination are the table the cap exists
  // to keep out of a settings bag.
  const listed =
    rule.kind === "all" || rule.kind === "any"
      ? rule.conditions.reduce((n, c) => n + listEntries(c), 0)
      : listEntries(rule);
  return listed > CONTACT_AUTH_ALLOWLIST_MAX ? null : rule;
}

// The write boundary's question: is there a rule that the reader would drop? Absent and null are not
// refusals (null clears the rule).
export function invalidContactAuthRule(raw: unknown): boolean {
  return (
    raw !== undefined && raw !== null && parseContactAuthRule(raw) === null
  );
}

export interface ContactAuthConfig {
  enabled: boolean;
  // The local rule, when the verdict comes from data we already hold. A rule is always evaluated per
  // message and never stores a grant: a stored verdict exists to spare somebody's endpoint, and a rule
  // reads our own rows. With a rule set the endpoint is asked only under `askEndpointAfterRule`.
  rule: ContactAuthRule | null;
  // The two-stage gate: the rule decides first, and what it allows is handed to the endpoint for the
  // final verdict. A flag and not "a rule and a url together": the url stays stored when an operator
  // switches to a rule, and the editor tells them it is not used, so reading the pair as two stages
  // would call an endpoint they turned away from. Strict, like `enabled`: anything but `true` keeps
  // the rule alone.
  askEndpointAfterRule: boolean;
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
  // sees a single account and has nothing to warn about. null ⇒ a legacy value with no recorded
  // instance (applied under the weaker check).
  handoffTeamInstanceId: number | null;
  // Whether a DENIAL writes the private note. Off is for a gate used as a scope filter, where a refusal
  // is the ordinary case and one note per excluded conversation is noise. Only the denial: an endpoint
  // that failed and a contact with nothing to ask about are things the operator has to fix, and the
  // note is where they learn it. Strict the other way from `enabled`: anything but `false` writes it,
  // so a malformed write can only bring a note back, never silence one.
  operatorNoteEnabled: boolean;
}

export const CONTACT_AUTH_DEFAULTS: ContactAuthConfig = {
  enabled: false,
  rule: null,
  askEndpointAfterRule: false,
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
  operatorNoteEnabled: true,
};

// Where the two stages sit. The rule stage runs first among the pre-turn gates, since it costs nothing
// and a conversation the agent does not serve should not get an away message or a redirect first.
// The endpoint stage stays last, since a conversation an earlier gate silenced costs no call. The
// endpoint stage exists when there is no rule (that is where an enabled gate with neither is the
// fail-closed `not_configured`) and when the operator asked for it after the rule.
export function contactAuthHasRuleStage(cfg: ContactAuthConfig): boolean {
  return cfg.rule !== null;
}
export function contactAuthHasEndpointStage(cfg: ContactAuthConfig): boolean {
  return cfg.rule === null || cfg.askEndpointAfterRule;
}

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
    rule: parseContactAuthRule(b.rule),
    askEndpointAfterRule: b.askEndpointAfterRule === true,
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
    operatorNoteEnabled: b.operatorNoteEnabled !== false,
  };
}
