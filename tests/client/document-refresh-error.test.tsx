/// <reference lib="dom" />

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The panel reloads itself constantly: after a template is saved or deleted, after a starter is
// used, and whenever the operator switches language. Those refreshes run while the company profile
// below is an OPEN FORM the operator may be typing into.
//
// A failed refresh must not take the screen away. The `loading` flag already knows this — it is the
// first load only, precisely so a reload does not unmount the editor — but `error` was shared, so
// one failed background request replaced the whole panel with a retry card and threw away whatever
// was in the form, along with the guard that would have warned about leaving it.
//
// NOTE: the language is switched on the REAL i18n instance rather than by mocking react-i18next —
// `mock.module` and its restore are global to the process and tear down other files' mocks.
// NOTE: assertions reduce to a boolean or a string BEFORE expect; a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

(globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
  "http://localhost/recursos/documentos",
);

const { default: i18n } = await import("@/client/lib/i18n");
const { DocumentsPanel } = await import(
  "@/client/pages/resources/documents/DocumentsPanel"
);
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// Which GET the NEXT load should fail. The first load always succeeds: this is about a refresh.
let failSettings = false;
// What the server says when it does. A sentence no catalogue in this tree contains, so finding it on
// screen can only mean it travelled from the response.
let settingsRefusal = "boom";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  if ((init?.method ?? "GET").toUpperCase() !== "GET") {
    return json({ company: {} });
  }
  if (url.pathname.endsWith("/document-templates/starters")) {
    return json({ starters: [] });
  }
  if (url.pathname.endsWith("/document-templates")) {
    return json({ templates: [] });
  }
  if (url.pathname.endsWith("/tenant-settings")) {
    if (failSettings) {
      return new Response(JSON.stringify({ error: settingsRefusal }), {
        status: 500,
      });
    }
    return json({
      company: {
        name: "",
        document: "",
        address: "",
        phone: "",
        email: "",
        website: "",
        logoKey: null,
        logoVersion: 0,
      },
    });
  }
  return json({ documents: [] });
}) as unknown as typeof fetch;

beforeEach(() => {
  failSettings = false;
  settingsRefusal = "boom";
});
afterEach(cleanup);
const startingLanguage = i18n.language;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await i18n.changeLanguage(startingLanguage);
});

test("a failed refresh keeps the company form and what was typed into it", async () => {
  await i18n.changeLanguage("en");
  render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <ToastProvider>
        <DocumentsPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
  // The letterhead is a modal now, so it has to be opened to be typed into — and being open is
  // exactly the state this rule is about: a background refresh must not take the form away from
  // under whoever is using it.
  fireEvent.click(
    await screen.findByRole("button", { name: /^(edit|fill in)$/i }),
  );
  const nameInput = (await screen.findAllByRole("textbox"))[0];
  if (!nameInput) throw new Error("no company field");
  fireEvent.change(nameInput, { target: { value: "ACME Nova" } });

  // A refresh, failing. Switching language is the cheapest trigger and one the operator can hit at
  // any moment; a template save or delete reaches the same `load`.
  failSettings = true;
  await act(async () => {
    await i18n.changeLanguage("pt-BR");
  });
  await waitFor(() => {
    expect(screen.queryAllByText(/Retry|Tentar novamente/).length >= 0).toBe(
      true,
    );
  });
  await new Promise((r) => setTimeout(r, 60));

  // The form is still there, still holding the edit.
  const boxes = await screen.findAllByRole("textbox");
  expect((boxes[0] as HTMLInputElement | undefined)?.value).toBe("ACME Nova");
  // …and the panel did not replace itself with a retry card.
  expect(screen.queryAllByText(/Retry|Tentar novamente/).length).toBe(0);
});

// The other half of the same rule: with NOTHING on screen yet, a failure has to be visible, and the
// retry card is the only thing that can say so. Reading "the screen is not taken away" as "errors
// are never shown" would leave a first load that failed looking like an empty account.
test("a failed FIRST load still shows the retry card", async () => {
  await i18n.changeLanguage("en");
  failSettings = true;
  render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <ToastProvider>
        <DocumentsPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(screen.queryAllByText(/Retry/).length).toBeGreaterThan(0);
  });
});

// #233. A failed refresh keeps the screen (above) AND says what the server said. The toast lives in
// `failed`, a callback that awaits nothing — `load` is the one that knows WHICH of the four requests
// refused, so the response travels to it as an argument. That wiring is what this proves: the static
// fence judges the SHAPE of the call, not that the reason arrives.
test("a failed refresh shows the reason the server sent", async () => {
  await i18n.changeLanguage("en");
  settingsRefusal = "Your plan does not include letterheads.";
  render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <ToastProvider>
        <DocumentsPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: /^(edit|fill in)$/i });

  failSettings = true;
  await act(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  // Both sentences are searched for, in both languages: the refresh that fires here is the one the
  // language switch caused, so the fallback would come out in pt-BR. Searching only for the English
  // one would fail by TIMEOUT instead of by showing what was on screen, which is a worse failure —
  // it cannot tell "the wrong sentence" from "no toast at all".
  const anyToast = /letterheads|Could not refresh|atualizar esta página/;
  // Reduced to a string before the expectation: a failing assertion holding a happy-dom node
  // serializes a cyclic tree and stalls the runner.
  await waitFor(() => {
    expect(screen.queryAllByText(anyToast).length).toBeGreaterThan(0);
  });
  const shown = screen
    .queryAllByText(anyToast)
    .map((n) => n.textContent ?? "")
    .join(" | ");
  expect(shown).toContain("Your plan does not include letterheads.");
  expect(shown).not.toContain("atualizar esta página");
});
