/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

// A layout rule that only exists at paint time. happy-dom computes no layout, so what is checked is
// the CLASS the modal hands the preview column. The column carries `self-start` (so `sticky` has
// something to travel within), which removes the stretch that gave it height, so it needs a
// DEFINITE height: a `max-h-` ceiling alone leaves the box at `min-h-96` with the PDF in 384px.

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
// two files cannot drift apart into a tall empty frame around a small PDF. Rendered, not read off
// the source: a scan from `indexOf("<iframe")` lands on the module comment above the component and
// sweeps up the Skeleton's own `h-full`.
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
