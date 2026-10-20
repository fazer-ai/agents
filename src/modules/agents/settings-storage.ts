import { parseToolPrecondition } from "@/modules/agents/tool-preconditions";
import { parseContactAuthRule } from "@/modules/contact-auth/settings";
import { normalizeSettingsForStorage } from "@/modules/images/settings";

function plain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// The contact gate's rule with the values the reader reads written as it reads them (a phone as its
// digits, a label lowercased, entries trimmed and deduplicated). Stored as typed,
// `+55 (11) 98888-7777` and `5511988887777` are one person to the gate and two values to the row.
// Laid OVER the stored rule rather than replacing it: a key the reader does not know stays, so a
// newer field survives an older writer and the audit still sees it go. A rule the reader cannot
// parse is left as it is, since refusing it is the write boundary's call, and so is one whose read
// form the reader would not read back as itself (a label at the length cap that lowercasing
// lengthens): storing that would turn a rule the gate honours into one it drops.
export function withStoredContactAuthRule(settings: unknown): unknown {
  if (!plain(settings) || !plain(settings.contactAuth)) return settings;
  const raw = settings.contactAuth.rule;
  const read = parseContactAuthRule(raw);
  if (!read || !plain(raw)) return settings;
  if (JSON.stringify(parseContactAuthRule(read)) !== JSON.stringify(read)) {
    return settings;
  }
  let rule: Record<string, unknown> = { ...raw, ...read };
  if ("conditions" in read && Array.isArray(raw.conditions)) {
    const conditions = raw.conditions as unknown[];
    rule = {
      ...rule,
      conditions: read.conditions.map((c, i) => ({
        ...(plain(conditions[i]) ? conditions[i] : {}),
        ...c,
      })),
    };
  }
  return { ...settings, contactAuth: { ...settings.contactAuth, rule } };
}

// A tool's rule of one condition stored as that condition, the shape the console writes and the API
// reads back, so a list of one written by REST or MCP and the same rule saved by the console are one
// stored value. The condition itself is kept as written (a key the reader does not know stays); a list
// whose single entry does not parse is left for the write boundary to refuse.
export function withStoredToolPreconditions(settings: unknown): unknown {
  if (!plain(settings) || !plain(settings.toolPreconditions)) return settings;
  const bag = settings.toolPreconditions;
  let changed = false;
  const out = Object.create(null) as Record<string, unknown>;
  for (const [name, raw] of Object.entries(bag)) {
    const one =
      Array.isArray(raw) && raw.length === 1 && parseToolPrecondition(raw[0])
        ? raw[0]
        : raw;
    if (one !== raw) changed = true;
    Object.defineProperty(out, name, {
      value: one,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return changed ? { ...settings, toolPreconditions: out } : settings;
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
  return withStoredToolPreconditions(
    withStoredContactAuthRule(
      normalizeSettingsForStorage(settings) ?? settings,
    ),
  ) as Record<string, unknown>;
}
