import { jsonLanguage } from "@codemirror/lang-json";
import type { SyntaxNode, Tree } from "@lezer/common";

// Reading a pasted API response as TEXT, for the sample-response field (issue #562).
//
// Both functions here parse with the editor's own grammar rather than with `JSON.parse`, and each
// has its own reason.
//
// The position, because `JSON.parse`'s message is not an answer. Measured: V8 appends
// `at position 20 (line 3 column 3)` to some of its errors and not to others, JSC (Bun, and Safari)
// appends nothing at all and says only `Expected '}'`, and every one of those sentences is the
// engine's own English that we would have to pattern-match to reuse and could never translate. The
// syntax tree answers in one number, the same way in every engine.
//
// The formatting, because `JSON.stringify(JSON.parse(text), null, 2)` does not return the operator's
// document. It returns what JavaScript made of it, and JavaScript loses things a response cares
// about: `12345678901234567890` comes back `12345678901234567000`, `1.0` comes back `1`, and the
// earlier of two duplicate keys is gone. Formatting is not the moment to decide what a response
// really meant, so the literals below are copied out of the document verbatim and only the
// whitespace between them is ours.

const parser = jsonLanguage.parser;
const INDENT = "  ";

// A place in the document, in the three coordinates the two readers of it want: the offset for a
// selection, the line and column for a sentence.
export interface JsonSpot {
  // A UTF-16 index, which is what a selection in the editor is measured in.
  offset: number;
  line: number;
  // Counted in CHARACTERS, because the only reader of this number is a person counting along a line
  // (round 2 of review). The offset is UTF-16 and an emoji is two of those, so a response carrying
  // one before the break — a name, a message, a status, which a customer-facing API sends all day —
  // named the character after the one it meant, once per astral character. Code points and not
  // grapheme clusters: a ZWJ sequence still counts as its parts, which is a smaller error than the
  // one this fixes and would cost `Intl.Segmenter` to remove.
  column: number;
}

function spotAt(text: string, offset: number): JsonSpot {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return {
    offset,
    line: before.split("\n").length,
    column: [...before.slice(lastBreak + 1)].length + 1,
  };
}

function firstErrorNode(tree: Tree): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter: (node) => {
      if (found) return false;
      if (node.type.isError) {
        found = node.node;
        return false;
      }
      return true;
    },
  });
  return found;
}

// What both readers below agree to ignore around the document: the surrounding whitespace, and with
// it the byte-order mark, which `String.trim` counts as whitespace and `JSON.parse` therefore never
// sees. Normalizing in ONE place is what keeps them from disagreeing — round 1 of review found a BOM
// that the field called readable (the pickers filled) and the formatter refused, which is an enabled
// button that does nothing when pressed.
function bodyOf(text: string): { body: string; lead: number } {
  return { body: text.trim(), lead: text.length - text.trimStart().length };
}

// Where this text stops being JSON, or null when it does not stop.
//
// The coordinates are about the text AS GIVEN, never about the normalized copy: this number is read
// by a person looking at their own document, and a caller that trimmed first would point at line 1
// for a break on line 3 (round 1 of review).
//
// An empty document is a problem at the start, not an absence of one: the caller decides that an
// empty field is simply empty, and never asks.
export function firstJsonProblem(text: string): JsonSpot | null {
  const { body, lead } = bodyOf(text);
  const tree = parser.parse(body);
  const error = firstErrorNode(tree);
  if (error) return spotAt(text, lead + error.from);
  // NOTE: an error NODE is not the only way to be broken. A tree with no error node still has a
  // shape, and two values pasted back to back parse as a first value plus something the grammar has
  // no room for; `JSON.parse` refuses that too, and so does the picker that reads this field. Asking
  // the top node for exactly one child is what covers it, and it covers the empty document in the
  // same breath.
  const top = tree.topNode;
  // NOTE: counted through the cursor and not by name. `JsonText` holds values and nothing else, so
  // every child is one, and asking for the names this file knows about would miss a literal the
  // grammar spells some other way.
  let values = 0;
  for (let c = top.firstChild; c; c = c.nextSibling) values++;
  if (values !== 1) return spotAt(text, lead + valueEndFor(top, body));
  return null;
}

// Where to point when the document holds no value, or more than one. The end of the first value is
// where the surplus begins; an empty document points at its own start.
function valueEndFor(top: SyntaxNode, text: string): number {
  const first = top.firstChild;
  if (!first) return 0;
  const second = first.nextSibling;
  return second ? second.from : Math.min(first.to, text.length);
}

// The same document, re-indented — or null when it does not parse, in which case NOTHING is changed.
// A document that could not be read is not a document to repair: the operator pasted it from
// somewhere and cannot get it back from us.
export function reindentJson(text: string): string | null {
  if (firstJsonProblem(text) !== null) return null;
  const { body } = bodyOf(text);
  const tree = parser.parse(body);
  const top = tree.topNode.firstChild;
  if (!top) return null;
  return render(top, body, 0);
}

function render(node: SyntaxNode, text: string, depth: number): string {
  if (node.name === "Object" || node.name === "Array") {
    const open = node.name === "Object" ? "{" : "[";
    const close = node.name === "Object" ? "}" : "]";
    const items = childValues(node);
    if (items.length === 0) return `${open}${close}`;
    const pad = INDENT.repeat(depth + 1);
    const inner = items
      .map((item) => pad + renderItem(item, text, depth + 1))
      .join(",\n");
    return `${open}\n${inner}\n${INDENT.repeat(depth)}${close}`;
  }
  // NOTE: every leaf is copied out of the document, which is the whole point: a number is whatever
  // the API wrote, not whatever JavaScript would write back.
  return text.slice(node.from, node.to);
}

function renderItem(node: SyntaxNode, text: string, depth: number): string {
  if (node.name !== "Property") return render(node, text, depth);
  const name = node.getChild("PropertyName");
  const value = name?.nextSibling?.nextSibling ?? null;
  if (!name || !value) return text.slice(node.from, node.to);
  return `${text.slice(name.from, name.to)}: ${render(value, text, depth)}`;
}

// The values inside a container: its children minus the punctuation the grammar also hangs there.
function childValues(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === "{" || c.name === "}" || c.name === "[" || c.name === "]") {
      continue;
    }
    if (c.name === "," || c.name === ":") continue;
    out.push(c);
  }
  return out;
}
