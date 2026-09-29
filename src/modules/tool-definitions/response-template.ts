// What an operator-authored HTTP tool says its response should LOOK LIKE by the time it reaches the
// model, and how that is rendered off a response body. Pure: no I/O, no clock.
//
// Without it the model gets the raw body clipped at maxResponseChars, and a field past the cut reads
// to a model as a gap to fill, not as missing data. A markdown template says which fields, under
// which names, in which order. Its tokens address the RESPONSE only, unlike the request-side
// PLACEHOLDER in `graph/tools/http.ts`: `{{secret}}` here is a path into the body and finds nothing.

import { clipText, unstorableCodePoints } from "@/lib/text";
import {
  collectLeaves,
  collectLists,
  isUsablePath,
  type SampleLeaf,
  type SampleList,
  walkPath,
} from "@/modules/tool-definitions/json-path";

// The template becomes model context on EVERY call of the tool, so it is capped like one.
// How much of a response reaches the model, template or not: `graph/tools/http.ts` clips to this,
// and the editor's preview promises "exactly what the agent would receive". Here rather than there
// because this module is the one both can import — `http.ts` is not client-safe, and a second 4000
// in the editor would be a second answer to the same question, with the wrong one being the one
// nobody is looking at.
export const MODEL_RESPONSE_CHAR_LIMIT = 4000;

export const MAX_TEMPLATE_CHARS = 4000;

// Per value, and the cap is what keeps the template's promise rather than a cost control. Without
// it one long field pushes the fields after it past the overall clip and they vanish from the tail —
// silently, which is the exact defect being fixed. Cutting HERE leaves the label and an explicit
// marker at the place the cut happened.
const MAX_VALUE_CHARS = 2000;

// What the model sees where a value did not come back. Never an empty string: a blank after a label
// is the gap that gets filled from training data, and this whole module exists because of that.
export const ABSENT_MARKER = "(not returned)";

// Anything between a pair of braces, INCLUDING what the path grammar refuses. Deliberately wider
// than the grammar: a token has to be recognized before it can be judged, and `{{data. id}}` is
// exactly the typo that a narrow pattern would fail to match and then leave sitting in the model's
// input as literal text.
const TOKEN = /\{\{([^{}]*)\}\}/g;

// A LIST OF UNKNOWN LENGTH. A block repeats its content once per item of the list its path names:
//
//   {{#each resultados}}
//   - {{nome}}: R$ {{preco}}
//   {{/each}}
//
// Inside it a path is RELATIVE to the item and `{{.}}` is the item itself; `{{#each .}}` walks a
// response that IS the list. Blocks do not nest. Both markers match TOKEN, so the block scan runs FIRST.
const BLOCK = /\{\{\s*(?:#each(?:[ \t]+([^{}]*?))?|(\/each))\s*\}\}/g;

// The current scope, which is the item inside a block and the body outside one.
export const ITEM_SELF = ".";

// How many items a block renders before it COUNTS the rest instead. This bounds WORK; the budget in
// `renderResponseTemplate` bounds TEXT, appending an item only while it fits with room for the count
// of what follows. The remainder is never dropped silently: "and 120 more" tells the model to narrow
// the query. Text BEFORE the block is not budgeted; the clip's own `…[truncated]` and the
// `response_clipped` note cover that.
export const MAX_EACH_ITEMS = 50;

// What the model sees where the list came back with nothing in it. Not the absent marker: the path
// was right and the API answered, so this is "no results", which is an answer. And never a blank:
// a label followed by nothing is the gap this module exists to close.
export const EMPTY_LIST_MARKER = "(none)";

export function moreItemsMarker(n: number): string {
  return `(and ${n} more not shown)`;
}

export interface ResponseTemplate {
  template: string;
}

// A template path: the grammar the appointment declaration shares, plus the scope itself.
export function isTemplatePath(p: unknown): p is string {
  return p === ITEM_SELF || isUsablePath(p);
}

function resolveTemplatePath(scope: unknown, path: string): unknown {
  return path === ITEM_SELF ? scope : walkPath(scope, path);
}

export type TemplateSegment =
  | { kind: "text"; text: string }
  | { kind: "each"; path: string; body: string };

export interface ParsedTemplate {
  segments: TemplateSegment[];
  // Why the template cannot be rendered as written, phrased to follow "outputSchema.template", or
  // null. A STRUCTURAL problem, which the token scan cannot see: to it both markers are well-formed.
  problem: string | null;
}

// A marker alone on its line takes the line with it (Handlebars calls this "standalone"), so the
// block written the natural way (marker, line per item, marker) renders one line per item, not a
// blank line between every two. A marker sharing its line with content keeps the line as written.
function standaloneBounds(
  template: string,
  start: number,
  end: number,
): [number, number] {
  let s = start;
  while (s > 0 && (template[s - 1] === " " || template[s - 1] === "\t")) s--;
  const atLineStart = s === 0 || template[s - 1] === "\n";
  let e = end;
  while (e < template.length && (template[e] === " " || template[e] === "\t"))
    e++;
  // A template typed in the console ends its lines with `\n`; one sent over REST or MCP from a
  // Windows editor may end them with `\r\n`, and the rule has to read both as "end of line".
  const eol =
    e === template.length
      ? 0
      : template[e] === "\n"
        ? 1
        : template[e] === "\r" && template[e + 1] === "\n"
          ? 2
          : -1;
  if (!atLineStart || eol === -1) return [start, end];
  return [s, e + eol];
}

export function parseTemplate(template: string): ParsedTemplate {
  const segments: TemplateSegment[] = [];
  const text = (s: string) => {
    if (s !== "") segments.push({ kind: "text", text: s });
  };
  let last = 0;
  let open: { path: string; bodyStart: number; marker: string } | null = null;
  for (const m of template.matchAll(BLOCK)) {
    const marker = m[0].trim();
    const [start, end] = standaloneBounds(
      template,
      m.index,
      m.index + m[0].length,
    );
    if (m[2] !== undefined) {
      if (open === null) {
        return {
          segments,
          problem: `has a {{/each}} with no {{#each …}} before it`,
        };
      }
      const body = template.slice(open.bodyStart, start);
      // A block with nothing to repeat renders a non-empty list as NOTHING: the tool answered and
      // the model reads an empty body. It is also exactly what the picker inserts (marker, empty
      // line, marker), so it is the shape a tool gets saved in when the operator stops one step
      // early; refused here, the Save gate says what to write instead of storing the silence.
      if (body.trim() === "") {
        return {
          segments,
          problem: `has ${open.marker} with nothing to repeat before {{/each}}; write the line for one item between the markers`,
        };
      }
      segments.push({ kind: "each", path: open.path, body });
      open = null;
    } else {
      if (open !== null) {
        return {
          segments,
          problem: `has ${marker} inside ${open.marker}; a list block cannot contain another`,
        };
      }
      const path = (m[1] ?? "").trim();
      if (!isTemplatePath(path)) {
        return {
          segments,
          problem: `has ${marker}, which does not name a list in the response; write {{#each path.to.list}}`,
        };
      }
      text(template.slice(last, start));
      open = { path, bodyStart: end, marker };
    }
    last = end;
  }
  if (open !== null) {
    return {
      segments,
      problem: `has ${open.marker} with no {{/each}} after it`,
    };
  }
  text(template.slice(last));
  return { segments, problem: null };
}

// The tokens a template writes, in document order, deduped. Includes malformed ones — the caller
// decides what to do with them, and both callers (the write refusal and the form gate) need to name
// them. Block markers are NOT tokens: they name a list, and `parseTemplate` judges them.
export function templateTokens(template: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of template.replace(BLOCK, "").matchAll(TOKEN)) {
    const raw = (m[1] ?? "").trim();
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function unusableTemplateTokens(template: string): string[] {
  return templateTokens(template).filter((t) => !isTemplatePath(t));
}

// WHERE EACH PIECE OF THE VOCABULARY SITS, for an editor that has to draw them apart. Here and not in
// the client, so the editor uses the same `TOKEN` and `BLOCK` that RENDER instead of a copy that drifts.
export type TemplateSpanKind = "token" | "block-open" | "block-close" | "stray";

export interface TemplateSpan {
  kind: TemplateSpanKind;
  from: number;
  to: number;
  // What it names: a token's path, a block's list. Null for a close marker and for a stray, which
  // name nothing.
  path: string | null;
  // Whether the grammar can use it as written. A token whose text is not a path renders as literal
  // text in front of the model, and a block over a non-path is refused on save; both are things the
  // editor exists to show BEFORE either happens. A stray is never usable.
  usable: boolean;
}

export function scanTemplate(template: string): TemplateSpan[] {
  const spans: TemplateSpan[] = [];
  // NOTE: blocks FIRST, and then tokens are dropped where they overlap one, which is the positional
  // form of the `template.replace(BLOCK, "")` that `templateTokens` does. To the token pattern both
  // markers are well-formed tokens, so without this `{{/each}}` reads as a malformed path and
  // `{{#each a}}` as a token that would reach the model as text.
  for (const m of template.matchAll(BLOCK)) {
    const close = m[2] !== undefined;
    const path = close ? null : (m[1] ?? "").trim();
    spans.push({
      kind: close ? "block-close" : "block-open",
      from: m.index,
      to: m.index + m[0].length,
      path,
      usable: close || isTemplatePath(path),
    });
  }
  const covered = (from: number, to: number): boolean =>
    spans.some((s) => from < s.to && to > s.from);
  for (const m of template.matchAll(TOKEN)) {
    const to = m.index + m[0].length;
    if (covered(m.index, to)) continue;
    const path = (m[1] ?? "").trim();
    spans.push({
      kind: "token",
      from: m.index,
      to,
      path,
      usable: isTemplatePath(path),
    });
  }
  // NOTE: what is left once every real span is accounted for, which is the same rule
  // `unmatchedTemplateDelimiter` answers with a fragment: `{{a}` matches no token, so it is not an
  // unusable token, it is not a token at all, and nothing would be drawn on the typo.
  for (const m of template.matchAll(/\{\{|\}\}/g)) {
    const to = m.index + 2;
    if (covered(m.index, to)) continue;
    spans.push({ kind: "stray", from: m.index, to, path: null, usable: false });
  }
  // DOCUMENT ORDER, because the caller builds a decoration set out of this and CodeMirror throws on
  // ranges that do not ascend.
  return spans.sort((a, b) => a.from - b.from);
}

// Whether rendering needs the response body at all. A template with neither a token nor a block
// says the same thing whatever came back, and the endpoint that most wants that is the one
// answering 204 with nothing in it. A block with no token inside still needs the body: how many
// times its content repeats is the body's answer.
export function templateNeedsBody(template: string): boolean {
  // `search` ignores the global flag's lastIndex, which `test` on a /g pattern would not.
  return templateTokens(template).length > 0 || template.search(BLOCK) !== -1;
}

// The block whose content the caret sits in, for the editor's picker: the path after `#each`, or
// null outside every block. LENIENT where `parseTemplate` refuses, on purpose: the operator has
// just typed `{{#each qsa}}` and opened the picker, and the block is unclosed at exactly that
// moment; refusing to answer would hide the item fields when they are most wanted. A marker the
// caret is inside of counts as not yet passed.
export function enclosingBlock(
  template: string,
  cursor: number,
): string | null {
  let open: string | null = null;
  for (const m of template.matchAll(BLOCK)) {
    if (m.index + m[0].length > cursor) break;
    open = m[2] !== undefined ? null : (m[1] ?? "").trim();
  }
  return open;
}

// A `{{` or a `}}` that is not part of a token (`{{a}` matches nothing), which would otherwise reach
// the model verbatim. The rule is "what is left after the real tokens are gone", which costs the
// ability to write a literal `{{`: in markdown for a model, a stray double brace is a typo. Returns
// the offending fragment so the message can point at it.
export function unmatchedTemplateDelimiter(template: string): string | null {
  const rest = template.replace(TOKEN, "");
  const at = rest.search(/\{\{|\}\}/);
  if (at === -1) return null;
  return rest.slice(at, at + 24);
}

// A value the model may be shown. WIDER than the appointment reader: `"active": false` is an answer,
// and the empty string is admitted for the renderer to tell apart from absent. The one refusal kept
// is the number past 2^53, whose digits JSON.parse already lost: the model would pass on an id the
// operator's system never issued.
function renderScalar(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (typeof node === "boolean") return node ? "true" : "false";
  if (typeof node === "number" && Number.isFinite(node)) {
    return Math.abs(node) > Number.MAX_SAFE_INTEGER ? undefined : String(node);
  }
  return undefined;
}

// The leaves a TEMPLATE token may point at: `collectLeaves` paired with this module's own scalar
// rule. The pairing is the invariant — a picker that offers what its own reader then refuses is
// worse than no picker — and `json-path.ts` carries the reasoning.
export function templateLeaves(root: unknown, max = 200): SampleLeaf[] {
  return collectLeaves(root, renderScalar, max);
}

// The lists a `{{#each}}` may repeat over, for the picker.
export function templateLists(root: unknown, max = 50): SampleList[] {
  return collectLists(root, max);
}

// What a token INSIDE a block may point at, relative to the item: the union of the first few items'
// leaves rather than the first item's alone, because a field the first row happens to lack (an
// optional note, a discount) is still a field of the list. A list of scalars has one thing to
// address, the item itself, offered as `.`. Paired with `renderTokens` the way `templateLeaves` is
// paired with the scalar rule: every offer here renders.
export function templateItemLeaves(
  items: unknown[],
  opts: { sampleItems?: number; max?: number } = {},
): SampleLeaf[] {
  const out: SampleLeaf[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, opts.sampleItems ?? 10)) {
    const self = renderScalar(item);
    const leaves =
      self !== undefined
        ? [{ path: ITEM_SELF, value: self }]
        : templateLeaves(item);
    for (const leaf of leaves) {
      if (out.length >= (opts.max ?? 200)) return out;
      if (seen.has(leaf.path)) continue;
      seen.add(leaf.path);
      out.push(leaf);
    }
  }
  return out;
}

// The items a block over `path` would repeat over in `body`, or null when there is no list there.
// The picker's question, answered by the same resolution the renderer uses.
export function templateListAt(body: unknown, path: string): unknown[] | null {
  const node = resolveTemplatePath(body, path);
  return Array.isArray(node) ? node : null;
}

// WHAT A TOKEN AT THIS CARET MAY NAME, for both console offers (the picker and the `{{` completion):
// one function so they cannot disagree, and here because the reader that must ACCEPT the pick is here.
export interface TemplateOffer {
  // The list whose items the caret's scope is, or null at the top level.
  block: string | null;
  leaves: SampleLeaf[];
  // Only ever offered at the top level: blocks do not nest.
  lists: SampleList[];
}

// The sample as the console already holds it: the parsed body plus the top-level offer computed
// once per paste. Taken rather than derived because this runs on every keystroke inside a token,
// and walking the body again per character would re-answer a question whose answer only changes
// when the SAMPLE changes.
export interface TemplateSampleOffer {
  body: unknown;
  leaves: SampleLeaf[];
  lists: SampleList[];
}

export function templateOfferAt(
  template: string,
  cursor: number,
  sample: TemplateSampleOffer,
): TemplateOffer {
  const block = enclosingBlock(template, cursor);
  if (block === null) {
    return { block: null, leaves: sample.leaves, lists: sample.lists };
  }
  // The item leaves ARE derived here, because they depend on which block the caret is in and
  // the caret moves between keystrokes. Bounded by the same caps the picker uses.
  const items = templateListAt(sample.body, block);
  return {
    block,
    leaves: items === null ? [] : templateItemLeaves(items),
    lists: [],
  };
}

// WHAT THE OPERATOR IS IN THE MIDDLE OF TYPING, or null outside a token. `kind`: after `{{#each ` only
// a LIST renders, so a scalar there would write a block the save refuses. `closed`: whether a `}}`
// already follows, which decides whether accepting types one.
export interface TemplateWrite {
  kind: "path" | "list";
  // What the operator has typed since the opening: `from` to the caret. The completion FILTERS on
  // this range (`@codemirror/autocomplete` slices `from..to` of the result), so it must end at the
  // caret, or candidates meant to replace the rest of the path would be filtered out.
  from: number;
  to: number;
  // Where the path already in the token ends, which is what an accepted answer REPLACES. The same
  // as the caret on an open token; through the existing path on a closed one, walked back over the
  // trailing whitespace the grammar trims. Kept apart from `to` because filtering and replacing are
  // two questions, and CodeMirror only lets one range answer the first.
  pathEnd: number;
  // Just past the `}}` that already closes this token, or null when nothing does. A boolean was
  // not enough, measured in the browser: `closeBrackets` turns a typed `{{` into `{{}}`, so the
  // ordinary case IS the closed one, and leaving the caret at the end of the inserted path leaves
  // it INSIDE the token. Everything typed next went in there — `{{cliente.nome{{#each x}}}}` on one
  // line, from typing a token and then a block the way anyone would.
  closeAt: number | null;
}

export function templateWriteAt(
  template: string,
  cursor: number,
): TemplateWrite | null {
  const before = template.slice(0, cursor);
  const open = before.lastIndexOf("{{");
  if (open === -1) return null;
  const typed = before.slice(open + 2);
  // NOTE: an unclosed `{{` further up is a typo rather than an invitation to complete on every line
  // under it, so the attempt stops at a line break. `}}` ends it for the obvious reason: the token
  // before the caret is finished.
  //
  // This is where the OFFER is narrower than the GRAMMAR, deliberately: `TOKEN` does span lines, so
  // `{{a\nb}}` is one token to the renderer and to `scanTemplate`, which marks it unusable and lets
  // the field say so. Two different questions — what is being written here, and what does the
  // runtime see — and only the second may answer for the runtime.
  if (/[\r\n]/.test(typed) || typed.includes("}}")) return null;
  // NOTE: `{{/each}}` names nothing, so there is nothing to offer inside it.
  if (typed.startsWith("/")) return null;
  // The whitespace the GRAMMAR allows (`{{ campo }}`, `{{ #each xs }}`) is not part of what is
  // being typed: in the prefix CodeMirror filters on, it would filter every path out.
  const lead = /^[ \t]*/.exec(typed)?.[0].length ?? 0;
  const body = typed.slice(lead);
  // `[ \t]+`, the separator `BLOCK` itself requires, not `*`: with `*`, completing right after
  // `each` writes `{{#eachresultados}}`, which the Save gate refuses. `closeBrackets` answers a typed
  // `{{` with `{{}}`, so the caret lands exactly there.
  const each = /^#each[ \t]+/.exec(body);
  // NOTE: and a `#` that has not become a complete marker yet is not a path prefix either. Without
  // this, dropping the separator above only moved the defect: `{{#each}}` stopped asking for a list
  // and started asking for a PATH over the text `#each`, so accepting wrote `{{cliente.nome}}`
  // over the marker the operator was in the middle of typing.
  if (!each && body.startsWith("#")) return null;
  const kind = each ? "list" : "path";
  const from = open + 2 + lead + (each ? each[0].length : 0);
  // The token may be closed by braces the operator typed OR by the ones already sitting there
  // from an earlier edit; either way the answer is the same, and what decides it is the next `}}`
  // on this line, before any other `{{`.
  const after = template.slice(cursor);
  const line = after.split(/[\r\n]/, 1)[0] ?? "";
  const close = line.indexOf("}}");
  const nextOpen = line.indexOf("{{");
  const closeAt =
    close !== -1 && (nextOpen === -1 || close < nextOpen)
      ? cursor + close + 2
      : null;
  return {
    kind,
    from,
    // NOTE: through the end of the path ALREADY THERE, not up to the caret: completing at the start of
    // `{{foo}}` must not write `{{barfoo}}`, which may even be a legal path nobody chose. Trailing
    // whitespace stays where the operator put it.
    to: cursor,
    pathEnd:
      closeAt === null ? cursor : endOfPath(template, cursor, closeAt - 2),
    closeAt,
  };
}

// Where the path being replaced stops: the closing braces, walked back over the whitespace the
// grammar trims, and never before the caret.
function endOfPath(template: string, cursor: number, close: number): number {
  let end = close;
  while (end > cursor && /[ \t]/.test(template[end - 1] ?? "")) end--;
  return Math.max(end, cursor);
}

export type ResponseTemplateRead =
  // No template here, as on any row whose `outputSchema` carries something else. The runtime keeps
  // the raw body, clipped.
  | { declared: false }
  | { declared: true; ok: true; template: string }
  // Declared and unusable. Refused by the writers rather than stored, because a declaration that
  // looks saved and does nothing is the same silence this feature removes — the operator is the one
  // who can act on the refusal, so they get it (see `padroes.md`, "recusar ou reparar").
  | { declared: true; ok: false; problem: string };

// ONE reader for both questions the writers ask ("is there a template?" and "why not?"), because
// two spellings of the same rule drift and the drift is invisible: the form would gate on one and
// the service store by the other.
//
// `mode: "template"` is what OPTS IN. Anything else in `outputSchema` — including a real JSON Schema
// someone wrote through the MCP tool, which has accepted the column unvalidated since it existed —
// declares nothing and is still accepted by the writers. Refusing those would break a published
// surface for rows that never asked for this feature.
export function readResponseTemplateResult(raw: unknown): ResponseTemplateRead {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { declared: false };
  }
  const bag = raw as Record<string, unknown>;
  if (bag.mode !== "template") return { declared: false };
  const fail = (problem: string): ResponseTemplateRead => ({
    declared: true,
    ok: false,
    problem,
  });
  if (typeof bag.template !== "string") {
    return fail(
      'outputSchema.template must be a string when mode is "template"',
    );
  }
  const template = bag.template.trim();
  if (template === "") {
    return fail(
      "outputSchema.template must not be empty; omit outputSchema (or send {}) to hand the model the raw response instead",
    );
  }
  if (template.length > MAX_TEMPLATE_CHARS) {
    return fail(
      `outputSchema.template must be at most ${MAX_TEMPLATE_CHARS} characters (it is sent to the model on every call of this tool)`,
    );
  }
  // The column is jsonb, which refuses a NUL and half a character outright: an unstoreable template
  // does not degrade anything, the write throws. Named here instead, where the operator can read it.
  const bad = unstorableCodePoints(template);
  if (bad !== null) {
    return fail(
      `outputSchema.template contains characters that cannot be stored: ${bad}`,
    );
  }
  const stray = unmatchedTemplateDelimiter(template);
  if (stray !== null) {
    return fail(
      `outputSchema.template has an unmatched delimiter near "${stray}"; a field is written {{path}}, and a stray {{ or }} would reach the model as literal text`,
    );
  }
  // Structure before tokens: a `{{/each}}` judged as a token is "not a path", which sends the
  // operator to fix a spelling that is right.
  const parsed = parseTemplate(template);
  if (parsed.problem !== null) {
    return fail(`outputSchema.template ${parsed.problem}`);
  }
  const unusable = unusableTemplateTokens(template);
  if (unusable.length > 0) {
    return fail(
      `outputSchema.template has token(s) that are not a path into the response: ${unusable
        .map((t) => `{{${t}}}`)
        .join(
          ", ",
        )}. A path is dot-separated keys with a number for a list position, e.g. data.items.0.name; inside {{#each list}}…{{/each}} it is relative to the item, and {{.}} is the item itself`,
    );
  }
  return { declared: true, ok: true, template };
}

// The runtime's question, and the fail-safe direction: anything the reader cannot honour reads as no
// template at all, so a row that somehow holds one renders nothing new instead of half of it.
export function readResponseTemplate(raw: unknown): ResponseTemplate | null {
  const r = readResponseTemplateResult(raw);
  return r.declared && r.ok ? { template: r.template } : null;
}

// THE PROJECTION ITSELF, here rather than in `graph/tools/http.ts` because the runtime and the
// editor's preview ("exactly what the agent would receive") must agree on it. One function, so a
// rule is never restated; the callers differ only in what they do with `skipped`.
export interface ProjectedResponse {
  // What the model is handed, or null when the template does not apply and the raw body goes.
  text: string | null;
  // Paths the template names that the body does not answer with. Empty when `text` is null.
  missing: string[];
  // Why the template did not apply, when it did not.
  skipped: "no-template" | "not-2xx" | "not-json" | null;
}

// Whether the model reads this body AS IT ARRIVED, with no template over it. Only 2xx gets a template
// (the same gate as `registerDeclaredAppointment`): a non-2xx body is the error the model has to read
// literally. Exported so the console asks this same question instead of answering it again.
export function readsBodyVerbatim(status: number): boolean {
  return status < 200 || status >= 300;
}

export function projectToolResponse(
  outputSchema: unknown,
  status: number,
  rawBody: string,
  opts: RenderOptions = {},
): ProjectedResponse {
  const tpl = readResponseTemplate(outputSchema);
  if (!tpl) return { text: null, missing: [], skipped: "no-template" };
  if (readsBodyVerbatim(status)) {
    return { text: null, missing: [], skipped: "not-2xx" };
  }
  // A template that reads nothing says the same thing whatever the body is, so it must not be
  // gated on the body PARSING: the endpoint that most wants a constant answer is the one returning
  // 204 with nothing in it.
  if (!templateNeedsBody(tpl.template)) {
    return { ...renderResponseTemplate(tpl, undefined, opts), skipped: null };
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { text: null, missing: [], skipped: "not-json" };
  }
  return { ...renderResponseTemplate(tpl, body, opts), skipped: null };
}

// The clip the model's input gets, whoever is applying it. Returns the flag as well as the text
// because the runtime warns on it and the preview does not.
export function clipToModelLimit(
  text: string,
  max: number = MODEL_RESPONSE_CHAR_LIMIT,
): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  return { text: `${clipText(text, max)}…[truncated]`, clipped: true };
}

// What a WRITER puts in the column: the reader's shape for a usable declaration, anything else
// untouched (a legacy JSON Schema is not this feature's to rewrite). REST/MCP refuse a broken
// declaration before this; the IMPORT cannot refuse a whole bundle, so with `dropUnusable` it drops
// the declaration and the row says "no template" instead of holding text nothing reads.
export function storableResponseTemplate(
  raw: unknown,
  opts: { dropUnusable?: boolean } = {},
): Record<string, unknown> {
  const r = readResponseTemplateResult(raw);
  if (r.declared && r.ok) return { mode: "template", template: r.template };
  if (r.declared && opts.dropUnusable) return {};
  return (raw ?? {}) as Record<string, unknown>;
}

export interface RenderedResponse {
  text: string;
  // The paths that did NOT resolve, named, in document order. This is the operator's only channel:
  // the tool succeeded and the model got an answer, so a mis-aimed path is invisible everywhere else.
  //
  // A path that resolved to `null` or to the empty string is NOT here. Those render as absent too —
  // the model must not be handed a blank — but the path itself is right, and reporting it would send
  // the operator to fix a template that has nothing wrong with it.
  missing: string[];
}

// Where a token sits: at the top level, or inside the block over `path` at item `index`. Decides
// what a miss is REPORTED as. Inside a block the label is the absolute path at the first index that
// lacked the field (`resultados.3.preco`), in-grammar so the operator can paste it into the
// sample field and see for themselves, and the report is deduped per FIELD, not per item, or a
// fifty-row list missing one column would name it fifty times.
type TokenScope = { path: string; index: number } | null;

function renderTokens(
  text: string,
  scope: unknown,
  at: TokenScope,
  report: (label: string, key: string) => void,
): string {
  return text.replace(TOKEN, (whole, rawToken: string) => {
    const path = (rawToken ?? "").trim();
    // Unreachable for a stored template (the reader refuses one that has such a token) and left
    // literal rather than thrown on, so a template reaching here by some other road degrades into
    // the text the operator typed instead of failing a tool call that already succeeded.
    if (!isTemplatePath(path)) return whole;
    const node = resolveTemplatePath(scope, path);
    const value = renderScalar(node);
    if (value !== undefined && value !== "") {
      return value.length > MAX_VALUE_CHARS
        ? `${clipText(value, MAX_VALUE_CHARS)}…[truncated]`
        : value;
    }
    if (value === undefined && node !== null) {
      const self = path === ITEM_SELF;
      if (at === null) report(path, path);
      else {
        // A root list (`{{#each .}}`) labels its items by index alone: `..0.name` is not a path
        // the grammar accepts, and the label exists to be pasted into the path fields.
        const here =
          at.path === ITEM_SELF ? String(at.index) : `${at.path}.${at.index}`;
        report(
          self ? here : `${here}.${path}`,
          `${at.path}[]${self ? "" : `.${path}`}`,
        );
      }
    }
    return ABSENT_MARKER;
  });
}

export interface RenderOptions {
  // The clip the rendered text will meet, which a block has to render UNDER. The runtime passes its
  // own; the preview takes the default, which is the same number, so the two agree.
  maxChars?: number;
}

export function renderResponseTemplate(
  tpl: ResponseTemplate,
  body: unknown,
  opts: RenderOptions = {},
): RenderedResponse {
  const budget = opts.maxChars ?? MODEL_RESPONSE_CHAR_LIMIT;
  const missing: string[] = [];
  const seen = new Set<string>();
  const report = (label: string, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    missing.push(label);
  };
  const parsed = parseTemplate(tpl.template);
  // Unreachable for a stored template, for the reason `renderTokens` gives, and degraded the same
  // way: the whole text renders as one segment, markers left as the operator typed them.
  const segments: TemplateSegment[] =
    parsed.problem === null
      ? parsed.segments
      : [{ kind: "text", text: tpl.template }];
  let text = "";
  for (const seg of segments) {
    if (seg.kind === "text") {
      text += renderTokens(seg.text, body, null, report);
      continue;
    }
    const node = resolveTemplatePath(body, seg.path);
    // A standalone `{{/each}}` took its line ending with it, and every item puts one back. A
    // MARKER standing in for the items does not, so the block owes that ending to whatever follows
    // (else `(none)Done`); an inline block owes nothing.
    const eol = seg.body.endsWith("\r\n")
      ? "\r\n"
      : seg.body.endsWith("\n")
        ? "\n"
        : "";
    // Same three-way rule as a scalar token: `null` is the API answering with nothing (right path,
    // not reported); anything that is not a list is the template promising one the response does
    // not carry (reported); and an empty list is an answer of its own.
    if (node === null) {
      text += ABSENT_MARKER + eol;
      continue;
    }
    if (!Array.isArray(node)) {
      report(seg.path, seg.path);
      text += ABSENT_MARKER + eol;
      continue;
    }
    if (node.length === 0) {
      text += EMPTY_LIST_MARKER + eol;
      continue;
    }
    // Item by item, each appended only if it fits under the budget WITH the count of what would
    // follow it, so the count is never what the clip removes. A miss inside an item is reported
    // only once the item is kept: naming a field absent from a row the model never saw sends the
    // operator to fix a line that did not render.
    let index = 0;
    for (; index < node.length && index < MAX_EACH_ITEMS; index++) {
      const pending: [string, string][] = [];
      const piece = renderTokens(
        seg.body,
        node[index],
        { path: seg.path, index },
        (label, key) => {
          pending.push([label, key]);
        },
      );
      const after = node.length - index - 1;
      // The count AND the line ending it carries, or a standalone block lands one character
      // past the budget on exactly the row length that fills it.
      const reserve =
        after > 0 ? moreItemsMarker(after).length + eol.length : 0;
      if (text.length + piece.length + reserve > budget) break;
      text += piece;
      for (const [label, key] of pending) report(label, key);
    }
    if (index < node.length) text += moreItemsMarker(node.length - index) + eol;
  }
  return { text, missing };
}
