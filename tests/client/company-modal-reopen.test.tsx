/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The guard, where it actually lives. `company-save-session.test.tsx` proves the card reports which
// opening a save belongs to, against a harness parent; this drives the real `DocumentsPanel`. The
// letterhead is a modal, so the card UNMOUNTS on close and a new one mounts on reopen while the
// stale card's request is still out. The generation is read off a ref so the stale closure sees the
// current value; state would hand it the frozen one.

(globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
  "http://localhost/recursos/documentos",
);

const { DocumentsPanel } = await import(
  "@/client/pages/resources/documents/DocumentsPanel"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");

const realFetch = globalThis.fetch;
const EMPTY_COMPANY = {
  name: "",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: null,
  logoVersion: 0,
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

let releasePut: () => void = () => {};
let puts = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "PUT" && url.pathname.endsWith("/tenant-settings/company")) {
    puts++;
    // Held open, so the window between the click and the response is a real one.
    await new Promise<void>((r) => {
      releasePut = r;
    });
    return json({ company: { ...EMPTY_COMPANY, name: "ACME Nova" } });
  }
  if (url.pathname.endsWith("/document-templates/starters"))
    return json({ starters: [] });
  if (url.pathname.endsWith("/document-templates"))
    return json({ templates: [] });
  if (url.pathname.endsWith("/documents")) return json({ documents: [] });
  if (url.pathname.endsWith("/tenant-settings"))
    return json({ company: EMPTY_COMPANY });
  return json({});
}) as unknown as typeof fetch;

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

// By its TITLE, so the discard confirm cannot be mistaken for it: the word "timbre" appears in the
// CONFIRM dialog's message and not in this modal.
function letterheadOpen(): boolean {
  return screen
    .queryAllByRole("dialog")
    .some((d) =>
      /perfil da empresa|company profile/i.test(d.textContent ?? ""),
    );
}

test("a letterhead save from a previous opening does not close the reopened editor", async () => {
  render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <NavGuardProvider>
        <ToastProvider>
          <DocumentsPanel />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );

  const open = async () => {
    const button = await screen.findByRole("button", {
      name: /preencher|fill in|editar|^edit$/i,
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(letterheadOpen()).toBe(true);
    });
  };

  await open();
  fireEvent.change(screen.getAllByRole("textbox")[0] as HTMLInputElement, {
    target: { value: "ACME Nova" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^(save|salvar)$/i }));
  await waitFor(() => {
    expect(puts).toBe(1);
  });

  // NOTE: closed while the request is out. The form still holds unsaved text, so this goes through
  // the discard confirm, the path the operator actually takes.
  fireEvent.keyDown(document.body, { key: "Escape" });
  // The confirm appears; the letterhead is already hidden behind it, so it is the Discard button
  // that says the dismissal reached the guard, not a dialog count.
  const discard = await screen.findByRole("button", {
    name: /descartar|^discard$/i,
  });
  fireEvent.click(discard);
  await waitFor(() => {
    expect(letterheadOpen()).toBe(false);
  });

  // Reopened: a NEW card, a new generation, and the first card's request still in flight.
  await open();
  releasePut();
  await new Promise((r) => setTimeout(r, 60));

  // Still on screen. Without the guard the older save announces itself and the panel closes the
  // editor the operator is looking at.
  expect(letterheadOpen()).toBe(true);
});
