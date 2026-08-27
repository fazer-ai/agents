/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter } from "react-router";

// A DECLARATION THE RUNTIME WOULD NOT FOLLOW IS NOT A DECLARATION TO SAVE.
//
// The declaration is read by ONE function, and the server stores nothing it would not follow: a book
// without a usable id and start path is REFUSED on save, and an unusable provider or summary path is
// silently dropped. Either way the operator ends up with a tool that does not do what the form
// showed them, and the modal's only report is the generic "check the name and URL" — so the feature
// reads as broken rather than as a typo in a path.
//
// Asserted on what the SAVE BUTTON does, never on the message alone: a test that only reads the
// error text stays green against a build that shows the message and saves anyway (issue #340).

const { ToolEditModal } = await import(
  "@/client/pages/resources/ToolEditModal"
);
const { ToastProvider, useModalController } = await import(
  "@/client/components"
);

const realFetch = globalThis.fetch;
let posted: Record<string, unknown>[] = [];

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  posted = [];
});

function serving() {
  posted = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      posted.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({ tool: { id: "1", name: "agendar" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
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
  return (
    <ToolEditModal
      modal={modal as unknown as Parameters<typeof ToolEditModal>[0]["modal"]}
      onSaved={() => undefined}
    />
  );
}

// By the field's own CAPTION — the first span inside its label — never by the label's whole
// textContent. A label carries its hint, its error message and (for a select) every option, so a
// substring search matches fields it was not aiming at: a fixture URL of `/v1/appointments` made
// the URL field answer for the appointment section, and the section's caption answered for
// "start time".
function captionOf(label: Element): string {
  return (label.querySelector("span")?.textContent ?? "").trim();
}

function inputFor(pattern: RegExp): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    pattern.test(captionOf(l)),
  );
  const input = label?.querySelector("input") as HTMLInputElement | null;
  if (!input) throw new Error(`no field captioned ${pattern}`);
  return input;
}

function saveDisabled(): boolean {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    /^(salvar|save)$/i.test((b.textContent ?? "").trim()),
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error("no save button on screen");
  return btn.disabled;
}

function clickSave(): void {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    /^(salvar|save)$/i.test((b.textContent ?? "").trim()),
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error("no save button on screen");
  fireEvent.click(btn);
}

// By the SENTENCE, not by the word "appointment": the URL field's own value is on screen too, and a
// fixture URL like /v1/appointments made this selector return the URL label instead — the test then
// failed for a reason that had nothing to do with the form.
function actionSelect(): HTMLSelectElement {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    /(books or cancels|marca ou cancela)/i.test(captionOf(l)),
  );
  const sel = label?.querySelector("select") as HTMLSelectElement | null;
  if (!sel) throw new Error("no appointment action select on screen");
  return sel;
}

async function openForm() {
  serving();
  render(
    <MemoryRouter initialEntries={["/recursos/ferramentas"]}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MemoryRouter>,
  );
  // A tool that is otherwise complete, so nothing but the declaration can hold the save.
  const name = inputFor(/nome|name/i);
  await waitFor(() => expect(name.isConnected).toBe(true));
  fireEvent.change(name, { target: { value: "Agendar" } });
  fireEvent.change(inputFor(/url/i), {
    target: { value: "https://api.example.com/v1/bookings" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(false));
}

test("a book declaration cannot be saved until its paths are usable", async () => {
  await openForm();

  // Choosing "it books one" with no paths yet: the save is held, not offered and then refused.
  fireEvent.change(actionSelect(), { target: { value: "book" } });
  await waitFor(() => expect(saveDisabled()).toBe(true));

  // A usable id alone is not enough: a book decides liveness by its START, and every reader of an
  // appointment refuses a declaration without one.
  fireEvent.change(inputFor(/onde está o id|where the id is/i), {
    target: { value: "data.id" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(true));

  // A path shape the reader cannot walk keeps it held, and says which shape it wants.
  fireEvent.change(inputFor(/onde está o id|where the id is/i), {
    target: { value: "data[0].id" },
  });
  fireEvent.change(inputFor(/horário de início|start time/i), {
    target: { value: "data.start" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(true));
  expect(screen.queryAllByText(/data\.items\.0\.id/i).length).toBeGreaterThan(
    0,
  );

  // Usable paths release it, and what is submitted is the declaration itself.
  fireEvent.change(inputFor(/onde está o id|where the id is/i), {
    target: { value: "data.id" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(false));

  // The summary is OPTIONAL, and an unusable one is dropped by the reader rather than refused — so
  // saving it would hand the operator a tool whose title path silently does nothing. Blank is fine;
  // typed-and-unwalkable is not.
  fireEvent.change(inputFor(/onde está o título|where the title is/i), {
    target: { value: "data..title" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(true));
  fireEvent.change(inputFor(/onde está o título|where the title is/i), {
    target: { value: "" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(false));
  clickSave();
  await waitFor(() => expect(posted.length).toBe(1));
  expect(posted[0]?.appointment).toEqual({
    action: "book",
    idPath: "data.id",
    startPath: "data.start",
  });
});

test("a provider that is not a slug holds the save too", async () => {
  await openForm();
  fireEvent.change(actionSelect(), { target: { value: "cancel" } });
  fireEvent.change(inputFor(/onde está o id|where the id is/i), {
    target: { value: "id" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(false));

  // Silently dropped by the reader, so the tool would be saved carrying a provider nobody wrote.
  fireEvent.change(inputFor(/sistema de agendamento|booking system/i), {
    target: { value: "Feegow Clínica!" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(true));

  // And so is Google's own name, which would put these ids into Google's id space.
  fireEvent.change(inputFor(/sistema de agendamento|booking system/i), {
    target: { value: "google_calendar" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(true));

  fireEvent.change(inputFor(/sistema de agendamento|booking system/i), {
    target: { value: "feegow" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(false));
  clickSave();
  await waitFor(() => expect(posted.length).toBe(1));
  expect(posted[0]?.appointment).toEqual({
    action: "cancel",
    provider: "feegow",
    idPath: "id",
  });
});
