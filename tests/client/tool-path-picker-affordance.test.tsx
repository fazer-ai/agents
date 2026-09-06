/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
  const sample = controlFor<HTMLTextAreaElement>(
    /resposta de exemplo|sample response/i,
  );
  fireEvent.change(sample, { target: { value: SAMPLE } });
}

// Every control that offers one of the sample's paths, whatever the widget calls itself.
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

  // The filter box has to belong to the OFFER, not merely be on screen: this modal is full of empty
  // text inputs, and any of them would satisfy a document-wide search while typing into it narrows
  // nothing. Scoped to the smallest subtree holding every option, which is the offer itself whatever
  // it is built from.
  const options = Array.from(
    document.querySelectorAll("li button, [role='option'], [role='menuitem']"),
  ).filter((el) => (el.textContent ?? "").trim().startsWith("data."));
  // Walk out from an option until a container also holds a text input. That container IS "the offer
  // owning a filter", and the walk is safe to run to the end because the offer is portalled: it
  // never reaches the form, so finding nothing means there is nothing rather than meaning the search
  // wandered into the page. Stopping at the smallest container of all the options would be too
  // tight — the filter sits BESIDE the list, not inside it.
  let offer: Element | null = options[0] ?? null;
  let filter: HTMLInputElement | null = null;
  while (offer && offer !== document.body) {
    filter = offer.querySelector<HTMLInputElement>(
      "input[type='text'], input[type='search'], input:not([type])",
    );
    if (filter) break;
    offer = offer.parentElement;
  }
  if (!filter) throw new Error("the offer has no filter box of its own");
  fireEvent.change(filter, { target: { value: "customer" } });

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
  const sample = await waitFor(() =>
    controlFor<HTMLTextAreaElement>(/resposta de exemplo|sample response/i),
  );
  fireEvent.change(sample, { target: { value: SAMPLE } });

  const template = controlFor<HTMLTextAreaElement>(
    /o que o agente recebe|what the agent receives/i,
  );
  fireEvent.change(template, { target: { value: "antes  depois" } });
  // Between the two words, which is neither end: appending would land at 13, replacing at 0.
  template.setSelectionRange(6, 6);
  template.focus();

  const opener = openerFor(template);
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
    expect(template.value).toBe("antes {{data.appointment.id}} depois"),
  );
  // And the operator is left writing where the token landed, not on the button that opened the
  // offer. This is the half `onCloseAutoFocus` buys: the value above is right either way, because
  // `insertToken` reads the selection before focus moves anywhere.
  await waitFor(() => {
    expect(document.activeElement === template).toBe(true);
    expect(template.selectionStart).toBe(
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
