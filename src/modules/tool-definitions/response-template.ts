// What an operator-authored HTTP tool says its response should LOOK LIKE by the time it reaches the
// model, and how that is rendered off a response body. Pure: no I/O, no clock.
//
// WHY THIS EXISTS. Without it the model gets the provider's raw body, clipped at maxResponseChars.
// Measured against a public CNPJ lookup (#456): a 7,982-char response whose first 2.3k are five
// third parties' names and masked tax ids, and whose registration status sits at char 7,806 — past
// the cut. The agent then answered with a status that was not in the tool result at all, twice. A
// truncated payload does not read to a model as missing data; it reads as a gap to fill from
// training data. So the fix is not a bigger clip, it is letting the tool say which nine fields it
// wanted and handing over only those.
//
// WHY A TEMPLATE AND NOT A FIELD MAP. A map answers "which fields", and the operator still has to
// hope the model reads the resulting JSON the way they meant. A markdown block answers "which
// fields, under which names, in which order", which is the same thing the n8n formatting node this
// replaces was doing. It costs one concept: a token is a path into the response.
//
// THE TOKENS HERE ARE NOT THE TOKENS IN `graph/tools/http.ts`. That module's PLACEHOLDER is the
// REQUEST-side vocabulary — `{{contact_name}}`, `{{secret}}`, the AI-filled fields — and its grammar
// has no dots. This one addresses the RESPONSE and nothing else: no context, no credential, no model
// input. `{{secret}}` in a response template is looked up in the response body like any other path,
// finds nothing, and renders as absent. Sharing one pattern between the two would have made that
// sentence untrue, which is the same reason `documents/tokens.ts` does not share the prompt's.

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

// A LIST OF UNKNOWN LENGTH (#459). One token addresses one value, so a tool whose response is N
// rows could not be projected at all and kept the raw clip, with the invention risk this module
// exists to remove, on exactly the tools operators write most: a product search, a slot lookup, an
// order history. A block repeats its content once per item of the list its path names:
//
//   {{#each resultados}}
//   - {{nome}} — R$ {{preco}}
//   {{/each}}
//
// Inside it a path is RELATIVE to the item, and `{{.}}` is the item itself, the one thing a list
// of strings has to address. The same spelling names the body outside a block (`{{#each .}}` walks
// a response that IS the list), so "a path is relative to the current scope, and `.` is the scope"
// stays one sentence. Blocks do not nest, deliberately: the second level is where "relative to
// which item" stops being one sentence, and no tool measured so far needed it.
//
// Both markers are well-formed tokens to TOKEN, which is why the block scan runs FIRST and the
// token scan sees only what is left: a `{{/each}}` judged as a path would be refused as malformed,
// and a `{{#each a}}` left to the token render would reach the model as literal text.
const BLOCK = /\{\{\s*(?:#each(?:[ \t]+([^{}]*?))?|(\/each))\s*\}\}/g;

// The current scope, which is the item inside a block and the body outside one.
export const ITEM_SELF = ".";

// How many items a block renders before it COUNTS the rest instead. At the 4,000-char cap, 50 items
// leave 80 characters each (about one line of a search result), and past that the clip below would
// cut mid-item anyway; a count beats a cut. The remainder is never dropped silently: a model reading
// "and 120 more" knows to ask for a narrower query, and one reading a list that simply ends does not.
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
  const atLineEnd = e === template.length || template[e] === "\n";
  if (!atLineStart || !atLineEnd) return [start, end];
  return [s, template[e] === "\n" ? e + 1 : e];
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
      segments.push({
        kind: "each",
        path: open.path,
        body: template.slice(open.bodyStart, start),
      });
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

// A `{{` or a `}}` that is not part of a token, which is a typo the token scan cannot see: `{{a}`
// matches nothing, so it is not an unusable TOKEN, it is not a token at all. Before this, that
// declaration was accepted, stored, and the runtime then put `Name: {{data.name}` in front of the
// model verbatim — the same silent mis-aim as a well-formed path pointing at nothing, which is the
// defect this whole section exists to remove.
//
// The rule is "what is left after the real tokens are gone", because that is the only way to tell
// `{{a}} }}` (a token and a stray) from `{{a}}`. It costs the ability to write a literal `{{` in a
// template, and that is the right trade: this is markdown for a model, and a stray double brace is
// a typo far more often than it is content. Returns the offending fragment, so the message can
// point at it rather than say "somewhere".
export function unmatchedTemplateDelimiter(template: string): string | null {
  const rest = template.replace(TOKEN, "");
  const at = rest.search(/\{\{|\}\}/);
  if (at === -1) return null;
  return rest.slice(at, at + 24);
}

// A value the model may be shown. WIDER than the appointment reader's rule, and the difference is
// the point: `"active": false` is an answer, and rendering it as absent would hand the model a
// blank where the API said no. The empty string is admitted here too and handled by the renderer,
// which needs to tell "the API answered with nothing" from "the API did not answer".
//
// The one refusal kept from the appointment side is the oversized number, for the same reason: past
// 2^53 the digits were already lost by JSON.parse, so String() would show the model an id that the
// operator's system never issued — and a model that reads an id in a tool result passes it to the
// next tool call.
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

export type ResponseTemplateRead =
  // No template here, which is what every tool written before #456 says and what a row carrying
  // something else in `outputSchema` says. The runtime keeps its old behaviour: raw body, clipped.
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

// What a WRITER puts in the column, from what a caller sent. The reader's own shape for a usable
// declaration, and the value untouched for anything that is not one — a legacy JSON Schema is not
// this feature's to rewrite.
//
// `dropUnusable` is the difference between the two kinds of writer, and it is not a style choice.
// The REST/MCP path refuses a broken declaration before reaching here (the operator wrote it and can
// fix it), so nothing unusable ever arrives and the flag is off. The IMPORT path cannot refuse: a
// bundle is a file handed over whole, and failing all of it over one tool's template would be worse
// than importing it — so there the broken declaration is DROPPED, which makes the row say "no
// template" honestly instead of parking unusable text where the editor reads it back as a legacy
// schema and nothing anywhere says why the tool stopped projecting.
// THE PROJECTION ITSELF, and it lives here rather than in `graph/tools/http.ts` because two callers
// have to agree on it: the runtime, and the editor's preview, which is labelled "exactly what the
// agent would receive". They were written as two readers of the same rules, and they drifted twice
// in two review rounds — round 4 taught the runtime that a token-less template needs no body and
// left the preview parsing JSON first; round 3 taught the preview about non-2xx and left it with
// its own copy of the clip. Restating a rule is how a preview stops being one, so there is one
// function and the callers differ only in what they do with `skipped`.
export interface ProjectedResponse {
  // What the model is handed, or null when the template does not apply and the raw body goes.
  text: string | null;
  // Paths the template names that the body does not answer with. Empty when `text` is null.
  missing: string[];
  // Why the template did not apply, when it did not.
  skipped: "no-template" | "not-2xx" | "not-json" | null;
}

export function projectToolResponse(
  outputSchema: unknown,
  status: number,
  rawBody: string,
): ProjectedResponse {
  const tpl = readResponseTemplate(outputSchema);
  if (!tpl) return { text: null, missing: [], skipped: "no-template" };
  // 2xx alone, the same gate `registerDeclaredAppointment` uses and for the same kind of reason: a
  // non-2xx body is the error the model has to read literally, and a template aimed at success
  // fields would render a block of absent markers over it.
  if (status < 200 || status >= 300) {
    return { text: null, missing: [], skipped: "not-2xx" };
  }
  // A template that reads nothing says the same thing whatever the body is, so it must not be
  // gated on the body PARSING: the endpoint that most wants a constant answer is the one returning
  // 204 with nothing in it.
  if (!templateNeedsBody(tpl.template)) {
    return { ...renderResponseTemplate(tpl, undefined), skipped: null };
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { text: null, missing: [], skipped: "not-json" };
  }
  return { ...renderResponseTemplate(tpl, body), skipped: null };
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
        const here = `${at.path}.${at.index}`;
        report(
          self ? here : `${here}.${path}`,
          `${at.path}[]${self ? "" : `.${path}`}`,
        );
      }
    }
    return ABSENT_MARKER;
  });
}

export function renderResponseTemplate(
  tpl: ResponseTemplate,
  body: unknown,
): RenderedResponse {
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
    // Same three-way rule as a scalar token: `null` is the API answering with nothing (right path,
    // not reported); anything that is not a list is the template promising one the response does
    // not carry (reported); and an empty list is an answer of its own.
    if (node === null) {
      text += ABSENT_MARKER;
      continue;
    }
    if (!Array.isArray(node)) {
      report(seg.path, seg.path);
      text += ABSENT_MARKER;
      continue;
    }
    if (node.length === 0) {
      text += EMPTY_LIST_MARKER;
      continue;
    }
    const shown = node.slice(0, MAX_EACH_ITEMS);
    shown.forEach((item, index) => {
      text += renderTokens(seg.body, item, { path: seg.path, index }, report);
    });
    if (node.length > shown.length) {
      text += moreItemsMarker(node.length - shown.length);
    }
  }
  return { text, missing };
}
