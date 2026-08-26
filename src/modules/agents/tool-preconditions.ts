// A condition an operator declares on ONE granted tool, checked by the runtime at the moment the
// model calls it: unmet, and the call does not run. It is the enforceable half of `toolGuidance`
// (tool-guidance.ts): guidance says WHEN to use a tool and is re-decided by the model every turn;
// a precondition says when the tool MAY be used, and is not the model's to re-decide.
//
// Measured motivation (issue #101): an agent told, in five separate places, never to hand off
// without the article URL called `handoff_to_human` on three consecutive runs of the same input and
// wrote the unmet condition into its own `reason` argument each time. The prompt was not the defect;
// the absence of an enforcement point was.
//
// TYPED, and deliberately not an expression language. The market splits here: OPA/Rego and Cedar are
// expression languages because their audience writes code, while the operator-facing products
// (Copilot Studio) give conditions over a NAMED VARIABLE and no syntax at all. This surface is
// configured by the same operator who types the prompt, so it is data. It is also the direction that
// stays open: a closed set of conditions translates mechanically into an expression later, while an
// expression published to operators is a contract that cannot be taken back.

// [code-tool] This type is the STATE NAMESPACE — the one piece a future sandboxed code tool
// genuinely shares with this file, because "what can a rule see about the conversation" is the same
// question for both and it is the expensive half to get right. When that tool lands, reconcile HERE
// rather than growing a second vocabulary: a rule that reads `conversationAttributes` in one place
// and `conversation.attributes` in another is a migration of operator configuration later.
// What must NOT be shared is the LANGUAGE. Code-tool code is authored by the MODEL, per turn, and
// may loop, call out and fail; a precondition is authored by the OPERATOR, once, and has to always
// terminate and always answer, because its answer decides whether a call happens at all. Letting the
// model author the rule that binds the model is the failure mode issue #363 measured one layer down.
export interface PreconditionState {
  // The mirrored Chatwoot bags, read from OUR tables (never a live Chatwoot call), at the moment the
  // guarded tool is called rather than at turn build. The turn is exactly when they move: the
  // customer gives the value, `set_custom_attribute` writes it, and the guarded call comes after —
  // all in one turn. A snapshot taken at build would refuse a condition the same turn had satisfied.
  conversationAttributes: Record<string, unknown>;
  contactAttributes: Record<string, unknown>;
}

// ONE kind today, and the union is written as a union anyway: `kind` is the tag a second condition
// will be added on, and a shape that has to be widened later is a shape whose readers were written
// without it. What is NOT here is a condition over the message history — see the note on
// PreconditionState in the PR: the graph state is unreachable from a tool outside a Pregel run
// (`getCurrentTaskInput()` throws "internal scratchpad not initialized", measured), and the mirror
// does not hold message bodies. That condition needs a transcript source that does not exist yet.
export type ToolPrecondition =
  // The named attribute carries a value (any non-blank value), or equals a given one.
  {
    kind: "attribute";
    scope: "conversation" | "contact";
    key: string;
    equals?: string;
  };

const SCOPES = new Set(["conversation", "contact"]);
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// Exported because the WRITE boundary needs the same parse the runtime uses. Two parsers is how a
// value gets accepted by the API and then ignored by the turn.
export function parseToolPrecondition(raw: unknown): ToolPrecondition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (c.kind === "attribute") {
    const key = str(c.key);
    const scope = str(c.scope);
    if (!key || !scope || !SCOPES.has(scope)) return null;
    // NOTE: `equals` presente com valor não-string é RECUSA, nunca "sem equals": dropar o campo
    // transformaria "o atributo tem que valer X" em "o atributo tem que existir", que é uma regra
    // mais fraca do que a que o operador escreveu — e mais fraca em silêncio.
    if (c.equals !== undefined && c.equals !== null) {
      if (typeof c.equals !== "string" || c.equals.trim() === "") return null;
    }
    const equals = str(c.equals);
    return {
      kind: "attribute",
      scope: scope as "conversation" | "contact",
      key,
      ...(equals === null ? {} : { equals }),
    };
  }
  return null;
}

// Stored flat at `settings.toolPreconditions = { [toolName]: ToolPrecondition }`, keyed by TOOL NAME
// rather than by grant id. That is what makes one map cover all six tool sources at once: prepare.ts
// merges native, document, HTTP, MCP, toolpack and RAG tools into a single name-unique list
// (dropDuplicateToolNames), so a name is the one identifier every source already agrees on.
//
// A malformed condition is DROPPED, not repaired: a precondition that "sort of" parses is worse than
// none, because the operator would read the tool as guarded while the runtime treats it as open. The
// write side refuses instead of dropping, so a dropped condition here means settings written before
// this shipped, or written around the API.
// NULL-PROTOTYPE, and both directions of that bit. A tool name is operator text: `__proto__` as a
// key on a plain object mutates the prototype instead of storing a rule, so the guard the operator
// wrote simply disappears; and a tool named `constructor` or `toString` finds an INHERITED value on
// lookup, so an unguarded tool is blocked by something nobody configured.
function emptyMap(): Record<string, ToolPrecondition> {
  return Object.create(null) as Record<string, ToolPrecondition>;
}

export function readToolPreconditions(
  settings: unknown,
): Record<string, ToolPrecondition> {
  const bag =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).toolPreconditions
      : undefined;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return emptyMap();
  const out = emptyMap();
  for (const [name, raw] of Object.entries(bag as Record<string, unknown>)) {
    const cond = parseToolPrecondition(raw);
    if (cond) out[name] = cond;
  }
  return out;
}

export function evaluatePrecondition(
  cond: ToolPrecondition,
  state: PreconditionState,
): boolean {
  const bag =
    cond.scope === "conversation"
      ? state.conversationAttributes
      : state.contactAttributes;
  // NOTE: OWN property, and the attribute key is operator text just like the tool name. `constructor`,
  // `toString` and `__proto__` all resolve to something non-blank on an ordinary bag parsed from
  // jsonb, so a presence-only rule would read as SATISFIED on an empty conversation — the tool runs
  // exactly where the operator asked for it not to.
  if (!Object.hasOwn(bag, cond.key)) return false;
  const value = bag[cond.key];
  if (value === null || value === undefined) return false;
  // NOTE: A non-string value (a number, a boolean, `false`, `0`) is PRESENT, and presence is the
  // question. Only a string can be blank, and a blank string is the shape an attribute takes when
  // it was cleared rather than set.
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return false;
    return cond.equals === undefined ? true : trimmed === cond.equals;
  }
  return cond.equals === undefined ? true : String(value) === cond.equals;
}

// Model-facing, and in English like every other tool return in this codebase. It has one job the
// status code of a refusal cannot do: tell the model what to DO next, so the turn continues instead
// of ending. In the reported case the right next move is to ask the customer for the URL, and the
// model only knows that if the refusal says which URL is missing.
export function unmetPreconditionMessage(
  toolName: string,
  cond: ToolPrecondition,
): string {
  const what =
    cond.equals === undefined
      ? `the ${cond.scope} attribute \`${cond.key}\` to be set`
      : `the ${cond.scope} attribute \`${cond.key}\` to be \`${cond.equals}\``;
  return `\`${toolName}\` was not run: it requires ${what}, and it is not. Continue the conversation and obtain it first — do not tell the customer about this restriction.`;
}

// Every entry of a settings bag that does not parse, named. The write side refuses on a non-empty
// result; the runtime reader drops the same entries silently, because by then the operator is not
// there to be told.
export function invalidToolPreconditions(settings: unknown): string[] {
  const bag =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).toolPreconditions
      : undefined;
  if (bag === undefined || bag === null) return [];
  // NOTE: The bag itself being the wrong shape is one refusal, not N: there are no names to list.
  if (typeof bag !== "object" || Array.isArray(bag))
    return ["toolPreconditions"];
  return Object.entries(bag as Record<string, unknown>)
    .filter(([, raw]) => parseToolPrecondition(raw) === null)
    .map(([name]) => name);
}
