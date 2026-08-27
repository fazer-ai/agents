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
// Both sides are read back from the same jsonb columns through the same select, so key order is
// Postgres's own and a structural comparison is sound. Feeding this an in-memory patch instead
// would compare a client's key order against jsonb's and manufacture changes nobody made.
//
// The settings bag is compared through `readBehaviorSettings` on BOTH sides, and that is not a
// nicety. A stored bag is sparse — a fresh agent holds only what its creator wrote — while
// `mergeBehaviorSettings` (which every settings write goes through) materializes all of it, so the
// first write after creation genuinely changes twenty-five blocks in the column and only one of
// them because an operator asked. Measured: an `agent_settings_set` moving `debounce.waitMs` from
// 1500 to 2500 produced a 6 KB `after` naming every block, with the edit buried in it. Reading both
// sides through the same reader puts them in the same shape first, so what is left is the edit.
//
// One artifact survives that, and it is the reader's and not this function's. `readGuardrailsConfig`
// promises "always a usable model name after the reader", and it keeps that promise only when the
// block is PRESENT: an absent one returns `GUARDRAILS_DEFAULTS` with `model: ""` without ever
// running the resolution, so a stored `{}` reads `""` while the same bag after the merge reads
// `gpt-5.4-mini`. The first settings write on an agent that never touched guardrails therefore
// names that block too. It is latent at runtime (an absent block is `enabled: false`, so nothing
// reads the model) and it is true of the column, so it is recorded rather than filtered; the test
// that pins it fails the day the reader is made idempotent, which is when someone should reconcile
// the two.

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

// The model config as the row may hold it: only the keys the schema names.
//
// `validateModelConfigForWrite` asks `modelConfigSchema.safeParse` whether the value is valid and
// throws away the STRIPPED result, so a config that is valid apart from a stray key is stored with
// that key intact — measured: a `PATCH` carrying `apiKey: "sk-…"` alongside a good provider/model
// reaches the column, and copying the column into the row hands a retained, tenant-admin-readable
// copy of it to the trail. The allowlist is derived from the schema rather than typed out, so a
// field added there is carried here and one never named is not, and it is a PICK rather than a
// parse because a legacy config that no longer validates still has to project something.
const MODEL_CONFIG_KEYS = Object.keys(modelConfigSchema.shape);

function pickModelConfig(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of MODEL_CONFIG_KEYS) if (k in src) out[k] = src[k];
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The reader's output as the row can actually hold it. It is not all plain data — `observability`
// carries `fullDetailUntil` as a `Date`, and `truncForAudit` walks objects by their enumerable
// entries, of which a Date has none: it reaches the column as `{}`, so the row says the deadline
// moved and cannot say to what (measured). The round-trip is the same conversion the comparison
// above already performs, applied to what is STORED as well as to what is compared, and it answers
// for the whole family rather than for the one block that has a Date today.
function jsonish(v: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v ?? {})) as Record<string, unknown>;
}

// The settings bag arrives whole from every door, so "which block did the operator touch" is a
// question only the comparison answers. Projecting the bag itself would put an agent's entire
// configuration into both halves of every row that moved one number.
function changedBlocks(
  before: unknown,
  after: unknown,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b = jsonish(readBehaviorSettings(before));
  const a = jsonish(readBehaviorSettings(after));
  const outBefore: Record<string, unknown> = {};
  const outAfter: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (!same(b[key], a[key])) {
      outBefore[key] = b[key];
      outAfter[key] = a[key];
    }
  }
  return { before: outBefore, after: outAfter };
}

// A comparação do bag inteiro só diverge da comparação bloco a bloco pela ORDEM das chaves, e não
// há caminho por onde ela chegue: os dois lados saem de `jsonb`, que canonicaliza (medido: as
// chaves voltam ordenadas por comprimento e depois por bytes, `{"zz":1,"a":2,"mmm":3}` e
// `{"a":2,"mmm":3,"zz":1}` produzem a mesma saída). Uma guarda para o bloco vazio foi escrita aqui
// e a bateria de mutação mostrou que nenhum teste a alcança, porque nada pode alcançá-la.

// Whether a replace-the-set write actually changed the set.
//
// The grants are compared as a SET and not as a list, because their order is not the operator's:
// `replaceAgentToolSelections` is a `deleteMany` + `createMany`, so every save reassigns the ids the
// read then orders by. Two submissions of the same set in a different order would otherwise record a
// row whose two halves hold the same grants. Sorting by each entry's own serialization is a total
// order by construction — no entry ties with another unless they are equal.
export function grantSetChanged(before: unknown[], after: unknown[]): boolean {
  const key = (xs: unknown[]) =>
    JSON.stringify(xs.map((g) => JSON.stringify(g)).sort());
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

  for (const field of AUDITED_AGENT_FIELDS) {
    if (same(before[field], after[field])) continue;
    if (field === "settings") {
      const blocks = changedBlocks(before.settings, after.settings);
      // Normalized-equal, raw-different. The bag comparison above is on the stored bytes and this
      // one is on what the platform resolves, and the readers CLAMP: `debounce.windowSeconds` of 1
      // and of 2 both read as 3 (measured), so a PATCH between them moves the column and moves
      // nothing the runtime will do. Without this the row lands with `{}` on both sides.
      //
      // A guard of this shape was written in round 1 and removed in the same round as dead, on the
      // strength of measuring that jsonb canonicalizes key order. That measurement was right and the
      // conclusion was not: key order was one way in, clamping is another, and only the first had
      // been checked.
      if (Object.keys(blocks.after).length === 0) continue;
      changed.push(field);
      beforeProj.settings = blocks.before;
      afterProj.settings = blocks.after;
      continue;
    }
    changed.push(field);
    const project =
      field === "modelConfig" ? pickModelConfig : (x: unknown) => x;
    beforeProj[field] = project(before[field]);
    afterProj[field] = project(after[field]);
  }

  if (changed.length === 0) return null;

  const only = changed.length === 1 ? changed[0] : undefined;
  if (only === "systemPrompt") {
    return {
      action: "agent.prompt_set",
      before: beforeProj,
      after: afterProj,
    };
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
