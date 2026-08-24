/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { DocumentsPanel } from "@/client/pages/resources/documents/DocumentsPanel";

// Revoking is not undoable, and it does more than hide a row: the PDF stops being served, and the
// agent's idempotency key is derived from the VALUES, so every later send of the same document
// resolves to the revoked row instead of issuing a fresh one. A misclick in a list is therefore
// permanent, and it takes the customer's copy with it.
//
// Driven through the rendered panel rather than through the handler, because the defect was the
// WIRING — the handler was always correct, and the button called it straight away.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

(globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
  "http://localhost/recursos/documentos",
);

const realFetch = globalThis.fetch;
let posted: string[] = [];
// Per-locale gates, so a test can make the OLD request resolve last.
const holdStarters: Record<string, Promise<void> | undefined> = {};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

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
  if (method !== "GET") {
    posted.push(`${method} ${url.pathname}`);
    return json({ success: true });
  }
  if (url.pathname.endsWith("/document-templates/starters")) {
    const locale = url.searchParams.get("locale") ?? "";
    const held = holdStarters[locale];
    if (held) await held;
    return json({
      starters: [{ key: "quote", name: `starter-${locale}`, description: "" }],
    });
  }
  if (url.pathname.endsWith("/document-templates"))
    return json({ templates: [] });
  if (url.pathname.endsWith("/tenant-settings")) {
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
  if (url.pathname.endsWith("/documents")) {
    return json({
      documents: [
        {
          id: "7",
          title: "Orçamento",
          number: "ORC-0001",
          status: "READY",
          revoked: false,
          issuedAt: "2026-08-20T12:00:00.000Z",
          templateId: "3",
          templateName: "Orçamento",
        },
      ],
    });
  }
  return json({});
}) as unknown as typeof fetch;

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

function mount() {
  return render(
    <MemoryRouter initialEntries={["/recursos/documentos"]}>
      <ToastProvider>
        <DocumentsPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
}

// The issued documents live on their own tab now: a template is configuration, an issued document is
// a record, and only the second one can be revoked.
async function openIssuedTab() {
  fireEvent.click(await screen.findByRole("tab", { name: /issued|emitidos/i }));
}

describe("revoking a document asks first", () => {
  test("the click opens a confirm instead of revoking", async () => {
    posted = [];
    mount();
    await openIssuedTab();
    const button = await screen.findByText("Revoke");
    fireEvent.click(button);
    // Nothing has been revoked yet — that is the whole finding.
    expect(posted).toEqual([]);
    expect((document.body.textContent ?? "").includes("Revoke document")).toBe(
      true,
    );
  });

  test("confirming is what revokes it", async () => {
    posted = [];
    mount();
    await openIssuedTab();
    fireEvent.click(await screen.findByText("Revoke"));
    // The dialog's own confirm button, which carries the same label as the row's.
    const buttons = screen.getAllByRole("button");
    const confirmButton = buttons
      .filter((b) => b.textContent === "Revoke")
      .pop() as HTMLButtonElement;
    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(posted).toEqual(["POST /api/v1/documents/7/revoke"]);
    });
  });
});
