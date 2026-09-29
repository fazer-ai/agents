import { describe, expect, test } from "bun:test";

// The app shell scrolls in exactly ONE place, and the element that does it has to be POSITIONED.
// `sr-only` is `position: absolute`, so with a static scroller a screen-reader label deep in the
// content resolves against the document, stretches `documentElement.scrollHeight` past the viewport
// and adds an outer scrollbar that scrolls the header away; `overflow-y: auto` does not clip it.
//
// Read from the source because happy-dom computes no layout and Tailwind reaches no stylesheet here,
// so a layout assertion cannot be written: whichever shell element carries the page-level scroll must
// carry a positioning class beside it.
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
    // Not `\bh-dvh\b`: a hyphen is a word boundary, so that also matches `min-h-dvh`, which sets
    // a FLOOR rather than a height and lets the shell grow past the viewport.
    const shell = classLists(source).find((c) =>
      /(?<![\w-])h-dvh(?![\w-])/.test(c),
    );
    expect(shell).toBeDefined();
    expect(shell).toMatch(/\boverflow-hidden\b/);
  });
});
