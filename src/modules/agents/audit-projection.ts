import { modelConfigSchema } from "@/graph/model-config";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import { readVaultRefId, VAULT_REF_PREFIX } from "@/modules/vault/service";

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

// `out[k] = v` is not an assignment when `k` is `"__proto__"`: it invokes the legacy prototype
// setter and creates no own property, so a stored block by that name would compare equal on both
// sides and its write would leave no row. Same repair, and same reason, as `truncForAudit`'s. Used
// only where the key comes from the CALLER — the fixed lists (`MODEL_CONFIG_KEYS`, the audited
// fields, array indices) cannot spell it.
function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, {
    value: v,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const CANONICAL: Partial<
  Record<AuditedAgentField, (v: unknown, now: Date) => unknown>
> = {
  settings: (v, now) => jsonish(readBehaviorSettings(v, now)),
  modelConfig: (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    // PARSED when it parses, because the parse is what applies the schema's own defaults and those
    // are what the runtime sees: `model` defaults to `""`, so a config that omits it and one that
    // sends it empty are the same configuration — measured — and a picker that preserved the
    // difference filed an `agent.update` for a save that changed nothing.
    const parsed = modelConfigSchema.safeParse(v);
    if (parsed.success) return parsed.data;
    // PICKED when it does not. A legacy config that no longer validates still has to project
    // something, and the pick is the same allowlist by another route.
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of MODEL_CONFIG_KEYS) if (k in src) out[k] = src[k];
    return out;
  },
};

// An endpoint that carries its own credential, in any of the three places one fits.
//
// `https://user:pw@host`, `https://host/v1?api_key=…` and `https://host/v1#token=…` all pass
// `z.string().url()` and the editor's own validator, and the row is append-only, so one pasted there
// once would outlive the correction. Bounded to `http(s)` on purpose: it is what an endpoint is, and
// it keeps operator prose out of the rule — measured, `"Pergunta: você quer?"` parses as a URL with
// protocol `pergunta:`, and a rule keyed on parseability alone would start eating template messages.
function carriesCredential(v: unknown): boolean {
  // TRIMMED first, and the trim is the guard rather than tidiness: `z.string().url()` validates
  // through `new URL`, which ignores surrounding whitespace, so `" https://user:pw@host"` is
  // accepted — and `validateModelConfigForWrite` discards the parsed result, so the string reaches
  // the column with the space still on it. An anchored test on the raw string then says no.
  if (typeof v !== "string") return false;
  // EMBEDDED, not only entire, and under ANY scheme. `new URL` is handed the whole string, so a
  // prompt reading `Use https://user:secret@example.com/api` fails to parse and was kept verbatim —
  // and a prompt is exactly where an operator pastes one inline.
  //
  // The password is OPTIONAL in the pattern: `https://sk-live-token@example.com/api` is userinfo
  // with no colon in it, and the token is the whole of it. Excluding `/` before the `@` is what
  // keeps an `@` in a PATH out — measured, `https://github.com/orgs/@time/repos` does not match.
  //
  // Only the userinfo form is looked for inside text, and the line is drawn by measurement rather
  // than by caution. `user:pass@` is a shape prose does not produce: on a prompt linking to
  // `https://clinica.example.com/faq?secao=cancelamento` it does not fire, and on
  // `ftp://u:hunter2@files.example.com/x` it does. A rule that also fired on an embedded QUERY
  // cannot tell those two apart — it matches the FAQ link and the credential link alike — and since
  // the answer here is to drop the WHOLE field, adopting it would delete a prompt from the trail for
  // linking to a documentation page. The query and fragment half therefore still asks about the
  // whole string, where there is no prose to confuse it with.
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i.test(v)) return true;
  const url = v.trim();
  // The RAW spelling only answers for a string that will not parse. `new URL` normalizes
  // `https:llm.example/v1?api_key=…` and `https:/llm.example/v1?api_key=…` to protocol `https:`,
  // and `modelConfigSchema` accepts both, so a test anchored on `//` in the text called them
  // non-endpoints and copied the query straight into the row.
  const looksHttp = /^https?:\/\//i.test(url);
  try {
    const u = new URL(url);
    const httpish = u.protocol === "http:" || u.protocol === "https:";
    // USERINFO is asked of any scheme, and the query and the fragment only of `http(s)`. The split
    // is measured, not stylistic. `z.string().url()` accepts `ftp://user:pw@host`, so restricting
    // the whole rule to `http(s)` let that one through; and userinfo costs nothing to widen because
    // prose does not have it — `"Pergunta: você quer?"` parses with protocol `pergunta:` and an
    // empty username, as do `mailto:` and `urn:`. A `?` in prose is common, which is why the other
    // half stays bounded to what is unambiguously an endpoint.
    if (u.username !== "" || u.password !== "") return true;
    return httpish && (u.search !== "" || u.hash !== "");
  } catch {
    if (!looksHttp) return false;
    // Shaped like an endpoint and not parseable as one: it cannot be shown to carry no credential.
    return true;
  }
}

// Such an endpoint is dropped from the canonical form rather than redacted in place, so the residue
// is what answers for it: rotating the credential reports that unread configuration moved, and never
// what it moved to.
//
// Applied to every field at every depth, because the sites are not one. Counting the reader's own
// output: `stt.baseURL`, `tts.baseURL`, `tts.normalizeBaseURL`, `vision.baseURL`, `contactAuth.url`,
// `guardrails.baseURL`, `memory.compaction.baseURL`, `modelFallback.baseURL` — eight, plus
// `modelConfig.baseURL`. A guard written on one of the nine is a guard on none of the other eight,
// and the tenth arrives with the next block.
// A credential reference that is not a REFERENCE.
//
// `docs/mcp.md` says every `credentialRef` is a `vault:<id>` and "never the secret itself", but the
// schema types it as a non-empty string and `collectCredentialRefWrites` validates only the refs a
// write CHANGES — so a legacy agent can carry a raw key there, resubmit it unchanged alongside some
// other edit, and have it copied into both halves of a permanent row. Nine keys carry one
// (`modelConfig` plus the eight `SETTINGS_CREDENTIAL_PATHS`, one of them spelled
// `normalizeCredentialRef`), which is why this asks about the NAME rather than repeating the list.
function isUnvouchableCredRef(key: string, v: unknown): boolean {
  if (!/credentialRef$/i.test(key)) return false;
  if (typeof v !== "string") return false;
  // The PREFIX is not the reference. `vault:sk-live-…` starts with it and is a secret, and the
  // unchanged-ref path is exactly the one that never validates, so the id itself has to be one.
  if (!v.startsWith(VAULT_REF_PREFIX)) return true;
  // The repo's own bounded parser, not a spelling check: `vault:99999999999999999999` is all digits
  // and outside the id range, so `readVaultRefId` cannot resolve it and it is caller-controlled text
  // rather than a reference to anything.
  return readVaultRefId(v) === null;
}

function dropUnvouchableUrls(v: unknown): unknown {
  // The ROOT is a position too. An audited scalar can BE the endpoint — a `name` or a
  // `systemPrompt` that is nothing but a URL — and a walk that only inspects object values and array
  // elements never asks about the value it was handed.
  if (carriesCredential(v)) return undefined;
  // Array ELEMENTS are checked, not just object values: `guardrails.competitors` is a list of bare
  // strings, and recursing into one without asking returns it untouched.
  if (Array.isArray(v))
    return v.filter((el) => !carriesCredential(el)).map(dropUnvouchableUrls);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (carriesCredential(val) || isUnvouchableCredRef(k, val)) continue;
    // `setOwn`, and the round trip to get here is the point. This was written as a plain assignment
    // on the reasoning that a CANONICAL value's keys are the readers' and the schema's and so cannot
    // be `__proto__`. The reasoning was wrong and the measurement says so: `readToolPreconditions`
    // builds its map with `Object.create(null)` and keys it by TOOL NAME, so `out[name] = cond` on a
    // null-prototype object creates `__proto__` as an OWN property — measured, the reader returns
    // `["handoff_to_human", "__proto__"]` and a plain assignment here dropped the second one, taking
    // an active runtime precondition out of the canonical view.
    setOwn(out, k, dropUnvouchableUrls(val));
  }
  return out;
}

// The parts of a stored value that the canonical form does not describe — an unknown settings block,
// a nested field under a block the readers DO know, a stray `modelConfig` key, a base URL that was
// dropped for carrying userinfo. Keyed by PATH and not by value, because a canonical value differs
// from its stored one all over a settings bag (defaults materialize, numbers clamp) while saying
// nothing about whether something unread moved.
function residue(
  raw: unknown,
  canon: unknown,
): Record<string, unknown> | undefined {
  if (Array.isArray(raw)) {
    // By VALUE and not by position. A typed reader normalizes the elements of a list it knows
    // (`followUp.steps`), so an unread field inside one survives in storage and is absent from the
    // canonical element; and an element the sanitization removed (a competitor entry that was a
    // credential-bearing URL) shifts every index after it. Either way, a raw element the canonical
    // array does not contain is one nothing reads — which is the whole question — and an index-wise
    // comparison answered it wrong in both cases.
    const canonArr = Array.isArray(canon) ? canon : [];
    const canonSeen = new Set(canonArr.map((x) => JSON.stringify(x)));
    const out: Record<string, unknown> = {};
    raw.forEach((el, i) => {
      if (el !== null && typeof el === "object") {
        // Recursed against the element at the same index: the reader rewrites these in place
        // (defaults materialize), so asking whether the element appears VERBATIM in the canonical
        // array would answer "unread" for every list it normalized — the same false positive the
        // clamp case is deliberately silent about.
        const nested = residue(el, canonArr[i]);
        if (nested !== undefined && Object.keys(nested).length > 0)
          out[String(i)] = nested;
        return;
      }
      // A primitive is not rewritten, it is kept or dropped, and dropping one shifts every index
      // after it — so this half asks by VALUE. It is what sees a competitor entry removed for being
      // a credential-bearing URL.
      if (!canonSeen.has(JSON.stringify(el))) out[String(i)] = el;
    });
    return out;
  }
  if (raw === null || typeof raw !== "object") {
    // A primitive the canonical form dropped entirely — the only way that happens is the rule above
    // — is unread by definition, and a rotation of it has to be visible. Wrapped rather than
    // returned bare so the caller's emptiness check reads it as content; the residue is COMPARED and
    // never projected, so the value itself does not leave this function.
    return canon === undefined && raw !== undefined
      ? { value: raw }
      : undefined;
  }
  const c =
    canon !== null && typeof canon === "object" && !Array.isArray(canon)
      ? (canon as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Absent from the canonical form, or DISCARDED by it. The second is the same thing said a
    // different way: a reader that rejects a value returns `null` for it rather than dropping the
    // key, so `contactAuth.url` carrying userinfo reads as `null` on both sides of a change and the
    // key alone would say the value is accounted for. It is not — nothing reads it, which is what
    // the residue is for.
    if (!Object.hasOwn(c, k) || (c[k] === null && v !== null)) {
      setOwn(out, k, v);
      continue;
    }
    const nested = residue(v, c[k]);
    if (nested !== undefined && Object.keys(nested).length > 0)
      setOwn(out, k, nested);
  }
  return out;
}

function canonical(field: AuditedAgentField, v: unknown, now: Date): unknown {
  const fn = CANONICAL[field];
  return dropUnvouchableUrls(fn ? fn(v, now) : v);
}

// The settings row carries the blocks that moved, never the bag: it arrives whole from every door,
// so which one the operator touched is a question only the comparison answers.
function changedBlocks(
  b: Record<string, unknown>,
  a: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
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

// Whether a replace-the-set write actually changed the set.
//
// Compared as a SET and not as a list, twice over. The grants' order is not the operator's:
// `replaceAgentToolSelections` is a `deleteMany` + `createMany`, so every save reassigns the ids the
// read then orders by. And inside a grant, `enabledTools` and `knowledgeBaseIds` are allowlists the
// runtime reads by MEMBERSHIP — measured: `filterAllowed` builds a `Set`, `prepare.ts` asks
// `.includes`/`.some`, the playground builds a `Set`, and no consumer reads the order — so the same
// allowlist resubmitted shuffled is the same grant. Membership is also why they are DEDUPLICATED
// here: `normalizeGrants` permits a repeated entry and a `Set` cannot hold one, so dropping a
// duplicate leaves the runtime's capability set untouched. Sorting by each entry's own serialization
// is a total order by construction: no entry ties with another unless they are equal.
export function grantSetChanged(before: unknown[], after: unknown[]): boolean {
  const SET_VALUED = ["enabledTools", "knowledgeBaseIds"];
  const canon = (g: unknown) => {
    if (g === null || typeof g !== "object") return JSON.stringify(g);
    const out: Record<string, unknown> = { ...(g as Record<string, unknown>) };
    for (const k of SET_VALUED) {
      const v = out[k];
      if (Array.isArray(v)) out[k] = [...new Set(v.map(String))].sort();
    }
    return JSON.stringify(out);
  };
  const key = (xs: unknown[]) => JSON.stringify(xs.map(canon).sort());
  return key(before) !== key(after);
}

// A projection with the unread marker on it, whatever shape the projection had.
//
// A field whose canonical form was DROPPED projects `undefined`, and one whose canonical form is a
// scalar projects a string or a number — assigning a property onto either throws. That is not a
// cosmetic bug: the audit shares the mutation's transaction, so the throw rolls the write back, and
// the write it rolls back is exactly the one an operator makes to REMOVE a credential they pasted
// into a name or a prompt by accident. Measured, before this existed:
// `TypeError: undefined is not an object`.
function markable(v: unknown): Record<string, unknown> {
  // Shaping and not a guard: without this arm a dropped field projects
  // `{ value: undefined, unreadConfigChanged: true }`, which serializes to the same row, and a
  // mutation battery on it kills nothing for that reason. It is kept so the value is honest before
  // it is serialized, rather than relying on `JSON.stringify` to erase the difference.
  if (v === undefined) return { unreadConfigChanged: true };
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return { ...(v as Record<string, unknown>), unreadConfigChanged: true };
  }
  return { value: v, unreadConfigChanged: true };
}

// The audit-safe form of any value a row is about to carry, for the projections built outside this
// module. `auditMutation` bounds sizes and repairs what the column refuses; it does not know that an
// endpoint can carry its own credential, and the create/clone/import/delete rows project a `name`
// that an operator is free to make one.
export function auditSafe(v: unknown): unknown {
  return dropUnvouchableUrls(v);
}

// Returns null when nothing changed: the trail records changes, and the console PATCHes a whole tab
// on every save, so writing a row per apply would fill the trail with saves that did nothing.
export function agentUpdateAudit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AgentUpdateAudit | null {
  // ONE instant for both sides. A reader that consults the clock resolves the same stored bag two
  // ways across a deadline expiry, so a no-op save could emit `agent.settings_set` and an unrelated
  // update could carry a settings change nobody made.
  const now = new Date();
  const changed: AuditedAgentField[] = [];
  const beforeProj: Record<string, unknown> = {};
  const afterProj: Record<string, unknown> = {};

  for (const field of AUDITED_AGENT_FIELDS) {
    const rawB = jsonish(before[field]);
    const rawA = jsonish(after[field]);
    const canonB = canonical(field, before[field], now);
    const canonA = canonical(field, after[field], now);
    // Two questions, asked SEPARATELY and both recorded. The first is what the runtime will do
    // differently; the second is whether anything moved that no reader sees. One write can do both
    // at once — a `debounce.windowSeconds` edit alongside an unknown nested setting — and an answer
    // that stopped at the first would leave half of that mutation out of the trail.
    const canonMoved = !same(canonB, canonA);
    const unreadMoved = !same(residue(rawB, canonB), residue(rawA, canonA));
    if (!canonMoved && !unreadMoved) continue;
    changed.push(field);
    if (canonMoved && field === "settings") {
      const diff = changedBlocks(
        canonB as Record<string, unknown>,
        canonA as Record<string, unknown>,
      );
      beforeProj.settings = diff.before;
      afterProj.settings = diff.after;
    } else if (canonMoved) {
      beforeProj[field] = canonB;
      afterProj[field] = canonA;
    } else {
      beforeProj[field] = {};
      afterProj[field] = {};
    }
    if (unreadMoved) {
      beforeProj[field] = markable(beforeProj[field]);
      afterProj[field] = markable(afterProj[field]);
    }
  }

  if (changed.length === 0) return null;

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
