import { parseContactAuthRule } from "@/modules/contact-auth/settings";
import { normalizeSettingsForStorage } from "@/modules/images/settings";

// The contact gate's rule as the reader reads it (a phone as its digits, a label lowercased, entries
// trimmed and deduplicated). Stored as typed, `+55 (11) 98888-7777` and `5511988887777` are one
// person to the gate and two values to the row. A rule the reader cannot parse is left as it is:
// refusing it is the write boundary's call.
export function withStoredContactAuthRule(settings: unknown): unknown {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return settings;
  }
  const bag = settings as Record<string, unknown>;
  const block = bag.contactAuth;
  if (!block || typeof block !== "object" || Array.isArray(block)) return bag;
  const rule = parseContactAuthRule((block as Record<string, unknown>).rule);
  return rule ? { ...bag, contactAuth: { ...block, rule } } : bag;
}

// What a write of `agent.settings` stores, on every path that writes one (update, create, import):
// `sendImage` keeps hosts only, so a pasted signed URL never reaches the row, and the contact gate's
// rule is stored as the reader reads it.
export function settingsForStorage(
  settings: unknown,
): Record<string, unknown> | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return undefined;
  }
  return withStoredContactAuthRule(
    normalizeSettingsForStorage(settings) ?? settings,
  ) as Record<string, unknown>;
}
