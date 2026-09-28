// A condition an operator declares on ONE granted tool, checked by the runtime when the model calls
// it: unmet, the call does not run. The enforceable half of `toolGuidance`, which the model re-decides
// every turn. Typed data, not an expression language: a closed set of conditions can become an
// expression later, while an expression published to operators cannot be taken back.

// This type is the STATE NAMESPACE shared with the operator-authored code tools (graph/tools/
// code.ts): "what can a rule see about the conversation" is the same question for both, and the
// code tool's `context` carries these two bags under these two names, read at call time through
// `preconditionStateLoader`, so a rule that reads `conversationAttributes` here and the body that
// reads `context.conversationAttributes` there are one vocabulary. What is NOT shared is the
// LANGUAGE: a code tool's body may loop, throw and hit a limit, and its failure is reported; a
// precondition has to always terminate and always answer, because its answer decides whether a call
// happens at all, so it stays a closed set of typed conditions.
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";

export interface PreconditionState {
  // The mirrored Chatwoot bags, read from OUR tables (never a live Chatwoot call), at the moment the
  // guarded tool is called rather than at turn build. The turn is exactly when they move: the
  // customer gives the value, `set_custom_attribute` writes it, and the guarded call comes after —
  // all in one turn. A snapshot taken at build would refuse a condition the same turn had satisfied.
  conversationAttributes: Record<string, unknown>;
  contactAttributes: Record<string, unknown>;
}

// One kind today, written as a union tagged by `kind` so readers handle the next one. No condition
// over the message history: a tool cannot reach the graph state outside a Pregel run, and the mirror
// holds no message bodies (docs/graph.md).
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

// NULL-PROTOTYPE, because a tool name is operator text: `__proto__` on a plain object would mutate the
// prototype instead of storing a rule, and `constructor` or `toString` would find an inherited value.
function emptyMap(): Record<string, ToolPrecondition> {
  return Object.create(null) as Record<string, ToolPrecondition>;
}

// `settings.toolPreconditions = { [toolName]: ToolPrecondition }`, keyed by name because a name is the
// one identifier all six tool sources share (dropDuplicateToolNames). A malformed condition is DROPPED:
// one that half-parses reads as a guard while the runtime treats the tool as open. Names are filtered
// only at write (isGuardableToolName): an imported rule still guards a tool whose name matches.
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

// Which names may carry a rule: the native catalog only. A native name is identity no other source can
// take; HTTP, MCP and integration names move under a rename, and a rule that follows a name onto another
// tool is a guard that silently stops guarding (docs/graph.md). Refused at write, unlike `toolGuidance`,
// which drops silently: a lost hint is a hint, a lost guard reads on screen as protection.
export function isGuardableToolName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    (NATIVE_TOOL_NAMES as readonly string[]).includes(name)
  );
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
    .filter(
      // NOTE: The KEY is checked too: a padded name parses as a condition but never matches a tool.
      // NOTE: `null` is a REMOVAL (the MCP merge's tombstone), not a parse failure; its name is still
      // checked, so removing a rule from a tool that could never be guarded is refused.
      ([name, raw]) =>
        !isGuardableToolName(name) ||
        (raw !== null && parseToolPrecondition(raw) === null),
    )
    .map(([name]) => name);
}
