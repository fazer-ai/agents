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

// THE PICKER IS AN AFFORDANCE OF THE FIELD, NOT A SECTION THAT OPENS UNDER IT (issue #462).
//
// Three costs were reported by an operator using this for the first time, and two of them are
// structural rather than cosmetic, which is what makes them assertable here:
//
//   - opening the offer PUSHES the fields below it down, in the middle of editing. The cause is in
//     the DOM: the list is rendered in the same flow container as the next field, so the browser has
//     no choice. Asserted as that containment, because happy-dom has no layout to measure.
//   - there is no filter. A real API response has dozens of leaves; the one measured for #456 has
//     40+, so the offer is a scroll and the operator reads it rather than searching it.
//
// The third cost (the affordance sitting below a four-row textarea, far from the caret it writes at)
// is about distance on screen and is not assertable without layout; it is covered by where the
// control is mounted, which the template test pins separately.

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

// Same association-following helper as `tool-appointment-declaration-form`: a `FormField` label
// POINTS at its control, and a `group` field has no single control to point at, so both shapes are
// legitimate and neither is a property a test should depend on.
function controlFor<T extends Element>(p: RegExp): T {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    p.test((l.textContent ?? "").trim()),
  ) as HTMLLabelElement | undefined;
  const byFor = label?.htmlFor
    ? (document.getElementById(label.htmlFor) as T | null)
    : null;
  const byGroup =
    byFor ??
    (Array.from(document.querySelectorAll("[role='group']"))
      .find((g) => p.test((g.querySelector("span")?.textContent ?? "").trim()))
      ?.querySelector("input, select, textarea") as T | null);
  if (!byGroup) throw new Error(`no control captioned ${p}`);
  return byGroup;
}

// A sample wide enough that the offer is a list worth filtering, and whose paths share a prefix so
// a filter has something to narrow away.
const SAMPLE = JSON.stringify({
  data: {
    appointment: {
      id: "ap_9",
      starts_at: "2026-09-02T14:00:00-03:00",
      title: "Consulta",
      room: "3",
      notes: "n",
      customer_name: "Ana",
      customer_email: "a@b.c",
    },
  },
});

async function openBookForm() {
  serving();
  render(
    <MemoryRouter>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MemoryRouter>,
  );
  const action = await waitFor(() =>
    controlFor<HTMLSelectElement>(/(books or cancels|marca ou cancela)/i),
  );
  fireEvent.change(action, { target: { value: "book" } });
  writeSample(SAMPLE);
}

// Every control that offers one of the sample's paths, whatever the widget calls itself.
// THE SAMPLE IS A CODEMIRROR NOW (issue #562), so it is written by dispatching into its view rather
// than by firing `change` on a textarea. Found by the accessible name on the contenteditable, which
// is the element CodeMirror gives the `textbox` role to, so this does not depend on how many editors
// the screen holds.
function writeSample(text: string): void {
  const content = Array.from(document.querySelectorAll(".cm-content")).find(
    (el) =>
      /resposta de exemplo|sample response/i.test(
        el.getAttribute("aria-label") ?? "",
      ),
  );
  if (!content) throw new Error("no sample editor on screen");
  const view = EditorView.findFromDOM(
    content.closest(".cm-editor") as HTMLElement,
  ) as EditorView;
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
}

// THE TEMPLATE FIELD IS A CODEMIRROR NOW (issue #563), so its caret is a position in the editor's
// document and its text comes from the view, not from a `.value`. Found by the accessible name on
// the contenteditable, the same way `writeSample` finds the sample's, so this does not depend on
// how many editors the screen holds.
function templateView(): EditorView {
  const content = Array.from(document.querySelectorAll(".cm-content")).find(
    (el) =>
      /o que o agente recebe|what the agent receives/i.test(
        el.getAttribute("aria-label") ?? "",
      ),
  );
  if (!content) throw new Error("no template editor on screen");
  return EditorView.findFromDOM(
    content.closest(".cm-editor") as HTMLElement,
  ) as EditorView;
}

function offeredPaths(): string[] {
  return Array.from(
    document.querySelectorAll("li button, [role='option'], [role='menuitem']"),
  )
    .map((el) => (el.textContent ?? "").trim())
    .filter((text) => text.startsWith("data."))
    .map((text) => text.split(/\s+/)[0] as string);
}

function openerFor(field: Element): HTMLButtonElement {
  // BY DOCUMENT ORDER, not by containment. Today the picker is a SIBLING of its `FormField`, so
  // walking up from the input reaches a scope holding all three pickers at once and no scope holding
  // exactly one — a containment search reports "no opener" against a screen that has three, which is
  // a harness failure wearing the costume of a red test.
  //
  // The pairing is positional and stays positional whatever the widget becomes: the affordance for a
  // field is the first one at or after it and before the next field's own.
  const openers = Array.from(document.querySelectorAll("button")).filter((b) =>
    /(escolher da resposta|pick from the sample|inserir um campo|insert a field)/i.test(
      (b.textContent ?? "").trim(),
    ),
  );
  const after = openers.filter(
    (b) =>
      Boolean(
        field.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
      ) || field.contains(b),
  );
  const own = after[0];
  if (!own)
    throw new Error(
      `no picker affordance at or after this field (found ${openers.length} on screen)`,
    );
  return own as HTMLButtonElement;
}

// The filter box has to belong to the OFFER, not merely be on screen: this modal is full of empty
// text inputs, and any of them would satisfy a document-wide search while typing into it narrows
// nothing.
//
// Walks out from an option until a container also holds a text input. That container IS "the offer
// owning a filter", and the walk is safe to run to the end because the offer is portalled: it never
// reaches the form, so finding nothing means there is nothing rather than meaning the search
// wandered into the page. Stopping at the smallest container of all the options would be too tight —
// the filter sits BESIDE the list, not inside it.
function filterOfTheOffer(): HTMLInputElement {
  const options = Array.from(
    document.querySelectorAll("li button, [role='option'], [role='menuitem']"),
  ).filter((el) => (el.textContent ?? "").trim().startsWith("data."));
  let offer: Element | null = options[0] ?? null;
  while (offer && offer !== document.body) {
    const filter = offer.querySelector<HTMLInputElement>(
      "input[type='text'], input[type='search'], input:not([type])",
    );
    if (filter) return filter;
    offer = offer.parentElement;
  }
  throw new Error("the offer has no filter box of its own");
}

test("opening a path offer does not push the field below it down", async () => {
  await openBookForm();
  const idField = controlFor<HTMLInputElement>(
    /onde está o id|where the id is/i,
  );
  const startField = controlFor<HTMLInputElement>(
    /horário de início|start time/i,
  );

  fireEvent.click(openerFor(idField));
  const anOption = await waitFor(() => {
    const el = Array.from(
      document.querySelectorAll(
        "li button, [role='option'], [role='menuitem']",
      ),
    ).find((x) => (x.textContent ?? "").trim().startsWith("data."));
    if (!el) throw new Error("the offer never appeared");
    return el;
  });

  // The common ancestor of the two fields is the flow the browser reflows: anything the offer adds
  // in there lands ABOVE the next field and moves it. Rendering the offer outside that subtree (a
  // portal, an overlay) is what makes the shift impossible rather than merely small.
  let flow: Element | null = idField;
  while (flow && !flow.contains(startField)) flow = flow.parentElement;
  expect(flow).not.toBeNull();
  expect(flow?.contains(anOption)).toBe(false);
});

test("a path offer can be narrowed by typing", async () => {
  await openBookForm();
  const idField = controlFor<HTMLInputElement>(
    /onde está o id|where the id is/i,
  );
  fireEvent.click(openerFor(idField));
  await waitFor(() => expect(offeredPaths().length).toBeGreaterThan(4));
  const before = offeredPaths().length;

  fireEvent.change(filterOfTheOffer(), { target: { value: "customer" } });

  await waitFor(() => {
    const after = offeredPaths();
    expect(after.length).toBeLessThan(before);
    expect(after.every((p) => p.includes("customer"))).toBe(true);
  });
});

// THE CARET SURVIVES THE OFFER OPENING, which the portal put at risk rather than fixed.
//
// The template's picker inserts AT the cursor, and `insertToken` reads `selectionStart` off the
// textarea at pick time and then refocuses it in a `requestAnimationFrame`. That worked while the
// offer was inline, because clicking a button moves focus without moving a textarea's selection.
// A popover autofocuses its content and, on close, Radix returns focus to the TRIGGER — which lands
// after that frame and takes the caret away from the box being written in. `onCloseAutoFocus` is
// prevented for exactly this, and prevention is invisible until something asserts it.
test("a token is inserted at the caret, not appended", async () => {
  serving();
  render(
    <MemoryRouter>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MemoryRouter>,
  );
  await waitFor(() => templateView());
  writeSample(SAMPLE);

  const view = templateView();
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "antes  depois" },
      // Between the two words, which is neither end: appending would land at 13, replacing at 0.
      selection: { anchor: 6 },
    });
    view.focus();
  });

  const opener = openerFor(view.contentDOM);
  fireEvent.click(opener);
  const leaf = await waitFor(() => {
    const el = Array.from(document.querySelectorAll("li button")).find((x) =>
      (x.textContent ?? "").trim().startsWith("data.appointment.id"),
    );
    if (!el) throw new Error("the id leaf was not offered");
    return el as HTMLButtonElement;
  });
  fireEvent.click(leaf);

  await waitFor(() =>
    expect(templateView().state.doc.toString()).toBe(
      "antes {{data.appointment.id}} depois",
    ),
  );
  // And the operator is left writing where the token landed, not on the button that opened the
  // offer. This is the half `onCloseAutoFocus` buys: the text above is right either way, because
  // the insert reads the view's selection before focus moves anywhere.
  await waitFor(() => {
    const v = templateView();
    expect(v.hasFocus).toBe(true);
    expect(v.state.selection.main.head).toBe(
      "antes {{data.appointment.id}}".length,
    );
  });
});

// THE OFFER HAS TO BE ABOVE THE MODAL IT OPENS IN, and no rendering test can see that: happy-dom
// has no stacking context, so the offer was in the document, positioned correctly, sized correctly
// and invisible — behind the dialog — with every assertion above passing. Found by opening it in a
// browser.
//
// `public/index.css` defines the z scale as TOKENS, and a Tailwind `z-50` is not a step on it: 50 is
// `--z-drawer`, which sits BELOW `--z-modal` (80). This picker only ever opens inside a modal, so a
// numeric class is always wrong here. Read off the source because the property is about paint order
// rather than about behaviour.
test("the offer's z-index comes from the popover token, not a numeric class", async () => {
  const source = await Bun.file(
    new URL(
      "../../src/client/pages/resources/ToolEditModal.tsx",
      import.meta.url,
    ),
  ).text();
  const content = source.slice(source.indexOf("PopoverPrimitive.Content"));
  const className = /className="([^"]*)"/.exec(content)?.[1] ?? "";
  expect(className.includes("z-(--z-popover)")).toBe(true);
  // And no bare numeric z anywhere on it, which is what it carried when it was invisible.
  expect(/\bz-\d+\b/.test(className)).toBe(false);
});

// THE OFFER PORTALS INTO THE DIALOG, NOT INTO THE BODY, and the difference is a scroll that works.
//
// Radix's Dialog installs `react-remove-scroll`, which cancels wheel events whose target sits
// outside its subtree. A popover portalled to `document.body` is outside it, so the list clicked
// fine and would not scroll: `overflow-y: auto` honoured, `scrollTop` movable programmatically, and
// every wheel event arriving already `preventDefault`ed. Reported from the browser, because nothing
// here dispatches a real wheel.
//
// Asserted as the containment that causes it, which is the part this file can see.
test("the offer is portalled inside the dialog, not into the body", async () => {
  await openBookForm();
  const idField = controlFor<HTMLInputElement>(
    /onde está o id|where the id is/i,
  );
  fireEvent.click(openerFor(idField));
  const anOption = await waitFor(() => {
    const el = Array.from(document.querySelectorAll("li button")).find((x) =>
      (x.textContent ?? "").trim().startsWith("data."),
    );
    if (!el) throw new Error("the offer never appeared");
    return el;
  });
  // By the WRAPPER's parent, never by `closest('[role=dialog]')` from the option: Radix's Popover
  // Content is itself `role="dialog"`, so that search matches the popover no matter where it was
  // portalled and reports success against the body-portalled build. Measured: mutating the portal
  // target left the first version of this test green.
  const wrapper = anOption.closest("[data-radix-popper-content-wrapper]");
  expect(Boolean(wrapper)).toBe(true);
  expect(wrapper?.parentElement === document.body).toBe(false);
  // The container it went into is the one holding the field, which is what puts it inside the
  // modal's scroll lock instead of outside it.
  expect(wrapper?.parentElement?.contains(idField)).toBe(true);
  // And still not in the field's own flow container, which is the other half and the reason the
  // offer was portalled in the first place. Both hold at once: the dialog is not that container.
  const startField = controlFor<HTMLInputElement>(
    /horário de início|start time/i,
  );
  let flow: Element | null = idField;
  while (flow && !flow.contains(startField)) flow = flow.parentElement;
  expect(flow?.contains(anOption)).toBe(false);
});

// Round 1 of review, three findings, all of them costs the portal introduced.

// THE FILTER IS PER VISIT, and a pick does not close the popover the way Radix thinks it does.
//
// Every caller closes by setting the controlled `open` prop to false from its own `onPick`, which
// Radix never sees: `onOpenChange` fires for the interactions IT handles (Escape, an outside click,
// the trigger), not for a prop the parent changed. So clearing the query there covers dismissal and
// misses the ordinary path, and the next visit opens onto a list already narrowed by a word the
// operator typed for a different field.
test("the filter does not survive a pick into the next visit", async () => {
  await openBookForm();
  const idField = controlFor<HTMLInputElement>(
    /onde está o id|where the id is/i,
  );
  fireEvent.click(openerFor(idField));
  await waitFor(() => expect(offeredPaths().length).toBeGreaterThan(4));

  const filter = filterOfTheOffer();
  fireEvent.change(filter, { target: { value: "customer" } });
  await waitFor(() =>
    expect(offeredPaths().every((p) => p.includes("customer"))).toBe(true),
  );

  const picked = await waitFor(() => {
    const el = Array.from(document.querySelectorAll("li button")).find((x) =>
      (x.textContent ?? "").trim().startsWith("data.appointment.customer_name"),
    );
    if (!el) throw new Error("the filtered leaf was not offered");
    return el as HTMLButtonElement;
  });
  fireEvent.click(picked);
  await waitFor(() => expect(offeredPaths().length).toBe(0));

  fireEvent.click(openerFor(idField));
  await waitFor(() => {
    const again = offeredPaths();
    expect(again.length).toBeGreaterThan(0);
    // The whole sample again, including the paths that word hides.
    expect(again.some((p) => !p.includes("customer"))).toBe(true);
  });
});

// ESCAPE LEAVES THE OPERATOR SOMEWHERE, and `onCloseAutoFocus` is prevented for the pick.
//
// Preventing it unconditionally covers a case that does not exist here: on Escape nothing refocuses
// the textarea, so the content unmounts under the focused element and focus falls to the document
// body — the keyboard operator's next Tab restarts from the top of the page. The prevention belongs
// to the pick, which restores focus itself; every other way out keeps Radix's return to the trigger.
test("escaping the offer returns focus to the control that opened it", async () => {
  await openBookForm();
  const idField = controlFor<HTMLInputElement>(
    /onde está o id|where the id is/i,
  );
  const opener = openerFor(idField);
  fireEvent.click(opener);
  await waitFor(() => expect(offeredPaths().length).toBeGreaterThan(4));

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(offeredPaths().length).toBe(0));
  expect(document.activeElement === opener).toBe(true);
  expect(document.activeElement === document.body).toBe(false);
});

// THE OFFER IS A DIALOG TO A SCREEN READER, so it has to say which one.
//
// Radix renders the Content as `role="dialog"`. Unnamed, entering it is announced as a bare dialog,
// and this screen opens three of them from three fields that differ only in what they fill. The
// filter's own label names the input, never the dialog around it.
test("the offer carries an accessible name of its own", async () => {
  await openBookForm();
  const idField = controlFor<HTMLInputElement>(
    /onde está o id|where the id is/i,
  );
  fireEvent.click(openerFor(idField));
  const anOption = await waitFor(() => {
    const el = Array.from(document.querySelectorAll("li button")).find((x) =>
      (x.textContent ?? "").trim().startsWith("data."),
    );
    if (!el) throw new Error("the offer never appeared");
    return el;
  });

  // The dialog is the Content itself, which is the popper wrapper's own child, never found by
  // `closest('[role=dialog]')` from the option: the modal around it answers to that too.
  const wrapper = anOption.closest("[data-radix-popper-content-wrapper]");
  const content = wrapper?.querySelector("[role='dialog']");
  if (!content) throw new Error("the offer is not a dialog to begin with");
  const label =
    content.getAttribute("aria-label") ??
    (content.getAttribute("aria-labelledby")
      ? (document.getElementById(
          content.getAttribute("aria-labelledby") as string,
        )?.textContent ?? "")
      : "");
  expect((label ?? "").trim().length).toBeGreaterThan(0);
});

// AND A PICK IS NOT ONE THING EITHER (round 2 of review).
//
// The suppression above belongs to the template, whose `onPick` refocuses the textarea at the caret
// it wrote. The three single-path fields only write a value, so suppressing the return there
// unmounts the focused option with nothing to catch the focus, and it falls to the document body —
// the same defect the round-1 fix was for, moved to the other three sites. The picker cannot tell
// them apart by watching: the caller's focus move happens a frame later, which is why the
// suppression exists at all. So the caller declares it, and this is that declaration's fence.
test("picking a single-path field returns focus to the control that opened it", async () => {
  await openBookForm();
  const idField = controlFor<HTMLInputElement>(
    /onde está o id|where the id is/i,
  );
  const opener = openerFor(idField);
  fireEvent.click(opener);
  const leaf = await waitFor(() => {
    const el = Array.from(document.querySelectorAll("li button")).find((x) =>
      (x.textContent ?? "").trim().startsWith("data.appointment.id"),
    );
    if (!el) throw new Error("the id leaf was not offered");
    return el as HTMLButtonElement;
  });
  fireEvent.click(leaf);

  await waitFor(() => expect(idField.value).toBe("data.appointment.id"));
  await waitFor(() => expect(document.activeElement === opener).toBe(true));
  expect(document.activeElement === document.body).toBe(false);
});
