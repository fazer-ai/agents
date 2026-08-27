import { modelConfigSchema } from "@/graph/model-config";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";

// Which of the three agent actions a write to `updateAgent` is, and what its row carries.
//
// `agent_update`, `prompt_set` and `agent_settings_set` are three MCP tools over ONE service
// function, and the REST route reaches that function with all three at once: the editor's General
// tab PATCHes `name`, `systemPrompt`, `enabled`, `mode` and `modelConfig` on every save whether or
// not they changed, and its Behavior tab sends the settings bag whole (`buildSettings()` spreads
// it). So the field a caller NAMED says nothing about what the operator did — only the comparison
// does, and the action is read off the diff for that reason. Reading it off the patch would file
// every console prompt edit as `agent.update` while the identical edit over MCP files as
// `agent.prompt_set`, which is precisely the divergence `docs/mcp.md` says this seam removes ("the
// same change leaves the same row whichever of the three transports made it").
//
// ── the one question this module answers ──
//
// Everything below is one question asked of each field: what counts as the SAME configuration? It
// is asked once, in `CANONICAL`, and the comparison and the projection both read the answer. The
// alternative is a special case per field, which is what this file was: four rounds of review each
// added an `if` for a value that compared unequal while nothing about the agent had changed.
//
// A canonical form has to be justified by what the RUNTIME reads, never by taste. Each names its
// measurement:
//
// - `settings` is the bag as `readBehaviorSettings` resolves it, because that view is what every
//   consumer takes. Two things then fall out rather than being handled: a value the readers CLAMP to
//   the same result is the same configuration (`debounce.windowSeconds` of 1 and of 2 both read as
//   3), and a `Date` the readers produce is compared and stored as its ISO string, which is what the
//   column can hold at all (`truncForAudit` walks objects by enumerable entries, of which a Date has
//   none, so it would land as `{}`).
// - `modelConfig` is the keys `modelConfigSchema` names. `validateModelConfigForWrite` asks the
//   schema whether the value is valid and throws away the STRIPPED result, so a config valid apart
//   from a stray key is stored with it — measured: a `PATCH` carrying `apiKey: "sk-…"` reaches the
//   column, and the row is retained and readable by every tenant admin. `exportAgent` already scans
//   for exactly this shape and refuses to emit. Derived from the schema rather than typed out, and a
//   PICK rather than a parse, because a legacy config that no longer validates still projects.
// - a grant's `enabledTools` and `knowledgeBaseIds` are SETS (see `grantSetChanged`).
// - everything else is itself: they are scalars.
//
// What canonicalizing deliberately does NOT do is hide a write. A block the readers do not know is
// absent from the resolved view, so it would compare equal while stored configuration moved — an
// import can preserve a forward-compatible block, and an upgrade that adds its reader makes it live.
// Those are tracked separately, by NAME: the row says which unread blocks moved without copying
// content nothing in this codebase can vouch for into a tenant-admin-readable row.

// Every column of the agent an operator can write. `id`, `createdAt` and `updatedAt` are not on it:
// the row already carries the target and the timestamp in its own columns.
export const AUDITED_AGENT_FIELDS = [
  "name",
  "systemPrompt",
  "enabled",
  "mode",
  "transferWithSummary",
  "modelConfig",
  "settings",
  "businessHoursId",
  "followUpHoursId",
] as const;

export type AuditedAgentField = (typeof AUDITED_AGENT_FIELDS)[number];

export type AgentUpdateAction =
  | "agent.update"
  | "agent.prompt_set"
  | "agent.settings_set";

export interface AgentUpdateAudit {
  action: AgentUpdateAction;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

const MODEL_CONFIG_KEYS = Object.keys(modelConfigSchema.shape);

// The JSON form of a value: what the column can hold, and what the comparison below already uses.
function jsonish<T>(v: unknown): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const CANONICAL: Partial<Record<AuditedAgentField, (v: unknown) => unknown>> = {
  settings: (v) => jsonish(readBehaviorSettings(v)),
  modelConfig: (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of MODEL_CONFIG_KEYS) if (k in src) out[k] = src[k];
    return out;
  },
};

function canonical(field: AuditedAgentField, v: unknown): unknown {
  const fn = CANONICAL[field];
  return fn ? fn(v) : v;
}

// The blocks whose RESOLVED value differs, and separately the names of the blocks that moved in
// storage without any reader seeing them.
function settingsDiff(
  before: unknown,
  after: unknown,
): {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  unreadBlocks: string[];
} {
  const b = canonical("settings", before) as Record<string, unknown>;
  const a = canonical("settings", after) as Record<string, unknown>;
  const outBefore: Record<string, unknown> = {};
  const outAfter: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (!same(b[key], a[key])) {
      outBefore[key] = b[key];
      outAfter[key] = a[key];
    }
  }
  const rawB = jsonish<Record<string, unknown> | null>(before) ?? {};
  const rawA = jsonish<Record<string, unknown> | null>(after) ?? {};
  const unreadBlocks = [
    ...new Set([...Object.keys(rawB), ...Object.keys(rawA)]),
  ]
    .filter((k) => !(k in a) && !same(rawB[k], rawA[k]))
    .sort();
  return { before: outBefore, after: outAfter, unreadBlocks };
}

// Whether a replace-the-set write actually changed the set.
//
// Compared as a SET and not as a list, twice over. The grants' order is not the operator's:
// `replaceAgentToolSelections` is a `deleteMany` + `createMany`, so every save reassigns the ids the
// read then orders by. And inside a grant, `enabledTools` and `knowledgeBaseIds` are allowlists the
// runtime reads by MEMBERSHIP — measured: `filterAllowed` builds a `Set`, `prepare.ts` asks
// `.includes`/`.some`, the playground builds a `Set`, and no consumer reads the order — so the same
// allowlist resubmitted shuffled is the same grant. Sorting by each entry's own serialization is a
// total order by construction: no entry ties with another unless they are equal.
export function grantSetChanged(before: unknown[], after: unknown[]): boolean {
  const SET_VALUED = ["enabledTools", "knowledgeBaseIds"];
  const canon = (g: unknown) => {
    if (g === null || typeof g !== "object") return JSON.stringify(g);
    const out: Record<string, unknown> = { ...(g as Record<string, unknown>) };
    for (const k of SET_VALUED) {
      const v = out[k];
      if (Array.isArray(v)) out[k] = [...v].map(String).sort();
    }
    return JSON.stringify(out);
  };
  const key = (xs: unknown[]) => JSON.stringify(xs.map(canon).sort());
  return key(before) !== key(after);
}

// Returns null when nothing changed: the trail records changes, and the console PATCHes a whole tab
// on every save, so writing a row per apply would fill the trail with saves that did nothing.
export function agentUpdateAudit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AgentUpdateAudit | null {
  const changed: AuditedAgentField[] = [];
  const beforeProj: Record<string, unknown> = {};
  const afterProj: Record<string, unknown> = {};
  let unreadBlocks: string[] = [];

  for (const field of AUDITED_AGENT_FIELDS) {
    if (field === "settings") {
      const diff = settingsDiff(before.settings, after.settings);
      if (
        Object.keys(diff.after).length === 0 &&
        diff.unreadBlocks.length === 0
      )
        continue;
      changed.push(field);
      beforeProj.settings = diff.before;
      afterProj.settings = diff.after;
      unreadBlocks = diff.unreadBlocks;
      continue;
    }
    const b = canonical(field, before[field]);
    const a = canonical(field, after[field]);
    if (same(b, a)) continue;
    changed.push(field);
    beforeProj[field] = b;
    afterProj[field] = a;
  }

  if (changed.length === 0) return null;

  // Named, not copied: these blocks are stored configuration nothing in this codebase reads, so
  // their contents are not ours to vouch for in a row a tenant admin can read.
  if (unreadBlocks.length > 0) {
    (afterProj.settings as Record<string, unknown>).unreadBlocksChanged =
      unreadBlocks;
  }

  const only = changed.length === 1 ? changed[0] : undefined;
  if (only === "systemPrompt") {
    return { action: "agent.prompt_set", before: beforeProj, after: afterProj };
  }
  if (only === "settings") {
    // Flattened to the blocks themselves, so the row reads the same as the one the MCP tool wrote:
    // `{ debounce: {...} }`, not `{ settings: { debounce: {...} } }`.
    return {
      action: "agent.settings_set",
      before: beforeProj.settings as Record<string, unknown>,
      after: afterProj.settings as Record<string, unknown>,
    };
  }
  return { action: "agent.update", before: beforeProj, after: afterProj };
}
