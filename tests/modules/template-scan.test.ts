import { describe, expect, test } from "bun:test";
import {
  scanTemplate,
  type TemplateSpan,
} from "@/modules/tool-definitions/response-template";

// WHERE EACH PIECE OF THE VOCABULARY SITS, so the editor can draw it.
//
// The response template is markdown plus three spellings of our own, and in a plain textarea all
// four look identical. Drawing them apart needs what `templateTokens` deliberately does not return:
// positions. This is the same two regexes answering the same question with a range attached, in the
// same module, because a second copy of `TOKEN` and `BLOCK` in the client is a second grammar that
// drifts from the renderer's.

function kinds(text: string): string[] {
  return scanTemplate(text).map((s) => `${s.kind}:${text.slice(s.from, s.to)}`);
}

function only(text: string): TemplateSpan {
  const spans = scanTemplate(text);
  expect(spans).toHaveLength(1);
  return spans[0] as TemplateSpan;
}

describe("scanTemplate", () => {
  test("finds nothing in prose", () => {
    expect(scanTemplate("Just a line of markdown, **bold** even.")).toEqual([]);
  });

  test("locates a token and the path it names", () => {
    const s = only("Nome: {{data.nome}}");
    expect(s).toEqual({
      kind: "token",
      from: 6,
      to: 19,
      path: "data.nome",
      usable: true,
    });
  });

  // A TOKEN THE GRAMMAR REFUSES IS STILL A TOKEN, which is the whole reason `TOKEN` is wider than
  // the path rule: `{{data. id}}` has to be recognized before it can be called wrong, or it reaches
  // the model as literal text with nothing on screen saying so.
  test("marks a token whose text is not a path", () => {
    expect(only("{{data. id}}").usable).toBe(false);
    expect(only("{{}}").usable).toBe(false);
  });

  test("reads the scope itself as a usable token", () => {
    expect(only("{{.}}")).toMatchObject({ path: ".", usable: true });
  });

  // THE BLOCK MARKERS ARE NOT TOKENS, and the scan has to agree with `templateTokens`, which strips
  // them before it counts. Judged as a path, `{{/each}}` is malformed and `{{#each a}}` is a token
  // that would render as text.
  test("separates the two block markers from tokens", () => {
    expect(kinds("{{#each results}}\n- {{name}}\n{{/each}}")).toEqual([
      "block-open:{{#each results}}",
      "token:{{name}}",
      "block-close:{{/each}}",
    ]);
  });

  test("marks a block over something that is not a path", () => {
    expect(only("{{#each a b}}")).toMatchObject({
      kind: "block-open",
      usable: false,
    });
    expect(only("{{#each .}}")).toMatchObject({
      kind: "block-open",
      path: ".",
      usable: true,
    });
  });

  // A STRAY BRACE IS THE TYPO THE TOKEN SCAN CANNOT SEE: `{{a}` matches no token at all, so without
  // this it is not drawn as anything and reaches the model verbatim. Same rule as
  // `unmatchedTemplateDelimiter`: what is left once the real tokens are gone.
  test("locates a brace that is part of no token", () => {
    expect(kinds("Nome: {{a}")).toEqual(["stray:{{"]);
    expect(kinds("{{a}} }}")).toEqual(["token:{{a}}", "stray:}}"]);
  });

  // THE SPANS COME BACK IN DOCUMENT ORDER, because the caller draws them onto a document and a
  // decoration set out of order is a runtime error in CodeMirror, not a cosmetic problem.
  test("returns spans in document order", () => {
    const spans = scanTemplate("{{b}} {{#each x}}{{/each}} {{c}} {{");
    const froms = spans.map((s) => s.from);
    expect(froms).toEqual([...froms].sort((a, b) => a - b));
    expect(spans.at(-1)?.kind).toBe("stray");
  });

  // A TOKEN MAY SPAN LINES, because `TOKEN` does and this scan says what the RUNTIME sees: a `{{`
  // left open and a `}}` a line down read as one token, which the renderer refuses. The completion
  // stops at a line break on purpose, an offer narrower than the grammar, not a disagreement with it.
  test("reads a token that spans lines the way the renderer does", () => {
    const doc = "- {{nome}} X{{cliente.no\nFIM}}";
    expect(kinds(doc)).toEqual(["token:{{nome}}", "token:{{cliente.no\nFIM}}"]);
    expect(scanTemplate(doc)[1]?.usable).toBe(false);
  });

  test("keeps a string's braces out of it", () => {
    expect(kinds('`{ "a": 1 }` and {{a}}')).toEqual(["token:{{a}}"]);
  });
});
