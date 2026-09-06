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

// Round 1 of review, and both findings are the same root: two readers of one field disagreeing
// about which string they are talking about.

// THE LINE IT NAMES IS THE LINE ON SCREEN. The field trimmed before asking, so a paste with blank
// lines above it was measured against a string the operator is not looking at.
test("the reported line counts from the document as pasted", async () => {
  await openEditor();
  writeSample('\n\n  {"a": }');
  await waitFor(() => {
    expect(document.body.textContent).toMatch(
      /line 3, column 9|linha 3, coluna 9/i,
    );
  });
});

// AN ENABLED BUTTON THAT DOES NOTHING is the silent refusal this whole feature exists to remove.
// A paste that opens with a byte-order mark READS — `String.trim` counts U+FEFF as whitespace, so
// `JSON.parse` gets a clean document and the pickers fill — and the formatter refused it, so Format
// stood enabled and the click went nowhere.
test("format enabled means format does something", async () => {
  await openEditor();
  writeSample('﻿{"data":{"id":"ap_1"}}');
  await waitFor(() => expect(formatButton().disabled).toBe(false));
  const before = sampleView().state.doc.toString();
  fireEvent.click(formatButton());
  await waitFor(() =>
    expect(sampleView().state.doc.toString()).not.toBe(before),
  );
  expect(sampleView().state.doc.toString()).toBe(`{
  "data": {
    "id": "ap_1"
  }
}`);
});

// And the other half of the same rule: once the sample IS formatted, the button has nothing left to
// do, and saying so is better than a click that changes nothing.
test("format is spent once the sample is already formatted", async () => {
  await openEditor();
  writeSample('{"a":1}');
  await waitFor(() => expect(formatButton().disabled).toBe(false));
  fireEvent.click(formatButton());
  await waitFor(() => expect(formatButton().disabled).toBe(true));
});

// AND THE OTHER DOOR INTO THIS FIELD LANDS READABLE TOO.
//
// "Send a test request" writes the RAW response body here, and an API answers minified. Landing on
// one unreadable line and asking the operator to press Format is a step with exactly one right
// answer, so it is not a step. Safe for the same reason Format is safe at all: the formatter copies
// every literal out verbatim, which this drives with an id no JavaScript number can hold.
test("a response from the test request arrives formatted", async () => {
  const raw =
    '{"data":{"id":12345678901234567890,"tags":["a","b"]},"status":"ok"}';
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i.toString();
    if (url.includes("/tools/test"))
      return new Response(
        JSON.stringify({
          result: {
            raw,
            status: 200,
            rawClipped: false,
            notes: [],
            ok: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
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
  render(
    <MemoryRouter>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MemoryRouter>,
  );
  await waitFor(() => sampleView());

  const url = document.querySelector<HTMLInputElement>(
    'input[placeholder^="https://api.example.com"]',
  );
  if (!url) throw new Error("no URL template field");
  fireEvent.change(url, { target: { value: "https://api.example.com/x" } });

  const open = Array.from(document.querySelectorAll("button")).find((b) =>
    /requisição de teste|test request/i.test(b.textContent ?? ""),
  ) as HTMLButtonElement;
  await waitFor(() => expect(open.disabled).toBe(false));
  fireEvent.click(open);

  const send = await waitFor(() => {
    const b = Array.from(document.querySelectorAll("button")).find((el) =>
      /^(enviar requisição|send request)$/i.test((el.textContent ?? "").trim()),
    );
    if (!b) throw new Error("the test dialog never opened");
    return b as HTMLButtonElement;
  });
  fireEvent.click(send);

  await waitFor(() =>
    expect(sampleView().state.doc.toString()).toBe(`{
  "data": {
    "id": 12345678901234567890,
    "tags": [
      "a",
      "b"
    ]
  },
  "status": "ok"
}`),
  );
});

// A BODY THE MODEL READS VERBATIM IS KEPT VERBATIM (round 5 of review).
//
// `templatePreviewFor` shows a non-2xx sample RAW, clipped exactly the way the runtime clips it,
// because that is what the model gets: the file already refuses to trim it for that reason, since
// dropping leading whitespace slides the 4000-character window and shows tail content the model
// would never reach. Reformatting the same body does more than slide the window — the preview would
// show a document the API never sent. So while a status says the body goes verbatim, this field
// neither formats on arrival nor offers to.
test("a non-2xx response is kept exactly as the API sent it", async () => {
  const raw = '{"error":{"code":"not_found","message":"no such id"}}';
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i.toString();
    if (url.includes("/tools/test"))
      return new Response(
        JSON.stringify({
          result: { raw, status: 404, rawClipped: false, notes: [], ok: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
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
  render(
    <MemoryRouter>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MemoryRouter>,
  );
  await waitFor(() => sampleView());

  const url = document.querySelector<HTMLInputElement>(
    'input[placeholder^="https://api.example.com"]',
  );
  if (!url) throw new Error("no URL template field");
  fireEvent.change(url, { target: { value: "https://api.example.com/x" } });
  const open = Array.from(document.querySelectorAll("button")).find((b) =>
    /requisição de teste|test request/i.test(b.textContent ?? ""),
  ) as HTMLButtonElement;
  await waitFor(() => expect(open.disabled).toBe(false));
  fireEvent.click(open);
  const send = await waitFor(() => {
    const b = Array.from(document.querySelectorAll("button")).find((el) =>
      /^(enviar requisição|send request)$/i.test((el.textContent ?? "").trim()),
    );
    if (!b) throw new Error("the test dialog never opened");
    return b as HTMLButtonElement;
  });
  fireEvent.click(send);

  // Exactly as it arrived: one line, not expanded.
  await waitFor(() => expect(sampleView().state.doc.toString()).toBe(raw));
  // And the button does not offer to change it, because changing it would change the preview —
  // with a sentence saying so, since a disabled button and no reason is the silent refusal this
  // field exists to remove.
  expect(formatButton().disabled).toBe(true);
  expect(document.body.textContent).toMatch(/404/);
  expect(document.body.textContent).toMatch(
    /exatamente como a API|exactly as the API sent it/i,
  );
});
