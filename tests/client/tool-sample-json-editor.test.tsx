/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter } from "react-router";

// THE SAMPLE RESPONSE IS READ, SO IT IS EDITED IN SOMETHING THAT READS (issue #562).
//
// This field is load-bearing and was a four-row textarea: every path picker on the screen is fed
// from it, the appointment declaration and the response template both point into it, and what goes
// in is a real API response, very often minified onto one line.
//
// The issue that asked for this said invalid JSON "fails silently". Measured before building: it
// does not — `tools.sampleInvalid` has always said the sample could not be read. What was missing is
// WHERE, and that is not free: `JSON.parse`'s message carries a position on V8 for some errors and
// not others, and on JSC (Bun here, Safari for an operator) for none. So the position comes from the
// editor's own grammar, and these tests drive the shapes where the engine would have nothing to say.

const { ToolEditModal } = await import(
  "@/client/pages/resources/ToolEditModal"
);
const { ToastProvider, useModalController } = await import(
  "@/client/components"
);

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function serving() {
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST")
      return new Response(JSON.stringify({ tool: { id: "1", name: "x" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    return new Response(JSON.stringify({ items: [], entries: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function Harness() {
  const modal = useModalController<{ id?: string }>();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open({});
  }, [modal]);
  return <ToolEditModal modal={modal as never} onSaved={() => undefined} />;
}

function sampleView(): EditorView {
  const content = Array.from(document.querySelectorAll(".cm-content")).find(
    (el) =>
      /resposta de exemplo|sample response/i.test(
        el.getAttribute("aria-label") ?? "",
      ),
  );
  if (!content) throw new Error("no sample editor on screen");
  return EditorView.findFromDOM(
    content.closest(".cm-editor") as HTMLElement,
  ) as EditorView;
}

function writeSample(text: string): void {
  const view = sampleView();
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
}

function formatButton(): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll("button")).find((el) =>
    /^(formatar|format)$/i.test((el.textContent ?? "").trim()),
  );
  if (!b) throw new Error("no format button on screen");
  return b as HTMLButtonElement;
}

async function openEditor() {
  serving();
  render(
    <MemoryRouter>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MemoryRouter>,
  );
  await waitFor(() => sampleView());
}

// THE GRAMMAR IS JSON, NOT JAVASCRIPT, and this is the shape that tells them apart: `{a: 1}` is an
// ordinary JavaScript object literal and is not JSON. Reusing the code tool's `javascript()` — which
// was already in the tree, and was the cheap thing to do — would have highlighted this as fine.
test("an unquoted key is reported, at the character where it starts", async () => {
  await openEditor();
  writeSample("{a: 1}");
  await waitFor(() => {
    expect(document.body.textContent).toMatch(
      /line 1, column 2|linha 1, coluna 2/i,
    );
  });
});

// AND THE POSITION IS OURS, not the engine's. For this document `JSON.parse` says only
// `Unexpected token '}', "…" is not valid JSON` on V8 and `Expected '}'` on JSC: neither carries a
// position, so a reader of the message would have nothing to show here.
test("a break the engine cannot locate is still located", async () => {
  await openEditor();
  writeSample('{"a": 1, "b": }');
  await waitFor(() => {
    expect(document.body.textContent).toMatch(
      /line 1, column 15|linha 1, coluna 15/i,
    );
  });
});

test("a readable sample says nothing about being unreadable", async () => {
  await openEditor();
  writeSample('{"data": {"id": "ap_1"}}');
  await waitFor(() => expect(formatButton().disabled).toBe(false));
  expect(document.body.textContent).not.toMatch(
    /is not valid json|não é json válido|line \d+, column \d+/i,
  );
});

test("format expands a minified paste in place", async () => {
  await openEditor();
  writeSample('{"data":{"id":"ap_1","tags":["a","b"]}}');
  await waitFor(() => expect(formatButton().disabled).toBe(false));
  fireEvent.click(formatButton());
  await waitFor(() =>
    expect(sampleView().state.doc.toString()).toBe(
      `{
  "data": {
    "id": "ap_1",
    "tags": [
      "a",
      "b"
    ]
  }
}`,
    ),
  );
});

// FORMATTING MUST NOT CHANGE WHAT THE RESPONSE SAYS, and the obvious implementation does.
// `JSON.stringify(JSON.parse(text), null, 2)` rewrites `12345678901234567890` as
// `12345678901234567000`: an id the operator would then pick from the offer, and read back wrong,
// with nothing on screen having warned them. Driven end to end here because the button is where an
// operator meets it.
test("format keeps an id no JavaScript number can hold", async () => {
  await openEditor();
  writeSample('{"data":{"id":12345678901234567890}}');
  await waitFor(() => expect(formatButton().disabled).toBe(false));
  fireEvent.click(formatButton());
  await waitFor(() =>
    expect(sampleView().state.doc.toString()).toContain("12345678901234567890"),
  );
});

// A REFUSAL THAT LEAVES THE TEXT ALONE. Formatting requires reading, so on a paste that does not
// read there is nothing it could do but drop what it could not understand — and the operator got
// that text from somewhere and cannot get it back from us.
test("format is refused while the sample cannot be read, and the paste is untouched", async () => {
  await openEditor();
  const broken = '{"a": 1, "b": }';
  writeSample(broken);
  await waitFor(() => expect(formatButton().disabled).toBe(true));
  fireEvent.click(formatButton());
  expect(sampleView().state.doc.toString()).toBe(broken);
});
