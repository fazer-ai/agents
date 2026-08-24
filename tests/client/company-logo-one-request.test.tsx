/// <reference lib="dom" />

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// A logo write answers with the WHOLE company block, and the card applies what comes back. Two of
// them in flight at once is therefore not two independent requests: whichever ANSWERS last decides
// what the card shows, and that is not necessarily the one that wrote last.
//
// The upload and the remove both go to the same key, so an older response landing last puts a
// superseded `logoKey` on screen — usually one whose file the newer write already deleted, which
// renders as a broken letterhead until the page is reloaded.
//
// Serialised rather than reconciled: an upload is a deliberate act, one at a time is what the
// operator expects, and the same shape is already how creating from a starter behaves.
//
// NOTE: assertions reduce to a boolean or a string BEFORE expect; a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

const { CompanyProfileCard } = await import(
  "@/client/pages/resources/documents/CompanyProfileCard"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");

const realFetch = globalThis.fetch;
const company = (over: Record<string, unknown> = {}) => ({
  name: "ACME",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: "1-logo-aaaa.png",
  logoVersion: 1,
  ...over,
});

let releaseUpload = () => {};
let releaseRemove = () => {};
let holdRemove = false;
const inFlight: string[] = [];

let holdProfile = false;
let releaseProfile = () => {};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname.endsWith("/tenant-settings/company/logo")) {
    // Mutations only: the same path serves the letterhead image itself, which the card fetches on
    // every render that has a key, and counting those would hide what this test is measuring.
    if (method !== "GET") inFlight.push(method);
    if (method === "POST") {
      await new Promise<void>((r) => {
        releaseUpload = r;
      });
      return new Response(
        JSON.stringify({ company: company({ logoKey: "1-logo-bbbb.png" }) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (holdRemove) {
      await new Promise<void>((r) => {
        releaseRemove = r;
      });
    }
    return new Response(
      JSON.stringify({ company: company({ logoKey: null }) }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  if (url.pathname.endsWith("/tenant-settings/company") && method !== "GET") {
    inFlight.push("PUT");
    if (holdProfile) {
      await new Promise<void>((r) => {
        releaseProfile = r;
      });
    }
    return new Response(JSON.stringify({ company: company() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  // The letterhead image itself.
  return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
}) as unknown as typeof fetch;

beforeEach(() => {
  holdRemove = false;
  holdProfile = false;
  inFlight.length = 0;
});
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

test("a second logo write cannot start while one is in flight", async () => {
  inFlight.length = 0;
  render(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard company={company()} onChanged={() => {}} />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );

  const file = new File([new Uint8Array([1])], "logo.png", {
    type: "image/png",
  });
  const picker = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  if (!picker) throw new Error("no file input");
  fireEvent.change(picker, { target: { files: [file] } });
  await waitFor(() => {
    expect(inFlight.length).toBe(1);
  });

  // Both controls are out of reach until the upload answers: the remove would delete the file the
  // upload is installing, and a second upload would race its own response.
  const buttons = [...document.querySelectorAll("button")];
  const enabled = buttons
    .filter((b) => b.querySelector("svg"))
    .map((b) => (b as HTMLButtonElement).disabled);
  expect(enabled.some((d) => d === false)).toBe(false);

  // Clicked the way an operator can reach them — the file picker is opened BY the upload button, so
  // a disabled button is a picker that never opens. Dispatching a change on the hidden input
  // directly would be testing a surface no click can reach.
  const removeButton = screen.queryByLabelText(/Delete|Excluir/);
  if (removeButton) fireEvent.click(removeButton);
  const uploadButton = [...document.querySelectorAll("button")].find((b) =>
    /Upload|Enviar/.test(b.textContent ?? ""),
  );
  if (uploadButton) fireEvent.click(uploadButton);
  await new Promise((r) => setTimeout(r, 30));
  expect(inFlight.join(",")).toBe("POST");

  releaseUpload();
  await waitFor(() => {
    const again = [...document.querySelectorAll("button")].filter((b) =>
      b.querySelector("svg"),
    );
    expect(again.some((b) => (b as HTMLButtonElement).disabled === false)).toBe(
      true,
    );
  });
});

// The other direction, which is the half a single test would miss: while the REMOVE is in flight,
// the upload button has to be out of reach too. Its own `loading` flag is false then, so nothing
// but the shared busy state disables it — and an upload landing on a key the remove is deleting is
// the same interleaving from the other side.
test("an upload cannot start while a removal is in flight", async () => {
  inFlight.length = 0;
  holdRemove = true;
  render(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard company={company()} onChanged={() => {}} />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );
  const removeButton = await screen.findByLabelText(/Delete|Excluir/);
  fireEvent.click(removeButton);
  await waitFor(() => {
    expect(inFlight.join(",")).toBe("DELETE");
  });

  const uploadButton = [...document.querySelectorAll("button")].find((b) =>
    /Upload|Enviar/.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
  expect(uploadButton?.disabled).toBe(true);

  releaseRemove();
  await waitFor(() => {
    expect(
      (
        [...document.querySelectorAll("button")].find((b) =>
          /Upload|Enviar/.test(b.textContent ?? ""),
        ) as HTMLButtonElement | undefined
      )?.disabled,
    ).toBe(false);
  });
});

// The THIRD writer of the same block, and the one a per-control flag misses: saving the profile text
// answers with the whole company block too, logo key included. An operator who saves while an upload
// is out gets whichever response lands last — and if that is the older one, the card adopts a
// logoKey whose file the newer write already deleted, so the letterhead renders broken until reload.
//
// One state for "a write to this block is in flight", not one per control.
test("saving the profile cannot start while a logo write is in flight", async () => {
  inFlight.length = 0;
  holdRemove = true;
  render(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard company={company()} onChanged={() => {}} />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByLabelText(/Delete|Excluir/));
  await waitFor(() => {
    expect(inFlight.join(",")).toBe("DELETE");
  });

  const save = [...document.querySelectorAll("button")].find((b) =>
    /^(Save|Salvar)$/.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
  expect(save?.disabled).toBe(true);
  if (save) fireEvent.click(save);
  await new Promise((r) => setTimeout(r, 30));
  expect(inFlight.join(",")).toBe("DELETE");

  releaseRemove();
  await waitFor(() => {
    expect(
      (
        [...document.querySelectorAll("button")].find((b) =>
          /^(Save|Salvar)$/.test(b.textContent ?? ""),
        ) as HTMLButtonElement | undefined
      )?.disabled,
    ).toBe(false);
  });
});

test("a logo write cannot start while the profile is saving", async () => {
  inFlight.length = 0;
  holdProfile = true;
  render(
    <MemoryRouter>
      <NavGuardProvider>
        <ToastProvider>
          <CompanyProfileCard company={company()} onChanged={() => {}} />
        </ToastProvider>
      </NavGuardProvider>
    </MemoryRouter>,
  );
  const save = [...document.querySelectorAll("button")].find((b) =>
    /^(Save|Salvar)$/.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
  if (!save) throw new Error("no save button");
  fireEvent.click(save);
  await waitFor(() => {
    expect(inFlight.join(",")).toBe("PUT");
  });

  const remove = screen.queryByLabelText(
    /Delete|Excluir/,
  ) as HTMLButtonElement | null;
  expect(remove?.disabled).toBe(true);
  if (remove) fireEvent.click(remove);
  const upload = [...document.querySelectorAll("button")].find((b) =>
    /Upload|Enviar/.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
  expect(upload?.disabled).toBe(true);
  if (upload) fireEvent.click(upload);
  await new Promise((r) => setTimeout(r, 30));
  expect(inFlight.join(",")).toBe("PUT");

  releaseProfile();
  await waitFor(() => {
    expect(
      (screen.queryByLabelText(/Delete|Excluir/) as HTMLButtonElement | null)
        ?.disabled,
    ).toBe(false);
  });
});
