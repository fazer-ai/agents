import { describe, expect, test } from "bun:test";
import { parseInline, parseSimpleMarkdown } from "@/modules/documents/markdown";

// The mapper is a CLOSED set, and this table is what proves it stays closed. Every row is either a
// construct we render or a construct we deliberately do not — and the second kind matters more,
// because anything the parser half-understands ends up in a document the customer keeps.

const plain = (text: string) => [{ text }];

describe("parseInline", () => {
  test("marks bold and italic, in both spellings", () => {
    expect(parseInline("a **b** c")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c" },
    ]);
    expect(parseInline("_it_")).toEqual([{ text: "it", italic: true }]);
    expect(parseInline("*it*")).toEqual([{ text: "it", italic: true }]);
  });

  test("nests bold inside italic", () => {
    expect(parseInline("_a **b** c_")).toEqual([
      { text: "a ", italic: true },
      { text: "b", italic: true, bold: true },
      { text: " c", italic: true },
    ]);
  });

  // Without the closer lookahead, the asterisk in an arithmetic line turns the rest of it italic and
  // an underscore in a file name eats everything after it. Both appear in real quote text.
  test("leaves an unmatched marker literal", () => {
    expect(parseInline("3 * 4 = 12")).toEqual(plain("3 * 4 = 12"));
    expect(parseInline("nota_final")).toEqual(plain("nota_final"));
    expect(parseInline("preço: R$ 10 *")).toEqual(plain("preço: R$ 10 *"));
  });

  // An italic is closed by the token that OPENED it, and by nothing else. A shared boolean let
  // either token close the other's span: `_3 * 4_` rendered as an italic "3 " followed by a literal
  // " 4_", so a stray asterisk inside an emphasised sentence rewrote what the customer reads.
  test("an italic is closed only by its own delimiter", () => {
    expect(parseInline("_3 * 4_")).toEqual([{ text: "3 * 4", italic: true }]);
    expect(parseInline("*a_b*")).toEqual([{ text: "a_b", italic: true }]);
    // And the pair still closes normally when nothing gets in the way.
    expect(parseInline("_x_ e *y*")).toEqual([
      { text: "x", italic: true },
      { text: " e " },
      { text: "y", italic: true },
    ]);
  });

  // Nesting one emphasis inside another has no representation — a span is bold, italic, or both —
  // so the inner markers print. The alternative is guessing which delimiter the operator meant to
  // close, and a wrong guess changes the sentence rather than its styling.
  test("an inner italic marker prints instead of nesting", () => {
    expect(parseInline("_a *b* c_")).toEqual([
      { text: "a *b* c", italic: true },
    ]);
    // Bold is a separate flag, so it still nests inside an italic.
    expect(parseInline("_a **b** c_")).toEqual([
      { text: "a ", italic: true },
      { text: "b", bold: true, italic: true },
      { text: " c", italic: true },
    ]);
  });

  // The escape covers ONE character, so a literal ** is written as two escapes. `\**` is the
  // ambiguous middle: it produces a literal asterisk followed by a live italic marker, which is what
  // a one-character escape has to mean and is worth pinning so a future "smarter" escape is a
  // deliberate change rather than a silent one.
  test("a backslash escapes one marker character", () => {
    expect(parseInline("2 \\* 3")).toEqual(plain("2 * 3"));
    expect(parseInline("\\*\\*x\\*\\*")).toEqual(plain("**x**"));
    expect(parseInline("\\**x\\**")).toEqual([
      { text: "*" },
      { text: "x*", italic: true },
    ]);
  });

  // Everything the closed set does not cover has to arrive as its own text. A parser that half-reads
  // a link or a table produces layout nobody authored.
  test("passes hostile and unsupported markdown through as text", () => {
    for (const input of [
      "<script>alert(1)</script>",
      "<b>not html</b>",
      "| a | b |\n|---|---|",
      "[link](https://example.com)",
      "![img](https://example.com/x.png)",
      "> quote",
      "# heading",
      "`code`",
    ]) {
      const lines = parseSimpleMarkdown(input);
      const rendered = lines
        .map((l) => l.spans.map((s) => s.text).join(""))
        .join("\n");
      expect(rendered).toBe(input);
      expect(
        lines.every((l) => l.spans.every((s) => !s.bold && !s.italic)),
      ).toBe(true);
    }
  });

  test("is total: never throws, on any of the hostile inputs above", () => {
    for (const input of ["***", "____", "*", "\\", "**a", "_a**b_"]) {
      expect(() => parseInline(input)).not.toThrow();
    }
  });
});

describe("parseSimpleMarkdown", () => {
  test("reads a bullet from any of the three markers", () => {
    const lines = parseSimpleMarkdown("- a\n* b\n• c");
    expect(lines.map((l) => l.kind)).toEqual(["bullet", "bullet", "bullet"]);
    expect(lines.map((l) => l.spans[0]?.text)).toEqual(["a", "b", "c"]);
  });

  // The lone "*" of a bullet must not open an italic run: the marker is consumed as the bullet.
  test("a bullet marker is not an italic marker", () => {
    const [line] = parseSimpleMarkdown("* item *destacado*");
    expect(line?.kind).toBe("bullet");
    expect(line?.spans).toEqual([
      { text: "item " },
      { text: "destacado", italic: true },
    ]);
  });

  test("keeps a blank line as a line of its own", () => {
    const lines = parseSimpleMarkdown("a\n\nb");
    expect(lines).toHaveLength(3);
    expect(lines[1]?.spans).toEqual([]);
  });
});
