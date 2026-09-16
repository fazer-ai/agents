/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { HighlightedTemplateField } from "@/client/components/HighlightedTemplateField";

// The field is a transparent <textarea> over a backdrop that re-renders the same text with the
// tokens colored. The caret and the selection are the textarea's geometry; the glyphs the operator
// sees are the backdrop's. They only agree while both layers break lines at the same column.
//
// They stop agreeing wherever a scrollbar takes layout space: the textarea is a scroll container
// and its scrollbar eats its content box, while the backdrop is `overflow: hidden` and keeps the
// full width. Different width, different wrapping, different scrollHeight — and `mirror()` assigns
// a scrollTop the backdrop clamps, so the drift grows as the prompt is scrolled. Measured on the
// real component in Chromium/Linux before the fix: 612px of content in the textarea against 622px
// in the backdrop, 241.8 against 240.8 lines, one line of drift at the end of a 16k-character
// prompt. Windows and Linux take that space by default, and so does macOS when the system is set to
// always show scroll bars, which is why the first report came from Windows and the team's overlay
// scrollbars showed nothing (#649).
//
// happy-dom computes no layout, so what is checked here is the RESERVATION: `scrollbar-gutter:
// stable` puts the gutter in the box whether or not a scrollbar is showing, which is what keeps the
// two content boxes the same width. It is checked on BOTH layers, because reserving it on one of
// them is the same bug with the sign flipped. That the property actually reaches the CSS is not
// checkable here (Tailwind emits the arbitrary property at build time); the browser measurement in
// the PR is what proves that half.

// Every class that decides where the text wraps. The component applies them through one shared
// string on purpose, and this list is that intent written where a regression trips over it.
const WRAPPING = [
  "w-full",
  "px-3",
  "py-2",
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
