import { describe, expect, test } from "bun:test";

// The app shell scrolls in exactly ONE place, and the element that does it has to be POSITIONED.
//
// `sr-only` is `position: absolute`, so a screen-reader label anywhere under the shell resolves
// against the nearest positioned ancestor. With the scroller static that ancestor was the initial
// containing block — the document — and a label far down the scrolled content stream landed at that
// document coordinate, stretching `documentElement.scrollHeight` past the viewport. The page then
// had a SECOND scrollbar, the outer one, which scrolled the header and the sidebar out of view.
// The scroller's own `overflow-y: auto` did not clip it either: a scroll container only clips
// absolutely positioned descendants whose containing block is inside it.
//
// Measured on /audit with one row expanded, at 1280x720 (issue #511):
//
//   document.scrollHeight   2529   with `main` static
//   document.scrollHeight    720   with `main` relative   (= the viewport)
//
// THIS FENCE READS THE SOURCE, AND THAT IS A COMPROMISE WORTH NAMING. The defect is a layout fact,
// and the assertion that would catch it directly — `document.scrollHeight === innerHeight` with a
// tall page mounted — cannot be written here: happy-dom computes no layout, `scrollHeight` is a
// stub, and Tailwind's classes reach no stylesheet in this environment, so `getComputedStyle` would
// answer `static` for every element regardless. There is no browser harness in this repo to put it
// in. What this file can still do is refuse the EDIT that reintroduces the bug, and it follows the
// scroller rather than the id or the class order: whichever element in the shell carries the
// page-level scroll must carry a positioning class beside it.
const source = await Bun.file(
  new URL("../../src/client/components/Layout.tsx", import.meta.url),
).text();

const POSITIONED = /\b(relative|absolute|fixed|sticky)\b/;
const PAGE_SCROLL = /\boverflow-(y-)?(auto|scroll)\b/;

// Every `className="..."` literal in the file, JSX attribute or not.
function classLists(src: string): string[] {
  return [...src.matchAll(/className="([^"]*)"/g)].map((m) => m[1] ?? "");
}

describe("the app shell contains its own scrolling", () => {
  test("the element that scrolls the page is positioned", () => {
    const scrollers = classLists(source).filter((c) => PAGE_SCROLL.test(c));
    // If this is 0 the shell stopped scrolling where this file thinks it does, and the fence is
    // measuring nothing — which is the failure mode a green sweep hides.
    expect(scrollers.length).toBeGreaterThan(0);
    for (const cls of scrollers) {
      expect(cls).toMatch(POSITIONED);
    }
  });

  // The other half of the shape, and the reason the bug is invisible until something escapes: the
  // shell is pinned to the viewport, so anything that outgrows it can only show up as a second
  // scrollbar rather than as a longer page.
  test("the shell is pinned to the viewport and hides its own overflow", () => {
    // NOT `\bh-dvh\b`: a hyphen is a word boundary, so that pattern also matches `min-h-dvh` —
    // which sets a FLOOR rather than a height and lets the shell grow past the viewport, the very
    // thing this asserts it does not do. The mutation survived the first spelling of this line.
    const shell = classLists(source).find((c) =>
      /(?<![\w-])h-dvh(?![\w-])/.test(c),
    );
    expect(shell).toBeDefined();
    expect(shell).toMatch(/\boverflow-hidden\b/);
  });
});
