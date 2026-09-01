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
  isUsablePath,
  type SampleLeaf,
  walkPath,
} from "@/modules/tool-definitions/json-path";

// The template becomes model context on EVERY call of the tool, so it is capped like one.
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

export interface ResponseTemplate {
  template: string;
}

// The tokens a template writes, in document order, deduped. Includes malformed ones — the caller
// decides what to do with them, and both callers (the write refusal and the form gate) need to name
// them.
export function templateTokens(template: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(TOKEN)) {
    const raw = (m[1] ?? "").trim();
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function unusableTemplateTokens(template: string): string[] {
  return templateTokens(template).filter((t) => !isUsablePath(t));
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
  const unusable = unusableTemplateTokens(template);
  if (unusable.length > 0) {
    return fail(
      `outputSchema.template has token(s) that are not a path into the response: ${unusable
        .map((t) => `{{${t}}}`)
        .join(
          ", ",
        )}. A path is dot-separated keys with a number for a list position, e.g. data.items.0.name`,
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

export function renderResponseTemplate(
  tpl: ResponseTemplate,
  body: unknown,
): RenderedResponse {
  const missing: string[] = [];
  const seen = new Set<string>();
  const text = tpl.template.replace(TOKEN, (whole, rawToken: string) => {
    const path = (rawToken ?? "").trim();
    // Unreachable for a stored template (the reader refuses one that has such a token) and left
    // literal rather than thrown on, so a template reaching here by some other road degrades into
    // the text the operator typed instead of failing a tool call that already succeeded.
    if (!isUsablePath(path)) return whole;
    const node = walkPath(body, path);
    const value = renderScalar(node);
    if (value !== undefined && value !== "") {
      return value.length > MAX_VALUE_CHARS
        ? `${clipText(value, MAX_VALUE_CHARS)}…[truncated]`
        : value;
    }
    if (value === undefined && node !== null && !seen.has(path)) {
      seen.add(path);
      missing.push(path);
    }
    return ABSENT_MARKER;
  });
  return { text, missing };
}
