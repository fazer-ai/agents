/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { HighlightedTemplateField } from "@/client/components/HighlightedTemplateField";

// The field is a transparent <textarea> over a backdrop that re-renders the same text with tokens
// colored: the caret is the textarea's geometry, the glyphs the backdrop's, and they agree only
// while both break lines at the same column. A scrollbar that takes layout space (Windows, Linux,
// macOS set to always show them) narrows the textarea but not the `overflow: hidden` backdrop, so
// wrapping drifts and grows as `mirror()` scrolls. `scrollbar-gutter: stable` reserves the gutter
// on BOTH layers (on one alone it is the same bug flipped). happy-dom has no layout, so this checks
// the reservation; that Tailwind emits the property is only provable in a browser.

// Every class that decides where the text wraps. The component applies them through one shared
// string on purpose, and this list is that intent written where a regression trips over it.
const WRAPPING = [
  "w-full",
  "px-2.5",
  "py-1.5",
  "text-sm",
  "whitespace-pre-wrap",
  "break-words",
  "border",
  "[scrollbar-gutter:stable]",
];

function layers() {
  const { container } = render(
    <HighlightedTemplateField
      value={"a ".repeat(400)}
      onChange={() => {}}
      isKnownToken={() => true}
      patternSource="\\{\\{(\\w+)\\}\\}"
      multiline
      aria-label="prompt"
    />,
  );
  const textarea = container.querySelector("textarea");
  const backdrop = container.querySelector('[aria-hidden="true"]');
  // Reduced to string arrays before any expect: a failing expectation holding a happy-dom node
  // serializes a cyclic tree and stalls the runner.
  const classesOf = (el: Element | null) =>
    (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  return { textarea: classesOf(textarea), backdrop: classesOf(backdrop) };
}

describe("the highlighted template field's two layers", () => {
  test("wrap under the same box, gutter included", () => {
    const { textarea, backdrop } = layers();
    for (const cls of WRAPPING) {
      expect({ cls, on: "textarea", has: textarea.includes(cls) }).toEqual({
        cls,
        on: "textarea",
        has: true,
      });
      expect({ cls, on: "backdrop", has: backdrop.includes(cls) }).toEqual({
        cls,
        on: "backdrop",
        has: true,
      });
    }
    cleanup();
  });

  // Presence is not the rule, agreement is, and the two come apart because `cn` only joins: a
  // second `[scrollbar-gutter:…]` further down a layer's class list leaves the first one in the
  // string, so a check that only asks "is stable there?" stays green while the cascade hands that
  // layer another value and the asymmetry is back. Each layer declares the gutter exactly once.
  test("declare the gutter once, and to the same value", () => {
    const { textarea, backdrop } = layers();
    const gutters = (classes: string[]) =>
      classes.filter((c) => c.startsWith("[scrollbar-gutter:"));
    expect(gutters(textarea)).toEqual(["[scrollbar-gutter:stable]"]);
    expect(gutters(backdrop)).toEqual(["[scrollbar-gutter:stable]"]);
    cleanup();
  });
});
