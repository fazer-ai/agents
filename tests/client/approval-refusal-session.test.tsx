/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// A held refusal belongs to one editing session. The mark expires by VALUE, so cancelling is not
// enough: `startEdit` re-seeds the draft from the record, and reopening an item would show the last
// request's server sentence before anything was sent. An inline editor ends it where the session
// starts (a dialog does it with `useOnModalOpen`).
// A save answering after the editor closed is not tested: Cancel is disabled while the PATCH is out.

// Assertions reduce to a string or a boolean BEFORE expect: a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls.

const { KnowledgeApprovals } = await import(
  "@/client/pages/resources/KnowledgeApprovals"
);
const { ToastProvider } = await import("@/client/components/Toast");

const realFetch = globalThis.fetch;
const REASON = "content contains characters that cannot be stored (U+0000)";

const APPROVAL = {
  id: "a1",
  status: "PENDING",
  proposedTitle: "Refund window",
  proposedContent: "Refunds within 30 days.",
  createdAt: new Date(0).toISOString(),
};

afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

function serve() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/knowledge/approvals") && method === "PATCH") {
      return new Response(JSON.stringify({ error: REASON, field: "content" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/knowledge/approvals")) {
      return new Response(JSON.stringify({ approvals: [APPROVAL] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// Edits the TITLE and leaves the content as proposed, which is what makes the refusal outlive the
// session: the server refuses `content`, and `startEdit` re-seeds that same value on the next
// opening, so the mark (which expires by VALUE) is still about what the box holds.
async function openEditorAndSave(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  fireEvent.change(screen.getByRole("textbox", { name: /title/i }), {
    target: { value: title },
  });
  const save = screen.getAllByRole("button", { name: /^save$/i });
  fireEvent.click(save[save.length - 1] as HTMLElement);
}

function mount() {
  return render(
    <ToastProvider>
      <KnowledgeApprovals />
    </ToastProvider>,
  );
}

test("a refusal from the last session is gone when the editor reopens", async () => {
  serve();
  mount();
  await openEditorAndSave("Refund window (30 days)");
  await waitFor(() => {
    expect(screen.queryAllByText(REASON).length).toBeGreaterThan(0);
  });

  fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
  await waitFor(() => {
    expect(screen.queryAllByRole("textbox").length).toBe(0);
  });
  fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

  // Reopened on the same record: the draft holds what was refused, and nothing has been sent.
  await waitFor(() => {
    expect(screen.queryAllByRole("textbox").length).toBeGreaterThan(0);
  });
  expect(screen.queryAllByText(REASON).length).toBe(0);
});
