import { intRange } from "@/lib/number-range";
// Per-agent config for the contact's conversations in other inboxes, read from
// `agent.settings.otherInboxes`. Off by default, and an inbox is read only when the operator picked
// it: an account can hold inboxes this agent must not see (another brand, an internal team), so
// "every inbox of the contact" is never a default.

export interface OtherInboxRef {
  // Our ChatwootInstance id. An inbox id only means something inside one Chatwoot account.
  instanceId: number;
  // The Chatwoot inbox id (chatwootInboxId).
  inboxId: number;
}

export interface OtherInboxesConfig {
  enabled: boolean;
  inboxes: OtherInboxRef[];
  maxConversations: number;
  lookbackDays: number;
  // A conversation whose rendered transcript fits this many characters goes in whole; a longer one
  // goes as a summary.
  fullTranscriptMaxChars: number;
}

export const OTHER_INBOXES_LIMITS = {
  maxConversations: intRange(1, 10),
  lookbackDays: intRange(1, 365),
  fullTranscriptMaxChars: intRange(500, 8000),
} as const;

export const OTHER_INBOXES_MAX_INBOXES = 50;

export const OTHER_INBOXES_DEFAULTS: OtherInboxesConfig = {
  enabled: false,
  inboxes: [],
  maxConversations: 5,
  lookbackDays: 90,
  fullTranscriptMaxChars: 2000,
};

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function clampInt(
  v: unknown,
  bounds: { min: number; max: number },
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(v)));
}

function readInboxes(v: unknown): OtherInboxRef[] {
  if (!Array.isArray(v)) return [];
  const out: OtherInboxRef[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const instanceId = positiveInt(o.instanceId);
    const inboxId = positiveInt(o.inboxId);
    if (instanceId === null || inboxId === null) continue;
    const key = `${instanceId}:${inboxId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ instanceId, inboxId });
    if (out.length >= OTHER_INBOXES_MAX_INBOXES) break;
  }
  return out;
}

export function readOtherInboxesConfig(settings: unknown): OtherInboxesConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).otherInboxes
      : undefined;
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return { ...OTHER_INBOXES_DEFAULTS, inboxes: [] };
  }
  const o = s as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    inboxes: readInboxes(o.inboxes),
    maxConversations: clampInt(
      o.maxConversations,
      OTHER_INBOXES_LIMITS.maxConversations,
      OTHER_INBOXES_DEFAULTS.maxConversations,
    ),
    lookbackDays: clampInt(
      o.lookbackDays,
      OTHER_INBOXES_LIMITS.lookbackDays,
      OTHER_INBOXES_DEFAULTS.lookbackDays,
    ),
    fullTranscriptMaxChars: clampInt(
      o.fullTranscriptMaxChars,
      OTHER_INBOXES_LIMITS.fullTranscriptMaxChars,
      OTHER_INBOXES_DEFAULTS.fullTranscriptMaxChars,
    ),
  };
}

// The inboxes this config lets a conversation of `instanceId` read, by Chatwoot inbox id.
export function selectedInboxIds(
  cfg: OtherInboxesConfig,
  instanceId: number,
): Set<number> {
  return new Set(
    cfg.inboxes
      .filter((i) => i.instanceId === instanceId)
      .map((i) => i.inboxId),
  );
}

// The OTHER_INBOX_SUMMARY job of one conversation: the turn arms it, `/reset` retires it.
export function summaryDedupeKey(
  instanceId: bigint,
  conversationId: number,
): string {
  return `${instanceId}:${conversationId}`;
}
