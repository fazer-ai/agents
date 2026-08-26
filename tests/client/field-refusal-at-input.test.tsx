/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// THE REFUSAL THAT LANDS ON THE INPUT IT IS ABOUT, AND THE ONE THAT CANNOT.
//
// #231 put the refused field on the wire: `{ error, field }`, where `field` is the server's own name
// for the value it refused and reads the same in every language. Measured before this change, the
// console read it in ZERO of the thirteen places that already destructure that body — the sentence
// went to a toast, and the operator of a six-input form still had to work out which input to fix.
//
// A toast is also the wrong container for it twice over: it is far from the control, and it scrolls
// away carrying the only copy of the reason.
//
// The rule this file holds is not "always render at the input" — it is that the two channels are
// EXCLUSIVE and one of them always fires. A refusal about an input this form renders goes to that
// input and the toast stays silent; a refusal about anything else (a field on another screen, a
// refusal about no input at all, a transport failure with no server behind it) goes to the toast.
// Silence is the one outcome that must never happen, and showing it twice is its own kind of noise.

const { CompanyProfileCard } = await import(
  "@/client/pages/resources/documents/CompanyProfileCard"
);
const { ToastProvider } = await import("@/client/components");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");

const realFetch = globalThis.fetch;

const COMPANY = {
  name: "ACME Ltda",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: null,
  logoVersion: 0,
};

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// The body an AppError answers with since #231: the localized sentence, and the field it is about
// when the refusal is about one. `field` is absent — not null — whenever it is not.
function refusingPut(body: { error: string; field?: string }) {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "PUT") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(body), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function mountCompany() {
  return render(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard
            company={COMPANY as never}
            onChanged={() => undefined}
            session={1}
          />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );
}

// The six inputs are rendered in `COMPANY_FIELDS` order, which is the order the card maps over.
const ORDER = ["name", "document", "address", "phone", "email", "website"];

function inputFor(field: string): HTMLInputElement {
  return screen.getAllByRole("textbox")[
    ORDER.indexOf(field)
  ] as HTMLInputElement;
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));
}

// Reduced to a COUNT before it leaves this function, never a node: an expectation that fails while
// holding a happy-dom element serializes a cyclic tree and hangs the runner.
function shownInsideFieldOf(field: string, message: string): number {
  const control = inputFor(field);
  const box = control.closest("label") ?? control.parentElement;
  return Array.from(box?.querySelectorAll("*") ?? []).filter(
    (el) => el.textContent === message && el.children.length === 0,
  ).length;
}

function shownAnywhere(message: string): number {
  return screen.queryAllByText(message).length;
}

// How many toasts are on screen, whatever they say. Counting the reason's occurrences is not the
// same question: a toast raised with the GENERIC sentence beside a message already on the control is
// still the duplicate this rule bars, and it shares no text with the one at the input.
//
// Radix renders each toast as an `<li>` in its viewport, and this card renders no list of its own.
function toastCount(): number {
  return document.querySelectorAll("li[data-state]").length;
}

test("a refusal that names an input this form renders lands on that input, once", async () => {
  // Worded the way `updateCompanySettings` words it (tenant-settings/service.ts): the sentence names
  // the character, and `field` names the patch key — which is the same string this form uses for the
  // input, because the console's company form is what that name was chosen for.
  const reason =
    'document contains a character the document fonts cannot print: "😀"';
  refusingPut({ error: reason, field: "document" });
  mountCompany();

  fireEvent.change(inputFor("document"), { target: { value: "12.345 😀" } });
  save();

  await waitFor(() => {
    expect(shownInsideFieldOf("document", reason)).toBe(1);
  });
  // And nowhere else: the toast does not repeat what is already on the control.
  expect(shownAnywhere(reason)).toBe(1);
  // Nor does it fire with the generic sentence instead, which is the same interruption carrying less
  // than the control already says.
  expect(toastCount()).toBe(0);
});

test("a refusal about an input this form does not render still reaches the operator", async () => {
  // `logoKey` is a column of the same block and has no text input on this card. Holding the refusal
  // for an input that is not on screen would be silence, which is the one outcome barred here.
  const reason = "the stored logo is no longer readable";
  refusingPut({ error: reason, field: "logoKey" });
  mountCompany();

  fireEvent.change(inputFor("name"), { target: { value: "ACME Nova" } });
  save();

  await waitFor(() => {
    expect(shownAnywhere(reason)).toBeGreaterThan(0);
  });
  for (const field of ORDER) {
    expect(shownInsideFieldOf(field, reason)).toBe(0);
  }
  // The positive control for the counter the test above reads as zero: a toast DOES register here,
  // so a counter that had stopped counting would fail on this line instead of passing on that one.
  expect(toastCount()).toBe(1);
});

test("a refusal about no input at all is still a toast", async () => {
  // Most refusals are not about one input (a 403, a 404, a conflict) and answer with no `field` at
  // all. They must keep behaving exactly as they did before this mechanism existed.
  const reason = "this tenant is not allowed to change the letterhead";
  refusingPut({ error: reason });
  mountCompany();

  fireEvent.change(inputFor("name"), { target: { value: "ACME Nova" } });
  save();

  await waitFor(() => {
    expect(shownAnywhere(reason)).toBeGreaterThan(0);
  });
  for (const field of ORDER) {
    expect(shownInsideFieldOf(field, reason)).toBe(0);
  }
});

test("editing the refused input takes the refusal off it", async () => {
  // The operator has acted on the thing the message asked them to fix. Leaving it there marks a value
  // the server never saw, and the next save answers for the new one.
  const reason =
    'document contains a character the document fonts cannot print: "😀"';
  refusingPut({ error: reason, field: "document" });
  mountCompany();

  fireEvent.change(inputFor("document"), { target: { value: "12.345 😀" } });
  save();
  await waitFor(() => {
    expect(shownInsideFieldOf("document", reason)).toBe(1);
  });

  fireEvent.change(inputFor("document"), { target: { value: "12.345" } });
  expect(shownInsideFieldOf("document", reason)).toBe(0);
});

test("a second refusal about another input does not leave the first one marked", async () => {
  // The capture is also the clear: one refusal is what the server answers, so two marks on screen
  // would claim the server refused twice. Only the second one is a fact.
  const first =
    'document contains a character the document fonts cannot print: "😀"';
  refusingPut({ error: first, field: "document" });
  mountCompany();

  fireEvent.change(inputFor("document"), { target: { value: "12.345 😀" } });
  save();
  await waitFor(() => {
    expect(shownInsideFieldOf("document", first)).toBe(1);
  });

  const second =
    'website contains a character the document fonts cannot print: "🙃"';
  refusingPut({ error: second, field: "website" });
  fireEvent.change(inputFor("website"), { target: { value: "acme.com 🙃" } });
  save();

  await waitFor(() => {
    expect(shownInsideFieldOf("website", second)).toBe(1);
  });
  expect(shownAnywhere(first)).toBe(0);
});

test("a save with no server behind it still says something", async () => {
  // Eden REJECTS on a transport failure rather than answering a body, so there is no message and no
  // field. The generic sentence is the honest thing, and it is a toast: there is no input to blame.
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  mountCompany();

  fireEvent.change(inputFor("name"), { target: { value: "ACME Nova" } });
  save();

  await waitFor(() => {
    expect(
      screen.queryAllByText(/não foi possível salvar|could not save/i).length,
    ).toBeGreaterThan(0);
  });
});

test("editing another input leaves the mark where the server put it", async () => {
  // `clear(field)` answers for ONE input. An operator who reads "fix the tax id" and goes on typing
  // their address has not fixed anything, and a mark that came off would take the reason with it.
  const reason =
    "document contains a character the document fonts cannot print";
  refusingPut({ error: reason, field: "document" });
  mountCompany();

  fireEvent.change(inputFor("document"), { target: { value: "12.345" } });
  save();
  await waitFor(() => {
    expect(shownInsideFieldOf("document", reason)).toBe(1);
  });

  fireEvent.change(inputFor("address"), { target: { value: "Rua Um, 2" } });
  expect(shownInsideFieldOf("document", reason)).toBe(1);
});

test("a later refusal about no input takes the earlier mark off", async () => {
  // The capture is the only writer, and it always writes. Otherwise the mark from a refusal the
  // server has stopped making sits on a control while a toast says something else entirely.
  const first = "document contains a character the document fonts cannot print";
  refusingPut({ error: first, field: "document" });
  mountCompany();

  fireEvent.change(inputFor("document"), { target: { value: "12.345" } });
  save();
  await waitFor(() => {
    expect(shownInsideFieldOf("document", first)).toBe(1);
  });

  const second = "this tenant is not allowed to change the letterhead";
  refusingPut({ error: second });
  save();

  await waitFor(() => {
    expect(shownAnywhere(second)).toBeGreaterThan(0);
  });
  expect(shownAnywhere(first)).toBe(0);
});

test("a save that goes through takes the mark off", async () => {
  // The refusal was about the value the server rejected; it accepted this one. Nothing on screen may
  // still say otherwise.
  const reason =
    "document contains a character the document fonts cannot print";
  refusingPut({ error: reason, field: "document" });
  mountCompany();

  fireEvent.change(inputFor("document"), { target: { value: "12.345" } });
  save();
  await waitFor(() => {
    expect(shownInsideFieldOf("document", reason)).toBe(1);
  });

  // The save route answers with the whole company block; nothing here reads it beyond `data.company`.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ company: COMPANY }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  save();

  await waitFor(() => {
    expect(shownAnywhere(reason)).toBe(0);
  });
});

// ── The three ways a mark can be held and never seen ──────────────────────────────────────────
//
// `capture` answers "is this input one the form declared", and the invariant needs "will the
// operator actually read this". The three below are where those diverge, all found by review on the
// first round of #313 and all the same defect: a placement that renders nothing is silence, and
// silence is the one outcome this mechanism may not produce.

// A `fetch` whose answer is released by hand, so the test can act between the click and the reply.
function deferredPut(body: { error: string; field?: string }) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "PUT") {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    await gate;
    return new Response(JSON.stringify(body), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return () => release();
}

// The modal case, mounted the way it really is: the card goes away and the ToastProvider does NOT.
// Unmounting the whole tree instead would take the toast viewport with it and the test could only
// ever observe zero, whatever the code did.
function DismissableCompany({ gone }: { gone: boolean }) {
  return (
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          {gone ? null : (
            <CompanyProfileCard
              company={COMPANY as never}
              onChanged={() => undefined}
              session={1}
            />
          )}
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>
  );
}

test("a refusal that arrives after the form is gone still reaches the operator", async () => {
  // This card is a modal body, and the file already records that a save is slow enough for the
  // operator to close the modal while the request is out. Closing it unmounts the hook, so the mark
  // is written to state nobody renders — and `capture` had already reported "it is on the control".
  const reason =
    "document contains a character the document fonts cannot print";
  const release = deferredPut({ error: reason, field: "document" });
  const view = render(<DismissableCompany gone={false} />);

  fireEvent.change(inputFor("document"), { target: { value: "12.345" } });
  save();
  view.rerender(<DismissableCompany gone={true} />);
  release();

  await waitFor(() => {
    expect(toastCount()).toBe(1);
  });
});

test("a refusal about a value the operator has already changed is a toast, not a mark", async () => {
  // Marking the input would put "this is not valid" under a value the server never saw. The refusal
  // is about what was SENT, and what was sent is no longer in the box.
  const reason =
    "document contains a character the document fonts cannot print";
  const release = deferredPut({ error: reason, field: "document" });
  mountCompany();

  fireEvent.change(inputFor("document"), { target: { value: "12.345 x" } });
  save();
  fireEvent.change(inputFor("document"), { target: { value: "12.345" } });
  release();

  await waitFor(() => {
    expect(toastCount()).toBe(1);
  });
  expect(shownInsideFieldOf("document", reason)).toBe(0);
});
