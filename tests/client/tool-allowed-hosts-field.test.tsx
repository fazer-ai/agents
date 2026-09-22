/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { MemoryRouter } from "react-router";

// THE ALLOWLIST IS WRITABLE FROM THE CONSOLE (review round 1 of #615). The runtime has always
// enforced `allowedHosts`, and the modal carried the field in its form state and payload without a
// control to type into, so every console-made tool saved `[]`. Since #615 the list is also the
// per-tool half of reaching an internal service, which made the missing field the difference between
// the feature existing and not. Asserted on what the SAVE sends, not on the field being drawn.

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
  return (label.textContent ?? "").trim();
}

// A <FormField> label POINTS at its control (`htmlFor`) instead of wrapping it, so the control is
// not a descendant to query for. Following the association is also the more honest check: it fails
// if the label names nothing, which a subtree query cannot notice.
function controlFor<T extends Element>(pattern: RegExp, what: string): T {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    pattern.test(captionOf(l)),
  ) as HTMLLabelElement | undefined;
  const byFor = label?.htmlFor
    ? (document.getElementById(label.htmlFor) as T | null)
    : null;
  // A `group` field has no single control to point at, so its heading is a <span> and the control
  // inside carries its own aria-label. Both shapes are legitimate; which one a field uses is a
  // property of its children, not something a test should depend on.
  const byGroup =
    byFor ??
    (Array.from(document.querySelectorAll("[role='group']"))
      .find((g) =>
        pattern.test((g.querySelector("span")?.textContent ?? "").trim()),
      )
      ?.querySelector("input, select, textarea") as T | null | undefined);
  if (!byGroup) throw new Error(`no ${what} captioned ${pattern}`);
  return byGroup;
}

function inputFor(pattern: RegExp): HTMLInputElement {
  return controlFor<HTMLInputElement>(pattern, "field");
}

function clickSave(): void {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    /^(salvar|save)$/i.test((b.textContent ?? "").trim()),
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error("no save button on screen");
  fireEvent.click(btn);
}

test("the hosts typed in the editor are what the save submits", async () => {
  serving();
  render(
    <MemoryRouter initialEntries={["/recursos/ferramentas"]}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </MemoryRouter>,
  );
  const name = inputFor(/nome|name/i);
  await waitFor(() => expect(name.isConnected).toBe(true));
  fireEvent.change(name, { target: { value: "Assinar" } });
  fireEvent.change(inputFor(/url/i), {
    target: { value: "http://sidecar:8080/sign" },
  });
  fireEvent.change(inputFor(/hosts permitidos|allowed hosts/i), {
    target: { value: " sidecar , api.example.com," },
  });
  clickSave();
  await waitFor(() => expect(posted.length).toBe(1));
  expect(posted[0]?.allowedHosts).toEqual(["sidecar", "api.example.com"]);
});
