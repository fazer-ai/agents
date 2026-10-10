/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider, useModalController } from "@/client/components";
import { DocumentTemplateModal } from "@/client/pages/resources/documents/DocumentTemplateModal";

// A layout rule that only exists at paint time. happy-dom computes no layout, so what is checked is
// the CLASS the open modal gives the preview column. The column carries `self-start` (so `sticky`
// has something to travel within), which removes the stretch that gave it height, so it needs a
// DEFINITE height: a `max-h-` ceiling alone leaves the box at `min-h-96` with the PDF in 384px.

const TEMPLATE = {
  id: "3",
  name: "Orçamento",
  slug: "orcamento",
  description: null,
  numberPrefix: "ORC-",
  enabled: true,
  blocks: [{ id: "corpo", type: "text", text: "Olá." }],
  fields: [],
  style: {
    font: "sans",
    baseFontSize: 10,
    accentColor: "#111827",
    margin: "normal",
    pageSize: "A4",
    locale: "pt-BR",
    currency: "BRL",
    showPageNumbers: false,
  },
};

function OpenModal() {
  const modal = useModalController<{ template: typeof TEMPLATE }>();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open({ template: TEMPLATE });
  }, [modal]);
  return (
    <DocumentTemplateModal
      modal={
        modal as unknown as Parameters<typeof DocumentTemplateModal>[0]["modal"]
      }
      onSaved={() => {}}
    />
  );
}

// The preview column's classes, read while the preview is still loading (its first state).
async function classesOfPreview(): Promise<string[]> {
  const realFetch = globalThis.fetch;
  // The preview request never answers: the column is read in its loading state.
  globalThis.fetch = (() =>
    new Promise<Response>(() => {})) as unknown as typeof fetch;
  try {
    render(
      <MemoryRouter>
        <ToastProvider>
          <OpenModal />
        </ToastProvider>
      </MemoryRouter>,
    );
    const dialog = await screen.findByRole("dialog");
    const column = within(dialog)
      .getAllByRole("status")
      .find((el) => el.textContent?.includes("Loading"));
    return (column?.getAttribute("class") ?? "").split(/\s+/);
  } finally {
    cleanup();
    globalThis.fetch = realFetch;
  }
}

describe("the template modal's preview column", () => {
  test("is given a definite height, not a ceiling", async () => {
    const classes = await classesOfPreview();
    expect(classes.some((c) => c.startsWith("lg:h-["))).toBe(true);
    // The ceiling is the regression: it looks equivalent and is not, because `self-start` means
    // nothing else sets the height.
    expect(classes.some((c) => c.startsWith("lg:max-h-["))).toBe(false);
  });

  // The two halves have to travel together: dropping `self-start` un-sticks the panel, and the
  // definite height above is what makes the sticky worth having.
  test("still opts out of the grid stretch so the sticky works", async () => {
    const classes = await classesOfPreview();
    expect(classes).toContain("lg:self-start");
    expect(classes).toContain("lg:sticky");
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
