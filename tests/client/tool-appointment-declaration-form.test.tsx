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

function textareaFor(pattern: RegExp): HTMLTextAreaElement {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    pattern.test(captionOf(l)),
  );
  const el = label?.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!el) throw new Error(`no textarea captioned ${pattern}`);
  return el;
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

// (#352, round 6) The reminder offsets were the one field still FILTERING instead of refusing: `24h`
// and `0` were dropped on the way out, the tool saved, the field went on showing them, and the
// customer was never reminded. Same question as the paths and the provider above, so the same
// answer.
test("offsets the runtime would not honour hold the save", async () => {
  await openForm();
  fireEvent.change(actionSelect(), { target: { value: "book" } });
  fireEvent.change(inputFor(/onde está o id|where the id is/i), {
    target: { value: "data.id" },
  });
  fireEvent.change(inputFor(/horário de início|start time/i), {
    target: { value: "data.start" },
  });
  await waitFor(() => expect(saveDisabled()).toBe(false));

  const offsets = inputFor(/quantas horas antes|this many hours before/i);
  // Not a number at all: silently dropped before, so the tool saved with no reminder armed.
  fireEvent.change(offsets, { target: { value: "24h" } });
  await waitFor(() => expect(saveDisabled()).toBe(true));
  // Below the server's own floor, and the same disappearance.
  fireEvent.change(offsets, { target: { value: "0" } });
  await waitFor(() => expect(saveDisabled()).toBe(true));
  // Above its ceiling, which the server would CLAMP — also a value the field would go on misstating.
  fireEvent.change(offsets, { target: { value: "99999" } });
  await waitFor(() => expect(saveDisabled()).toBe(true));
  // More than the five the server keeps.
  fireEvent.change(offsets, { target: { value: "48, 24, 12, 6, 3, 1" } });
  await waitFor(() => expect(saveDisabled()).toBe(true));

  // Empty is an ordinary answer: an operator whose own system already reminds says so this way.
  fireEvent.change(offsets, { target: { value: "" } });
  await waitFor(() => expect(saveDisabled()).toBe(false));

  // And a valid list releases it and is what gets submitted, in the order the reader gives.
  fireEvent.change(offsets, { target: { value: "24, 1" } });
  await waitFor(() => expect(saveDisabled()).toBe(false));
  clickSave();
  await waitFor(() => expect(posted.length).toBe(1));
  expect(posted[0]?.appointment).toEqual({
    action: "book",
    idPath: "data.id",
    startPath: "data.start",
    reminderOffsetsHours: [24, 1],
    // Off unless the operator turned it on: the switch only appears once the field is nonempty.
    askConfirmationOnLast: false,
  });
});

// (#352) The picker is the answer to what the gates above CANNOT catch: `data.id` typed where the
// field is `data.appointment.id` is well-formed, passes every check, and reads nothing all the way
// to production. Asserted on the VALUE the field ends up holding and on what is submitted, never on
// the list appearing: a picker that renders and fills nothing looks identical.
test("a pasted sample fills the paths by clicking, and is never submitted", async () => {
  await openForm();
  fireEvent.change(actionSelect(), { target: { value: "book" } });
  await waitFor(() => expect(saveDisabled()).toBe(true));

  const sample = textareaFor(/resposta de exemplo|sample response/i);
  fireEvent.change(sample, {
    target: {
      value: JSON.stringify({
        data: {
          appointment: { id: "ap_9", starts_at: "2026-09-02T14:00:00-03:00" },
        },
      }),
    },
  });

  // One picker per field, so a click can only mean one target.
  const pickers = () =>
    Array.from(document.querySelectorAll("button")).filter((b) =>
      /(escolher da resposta|pick from the sample)/i.test(
        (b.textContent ?? "").trim(),
      ),
    );
  await waitFor(() => expect(pickers().length).toBe(3));

  const pick = async (which: number, path: string) => {
    fireEvent.click(pickers()[which] as HTMLButtonElement);
    const leaf = await waitFor(() => {
      const b = Array.from(document.querySelectorAll("li button")).find((x) =>
        (x.textContent ?? "").startsWith(path),
      );
      if (!b) throw new Error(`no leaf ${path}`);
      return b as HTMLButtonElement;
    });
    fireEvent.click(leaf);
  };

  await pick(0, "data.appointment.id");
  expect(inputFor(/onde está o id|where the id is/i).value).toBe(
    "data.appointment.id",
  );
  // Still held: the start has not been chosen yet, so the picker is not what released the save.
  expect(saveDisabled()).toBe(true);

  await pick(1, "data.appointment.starts_at");
  expect(inputFor(/horário de início|start time/i).value).toBe(
    "data.appointment.starts_at",
  );
  await waitFor(() => expect(saveDisabled()).toBe(false));

  clickSave();
  await waitFor(() => expect(posted.length).toBe(1));
  expect(posted[0]?.appointment).toEqual({
    action: "book",
    idPath: "data.appointment.id",
    startPath: "data.appointment.starts_at",
  });
  // The sample itself is an aid, not a field: nothing about it reaches the server.
  expect(JSON.stringify(posted[0])).not.toContain('starts_at":"2026');
});

// (#352, round 8) A switch with no programmatic name is announced as an unnamed switch: the text
// beside it is only visually adjacent. Asserted through the accessible name, which is also what
// makes the label clickable — a test that merely found the text on screen would pass unchanged
// against the broken build.
test("the confirmation switch carries its label", async () => {
  await openForm();
  fireEvent.change(actionSelect(), { target: { value: "book" } });
  fireEvent.change(inputFor(/onde está o id|where the id is/i), {
    target: { value: "data.id" },
  });
  fireEvent.change(inputFor(/horário de início|start time/i), {
    target: { value: "data.start" },
  });
  // The switch only appears once an offset is configured.
  fireEvent.change(inputFor(/quantas horas antes|this many hours before/i), {
    target: { value: "24" },
  });

  const sw = await waitFor(() => {
    const el = document.querySelector('[role="switch"]');
    if (!el) throw new Error("no switch on screen");
    return el as HTMLElement;
  });
  const labelled = document.querySelector(
    `label[for="${sw.getAttribute("id")}"]`,
  );
  expect(sw.getAttribute("id")).toBeTruthy();
  expect(labelled?.textContent ?? "").toMatch(
    /(no último lembrete|on the last reminder)/i,
  );

  // And the name is wired, not decorative: clicking the label flips the switch.
  const before = sw.getAttribute("aria-checked");
  fireEvent.click(labelled as Element);
  await waitFor(() =>
    expect(
      document.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
    ).not.toBe(before),
  );
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
