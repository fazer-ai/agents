/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// A HELD REFUSAL BELONGS TO ONE EDITING SESSION.
//
// The mark expires by VALUE, which is what keeps it from needing an `onChange` line per input — and
// it is also why cancelling an editor is not enough to end it. `startEdit` re-seeds the draft from
// the record, so reopening the same item (or another one whose title matches) puts the previous
// request's server sentence under a box before anything has been sent. A dialog answers this with
// `useOnModalOpen`; an inline editor has to answer it where the session starts.
//
// The list is gated on the same state for consistency with that — the two boxes are drawn inside
// `editingId === a.id` — but there is no test here for a save answering after the editor closed,
// because there is no way to get there: Cancel is `disabled={busyId === a.id}` while the PATCH is
// out. Leaving the record of it in the source instead of asserting a path the UI blocks.
//
// NOTE: assertions reduce to a string or a boolean BEFORE expect: a failing expectation holding a
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
// opening, so the mark — which expires by VALUE — is still about what the box holds. Retyping the
// refused text would do it too; this is the path that needs no retyping at all.
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
