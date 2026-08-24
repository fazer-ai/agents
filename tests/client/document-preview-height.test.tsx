/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

// A layout rule that only exists at paint time. happy-dom computes no layout, so what is checked is
// the CLASS the modal hands the preview column — which is where the bug was, and is the thing that
// can silently regress.
//
// What broke: the preview column carries `self-start` (without it `sticky` has nothing to travel
// within), and `self-start` removes the stretch that was giving the column its height. With only a
// `max-h-` ceiling left, the box sat at `min-h-96` and the PDF rendered into 384px of a modal twice
// that tall. The fix is a DEFINITE height, and this is the check that it does not quietly go back to
// a ceiling the next time someone tunes the number.

const MODAL = new URL(
  "../../src/client/pages/resources/documents/DocumentTemplateModal.tsx",
  import.meta.url,
).pathname;
async function classNamesOfPreview(): Promise<string> {
  const src = await Bun.file(MODAL).text();
  const match = src.match(/<DocumentPreview[\s\S]*?className="([^"]*)"/);
  if (!match?.[1]) throw new Error("DocumentPreview className not found");
  return match[1];
}

describe("the template modal's preview column", () => {
  test("is given a definite height, not a ceiling", async () => {
    const classes = await classNamesOfPreview();
    expect(classes).toMatch(/(^|\s)lg:h-\[/);
    // The ceiling is the regression: it looks equivalent and is not, because `self-start` means
    // nothing else sets the height.
    expect(classes).not.toMatch(/(^|\s)lg:max-h-\[/);
  });

  // The two halves have to travel together: dropping `self-start` un-sticks the panel, and the
  // definite height above is what makes the sticky worth having.
  test("still opts out of the grid stretch so the sticky works", async () => {
    expect(await classNamesOfPreview()).toContain("lg:self-start");
  });
});

// The height above only reaches the document because the iframe fills the box it is given, so the
// two files cannot drift apart into a tall empty frame around a small PDF.
//
// Rendered rather than read off the source, and that is not a preference: the first version of this
// scanned from `indexOf("<iframe")`, which lands on the module comment ABOVE the component (it says
// "in an <iframe> fed by a blob URL"), so the slice swept up the loading Skeleton's own `h-full` and
// the check passed with the iframe stripped bare. The class attribute is on the element either way.
describe("the preview iframe", () => {
  test("fills the box it is given", async () => {
    const { DocumentPreview } = await import(
      "@/client/pages/resources/documents/DocumentPreview"
    );
    const { container } = render(
      <DocumentPreview
        state={{ url: "about:blank", loading: false, error: null }}
      />,
    );
    const iframe = container.querySelector("iframe");
    // Reduced to a string before the expect: a failing expectation holding a happy-dom node
    // serializes a cyclic tree and stalls the runner.
    const classes = iframe?.getAttribute("class") ?? "";
    expect(classes.split(/\s+/)).toContain("h-full");
    cleanup();
  });
});
