import { describe, expect, test } from "bun:test";

// IOS Safari zooms on focus into a field under 16px, and the density
// scale sets form text at 13-15px. The guard is a rule in public/index.css that
// only iOS WebKit matches; it only works while it stays OUTSIDE any `@layer`,
// since an unlayered rule is what outranks Tailwind's `@layer utilities`.
const css = await Bun.file("public/index.css").text();

describe("iOS input zoom guard", () => {
  const start = css.indexOf("@supports (-webkit-touch-callout: none)");

  test("the rule exists and sets fields to 16px", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf("}\n}", start));
    expect(block).toMatch(
      /input,\s*select,\s*textarea,\s*\[data-field-backdrop\]\s*\{\s*font-size:\s*16px/,
    );
  });

  // The highlighted template field draws its text on a backdrop behind a transparent control. Sized
  // apart, the two layers wrap at different points and the caret leaves the visible text.
  test("the highlighted field's backdrop is sized with the control it mirrors", async () => {
    const field = await Bun.file(
      "src/client/components/HighlightedTemplateField.tsx",
    ).text();
    expect(field).toContain('data-field-backdrop=""');
  });

  test("the rule is not inside a cascade layer", () => {
    let depth = 0;
    let layered = false;
    const opens: boolean[] = [];
    for (let i = 0; i < start; i += 1) {
      if (css[i] === "{") {
        const head = css.slice(css.lastIndexOf("\n", i) + 1, i);
        opens.push(head.trimStart().startsWith("@layer"));
        depth += 1;
      } else if (css[i] === "}") {
        opens.pop();
        depth -= 1;
      }
    }
    layered = opens.some(Boolean);
    expect(depth).toBe(0);
    expect(layered).toBe(false);
  });
});
